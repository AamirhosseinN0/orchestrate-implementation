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

const CWD = process.cwd();
let REG_PATH = path.join(CWD, '.claude', 'orchestration', 'register.json');

const die = (m) => { console.error('error: ' + m); process.exit(2); };
const now = () => new Date().toISOString();

function readReg() {
  if (!fs.existsSync(REG_PATH)) die('no register at ' + rel(REG_PATH) + ' — run `load` first');
  return JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
}
function writeReg(r) {
  fs.mkdirSync(path.dirname(REG_PATH), { recursive: true });
  fs.writeFileSync(REG_PATH, JSON.stringify(r, null, 2) + '\n');
}
const rel = (p) => path.relative(CWD, p) || p;
function nextId(r) {
  const n = r.gaps.reduce((m, g) => Math.max(m, parseInt(g.id.slice(1), 10)), 0);
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
  B.push('**Report back exactly this shape, as JSON:**');
  B.push('');
  B.push('```json');
  B.push('{');
  B.push('  "summary": "what you changed in the plan, in two or three sentences",');
  B.push('  "builtOn": [{"path": "real/path", "what": "what it is and why this work uses it"}],');
  B.push('  "tasks": [{"key": "2.1", "title": "plain title", "needs": ["0.14"],');
  B.push('             "owns": ["paths this work creates or changes"],');
  B.push('             "verify": ["the exact commands that prove it"]}],');
  B.push('  "newGaps": [{"title": "the thing nobody has decided", "why": "why it blocks", "quote": "the sentence"}]');
  B.push('}');
  B.push('```');
  B.push('');
  B.push('`owns` matters more than it looks: two tasks running at once may never touch one file, so');
  B.push('be exact and be narrow. If two pieces of this plan must change the same file, they are one');
  B.push('task, or one waits for the other — say which.');
  console.log(B.join('\n'));
}

function cmdRefineDone(needle) {
  const r = readReg(); const p = planEntry(r, needle);
  const rep = stdinJson();
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
    const rec = { key: t.key, title: t.title || t.key, plan: p.path, needs: t.needs || [],
      owns: t.owns, context: p.builtOn, verify: t.verify || [], decisions: [], notes: '',
      branch: 'step/' + t.key, worktree: '', chip: '', status: 'planned', reports: [] };
    if (ex >= 0) r.tasks[ex] = { ...r.tasks[ex], ...rec }; else r.tasks.push(rec);
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
function norm(p) { return p.replace(/\/+$/, '').replace(/\/\*+$/, ''); }
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
  while (left.length && guard++ < 100) {
    const ready = left.filter((t) => (t.needs || []).every((n) => placed.has(n)));
    if (!ready.length) { out.push({ wave: -1, tasks: left.slice() }); break; }
    out.push({ wave: out.length, tasks: ready });
    ready.forEach((t) => placed.set(t.key, out.length - 1));
    left = left.filter((t) => !ready.includes(t));
  }
  return out;
}

function cmdTaskAdd() {
  const r = readReg(); const inp = stdinJson();
  const items = Array.isArray(inp) ? inp : [inp];
  for (const it of items) {
    if (!it.key || !it.title) die('each task needs a key and a title');
    if (!it.owns || !it.owns.length) die('task "' + it.key + '" declares no files it owns — two tasks may not touch one file, so ownership is not optional');
    const t = {
      key: it.key, title: it.title, plan: it.plan || '', needs: it.needs || [],
      owns: it.owns, context: it.context || [], verify: it.verify || [],
      decisions: it.decisions || [], notes: it.notes || '',
      branch: it.branch || ('step/' + it.key), worktree: '', chip: '',
      status: 'planned', reports: [],
    };
    const at = tasks(r).findIndex((x) => x.key === t.key);
    if (at >= 0) tasks(r)[at] = { ...tasks(r)[at], ...t }; else tasks(r).push(t);
  }
  writeReg(r);
  console.log(tasks(r).length + ' task(s) recorded. Run `graph` to check nothing clashes.');
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
      lines.push('### ⚠ Cannot be ordered — these wait on each other in a circle');
      for (const t of w.tasks) lines.push('- **' + t.key + '** ' + t.title + ' — waits on ' + (t.needs || []).join(', '));
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
    // no two tasks in one round may touch one file
    for (let i = 0; i < w.tasks.length; i++) for (let j = i + 1; j < w.tasks.length; j++) {
      const o = overlap(w.tasks[i], w.tasks[j]);
      if (o.length) {
        bad++;
        lines.push('  ⚠ **' + w.tasks[i].key + '** and **' + w.tasks[j].key + '** would both change the same files: ' + o.join('; '));
        lines.push('    Split the work, or make one wait for the other. They cannot run together.');
      }
    }
    // nor may one read what another is in the middle of changing
    for (const a of w.tasks) for (const b of w.tasks) {
      if (a === b) continue;
      for (const c of a.context || []) for (const ow of b.owns || []) {
        if (!collides(c.path, ow)) continue;
        bad++;
        lines.push('  ⚠ **' + a.key + '** is told to build on `' + c.path + '`, which **' + b.key +
                   '** is rewriting in the same round.');
        lines.push('    It would be reading somebody mid-edit. Make ' + a.key + ' wait for ' + b.key + '.');
      }
    }
    // a task told to build on something it may not touch
    for (const a of w.tasks) for (const c of a.context || []) {
      const ownedHere = (a.owns || []).some((ow) => collides(c.path, ow));
      const ownedLater = tasks(r).some((t) => t !== a && (t.owns || []).some((ow) => collides(c.path, ow)));
      if (!ownedHere && !ownedLater) continue;
      if (ownedHere) continue;
      lines.push('  · **' + a.key + '** builds on `' + c.path + '` but may not change it — read-only. ' +
                 'If it needs to write there, say so now.');
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

function cmdBrief(key) {
  const r = readReg(); const t = getTask(r, key);
  const held = (t.needs || []).filter((n) => getTask(r, n).status !== 'landed');
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
  if (t.plan) { B.push('**The plan.** Read it in full before writing anything: `' + t.plan + '`'); B.push(''); }
  if (t.decisions.length) {
    B.push('**Already settled with the author. Do not reopen, do not improve on:**');
    B.push('');
    for (const d of t.decisions) B.push('- ' + d);
    B.push('');
  }
  B.push('**Build on what is already there. These exist — read them before you write anything that');
  B.push('overlaps, and use them rather than writing your own:**');
  B.push('');
  if (t.context.length) for (const c of t.context) {
    const mine = (t.owns || []).some((ow) => collides(c.path, ow));
    B.push('- `' + c.path + '` — ' + (c.what || '') + (mine ? '' : '  **(read it, do not change it — it is not yours)**'));
  }
  else B.push('- ⚠ nothing recorded. That is a mistake in the brief, not permission to invent. Ask before starting.');
  B.push('');
  B.push('**The only files you may change:**');
  B.push('');
  for (const o of t.owns) B.push('- `' + o + '`');
  B.push('');
  B.push('Another task is working in the same repository right now. If your work needs a file outside');
  B.push('that list, **stop and ask** — do not edit it. Two of you changing one file is the one thing');
  B.push('this arrangement cannot survive.');
  B.push('');
  B.push('**Where you work.** Your own copy of the repository, already made for you:');
  B.push('');
  B.push('```');
  B.push('cd ' + (t.worktree || '<created when you are released>'));
  B.push('```');
  B.push('');
  B.push('It is on the branch `' + t.branch + '`, taken from the main line as it stood once everything');
  B.push('you depend on had landed. Stay in it. Do not touch the main checkout.');
  B.push('');
  B.push('**No guessing.** If the plan does not say, or what it says is not there in the code, stop and');
  B.push('ask the one running the show. Do not narrow the requirement so the wait ends sooner, do not');
  B.push('infer a decision from what you find in another copy of the repository — a change appearing');
  B.push('there is somebody mid-edit, not an answer.');
  B.push('');
  B.push('**Before you say you are done, all of these must pass, and you must paste the output:**');
  B.push('');
  B.push('```bash');
  if (t.verify.length) for (const v of t.verify) B.push(v);
  else B.push('# ⚠ nothing recorded. Ask what counts as proof before you start.');
  B.push('```');
  B.push('');
  B.push('**Then commit your work on your branch.** One clear message, no attribution trailers.');
  B.push('');
  B.push('**Then report, both ways — the message is how it hears, the list is what survives:**');
  B.push('');
  B.push('```bash');
  B.push('node ~/.claude/skills/orchestrate-implementation/driver.mjs --register ' +
         path.resolve(CWD, REG_PATH) + ' done ' + t.key + ' <<\'J\'');
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
  console.log(B.join('\n'));
}

function cmdChip(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  if (flags.id) t.chip = flags.id;
  if (flags.worktree) t.worktree = flags.worktree;
  const held = (t.needs || []).filter((n) => getTask(r, n).status !== 'landed');
  t.status = held.length ? 'held' : 'ready';
  writeReg(r);
  console.log(t.key + '  ' + t.status + (held.length ? '  waiting for ' + held.join(', ') : '  can start now'));
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
  const held = (t.needs || []).filter((n) => getTask(r, n).status !== 'landed');
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
    const d = getTask(r, n);
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
  t.reports.push({ ...rep, at: now() });
  t.status = 'reported';
  writeReg(r);
  console.log(key + ' recorded as finished by its own account. Not landed until it is checked again.');
}

function cmdGuard(key) {
  const r = readReg(); const t = getTask(r, key);
  if (!t.worktree) die('no worktree recorded for ' + key);
  console.log('Run this, then compare against what ' + key + ' was allowed to touch:\n');
  console.log('  git -C ' + t.worktree + ' diff --name-only main...' + t.branch);
  console.log('\nAllowed:');
  for (const o of t.owns) console.log('  ' + o);
  console.log('\nAnything outside that list is a violation — send it back, do not fix it yourself.');
}

function cmdLanded(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  if (t.status !== 'reported') die(key + ' is "' + t.status + '" — it cannot land before it reports finished');
  t.status = 'landed'; t.landedAt = now();
  t.landedSha = flags.sha || '';
  if (!t.landedSha) console.log('(no --sha given: a released chip cannot then prove its copy carries this work)');
  writeReg(r);
  const freed = tasks(r).filter((x) => x.status === 'held' && (x.needs || []).includes(key) &&
    (x.needs || []).every((n) => getTask(r, n).status === 'landed'));
  console.log(key + ' landed.');
  if (freed.length) { console.log('\nThese were waiting only on it and can be released now:'); for (const f of freed) console.log('  driver.mjs release ' + f.key); }
  else console.log('Nothing was freed by it.');
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
}

// ------------------------------------------------------------------ dispatch

const argv = process.argv.slice(2);
const flags = {}; const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
  else rest.push(argv[i]);
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
  refine done <plan> < json {summary, builtOn, tasks, newGaps} — records tasks, reopens gaps.
  refine check              exits 1 unless every plan is refined and nothing was reopened.

driving the work out, after the grill:

  whoami [--session id]     your own peer name, so chips can message you back.
  iam <name>                record it, so every brief carries it.
  task add       < json     [{key,title,plan,needs,owns,context,verify,decisions}]
  graph                     the rounds, what runs side by side. Exits 1 if two tasks share a file.
  brief <key>               the whole self-contained chip prompt. Nothing left to infer.
  chip <key> --id <task_id> [--worktree p]    record the chip, set held or ready.
  agent <key> --name <peer>  record where a chip checked in from — without it you cannot release it.
  release <key>             refuses while a requirement has not landed; prints the release message.
  done <key>     < json     {commit, verified, notes} — a chip's own report.
  guard <key>               check what it changed against what it was allowed to change.
  landed <key>              record the merge, and name who that frees.
  board                     every task, its state, and what it waits for.

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
    else if (sub === 'done') cmdRefineDone(rest[0]);
    else if (sub === 'check') cmdRefineCheck();
    else die('refine list|brief <plan>|done <plan>|check');
    break;
  }
  case 'whoami': cmdWhoami(flags); break;
  case 'iam': { const r = readReg(); r.orchestrator = rest[0] || die('need a name'); writeReg(r); console.log('briefs will tell chips to report to ' + r.orchestrator); break; }
  case 'task': if (rest.shift() !== 'add') die('only `task add` is supported'); cmdTaskAdd(); break;
  case 'graph': cmdGraph(); break;
  case 'brief': cmdBrief(rest[0]); break;
  case 'chip': cmdChip(rest[0], flags); break;
  case 'agent': cmdAgent(rest[0], flags); break;
  case 'release': cmdRelease(rest[0]); break;
  case 'done': cmdDone(rest[0]); break;
  case 'guard': cmdGuard(rest[0]); break;
  case 'landed': cmdLanded(rest[0], flags); break;
  case 'board': cmdBoard(); break;
  default: console.log(HELP); process.exit(cmd ? 2 : 0);
}
