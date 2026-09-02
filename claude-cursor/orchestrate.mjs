#!/usr/bin/env node
// Five stages: load the plans, judge how hard they are, refine away the
// ambiguity, check nothing collides, run the steps.
//
// State lives in .claude/orch/. The record (events.jsonl) is the truth and
// state.json is a projection of it — every change appends the event first and
// writes the projection second, so a crash between the two leaves an event with
// no projection, which is repairable. The other order silently loses the change.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd();
const ORCH = process.env.CURSOR_ORCH_DIR || path.join(CWD, '.claude', 'orch');
const STATE = path.join(ORCH, 'state.json');
const EVENTS = path.join(ORCH, 'events.jsonl');
const sub = (...p) => { const d = path.join(ORCH, ...p); fs.mkdirSync(path.dirname(d), { recursive: true }); return d; };

const die = (msg, code = 2) => { console.error('✗ ' + msg); process.exit(code); };
const ok = (msg) => console.log('✓ ' + msg);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

// ---------------------------------------------------------------- persistence
const EMPTY = { version: 1, created: null, plans: [], tasks: [], notes: [] };
function readState() {
  if (!fs.existsSync(STATE)) return { ...EMPTY, tasks: [], plans: [], notes: [] };
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (e) { die(`state.json is not valid JSON (${e.message}). The record is intact — rebuild from ${EVENTS}`); }
}
// Event first, projection second. See the header.
function commit(s, why, argv) {
  fs.mkdirSync(ORCH, { recursive: true });
  s.created ||= new Date().toISOString();
  const seq = fs.existsSync(EVENTS) ? fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).length + 1 : 1;
  fs.appendFileSync(EVENTS, JSON.stringify({ seq, at: new Date().toISOString(), why, argv: argv || [], state: s }) + '\n');
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
}
const tasks = (s) => s.tasks || [];
const getTask = (s, k) => tasks(s).find((t) => t.key === k) || die(`no step "${k}". Try \`board\`.`);
const depOf = (s, k) => tasks(s).find((t) => t.key === k);

// ------------------------------------------------- the interference engine
// Ported from driver.mjs with its comments, because those comments are the
// record of what broke before. Two open steps touching one file is the single
// failure this whole arrangement exists to prevent.
function norm(p) {
  let x = String(p).replace(/\/+$/, '').replace(/\/\*+$/, '');
  while (x.startsWith('./')) x = x.slice(2);
  x = path.posix.normalize(x);
  return x;
}
function collides(a, b) {
  const x = norm(a), y = norm(b);
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}
function overlap(t1, t2) {
  const out = [];
  for (const a of t1.owns || []) for (const b of t2.owns || []) if (collides(a, b)) out.push(a + ' ↔ ' + b);
  return out;
}
// A serialisation point is a shared invariant named in prose by whoever wrote
// the step — "docker-compose.yml", "docker compose file", "Docker-Compose.yml".
// Comparing those by exact string equality is a check that can only ever fire
// when two authors typed the same characters, and on a real run it never fired
// once: a pre-flight found a docker-compose.yml collision it had reported clean.
// Normalise before comparing; keep both spellings when reporting so the
// mismatch is visible and can be tidied.
const normPoint = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
function sharedPoints(t1, t2) {
  const theirs = new Map();
  for (const y of t2.serialises || []) theirs.set(normPoint(y), y);
  const out = [];
  for (const x of t1.serialises || []) {
    const y = theirs.get(normPoint(x));
    if (y === undefined) continue;
    out.push(y === x ? x : x + ' ≈ ' + y);
  }
  return out;
}
function interference(t, other) {
  const files = overlap(t, other);
  const points = sharedPoints(t, other);
  return files.length || points.length ? { files, points } : null;
}
// A step is open — its files are in somebody's hands — from the moment it is
// handed out until it lands. This used to be keyed off the chip id, which is
// bookkeeping the documented invocation never passed; the effect was that every
// gate reading it went dark. Status is what actually says whether work is out.
const OPEN_STATUSES = ['open', 'reported'];
const DEAD_STATUS = ['landed', 'cancelled'];
const openTasks = (s, except) => tasks(s).filter((x) => x.key !== except && OPEN_STATUSES.includes(x.status));
const heldNeeds = (s, t) => (t.needs || []).filter((n) => { const d = depOf(s, n); return !d || d.status !== 'landed'; });

function waves(s) {
  const ts = tasks(s).filter((t) => t.status !== 'cancelled');
  const placed = new Map(); const out = [];
  let left = ts.slice(), guard = 0;
  while (left.length) {
    if (guard++ >= 1000) break;
    const ready = left.filter((t) => (t.needs || []).every((n) => placed.has(n)));
    if (!ready.length) break;
    out.push({ wave: out.length, tasks: ready });
    ready.forEach((t) => placed.set(t.key, out.length - 1));
    left = left.filter((t) => !ready.includes(t));
  }
  if (left.length) out.push({ wave: -1, tasks: left.slice() });  // a cycle: show it, never drop it
  return out;
}

// The set that can open right now: everything it needs has landed, and nothing
// it owns is in the hands of a step that is already out. Round membership is
// irrelevant — a step three layers deep opens the instant its own dependencies
// land. Accepted steps are checked against each other too, so the set this
// returns is safe to open all at once.
function frontier(s) {
  const open = openTasks(s, null);
  const unblocks = (key) => tasks(s).filter((x) => !DEAD_STATUS.includes(x.status) && (x.needs || []).includes(key)).length;
  const cands = tasks(s)
    .filter((t) => t.status === 'planned' && heldNeeds(s, t).length === 0)
    .sort((a, b) => unblocks(b.key) - unblocks(a.key) || (a.key < b.key ? -1 : 1));
  const accepted = [], blocked = [];
  for (const t of cands) {
    const clash = [...open, ...accepted].map((o) => ({ o, i: interference(t, o) })).filter((x) => x.i);
    if (clash.length) blocked.push({ t, why: clash }); else accepted.push(t);
  }
  const waiting = tasks(s).filter((t) => t.status === 'planned' && heldNeeds(s, t).length > 0);
  return { open, accepted, blocked, waiting, unblocks };
}

// ------------------------------------------------------------ step validation
// One malformed step poisons every command that reads it later, so the same
// gate runs whoever writes it. `refine done` used to skip this and merge an
// agent's steps in raw, which put a hole in the one invariant that matters on
// the path that creates almost every step.
const LIST_FIELDS = ['needs', 'owns', 'serialises', 'verify', 'context'];
function stepProblems(s, it, existing) {
  const p = [];
  if (!it || typeof it !== 'object' || Array.isArray(it)) return ['is not an object'];
  if (!it.key || typeof it.key !== 'string') p.push('needs a string key');
  if (!existing && !it.title) p.push('needs a title');
  for (const f of LIST_FIELDS) if (it[f] !== undefined && !Array.isArray(it[f])) p.push(`${f} must be a list`);
  for (const o of it.owns || []) {
    if (typeof o !== 'string' || !o.trim()) { p.push('owns has an empty entry'); continue; }
    if (/\s[—–]\s|\s--\s/.test(o)) p.push(`owns entry "${o}" is prose, not a path`);
    else if (/:\d+/.test(o)) p.push(`owns entry "${o}" carries a :line suffix — ownership is whole files`);
    else if (!/[/.]/.test(o) && o.split(/\s+/).length > 1) p.push(`owns entry "${o}" reads as a sentence, not a path`);
  }
  return p;
}
// Two steps sharing a file is not a reason to refuse the record — it only means
// they cannot be open at the same time, which is `check`'s business and
// `run open`'s gate. Refusing here would make refining impossible the moment
// anything was in flight. So overlaps are reported, loudly, and written down.
function overlapsOf(s, it) {
  const mine = { owns: it.owns || [], serialises: it.serialises || [] };
  const out = [];
  for (const other of tasks(s)) {
    if (other.key === it.key || DEAD_STATUS.includes(other.status)) continue;
    const i = interference(mine, other);
    if (i) out.push({ key: other.key, status: other.status, what: [...i.files, ...i.points.map((x) => 'serialisation point ' + x)].join('; ') });
  }
  return out;
}
function putStep(s, it) {
  const existing = depOf(s, it.key);
  const problems = stepProblems(s, it, existing);
  if (problems.length) return problems;
  const merged = existing ? { ...existing, ...it } : { status: 'planned', needs: [], owns: [], serialises: [], verify: [], ...it };
  if (existing) Object.assign(existing, it); else s.tasks.push(merged);
  return null;
}
function reportOverlaps(s, keys) {
  const lines = [];
  for (const k of keys) {
    const t = depOf(s, k); if (!t) continue;
    for (const o of overlapsOf(s, t)) {
      lines.push(`  ${k} ↔ ${o.key}${OPEN_STATUSES.includes(o.status) ? ' (open right now)' : ''}: ${o.what}`);
    }
  }
  if (lines.length) {
    console.log(`\n${lines.length} overlap(s) — these cannot open at the same time:`);
    for (const l of lines) console.log(l);
    console.log('  If that is not what you meant, one of them owns too much. `check` decides the order.');
  }
}

// ------------------------------------------------------------------ the model
// The ladder is data; this only reads it. Judgement about which rung a step
// deserves is the orchestrator's, recorded by `assess propose` and overridable
// by the user — never computed here.
function ladder() {
  return JSON.parse(fs.readFileSync(path.join(HERE, 'models.json'), 'utf8'));
}
function tierOf(name) {
  const m = ladder();
  const tier = m.roles[name] || name;
  const row = m.ladder.find((r) => r.tier === tier);
  if (!row) die(`unknown role or tier "${name}". Tiers: ${m.ladder.map((r) => r.tier).join(', ')}`);
  return row;
}

// The mechanical signals available about a step. They are thin on purpose:
// nothing here knows how hard code is. They exist so a proposal can be sanity
// checked against something, not so a model can be picked by formula.
function signals(s, t) {
  const plan = (s.plans || []).find((p) => p.path === t.plan);
  return {
    files: (t.owns || []).length,
    needs: (t.needs || []).length,
    checks: (t.verify || []).length,
    planLines: plan ? plan.lines : 0,
  };
}

// ------------------------------------------------------------------- commands
const CMDS = {};

CMDS.load = (argv) => {
  if (!argv.length) die('load needs at least one plan file or directory');
  const s = readState();
  const found = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f));
    else if (/\.(md|markdown|txt)$/i.test(p)) found.push(p);
  };
  for (const a of argv) { if (!fs.existsSync(a)) die(`no such path: ${a}`); walk(a); }
  if (!found.length) die('none of those paths held a plan file (.md, .markdown, .txt)');
  s.plans = found.map((f) => {
    const body = fs.readFileSync(f, 'utf8');
    return { path: path.relative(CWD, f), lines: body.split('\n').length, bytes: Buffer.byteLength(body), sha: sha(body) };
  });
  commit(s, 'load', argv);
  const total = s.plans.reduce((a, p) => a + p.bytes, 0);
  console.log(`${s.plans.length} plan(s), ~${Math.round(total / 5.5 / 1000)}k words:`);
  for (const p of s.plans) console.log(`  ${String(p.lines).padStart(5)} lines  ${p.path}`);
  console.log('\nRead every one of them in full before anything else.');
};

CMDS.step = (argv) => {
  const s = readState();
  if (argv[0] !== 'add') die('step add < json   — a list of {key,title,plan,needs,owns,serialises,verify}');
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) die('step add reads JSON on stdin and got nothing');
  let list; try { list = JSON.parse(raw); } catch (e) { die('that is not valid JSON: ' + e.message); }
  if (!Array.isArray(list)) list = [list];
  const bad = [];
  for (const it of list) { const p = putStep(s, it); if (p) bad.push([it.key || '(no key)', p]); }
  if (bad.length) {
    for (const [k, ps] of bad) { console.error(`✗ ${k}:`); for (const x of ps) console.error('    ' + x); }
    process.exit(1);
  }
  commit(s, 'step add', argv);
  ok(`${list.length} step(s) recorded. ${tasks(s).length} in the register.`);
  reportOverlaps(s, list.map((it) => it.key));
};

// The judgement, as the orchestrator read it. Stored, not computed.
CMDS.assess = (argv) => {
  const s = readState();
  const m = ladder();
  const tiers = m.ladder.map((r) => r.tier);

  if (argv[0] === 'propose') {
    const raw = fs.readFileSync(0, 'utf8').trim();
    let list; try { list = JSON.parse(raw); } catch (e) { die('that is not valid JSON: ' + e.message); }
    for (const it of (Array.isArray(list) ? list : [list])) {
      const t = getTask(s, it.key);
      if (!tiers.includes(it.tier)) die(`step ${it.key}: "${it.tier}" is not a tier. Tiers: ${tiers.join(', ')}`);
      // A choice the user already made is not silently re-proposed.
      if (t.model_by === 'user') { console.log(`  ${t.key}: left on ${t.tier} — you set that yourself`); continue; }
      t.tier = it.tier; t.model_by = 'suggested';
      t.problem = it.problem || t.problem; t.why_model = it.why || t.why_model;
    }
    commit(s, 'assess propose', argv);
  } else if (argv[0] === 'set') {
    for (const pair of argv.slice(1)) {
      const [k, tier] = pair.split('=');
      if (!tier) die(`--set wants KEY=tier, got "${pair}"`);
      const t = getTask(s, k);
      if (!tiers.includes(tier)) die(`"${tier}" is not a tier. Tiers: ${tiers.join(', ')}`);
      t.tier = tier; t.model_by = 'user';
    }
    commit(s, 'assess set', argv);
  } else if (argv[0] === 'check') {
    const missing = tasks(s).filter((t) => !DEAD_STATUS.includes(t.status) && !t.tier);
    if (missing.length) die(`${missing.length} step(s) have no model yet: ${missing.map((t) => t.key).join(' ')}`, 1);
    ok('every step has a model');
    return;
  } else if (argv.length) die('assess [propose < json | set KEY=tier ... | check]');

  const rows = tasks(s).filter((t) => !DEAD_STATUS.includes(t.status));
  if (!rows.length) { console.log('No steps yet — refine the plans first.'); return; }
  const w = (a, n) => String(a ?? '').slice(0, n).padEnd(n);
  console.log(w('step', 8) + w('problem', 42) + w('scope', 16) + w('model', 10) + 'why');
  console.log('-'.repeat(112));
  for (const t of rows) {
    const g = signals(s, t);
    const scope = `${g.files} file${g.files === 1 ? '' : 's'}` + (g.needs ? `, ${g.needs} dep` : '');
    console.log(w(t.key, 8) + w(t.problem || t.title, 42) + w(scope, 16) +
      w((t.tier || '—') + (t.model_by === 'user' ? '*' : ''), 10) + String(t.why_model || '').slice(0, 40));
  }
  console.log('\n* you set it. Change any row with:  assess set <key>=<tier>');
  console.log('Tiers, weakest first: ' + tiers.join(' → '));
};

CMDS.check = () => {
  const s = readState();
  const f = frontier(s);
  let bad = 0;
  // A cycle in the dependencies is not a scheduling problem, it is a mistake.
  const w = waves(s);
  const cyc = w.find((x) => x.wave === -1);
  if (cyc) { console.log('✗ these steps depend on each other in a loop: ' + cyc.tasks.map((t) => t.key).join(' ')); bad++; }
  if (f.open.length) console.log('Open right now (' + f.open.length + '): ' + f.open.map((t) => t.key).join('  ') + '\n');
  if (f.accepted.length) {
    console.log(`Can open together, nothing they touch is in flight (${f.accepted.length}):`);
    for (const t of f.accepted) {
      const n = f.unblocks(t.key);
      console.log('  ' + t.key.padEnd(10) + (t.tier || '—').padEnd(10) + String(t.title || '').slice(0, 46) + (n ? `   → unblocks ${n}` : ''));
    }
    console.log('\nOpen all of them. Opening one at a time is the slowest thing this can do.');
  } else console.log('Nothing new can open right now.');
  if (f.blocked.length) {
    console.log('\nReady, but they would interfere with open work:');
    for (const { t, why } of f.blocked) for (const { o, i } of why) {
      console.log('  ' + t.key.padEnd(10) + '↔ ' + o.key + '  on ' +
        [...i.files, ...i.points.map((x) => 'serialisation point ' + x)].join('; '));
    }
  }
  if (f.waiting.length) console.log('\nWaiting on work to land: ' + f.waiting.map((t) => t.key).join('  '));
  process.exit(bad ? 1 : 0);
};

// The ladder lives in models.json and models.mjs owns it; this is only a way to
// see it without knowing where the scripts are.
CMDS.models = (argv) => {
  const r = execFileSync('node', [path.join(HERE, 'scripts', 'models.mjs'), ...(argv.length ? argv : ['list'])],
    { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  process.stdout.write(r);
};

CMDS.board = () => {
  const s = readState();
  const rows = tasks(s);
  if (!rows.length) { console.log('Nothing yet.'); return; }
  const by = {};
  for (const t of rows) (by[t.status] ||= []).push(t);
  for (const st of ['open', 'reported', 'planned', 'landed', 'cancelled']) {
    if (!by[st]) continue;
    console.log(`\n${st} (${by[st].length}):`);
    for (const t of by[st]) {
      const held = heldNeeds(s, t);
      const runs = (t.runs || []).length;
      console.log('  ' + t.key.padEnd(10) + (t.tier || '—').padEnd(9) +
        String(t.title || '').slice(0, 44).padEnd(46) +
        (held.length ? 'waits on ' + held.join(',') : '') + (runs ? `  ${runs} run(s)` : ''));
    }
  }
};

// ------------------------------------------------------------------- refining
const planSlug = (p) => String(p).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
const refineReport = (p) => sub('refine', planSlug(p) + '.json');

CMDS.refine = (argv) => {
  const [what, plan] = argv;
  const s = readState();
  if (what === 'brief') {
    if (!plan) die('refine brief <plan>');
    const rec = (s.plans || []).find((p) => p.path === plan || p.path.endsWith('/' + plan));
    if (!rec) die(`"${plan}" is not a loaded plan. Try \`load\` first, or one of:\n  ` + (s.plans || []).map((p) => p.path).join('\n  '));
    const out = refineReport(rec.path);
    console.log(`Refine one implementation plan so it can be built from, without anyone
having to guess.

The plan: ${rec.path}  (${rec.lines} lines)

Read it in full, then read the code it talks about. Your job is to make the plan
match the repository as it actually is — not to design anything new, and not to
decide anything the plan deliberately left open.

Do two things:

1. Edit ${rec.path} in place. Replace every instruction that cannot be followed
   literally: a path that does not exist, a function that was renamed, a command
   that would not run, an order that is impossible. Leave the intent alone.

2. Write your report to ${path.relative(CWD, out)} as JSON:

   {
     "summary": "what you changed and why, in a few sentences",
     "builtOn": [{"path": "src/x.ts", "what": "what you read there"}],
     "openQuestions": ["anything you could not settle from the code"],
     "steps": [{
       "key": "S-1",
       "title": "one line",
       "owns": ["every file this step may write, whole paths only"],
       "serialises": ["shared invariants it moves: a lockfile, a migration head"],
       "needs": ["keys of steps that must land first"],
       "verify": ["the command that proves it worked"]
     }]
   }

   \`owns\` is the important one. Two steps that own the same file cannot run at
   the same time, so a list that is too narrow causes a collision nobody sees
   until the merge. List what the step will actually write, including tests and
   generated files.

Report the file written, not a summary in your reply.`);
    return;
  }
  if (what === 'done') {
    if (!plan) die('refine done <plan>');
    const rec = (s.plans || []).find((p) => p.path === plan || p.path.endsWith('/' + plan)) || die(`"${plan}" is not a loaded plan`);
    const f = refineReport(rec.path);
    if (!fs.existsSync(f)) die(`no report at ${path.relative(CWD, f)} — the agent did not write one.\n  Its own reply is not a substitute: that route goes through a context that gets compacted.`);
    let rep; try { rep = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { die(`the report at ${f} is not valid JSON: ${e.message}`); }
    const steps = rep.steps || [];
    if (!steps.length) die('the report names no steps');
    // Every step goes through the same gate as a hand-written one. The old
    // driver merged refined steps in raw, which put a hole in the one invariant
    // that matters on the path that creates almost every step.
    const bad = [];
    for (const it of steps) { const p = putStep(s, { ...it, plan: rec.path }); if (p) bad.push([it.key || '(no key)', p]); }
    if (bad.length) {
      console.error('✗ the report has steps that cannot be recorded as written:');
      for (const [k, ps] of bad) { console.error(`  ${k}:`); for (const x of ps) console.error('    ' + x); }
      process.exit(1);
    }
    rec.refined = new Date().toISOString();
    rec.openQuestions = rep.openQuestions || [];
    commit(s, 'refine done', argv);
    ok(`${steps.length} step(s) from ${rec.path}: ${steps.map((t) => t.key).join(' ')}`);
    reportOverlaps(s, steps.map((t) => t.key));
    if (rec.openQuestions.length) {
      console.log(`\n${rec.openQuestions.length} thing(s) it could not settle from the code — put these to the user before building:`);
      for (const q of rec.openQuestions) console.log('  · ' + q);
    }
    return;
  }
  if (what === 'check') {
    const un = (s.plans || []).filter((p) => !p.refined);
    if (un.length) die(`${un.length} plan(s) not refined yet: ` + un.map((p) => p.path).join(' '), 1);
    const open = (s.plans || []).flatMap((p) => p.openQuestions || []);
    if (open.length) die(`${open.length} open question(s) from refining still unanswered`, 1);
    ok('every plan is refined and nothing is left open');
    return;
  }
  die('refine brief <plan> | refine done <plan> | refine check');
};

// ------------------------------------------------------------------ running
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
// For probes that are expected to fail: their complaint is not the user's news.
const shq = (cmd, args) => sh(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });

CMDS.run = (argv) => {
  const [what, key] = argv;
  const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  const s = readState();

  if (what === 'open') {
    const t = getTask(s, key);
    if (t.status !== 'planned') die(`${key} is already ${t.status}`);
    if (!t.tier) die(`${key} has no model yet — run \`assess\` first`);
    const held = heldNeeds(s, t);
    if (held.length) die(`${key} needs ${held.join(', ')} to land first`);
    // The same gate as everything else: nothing opens onto files in flight.
    for (const o of openTasks(s, key)) {
      const i = interference(t, o);
      if (i) die(`${key} would collide with ${o.key}, which is open: ` +
        [...i.files, ...i.points.map((x) => 'serialisation point ' + x)].join('; '));
    }
    const row = tierOf(t.tier);
    t.branch = t.branch || `step/${key}`;
    // Beside the project, named after it. A bare `wt-<key>` in the parent
    // directory collides with every other project doing the same thing, and the
    // second one to try inherits a worktree pointing at somebody else's repo.
    const wtRoot = process.env.CURSOR_ORCH_WT || path.resolve(CWD, '..');
    t.worktree = t.worktree || path.join(wtRoot, `${path.basename(CWD)}-wt-${key}`);
    if (!fs.existsSync(t.worktree)) {
      try { sh('git', ['worktree', 'add', t.worktree, '-b', t.branch]); }
      catch (e) { die(`could not make a worktree at ${t.worktree}\n  ${String(e.stderr || e.message).trim()}`); }
    } else {
      // Something is already there. If git does not know about it, it is not a
      // worktree of this repo and opening onto it would write into a stranger.
      const known = (() => { try { return shq('git', ['worktree', 'list']).includes(t.worktree); } catch { return false; } })();
      if (!known) die(`${t.worktree} already exists and is not a worktree of this repo.\n  Move it, or pass a different one.`);
    }
    if (!t.chat) t.chat = sh('bash', [path.join(HERE, 'scripts', 'cursor-chat.sh')]);
    const brief = sub('briefs', key + '.md');
    fs.writeFileSync(brief, briefText(s, t, row));
    t.briefFile = path.relative(CWD, brief);
    // What the brief was written from. A step whose owns or verify changed
    // afterwards is holding an agent to instructions nobody has revised.
    t.briefSha = sha(JSON.stringify([t.owns, t.serialises, t.verify, t.needs, t.title, t.plan]));
    t.status = 'open'; t.openedAt = new Date().toISOString();
    commit(s, 'run open', argv);
    ok(`${key} is open on ${row.shown}`);
    console.log(`  worktree  ${t.worktree}\n  branch    ${t.branch}\n  chat      ${t.chat}\n  brief     ${t.briefFile}`);
    // The shorter of the two spellings. A skill installed far from the project
    // relativises to a ../../../.. chain nobody can read or check.
    const rel = path.relative(CWD, path.join(HERE, 'scripts', 'run.sh'));
    const abs = path.join(HERE, 'scripts', 'run.sh');
    const runner = rel.length < abs.length && !rel.startsWith('../..') ? rel : abs;
    console.log(`\nLaunch it in the background:\n  bash ${runner} \\\n    --role chip --tier ${t.tier} --key ${key} --workspace ${t.worktree} \\\n    --chat ${t.chat} --prompt-file ${t.briefFile}`);
    // Opening one at a time is the slowest thing this can do, and it is easy to
    // do by accident — one `run open` reads like progress. So the ones still
    // waiting are counted here rather than left for somebody to run `check`.
    const more = frontier(readState()).accepted;
    if (more.length) {
      console.log(`\n⚠ ${more.length} more step(s) can open right now and are not: ${more.map((x) => x.key).join(' ')}`);
      console.log('  Open them in this same round. Interference is the only reason to hold one back,');
      console.log('  and none of these interferes with anything — that is what put them on this list.');
    }
    return;
  }

  if (what === 'record') {
    const t = getTask(s, key);
    const log = flag('--log') || flag('--json');
    if (!log) die('run record <key> --log <run.jsonl>   (or --json <record.json> for a Claude Code step)');
    if (!fs.existsSync(log)) die(`no file at ${log}`);
    let rec;
    if (flag('--json')) { rec = JSON.parse(fs.readFileSync(log, 'utf8')); }
    else {
      // Harvest rather than ask: what the run did is in the log, and asking the
      // agent to summarise it is how 36 MB became five lines of prose.
      try { rec = JSON.parse(execFileSync('node', [path.join(HERE, 'scripts', 'harvest.mjs'), log], { encoding: 'utf8', maxBuffer: 1 << 28 })); }
      catch (e) { rec = e.stdout ? JSON.parse(e.stdout) : die('could not harvest ' + log); }
    }
    t.runs ||= [];
    const n = t.runs.length + 1;
    const out = sub('runs', key, n + '.json');
    fs.writeFileSync(out, JSON.stringify(rec, null, 2) + '\n');
    t.runs.push({ n, at: new Date().toISOString(), outcome: rec.outcome, seconds: rec.seconds,
      files: (rec.files || []).length, model: rec.model, record: path.relative(CWD, out) });
    t.status = rec.outcome === 'passed' ? 'reported' : t.status;
    // A run that died is a fact about the run, recorded where it can be seen —
    // not something for somebody to notice in a log tail and type in later.
    if (rec.outcome !== 'passed') {
      (s.notes ||= []).push({ at: new Date().toISOString(), key, kind: rec.outcome,
        text: rec.trouble?.tail || `run ${n} ended ${rec.outcome}` });
    }
    commit(s, 'run record', argv);
    ok(`${key} run ${n}: ${rec.outcome}, ${Math.round((rec.seconds || 0) / 60)}m, ${(rec.files || []).length} file(s) changed`);
    // Files it wrote that it does not own. The log knows this; no second diff.
    const stray = (rec.files || []).map((f) => f.path).filter((p) => !(t.owns || []).some((o) => collides(o, p)));
    if (stray.length) {
      console.log(`\n⚠ ${stray.length} file(s) written that ${key} does not own:`);
      for (const p of stray.slice(0, 12)) console.log('    ' + p);
    }
    return;
  }
  die('run open <key> | run record <key> --log <file>');
};

function briefText(s, t, row) {
  const plan = t.plan || '(no plan recorded)';
  const L = [];
  L.push(`# ${t.key} — ${t.title || ''}`, '');
  L.push(`You are a subprocess, not an interactive session. Nobody is waiting to`,
         `answer you mid-run: if you truly cannot proceed, stop and make your final`,
         `answer the question you need answered. You will be resumed on this chat`,
         `with the reply.`, '');
  L.push(`You are already in your own worktree at ${t.worktree}, on branch`,
         `${t.branch}. It is checked out for you — do not create it, and never`,
         `touch the main checkout.`, '');
  L.push(`## The plan`, '', `Read ${plan} in full before writing anything.`, '');
  if ((t.needs || []).length) L.push(`## Built on`, '', `These landed before you: ${t.needs.join(', ')}. Their work is in your`, `worktree already.`, '');
  L.push(`## What you own`, '', `You may write these and nothing else:`, '');
  for (const o of t.owns || []) L.push(`  - ${o}`);
  L.push('', `Anything outside that list is another step's, and two steps writing one`,
         `file is the single failure this arrangement cannot survive. If you believe`,
         `you need a file you do not own, stop and say so instead of taking it.`, '');
  if ((t.serialises || []).length) {
    L.push(`## Shared ground`, '', `You move these, which other steps also depend on — change them once,`, `deliberately:`, '');
    for (const x of t.serialises) L.push(`  - ${x}`);
    L.push('');
  }
  if ((t.verify || []).length) {
    L.push(`## Proof`, '', `Run these and make them pass before you finish:`, '');
    for (const v of t.verify) L.push(`  ${v}`);
    L.push('');
  }
  L.push(`## Finishing`, '', `Commit on ${t.branch}. Your final answer should say what you changed, what`,
         `you ran, and what came back. Do not add any co-author or generated-by`,
         `trailer to the commit.`, '');
  L.push(`Everything about this run — the files you touched, the commands you ran and`,
         `their exit codes — is read out of your own log afterwards, so you do not`,
         `need to restate it. Say what a person could not read off a diff: what you`,
         `decided, and what you are unsure about.`);
  return L.join('\n') + '\n';
}

CMDS.guard = (argv) => {
  const s = readState();
  const t = getTask(s, argv[0]);
  // The default branch, not "main" flatly — a repo with no remote has no
  // origin/HEAD to ask, and a repo that calls its trunk something else is not
  // wrong. Each fallback is tried in turn and the last one is a guess named as
  // such by the error if it is also absent.
  const guessBase = () => {
    for (const fn of [
      () => shq('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).split('/').pop(),
      () => shq('git', ['config', '--get', 'init.defaultBranch']),
      () => (shq('git', ['branch', '--format=%(refname:short)']).split('\n').find((b) => b === 'main' || b === 'master')),
    ]) { try { const v = fn(); if (v) return v; } catch { /* try the next */ } }
    return 'main';
  };
  const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : guessBase();
  let changed;
  try { changed = sh('git', ['diff', '--name-only', `${base}...${t.branch}`]).split('\n').filter(Boolean); }
  catch { die(`could not diff ${base}...${t.branch}`); }
  const stray = changed.filter((p) => !(t.owns || []).some((o) => collides(o, p)));
  t.guardedAt = new Date().toISOString(); t.guardedBase = base; t.guardedFiles = changed;
  commit(s, 'guard', argv);
  console.log(`${changed.length} file(s) changed on ${t.branch} against ${base}`);
  for (const p of changed) console.log('  ' + ((t.owns || []).some((o) => collides(o, p)) ? ' ' : '✗') + ' ' + p);
  if (stray.length) { console.error(`\n✗ ${stray.length} file(s) it does not own. Send it back.`); process.exit(1); }
  ok('everything it touched, it owns');
};

CMDS.land = (argv) => {
  const s = readState();
  const t = getTask(s, argv[0]);
  const held = heldNeeds(s, t);
  if (held.length) die(`${t.key} cannot land before ${held.join(', ')}`);
  t.status = 'landed'; t.landedAt = new Date().toISOString();
  const i = argv.indexOf('--sha'); if (i !== -1) t.landedSha = argv[i + 1];
  commit(s, 'land', argv);
  ok(`${t.key} landed`);
  const freed = tasks(s).filter((x) => x.status === 'planned' && (x.needs || []).includes(t.key) && heldNeeds(s, x).length === 0);
  if (freed.length) console.log(`  frees: ${freed.map((x) => x.key).join(' ')} — run \`check\` and open everything it names.`);
  else console.log('  run `check`: a landing usually widens what can open.');
};

// -------------------------------------------------------------------- the slot
// One shared machine slot for heavy checks. Twelve agents each deciding to run
// the suite at the same moment is how a box gets taken down, and this exists to
// make that impossible rather than unlikely.
//
// mkdir is the mutex: it is atomic and it fails if the directory is there. Every
// claim carries a token nobody else can guess, so "free this slot" means "free
// the claim I took" rather than "delete whatever is at that path" — the
// difference between a process tidying up after itself and an evicted one wiping
// out the run that replaced it.
import os from 'node:os';
const slotsDir = () => { const d = path.join(ORCH, 'slots'); fs.mkdirSync(d, { recursive: true }); return d; };
const lockOf = (name) => path.join(slotsDir(), String(name).replace(/[^A-Za-z0-9_-]+/g, '-') + '.lock');
const holderOf = (lock) => { try { return JSON.parse(fs.readFileSync(path.join(lock, 'holder.json'), 'utf8')); } catch { return null; } };

function slotTake(name, what) {
  const lock = lockOf(name);
  try { fs.mkdirSync(lock, { recursive: false }); } catch { return null; }
  const claim = { token: crypto.randomBytes(9).toString('hex') + '-' + process.pid,
    pid: process.pid, host: os.hostname(), what: what || '', since: new Date().toISOString() };
  // Written by rename, so a waiter never reads a half-written claim and mistakes
  // it for the "holder unknown" leftover case.
  const tmp = path.join(lock, 'holder.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(claim, null, 2) + '\n');
  fs.renameSync(tmp, path.join(lock, 'holder.json'));
  return { lock, token: claim.token };
}
// Never steal from a holder that can be shown to be alive. A suite legitimately
// running past the time limit is still running, and taking its slot away starts
// a second one beside it — the exact crash this prevents. So liveness is asked
// first, and the limit only reaches a holder whose liveness cannot be
// established: another host, or no pid to check.
function slotStale(lock, staleMs) {
  const h = holderOf(lock);
  if (!h) { try { return Date.now() - fs.statSync(lock).mtimeMs > 10000; } catch { return false; } }
  if (h.pid && h.host === os.hostname()) {
    try { process.kill(h.pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
    // EPERM means it is there and owned by someone else: alive, not ours to judge.
  }
  return Date.now() - Date.parse(h.since || 0) > staleMs;
}
// Rename the whole lock out of the way. Rename is atomic and only one racer wins
// it, so two waiters cannot both conclude they evicted the holder and both go —
// which a check-then-remove let them do. If a fresh claim slipped in between the
// judgement and the rename, it is put straight back.
function slotDrop(lock, judged) {
  const carried = lock + '.evicted.' + process.pid + '.' + Date.now();
  try { fs.renameSync(lock, carried); } catch { return false; }
  const got = holderOf(carried);
  if (got && judged && got.token !== judged) {
    try {
      fs.mkdirSync(lock, { recursive: false });
      fs.renameSync(path.join(carried, 'holder.json'), path.join(lock, 'holder.json'));
      fs.rmSync(carried, { recursive: true, force: true });
      return false;
    } catch { console.error('slot: a claim changed hands mid-eviction and could not be restored.'); }
  }
  fs.rmSync(carried, { recursive: true, force: true });
  return true;
}
const describe = (lock) => {
  const h = holderOf(lock);
  if (!h) return 'held by nobody we can name';
  const mins = Math.round((Date.now() - Date.parse(h.since)) / 60000);
  return `held by pid ${h.pid || '?'} on ${h.host}${h.what ? ' for ' + h.what : ''}, ${mins}m`;
};
const slotLog = (name, what) => {
  try { fs.appendFileSync(path.join(slotsDir(), 'slot.log'),
    JSON.stringify({ at: new Date().toISOString(), slot: name, what }) + '\n'); } catch { /* best effort */ }
};

CMDS.slot = (argv) => {
  const [what, ...rest] = argv;
  const dashdash = argv.indexOf('--');
  const name = (rest[0] && !rest[0].startsWith('-')) ? rest[0] : 'ci';
  const staleMin = Number((argv[argv.indexOf('--stale') + 1]) || 30);
  const staleMs = staleMin * 60000;

  if (what === 'status') {
    const d = slotsDir();
    const held = fs.readdirSync(d).filter((f) => f.endsWith('.lock'));
    if (!held.length) console.log('no slot is held.');
    for (const f of held) console.log(f.replace(/\.lock$/, '') + ': ' + describe(path.join(d, f)));
    let log = [];
    try { log = fs.readFileSync(path.join(d, 'slot.log'), 'utf8').split('\n').filter(Boolean); } catch { /* none yet */ }
    if (log.length) {
      console.log(`\nwhat has happened here (last ${Math.min(10, log.length)} of ${log.length}):`);
      for (const l of log.slice(-10)) { let e; try { e = JSON.parse(l); } catch { continue; }
        console.log('  ' + String(e.at).slice(0, 19).replace('T', ' ') + '  ' + e.slot + '  ' + e.what); }
    }
    return;
  }

  if (what === 'free') {
    const lock = lockOf(name);
    if (!fs.existsSync(lock)) return console.log(name + ' is already free.');
    const h = holderOf(lock);
    if (!argv.includes('--force') && !slotStale(lock, staleMs))
      die(`${name} is ${describe(lock)} — its run may be inside it right now.\n` +
          '  Freeing under a live run causes the exact crash the slot exists to stop.\n' +
          `  If you are certain the holder is gone: slot free ${name} --force`);
    if (!slotDrop(lock, h && h.token)) return console.log(`${name} changed hands while we looked — left alone.`);
    slotLog(name, 'freed by hand');
    ok(name + ' is free');
    return;
  }

  if (what === 'run') {
    if (dashdash === -1) die('slot run <name> -- <command>   (the -- is required)');
    const cmd = argv.slice(dashdash + 1);
    if (!cmd.length) die('slot run needs a command after --');
    const label = cmd.join(' ').slice(0, 60);
    let claim = null, waited = 0;
    // Poll rather than block: a slot is held for minutes, and a ten-second miss
    // costs nothing against a suite that runs for five.
    for (;;) {
      claim = slotTake(name, label);
      if (claim) break;
      const lock = lockOf(name);
      if (slotStale(lock, staleMs)) {
        const h = holderOf(lock);
        if (slotDrop(lock, h && h.token)) { slotLog(name, `evicted a stale claim (${describe(lock)})`); continue; }
      }
      if (waited === 0) console.error(`waiting for the ${name} slot — ${describe(lockOf(name))}`);
      waited += 10;
      // A synchronous wait that spawns nothing: the alternative is a `sleep`
      // process every ten seconds for as long as the queue is deep.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
      if (waited > 3 * 3600) die(`gave up waiting for the ${name} slot after 3h`);
    }
    slotLog(name, `took it for: ${label}`);
    // The claim must come back however the command ends, including a signal.
    const release = () => { if (claim) { slotDrop(claim.lock, claim.token); claim = null; } };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { release(); process.exit(1); });
    process.on('exit', release);
    // The command's own exit code is the result. A non-zero one is news about
    // the check, not a fault in the slot, so it is passed through rather than
    // thrown — the claim is released either way by the exit handler.
    let code = 0;
    try { execFileSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: false, env: process.env }); }
    catch (e) { code = typeof e.status === 'number' ? e.status : 1; }
    slotLog(name, `released after: ${label} (exit ${code})`);
    release();
    process.exit(code);
  }
  die('slot run <name> -- <cmd> | slot status | slot free <name> [--force]');
};

// ------------------------------------------------------------------- the doctor
// Everything a step cites that can be checked without running anything. The one
// that earns its place is duplicate ownership: on a real run 52 of 203 owned
// paths turned out to be claimed twice, one of them seven times, and nothing
// anywhere said so. `check` only ever compares what is open right now.
function firstBinary(cmd) {
  // `CI=1 pnpm test` tests pnpm, not CI=1.
  const words = String(cmd).trim().split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  return words[i] || '';
}
function resolves(bin) {
  if (!bin) return false;
  if (bin.includes('/')) return fs.existsSync(path.resolve(CWD, bin));
  // A shell builtin is not on PATH and is not a missing binary either.
  if (['cd', 'echo', 'true', 'false', 'test', 'export', 'set', 'source', '.', ':'].includes(bin)) return true;
  try { shq('sh', ['-c', `command -v ${JSON.stringify(bin)}`]); return true; } catch { return false; }
}

CMDS.doctor = () => {
  const s = readState();
  const bad = [], warn = [];

  for (const p of s.plans || []) {
    if (!fs.existsSync(path.resolve(CWD, p.path))) { bad.push(`the plan ${p.path} is gone — \`load\` again, or the steps built on it cite nothing`); continue; }
    const now = sha(fs.readFileSync(path.resolve(CWD, p.path), 'utf8'));
    // Refining rewrites its plan, so drift is expected there and only worth
    // saying for a plan nobody has refined.
    if (now !== p.sha && !p.refined) warn.push(`${p.path} changed since it was loaded, and has not been refined`);
  }

  const live = tasks(s).filter((t) => t.status !== 'cancelled');
  const keys = new Set(live.map((t) => t.key));

  // Every owned path, and who claims it. Landed work counts: a path two steps
  // both wrote is how one of them quietly undid the other.
  const claims = new Map();
  for (const t of live) for (const o of t.owns || []) {
    const k = norm(o);
    (claims.get(k) || claims.set(k, []).get(k)).push(t.key);
  }
  const dup = [...claims.entries()].filter(([, who]) => who.length > 1);
  if (dup.length) {
    bad.push(`${dup.length} path(s) claimed by more than one step:`);
    for (const [p2, who] of dup.slice(0, 20)) bad.push(`    ${p2}  ←  ${who.join(', ')}`);
    if (dup.length > 20) bad.push(`    … ${dup.length - 20} more`);
  }

  for (const t of live) {
    for (const n of t.needs || []) if (!keys.has(n)) bad.push(`${t.key} needs ${n}, which is not a step`);
    if (!(t.owns || []).length) warn.push(`${t.key} owns nothing — guard cannot judge it`);
    if (!DEAD_STATUS.includes(t.status) && !t.tier) warn.push(`${t.key} has no model yet`);
    for (const o of t.owns || []) {
      // A file it is about to create will not exist; the directory it goes in
      // has to, or the agent cannot write it.
      const abs = path.resolve(CWD, o);
      if (!fs.existsSync(abs) && !fs.existsSync(path.dirname(abs)))
        warn.push(`${t.key} owns ${o}, and neither it nor its directory exists`);
    }
    for (const v of t.verify || []) {
      const bin = firstBinary(v);
      if (bin && !/[|&;<>(){}$`]/.test(bin) && !resolves(bin))
        bad.push(`${t.key} verifies with \`${bin}\`, which does not resolve here`);
    }
    // A record corrected after the brief was written does not correct the brief,
    // and the agent holding it will never know.
    if (t.briefFile && fs.existsSync(path.resolve(CWD, t.briefFile))) {
      const at = fs.statSync(path.resolve(CWD, t.briefFile)).mtimeMs;
      if (t.openedAt && Date.parse(t.openedAt) > at + 1000)
        warn.push(`${t.key}'s brief is older than its record — rewrite it and tell the agent to re-read`);
    }
  }

  // A step that cannot be placed is either in a dependency loop or waiting on a
  // key that does not exist. The second is already named above, so say which.
  const stuck = waves(s).find((w) => w.wave === -1);
  if (stuck) {
    const missing = stuck.tasks.filter((t) => (t.needs || []).some((n) => !keys.has(n)));
    const looped = stuck.tasks.filter((t) => !missing.includes(t));
    if (looped.length) bad.push('these steps depend on each other in a loop: ' + looped.map((t) => t.key).join(' '));
    if (missing.length && !looped.length)
      bad.push('and so ' + missing.map((t) => t.key).join(' ') + ' can never be placed until that is fixed');
  }

  for (const w of warn) console.log('· ' + w);
  for (const b of bad) console.log((b.startsWith('    ') ? '' : '✗ ') + b);
  if (!bad.length && !warn.length) ok('nothing to say — every path, command and plan a step cites checks out');
  else if (!bad.length) ok(`${warn.length} thing(s) worth a look, nothing broken`);
  else {
    // The indented lines are detail on the problem above them, not problems.
    const n = bad.filter((b) => !b.startsWith('    ')).length;
    console.log(`\n${n} problem(s). Fix them before opening anything.`);
    process.exit(1);
  }
};

// ------------------------------------------------------------------- the doctor
// Everything a step cites that can be checked without running anything. It is
// the sweep before work goes out, and its value is entirely in being run then.
CMDS.doctor = () => {
  const s = readState();
  const live = tasks(s).filter((t) => !DEAD_STATUS.includes(t.status));
  let bad = 0;
  const binCache = {};
  const binOk = (b) => {
    if (!(b in binCache)) {
      try { execFileSync('bash', ['-c', 'command -v -- ' + JSON.stringify(b)], { stdio: 'ignore' }); binCache[b] = true; }
      catch { binCache[b] = false; }
    }
    return binCache[b];
  };

  for (const t of live) {
    const probs = [];
    if (t.plan && !fs.existsSync(path.resolve(CWD, t.plan))) probs.push('its plan does not exist: ' + t.plan);
    for (const n of t.needs || []) if (!depOf(s, n)) probs.push(`needs "${n}", which is not a step`);
    if (!t.tier) probs.push('has no model — run `assess`');
    // A backstop for prose that reached owns before the gate existed. An entry
    // that is not a path can never be matched by a diff, so `guard` cannot judge
    // the step at all and says nothing while letting anything through.
    for (const o of t.owns || []) {
      if (/\s[—–]\s|\s--\s/.test(o) || /:\d+$/.test(o) || (!/[/.]/.test(o) && o.split(/\s+/).length > 1))
        probs.push(`owns "${o}", which guard can never match against a diff`);
      else {
        const dir = path.dirname(path.resolve(CWD, o));
        if (!fs.existsSync(dir)) probs.push(`owns "${o}", whose directory does not exist`);
      }
    }
    for (const v of t.verify || []) {
      const first = String(v).trim().split(/\s+/)[0];
      if (first && /^[A-Za-z0-9_.\/-]+$/.test(first) && !binOk(first))
        probs.push(`its proof starts with "${first}", which does not resolve to anything runnable`);
    }
    // A brief already handed out does not change when the record does, and the
    // agent holding it will not know.
    if (t.briefSha) {
      const now = sha(JSON.stringify([t.owns, t.serialises, t.verify, t.needs, t.title, t.plan]));
      if (now !== t.briefSha) probs.push('its brief is older than the step — rewrite it and tell the agent to re-read');
    }
    if (probs.length) { bad += probs.length; console.log('✗ ' + t.key); for (const p of probs) console.log('    ' + p); }
  }

  // Two steps claiming one path. Between open ones this is the breach; between
  // planned ones it only means they cannot open together, which `check` says.
  const dupOpen = [], dupPlanned = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const f = overlap(live[i], live[j]);
    if (!f.length) continue;
    const both = OPEN_STATUSES.includes(live[i].status) && OPEN_STATUSES.includes(live[j].status);
    (both ? dupOpen : dupPlanned).push(`${live[i].key} ↔ ${live[j].key}: ${f.join('; ')}`);
  }
  if (dupOpen.length) {
    bad += dupOpen.length;
    console.log(`✗ ${dupOpen.length} pair(s) of OPEN steps claim the same path:`);
    for (const x of dupOpen) console.log('    ' + x);
    console.log('    Two of them changing one thing is the one failure this cannot survive.');
  }
  if (dupPlanned.length) console.log(`· ${dupPlanned.length} pair(s) of planned steps share a path — they simply cannot open together.`);

  // A serialisation point only one step names is usually a spelling that missed
  // its partner, which is the failure mode this whole comparison exists for.
  const pts = new Map();
  for (const t of live) for (const x of t.serialises || []) {
    const k = normPoint(x);
    (pts.get(k) || pts.set(k, []).get(k)).push({ key: t.key, spelling: x, status: t.status });
  }
  const lone = [...pts.values()].filter((v) => v.length === 1);
  if (lone.length) {
    console.log(`· ${lone.length} serialisation point(s) only one step names:`);
    for (const v of lone) console.log(`    ${v[0].key}: "${v[0].spelling}"`);
    console.log('    If another step moves the same thing and spelled it differently, nothing will catch it.');
  }
  const contended = [...pts.values()].filter((v) => v.filter((x) => OPEN_STATUSES.includes(x.status)).length > 1);
  if (contended.length) {
    bad += contended.length;
    console.log(`✗ ${contended.length} serialisation point(s) held by more than one open step:`);
    for (const v of contended) console.log(`    ${v.map((x) => x.key).join(' ↔ ')}: "${v[0].spelling}"`);
  }

  // A tick over nothing checked is how a green report starts meaning nothing.
  if (!live.length) {
    console.log('· nothing to check — every step is landed, cancelled, or not yet recorded.');
    console.log('  Run this again when work is about to go out; it proves nothing right now.');
    return;
  }
  if (bad) { console.log(`\n✗ ${bad} problem(s) across ${live.length} step(s)`); process.exit(1); }
  ok(`${live.length} step(s) check out — paths, proofs, briefs and ownership`);
};

const HELP = `orchestrate — five stages, on Cursor or Claude Code

  load <path>...            read the plan files, record them
  assess [propose|set|check]  how hard each step is, and which model it gets
  refine brief <plan>       the prompt for a refining agent
  refine done <plan>        read its report; records the steps it found
  check                     which steps can open together, and what blocks the rest
  run open <key>            worktree, chat, brief — everything a step needs to start
  run record <key> --log L  harvest a finished run into the record
  guard <key>               did it touch anything it does not own
  land <key> [--sha S]      record the merge
  board                     every step and its state
  doctor                    everything a step cites that can be checked
  models [list|sync]        the ladder, and regenerating it from the CLI
  doctor                    everything the steps cite that can be checked without running
  slot run <n> -- <cmd>     one shared machine slot, so parallel heavy checks queue

State lives in .claude/orch/. events.jsonl is the record; state.json is a
projection of it.`;

const [cmd, ...argv] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); process.exit(0); }
if (!CMDS[cmd]) { console.error(HELP); die(`\nunknown command: ${cmd}`); }
CMDS[cmd](argv);
