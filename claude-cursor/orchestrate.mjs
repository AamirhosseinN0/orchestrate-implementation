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
// The shorter of the two spellings. A skill installed far from the project
// relativises to a ../../../.. chain nobody can read or check.
const shortest = (abs) => {
  const rel = path.relative(CWD, abs);
  return rel && !rel.startsWith('../..') && rel.length < abs.length ? rel : abs;
};
const SELF = () => shortest(process.argv[1]);
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
// Two things used to be one. They are not the same, and treating them alike
// serialised work that never needed it.
//
// A shared FILE is a merge to sequence, not a collision to prevent: each step
// builds in its own worktree, on its own copy, so two agents writing one file
// never meet. Whatever they both changed is reconciled once, at the merge, by
// the agent whose branch goes second — which is cheaper than the wall-clock of
// making one of them wait for the other to finish and land.
//
// A shared SERIALISATION POINT is different in kind, and is still a gate. A
// lockfile, a migration head, a closed list a test asserts on: git merges these
// cleanly and produces something wrong. There is no conflict to see and no
// diff to read, and the fix is not a code change — a lockfile is regenerated,
// not merged. Sequencing those is the only thing that works.
function blocks(t, other) {
  const points = sharedPoints(t, other);
  return points.length ? { points } : null;
}
// What two steps will have to reconcile at the merge. Always reported, never a
// gate: the point of saying it early is that the order is chosen rather than
// discovered.
function willMerge(t, other) {
  const files = overlap(t, other);
  return files.length ? { files } : null;
}
// A step is open — its files are in somebody's hands — from the moment it is
// handed out until it lands. This used to be keyed off the chip id, which is
// bookkeeping the documented invocation never passed; the effect was that every
// gate reading it went dark. Status is what actually says whether work is out.
const OPEN_STATUSES = ['open', 'reported'];
const DEAD_STATUS = ['landed', 'cancelled'];
const openTasks = (s, except) => tasks(s).filter((x) => x.key !== except && OPEN_STATUSES.includes(x.status));

// A dependency is satisfied for the purpose of OPENING once its work is on the
// main line, and that happens at `join`, not at `land`.
//
// `join` runs `git merge --no-ff` in the main checkout and rolls back only on
// conflict, so on success the dependency's commits are on the main checkout's
// HEAD. `run open` cuts the dependent's worktree with `git worktree add` and no
// commit-ish, which branches from that same HEAD. A worktree cut just after
// join and one cut after land therefore hold byte-identical code. What `land`
// adds is proof — a green suite on the joined tree — and the dependent does not
// consume the proof, it consumes the code.
//
// Waiting for the proof anyway put the whole slot queue on every hop of the
// chain: twelve branches finishing together behind a ten-minute suite is two
// hours before the last one lands, and on a seven-deep graph that queue was
// most of the wall-clock.
//
// The cost is real and it is named where it bites. If the joined-tree suite
// goes red, dependents have already been cut from that HEAD, so the fix lands
// as a forward commit — a `git reset --hard` would strand them. `sendback`
// says so when there is anything to strand.
//
// Set CURSOR_ORCH_OPEN_AT=land to go back to waiting for the proof.
const OPEN_AT_JOIN = (process.env.CURSOR_ORCH_OPEN_AT || 'join') !== 'land';
const onMainLine = (d) => d.status === 'landed' || (OPEN_AT_JOIN && !!d.joinedAt);
const heldNeeds = (s, t) => (t.needs || []).filter((n) => { const d = depOf(s, n); return !d || !onMainLine(d); });
// Landing is the bookkeeping that records proof, so it stays strict: a step is
// not recorded as proven while something it was built on is only merged. Open
// early, land in order.
const unlandedNeeds = (s, t) => (t.needs || []).filter((n) => { const d = depOf(s, n); return !d || d.status !== 'landed'; });
// Dependencies that are on the main line but not yet proven. A step opened on
// these is the trade this makes, so every command that opens one says it.
const unprovenNeeds = (s, t) => (t.needs || []).filter((n) => { const d = depOf(s, n); return d && d.status !== 'landed' && !!d.joinedAt; });
// Steps whose worktree was cut from a HEAD that already carried this step's
// merge. If this step's work has to be undone, these are what a reset would
// strand, and the fix has to go forward instead.
const cutFrom = (s, t) => {
  if (!t.joinedAt) return [];
  const after = Date.parse(t.joinedAt);
  return tasks(s).filter((x) => x.key !== t.key && OPEN_STATUSES.includes(x.status) &&
    x.openedAt && Date.parse(x.openedAt) >= after);
};

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
  const accepted = [], blocked = [], merges = [];
  for (const t of cands) {
    const clash = [...open, ...accepted].map((o) => ({ o, i: blocks(t, o) })).filter((x) => x.i);
    if (clash.length) { blocked.push({ t, why: clash }); continue; }
    for (const o of [...open, ...accepted]) {
      const m = willMerge(t, o);
      if (m) merges.push({ a: t.key, b: o.key, files: m.files });
    }
    accepted.push(t);
  }
  const waiting = tasks(s).filter((t) => t.status === 'planned' && heldNeeds(s, t).length > 0);
  return { open, accepted, blocked, waiting, merges, unblocks };
}

// ------------------------------------------------------------ step validation
// One malformed step poisons every command that reads it later, so the same
// gate runs whoever writes it. `refine done` used to skip this and merge an
// agent's steps in raw, which put a hole in the one invariant that matters on
// the path that creates almost every step.
const LIST_FIELDS = ['needs', 'owns', 'serialises', 'verify', 'context'];
// The number a plan is known by. Steps are keyed from it, which is the whole of
// what keeps two plans' keys apart, so a plan whose name this cannot read is a
// round of colliding keys:
//
//   2.1-flashcards.md      → 2.1      numbered like a section
//   S-013-capabilities.md  → 013      named for the step it becomes
//   S-018a-retry.md        → 018a     and its follow-on
//
// The second shape used to fall through to the first alphanumeric token, which
// is the bare letter "S" — so twelve differently-named plans all told their
// agents to key from `S-S`, which is one prefix, which is the collision this id
// exists to prevent. It was caught by hand, once, in briefs already written.
const planId = (p) => {
  const base = path.basename(String(p)).replace(/\.(md|markdown|txt)$/i, '');
  const m = /^(?:[A-Za-z]+[-_])?(\d+(?:\.\d+)*[a-z]?)(?![\w.])/.exec(base);
  return m ? m[1] : (base.split(/[^A-Za-z0-9]+/)[0] || base);
};
const keyPrefix = (p) => 'S-' + planId(p);
// One plan, however it was named: a path either way round the slashes, or the
// id it is known by. A record written on Windows holds backslashes and every
// caller types the other one.
const slashes = (x) => String(x).split(path.win32.sep).join('/');
// The same plan under either spelling. A step records the path it was handed;
// the plan record holds the one `load` walked to, and on Windows those differ
// by nothing but the slash.
const samePlan = (a, b) => !!a && !!b && norm(slashes(a)) === norm(slashes(b));
const findPlan = (s, name) => {
  const want = norm(slashes(name));
  return (s.plans || []).find((p) => {
    const have = norm(slashes(p.path));
    return have === want || have.endsWith('/' + want) ||
      planId(p.path) === String(name) || keyPrefix(p.path) === String(name);
  });
};
function stepProblems(s, it, existing) {
  const p = [];
  if (!it || typeof it !== 'object' || Array.isArray(it)) return ['is not an object'];
  if (!it.key || typeof it.key !== 'string') p.push('needs a string key');
  if (!existing && !it.title) p.push('needs a title');
  // A key is the address of one step. Two plans that both called something
  // "S-1" used to merge into one record without a word: the second plan's
  // title, owns and plan path overwrote the first's, and the count printed
  // afterwards came from the report rather than from the register, so nothing
  // said eight steps had gone. Three plans of five steps became five steps.
  if (existing && existing.plan && it.plan && !samePlan(existing.plan, it.plan))
    p.push(`key "${it.key}" already belongs to ${existing.plan} — keys are unique across every plan in the round, so key this one ${keyPrefix(it.plan)}.1, ${keyPrefix(it.plan)}.2 …`);
  for (const f of LIST_FIELDS) if (it[f] !== undefined && !Array.isArray(it[f])) p.push(`${f} must be a list`);
  for (const o of it.owns || []) {
    if (typeof o !== 'string' || !o.trim()) { p.push('owns has an empty entry'); continue; }
    if (/\s[—–]\s|\s--\s/.test(o)) p.push(`owns entry "${o}" is prose, not a path`);
    else if (/:\d+/.test(o)) p.push(`owns entry "${o}" carries a :line suffix — ownership is whole files`);
    else if (!/[/.]/.test(o) && o.split(/\s+/).length > 1) p.push(`owns entry "${o}" reads as a sentence, not a path`);
  }
  return p;
}
// `needs` names steps, not plans. An agent that has just read a plan with a
// `requires:` header reaches for the plan's id, which is not a key and never
// becomes one. Twenty-four such entries survived a whole round because the only
// check for them ran in `doctor`, immediately before opening — long after the
// report that caused them had been thrown away.
function needsProblems(s, it, alsoKnown = new Set()) {
  const p = [];
  for (const n of it.needs || []) {
    if (typeof n !== 'string' || !n.trim()) { p.push('needs has an empty entry'); continue; }
    if (alsoKnown.has(n) || depOf(s, n)) continue;
    const plan = (s.plans || []).find((x) => x.path === n || x.path.endsWith('/' + n) || planId(x.path) === n);
    p.push(plan
      ? `needs "${n}", which is a plan, not a step — name the keys of its steps instead`
      : `needs "${n}", which is not a step in this round`);
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
    const b = blocks(mine, other), m = willMerge(mine, other);
    if (b) out.push({ key: other.key, status: other.status, gate: true, what: 'serialisation point ' + b.points.join('; ') });
    if (m) out.push({ key: other.key, status: other.status, gate: false, what: m.files.join('; ') });
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
  const gates = [], merges = [], seen = new Set();
  for (const k of keys) {
    const t = depOf(s, k); if (!t) continue;
    for (const o of overlapsOf(s, t)) {
      // A pair is one fact however many directions it is looked at from.
      const id = [k, o.key].sort().join('|') + '|' + o.gate;
      if (seen.has(id)) continue;
      seen.add(id);
      const line = `  ${k} ↔ ${o.key}${OPEN_STATUSES.includes(o.status) ? ' (open right now)' : ''}: ${o.what}`;
      (o.gate ? gates : merges).push(line);
    }
  }
  if (gates.length) {
    console.log(`\n${gates.length} shared serialisation point(s) — these cannot be open at the same time:`);
    for (const l of gates) console.log(l);
  }
  if (merges.length) {
    console.log(`\n${merges.length} shared file(s) — these can run together; whichever lands second reconciles:`);
    for (const l of merges) console.log(l);
    console.log('  If that is not what you meant, one of them owns too much.');
  }
}

// ------------------------------------------------------------------ the model
// The ladder is data; this only reads it. Judgement about which rung a step
// deserves is the orchestrator's, recorded by `assess propose` and overridable
// by the user — never computed here.
function ladder() {
  return JSON.parse(fs.readFileSync(path.join(HERE, 'models.json'), 'utf8'));
}
// What a row's model calls itself. `accepts` is a list because the runtime is
// not consistent about effort suffixes; the first entry is the canonical one.
const modelName = (row) => (row.accepts && row.accepts[0]) || row.shown || row.id;
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
// What a plan says it comes after, out of its own front matter. A whole round
// went out with no cross-plan ordering at all because this header was read by
// nobody: not by `load`, and so never by the agent refining the plan.
//
//   ---
//   requires: [1.6, 2.3]      or   requires: 1.6, 2.3
//   ---                            or a "- 1.6" block under it
function requiresOf(body) {
  // Front matter is written two ways and both are common: fenced between --- at
  // the very top, or in a ```yaml block under the title. Reading only the first
  // spelling loaded twelve plans with no dependencies at all, and an empty graph
  // is not a safe default — it lets `check` open an integration step beside the
  // five steps it integrates.
  const head = body.split('\n').slice(0, 60).join('\n');
  const blocks = [];
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (front) blocks.push(front[1]);
  for (const m of head.matchAll(/^[ \t]*```[ \t]*(?:ya?ml)?[ \t]*\r?\n([\s\S]*?)^[ \t]*```/gm)) blocks.push(m[1]);
  for (const block of blocks) {
    const found = requiresIn(block);
    if (found.length) return found;
  }
  return [];
}
// One `requires:` key, however its list is written: inline, bracketed, or a
// block of "- " items under it.
function requiresIn(block) {
  const m = /^[ \t]*requires:[ \t]*(.*)$/m.exec(block);
  if (!m) return [];
  const clean = (x) => String(x).replace(/^["']|["']$/g, '').replace(/[,]$/, '').trim();
  // The comment goes before the brackets do, or `[a, b] # why` keeps the ]
  // and the last id is recorded as "b]" — a dependency on nothing.
  const inline = m[1].replace(/#.*$/, '').trim().replace(/^\[|\]$/g, '').trim();
  if (inline) return inline.split(/[,\s]+/).map(clean).filter(Boolean);
  const out = [];
  for (const line of block.slice(m.index + m[0].length).split('\n')) {
    if (!line.trim()) continue;
    const item = /^[ \t]*-[ \t]*(.+?)[ \t]*$/.exec(line);
    if (!item) break;
    out.push(clean(item[1]));
  }
  return out;
}

// The words a serialisation point is spelled with. Data, like the ladder, and
// for the same reason: six spellings of one migration head across eleven steps
// is a merge git performs cleanly and gets wrong, and the only defence is that
// two steps moving one thing say the same words about it.
function vocabulary() {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).points || []; } catch { return []; } };
  const shipped = read(path.join(HERE, 'points.json'));
  const local = process.env.CURSOR_ORCH_POINTS ? read(process.env.CURSOR_ORCH_POINTS) : [];
  return [...new Set([...shipped, ...local])];
}

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
    return { path: path.relative(CWD, f), lines: body.split('\n').length, bytes: Buffer.byteLength(body),
             sha: sha(body), requires: requiresOf(body) };
  });
  commit(s, 'load', argv);
  const total = s.plans.reduce((a, p) => a + p.bytes, 0);
  console.log(`${s.plans.length} plan(s), ~${Math.round(total / 5.5 / 1000)}k words:`);
  for (const p of s.plans) console.log(`  ${String(p.lines).padStart(5)} lines  ${p.path}`);
  console.log('\nRead every one of them in full before anything else.');
};

// ------------------------------------------------------------------- the map
// Which plans touch which files, read out of the plans themselves.
//
// The width of a round is decided before any agent runs: a plan may become at
// most two steps, so ten plans cannot become more than twenty, and the
// cross-product in `step link` makes every step of a plan wait for every step
// of what it comes after. Both of those are cheap to live with when a plan is
// one coherent slice of files, and expensive when four disjoint file sets share
// one document.
//
// This says which it is, while the plans can still be rearranged. After
// refining the same information exists in `owns` and is accurate rather than
// guessed — so both are shown when there are steps.
const FILE_EXT = 'ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sql|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|css|scss|less|html|toml|ini|sh|bash|lock|prisma|graphql|proto|tf|cfg|conf';
// Deliberately narrow. A token counts as a path when it ends in an extension
// this recognises, or when it is plainly a directory — which keeps "and/or",
// "A/B" and a bare version number out. What it misses is a directory written
// without its trailing slash, so the map says it is a reading of the prose and
// not a gate. Nothing is held back on the strength of it.
const looksLikePath = (x) => {
  if (!x || /^https?:/i.test(x) || x.includes('://')) return false;
  if (new RegExp(`\\.(?:${FILE_EXT})$`, 'i').test(x)) return true;
  return x.endsWith('/') && x.includes('/');
};
function pathsIn(body) {
  const out = new Set();
  const re = new RegExp(String.raw`[\w.@~-]*(?:/[\w.@~-]+)+/?|[\w.@-]+\.(?:${FILE_EXT})\b`, 'gi');
  for (const m of String(body).matchAll(re)) {
    const x = m[0].replace(/[.,;:)\]}]+$/, '');
    if (looksLikePath(x)) out.add(norm(x));
  }
  return out;
}

CMDS.map = () => {
  const s = readState();
  const plans = s.plans || [];
  if (!plans.length) die('no plans loaded — run `load <path>` first');
  const live = tasks(s).filter((t) => !DEAD_STATUS.includes(t.status));

  // file → the plans that name it
  const vocab = vocabulary();
  const byFile = new Map();
  const perPlan = new Map();
  const pointsPerPlan = new Map();
  // One read per plan: both the paths and the shared ground come out of the
  // same body.
  for (const p of plans) {
    let body = '';
    try { body = fs.readFileSync(path.resolve(CWD, p.path), 'utf8'); } catch { continue; }
    const found = pathsIn(body);
    perPlan.set(p.path, found);
    for (const f of found) (byFile.get(f) || byFile.set(f, []).get(f)).push(p.path);
    const lower = body.toLowerCase();
    pointsPerPlan.set(p.path, vocab.filter((v) => lower.includes(v.toLowerCase())));
  }

  console.log(`${plans.length} plan(s), ${byFile.size} distinct path(s) named between them.`);
  console.log('This is a reading of the plans\' prose, not a gate — nothing is held back on it.\n');

  // The seams: what many plans reach for. Each one is a fan-in, and a fan-in is
  // the deepest part of any graph. Lifting it into its own plan that lands
  // first turns the fan-in into one early landing and lets the rest run wide.
  const seams = [...byFile.entries()].filter(([, ps]) => ps.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  const shared = [...byFile.entries()].filter(([, ps]) => ps.length === 2);
  if (seams.length) {
    console.log(`Seams — named by three or more plans (${seams.length}):`);
    for (const [f, ps] of seams) console.log(`  ${String(ps.length).padStart(2)}×  ${f.padEnd(44)} ${ps.map((x) => planId(x)).join(' ')}`);
    console.log('  Lift each into its own plan that lands first. Everything else then fans');
    console.log('  off a contract instead of queueing behind whoever got there first.\n');
  } else {
    console.log('No path is named by three or more plans — no obvious seam to lift.\n');
  }
  if (shared.length) {
    console.log(`Shared by exactly two plans (${shared.length}) — a merge to sequence, not a gate:`);
    for (const [f, ps] of shared.slice(0, 15)) console.log(`      ${f.padEnd(44)} ${ps.map((x) => planId(x)).join(' ')}`);
    if (shared.length > 15) console.log(`      … and ${shared.length - 15} more`);
    console.log('');
  }

  // Which plans could already run beside each other, on files alone. This is
  // the number that decides how wide the round can get.
  const ids = plans.map((p) => p.path);
  const clash = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = perPlan.get(ids[i]) || new Set(), b = perPlan.get(ids[j]) || new Set();
    const both = [...a].filter((x) => [...b].some((y) => collides(x, y)));
    if (both.length) clash.push({ a: ids[i], b: ids[j], files: both });
  }
  const disjoint = ids.filter((x) => !clash.some((c) => c.a === x || c.b === x));
  console.log(`Plans whose file sets touch nothing else (${disjoint.length} of ${ids.length}): ` +
    (disjoint.map((x) => planId(x)).join(' ') || '(none)'));
  if (clash.length) {
    console.log(`${clash.length} pair(s) of plans name a path in common:`);
    for (const c of clash.slice(0, 12)) console.log(`  ${planId(c.a)} ↔ ${planId(c.b)}  ${c.files.slice(0, 4).join('; ')}${c.files.length > 4 ? ` (+${c.files.length - 4})` : ''}`);
    if (clash.length > 12) console.log(`  … and ${clash.length - 12} more`);
  }

  // The ordering already written down, and what it will cost once linked.
  const withReq = plans.filter((p) => (p.requires || []).length);
  console.log(`\nOrdering declared in front matter: ${withReq.length} of ${plans.length} plan(s) name a requires:.`);
  for (const p of withReq) console.log(`  ${planId(p.path)} comes after ${(p.requires || []).join(', ')}`);
  const noReq = plans.filter((p) => !(p.requires || []).length);
  if (noReq.length && withReq.length) {
    console.log(`  ${noReq.length} plan(s) declare no ordering: ${noReq.map((p) => planId(p.path)).join(' ')}`);
    console.log('  If one of those really does come after another, say so — an empty graph');
    console.log('  lets an integration plan open beside the plans it integrates.');
  }

  // Serialisation points the plans already imply. Two plans naming one of these
  // will be held apart one at a time, so it is worth knowing which, and worth
  // knowing whether they are really the same instance of the thing.
  const contended = vocab.map((v) => ({ v, who: plans.filter((p) => (pointsPerPlan.get(p.path) || []).includes(v)) }))
    .filter((x) => x.who.length >= 2);
  if (contended.length) {
    console.log(`\nShared ground named by more than one plan (${contended.length}) — these go one at a time:`);
    for (const { v, who } of contended) console.log(`  ${v.padEnd(22)} ${who.map((p) => planId(p.path)).join(' ')}`);
    console.log('  If two of these are genuinely separate — a migration directory per package,');
    console.log('  a lockfile per workspace — scope the name: "migration head: orders".');
    console.log('  Only where you can point at two separate files.');
  }

  // Once steps exist, `owns` is the real answer and the prose is only a guess.
  if (live.length) {
    const owned = new Map();
    for (const t of live) for (const o of t.owns || []) (owned.get(norm(o)) || owned.set(norm(o), []).get(norm(o))).push(t.key);
    const fan = [...owned.entries()].filter(([, ks]) => ks.length >= 3).sort((a, b) => b[1].length - a[1].length);
    console.log(`\n${live.length} step(s) recorded, owning ${owned.size} path(s).`);
    if (fan.length) {
      console.log(`  ${fan.length} path(s) owned by three or more steps — the same seam, now measured:`);
      for (const [f, ks] of fan) console.log(`    ${String(ks.length).padStart(2)}×  ${f.padEnd(40)} ${ks.join(' ')}`);
    }
  } else {
    console.log('\nNo steps yet. This is the moment to rearrange the plans — after refining,');
    console.log('changing the shape means `step reset` and refining again.');
  }
};

// Every step in a batch is judged before any of it is written. Half a batch
// recorded and the rest refused leaves a register nobody planned.
function vetBatch(s, list) {
  const bad = [];
  const dry = JSON.parse(JSON.stringify(s));
  const mine = new Set(list.map((it) => it && it.key).filter(Boolean));
  const seen = new Set();
  for (const it of list) {
    const probs = [];
    const k = it && it.key;
    if (k && seen.has(k)) probs.push(`"${k}" appears twice in this batch`);
    if (k) seen.add(k);
    const p = putStep(dry, it);
    if (p) probs.push(...p);
    probs.push(...needsProblems(dry, it || {}, mine));
    if (probs.length) bad.push([k || '(no key)', probs]);
  }
  return bad;
}

CMDS.step = (argv) => {
  const s = readState();
  const usage = 'step add < json | step link [--dry-run] [--only-shared] | step rm <key>… [--force] | step reset <plan> [--force]';

  // Plans are refined all at once, so when an agent writes its report the steps
  // of the plans it comes after usually do not exist yet and it cannot name
  // their keys. The ordering is not lost — it is in each plan's `requires:` —
  // but somebody had to turn it into needs by hand once every report was in.
  // This does that: plan B requires plan A, so every step of B needs every step
  // of A. It is safe to run more than once and says what it changed.
  if (argv[0] === 'link') {
    const dry = argv.includes('--dry-run');
    // The cross-product is the safe default and stays the default: plan B comes
    // after plan A, so every step of B waits for every step of A. It is also
    // the coarsest thing here — with two steps each it records four edges where
    // typically one is real, and the three spurious ones hold work that never
    // conflicted.
    //
    // `--only-shared` records the edge only where the two steps actually meet:
    // one owns a path the other owns, or they name the same serialisation
    // point. That is the ordering the requirements really have.
    //
    // What it cannot see is a dependency with no footprint in the record — B
    // reads at runtime what A writes, and no file or point says so. So a
    // requirement that comes out with no edges at all is not quietly dropped:
    // it is named and it fails the command.
    const onlyShared = argv.includes('--only-shared');
    const live = tasks(s).filter((t) => !DEAD_STATUS.includes(t.status));
    const stepsOf = (rec) => live.filter((t) => samePlan(t.plan, rec.path));
    const added = [], missing = [], unknown = [], skipped = [], vanished = [];
    for (const rec of s.plans || []) {
      const mine = stepsOf(rec);
      if (!mine.length) continue;
      for (const req of rec.requires || []) {
        const dep = findPlan(s, req);
        if (!dep) { unknown.push(`${rec.path} requires "${req}", which is not a loaded plan`); continue; }
        const theirs = stepsOf(dep);
        if (!theirs.length) { missing.push(`${rec.path} requires ${dep.path}, which has no steps recorded yet`); continue; }
        // Edges this requirement ends up standing on, whether this run added
        // them or a previous one did. Zero of them is the case that must fail.
        let kept = 0;
        for (const t of mine) for (const d of theirs) {
          if (t.key === d.key) continue;
          if ((t.needs || []).includes(d.key)) { kept++; continue; }
          if (onlyShared) {
            const files = overlap(t, d), points = sharedPoints(t, d);
            if (!files.length && !points.length) {
              skipped.push(`${t.key} ↮ ${d.key} — nothing shared`);
              continue;
            }
            (t.needs ||= []).push(d.key);
            added.push(`${t.key} needs ${d.key}  (${files.length ? files.join('; ') : 'point ' + points.join('; ')})`);
          } else {
            (t.needs ||= []).push(d.key);
            added.push(`${t.key} needs ${d.key}`);
          }
          kept++;
        }
        // The ordering the plan asked for came out as nothing at all. Under the
        // cross-product this cannot happen; under --only-shared it can, and it
        // is the one outcome that must not pass quietly.
        if (onlyShared && !kept) vanished.push(`${rec.path} requires ${dep.path}, and no step of either shares a file or a point — ` +
          `so that ordering would be recorded nowhere. Name the real dependency in the plan's steps, or link without --only-shared.`);
      }
    }
    for (const u of unknown) console.log('✗ ' + u);
    for (const v of vanished) console.log('✗ ' + v);
    for (const m of missing) console.log('· ' + m + ' — refine it, then run this again');
    if (onlyShared && skipped.length) {
      console.log(`· ${skipped.length} pair(s) left unlinked because they share nothing:`);
      for (const x of skipped.slice(0, 20)) console.log('    ' + x);
      if (skipped.length > 20) console.log(`    … and ${skipped.length - 20} more`);
    }
    // Nothing is recorded when a requirement would vanish. Half a graph is
    // worse than none, because the half that landed is the harder half to see.
    if (vanished.length) die(`${vanished.length} requirement(s) would be recorded nowhere. Nothing was written.`, 1);
    if (!added.length) { ok('nothing to add — every plan already waits on what it says it comes after'); return; }
    for (const a of added) console.log('  ' + a);
    if (dry) { console.log(`\n${added.length} link(s) — not recorded (--dry-run)`); return; }
    // A requires: chain that loops is a mistake in the plans, and recording it
    // would leave a register no wave can be built from.
    const loop = waves(s).find((w) => w.wave === -1);
    if (loop) die(`those requires: headers put ${loop.tasks.map((t) => t.key).join(' ')} in a loop. Nothing was recorded.`);
    commit(s, 'step link', argv);
    ok(`${added.length} dependency(ies) recorded from the plans' requires: headers`);
    if (unknown.length) process.exit(1);
    return;
  }

  if (argv[0] === 'rm' || argv[0] === 'reset') {
    const force = argv.includes('--force');
    const rest = argv.slice(1).filter((a) => a !== '--force');
    if (!rest.length) die(usage);
    let doomed;
    if (argv[0] === 'reset') {
      const rec = findPlan(s, rest[0]);
      if (!rec) die(`"${rest[0]}" is not a loaded plan. Try one of:\n  ` + (s.plans || []).map((p) => p.path).join('\n  '));
      doomed = tasks(s).filter((t) => samePlan(t.plan, rec.path) && t.status !== 'cancelled');
      if (!doomed.length) die(`no live steps belong to ${rec.path}`, 1);
    } else {
      doomed = rest.map((k) => getTask(s, k)).filter((t) => t.status !== 'cancelled');
      if (!doomed.length) die('every one of those is already cancelled', 1);
    }
    // Work that went out, or landed, is not undone by forgetting it here: a
    // worktree and a branch outlive the record. So it takes saying so.
    const live = doomed.filter((t) => t.status !== 'planned');
    if (live.length && !force)
      die(`${live.map((t) => `${t.key} is ${t.status}`).join(', ')}. Cancelling that leaves a worktree and a branch behind.\n  Say --force if that is what you mean.`);
    // Cancelled, never deleted. events.jsonl is the record; a step that once
    // existed and a step that never did are not the same fact.
    for (const t of doomed) { t.status = 'cancelled'; t.cancelledAt = new Date().toISOString(); }
    const gone = new Set(doomed.map((t) => t.key));
    const orphaned = [];
    for (const t of tasks(s)) {
      if (gone.has(t.key) || !(t.needs || []).some((n) => gone.has(n))) continue;
      t.needs = t.needs.filter((n) => !gone.has(n));
      orphaned.push(t.key);
    }
    commit(s, 'step ' + argv[0], argv);
    ok(`${doomed.length} step(s) cancelled: ${doomed.map((t) => t.key).join(' ')}`);
    if (orphaned.length) console.log(`  dropped from the needs of: ${orphaned.join(' ')}`);
    const leftovers = doomed.filter((t) => t.worktree);
    if (leftovers.length) {
      console.log(`\n${leftovers.length} of them had a worktree. Nothing here removes it — do it by hand:`);
      for (const t of leftovers) console.log(`  git worktree remove ${t.worktree}  &&  git branch -D ${t.branch}`);
    }
    return;
  }

  if (argv[0] !== 'add') die(usage);
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) die('step add reads JSON on stdin and got nothing');
  let list; try { list = JSON.parse(raw); } catch (e) { die('that is not valid JSON: ' + e.message); }
  if (!Array.isArray(list)) list = [list];
  const bad = vetBatch(s, list);
  if (bad.length) {
    for (const [k, ps] of bad) { console.error(`✗ ${k}:`); for (const x of ps) console.error('    ' + x); }
    console.error(`\nNothing was recorded — ${bad.length} of ${list.length} step(s) could not be.`);
    process.exit(1);
  }
  for (const it of list) putStep(s, it);
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
  } else if (argv[0] === 'critical') {
    // Difficulty is not the only thing that decides which model a step wants.
    // Position does too, and the two come apart: a step with twenty steps
    // behind it has its latency multiplied by all of them, and a wrong answer
    // on it costs a re-run of everything it unblocks. A leaf step costs only
    // itself.
    //
    // `frontier` already sorts by how many steps a candidate unblocks, so the
    // number exists; nothing was using it to choose a model. This does: it
    // suggests a notch up where the downstream cost is heavy and a notch down
    // on a leaf, which comes out roughly cost-neutral and puts the strongest
    // model where a mistake is most expensive.
    //
    // It only ever suggests. A row the user set is left alone, the same as
    // `propose`, and nothing is written without --apply.
    const apply = argv.includes('--apply');
    const live = tasks(s).filter((t) => !DEAD_STATUS.includes(t.status));
    if (!live.length) { console.log('No steps yet — refine the plans first.'); return; }
    // How many steps sit behind this one, all the way down, not just directly.
    // Direct dependents undercount a chain: the first link of a seven-deep one
    // unblocks a single step and gates all six.
    const downstream = (key, seen = new Set()) => {
      for (const x of live) {
        if (seen.has(x.key) || !(x.needs || []).includes(key)) continue;
        seen.add(x.key); downstream(x.key, seen);
      }
      return seen;
    };
    const rows = live.map((t) => {
      const behind = downstream(t.key).size;
      const at = tiers.indexOf(t.tier);
      let want = at, why = '';
      if (at === -1) { want = -1; }
      else if (behind >= 3) { want = Math.min(tiers.length - 1, at + 1); why = `${behind} steps behind it`; }
      else if (behind === 0 && (t.needs || []).length) { want = Math.max(0, at - 1); why = 'a leaf — nothing waits on it'; }
      return { t, behind, at, want, why };
    });
    const moves = rows.filter((r) => r.want !== -1 && r.want !== r.at && r.t.model_by !== 'user');
    const frozen = rows.filter((r) => r.want !== -1 && r.want !== r.at && r.t.model_by === 'user');
    const w = (a, n) => String(a ?? '').slice(0, n).padEnd(n);
    console.log(w('step', 10) + w('behind', 8) + w('now', 10) + w('suggest', 10) + 'why');
    console.log('-'.repeat(78));
    for (const r of rows.sort((a, b) => b.behind - a.behind)) {
      const to = r.want === -1 ? '—' : tiers[r.want];
      console.log(w(r.t.key, 10) + w(r.behind, 8) + w((r.t.tier || '—') + (r.t.model_by === 'user' ? '*' : ''), 10) +
        w(r.want === r.at ? '' : to, 10) + r.why);
    }
    if (frozen.length) console.log(`\n${frozen.length} row(s) left alone because you set them: ${frozen.map((r) => r.t.key).join(' ')}`);
    if (!moves.length) { console.log('\nNothing to change — every step is already at the tier its position argues for.'); return; }
    if (!apply) {
      console.log(`\n${moves.length} row(s) would move. Nothing written — run \`assess critical --apply\` to take them.`);
      return;
    }
    for (const r of moves) { r.t.tier = tiers[r.want]; r.t.model_by = 'critical'; r.t.why_model = r.why; }
    commit(s, 'assess critical', argv);
    ok(`${moves.length} row(s) moved on position: ${moves.map((r) => r.t.key + '→' + r.t.tier).join(' ')}`);
    return;
  } else if (argv.length) die('assess [propose < json | set KEY=tier ... | critical [--apply] | check]');

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
  if (f.merges.length) {
    console.log(`\n${f.merges.length} pair(s) share files. They still run together — whichever`);
    console.log('lands second reconciles, and `join` says when that is needed:');
    for (const m of f.merges) console.log('  ' + m.a.padEnd(10) + '↔ ' + m.b + '  ' + m.files.join('; '));
  }
  if (f.blocked.length) {
    console.log('\nHeld back — they move a serialisation point that open work is already moving.');
    console.log('git merges these cleanly and gets them wrong, so they go one at a time:');
    for (const { t, why } of f.blocked) for (const { o, i } of why) {
      console.log('  ' + t.key.padEnd(10) + '↔ ' + o.key + '  ' + i.points.join('; '));
    }
  }
  // Not "to land": landing is the proof, and a dependency only has to be on the
  // main line for a dependent to be cut from it. Saying "land" here described
  // the gate as it was before joining was enough.
  if (f.waiting.length) console.log('\nWaiting on work to reach the main line: ' + f.waiting.map((t) => t.key).join('  '));
  process.exit(bad ? 1 : 0);
};

// The ladder lives in models.json and models.mjs owns it; this is only a way to
// see it without knowing where the scripts are.
CMDS.models = (argv) => {
  // Its complaints are already written for a person to read. Letting the
  // failure out as an exception buried a clean ✗ under a Node stack trace.
  try {
    process.stdout.write(execFileSync('node', [path.join(HERE, 'scripts', 'models.mjs'), ...(argv.length ? argv : ['list'])],
      { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }));
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.status === undefined) die(`could not run models.mjs: ${e.message}`);
    process.exit(e.status);
  }
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
// A plan may become at most this many steps. See `refine done`.
const MAX_STEPS_PER_PLAN = 2;
const planSlug = (p) => String(p).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
const refineReport = (p) => sub('refine', planSlug(p) + '.json');

CMDS.refine = (argv) => {
  const [what, plan] = argv;
  const s = readState();
  if (what === 'brief') {
    if (!plan) die('refine brief <plan>');
    const rec = findPlan(s, plan);
    if (!rec) die(`"${plan}" is not a loaded plan. Try \`load\` first, or one of:\n  ` + (s.plans || []).map((p) => p.path).join('\n  '));
    const out = refineReport(rec.path);
    const req = (rec.requires || []);
    const pre = req.length
      ? `\nIt says it comes after: ${req.join(', ')}. Steps of those plans must land\nbefore this plan's work can start — name their keys in \`needs\`. Steps already\nrecorded, to name from:\n${(tasks(s).filter((t) => req.some((r) => t.plan && (t.plan.includes(r) || planId(t.plan) === r)))
          .map((t) => `  ${t.key.padEnd(12)} ${t.plan}  ${String(t.title || '').slice(0, 40)}`).join('\n') || '  (none recorded yet — refine those plans first)')}\n`
      : '';
    console.log(`Refine one implementation plan so it can be built from, without anyone
having to guess.

The plan: ${rec.path}  (${rec.lines} lines)
${pre}
Read it in full, then read the code it talks about. Your job is to make the plan
match the repository as it actually is — not to design anything new, and not to
decide anything the plan deliberately left open.

Do two things:

1. Edit ${rec.path} in place. Replace every instruction that cannot be followed
   literally: a path that does not exist, a function that was renamed, a command
   that would not run, an order that is impossible. Leave the intent alone.

   The repository's own checks may grep your prose, not just its code. A plan
   that spells out a forbidden call verbatim has been read by a lint as the
   forbidden call itself. If you must write one, quote it and say it is
   forbidden in the same line.

2. Write your report to ${path.relative(CWD, out)} as JSON:

   {
     "summary": "what you changed and why, in a few sentences",
     "builtOn": [{"path": "src/x.ts", "what": "what you read there"}],
     "openQuestions": ["anything you could not settle from the code"],
     "steps": [{
       "key": "${keyPrefix(rec.path)}.1",
       "title": "one line",
       "owns": ["every file this step may write, whole paths only"],
       "serialises": ["shared invariants it moves: a lockfile, a migration head"],
       "needs": ["keys of steps that must land first"],
       "verify": ["the command that proves it worked"]
     }]
   }

   One plan is one step unless it genuinely has to be more than one, and never
   more than ${MAX_STEPS_PER_PLAN}. Split it only when a part must land before another can
   start, or when two parts write disjoint files and are worth running at the
   same time. A plan this size is usually a single step - do not carve it up to
   look thorough; a report with more steps than that is refused.

   Key every step from this plan: ${keyPrefix(rec.path)}.1, ${keyPrefix(rec.path)}.2. Other plans in this
   round are being refined at the same time, keys are unique across all of them,
   and a report that reuses one another plan already holds is refused whole.

   \`needs\` names step keys, never plan ids. A key that is not a step in this
   round is refused.

   \`owns\` is the important one. Two steps that own the same file cannot run at
   the same time, so a list that is too narrow causes a collision nobody sees
   until the merge. List what the step will actually write, including tests and
   generated files.

   \`serialises\` is the one that gets spelled six different ways. Use these
   exact words for anything on this list:

${vocabulary().map((v) => '     · ' + v).join('\n')}

   Invent a name only for something genuinely not on it, and then spell it the
   way the plan spells it. Two steps moving one shared thing are only held apart
   when they call it the same name.

Report the file written, not a summary in your reply.`);
    return;
  }
  if (what === 'done') {
    if (!plan) die('refine done <plan>');
    const rec = findPlan(s, plan) || die(`"${plan}" is not a loaded plan`);
    const f = refineReport(rec.path);
    if (!fs.existsSync(f)) die(`no report at ${path.relative(CWD, f)} — the agent did not write one.\n  Its own reply is not a substitute: that route goes through a context that gets compacted.`);
    let rep; try { rep = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { die(`the report at ${f} is not valid JSON: ${e.message}`); }
    const steps = rep.steps || [];
    if (!steps.length) die('the report names no steps');
    // A plan is one step, or two when a part must land before the rest. More
    // than that is an agent carving up work that was already small enough.
    if (steps.length > MAX_STEPS_PER_PLAN) die(`the report splits ${rec.path} into ${steps.length} steps; ${MAX_STEPS_PER_PLAN} is the most a plan may become.
  Have the agent merge them and rewrite ${path.relative(CWD, f)}.`);
    // Every step goes through the same gate as a hand-written one. The old
    // driver merged refined steps in raw, which put a hole in the one invariant
    // that matters on the path that creates almost every step. It is judged
    // entire and written entire: a report half-recorded and half-refused is a
    // register nobody planned, and the half that landed is the harder half to
    // see.
    const stamped = steps.map((it) => ({ ...it, plan: rec.path }));
    const bad = vetBatch(s, stamped);
    if (bad.length) {
      console.error('✗ the report has steps that cannot be recorded as written:');
      for (const [k, ps] of bad) { console.error(`  ${k}:`); for (const x of ps) console.error('    ' + x); }
      console.error(`\nNothing from ${rec.path} was recorded. Have the agent fix ${path.relative(CWD, f)} and run this again.`);
      process.exit(1);
    }
    for (const it of stamped) putStep(s, it);
    rec.refined = new Date().toISOString();
    rec.openQuestions = rep.openQuestions || [];
    commit(s, 'refine done', argv);
    // The count that would have caught three plans overwriting each other is
    // the register's, not the report's. The report's number was always right.
    ok(`${steps.length} step(s) from ${rec.path}: ${steps.map((t) => t.key).join(' ')}  (${tasks(s).filter((t) => t.status !== 'cancelled').length} in the register)`);
    // Refining rewrites its plan, and nothing used to say what it changed.
    try {
      const stat = shq('git', ['diff', '--stat', '--', rec.path]);
      if (stat) console.log('\nWhat it did to the plan:\n' + stat.split('\n').map((l) => '  ' + l.trim()).join('\n'));
    } catch { /* not a repo, or the plan is untracked — the steps still stand */ }
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
    if (held.length) die(`${key} needs ${held.join(', ')} on the main line first`);
    // Opened off a merge that has not been proven. Worth saying every time,
    // because it is what the send-back will have to work around if that merge
    // turns out to be wrong.
    const unproven = unprovenNeeds(s, t);
    // Only a serialisation point stops a step opening. A shared file does not:
    // the two build in separate worktrees and reconcile at the merge.
    for (const o of openTasks(s, key)) {
      const i = blocks(t, o);
      if (i) die(`${key} moves the same serialisation point as ${o.key}, which is open: ${i.points.join('; ')}\n` +
        '  git merges these cleanly and gets them wrong, so they go one at a time.');
    }
    const willReconcile = openTasks(s, key).map((o) => ({ o, m: willMerge(t, o) })).filter((x) => x.m);
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
    ok(`${key} is open on ${modelName(row)}`);
    if (unproven.length) {
      console.log(`  built on ${unproven.join(', ')} — merged, not yet proven. Its worktree is`);
      console.log(`  cut from that merge, so if the suite goes red there the fix lands as a`);
      console.log(`  forward commit; a reset would strand this worktree.`);
    }
    if (willReconcile.length) {
      console.log(`  shares files with open work — whichever lands second reconciles:`);
      for (const { o, m } of willReconcile) console.log(`    ↔ ${o.key}: ${m.files.join('; ')}`);
    }
    console.log(`  worktree  ${t.worktree}\n  branch    ${t.branch}\n  chat      ${t.chat}\n  brief     ${t.briefFile}`);
    const runner = shortest(path.join(HERE, 'scripts', 'run.sh'));
    console.log(`\nLaunch it in the background:\n  bash ${runner} \\\n    --role chip --tier ${t.tier} --key ${key} --workspace ${t.worktree} \\\n    --chat ${t.chat} --prompt-file ${t.briefFile}`);
    // Opening one at a time is the slowest thing this can do, and it is easy to
    // do by accident — one `run open` reads like progress. So the ones still
    // waiting are counted here rather than left for somebody to run `check`.
    const more = frontier(readState()).accepted;
    if (more.length) {
      console.log(`\n⚠ ${more.length} more step(s) can open right now and are not: ${more.map((x) => x.key).join(' ')}`);
      console.log('  Open them in this same round. A shared serialisation point is the only');
      console.log('  reason to hold one back, and none of these shares one with open work.');
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
  const i = argv.indexOf('--sha');
  const shaArg = i === -1 ? null : argv[i + 1];
  // Not `n !== i + 1`: with no --sha at all, indexOf gives -1 and i + 1 is 0,
  // which silently ate the first key.
  const keys = argv.filter((a, n) => !a.startsWith('--') && !(i !== -1 && n === i + 1));
  if (!keys.length) die('land <key> [--sha <sha>] | land --batch <key>… --sha <sha>');
  // One suite covered the whole batch, so one command records what it proved.
  // Landing them one at a time would be the same bookkeeping typed six times,
  // and the strict gate below still holds for each.
  const batch = argv.includes('--batch');
  if (!batch && keys.length > 1) die(`land takes one step unless you say --batch. Got: ${keys.join(' ')}`);
  const ts = keys.map((k) => getTask(s, k));
  // Strict on purpose: opening is allowed off a merge, but recording proof is
  // not. A step landed while something it was built on is merely merged would
  // claim a green suite covers work that has not been through one.
  //
  // Within a batch, the others are landing in the same breath, so a dependency
  // that is also in this batch counts as satisfied.
  const inBatch = new Set(keys);
  for (const t of ts) {
    const held = unlandedNeeds(s, t).filter((n) => !inBatch.has(n));
    if (held.length) die(`${t.key} cannot land before ${held.join(', ')}`);
  }
  for (const t of ts) {
    t.status = 'landed'; t.landedAt = new Date().toISOString();
    if (shaArg) t.landedSha = shaArg;
  }
  commit(s, 'land', argv);
  ok(ts.length === 1 ? `${ts[0].key} landed` : `${ts.length} step(s) landed: ${keys.join(' ')}`);
  const freed = tasks(s).filter((x) => x.status === 'planned' &&
    (x.needs || []).some((n) => inBatch.has(n)) && heldNeeds(s, x).length === 0);
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

// The first segment of a path that is not on disk, and the directory it would
// have gone in. Both are needed: the name to judge, and somewhere to look for
// something almost exactly like it.
function firstMissing(rel) {
  const parts = norm(rel).split('/').filter((x) => x && x !== '.');
  let at = CWD;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = path.join(at, parts[i]);
    if (!fs.existsSync(next)) return { parent: at, name: parts[i] };
    at = next;
  }
  return null;
}
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
// Names in `dir` that are one or two keystrokes from `name`. Two is where
// `pakcages` sits beside `packages`; three starts matching real neighbours.
function nearNames(dir, name) {
  let entries; try { entries = fs.readdirSync(dir); } catch { return []; }
  const lim = name.length >= 5 ? 2 : 1;
  return entries.filter((e) => e !== name && Math.abs(e.length - name.length) <= lim &&
    editDistance(e.toLowerCase(), name.toLowerCase()) <= lim).slice(0, 3);
}

// A serialisation point is only a gate when two steps spell it the same way.
// One round produced six spellings of one migration head across eleven steps —
// drizzle-journal, drizzle-migrations-head, drizzle-migration-journal — and
// every one of them read as a different thing, so `check` would have opened two
// migration-writing steps in the same round. git merges those cleanly.
const POINT_NOISE = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'for', 'head', 'heads', 'file', 'files', 'point', 'shared', 'main']);
function pointTokens(x) {
  return new Set(String(x).toLowerCase().split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .filter((w) => !POINT_NOISE.has(w)));
}
// A point may name the instance it moves and not just the class of thing:
//
//     migration head: orders          lockfile: apps/web
//
// Two such names with the same class and different instances are two different
// shared things, said deliberately, and holding them apart is the entire reason
// for writing them that way. In a monorepo with a migration directory per
// package, one shared word serialised eleven steps that never touched.
//
// A scoped name against a BARE one is still treated as the same thing, and must
// stay that way: a step that says plain "lockfile" may well mean all of them,
// and that is exactly the pair worth catching.
const scopeOf = (x) => {
  const m = /^([^:]+):\s*(\S.*)$/.exec(String(x).trim());
  return m ? { cls: m[1], inst: m[2] } : null;
};
// Two spellings are the same thing when what is left of them is the same, or
// when one says everything the other does and more. Differing by one token is
// weaker evidence — "ci workflow" and "ci cache" are two things — so that one
// is said out loud and not treated as a fault.
function pointKinship(a, b) {
  // Same class, different instance, both said explicitly: not a spelling drift.
  const sa = scopeOf(a), sb = scopeOf(b);
  if (sa && sb) {
    const ca = pointTokens(sa.cls), cb = pointTokens(sb.cls);
    const shareCls = [...ca].filter((x) => cb.has(x));
    const sameClass = ca.size > 0 && shareCls.length === ca.size && shareCls.length === cb.size;
    if (sameClass && normPoint(sa.inst) !== normPoint(sb.inst)) return null;
  }
  const A = pointTokens(a), B = pointTokens(b);
  if (!A.size || !B.size) return null;
  const shared = [...A].filter((x) => B.has(x));
  if (shared.length === A.size && shared.length === B.size) return 'same';
  if (shared.length === A.size || shared.length === B.size) return 'same';
  if (shared.length && A.size === B.size && A.size - shared.length === 1) return 'maybe';
  return null;
}

// ------------------------------------------------------------------- the doctor
// Everything a step cites that can be checked without running anything. It is
// the sweep before work goes out, and its value is entirely in being run then.
CMDS.doctor = () => {
  const s = readState();
  const all = process.argv.includes('--all');
  const live = tasks(s).filter((t) => !DEAD_STATUS.includes(t.status));
  let bad = 0;
  const soft = [];
  // A plan rewritten after its steps were cut from it leaves steps citing text
  // that no longer says what they were built on. Refining rewrites its own
  // plan, so drift there is expected and only worth saying for a plan nobody
  // has refined.
  for (const p of s.plans || []) {
    if (!fs.existsSync(path.resolve(CWD, p.path))) { bad++; console.log(`✗ the plan ${p.path} is gone — \`load\` again, or the steps built on it cite nothing`); continue; }
    if (sha(fs.readFileSync(path.resolve(CWD, p.path), 'utf8')) !== p.sha && !p.refined)
      soft.push(`${p.path} changed since it was loaded, and has not been refined`);
  }
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
    if (!(t.owns || []).length) soft.push(`${t.key} owns nothing — guard cannot judge it`);
    for (const o of t.owns || []) {
      if (/\s[—–]\s|\s--\s/.test(o) || /:\d+$/.test(o) || (!/[/.]/.test(o) && o.split(/\s+/).length > 1))
        probs.push(`owns "${o}", which guard can never match against a diff`);
      else {
        // A directory a step is about to create does not exist yet, and on a
        // build from nothing that is most of the round: 31 of 47 steps failed
        // here once, and the answer was twenty .gitkeep commits made only to
        // get a green report. A doctor that has to be lied to is not run.
        //
        // What is still worth stopping is a typo, and a typo is visible: the
        // first segment that does not exist has a near-identical neighbour
        // that does. `pakcages/server/...` beside `packages/` is caught;
        // `packages/server/src/features/base/` on an empty repo is not.
        const miss = firstMissing(o);
        if (miss) {
          const near = nearNames(miss.parent, miss.name);
          if (near.length) probs.push(`owns "${o}", and "${miss.name}" does not exist beside ${near.map((n) => `"${n}"`).join(', ')} — a typo?`);
          else soft.push(`${t.key} owns "${o}", whose directory does not exist yet — it has to create it`);
        }
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
  // A shared file between open steps is expected now: they build in separate
  // worktrees and reconcile at the merge. What is worth saying is which merges
  // are coming, so the order is chosen rather than discovered.
  const dueOpen = [], duePlanned = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const f = overlap(live[i], live[j]);
    if (!f.length) continue;
    const both = OPEN_STATUSES.includes(live[i].status) && OPEN_STATUSES.includes(live[j].status);
    (both ? dueOpen : duePlanned).push(`${live[i].key} ↔ ${live[j].key}: ${f.join('; ')}`);
  }
  // A path three or more steps own is a seam, and a seam is a fan-in: every one
  // of those steps reconciles against every other at the merge, and any step
  // ordered after them waits for all of them. Saying it here is cheap, and the
  // answer is a plan of its own that lands first — after which nothing else
  // needs to own the file at all.
  {
    const owned = new Map();
    for (const t of live) for (const o of t.owns || []) {
      const k = norm(o);
      (owned.get(k) || owned.set(k, []).get(k)).push(t.key);
    }
    const fan = [...owned.entries()].filter(([, ks]) => ks.length >= 3)
      .sort((a, b) => b[1].length - a[1].length);
    if (fan.length) {
      console.log(`· ${fan.length} path(s) owned by three or more steps — each is a seam:`);
      for (const [f, ks] of fan) console.log(`    ${f} — ${ks.join(', ')}`);
      console.log('    Every one of those reconciles against every other at the merge. A step');
      console.log('    that owns the seam alone and lands first removes the whole fan-in.');
    }
  }
  if (dueOpen.length) {
    console.log(`· ${dueOpen.length} pair(s) of open steps share files — a merge to sequence, not a collision:`);
    for (const x of dueOpen) console.log('    ' + x);
    console.log('    Whichever lands second reconciles. `join` will say when.');
  }
  if (duePlanned.length) console.log(`· ${duePlanned.length} further pair(s) share files but are not both out yet.`);

  // A serialisation point only one step names is usually a spelling that missed
  // its partner, which is the failure mode this whole comparison exists for.
  const pts = new Map();
  for (const t of live) for (const x of t.serialises || []) {
    const k = normPoint(x);
    (pts.get(k) || pts.set(k, []).get(k)).push({ key: t.key, spelling: x, status: t.status });
  }
  // Spellings that are probably one thing. The confident kind is a fault: two
  // steps that both move the migration head and call it two names are two steps
  // nothing will hold apart. The weaker kind is said and not counted.
  const spellings = [...pts.entries()].map(([k, v]) => ({ k, spelling: v[0].spelling, who: v.map((x) => x.key) }));
  const same = [], maybe = [];
  for (let i = 0; i < spellings.length; i++) for (let j = i + 1; j < spellings.length; j++) {
    const kin = pointKinship(spellings[i].spelling, spellings[j].spelling);
    if (kin === 'same') same.push([spellings[i], spellings[j]]);
    else if (kin === 'maybe') maybe.push([spellings[i], spellings[j]]);
  }
  const twinned = new Set(same.concat(maybe).flat().map((x) => x.k));
  if (same.length) {
    bad += same.length;
    console.log(`✗ ${same.length} serialisation point(s) look like the same thing spelled two ways:`);
    for (const [a, b] of same) console.log(`    "${a.spelling}" (${a.who.join(', ')})  ≈  "${b.spelling}" (${b.who.join(', ')})`);
    console.log('    Pick one spelling and correct the others, or say why they are different things.');
    console.log('    Two names for one shared thing is two steps nothing holds apart.');
  }
  if (maybe.length) {
    console.log(`· ${maybe.length} pair(s) of serialisation points differ by one word — worth a look:`);
    for (const [a, b] of maybe) console.log(`    "${a.spelling}" (${a.who.join(', ')})  ~  "${b.spelling}" (${b.who.join(', ')})`);
  }
  // A point only one step names is either the spelling that missed its partner
  // or a step that genuinely moves something alone. It fired on 24 honest
  // singletons in one round and buried the pairs above, so it is now told only
  // where there is a partner to have missed — or under --all.
  const lone = [...pts.values()].filter((v) => v.length === 1 && (all || twinned.has(normPoint(v[0].spelling))));
  if (lone.length) {
    console.log(`· ${lone.length} serialisation point(s) only one step names:`);
    for (const v of lone) console.log(`    ${v[0].key}: "${v[0].spelling}"`);
    console.log('    If another step moves the same thing and spelled it differently, nothing will catch it.');
  }
  const quiet = [...pts.values()].filter((v) => v.length === 1).length - lone.length;
  if (quiet && !all) console.log(`· ${quiet} further point(s) named by one step only, and by nothing like it — \`doctor --all\` lists them.`);
  const contended = [...pts.values()].filter((v) => v.filter((x) => OPEN_STATUSES.includes(x.status)).length > 1);
  if (contended.length) {
    bad += contended.length;
    console.log(`✗ ${contended.length} serialisation point(s) held by more than one open step:`);
    for (const v of contended) console.log(`    ${v.map((x) => x.key).join(' ↔ ')}: "${v[0].spelling}"`);
  }

  // Things worth knowing that are nobody's fault: a directory a step will
  // create, a plan edited by hand, a step that owns nothing yet.
  for (const w of soft) console.log('· ' + w);

  // A tick over nothing checked is how a green report starts meaning nothing.
  if (!live.length) {
    console.log('· nothing to check — every step is landed, cancelled, or not yet recorded.');
    console.log('  Run this again when work is about to go out; it proves nothing right now.');
    return;
  }
  if (bad) { console.log(`\n✗ ${bad} problem(s) across ${live.length} step(s)`); process.exit(1); }
  ok(`${live.length} step(s) check out — paths, proofs, briefs and ownership` +
    (soft.length ? `, with ${soft.length} thing(s) worth a look above` : ''));
};

// ------------------------------------------------------- joining, and sending back
// Merging is where steps that shared a file finally meet. Whichever goes second
// reconciles, and the agent that should do it is the one that wrote the branch —
// it is still on its chat and it knows why it made those changes. A fresh agent
// reading logs would have to reconstruct two agents' intent from outside, which
// is strictly harder than what either of them was doing.
// The main checkout has to be clean before anything merges into it, and the
// reasons are the same whether one branch is going in or six.
function refuseIfDirty() {
  // Excluding .claude: this tool's own state lives there and is written on every
  // command, so a bare status is dirty before anything has happened and would
  // refuse every merge for ever.
  // Only tracked changes. An untracked file does not stop a merge — git refuses
  // by itself if one would be overwritten — and refusing here would block every
  // merge in any tree with a build directory in it.
  const dirty = shq('git', ['status', '--porcelain', '--', ':!.claude'])
    .split('\n').filter((l) => l.trim() && !l.startsWith('??')).join('\n');
  if (dirty) die("the main checkout has uncommitted changes to tracked files:\n" +
    dirty.split('\n').slice(0, 10).map((l) => '    ' + l).join('\n') +
    "\n  Merging on top of them would mix your work into the step's. Commit or stash first.");
}
// One branch into the main line. Returns the conflicted paths, having rolled the
// merge back, or an empty list having left it in place.
function mergeOne(s, t) {
  let conflicted = [];
  try {
    execFileSync('git', ['merge', '--no-ff', t.branch, '-m', `land ${t.key}`],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    // Take the conflicted list before aborting; after the abort there is nothing
    // left to read it from.
    conflicted = shq('git', ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    try { execFileSync('git', ['merge', '--abort'], { stdio: 'ignore' }); } catch { /* nothing to abort */ }
  }
  t.joinAttempts = (t.joinAttempts || 0) + 1;
  if (conflicted.length) {
    // Who landed the other side, so the resume can say what it is reconciling
    // against rather than just naming files.
    const others = tasks(s).filter((x) => x.key !== t.key && x.status === 'landed' &&
      conflicted.some((f) => (x.owns || []).some((o) => collides(o, f))));
    t.conflictedWith = others.map((x) => x.key);
    t.conflictedOn = conflicted;
    return { conflicted, others };
  }
  t.joinedAt = new Date().toISOString();
  t.joinedSha = shq('git', ['rev-parse', '--short', 'HEAD']);
  return { conflicted: [] };
}

// Several branches into the main line, then ONE suite over the result.
//
// Twelve branches finishing together used to mean twelve full suite runs in
// series through the slot, and the graph advanced at the rate of one of them.
// Merging the green ones together and testing once cuts that by the batch
// factor — and tests the tree that will actually exist, which is strictly
// better coverage than twelve pairwise trees nobody ever assembles.
//
// What it costs is attribution. A red batch does not say which branch did it,
// so the order is recorded here and the red path re-joins one at a time from
// the recorded sha. That cost is only paid when something is genuinely broken.
function joinBatch(s, argv) {
  const keys = argv.filter((a) => !a.startsWith('--'));
  if (keys.length < 2) die('join --batch wants two or more steps. One branch is just `join <key>`.');
  const ts = keys.map((k) => getTask(s, k));
  for (const t of ts) if (!t.branch) die(`${t.key} has no branch — it was never opened`);
  refuseIfDirty();

  const before = shq('git', ['rev-parse', '--short', 'HEAD']);
  const merged = [], failed = [];
  for (const t of ts) {
    const r = mergeOne(s, t);
    if (r.conflicted.length) failed.push({ t, ...r });
    else merged.push(t);
  }
  // The order matters for the bisect, and only the record can still say what it
  // was once six merges sit on top of each other.
  (s.batches ||= []).push({ at: new Date().toISOString(), before,
    merged: merged.map((t) => t.key), failed: failed.map((x) => x.t.key) });
  commit(s, 'join --batch', argv);

  if (merged.length) {
    const head = shq('git', ['rev-parse', '--short', 'HEAD']);
    ok(`${merged.length} of ${ts.length} merged cleanly onto ${head} (was ${before}): ${merged.map((t) => t.key).join(' ')}`);
  } else {
    console.log(`✗ none of the ${ts.length} merged — the main line is untouched at ${before}.`);
  }
  for (const { t, conflicted, others } of failed) {
    console.log(`\n✗ ${t.key} conflicts with the main line on ${conflicted.length} file(s):`);
    for (const f of conflicted) console.log('    ' + f);
    if (others.length) console.log(`  The other side is ${others.map((x) => x.key).join(', ')}, already landed.`);
    console.log('  That one merge was rolled back; the rest of the batch stands.');
    console.log(`    node ${SELF()} sendback ${t.key} --why conflict`);
  }
  if (!merged.length) process.exit(1);

  console.log('\n  One suite over the whole batch, which is the tree that will actually exist:');
  console.log(`    node ${SELF()} slot run ci -- <your test command>`);
  console.log(`  Green: land --batch ${merged.map((t) => t.key).join(' ')} --sha ${shq('git', ['rev-parse', '--short', 'HEAD'])}`);
  console.log('  Red:   the batch does not say which branch did it. Bisect from the');
  console.log(`         recorded base:  git reset --hard ${before}  then re-join in halves.`);
  console.log(`         The order is recorded: ${merged.map((t) => t.key).join(' → ')}`);
  // Everything the batch put on the main line may already be built on.
  const nowFree = tasks(s).filter((x) => x.status === 'planned' && heldNeeds(s, x).length === 0 &&
    (x.needs || []).some((n) => merged.some((t) => t.key === n)));
  if (nowFree.length) {
    console.log(`\n  ${nowFree.length} step(s) can open off this batch now: ${nowFree.map((x) => x.key).join(' ')}`);
  }
  if (failed.length) process.exit(1);
}

CMDS.join = (argv) => {
  const s = readState();
  if (argv.includes('--batch')) return joinBatch(s, argv);
  const t = getTask(s, argv[0]);
  if (!t.branch) die(`${t.key} has no branch — it was never opened`);
  refuseIfDirty();

  const before = shq('git', ['rev-parse', 'HEAD']);
  const { conflicted, others } = mergeOne(s, t);

  if (conflicted.length) {
    commit(s, 'join (conflict)', argv);
    console.log(`✗ ${t.key} conflicts with the main line on ${conflicted.length} file(s):`);
    for (const f of conflicted) console.log('    ' + f);
    if (others.length) console.log(`  The other side is ${others.map((x) => x.key).join(', ')}, already landed.`);
    console.log('\n  The merge was rolled back — the main line is untouched.');
    console.log(`  Send it back to the agent that wrote it, which is still on its chat:`);
    console.log(`    node ${SELF()} sendback ${t.key} --why conflict`);
    process.exit(1);
  }
  commit(s, 'join', argv);
  ok(`${t.key} merged cleanly at ${t.joinedSha} (was ${before.slice(0, 7)})`);
  console.log('  A clean merge is not a working one. Run the suite on the joined tree now:');
  console.log(`    node ${SELF()} slot run ci -- <your test command>`);
  console.log(`  Green: land ${t.key} --sha ${t.joinedSha}`);
  console.log(`  Red:   sendback ${t.key} --why "<what broke>"`);
  // The merge is on HEAD now, so anything that only needed this can be cut from
  // it — that is the whole point of not waiting for the proof. Say it here,
  // where the merge just happened, rather than leaving it for `land`.
  if (OPEN_AT_JOIN) {
    const freed = tasks(s).filter((x) => x.status === 'planned' &&
      (x.needs || []).includes(t.key) && heldNeeds(s, x).length === 0);
    if (freed.length) {
      console.log(`\n  This merge is on HEAD, so ${freed.length} step(s) can open now without waiting`);
      console.log(`  for the suite: ${freed.map((x) => x.key).join(' ')}`);
      console.log('  Open them, then run the suite beside them. `check` names the full set.');
    }
  }
};

CMDS.sendback = (argv) => {
  const s = readState();
  const t = getTask(s, argv[0]);
  const i = argv.indexOf('--why');
  let why = i === -1 ? '' : argv.slice(i + 1).join(' ');
  if (!t.chat) die(`${t.key} has no chat to resume — it was never opened through \`run open\``);
  if (!why) die('sendback needs --why "<what to fix>"');

  // The one case worth composing rather than retyping.
  if (why === 'conflict') {
    const files = t.conflictedOn || [];
    const others = t.conflictedWith || [];
    why = `Your branch ${t.branch} no longer merges into the main line. ` +
      (others.length ? `${others.join(' and ')} landed while you were working, and ` : '') +
      `these files conflict:\n\n` + files.map((f) => '    ' + f).join('\n') +
      `\n\nYou own them, so reconciling is yours. Fetch the current main line into your
worktree, look at what landed there, and merge it into your branch — keeping both
sides' intent, not just yours. The other change is not a mistake to overwrite.
Then re-run your proof and commit.`;
  }
  const prompt = `${why}\n\nYou are still ${t.key}, in ${t.worktree}, on ${t.branch}.\n\n` +
    `You may write only what you own:\n` + (t.owns || []).map((o) => '    ' + o).join('\n') +
    ((t.verify || []).length
      ? `\n\nProve it again with:\n` + t.verify.map((v) => '    ' + v).join('\n')
      : '');
  const f = sub('sendbacks', `${t.key}-${(t.sendbacks || []).length + 1}.txt`);
  fs.writeFileSync(f, prompt + '\n');
  (t.sendbacks ||= []).push({ at: new Date().toISOString(), why: why.slice(0, 200), file: path.relative(CWD, f) });
  t.status = 'open';
  commit(s, 'sendback', argv);
  ok(`${t.key} sent back — the prompt is at ${path.relative(CWD, f)}`);
  // A step whose merge is already on HEAD may have had other worktrees cut from
  // it. Undoing it with a reset would strand those, so the fix has to go
  // forward. This is the one place the open-at-join trade has to be paid, and
  // it is paid by being told about it rather than by discovering it.
  const stranded = cutFrom(s, t);
  if (stranded.length) {
    console.log(`\n  ⚠ ${stranded.length} step(s) were opened off this merge: ${stranded.map((x) => x.key).join(' ')}`);
    console.log('    Their worktrees are cut from the HEAD that carries it, so do NOT');
    console.log(`    \`git reset --hard\` past ${t.joinedSha || 'that merge'} — the fix has to land as a`);
    console.log('    forward commit on this branch, and re-join.');
  }
  console.log('\n  Resume the agent that wrote it, on its own chat:');
  console.log(`    agent -p --force --trust --resume ${t.chat} "$(cat ${path.relative(CWD, f)})"`);
  console.log('\n  It has the context for why it made those changes. A new agent reading logs');
  console.log('  would have to reconstruct that from outside.');
};

const HELP = `orchestrate — six stages, on Cursor or Claude Code

  load <path>...            read the plan files, record them
  map                       which plans touch which files, and where the seams are
  assess [propose|set|critical|check]  how hard each step is, and which model
  refine brief <plan>       the prompt for a refining agent
  refine done <plan>        read its report; records the steps it found
  step add < json           record steps by hand, in one batch or not at all
  step rm <key>…            cancel a step, and drop it from what needed it
  step link [--only-shared] turn each plan's requires: into needs between steps
  step reset <plan>         cancel every live step of one plan
  check                     which steps can open together, and what blocks the rest
  run open <key>            worktree, chat, brief — everything a step needs to start
  run record <key> --log L  harvest a finished run into the record
  guard <key>               did it touch anything it does not own
  join <key>                merge it into the main line; says when it conflicts
  join --batch <key>…       merge several, then one suite over the result
  sendback <key> --why W    resume the agent that wrote it, with what to fix
  land <key> [--sha S]      record the merge
  land --batch <key>… --sha S   record what one suite proved
  board                     every step and its state
  doctor [--all]            everything the steps cite that can be checked without running
  slot run <n> -- <cmd>     one shared machine slot, so parallel heavy checks queue
  models [list|sync]        the ladder, and regenerating it from the CLI

A dependency counts as met once it has JOINED, not once it has landed: the
merge is on the main checkout's HEAD by then and a worktree cut from it holds
the same code, so dependents no longer queue behind the suite. Set
CURSOR_ORCH_OPEN_AT=land to wait for the proof instead.

State lives in .claude/orch/. events.jsonl is the record; state.json is a
projection of it.`;

const [cmd, ...argv] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); process.exit(0); }
if (!CMDS[cmd]) { console.error(HELP); die(`\nunknown command: ${cmd}`); }
CMDS[cmd](argv);
