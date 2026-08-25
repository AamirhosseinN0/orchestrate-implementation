#!/usr/bin/env node
// driver.mjs — the bookkeeping half of /orchestrate-implementation.
//
// It does the parts a model does badly: remembering every gap it found,
// refusing to call a session finished while one is unanswered, and holding
// each question to the plain-words rules. It does NOT decide anything.
// Zero dependencies. Node >= 18.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const CWD = process.cwd();
let REG_PATH = path.join(CWD, '.claude', 'orchestration', 'register.json');

const die = (m) => { console.error('error: ' + m); process.exit(2); };
const now = () => new Date().toISOString();

function readReg() {
  acquireLock();
  if (!fs.existsSync(REG_PATH)) die('no register at ' + rel(REG_PATH) + ' — run `load` first');
  return JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
}
// The register is shared: chips report into it from their own processes while
// the orchestrator writes releases. One directory-based lock serialises every
// command; a holder dead longer than 15s is stolen.
let HAS_LOCK = false;
function lockDir() { return REG_PATH + '.lock'; }
function acquireLock() {
  if (HAS_LOCK) return;
  for (let i = 0; i < 60; i++) {
    try { fs.mkdirSync(lockDir(), { recursive: false }); HAS_LOCK = true; process.on('exit', releaseLock); return; }
    catch {
      try { if (Date.now() - fs.statSync(lockDir()).mtimeMs > 15000) { fs.rmdirSync(lockDir()); continue; } } catch { continue; }
      try { execSync('sleep 0.1'); } catch { /* keep spinning */ }
    }
  }
  die('another driver process has held the register lock for a while: ' + rel(lockDir()) +
      '\n       If nothing is actually running, remove that directory.');
}
function releaseLock() { if (HAS_LOCK) { try { fs.rmdirSync(lockDir()); } catch { /* gone */ } HAS_LOCK = false; } }

function writeReg(r) {
  fs.mkdirSync(path.dirname(REG_PATH), { recursive: true });
  const next = JSON.stringify(r, null, 2) + '\n';
  let prev = null;
  try { prev = fs.readFileSync(REG_PATH, 'utf8'); } catch { /* first write */ }
  if (prev === next) return;                    // a no-op write must not burn a backup slot
  if (prev !== null) {
    // The register is the run, and it is usually gitignored — these backups are
    // its only history. Keep the old state, land the new one durably, and only
    // then prune, so no crash can cost both copies.
    const bdir = path.join(path.dirname(REG_PATH), 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let seq = 0, dest;
    do { dest = path.join(bdir, 'register-' + stamp + '-' + String(seq++).padStart(2, '0') + '.json'); }
    while (fs.existsSync(dest));
    fs.writeFileSync(dest, prev);
    fs.writeFileSync(REG_PATH + '.tmp', next);
    fs.renameSync(REG_PATH + '.tmp', REG_PATH);
    const olds = fs.readdirSync(bdir).filter((f) => f.startsWith('register-')).sort();
    while (olds.length > 30) fs.unlinkSync(path.join(bdir, olds.shift()));
  } else {
    fs.writeFileSync(REG_PATH + '.tmp', next);
    fs.renameSync(REG_PATH + '.tmp', REG_PATH);
  }
}
const rel = (p) => path.relative(CWD, p) || p;
function nextId(r) {
  const n = r.gaps.reduce((m, g) => Math.max(m, parseInt(g.id.slice(1), 10) || 0), 0);
  return 'g' + String(n + 1).padStart(2, '0');
}
function stdinJson() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { die('expected JSON on stdin'); }
  if (!raw.trim()) die('expected JSON on stdin');
  try { return JSON.parse(raw); } catch (e) { die('bad JSON on stdin: ' + e.message); }
}
function getGap(r, id) {
  const g = r.gaps.find((x) => x.id === id);
  if (!g) die('no gap ' + id);
  return g;
}

// ---------------------------------------------------------------- resolving

function expand(arg) {
  const abs = path.resolve(CWD, arg);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const out = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(md|markdown|txt|rst)$/i.test(e.name)) out.push(p);
      }
    })(abs);
    return out.sort();
  }
  if (arg.includes('*')) {
    const dir = path.dirname(abs), base = path.basename(abs);
    if (!fs.existsSync(dir)) return [];
    const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)).sort();
  }
  return fs.existsSync(abs) ? [abs] : [];
}

// ------------------------------------------------------------------ lexicon
// Each entry is a shape of not-yet-decided that a plan can hold.

const LEX = [
  { id: 'marker',   why: 'marked unfinished',            re: /\b(TBD|TODO|FIXME|XXX|\?\?\?)\b/i },
  { id: 'later',    why: 'postponed, never returned to', re: /\b(to be (decided|determined|defined|chosen)|decide later|decided later|not yet decided|still (open|undecided)|open question|left open|we'?ll decide|revisit later|for now|initially|at first|in the first version)\b/i },
  { id: 'unnamed',  why: 'a known method, not named',    re: /\b(well[- ]?(known|used|tested|established)|widely[- ]?(used|adopted)|commonly used|industry[- ]?standard|already (tested|proven|implemented)|off[- ]the[- ]shelf|battle[- ]tested|standard (approach|method|algorithm|library|practice)|an? existing (library|algorithm|method|implementation)|published (method|algorithm))\b/i },
  { id: 'handwave', why: 'a gesture, not an instruction', re: /\b(some (kind|sort|form) of|somehow|a way to|as (needed|appropriate|required)|if (needed|necessary)|where appropriate|and so on|etc\.|among others|or similar|something like|along the lines of)/i },
  { id: 'judgement',why: 'an adjective with no test',     re: /\b(appropriate|suitable|sensible|reasonable|adequate|proper|acceptable|best practice|robust|scalable|performant|secure|modern|clean|efficient|optimal)\b/i },
  { id: 'hedge',    why: 'not a commitment',              re: /\b(might(?! be (?:read|written|seen))|possibly|perhaps|probably|should probably|we think|likely to|ideally|preferably|(we|it|this|you) may (need|want|have to|end up)|may need to|could be worth|open to)\b/i },
  { id: 'quantity', why: 'a quantity with no number',     re: /\b(an?|the|some) (threshold|limit|cap|timeout|interval|window|quota|budget|retention period|page size|batch size|maximum|minimum|max|min|ceiling|floor)\b/i },
  { id: 'cadence',  why: 'a rhythm with no period',       re: /\b(regularly|periodically|frequently|often|occasionally|from time to time|soon|quickly|fast|promptly|in a timely)\b/i },
  { id: 'copycat',  why: 'a reference, not a spec',       re: /\b(similar to|inspired by|modelled on|modeled on|like (what )?[A-Z][a-zA-Z]+ does|the way [A-Z][a-zA-Z]+)\b/ },
  { id: 'vagueqty', why: 'a count with no count',         re: /\b(several|a few|a number of|various|multiple) (?!things|reasons|ways|times|words|cases|places|people|others|more|of )[a-z]+/i },
  { id: 'tuning',   why: 'a number somebody has to pick', re: /\b(configurable|tunable|tuned|adjustable|to taste|per deployment|environment[- ]specific)\b/i },
];

const SETTLED_HEADING = /(settled|do not relitigate|already decided|decisions \(|resolved|answered)/i;
const FENCE = /^\s*(```|~~~)/;

function scanFile(p) {
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const hits = [];
  let fenced = false, heading = '', settled = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) { heading = h[2].trim(); settled = SETTLED_HEADING.test(heading); return; }
    if (settled) return;
    if (/^\s*[|>]?\s*$/.test(line)) return;
    for (const l of LEX) {
      const m = line.match(l.re);
      if (m) hits.push({ line: i + 1, kind: l.id, why: l.why, hit: m[0], heading, quote: line.trim().slice(0, 200) });
    }
  });
  return hits;
}

// A plan can also be silent. If a whole category of question is never
// mentioned anywhere in the document, that is a gap nobody wrote down.
const CATEGORIES = [
  { id: 'failure',    ask: 'what happens when it fails',        words: ['fail', 'error', 'crash', 'retry', 'timeout', 'rollback', 'roll back', 'exception', 'goes wrong'] },
  { id: 'limits',     ask: 'how much is too much',              words: ['limit', 'quota', 'cap', 'maximum', 'max ', 'rate', 'throttle', 'too many', 'size'] },
  { id: 'permission', ask: 'who is allowed to do it',           words: ['who can', 'allowed', 'permission', 'role', 'actor', 'access', 'may not', 'forbidden'] },
  { id: 'repeat',     ask: 'what happens if it runs twice',     words: ['twice', 'duplicate', 'idempot', 'replay', 'again', 'already', 'repeat', 're-run', 'rerun'] },
  { id: 'existing',   ask: 'what happens to what already exists',words: ['migrat', 'backfill', 'existing', 'already stored', 'upgrade', 'old rows', 'historic'] },
  { id: 'proof',      ask: 'how anyone knows it works',         words: ['test', 'fixture', 'golden', 'verify', 'prove', 'assert', 'check that', 'acceptance'] },
  { id: 'undo',       ask: 'how it is undone or deleted',       words: ['undo', 'delete', 'remove', 'revert', 'erase', 'retention', 'purge', 'cancel'] },
  { id: 'growth',     ask: 'what it looks like at ten times the size', words: ['scale', 'grow', 'volume', 'load', 'how many', 'per second', 'concurren', 'thousand'] },
];

function silenceFile(p) {
  const text = fs.readFileSync(p, 'utf8').toLowerCase();
  return CATEGORIES.filter((c) => !c.words.some((w) => text.includes(w)));
}

// ------------------------------------------------------------------ commands

function cmdLoad(args) {
  const files = [...new Set(args.flatMap(expand))];
  if (!files.length) die('no plan files matched: ' + args.join(' '));
  const reg = fs.existsSync(REG_PATH) ? readReg() : { version: 1, created: now(), plans: [], gaps: [] };
  for (const f of files) {
    const body = fs.readFileSync(f, 'utf8');
    const entry = {
      path: rel(f),
      lines: body.split('\n').length,
      bytes: Buffer.byteLength(body),
      sha: crypto.createHash('sha256').update(body).digest('hex').slice(0, 12),
    };
    const at = reg.plans.findIndex((x) => x.path === entry.path);
    if (at >= 0) reg.plans[at] = entry; else reg.plans.push(entry);
  }
  writeReg(reg);
  console.log('register: ' + rel(REG_PATH));
  console.log('loaded ' + reg.plans.length + ' plan file(s):\n');
  let words = 0;
  for (const p of reg.plans) {
    words += Math.round(p.bytes / 5.5);
    console.log('  ' + p.path.padEnd(52) + String(p.lines).padStart(6) + ' lines  ' + (p.bytes < 1024 ? String(p.bytes).padStart(5) + ' B ' : String(Math.round(p.bytes / 1024)).padStart(5) + ' KB'));
  }
  console.log('\n~' + words.toLocaleString() + ' words total. READ EVERY ONE IN FULL before scanning.');
}

function cmdScan() {
  const reg = readReg();
  if (!reg.plans.length) die('no plans loaded');
  let added = 0;
  for (const p of reg.plans) {
    for (const h of scanFile(path.resolve(CWD, p.path))) {
      if (reg.gaps.some((g) => g.plan === p.path && g.line === h.line && g.marker === h.kind)) continue;
      reg.gaps.push({
        id: nextId(reg), plan: p.path, line: h.line, marker: h.kind, why: h.why,
        hit: h.hit, quote: h.quote, section: h.heading,
        title: '', scope: 'unset', status: 'candidate',
        research: [], question: null, answer: null,
      });
      added++;
    }
  }
  writeReg(reg);
  const byPlan = {};
  for (const g of reg.gaps.filter((x) => x.status === 'candidate')) (byPlan[g.plan] ||= []).push(g);
  for (const [p, gs] of Object.entries(byPlan)) {
    console.log('\n' + p + '  (' + gs.length + ')');
    for (const g of gs) console.log('  ' + g.id + '  L' + String(g.line).padStart(4) + '  [' + g.marker + '] ' + g.why + '\n        "' + g.quote.slice(0, 110) + '"');
  }
  console.log('\nHow thick the fog is, per plan:');
  for (const p of reg.plans) {
    const n = reg.gaps.filter((g) => g.plan === p.path && g.status === 'candidate').length;
    const per = (n / p.lines) * 100;
    const band = per >= 20 ? 'barely specified' : per >= 8 ? 'thin in places' : per >= 2 ? 'mostly settled' : 'settled';
    console.log('  ' + p.path.padEnd(46) + String(n).padStart(4) + ' in ' + String(p.lines).padStart(5) + ' lines   ' + per.toFixed(1).padStart(5) + '/100  ' + band);
  }
  console.log('\n' + added + ' new candidate(s), ' + reg.gaps.length + ' total.');
  console.log('These are SUSPECTS, not gaps. Read each in its own paragraph and either');
  console.log('  keep it:  driver.mjs set <id> status=gap title="..." scope=in');
  console.log('  drop it:  driver.mjs set <id> status=dropped');
}

function cmdSilence() {
  const reg = readReg();
  console.log('Categories a plan never mentions at all. Each is a gap by silence —');
  console.log('confirm by reading, then add it with `add`.\n');
  for (const p of reg.plans) {
    const missing = silenceFile(path.resolve(CWD, p.path));
    console.log(p.path);
    if (!missing.length) console.log('  — mentions all eight');
    for (const c of missing) console.log('  ✗ never says ' + c.ask + '  [' + c.id + ']');
  }
}

function cmdAdd() {
  const reg = readReg();
  const inp = stdinJson();
  const items = Array.isArray(inp) ? inp : [inp];
  const ids = [];
  for (const it of items) {
    if (!it.title) die('each added gap needs a title');
    const g = {
      id: nextId(reg), plan: it.plan || '(across plans)', line: it.line || 0,
      marker: it.marker || 'model', why: it.why || 'found by reading',
      hit: '', quote: it.quote || '', section: it.section || '',
      title: it.title, scope: it.scope || 'unset', status: 'gap',
      research: it.research || [], question: null, answer: null,
    };
    reg.gaps.push(g); ids.push(g.id);
  }
  writeReg(reg);
  console.log('added: ' + ids.join(', '));
}

function cmdList(flags) {
  const reg = readReg();
  let gs = reg.gaps;
  if (flags.status) gs = gs.filter((g) => g.status === flags.status);
  if (flags.scope) gs = gs.filter((g) => g.scope === flags.scope);
  if (flags.plan) gs = gs.filter((g) => g.plan.includes(flags.plan));
  if (!gs.length) return console.log('(none)');
  for (const g of gs) {
    console.log(g.id + '  ' + g.status.padEnd(10) + g.scope.padEnd(6) + (g.title || g.quote.slice(0, 70)));
    console.log('     ' + g.plan + (g.line ? ':' + g.line : ''));
  }
  console.log('\n' + gs.length + ' of ' + reg.gaps.length);
}

function cmdShow(id) {
  const g = getGap(readReg(), id);
  console.log(JSON.stringify(g, null, 2));
}

function cmdSet(id, pairs) {
  const reg = readReg(); const g = getGap(reg, id);
  const OK = ['status', 'scope', 'title', 'why', 'plan', 'line', 'section'];
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i < 0) die('expected key=value, got: ' + p);
    const k = p.slice(0, i), v = p.slice(i + 1);
    if (!OK.includes(k)) die('cannot set "' + k + '" (allowed: ' + OK.join(', ') + ')');
    if (k === 'scope' && !['in', 'out', 'unset'].includes(v)) die('scope must be in|out|unset');
    if (k === 'status' && !['candidate', 'gap', 'dropped', 'asked', 'batched', 'answered', 'deferred'].includes(v)) die('bad status');
    g[k] = k === 'line' ? Number(v) : v;
  }
  writeReg(reg);
  console.log(g.id + '  ' + g.status + '  ' + g.scope + '  ' + (g.title || '(untitled)'));
}

function cmdResearch(id) {
  const reg = readReg(); const g = getGap(reg, id);
  const inp = stdinJson();
  g.research = Array.isArray(inp) ? inp : [inp];
  writeReg(reg);
  console.log(g.id + ': ' + g.research.length + ' option(s) researched');
  for (const r of g.research) console.log('  - ' + r.name + (r.url ? '  ' + r.url : ''));
}

// ------------------------------------------------------------------ plain words
// The house rules, mechanised. A question that fails these gets rewritten,
// not asked.

const JARGON = ['idempoten', 'schema', 'endpoint', 'api', 'rls', 'jwt', 'oauth', 'middleware',
  'polymorph', 'denormal', 'normalis', 'normaliz', 'mutex', 'semaphore', 'orm', 'dag', 'crdt',
  'rpc', 'grpc', 'serialis', 'serializ', 'deserial', 'hashmap', 'primary key', 'foreign key',
  'transaction', 'async', 'coroutine', 'goroutine', 'thread pool', 'backpressure', 'shard',
  'replication', 'latency', 'throughput', 'monorepo', 'refactor', 'abstraction', 'interface',
  'dependency injection', 'singleton', 'enum', 'boolean', 'nullable', 'tuple', 'regex', 'regexp',
  'migration', 'backfill', 'webhook', 'payload', 'middleware', 'runtime', 'compile', 'binary',
  'namespace', 'mutation', 'immutab', 'idempotent', 'invariant', 'heuristic', 'deterministic',
  'stochastic', 'quantis', 'quantiz', 'vectoris', 'vectoriz', 'embedding', 'tokenis', 'tokeniz',
  'algorithm', 'implementation', 'architecture', 'infrastructure', 'configuration', 'authenticat',
  'authoris', 'authoriz', 'provision', 'orchestrat', 'instantiat', 'parameteris', 'parameteriz'];

const PATHY = /(^|\s|\()[\w.\-/]*\/[\w.\-/]+|\b\w+\.(md|ts|tsx|js|mjs|py|json|sql|toml|yaml|yml|sh|rs|go|java|rb)\b|`[^`]+`/i;

function words(s) { return s.trim().split(/\s+/).filter(Boolean); }

function lintText(label, s, maxWords) {
  const p = [];
  if (!s || !s.trim()) { p.push(label + ' is empty'); return p; }
  const w = words(s);
  if (w.length > maxWords) p.push(label + ' is ' + w.length + ' words, max ' + maxWords);
  if (PATHY.test(s)) p.push(label + ' names a file or path — say what it does instead');
  const low = ' ' + s.toLowerCase() + ' ';
  for (const j of JARGON) if (low.includes(j)) { p.push(label + ' uses "' + j + '" — plainer word needed'); break; }
  // Measure each unhyphenated run: "multiply-the-gap" is plain English,
  // "implementation" is not.
  const long = w.flatMap((x) => x.split(/[-\u2013\u2014/]/)).find((x) => x.replace(/[^a-z]/gi, '').length >= 14);
  if (long) p.push(label + ' has a 14+ letter word: "' + long + '"');
  return p;
}

function lintGap(g) {
  const p = [];
  const q = g.question;
  if (!q) return ['no question written yet'];
  p.push(...lintText('question', q.text, 28));
  if (q.text && !q.text.trim().endsWith('?')) p.push('question does not end in a question mark');
  const os = q.options || [];
  if (os.length < 2 || os.length > 4) p.push('needs 2 to 4 answers, has ' + os.length);
  const recs = os.filter((o) => o.recommended);
  if (recs.length !== 1) p.push('needs exactly one recommended answer, has ' + recs.length);
  else if (!os[0].recommended) p.push('the recommended answer must be listed first');
  os.forEach((o, i) => {
    const tag = 'answer ' + (i + 1);
    p.push(...lintText(tag + ' label', o.label, 6));
    if (!o.gain || !o.gain.trim()) p.push(tag + ' has no upside');
    else p.push(...lintText(tag + ' upside', o.gain, 26));
    if (!o.cost || !o.cost.trim()) p.push(tag + ' has no cost');
    else p.push(...lintText(tag + ' cost', o.cost, 26));
  });
  return p;
}

function cmdQuestion(id) {
  const reg = readReg(); const g = getGap(reg, id);
  const q = stdinJson();
  if (!q.text || !Array.isArray(q.options)) die('need {"text": "...", "options": [{label, gain, cost, recommended}]}');
  g.question = q;
  const problems = lintGap(g);
  if (problems.length) { console.error(id + ' — not asked, fix these first:'); for (const x of problems) console.error('  ✗ ' + x); process.exit(1); }
  if (g.status !== 'batched') g.status = 'asked';
  writeReg(reg);
  console.log(id + ' ✓ passes the plain-words rules. ' + (g.status === 'batched' ? 'Held for the batch.' : 'Ask it now.') + '\n');
  printQuestion(g);
}

function printQuestion(g) {
  const q = g.question;
  console.log(q.text);
  q.options.forEach((o) => {
    console.log('  • ' + o.label + (o.recommended ? '  (Recommended)' : ''));
    console.log('      ✓ ' + o.gain);
    console.log('      ✕ ' + o.cost);
  });
}

function cmdLint(id) {
  const reg = readReg();
  const gs = id ? [getGap(reg, id)] : reg.gaps.filter((g) => g.question);
  if (!gs.length) return console.log('no questions written yet');
  let bad = 0;
  for (const g of gs) {
    const p = lintGap(g);
    if (!p.length) { console.log('✓ ' + g.id + '  ' + (g.title || '')); continue; }
    bad++;
    console.log('✗ ' + g.id + '  ' + (g.title || ''));
    for (const x of p) console.log('    ' + x);
  }
  if (bad) { console.log('\n' + bad + ' question(s) need rewriting.'); process.exit(1); }
  console.log('\nall clear.');
}

function cmdAnswer(id) {
  const reg = readReg(); const g = getGap(reg, id);
  const a = stdinJson();
  if (!a.choice) die('need {"choice": "...", "note": "why, in their words"}');
  g.answer = { choice: a.choice, note: a.note || '', rejected: a.rejected || [], carries: a.carries || [], reaches_back: a.reaches_back || '', at: now() };
  g.status = 'answered';
  writeReg(reg);
  console.log(id + ' answered: ' + a.choice);
}

function cmdBatch() {
  const reg = readReg();
  const gs = reg.gaps.filter((g) => g.status === 'batched');
  if (!gs.length) return console.log('nothing batched.');
  console.log('These are the small ones. Each has a suggested answer. Say "all fine",');
  console.log('or name the numbers you want changed.\n');
  gs.forEach((g, i) => {
    const s = g.question && g.question.options && g.question.options[0];
    console.log((i + 1) + '. ' + (g.title || g.quote.slice(0, 70)));
    console.log('   suggested: ' + (s ? s.label : '(none written)'));
    if (s && s.gain) console.log('   ✓ ' + s.gain);
    if (s && s.cost) console.log('   ✕ ' + s.cost);
    console.log('');
  });
  console.log(gs.length + ' item(s). ids: ' + gs.map((g) => g.id).join(' '));
}

function cmdStatus() {
  const reg = readReg();
  const by = {};
  for (const g of reg.gaps) by[g.status] = (by[g.status] || 0) + 1;
  console.log('register: ' + rel(REG_PATH));
  console.log('plans:    ' + reg.plans.length);
  console.log('found:    ' + reg.gaps.length + '   ' + Object.entries(by).map(([k, v]) => k + '=' + v).join('  '));
  const open = reg.gaps.filter((g) => g.scope === 'in' && !['answered', 'dropped'].includes(g.status));
  const unset = reg.gaps.filter((g) => g.scope === 'unset' && g.status !== 'dropped' && g.status !== 'candidate');
  if (unset.length) { console.log('\nno scope decided yet (in or out?):'); for (const g of unset) console.log('  ' + g.id + '  ' + (g.title || g.quote.slice(0, 60))); }
  if (open.length) {
    console.log('\nin scope and still unanswered — name each one when you report:');
    for (const g of open) console.log('  ' + g.id + '  [' + g.status + '] ' + (g.title || g.quote.slice(0, 60)) + '\n        ' + g.plan + (g.line ? ':' + g.line : ''));
  } else console.log('\nnothing in scope is unanswered.');
}

function cmdCheck() {
  const reg = readReg();
  const cand = reg.gaps.filter((g) => g.status === 'candidate');
  const unset = reg.gaps.filter((g) => g.scope === 'unset' && !['dropped', 'candidate'].includes(g.status));
  const open = reg.gaps.filter((g) => g.scope === 'in' && !['answered', 'dropped'].includes(g.status));
  let fail = false;
  if (cand.length) { console.error('✗ ' + cand.length + ' candidate(s) never judged — keep or drop each one'); fail = true; }
  if (unset.length) { console.error('✗ ' + unset.length + ' gap(s) with no scope — in or out?'); fail = true; }
  if (open.length) { console.error('✗ ' + open.length + ' in-scope gap(s) unanswered:'); for (const g of open) console.error('    ' + g.id + '  ' + (g.title || g.quote.slice(0, 60))); fail = true; }
  if (fail) { console.error('\nnot finished. Do not report this session as done.'); process.exit(1); }
  console.log('✓ every candidate judged, every in-scope gap answered. Safe to write the record.');
}

// ------------------------------------------------------------------- render

function cmdRender(flags) {
  const reg = readReg();
  const done = reg.gaps.filter((g) => g.status === 'answered');
  if (!done.length) die('nothing answered yet');
  if (flags.plan) {
    const gs = done.filter((g) => g.plan.includes(flags.plan));
    if (!gs.length) { console.log('(nothing was decided for ' + flags.plan + ' — leave that plan alone)'); return; }
    console.log('## Decisions (settled with the user — do not relitigate)\n');
    console.log('| Decision | Choice |');
    console.log('|---|---|');
    for (const g of gs) console.log('| ' + (g.title || g.quote.slice(0, 50)) + ' | **' + g.answer.choice + '**' + (g.answer.note ? ' — ' + g.answer.note.replace(/\n/g, ' ') : '') + ' |');
    return;
  }
  const out = flags.out || path.join('docs', 'decisions-' + (flags.name || 'implementation') + '.md');
  const L = [];
  L.push('# Decisions — ' + (flags.title || 'the implementation grill'));
  L.push('');
  L.push('*Settled with the user on ' + new Date().toISOString().slice(0, 10) + ', before any of this work was begun.');
  L.push('The plans say what to build; this says what was decided, what was turned down, and why — so');
  L.push('that nobody later has to reconstruct the reasoning.*');
  L.push('');
  L.push('Plans read: ' + reg.plans.map((p) => '[`' + p.path + '`](' + path.relative(path.dirname(out), p.path) + ')').join(', ') + '.');
  L.push('');
  const nDropped = reg.gaps.filter((g) => g.status === 'dropped').length;
  L.push('Read for things not yet decided: ' + reg.gaps.length + ' suspects, ' + nDropped +
         ' of them settled already or not this work, leaving ' + (reg.gaps.length - nDropped) +
         ' real. ' + done.length + ' were settled here.');
  L.push('');
  L.push('---');
  done.forEach((g, i) => {
    L.push('');
    L.push('## ' + (i + 1) + ' — ' + (g.title || g.quote.slice(0, 60)));
    L.push('');
    if (g.quote) { L.push('> ' + g.quote); L.push(''); L.push('*— ' + g.plan + (g.line ? ', line ' + g.line : '') + '*'); L.push(''); }
    const ch = g.answer.choice.trim();
    L.push('**Chosen.** ' + ch + (/[.!?]$/.test(ch) ? '' : '.') + (g.answer.note ? ' ' + g.answer.note : ''));
    if (g.answer.rejected && g.answer.rejected.length) {
      L.push('');
      L.push('**Turned down, and why.**');
      L.push('');
      L.push('| Turned down | Why |');
      L.push('|---|---|');
      for (const r of g.answer.rejected) L.push('| **' + r.what + '** | ' + r.why + ' |');
    }
    if (g.answer.carries && g.answer.carries.length) {
      L.push('');
      L.push('**Conditions this choice carries, and none is optional.**');
      L.push('');
      g.answer.carries.forEach((c, n) => L.push((n + 1) + '. ' + c));
    }
    if (g.answer.reaches_back) { L.push(''); L.push('**Reaches backwards into work already done.** ' + g.answer.reaches_back); }
    if (g.research && g.research.length) {
      L.push('');
      L.push('*Looked at first: ' + g.research.map((r) => r.url ? '[' + r.name + '](' + r.url + ')' : r.name).join(', ') + '.*');
    }
  });
  L.push('');
  fs.mkdirSync(path.dirname(path.resolve(CWD, out)), { recursive: true });
  fs.writeFileSync(path.resolve(CWD, out), L.join('\n'));
  console.log('wrote ' + out + '  (' + done.length + ' decisions)');
  const touched = reg.plans.filter((p) => done.some((g) => g.plan === p.path));
  console.log('now paste a settled-decisions table into each plan that gained one:');
  for (const p of touched) console.log('  driver.mjs render --plan ' + p.path);
  const untouched = reg.plans.filter((p) => !touched.includes(p));
  if (untouched.length) console.log('unchanged, nothing was decided for them: ' + untouched.map((p) => p.path).join(', '));
}


// ==================================================== act one and a half: refine
// The grill settles what to do. Refinement makes the plan buildable against the
// code that actually exists — and is not allowed to decide anything itself.

function planEntry(r, needle) {
  const hits = r.plans.filter((x) => x.path.includes(needle));
  if (!hits.length) die('no plan matching "' + needle + '"');
  if (hits.length > 1) die('"' + needle + '" matches ' + hits.length + ': ' + hits.map((h) => h.path).join(', '));
  return hits[0];
}

function cmdRefineList() {
  const r = readReg();
  const done = r.gaps.filter((g) => g.status === 'answered');
  console.log('plan'.padEnd(46) + 'decided'.padEnd(9) + 'refined');
  console.log('-'.repeat(72));
  for (const p of r.plans) {
    const mine = done.filter((g) => g.plan === p.path).length;
    console.log(p.path.padEnd(46) + String(mine).padEnd(9) + (p.refined ? '✓ ' + (p.refinedAt || '').slice(0, 10) : '—'));
  }
  const todo = r.plans.filter((x) => !x.refined);
  console.log('\n' + todo.length + ' still to refine' + (todo.length ? ': ' + todo.map((x) => x.path).join(', ') : ''));
}


// Everything an agent is told lives on disk, not in the orchestrator's memory.
// A compaction can drop a sentence from a context; it cannot drop a file.
function orchDir(sub) {
  const d = path.join(path.dirname(path.resolve(CWD, REG_PATH)), sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const slug = (x) => x.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
// a key the slug had to change could collide with another that slugs the same,
// so those get a suffix derived from the real key; clean keys keep clean names
const fileKey = (key) => slug(key) === key ? key
  : slug(key) + '-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 6);
function briefPath(key) { return path.join(orchDir('briefs'), fileKey(key) + '.md'); }
function reportPath(planPath) { return path.join(orchDir('refine'), slug(planPath.replace(/\.md$/, '')) + '.json'); }
// What the brief is built from. Volatile fields (who checked in, what landed)
// are excluded — they change without changing a word of the brief.
function briefSha(t, r) {
  // exactly the fields the brief's text is built from — no more (a notes-only
  // change must not cry stale) and no less (a new orchestrator address must)
  return crypto.createHash('sha256').update(JSON.stringify({
    key: t.key, title: t.title, plan: t.plan, needs: t.needs, owns: t.owns,
    serialises: t.serialises || [], context: t.context, verify: t.verify,
    decisions: t.decisions, branch: t.branch, orchestrator: (r && r.orchestrator) || '',
  })).digest('hex').slice(0, 12);
}

function cmdRefineBrief(needle) {
  const r = readReg(); const p = planEntry(r, needle);
  const mine = r.gaps.filter((g) => g.status === 'answered' && g.plan === p.path);
  const B = [];
  B.push('Refine one implementation plan so it can be built from, without anyone having to guess.');
  B.push('');
  B.push('**The plan:** `' + p.path + '` — read all ' + p.lines + ' lines before you change a word.');
  B.push('');
  B.push('**Already settled with the author. These are decided. Do not reopen them, do not improve');
  B.push('on them, do not pick differently because the code suggests otherwise:**');
  B.push('');
  if (mine.length) for (const g of mine) {
    B.push('- **' + (g.title || g.quote.slice(0, 60)) + '** → ' + g.answer.choice +
           (g.answer.note ? '. ' + g.answer.note : ''));
    for (const c of g.answer.carries || []) B.push('    - condition, not optional: ' + c);
  } else B.push('- (none recorded for this plan)');
  B.push('');
  B.push('**What to do.**');
  B.push('');
  B.push('1. Read the codebase. Find what already exists that this plan must build on — the modules,');
  B.push('   the helpers, the patterns it should use rather than reinvent. Name them by real path.');
  B.push('2. Rewrite the plan so every settled decision is stated in it as a decision, and every');
  B.push('   sentence that dodged a decision now says the decided thing. Keep the author\'s voice.');
  B.push('3. Work out what building it actually touches: which files this work would create or');
  B.push('   change, what it must wait for, and what would prove it works.');
  B.push('');
  B.push('**What you must not do.**');
  B.push('');
  B.push('- Do not decide anything that is still open. If you find something the plan needs and');
  B.push('  nobody has settled — a number, a method, a rule — **report it, do not choose it.** That');
  B.push('  is the whole point of this arrangement.');
  B.push('- Do not write product code. You are finishing the plan, not building it.');
  B.push('- Do not touch any file except `' + p.path + '`.');
  B.push('');
  B.push('**Write your report to this exact file** — not into the chat, not as a summary. The');
  B.push('orchestrator reads the file, so nothing you found can be lost on the way:');
  B.push('');
  B.push('    ' + reportPath(p.path));
  B.push('');
  B.push('It must be valid JSON of exactly this shape. Be complete — every file you list under');
  B.push('`owns` is a file somebody is allowed to touch, and one you leave out is one they will');
  B.push('have to stop and ask about:');
  B.push('');
  B.push('```json');
  B.push('{');
  B.push('  "summary": "what you changed in the plan, in two or three sentences",');
  B.push('  "builtOn": [{"path": "real/path", "what": "what it is and why this work uses it"}],');
  B.push('  "tasks": [{"key": "2.1", "title": "plain title", "needs": ["0.14"],');
  B.push('             "owns": ["paths this work creates or changes"],');
  B.push('             "serialises": ["alembic-head"],');
  B.push('             "verify": ["the exact commands that prove it"]}],');
  B.push('  "newGaps": [{"title": "the thing nobody has decided", "why": "why it blocks", "quote": "the sentence"}]');
  B.push('}');
  B.push('```');
  B.push('');
  B.push('`owns` matters more than it looks: two tasks running at once may never touch one file, so');
  B.push('be exact and be narrow. If two pieces of this plan must change the same file, they are one');
  B.push('task, or one waits for the other — say which.');
  B.push('');
  B.push('`serialises` names the things that collide without sharing a file: this work adds a');
  B.push('migration (name the chain: "alembic-head"), changes a lockfile ("pnpm-lock"), or extends a');
  B.push('closed list or registry that a test asserts exact equality over (name it, e.g. "EventKind").');
  B.push('Two tasks moving one of these in the same round land red in CI with zero file overlap, so');
  B.push('missing one here costs a round.');
  B.push('');
  B.push('When the file is written, say only that you have written it and what is in it in one line.');
  B.push('Do not paste the JSON back — the file is the report.');
  console.log(B.join('\n'));
}

function cmdRefineDone(needle, flags) {
  const r = readReg(); const p = planEntry(r, needle);
  const src = flags.from ? path.resolve(CWD, flags.from) : reportPath(p.path);
  let rep;
  if (fs.existsSync(src)) {
    try { rep = JSON.parse(fs.readFileSync(src, 'utf8')); }
    catch (e) { die('the report at ' + rel(src) + ' is not valid JSON: ' + e.message + '\n       Send it back to the agent — do not retype it yourself.'); }
    console.log("read the agent's own report: " + rel(src));
  } else {
    // Older flow, and the escape hatch: JSON piped in. Still works, but the file
    // is better — it cannot lose a line to a compaction on the way here.
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
    if (!raw.trim()) die('no report at ' + rel(src) + ' and nothing on stdin.\n' +
      '       The agent was told to write its report to that path. Ask it to,\n' +
      '       rather than retyping what it told you — that is how files get dropped.');
    try { rep = JSON.parse(raw); } catch (e) { die('bad JSON on stdin: ' + e.message); }
    console.log('⚠ took the report from stdin, not from the agent\'s own file.');
    console.log('  It passed through your context to get here, so check nothing was lost.');
  }
  p.refined = true; p.refinedAt = now(); p.refineSummary = rep.summary || '';
  p.builtOn = rep.builtOn || [];
  let added = 0;
  for (const g of rep.newGaps || []) {
    r.gaps.push({
      id: nextId(r), plan: p.path, line: g.line || 0, marker: 'refine',
      why: g.why || 'found while refining against the code', hit: '', quote: g.quote || '',
      section: '', title: g.title, scope: 'in', status: 'gap',
      research: [], question: null, answer: null,
    });
    added++;
  }
  for (const t of rep.tasks || []) {
    if (!t.key || !t.owns) continue;
    const ex = (r.tasks ||= []).findIndex((x) => x.key === t.key);
    if (ex >= 0) {
      // re-refining a plan mid-run must not reset a live task's state
      const cur = r.tasks[ex];
      cur.title = t.title || cur.title; cur.plan = p.path; cur.needs = t.needs || cur.needs;
      // widen, never narrow: pre-flight may have extended these since the last refine
      cur.owns = [...new Set([...(cur.owns || []), ...t.owns])];
      cur.serialises = [...new Set([...(cur.serialises || []), ...(t.serialises || [])])];
      cur.context = (p.builtOn || []).length ? p.builtOn : cur.context;
      cur.verify = t.verify || cur.verify;
    } else {
      r.tasks.push({ key: t.key, title: t.title || t.key, plan: p.path, needs: t.needs || [],
        owns: t.owns, serialises: t.serialises || [], context: p.builtOn, verify: t.verify || [],
        decisions: [], notes: '', branch: 'step/' + t.key, worktree: '', chip: '',
        status: 'planned', reports: [] });
    }
  }
  writeReg(r);
  console.log(p.path + ' refined.');
  console.log('  ' + (rep.tasks || []).length + ' task(s) proposed');
  console.log('  ' + (p.builtOn || []).length + ' existing thing(s) to build on');
  if (added) {
    console.log('\n⚠ ' + added + ' NEW undecided thing(s) found against the real code.');
    console.log('These are gaps, not decisions. The grill reopens — ask the user before any chip exists:');
    console.log('  driver.mjs list --status gap');
  }
}

function cmdRefineCheck() {
  const r = readReg();
  const unrefined = r.plans.filter((x) => !x.refined);
  const open = r.gaps.filter((g) => g.scope === 'in' && !['answered', 'dropped'].includes(g.status));
  let fail = false;
  if (unrefined.length) { console.error('✗ ' + unrefined.length + ' plan(s) not refined: ' + unrefined.map((x) => x.path).join(', ')); fail = true; }
  if (open.length) {
    console.error('✗ ' + open.length + ' gap(s) reopened by refinement and still unanswered:');
    for (const g of open) console.error('    ' + g.id + '  ' + (g.title || g.quote.slice(0, 60)));
    fail = true;
  }
  const noTasks = (r.tasks || []).length === 0;
  if (noTasks) { console.error('✗ no tasks proposed — refinement produced nothing to hand out'); fail = true; }
  try {
    const dirty = execSync('git status --porcelain', { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
    const uncommitted = r.plans.filter((pl) => dirty.some((f) => f === pl.path || f.endsWith('/' + pl.path)));
    if (uncommitted.length) {
      console.log('· ' + uncommitted.length + ' refined plan(s) are not committed: ' +
        uncommitted.map((x) => x.path).join(', '));
      console.log('  Briefs point at the main checkout so agents will still read the new text, but');
      console.log('  commit them anyway — a plan and the code built from it belong in one history.');
    }
  } catch { /* not a git repo */ }
  if (fail) { console.error('\nnot ready to hand anything out.'); process.exit(1); }
  console.log('✓ every plan refined, nothing left undecided, ' + r.tasks.length + ' task(s) ready. Run `graph`.');
}

// ============================================================ act two: driving
// The grill settles what to build. These commands hand it out, hold back what
// must wait, and refuse to let anything land unproved.

function tasks(r) { return (r.tasks ||= []); }
function getTask(r, k) {
  const t = tasks(r).find((x) => x.key === k);
  if (!t) die('no task "' + k + '" (have: ' + tasks(r).map((x) => x.key).join(', ') + ')');
  return t;
}

// Two tasks may not touch one file. Ownership is declared, and checked.
function norm(p) {
  let x = String(p).replace(/\/+$/, '').replace(/\/\*+$/, '');
  while (x.startsWith('./')) x = x.slice(2);
  return x;
}
// one-directional: does the owned entry `own` cover the path `p`?
function coveredBy(own, p) { const o = norm(own), x = norm(p); return x === o || x.startsWith(o + '/'); }
function collides(a, b) {
  const x = norm(a), y = norm(b);
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}
function overlap(t1, t2) {
  const out = [];
  for (const a of t1.owns || []) for (const b of t2.owns || []) if (collides(a, b)) out.push(a + ' ↔ ' + b);
  return out;
}

function waves(r) {
  const ts = tasks(r).filter((t) => t.status !== 'cancelled');
  const placed = new Map(); const out = [];
  let left = ts.slice(), guard = 0;
  while (left.length) {
    if (guard++ >= 1000) break;   // backstop only; leftovers still surface below
    const ready = left.filter((t) => (t.needs || []).every((n) => placed.has(n)));
    if (!ready.length) break;
    out.push({ wave: out.length, tasks: ready });
    ready.forEach((t) => placed.set(t.key, out.length - 1));
    left = left.filter((t) => !ready.includes(t));
  }
  // whatever could not be placed is a problem to show, never a thing to drop
  if (left.length) out.push({ wave: -1, tasks: left.slice() });
  return out;
}

const TASK_FIELDS = ['title', 'plan', 'needs', 'owns', 'serialises', 'context', 'verify', 'decisions', 'notes', 'branch'];

// One malformed record poisons every command that reads it later, so the gate
// is strict in both directions: create and update enforce the same shape.
function taskProblems(it, isNew) {
  if (it === null || typeof it !== 'object' || Array.isArray(it)) return ['is not a task object'];
  if (typeof it.key !== 'string' || !it.key.trim()) return ['needs a key'];
  const probs = [];
  for (const k of ['owns', 'needs', 'serialises', 'verify', 'decisions']) {
    if (it[k] === undefined) continue;
    if (!Array.isArray(it[k]) || it[k].some((x) => typeof x !== 'string' || !x.trim()))
      probs.push(k + ' must be a list of non-empty strings');
  }
  if (Array.isArray(it.owns) && it.owns.length === 0)
    probs.push('owns cannot be empty — ownership is the load-bearing rule, and an empty list disarms it');
  if (isNew && it.owns === undefined)
    probs.push('declares no files it owns — two tasks may not touch one file, so ownership is not optional');
  if (isNew && (typeof it.title !== 'string' || !it.title.trim())) probs.push('needs a title');
  if (!isNew && it.title !== undefined && (typeof it.title !== 'string' || !it.title.trim()))
    probs.push('title cannot be blanked');
  if (it.context !== undefined && (!Array.isArray(it.context) ||
      it.context.some((c) => !c || typeof c !== 'object' || typeof c.path !== 'string' || !c.path.trim())))
    probs.push('context must be a list of {path, what} objects');
  for (const k of ['plan', 'notes', 'branch'])
    if (it[k] !== undefined && typeof it[k] !== 'string') probs.push(k + ' must be a string');
  return probs;
}

function cmdTaskAdd() {
  const r = readReg(); const inp = stdinJson();
  const items = Array.isArray(inp) ? inp : [inp];
  // Validate every item before touching anything: a batch that fails partway
  // must fail whole, and must not have claimed success for any part of itself.
  const plans = [];
  const errs = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const at = (it && typeof it === 'object' && !Array.isArray(it)) ? tasks(r).findIndex((x) => x.key === it.key) : -1;
    const probs = taskProblems(it, at < 0);
    const label = 'item ' + (i + 1) + (it && it.key ? ' ("' + it.key + '")' : '');
    if (probs.length) { for (const x of probs) errs.push(label + ' ' + x); continue; }
    plans.push({ it, at });
  }
  if (errs.length) die('nothing was saved:\n       ' + errs.join('\n       '));
  const said = [];
  for (const { it, at } of plans) {
    const ignored = Object.keys(it).filter((k) => k !== 'key' && !TASK_FIELDS.includes(k));
    const tail = ignored.length ? '   ignored: ' + ignored.join(', ') + ' (not settable here)' : '';
    if (at >= 0) {
      const t = tasks(r)[at];
      const touched = [];
      for (const k of TASK_FIELDS) if (it[k] !== undefined) { t[k] = it[k]; touched.push(k); }
      said.push('updated ' + it.key + ': ' + (touched.join(', ') || '(nothing — no known field was sent)') + tail);
    } else {
      tasks(r).push({
        key: it.key, title: it.title, plan: it.plan || '', needs: it.needs || [],
        owns: it.owns, serialises: it.serialises || [], context: it.context || [],
        verify: it.verify || [], decisions: it.decisions || [], notes: it.notes || '',
        branch: it.branch || ('step/' + it.key), worktree: '', chip: '',
        status: 'planned', reports: [],
      });
      said.push('created ' + it.key + tail);
    }
  }
  writeReg(r);
  for (const line of said) console.log(line);
  console.log(tasks(r).length + ' task(s) on record. Run `graph` to check nothing clashes.');
}

function cmdGraph() {
  const r = readReg(); const ws = waves(r);
  if (!ws.length) die('no tasks yet');
  let bad = 0;
  const lines = [];
  lines.push('## The work, and what can run side by side');
  lines.push('');
  for (const w of ws) {
    if (w.wave === -1) {
      bad++;
      lines.push('### ⚠ Cannot be ordered');
      for (const t of w.tasks) {
        const missing = (t.needs || []).filter((n) => !tasks(r).some((x) => x.key === n));
        const cancelled = (t.needs || []).filter((n) => tasks(r).some((x) => x.key === n && x.status === 'cancelled'));
        let why;
        if (missing.length) why = 'waits on ' + missing.join(', ') + ', which ' + (missing.length > 1 ? 'are' : 'is') + ' not on record — a typo, or a task never added';
        else if (cancelled.length) why = 'waits on ' + cancelled.join(', ') + ', which was cancelled — reassign or cancel this too';
        else why = 'waits on ' + (t.needs || []).join(', ') + ' in a circle';
        lines.push('- **' + t.key + '** ' + t.title + ' — ' + why);
      }
      continue;
    }
    const par = w.tasks.length > 1 ? w.tasks.length + ' in parallel' : 'on its own';
    lines.push('### Round ' + (w.wave + 1) + ' — ' + par);
    lines.push('');
    for (const t of w.tasks) {
      const need = (t.needs || []).length ? ' · waits for ' + t.needs.join(', ') : ' · nothing to wait for';
      lines.push('- **' + t.key + '** — ' + t.title + need);
      lines.push('  - touches: ' + (t.owns || []).join(', '));
      if (t.plan) lines.push('  - from: ' + t.plan);
    }
    lines.push('');
    // no two tasks in one round may touch one file — and a task that has landed
    // is merged work, not a contender, so it collides with nobody
    for (let i = 0; i < w.tasks.length; i++) for (let j = i + 1; j < w.tasks.length; j++) {
      const a = w.tasks[i], b = w.tasks[j];
      if (a.status === 'landed' || b.status === 'landed') continue;
      const o = overlap(a, b);
      if (o.length) {
        bad++;
        lines.push('  ⚠ **' + a.key + '** and **' + b.key + '** would both change the same files: ' + o.join('; '));
        lines.push('    Split the work, or make one wait for the other. They cannot run together.');
      }
      // A shared file is the easy case. A shared invariant — a migration chain
      // head, a lockfile, a closed list some test asserts exact equality over —
      // collides in CI with zero file overlap.
      const shared = (a.serialises || []).filter((x) => (b.serialises || []).includes(x));
      if (shared.length) {
        bad++;
        lines.push('  ⚠ **' + a.key + '** and **' + b.key + '** both move the same serialisation point: ' + shared.join(', '));
        lines.push('    No file overlaps, and it will still land red — the point is single-file in effect.');
        lines.push('    Make one wait for the other.');
      }
    }
    // nor may one read what another is in the middle of changing
    for (const a of w.tasks) for (const b of w.tasks) {
      if (a === b || a.status === 'landed' || b.status === 'landed') continue;
      for (const c of a.context || []) for (const ow of b.owns || []) {
        if (!collides(c.path, ow)) continue;
        bad++;
        lines.push('  ⚠ **' + a.key + '** is told to build on `' + c.path + '`, which **' + b.key +
                   '** is rewriting in the same round.');
        lines.push('    It would be reading somebody mid-edit. Make ' + a.key + ' wait for ' + b.key + '.');
      }
    }
    // a task told to build on something it may not touch — but once the owner
    // has landed, that path is just code, and repeating the note every run is
    // how a gate stops being read
    for (const a of w.tasks) {
      if (a.status === 'landed') continue;
      for (const c of a.context || []) {
        if ((a.owns || []).some((ow) => collides(c.path, ow))) continue;
        const owner = tasks(r).find((t) => t !== a && t.status !== 'landed' && (t.owns || []).some((ow) => collides(c.path, ow)));
        if (!owner) continue;
        lines.push('  · **' + a.key + '** builds on `' + c.path + '` but may not change it — read-only. ' +
                   'If it needs to write there, say so now.');
      }
    }
  }
  console.log(lines.join('\n'));
  if (bad) { console.error('\n' + bad + ' problem(s) — fix the plan before creating any chip.'); process.exit(1); }
  console.log('\nNothing clashes. Every round above can run side by side.');
}

function cmdWhoami(flags) {
  const dir = path.join(process.env.HOME, '.claude', 'sessions');
  if (!fs.existsSync(dir)) die('no session registry at ' + dir);
  const rows = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
  if (flags.session) {
    const me = rows.find((s) => s.sessionId === flags.session);
    if (!me) die('no live session with id ' + flags.session);
    console.log(me.name);
    return;
  }
  const here = rows.filter((s) => s.cwd === CWD);
  console.log('Live sessions in this directory:');
  for (const s of here) console.log('  ' + s.name.padEnd(24) + s.sessionId);
  console.log('\nYours is the one ListAgents does NOT show (it never lists you).');
  console.log('Or pass your own session id: driver.mjs whoami --session <id>');
}

function depOf(r, key) { return tasks(r).find((x) => x.key === key) || null; }
function heldNeeds(r, t) {
  return (t.needs || []).filter((n) => { const d = depOf(r, n); return !d || d.status !== 'landed'; });
}

function cmdBrief(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  const held = heldNeeds(r, t);
  const who = r.orchestrator ? '`' + r.orchestrator + '`' : 'the one running the show';
  const B = [];
  B.push('# Before anything else: check in');
  B.push('');
  B.push('Your very first action — before reading a file, before thinking about the work — is to');
  B.push('send this message to ' + who + ' with `SendMessage`:');
  B.push('');
  B.push('> ' + t.key + ' checking in. I am up and I have read my brief.');
  B.push('');
  B.push('This is how it learns where to reach you. Until you have done it you are unreachable, and');
  B.push('if you are on hold you will never be released. Do it even if the rest of this says wait.');
  B.push('');
  B.push('When it messages you, reply to the name in the message\'s `from`.');
  B.push('');
  B.push('---');
  B.push('');
  if (held.length) {
    B.push('# ON HOLD — do not start yet');
    B.push('');
    B.push('This work waits for: **' + held.join(', ') + '**. They are not finished.');
    B.push('');
    B.push('Beyond that check-in, do nothing at all until ' + who +
           ' messages you the words **"requirements are done, you may start"**.');
    B.push('Not the reading, not the independent-looking half, nothing. If you think you can see a part');
    B.push('that does not depend on them, you are wrong about the dependency or the dependency is wrong');
    B.push('— say so and wait.');
    B.push('');
    B.push('**Your copy of the repository was made the moment this chip was opened**, which is before the');
    B.push('work you depend on had landed. When you are released you will be given a check to run that');
    B.push('proves your copy has that work in it. Run it. A copy that is behind is the single most');
    B.push('expensive way this goes wrong.');
    B.push('');
    B.push('---');
    B.push('');
  }
  B.push('# ' + t.key + ' — ' + t.title);
  B.push('');
  if (t.plan) {
    B.push('**The plan.** Read it in full before writing anything:');
    B.push('');
    B.push('    ' + path.resolve(CWD, t.plan));
    B.push('');
    B.push('That is the **main checkout**, not your copy. It has to be, because the plan was rewritten');
    B.push('against the real code after you were queued — the copy in your own tree may be the older');
    B.push('one. Every other path in this brief is relative and belongs to your copy; only the plan');
    B.push('and this brief are read from over there.');
    B.push('');
  }
  if ((t.decisions || []).length) {
    B.push('**Already settled with the author. Do not reopen, do not improve on:**');
    B.push('');
    for (const d of t.decisions) B.push('- ' + d);
    B.push('');
  }
  B.push('**Build on what is already there. These exist — read them before you write anything that');
  B.push('overlaps, and use them rather than writing your own:**');
  B.push('');
  if ((t.context || []).length) for (const c of t.context) {
    const mine = (t.owns || []).some((ow) => collides(c.path, ow));
    B.push('- `' + c.path + '` — ' + (c.what || '') + (mine ? '' : '  **(read it, do not change it — it is not yours)**'));
  }
  else B.push('- ⚠ nothing recorded. That is a mistake in the brief, not permission to invent. Ask before starting.');
  B.push('');
  B.push('**The only files you may change:**');
  B.push('');
  for (const o of t.owns || []) B.push('- `' + o + '`');
  B.push('');
  B.push('Another task is working in the same repository right now. If your work needs a file outside');
  B.push('that list, **stop and ask** — do not edit it. Two of you changing one file is the one thing');
  B.push('this arrangement cannot survive.');
  if ((t.serialises || []).length) {
    B.push('');
    B.push('**Single-file-in-effect things this work moves:** ' + t.serialises.join(', ') + '.');
    B.push('Nobody else in your round is allowed to touch these. If you find your work moving one not named here');
    B.push('— a migration chain, a lockfile, a closed list a test checks exactly — stop and say so');
    B.push('before you commit, because two moves of one of these land red together.');
  }
  B.push('');
  B.push('**Where you work.** The harness has already put you in your own copy of the repository.');
  B.push('Stay in it, and never touch the main checkout. But it starts you on an auto-generated');
  B.push('branch with a random name — **do not work there.** Your first act after checking in:');
  B.push('');
  B.push('```bash');
  B.push('git checkout -b ' + t.branch + ' || git checkout ' + t.branch);
  B.push('```');
  B.push('');
  B.push('Everything you do lands on `' + t.branch + '`. The checks that take your work back look for');
  B.push('that exact name; work left on the auto-generated branch is invisible to them.');
  B.push('');
  B.push('**No guessing.** If the plan does not say, or what it says is not there in the code, stop and');
  B.push('ask the one running the show. Do not narrow the requirement so the wait ends sooner, do not');
  B.push('infer a decision from what you find in another copy of the repository — a change appearing');
  B.push('there is somebody mid-edit, not an answer.');
  B.push('');
  B.push('**Before you say you are done, all of these must pass, and you must paste the output:**');
  B.push('');
  B.push('```bash');
  if ((t.verify || []).length) for (const v of t.verify) B.push(v);
  else B.push('# ⚠ nothing recorded. Ask what counts as proof before you start.');
  B.push('```');
  B.push('');
  B.push('**Then commit your work on your branch.** One clear message, no attribution trailers.');
  B.push('');
  B.push('**Then report, both ways — the message is how it hears, the list is what survives:**');
  B.push('');
  B.push('```bash');
  B.push('node ~/.claude/skills/orchestrate-implementation/driver.mjs --register \'' +
         path.resolve(CWD, REG_PATH) + '\' done \'' + t.key + '\' <<\'J\'');
  B.push('{"commit": "<sha>", "verified": "<what you ran and what it said>", "notes": "<anything the next one needs>"}');
  B.push('J');
  B.push('```');
  B.push('');
  B.push('and send this message' + (r.orchestrator ? ' to `' + r.orchestrator + '`' : ' back to whoever briefed you') + ':');
  B.push('');
  B.push('> ' + t.key + ' is done and committed on `' + t.branch + '` at <sha>. Checks run: <what>. ' +
         'Files changed: <list>. Waiting for your check before it is joined up.');
  B.push('');
  B.push('**It is not finished when you say so.** The work is checked again and joined to the main line');
  B.push('by the one running the show. Stay available — if the joined-up run breaks, it comes back to');
  B.push('you, because you are the one who knows what the code meant.');
  const body = B.join('\n') + '\n';
  if (flags && flags.stdout) { console.log(body); return; }
  const out = briefPath(t.key);
  fs.writeFileSync(out, body);
  t.briefSha = briefSha(t, r); t.briefAt = now(); t.briefFile = out;
  writeReg(r);
  console.log('wrote ' + out);
  console.log('');
  console.log('Give the chip this, and nothing retyped from memory:');
  console.log('');
  console.log('---8<---');
  console.log('Your brief is at:');
  console.log('');
  console.log('    ' + out);
  console.log('');
  console.log('**Read it in full before anything else.** It is the whole of what you were given —');
  console.log('the plan, the decisions already settled, what to build on, the only files you may');
  console.log('change, and what counts as proof. Nothing was left in a chat message.');
  console.log('');
  console.log('It lives in the main checkout, so read it by that absolute path — it will not be');
  console.log('inside your own copy of the repository.');
  console.log('');
  console.log('Two things from it, up front, so you cannot miss them:');
  console.log('');
  console.log('1. Before anything else, send this with SendMessage to ' + (r.orchestrator || '<the orchestrator>') + ':');
  console.log('   "' + t.key + ' checking in. I am up and I have read my brief."');
  const held0 = (t.needs || []).filter((n) => getTask(r, n).status !== 'landed');
  console.log(held0.length
    ? '2. You are ON HOLD, waiting for ' + held0.join(', ') + '. Do nothing but that check-in until\n   you are told "requirements are done, you may start".'
    : '2. You are clear to start once you have read the brief.');
  console.log('---8<---');
}

function cmdBriefAll() {
  const r = readReg();
  let n = 0;
  for (const t of tasks(r)) {
    if (['cancelled', 'landed'].includes(t.status)) continue;
    const before = t.briefSha;
    cmdBriefQuiet(t.key);
    n++;
    const now2 = getTask(readReg(), t.key).briefSha;
    if (before && before !== now2) console.log('  changed: ' + t.key + '  → any chip already holding it is out of date');
  }
  console.log(n + ' brief(s) written to ' + orchDir('briefs'));
}

function cmdBriefQuiet(key) {
  const saved = console.log; console.log = () => {};
  try { cmdBrief(key, {}); } finally { console.log = saved; }
}

// A brief written before the record was corrected is a lie an agent is acting on.
function staleBriefs(r) {
  // a landed task's brief is history, not guidance — flagging it is noise
  return tasks(r).filter((t) => !['landed', 'cancelled'].includes(t.status) &&
    t.briefSha && t.briefSha !== briefSha(t, r));
}



// ------------------------------------------------------- act one and three quarters
// Refinement writes `owns` from reading; nobody has tested it against the code.
// Pre-flight does: one read-only agent per task, before its chip exists, whose
// whole job is to find what the record missed.

function preflightReportPath(key) { return path.join(orchDir('preflight'), fileKey(key) + '.json'); }

function cmdPreflightBrief(key) {
  const r = readReg(); const t = getTask(r, key);
  const B = [];
  B.push('Pre-flight one task before anyone builds it. You are **read-only**: you change nothing,');
  B.push('anywhere, and the one file you write is your report.');
  B.push('');
  B.push('**The task:** ' + t.key + ' — ' + t.title);
  if (t.plan) B.push('**Its plan, read it in full:** ' + path.resolve(CWD, t.plan));
  B.push('**What the record says it may change:** ' + (t.owns || []).join(', '));
  B.push('**What the record says it builds on:** ' + ((t.context || []).map((c) => c.path).join(', ') || '(nothing)'));
  B.push('**How it says it will be proved:** ' + ((t.verify || []).join('  ·  ') || '(nothing)'));
  B.push('');
  B.push('Find out, by reading the plan and then the codebase:');
  B.push('');
  B.push('1. **Every file the work would have to create or change that the list above misses.**');
  B.push('   For each: the path, why, and the file:line that proves it — an assertion that must be');
  B.push('   extended, a registry that must gain an entry, a closed list a test checks exactly, a');
  B.push('   dict and an import that must land together. The proof matters: a hunch is not a gap.');
  B.push('2. **Every serialisation point the work moves** — a migration chain head, a lockfile, a');
  B.push('   closed enum or registry some test asserts exact equality over. Name each one.');
  B.push('3. **Whether each verify command can actually run here** — is its binary present, does it');
  B.push('   need something started first, does it point at the right place.');
  B.push('');
  B.push('Write your report to this exact file — not into the chat:');
  B.push('');
  B.push('    ' + preflightReportPath(t.key));
  B.push('');
  B.push('```json');
  B.push('{"missing": [{"path": "...", "why": "...", "evidence": "file.py:123", "loadBearing": true}],');
  B.push(' "serialises": ["alembic-head"],');
  B.push(' "verify": [{"command": "...", "runnable": true, "why": ""}],');
  B.push(' "notes": ""}');
  B.push('```');
  B.push('');
  B.push('`loadBearing` means: without this the work cannot land green. When unsure, true.');
  B.push('**Report, do not fix.** Not the record, not the plan, not the code. When the file is');
  B.push('written, say so in one line and stop.');
  console.log(B.join('\n'));
}

function cmdPreflightDone(key) {
  const r = readReg(); const t = getTask(r, key);
  const src = preflightReportPath(key);
  if (!fs.existsSync(src)) die('no report at ' + rel(src) + ' — the agent was told to write it there. Ask it to.');
  let rep;
  try { rep = JSON.parse(fs.readFileSync(src, 'utf8')); }
  catch (e) { die('the report at ' + rel(src) + ' is not valid JSON: ' + e.message + ' — send it back to the agent.'); }
  // a garbage report must not mark the task pre-flighted — check goes green on it
  const bad = [];
  if (rep === null || typeof rep !== 'object' || Array.isArray(rep)) bad.push('the report is not an object');
  else {
    if (rep.missing !== undefined && (!Array.isArray(rep.missing) ||
        rep.missing.some((m) => !m || typeof m !== 'object' || typeof m.path !== 'string' || !m.path.trim())))
      bad.push('missing must be a list of {path, why, evidence, loadBearing} with a real path each');
    if (rep.serialises !== undefined && (!Array.isArray(rep.serialises) ||
        rep.serialises.some((x) => typeof x !== 'string' || !x.trim())))
      bad.push('serialises must be a list of names');
    if (rep.verify !== undefined && (!Array.isArray(rep.verify) ||
        rep.verify.some((v) => !v || typeof v !== 'object')))
      bad.push('verify must be a list of {command, runnable, why}');
  }
  if (bad.length) die('the report at ' + rel(src) + ' is not usable — send it back rather than fixing it here:\n       ' + bad.join('\n       '));
  t.preflight = { at: now(), missing: rep.missing || [], verify: rep.verify || [], notes: rep.notes || '' };
  for (const x of rep.serialises || []) { (t.serialises ||= []); if (!t.serialises.includes(x)) t.serialises.push(x); }
  writeReg(r);
  console.log(key + ' pre-flighted: ' + t.preflight.missing.length + ' gap(s), ' +
    (rep.serialises || []).length + ' serialisation point(s), ' +
    t.preflight.verify.filter((v) => v.runnable === false).length + ' verify problem(s)');
  const load = t.preflight.missing.filter((m) => m.loadBearing);
  if (load.length) {
    console.log('\nLoad-bearing gaps — the record is wrong, not the agent:');
    for (const m of load) console.log('  ' + m.path + '  (' + (m.evidence || 'no evidence given') + ')\n      ' + (m.why || ''));
    const merged = [...new Set([...(t.owns || []), ...load.map((m) => m.path)])];
    console.log('\nExtend the record with the agent\'s own list — do not retype it:');
    console.log("  echo '" + JSON.stringify([{ key: t.key, owns: merged }]) + "' | node " +
      (process.argv[1] || 'driver.mjs') + " --register '" + path.resolve(CWD, REG_PATH) + "' task add");
    console.log('Then `graph` again — a widened owns can create a collision that was not there before.');
  }
  for (const v of t.preflight.verify.filter((x) => x.runnable === false))
    console.log('\n⚠ verify cannot run as written: ' + v.command + '\n    ' + (v.why || ''));
}

function cmdPreflightCheck(flags) {
  const r = readReg();
  let n = waveArg(flags);
  if (n === undefined) {
    // the round you are about to open: first one holding a task with no chip yet
    const ws = waves(r).filter((w) => w.wave >= 0);
    const cand = ws.find((w) => w.tasks.some((t) => !t.chip && !['landed', 'cancelled'].includes(t.status)));
    n = cand ? cand.wave : currentWave(r);
  }
  const st = waveState(r, n);
  if (!st) die('there is no round ' + (n + 1));
  let fail = false;
  for (const t of st.tasks) {
    if (['landed', 'cancelled'].includes(t.status)) continue;
    if (!t.preflight) { console.error('✗ ' + t.key + '  never pre-flighted'); fail = true; continue; }
    const open = (t.preflight.missing || []).filter((m) => m.loadBearing &&
      !(t.owns || []).some((o) => coveredBy(o, m.path)));
    if (open.length) {
      fail = true;
      console.error('✗ ' + t.key + '  load-bearing gap(s) still outside its owns:');
      for (const m of open) console.error('    ' + m.path + '  (' + (m.evidence || '?') + ')');
    } else console.log('✓ ' + t.key);
  }
  if (fail) { console.error('\nRound ' + (n + 1) + ' is not ready. Ten stop-and-ask round-trips is what opening it anyway costs.'); process.exit(1); }
  console.log('\nRound ' + (n + 1) + ' pre-flighted clean.');
}

// ------------------------------------------------------------------- doctor
// A brief is handed to somebody who will believe it. Everything a brief cites
// that can be checked mechanically, is — before any chip exists.
function cmdDoctor() {
  const r = readReg();
  const binCache = {};
  const binOk = (b) => {
    if (!(b in binCache)) {
      try { execSync('command -v -- ' + JSON.stringify(b), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: '/bin/bash' }); binCache[b] = true; }
      catch { binCache[b] = false; }
    }
    return binCache[b];
  };
  let bad = 0, checked = 0;
  for (const t of tasks(r)) {
    if (['landed', 'cancelled'].includes(t.status)) continue;
    checked++;
    const probs = [];
    if (t.plan && !fs.existsSync(path.resolve(CWD, t.plan))) probs.push('its plan does not exist: ' + t.plan);
    for (const c of t.context || []) {
      if (!c || typeof c !== 'object' || typeof c.path !== 'string') { probs.push('a context entry is not {path, what} — fix the record'); continue; }
      if (!fs.existsSync(path.resolve(CWD, c.path))) probs.push('told to build on a path that does not exist: ' + c.path);
    }
    const vlist = Array.isArray(t.verify) ? t.verify : (t.verify ? [String(t.verify)] : []);
    for (const v of vlist) {
      // skip leading VAR=value assignments — `CI=1 pnpm test` tests pnpm, not CI=1
      const toks = String(v).trim().split(/\s+/).filter(Boolean);
      const bin = (toks.find((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) || '').replace(/^[(]+/, '');
      if (bin && !binOk(bin)) probs.push('verify command\'s binary is not on PATH: `' + bin + '`  (' + v + ')');
    }
    if (t.briefSha && t.briefSha !== briefSha(t, r)) probs.push('brief is stale — the record changed after it was written');
    if (!probs.length) continue;
    bad++;
    console.log('✗ ' + t.key);
    for (const x of probs) console.log('    ' + x);
  }
  if (!bad) console.log('✓ ' + checked + ' task(s): every cited path exists, every verify binary resolves, no brief is stale.');
  console.log('\nWhat this cannot see: a verify target that is unreachable (a database down, a service');
  console.log('not started), and any number quoted in a note. Run each verify once by hand before a');
  console.log('brief asserts it, and never put a number in a brief that the run itself can change —');
  console.log('write where to read it instead.');
  if (bad) { console.error('\n' + bad + ' task(s) failed. Fix the record, `brief --all`, run doctor again.'); process.exit(1); }
}

// --------------------------------------------------------------------- owed
// Work that is only possible in a window between two pieces, recorded so the
// window closing is a decision somebody made rather than a thing nobody saw.
function owedList(r) { return (r.owed ||= []); }

function cmdOwed(sub, rest, flags) {
  const r = readReg();
  if (sub === 'add') {
    if (typeof flags.what !== 'string' || typeof flags.why !== 'string')
      die('owed add --what "..." --why "..." [--window "..."] [--to <key>] [--load-bearing] — what and why both need text');
    if (flags.window !== undefined && typeof flags.window !== 'string') die('--window needs text');
    if (flags.to !== undefined) { if (typeof flags.to !== 'string') die('--to needs a task key'); getTask(r, flags.to); }
    const id = 'o' + String(owedList(r).reduce((m, o) => Math.max(m, parseInt(o.id.slice(1), 10) || 0), 0) + 1).padStart(2, '0');
    owedList(r).push({ id, what: flags.what, why: flags.why, window: flags.window || '',
      to: flags.to || '', loadBearing: !!flags['load-bearing'], status: 'open', at: now() });
    writeReg(r);
    console.log(id + ' recorded' + (flags.to ? ', assigned to ' + flags.to : ' — UNASSIGNED. An owed item nobody owns is one the window closes on.'));
  } else if (sub === 'assign') {
    const o = owedList(r).find((x) => x.id === rest[0]); if (!o) die('no owed item ' + rest[0]);
    if (!flags.to) die('need --to <task key>');
    getTask(r, flags.to); o.to = flags.to; writeReg(r);
    console.log(o.id + ' → ' + flags.to + '. Put it in that task\'s brief — an assignment the agent never sees is not one.');
  } else if (sub === 'done') {
    const o = owedList(r).find((x) => x.id === rest[0]); if (!o) die('no owed item ' + rest[0]);
    o.status = 'done'; o.doneAt = now(); writeReg(r); console.log(o.id + ' settled.');
  } else if (sub === 'list' || sub === undefined) {
    const os = owedList(r);
    if (!os.length) return console.log('nothing is owed.');
    for (const o of os) {
      console.log(o.id + '  ' + o.status.padEnd(6) + (o.loadBearing ? 'LOAD-BEARING  ' : '              ') +
        (o.to ? '→ ' + o.to : 'UNASSIGNED').padEnd(14) + o.what);
      if (o.status === 'open') console.log('      why: ' + o.why + (o.window ? '   window: ' + o.window : ''));
    }
  } else die('owed add|assign <id> --to <key>|done <id>|list');
}

// -------------------------------------------------------------- wave gating
// A wave is finished when every task in it has landed AND the main line has
// been through CI. Not before, and no chip of the next wave exists until then.
function waveOf(r, key) {
  for (const w of waves(r)) if (w.tasks.some((t) => t.key === key)) return w.wave;
  return -1;
}
function waveState(r, n) {
  const w = waves(r).find((x) => x.wave === n);
  if (!w) return null;
  const landed = w.tasks.filter((t) => t.status === 'landed');
  const ci = (r.ci || {})[String(n)] || null;
  return { n, tasks: w.tasks, landed, allLanded: landed.length === w.tasks.length, ci,
           green: !!ci && ['green', 'skipped'].includes(ci.status) };
}
// Why the next wave may not be opened yet — empty means it may.
function blocking(r, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const st = waveState(r, i);
    if (!st) continue;
    if (!st.allLanded) out.push('round ' + (i + 1) + ': ' +
      st.tasks.filter((t) => t.status !== 'landed').map((t) => t.key + '(' + t.status + ')').join(' '));
    else if (!st.green) out.push('round ' + (i + 1) + ': all landed, but CI has not been recorded green');
  }
  return out;
}

function waveArg(flags) {
  if (flags.wave === undefined) return undefined;
  // a bare --wave parses as boolean true, and Number(true) is 1 — reject it
  if (!/^[0-9]+$/.test(String(flags.wave)) || Number(flags.wave) < 1)
    die('--wave needs a round number counting from 1, got: ' + (flags.wave === true ? '(nothing)' : flags.wave));
  return Number(flags.wave) - 1;
}

function cmdCi(flags) {
  const r = readReg();
  const wa = waveArg(flags);
  const n = wa !== undefined ? wa : currentWave(r);
  const st = waveState(r, n);
  if (!st) die('there is no round ' + (n + 1));
  const status = flags.status;
  if (!['green', 'red', 'skipped'].includes(status)) die('--status must be green, red or skipped');
  if (status === 'skipped' && !flags.why) die('--status skipped needs --why "..." — a missing CI run is a decision, not an omission');
  if (!st.allLanded && status !== 'red')
    die('round ' + (n + 1) + ' has not all landed yet, so this cannot close it:\n       ' +
        st.tasks.filter((t) => t.status !== 'landed').map((t) => t.key).join(' '));
  (r.ci ||= {})[String(n)] = { status, ref: flags.ref || '', why: flags.why || '', at: now() };
  writeReg(r);
  console.log('round ' + (n + 1) + ' CI: ' + status + (flags.ref ? '  ' + flags.ref : ''));
  if (status === 'green' || status === 'skipped') {
    const nxt = waveState(r, n + 1);
    console.log(nxt ? 'Round ' + (n + 2) + ' may now be opened: ' + nxt.tasks.map((t) => t.key).join(' ')
                    : 'That was the last round.');
    const owedOpen = (r.owed || []).filter((o) => o.status === 'open');
    if (owedOpen.length) {
      console.log('\n⚠ the round closed with ' + owedOpen.length + ' owed item(s) still open:');
      for (const o of owedOpen) console.log('    ' + o.id + '  ' + (o.to ? '→ ' + o.to : 'UNASSIGNED') +
        (o.loadBearing ? '  LOAD-BEARING' : '') + '  ' + o.what);
      console.log('  A window that closes on an unassigned item closes for good. Assign each or');
      console.log('  mark it done — do not let the next round bury them.');
    }
  } else if (status === 'red') console.log('Nothing of the next round is created. Send the break back to whoever owns those files.');
}

// The round that needs attention. A round that has fully landed but has no CI
// recorded is the one holding everything up — it comes first, ahead of whatever
// is nominally in flight.
function currentWave(r) {
  const ws = waves(r).filter((w) => w.wave >= 0);
  for (const w of ws) {
    const st = waveState(r, w.wave);
    if (st.allLanded && !st.green) return w.wave;
  }
  for (const w of ws) if (w.tasks.some((t) => t.status !== 'landed')) return w.wave;
  return Math.max(0, ws.length - 1);
}

function cmdWave(flags) {
  const r = readReg();
  const wa = waveArg(flags);
  const n = wa !== undefined ? wa : currentWave(r);
  const st = waveState(r, n);
  if (!st) die('there is no round ' + (n + 1));
  console.log('Round ' + (n + 1) + ' of ' + waves(r).filter((w) => w.wave >= 0).length +
              '  —  ' + st.landed.length + ' of ' + st.tasks.length + ' landed');
  console.log('');
  for (const t of st.tasks) console.log('  ' + (t.status === 'landed' ? '●' : '·') + ' ' +
    t.key.padEnd(12) + t.status.padEnd(11) + t.title.slice(0, 44));
  console.log('');
  if (!st.allLanded) console.log('Not finished. The next round does not exist yet.');
  else if (!st.green) {
    console.log('All landed. CI has not been recorded — the next round still does not exist.');
    console.log('  node driver.mjs ci --status green --ref <run>');
  } else console.log('Finished and CI ' + st.ci.status + '. The next round may be opened.');
  const b = blocking(r, n);
  if (b.length) { console.log('\nEarlier rounds still holding this one up:'); for (const x of b) console.log('  ' + x); }
}

function cmdChip(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  if (['landed', 'reported', 'cancelled'].includes(t.status))
    die(key + ' is ' + t.status + ' — a chip cannot rewind it. If this is really meant to run again, that is a new task.');
  const n = waveOf(r, key);
  const stop = blocking(r, n);
  if (stop.length && !t.chip) {
    console.error('✗ ' + key + ' is in round ' + (n + 1) + ', and an earlier round is not finished.');
    console.error('  No chip of this round exists yet, and none is created until:');
    for (const x of stop) console.error('    ' + x);
    console.error('\n  Everything already merged has to be proved together before more work starts');
    console.error('  from it. Finish the round, land it, run CI, record it:');
    console.error('    node driver.mjs wave');
    console.error('    node driver.mjs ci --status green --ref <run>');
    process.exit(1);
  }
  if (flags.id) t.chip = flags.id;
  if (flags.worktree) t.worktree = flags.worktree;
  const held = heldNeeds(r, t);
  t.status = held.length ? 'held' : 'ready';
  writeReg(r);
  console.log(t.key + '  ' + t.status + (held.length ? '  waiting for ' + held.join(', ') : '  can start now'));
  if (held.length) {
    console.log('');
    console.log('⚠ This should not have happened. A round only opens once every round before it has');
    console.log('  landed, so nothing in the round being created can still be waiting. Either this');
    console.log('  task is in the wrong round, or ' + held.join(', ') + ' was never recorded as landed.');
    console.log('  Check `wave` and `graph` before you let anyone click that chip.');
  }
}

function cmdAgent(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  if (!flags.name) die('need --name <peer name it checked in from>');
  t.agent = flags.name;
  if (t.status === 'planned') t.status = (t.needs || []).some((n) => getTask(r, n).status !== 'landed') ? 'held' : 'ready';
  writeReg(r);
  console.log(key + ' is reachable at ' + t.agent + '  (' + t.status + ')');
  const stillHeld = (t.needs || []).filter((n) => getTask(r, n).status !== 'landed');
  if (stillHeld.length) console.log('Reply to it now: you are on hold until ' + stillHeld.join(', ') + ' land. Do not start.');
}

function cmdRelease(key) {
  const r = readReg(); const t = getTask(r, key);
  if (['landed', 'reported', 'cancelled'].includes(t.status))
    die(key + ' is ' + t.status + ' — releasing it would rewind finished work.');
  const held = heldNeeds(r, t);
  if (held.length) { console.error('✗ cannot release ' + key + ' — still waiting for ' + held.join(', ') + ' (not landed)'); process.exit(1); }
  t.status = 'ready';
  writeReg(r);
  if (!t.agent) console.log('⚠ ' + key + ' has never checked in — you have no address for it. Wait for its check-in.\n');
  console.log('Send this with SendMessage to ' + (t.agent || '<no address yet>') + ':\n');
  console.log('requirements are done, you may start.');
  console.log('');
  console.log((t.needs || []).length
    ? 'What you were waiting for has landed on the main line: ' + t.needs.join(', ') + '.'
    : 'Nothing was blocking you.');
  console.log('');
  console.log('**Before you write a line, prove your copy actually has that work in it.** Your copy was');
  console.log('made when the chip was opened, which may have been before any of it landed. Run this:');
  console.log('');
  console.log('```bash');
  console.log('git fetch --all -q 2>/dev/null; git log --oneline -1');
  for (const n of t.needs || []) {
    const d = depOf(r, n);
    if (!d) { console.log('# ' + n + ' is not on record — fix the needs list before releasing'); continue; }
    console.log(d.landedSha
      ? 'git merge-base --is-ancestor ' + d.landedSha + ' HEAD && echo "' + n + ' is in" || echo "' + n + ' is MISSING"'
      : '# ' + n + ' landed with no commit recorded — ask before trusting your copy');
  }
  console.log('```');
  console.log('');
  console.log('If anything says MISSING, do not work around it and do not start the independent-looking');
  console.log('half. Bring your copy up to date with the main line first, or say so and wait.');
  console.log('');
  console.log('The rules in your brief have not changed: only the files listed there, no guessing, and');
  console.log('report both ways when the checks pass.');
}

function cmdDone(key) {
  const r = readReg(); const t = getTask(r, key);
  const rep = stdinJson();
  (t.reports ||= []).push({ ...rep, at: now() });
  t.status = 'reported';
  writeReg(r);
  console.log(key + ' recorded as finished by its own account. Not landed until it is checked again.');
}

function worktreeFor(t) {
  if (t.worktree && fs.existsSync(t.worktree)) return t.worktree;
  try {
    const out = execSync('git worktree list --porcelain', { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) cur = line.slice(9).trim();
      if (line.startsWith('branch ') && line.slice(7).trim() === 'refs/heads/' + t.branch) return cur;
    }
  } catch { /* no git */ }
  return null;
}

function cmdGuard(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  const wt = worktreeFor(t);
  if (!wt) die('cannot find a copy of the repository on branch ' + t.branch +
    '\n       Record it: driver.mjs chip ' + key + ' --worktree <path>');
  const base = flags.base || 'main';
  let changed;
  try {
    changed = execSync('git diff --name-only ' + base + '...' + t.branch, { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((x) => x.trim()).filter(Boolean);
  } catch (e) { die('could not diff ' + base + '...' + t.branch + ' in ' + wt); }
  if (!changed.length) { console.log('⚠ ' + key + ' changed nothing at all against ' + base + '. That is not finished work.'); process.exit(1); }
  const allowed = t.owns || [];
  const bad = changed.filter((f) => !allowed.some((o) => collides(f, o)));
  console.log(key + ' changed ' + changed.length + ' file(s) on ' + t.branch + ':');
  for (const f of changed) console.log('  ' + (bad.includes(f) ? '✗' : '✓') + ' ' + f);
  if (bad.length) {
    console.log('\n✗ ' + bad.length + ' file(s) outside what it was allowed to touch:');
    for (const f of bad) console.log('    ' + f);
    console.log('\n  Allowed: ' + allowed.join(', '));
    console.log('  Send it back. Do not fix it here — you would be writing code, and you would be');
    console.log('  writing it in the one place that has to stay able to judge it.');
    process.exit(1);
  }
  console.log('\n✓ everything it changed was its to change. Safe to join up.');
}

function cmdLanded(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  if (t.status !== 'reported') die(key + ' is "' + t.status + '" — it cannot land before it reports finished');
  t.status = 'landed'; t.landedAt = now();
  t.landedSha = flags.sha || '';
  const wv = waveOf(r, key);
  if (wv >= 0 && (r.ci || {})[String(wv)]) {
    delete r.ci[String(wv)];
    console.log('round ' + (wv + 1) + ' had a CI result on record — invalidated, because this landing changed the main line after that run.');
  }
  if (!t.landedSha) console.log('(no --sha given: a released chip cannot then prove its copy carries this work)');
  writeReg(r);
  const freed = tasks(r).filter((x) => x.status === 'held' && (x.needs || []).includes(key) &&
    heldNeeds(r, x).length === 0);
  console.log(key + ' landed.');
  if (freed.length) { console.log('\nThese were waiting only on it and can be released now:'); for (const f of freed) console.log('  driver.mjs release ' + f.key); }
  else console.log('Nothing was freed by it.');
}

// The orchestrator builds nothing. If work is sitting in the main checkout on
// files that belong to a task, somebody has done a chip's job here.
function trespass(r) {
  let out = [];
  try {
    const dirty = execSync('git status --porcelain', { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
      .map((l) => l.includes(' -> ') ? l.split(' -> ')[1] : l);
    for (const f of dirty) for (const t of tasks(r)) {
      if ((t.owns || []).some((o) => collides(f, o))) out.push({ file: f, key: t.key });
    }
  } catch { /* not a git repo, or git unavailable — skip */ }
  return out;
}


// ---------------------------------------------------------------- the ledger
// A context forgets what it promised. This does not. Every word that passes
// between the orchestrator and an agent is appended here, and `outstanding`
// reads it back as "who is waiting on you".
function ledgerPath() {
  return path.join(path.dirname(path.resolve(CWD, REG_PATH)), 'messages.jsonl');
}
function append(entry) {
  const f = ledgerPath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify({ at: now(), ...entry }) + '\n');
}
function ledger() {
  const f = ledgerPath();
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const OUT_KINDS = ['release', 'reply', 'sendback', 'note', 'hold', 'announce'];
const IN_KINDS = ['checkin', 'report', 'question', 'blocked', 'note'];

function cmdSay(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  const kind = flags.kind || 'note';
  if (!OUT_KINDS.includes(kind)) die('kind must be one of: ' + OUT_KINDS.join(', '));
  if (!flags.text) die('need --text "what you actually sent"');
  append({ dir: 'out', key, kind, agent: t.agent || '', text: flags.text });
  console.log('logged: → ' + key + ' [' + kind + ']');
}

function cmdHeard(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  const kind = flags.kind || 'note';
  if (!IN_KINDS.includes(kind)) die('kind must be one of: ' + IN_KINDS.join(', '));
  if (!flags.text) die('need --text "what they actually said"');
  append({ dir: 'in', key, kind, agent: t.agent || '', text: flags.text });
  t.lastHeard = now();
  writeReg(r);
  console.log('logged: ← ' + key + ' [' + kind + ']');
  if (kind === 'question' || kind === 'blocked')
    console.log('  It is now waiting on you. `outstanding` will keep saying so until you log a reply.');
}

function cmdOutstanding() {
  const r = readReg(); const log = ledger();
  const rows = [];
  for (const t of tasks(r)) {
    const mine = log.filter((e) => e.key === t.key);
    const lastAsk = [...mine].reverse().find((e) => e.dir === 'in' && ['question', 'blocked'].includes(e.kind));
    if (lastAsk) {
      const replied = mine.some((e) => e.dir === 'out' && e.at > lastAsk.at);
      if (!replied) rows.push({ key: t.key, why: 'asked you something and has had no answer',
        detail: lastAsk.text.slice(0, 90), since: lastAsk.at });
    }
    if (t.status === 'reported') rows.push({ key: t.key, why: 'says it is finished and is waiting on your check',
      detail: ((t.reports || []).slice(-1)[0] || {}).verified || '', since: ((t.reports || []).slice(-1)[0] || {}).at || '' });
    if (t.status === 'held' && (t.needs || []).every((n) => { const d = tasks(r).find((x) => x.key === n); return d && d.status === 'landed'; }))
      rows.push({ key: t.key, why: 'is free to start and has not been released', detail: 'waited for ' + (t.needs || []).join(', '), since: '' });
    if (t.status === 'planned' && t.agent)
      rows.push({ key: t.key, why: 'checked in but was never told where it stands', detail: '', since: '' });
  }
  if (!rows.length) return console.log('Nothing is waiting on you.');
  console.log('These are waiting on you. Deal with each one — none of them will ask twice.\n');
  for (const x of rows) {
    console.log('  ' + x.key.padEnd(10) + x.why);
    if (x.detail) console.log('             “' + x.detail + '”');
    if (x.since) console.log('             since ' + x.since.slice(0, 19).replace('T', ' '));
  }
  console.log('\n' + rows.length + ' outstanding.');
}

// ------------------------------------------------------------------- resume
// A session dies and fifty agents keep messaging an address nobody reads.
function cmdResume(flags) {
  const r = readReg();
  if (!flags.name) die('need --name <your new peer name> — get it from `whoami`');
  const was = r.orchestrator || '(none recorded)';
  r.orchestrator = flags.name;
  writeReg(r);
  console.log('The run is now yours. It was ' + was + '; it is ' + flags.name + '.\n');
  console.log('Every brief names the old address, so they are all wrong. Rewriting them:');
  console.log('  node driver.mjs brief --all\n');
  const live = tasks(r).filter((t) => t.agent && !['landed', 'cancelled'].includes(t.status));
  if (live.length) {
    console.log('Then send this to each of these ' + live.length + ' agent(s):\n');
    console.log('  ---8<---');
    console.log('  The session running this changed. I am ' + flags.name + ' — reply to me from now on,');
    console.log('  not to ' + was + '. Nothing about your work has changed. Your brief was rewritten with');
    console.log('  the new address; re-read it before you go on. If you asked something and never got an');
    console.log('  answer, ask me again — I may not have it.');
    console.log('  ---8<---\n');
    for (const t of live) console.log('  ' + t.key.padEnd(10) + t.agent.padEnd(18) + t.status);
  } else console.log('No agent has checked in yet, so there is nobody to re-announce to.');
  console.log('\nThen work through what was left mid-air:');
  console.log('  node driver.mjs outstanding');
}

function cmdBoard() {
  const r = readReg();
  if (!tasks(r).length) return console.log('no tasks yet');
  const ICON = { planned: '·', held: '⏸', ready: '▶', reported: '✓?', landed: '●', cancelled: '✗' };
  console.log('key'.padEnd(14) + 'state'.padEnd(11) + 'waits for'.padEnd(14) + 'address'.padEnd(18) + 'title');
  console.log('-'.repeat(90));
  for (const t of tasks(r)) {
    const held = (t.needs || []).filter((n) => { const d = tasks(r).find((x) => x.key === n); return !d || d.status !== 'landed'; });
    console.log(t.key.padEnd(14) + ((ICON[t.status] || '?') + ' ' + t.status).padEnd(11) +
      (held.length ? held.join(',') : '—').padEnd(14) + (t.agent || 'not checked in').padEnd(18) + t.title.slice(0, 32));
  }
  const n = (s) => tasks(r).filter((t) => t.status === s).length;
  console.log('\n' + n('landed') + ' landed · ' + n('reported') + ' waiting on your check · ' +
    n('ready') + ' running · ' + n('held') + ' on hold · ' + n('planned') + ' not yet handed out');
  const stuck = tasks(r).filter((t) => t.status === 'held' && (t.needs || []).every((x) => { const d = tasks(r).find((y) => y.key === x); return d && d.status === 'landed'; }));
  if (stuck.length) console.log('\n⚠ held but nothing is blocking them any more — release: ' + stuck.map((t) => t.key).join(', '));
  const owedOpen = (r.owed || []).filter((o) => o.status === 'open');
  if (owedOpen.length) console.log('\nowed: ' + owedOpen.length + ' open (' +
    owedOpen.filter((o) => !o.to).length + ' unassigned) — `owed list`');
  const cw = currentWave(r);
  const cst = waveState(r, cw);
  if (cst) {
    console.log('\nround ' + (cw + 1) + ' of ' + waves(r).filter((w) => w.wave >= 0).length + ': ' +
      cst.landed.length + '/' + cst.tasks.length + ' landed' +
      (cst.allLanded ? (cst.green ? ', CI ' + cst.ci.status + ' — next round may be opened'
                                  : ', CI not recorded — next round is not created yet')
                     : ' — next round is not created yet'));
  }
  const stale = staleBriefs(r);
  if (stale.length) {
    console.log('\n⚠ the record changed after these briefs were written — the agent holding one is');
    console.log('  working from something you have since corrected:');
    for (const t of stale) console.log('    ' + t.key + '  ' + (t.briefFile ? rel(t.briefFile) : ''));
    console.log('  Rewrite with `brief --all`, then tell each affected agent to re-read its brief.');
  }
  const tres = trespass(r);
  if (tres.length) {
    console.log('\n⚠ the main checkout has changes on files that belong to a task:');
    for (const x of tres.slice(0, 8)) console.log('    ' + x.file + '  → belongs to ' + x.key);
    if (tres.length > 8) console.log('    …and ' + (tres.length - 8) + ' more');
    console.log('  You build nothing here. If this is yours, undo it and let ' +
                [...new Set(tres.map((x) => x.key))].join('/') + ' do it in its own copy.');
  }
}

// ------------------------------------------------------------------ dispatch

const argv = process.argv.slice(2);
const flags = {}; const rest = [];
const BOOL_FLAGS = new Set(['stdout', 'all', 'load-bearing']);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    flags[k] = (!BOOL_FLAGS.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  } else rest.push(argv[i]);
}
if (flags.register) REG_PATH = path.resolve(CWD, flags.register);

const cmd = rest.shift();
const HELP = `orchestrate-implementation driver — bookkeeping for a grill session.

  load <path|dir|glob>...   resolve plan files, record sizes. Read them yourself after.
  scan                      find every not-yet-decided phrase. Suspects, not verdicts.
  silence                   name the questions a plan never mentions at all.
  add            < json     record a gap you found by reading, not by scanning.
  list [--status s] [--scope in|out] [--plan p]
  show <id>
  set <id> k=v...           status|scope|title|why|plan|line|section
  research <id>  < json     [{name, url, note}] — what you actually looked up.
  question <id>  < json     {text, options:[{label,gain,cost,recommended}]} — lints, then saves.
  lint [id]                 hold every question to the plain-words rules. Exits 1 on a failure.
  answer <id>    < json     {choice, note, rejected:[{what,why}], carries:[], reaches_back}
  batch                     print the small ones as one approval list.
  status                    the item-by-item account of what is still open.
  check                     exit 1 unless every candidate is judged and every in-scope gap answered.
  render [--out p] [--title t] [--name n] | --plan <p>

making the plans buildable, between the grill and the work:

  refine list               which plans still need it.
  refine brief <plan>       the prompt for the refining agent. It may decide nothing.
  refine done <plan>        read the agent's own report file; records tasks, reopens gaps.
  refine check              exits 1 unless every plan is refined and nothing was reopened.

driving the work out, after the grill:

  whoami [--session id]     your own peer name, so chips can message you back.
  iam <name>                record it, so every brief carries it.
  task add       < json     [{key,title,plan,needs,owns,context,verify,decisions}]
  graph                     the rounds, what runs side by side. Exits 1 when two tasks in one
                            round share a file OR a serialisation point (migration head, lockfile,
                            closed list a test checks exactly).
  preflight brief <key>     prompt for a read-only agent: test the task's owns against the code.
  preflight done <key>      read its report; load-bearing gaps must land back in owns.
  preflight check [--wave n]  exits 1 while the round about to open has unflown or unresolved tasks.
  doctor                    check everything a brief cites that can be checked: paths exist,
                            verify binaries resolve, no brief is stale. Exits 1 on a failure.
  owed add|assign|done|list work only possible in a window between two pieces — record it, assign
                            it, and close no round on top of it silently.
  brief <key> [--stdout]    write the chip's brief to a file; print what to send. --all rewrites every one.
  chip <key> --id <task_id> [--worktree p]    record the chip, set held or ready.
  agent <key> --name <peer>  record where a chip checked in from — without it you cannot release it.
  release <key>             refuses while a requirement has not landed; prints the release message.
  done <key>     < json     {commit, verified, notes} — a chip's own report.
  guard <key> [--base b]    diff its branch and name any file it was not allowed to touch. Exits 1.
  say <key> --kind k --text t     log what you sent (release|reply|sendback|note|hold|announce).
  heard <key> --kind k --text t   log what arrived (checkin|report|question|blocked|note).
  outstanding               who is waiting on you, and since when.
  resume --name <peer>      take over a run after the session running it ended.
  landed <key>              record the merge, and name who that frees.
  board                     every task, its state, and what it waits for.
  wave [--wave n]           the round in flight: what is left, and whether the next may open.
  ci --status green|red|skipped [--ref r] [--why w]   record CI for the round just landed.

  --register <path>         default .claude/orchestration/register.json`;

switch (cmd) {
  case 'load': cmdLoad(rest); break;
  case 'scan': cmdScan(); break;
  case 'silence': cmdSilence(); break;
  case 'add': cmdAdd(); break;
  case 'list': cmdList(flags); break;
  case 'show': cmdShow(rest[0]); break;
  case 'set': cmdSet(rest.shift(), rest); break;
  case 'research': cmdResearch(rest[0]); break;
  case 'question': cmdQuestion(rest[0]); break;
  case 'lint': cmdLint(rest[0]); break;
  case 'answer': cmdAnswer(rest[0]); break;
  case 'batch': cmdBatch(); break;
  case 'status': cmdStatus(); break;
  case 'check': cmdCheck(); break;
  case 'render': cmdRender(flags); break;
  case 'refine': {
    const sub = rest.shift();
    if (sub === 'list') cmdRefineList();
    else if (sub === 'brief') cmdRefineBrief(rest[0]);
    else if (sub === 'done') cmdRefineDone(rest[0], flags);
    else if (sub === 'check') cmdRefineCheck();
    else die('refine list|brief <plan>|done <plan>|check');
    break;
  }
  case 'whoami': cmdWhoami(flags); break;
  case 'iam': { const r = readReg(); r.orchestrator = rest[0] || die('need a name'); writeReg(r); console.log('briefs will tell chips to report to ' + r.orchestrator); break; }
  case 'task': if (rest.shift() !== 'add') die('only `task add` is supported'); cmdTaskAdd(); break;
  case 'graph': cmdGraph(); break;
  case 'brief': if (flags.all) cmdBriefAll(); else cmdBrief(rest[0], flags); break;
  case 'chip': cmdChip(rest[0], flags); break;
  case 'agent': cmdAgent(rest[0], flags); break;
  case 'release': cmdRelease(rest[0]); break;
  case 'done': cmdDone(rest[0]); break;
  case 'guard': cmdGuard(rest[0], flags); break;
  case 'landed': cmdLanded(rest[0], flags); break;
  case 'board': cmdBoard(); break;
  case 'wave': cmdWave(flags); break;
  case 'preflight': {
    const sub = rest.shift();
    if (sub === 'brief') cmdPreflightBrief(rest[0]);
    else if (sub === 'done') cmdPreflightDone(rest[0]);
    else if (sub === 'check') cmdPreflightCheck(flags);
    else die('preflight brief <key>|done <key>|check [--wave n]');
    break;
  }
  case 'doctor': cmdDoctor(); break;
  case 'owed': cmdOwed(rest.shift(), rest, flags); break;
  case 'ci': cmdCi(flags); break;
  case 'say': cmdSay(rest[0], flags); break;
  case 'heard': cmdHeard(rest[0], flags); break;
  case 'outstanding': cmdOutstanding(); break;
  case 'resume': cmdResume(flags); break;
  default: console.log(HELP); process.exit(cmd ? 2 : 0);
}
