#!/usr/bin/env node
// Five stages: load the plans, judge how hard they are, refine away the
// ambiguity, check nothing collides, run the steps.
//
// State lives in .claude/orch/. The record (events.jsonl) is the truth and
// state.json is a projection of it — every change appends the event first and
// writes the projection second, so a crash between the two leaves an event with
// no projection. `rebuild` repairs that by replaying the last event's state
// snapshot back into state.json. The other order would silently lose the change.
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
  // path.relative answers in the platform's own separator, so on Windows a
  // path two levels up reads "..\\.." — a POSIX-only startsWith check let it
  // straight through and printed the very ../../../.. chain this exists to
  // stop. Fold to forward slashes before judging it.
  return rel && !slashes(rel).startsWith('../..') && rel.length < abs.length ? rel : abs;
};
const SELF = () => shortest(process.argv[1]);
const ok = (msg) => console.log('✓ ' + msg);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

// ---------------------------------------------------------------- persistence
const EMPTY = { version: 1, created: null, plans: [], tasks: [], notes: [] };
function readState() {
  if (!fs.existsSync(STATE)) return { ...EMPTY, tasks: [], plans: [], notes: [] };
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (e) { die(`state.json is not valid JSON (${e.message}). The record is intact — run \`rebuild\` to replay it back from ${EVENTS}`); }
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
  // A record written on Windows holds backslashes; `slashes()` (below) is the
  // one place that already folds them, so this reuses it rather than growing a
  // second, slightly different, notion of "the same path".
  let x = slashes(p).replace(/\/+$/, '');
  while (x.startsWith('./')) x = x.slice(2);
  return path.posix.normalize(x === '' ? '.' : x);
}
// A glob only where `owns` actually uses one — `*` inside a segment or `**`
// across segments — converted to the equivalent regex. `**/` and `/**` collapse
// to "zero or more segments" so the boundary slash does not force at least one
// directory to exist between the fixed parts of the pattern.
const isGlob = (p) => /[*?]/.test(p);
// Placeholders, not NUL: three characters from the Unicode private-use area,
// which cannot occur in a path and, unlike a NUL byte, do not make git read this
// file as binary and lose it to `diff` and `blame`.
const PH_SLASH_STAR = '\uE000', PH_STAR_SLASH = '\uE001', PH_STAR_STAR = '\uE002';
function globRe(pat) {
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const x = esc
    .replace(/\*\*\//g, PH_SLASH_STAR)
    .replace(/\/\*\*/g, PH_STAR_SLASH)
    .replace(/\*\*/g, PH_STAR_STAR)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(new RegExp(PH_SLASH_STAR, 'g'), '(?:.*/)?')
    .replace(new RegExp(PH_STAR_SLASH, 'g'), '(?:/.*)?')
    .replace(new RegExp(PH_STAR_STAR, 'g'), '.*');
  return new RegExp('^' + x + '$');
}
function collides(a, b) {
  // Case-insensitive here only — not folded into `norm` itself, which other
  // callers (firstMissing among them) use to build real filesystem paths that
  // must keep their actual case on a case-sensitive filesystem.
  const x = norm(a).toLowerCase(), y = norm(b).toLowerCase();
  if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) return true;
  // Only a trailing glob used to be recognised, so a mid-path one — `src/**/*.js`
  // against `src/a.js` — matched nothing and let stray files straight through.
  if (isGlob(x) && !isGlob(y)) return globRe(x).test(y);
  if (isGlob(y) && !isGlob(x)) return globRe(y).test(x);
  return false;
}
function overlap(t1, t2) {
  const out = [];
  for (const a of t1.owns || []) for (const b of t2.owns || []) if (collides(a, b)) out.push(a + ' ↔ ' + b);
  return out;
}
// "a", "a and b", "a, b and c". Two callers wanted this and each had written
// its own: five tiers collapsing onto three efforts is a three-way list, and
// so is the set of steps found to be claiming one file. A bare join of three
// reads as one long name.
const andList = (xs) => xs.length < 2 ? String(xs[0] ?? '')
  : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
// A serialisation point is a shared invariant named in prose by whoever wrote
// the step — "docker-compose.yml", "docker compose file", "Docker-Compose.yml".
// Comparing those by exact string equality is a check that can only ever fire
// when two authors typed the same characters, and on a real run it never fired
// once: a pre-flight found a docker-compose.yml collision it had reported clean.
// `normPoint` folds case and whitespace only, which those three spellings do
// not agree on even after folding — the actual matching, including the scoped
// `class: instance` form (a bare name still gates against any scoped instance
// of the same class; two different instances do not), is `pointKinship` below,
// which this reuses so the gate and `doctor`'s drift report agree on what
// "the same point" means. Keep both spellings when reporting so a mismatch
// worth tidying stays visible.
const normPoint = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
function sharedPoints(t1, t2) {
  const out = [];
  for (const x of t1.serialises || []) for (const y of t2.serialises || []) {
    if (pointKinship(x, y) === 'same') out.push(y === x ? x : x + ' ≈ ' + y);
  }
  return out;
}
// A symbol one step exports and another consumes. This is the only footprint a
// real build-order dependency leaves in the record: B imports `ExamAttempt`
// from a module A creates, and the two touch no file in common and name no
// point in common, so nothing else here can see the edge at all.
//
// `provides` is what a step's work makes reachable from outside it — an
// exported type or function, a table, a config key, the handler behind a route.
// `uses` is what it consumes that it does not itself create. Both are named by
// whoever writes the step, because the step is the only thing that knows them;
// a symbol read out of prose is a guess, and a guess in the one field that
// decides build order is worse than no field.
//
// An identifier, always — the thing you would type in an import. A route is
// named by its handler or its route constant, not by its URL: a URL is
// indistinguishable from a path here, and `stepProblems` refuses paths because
// a path in this field looks filled in and matches nothing.
//
// Compared case-sensitively after trimming: `ExamAttempt` and `examAttempt` are
// two different exports in every language this runs against, and folding them
// together would invent an edge as readily as it caught one.
const normSym = (s) => String(s).trim();
function sharedSymbols(provider, consumer) {
  const mine = new Set((provider.provides || []).map(normSym).filter(Boolean));
  return [...new Set((consumer.uses || []).map(normSym))].filter((u) => u && mine.has(u));
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

// What moving these keys onto the main line actually opens up, and what it
// does not. `join` used to answer this with its own two-line filter — planned,
// needs me, nothing held — which knows about dependencies and nothing about
// serialisation points. So it advertised a step, and `run open` then refused
// the same step for moving a point that open work was already moving: two
// commands, two different ideas of "can open now", and the one that printed the
// advice was the one that was not going to enforce it. There is only one such
// idea now, and it is `frontier`, which is what `run open` is checked against.
function freedBy(s, keys) {
  const f = frontier(s);
  const mine = (x) => (x.needs || []).some((n) => keys.includes(n));
  return { can: f.accepted.filter(mine), held: f.blocked.filter(({ t }) => mine(t)) };
}

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
const LIST_FIELDS = ['needs', 'owns', 'serialises', 'verify', 'context', 'provides', 'uses'];
// Fields the tool keeps about a step, which whoever writes the step does not
// get to set. `refine done` reads a file an agent wrote: a report carrying
// `"status": "cancelled"` would merge straight into the record and leave a step
// off the board while the command printed a tick, and one carrying
// `"status": "landed"` would claim a proof that never ran. Refused rather than
// stripped, because a report that says this is a report that has misunderstood
// what it is writing, and silently ignoring half of it is how the last one got
// through.
const KEPT_FIELDS = ['status', 'runs', 'branch', 'worktree', 'chat', 'briefFile', 'briefSha',
  'openedAt', 'landedAt', 'landedSha', 'joinedAt', 'joinedSha', 'joinAttempts', 'joinError',
  'cancelledAt', 'revivedAt', 'guardedAt', 'guardedBase', 'guardedFiles', 'severed',
  'sendbacks', 'conflictedOn', 'conflictedWith', 'model_by'];
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
// Every path this records or prints is repo-relative, and on Windows
// path.relative hands back backslashes. Those are then compared against
// `git diff --name-only`, which is always forward-slash, and pasted into
// shell commands the operator is told to run — so the separator is folded
// once, here, rather than at each of the eleven places that needed it.
const relCwd = (p) => slashes(path.relative(CWD, p));
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
  // A key becomes a worktree directory name and a branch name — `run open`
  // builds both by string-pasting it in, with no path.join between the key and
  // its neighbours. `owns` gets a whole gate of path checks below; a key of
  // "../../evil" got none, and only git's own ref-format check stood between it
  // and a worktree landing two directories outside the repo.
  else if (/[\\/]/.test(it.key) || it.key === '.' || it.key === '..')
    p.push(`key "${it.key}" cannot contain a slash — it becomes a worktree and branch name`);
  if (!existing && !it.title) p.push('needs a title');
  // A key is the address of one step. Two plans that both called something
  // "S-1" used to merge into one record without a word: the second plan's
  // title, owns and plan path overwrote the first's, and the count printed
  // afterwards came from the report rather than from the register, so nothing
  // said eight steps had gone. Three plans of five steps became five steps.
  if (existing && existing.plan && it.plan && !samePlan(existing.plan, it.plan))
    p.push(`key "${it.key}" already belongs to ${existing.plan} — keys are unique across every plan in the round, so key this one ${keyPrefix(it.plan)}.1, ${keyPrefix(it.plan)}.2 …`);
  for (const f of LIST_FIELDS) if (it[f] !== undefined && !Array.isArray(it[f])) p.push(`${f} must be a list`);
  for (const f of KEPT_FIELDS) if (it[f] !== undefined)
    p.push(`sets "${f}", which is the tool's own bookkeeping and not a step's to write — take it out`);
  for (const o of it.owns || []) {
    if (typeof o !== 'string' || !o.trim()) { p.push('owns has an empty entry'); continue; }
    if (/\s[—–]\s|\s--\s/.test(o)) p.push(`owns entry "${o}" is prose, not a path`);
    else if (/:\d+/.test(o)) p.push(`owns entry "${o}" carries a :line suffix — ownership is whole files`);
    else if (!/[/.]/.test(o) && o.split(/\s+/).length > 1) p.push(`owns entry "${o}" reads as a sentence, not a path`);
  }
  // `provides` and `uses` name symbols, and a symbol is the thing you would
  // type in an import — not the file it lives in and not a sentence about it.
  // Both mistakes make the field look filled while matching nothing, which is
  // the failure that costs most here: a `uses` that can never intersect any
  // `provides` records no edge, and the step opens against code that does not
  // exist yet.
  for (const f of ['provides', 'uses']) for (const x of it[f] || []) {
    if (typeof x !== 'string' || !x.trim()) { p.push(`${f} has an empty entry`); continue; }
    const v = x.trim();
    if (/[/\\]/.test(v) || /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|sql|json|md)$/i.test(v))
      p.push(`${f} entry "${v}" is a path — name the symbol it exports, not the file it lives in`);
    else if (/\s/.test(v)) p.push(`${f} entry "${v}" reads as prose, not a symbol you could import`);
  }
  p.push(...contextProblems(it.context, 'context'));
  return p;
}

// `context` is the only field a step carries for the reader rather than for the
// scheduler: it names what already exists, says what is in it, and the brief
// prints it verbatim. So the path has to be one the agent can open from its own
// worktree — repository-relative, whole files, not a sentence. Prose here is the
// same failure prose in `owns` was: it looks filled in, it costs the agent a
// search that finds nothing, and nothing downstream ever says why.
function contextProblems(list, field) {
  const p = [];
  if (list === undefined || list === null) return p;
  if (!Array.isArray(list)) return [`${field} must be a list of {path, what} objects`];
  for (const c of list) {
    const v = typeof c === 'string' ? c
      : (c && typeof c === 'object' && !Array.isArray(c) ? c.path : null);
    if (typeof v !== 'string' || !v.trim()) {
      p.push(`${field} has an entry with no path — each one is {"path": "…", "what": "…"}`);
      continue;
    }
    const x = v.trim(), clip = x.slice(0, 60);
    if (path.isAbsolute(x) || /^[A-Za-z]:[\/]/.test(x))
      p.push(`${field} entry "${clip}" is an absolute path — it is read from a worktree that is not this checkout, so it has to be repository-relative`);
    else if (norm(x).split('/').includes('..'))
      p.push(`${field} entry "${clip}" climbs out of the repository`);
    else if (/\s[—–]\s|\s--\s/.test(x))
      p.push(`${field} entry "${clip}" is prose, not a path — what it is goes in "what"`);
    else if (/:\d+/.test(x))
      p.push(`${field} entry "${clip}" carries a :line suffix — name the file`);
    else if (!/[/.]/.test(x) && x.split(/\s+/).length > 1)
      p.push(`${field} entry "${clip}" reads as a sentence, not a path`);
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
// ------------------------------------------------------------ severed edges
// `step rm` has to take an edge out of a dependent's `needs`: a cancelled step
// never reaches the main line, so `heldNeeds` would hold everything behind it
// for ever. Taking it out silently is the other half of that trade and it is
// the one that cost a round — cancelling eight steps stripped `needs` from the
// survivors, re-refining brought the same keys back with nothing pointing at
// them, and four steps were a `run open` away from building against a tree
// that had none of the work they were written on top of.
//
// So the edge is moved rather than dropped. `severed` holds what was taken and
// which cancellation took it, `restoreSevered` puts it back the moment that key
// is recorded again, and `doctor` names the ones still lying severed. The rule
// is the same one `step link` already enforces on itself: half a graph is worse
// than none, because the half that landed is the harder half to see.
function severNeeds(s, gone) {
  const at = new Date().toISOString();
  const cut = [];
  for (const t of tasks(s)) {
    if (gone.has(t.key)) continue;   // a doomed step keeps its own needs
    const lost = (t.needs || []).filter((n) => gone.has(n));
    if (!lost.length) continue;
    t.needs = t.needs.filter((n) => !gone.has(n));
    t.severed ||= [];
    for (const n of lost) if (!t.severed.some((x) => x.key === n)) t.severed.push({ key: n, at });
    cut.push({ key: t.key, lost });
  }
  return cut;
}
// What the tool took out, the tool puts back. Called wherever a key comes back
// onto the board, so reviving a cancelled step is not a quieter way of deleting
// every edge that pointed at it.
function restoreSevered(s, key) {
  const back = [];
  for (const t of tasks(s)) {
    if (!(t.severed || []).some((x) => x.key === key)) continue;
    t.severed = t.severed.filter((x) => x.key !== key);
    if (!t.severed.length) delete t.severed;
    if (!(t.needs || []).includes(key)) (t.needs ||= []).push(key);
    back.push(t.key);
  }
  return back;
}
// Edges still lying severed, with what became of the step at the other end.
const severedEdges = (s) => tasks(s).filter((t) => !DEAD_STATUS.includes(t.status))
  .flatMap((t) => (t.severed || []).map((x) => ({ t, lost: x.key, dep: depOf(s, x.key), at: x.at })));

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
  if (existing) {
    // Cancelled, never deleted (see `step rm`) — but a step add naming that key
    // again is a deliberate act, and merging fields into a dead record while
    // reporting success left it dead: `board` still showed it cancelled and
    // `run open` refused it, with nothing having said so. Recording it again is
    // what un-cancels it, full stop. There used to be an exception for a record
    // that carried its own `status`, which is the one shape that must never
    // reach here at all — `stepProblems` refuses the whole step for it now, so
    // the exception could only ever have fired on the case it was protecting.
    if (existing.status === 'cancelled') {
      existing.status = 'planned';
      delete existing.cancelledAt;
      existing.revivedAt = new Date().toISOString();
    }
    Object.assign(existing, it);
  } else s.tasks.push(merged);
  // Reviving a key restores the edges its cancellation severed, whether it came
  // back through `step add` or through a second `refine done`. Cheap to run
  // unconditionally: a key nothing was severed against finds nothing.
  restoreSevered(s, it.key);
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

// ------------------------------------------------------------------ runners
// Which CLI executes the steps. Chosen once, before `load`, and the round is
// automated from there — so this is a property of the round, not of a step.
//
// Cursor runs a ladder of five models. opencode runs one model, DeepSeek V4
// Flash, and the tier chooses how hard it thinks instead of which model
// answers. Claude Code does both at once: a tier picks Sonnet or Opus and the
// effort it runs at. The three are never compared: they share a tier
// vocabulary and nothing else.
const RUNNERS = ['cursor', 'opencode', 'claude'];
const runnerOf = (s) => s.runner || 'cursor';
const runnerRow = (name) => (ladder().runners || {})[name] || null;
// What a step will actually run on, as one line, for a table or a brief.
function runnerModel(s, tier) {
  const name = runnerOf(s);
  if (name === 'cursor') { const row = tierOf(tier); return { name, model: modelName(row), detail: modelName(row), verifiable: true }; }
  const r = runnerRow(name);
  if (!r) return { name, model: '(unknown runner)', detail: '(unknown runner)', verifiable: false };
  const t = ladder().roles[tier] || tier;
  // A runner with a ladder of its own picks a model per tier and the reasoning
  // it runs at with it; one with a single model picks only the effort.
  if (r.ladder) {
    const row = r.ladder.find((x) => x.tier === t);
    if (!row) return { name, model: `(no ${name} row for tier ${t})`, detail: `(no ${name} row for tier ${t})`, verifiable: false };
    return { name, model: row.id, effort: row.effort,
      detail: `${row.id} · ${row.effort}`, verifiable: !!r.verifiable };
  }
  const effort = (r.efforts || {})[t];
  return { name, model: r.model, effort,
    detail: `${r.shown || r.model} · ${effort || '?'}`, verifiable: !!r.verifiable };
}
// The launcher's own answer to "where is the binary". Asked here so a round
// fails before it opens rather than once per step inside a backgrounded run.
function runnerBin(name) {
  if (name === 'cursor') return { ok: true, path: 'agent' };
  try {
    const p = execFileSync('node', [path.join(HERE, 'scripts', 'models.mjs'), 'which', '--runner', name],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return { ok: true, path: p };
  } catch (e) { return { ok: false, why: String(e.stderr || e.message).trim() }; }
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

CMDS.runner = (argv) => {
  const s = readState();
  if (!argv.length || argv[0] === 'show') {
    const name = runnerOf(s);
    const m = runnerRow(name);
    console.log(`This round runs on: ${name}${s.runner ? '' : '  (the default — nothing has chosen yet)'}`);
    if (name === 'cursor') {
      console.log('  Five models, weakest to strongest. The model that answered is read out of');
      console.log('  the run\'s own opening event and checked against what was asked for.');
    } else if (m && m.ladder) {
      console.log('  A tier picks the model and the effort it runs at, together:');
      for (const x of m.ladder)
        console.log(`    ${x.tier.padEnd(10)} ${x.id.padEnd(18)} effort ${x.effort}`);
      console.log('  The model that answered is named in the run\'s own opening event and is');
      console.log('  checked against what was asked for.');
    } else if (m) {
      console.log(`  One model: ${m.shown || m.model}  (${m.model})`);
      console.log('  A tier chooses the effort, not the model:');
      for (const [t, e] of Object.entries(m.efforts || {})) console.log(`    ${t.padEnd(10)} ${e}`);
      console.log('  Nothing in the log names the model that answered, so a run records what was');
      console.log('  asked for and is marked unverified. The effort is checked before the run.');
    }
    const bin = runnerBin(name);
    console.log(bin.ok ? `  binary: ${bin.path}` : `  ✗ ${bin.why}`);
    if (tasks(s).some((t) => (t.runs || []).length))
      console.log('\n  Runs already recorded on this round were made on the runner it had then.');
    return;
  }
  if (argv[0] !== 'use') die('runner [show] | runner use <' + RUNNERS.join('|') + '>');
  const want = argv[1];
  if (!RUNNERS.includes(want)) die(`unknown runner "${want}". Known: ${RUNNERS.join(', ')}`);
  // Changing it mid-round is allowed and said out loud, because the records
  // already filed were made somewhere else and comparing them is on whoever
  // reads them.
  const out = tasks(s).filter((t) => OPEN_STATUSES.includes(t.status));
  if (out.length) console.log(`⚠ ${out.length} step(s) are already out on ${runnerOf(s)}: ${out.map((t) => t.key).join(' ')}`);
  const bin = runnerBin(want);
  if (!bin.ok) die(`${want} cannot be used here.\n  ${bin.why}`);
  s.runner = want;
  commit(s, 'runner use', argv);
  ok(`this round runs on ${want}`);
  const m = runnerRow(want);
  if (m && !m.verifiable) {
    console.log('  Nothing in its log names the model that answered, so runs are recorded as');
    console.log('  what was asked for and marked unverified. With one model there is nothing');
    console.log('  to confuse it with; a silent downgrade would still not be caught.');
  }
  console.log(`  binary: ${bin.path}`);
};

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
    return { path: relCwd(f), lines: body.split('\n').length, bytes: Buffer.byteLength(body),
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
  // A needs: edge that only closes into a loop once the whole batch is in place
  // is invisible to the per-step checks above — each looks at one step against
  // the state as it stood before this batch, and a self-reference or a cycle
  // spread across several new steps passes every one of them individually.
  // `needs "S1", which is not a step in this round` never fires because by the
  // time it is checked, `dry` already holds S1. Only `waves`, run once over the
  // batch as it would land, sees the loop.
  const cyc = waves(dry).find((w) => w.wave === -1);
  if (cyc) bad.push(['(cycle)', [`these steps depend on each other in a loop and could never open: ${cyc.tasks.map((t) => t.key).join(' ')}`]]);
  return bad;
}

CMDS.step = (argv) => {
  const s = readState();
  const usage = 'step add < json | step own <key> <path>… [--remove] | step link [--dry-run] [--only-shared] | ' +
    'step rm <key>… [--force] | step reset <plan> [--force]';

  // A refined `owns` list comes out short on shared ground far more often than
  // it comes out long, and always in the same place: the registry the step has
  // to add one line to, the migration journal its own migration writes, the
  // seed file its own proof command touches. Each of those is work that was
  // correct, failing `guard` on a list nobody could have written from the plan
  // alone. The alternative was re-refining the whole plan to add one path.
  //
  // Widening ownership is a decision, so it is recorded like one, judged by the
  // same gate `step add` uses, and it says at once what it now collides with.
  if (argv[0] === 'own') {
    const remove = argv.includes('--remove');
    const rest = argv.slice(1).filter((a) => a !== '--remove');
    const key = rest.shift();
    if (!key || !rest.length) die('step own <key> <path>… [--remove]');
    const t = getTask(s, key);
    if (DEAD_STATUS.includes(t.status)) die(`${key} is ${t.status} — nothing is going to write those files`);
    const probs = stepProblems(s, { key, owns: rest }, t);
    if (probs.length) { for (const p of probs) console.error('✗ ' + p); process.exit(1); }
    const before = (t.owns || []).map(norm);
    if (remove) {
      const absent = rest.filter((o) => !before.includes(norm(o)));
      if (absent.length) die(`${key} does not own ${absent.join(', ')} — nothing to remove`);
      t.owns = (t.owns || []).filter((o) => !rest.some((r) => norm(r) === norm(o)));
    } else {
      const added = rest.filter((o) => !before.includes(norm(o)));
      if (!added.length) { ok(`${key} already owns all of those`); return; }
      t.owns = [...(t.owns || []), ...added];
    }
    // The brief already in the agent's hands was written from the old list, and
    // `doctor` will say so. Saying it here is what stops the round going out on
    // instructions nobody revised.
    commit(s, 'step own', argv);
    ok(`${key} now owns ${(t.owns || []).length} path(s): ${(t.owns || []).join(' ')}`);
    if (t.briefSha && OPEN_STATUSES.includes(t.status)) {
      console.log(`\n  ⚠ ${key} is ${t.status} and its brief was written from the old list.`);
      console.log(`     Rewrite it and tell the agent:  node ${SELF()} run open ${key} --rebrief`);
    }
    reportOverlaps(s, [key]);
    return;
  }

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
    // `--only-shared` records the edge only where the two steps actually meet.
    // What counts as meeting used to include owning a path in common, and that
    // was this command working against the engine it feeds. A `needs` edge is a
    // gate — `frontier` drops any candidate with one unmet, and `run open` dies
    // on it — while `blocks`/`willMerge` above exist precisely to say a shared
    // file is NOT a gate but a merge to sequence. So the command recommended
    // for widening a narrow round was itself serialising, by hand, the one
    // thing the scheduler had been rebuilt to run in parallel.
    //
    // Two steps meet in a way that decides build order when one CONSUMES A
    // SYMBOL the other CREATES, or when they move the same serialisation point.
    // Nothing else is an ordering. A file they both write is reported, and they
    // still run together.
    //
    // The symbol test is also the one that sees a dependency file overlap never
    // could: B imports what A exports, from files that have nothing in common.
    // That edge was missing from every graph this built, and a step opening
    // against code that did not exist yet is what it cost.
    //
    // What it still cannot see is a dependency nobody named — B reads at
    // runtime what A writes, and no symbol, file or point says so. So a
    // requirement that comes out with no edges at all is not quietly dropped:
    // it is named and it fails the command.
    const onlyShared = argv.includes('--only-shared');
    const live = tasks(s).filter((t) => !DEAD_STATUS.includes(t.status));
    const stepsOf = (rec) => live.filter((t) => samePlan(t.plan, rec.path));
    const added = [], missing = [], unknown = [], skipped = [], vanished = [], reconcile = [];
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
            // `t` is the dependent and `d` the dependency, so the symbols that
            // order them are the ones `d` creates and `t` consumes. Asking it
            // the other way round records the edge backwards.
            const syms = sharedSymbols(d, t), points = sharedPoints(t, d), files = overlap(t, d);
            if (!syms.length && !points.length) {
              // Sharing a file is not nothing, and saying "nothing shared"
              // about a pair that shares one reads as a mistake in the tool.
              // It is a merge to sequence, and they still run together.
              if (files.length) reconcile.push(`${t.key} ↔ ${d.key}  ${files.join('; ')}`);
              else skipped.push(`${t.key} ↮ ${d.key} — no symbol, no point`);
              continue;
            }
            (t.needs ||= []).push(d.key);
            added.push(`${t.key} needs ${d.key}  (${syms.length ? 'uses ' + syms.join(', ') : 'point ' + points.join('; ')})`);
          } else {
            (t.needs ||= []).push(d.key);
            added.push(`${t.key} needs ${d.key}`);
          }
          kept++;
        }
        // The ordering the plan asked for came out as nothing at all. Under the
        // cross-product this cannot happen; under --only-shared it can, and it
        // is the one outcome that must not pass quietly.
        if (onlyShared && !kept) vanished.push(`${rec.path} requires ${dep.path}, and no step of one uses a symbol a step of the ` +
          `other provides, nor do they share a serialisation point — so that ordering would be recorded nowhere.\n` +
          `    Put what the later steps import into their \`uses\`, and what the earlier ones export into their \`provides\`;\n` +
          `    a file they both write is not an ordering. Or link without --only-shared.`);
      }
    }
    for (const u of unknown) console.log('✗ ' + u);
    for (const v of vanished) console.log('✗ ' + v);
    for (const m of missing) console.log('· ' + m + ' — refine it, then run this again');
    if (onlyShared && skipped.length) {
      console.log(`· ${skipped.length} pair(s) left unlinked because nothing orders them:`);
      for (const x of skipped.slice(0, 20)) console.log('    ' + x);
      if (skipped.length > 20) console.log(`    … and ${skipped.length - 20} more`);
    }
    // Said plainly rather than left to look like an omission. These pairs write
    // a file in common and are deliberately NOT given an edge: they run in the
    // same round, in their own worktrees, and whichever lands second reconciles.
    if (onlyShared && reconcile.length) {
      console.log(`· ${reconcile.length} pair(s) write a file in common — they still run together, and`);
      console.log('  whichever lands second reconciles. A shared file is not an ordering:');
      for (const x of reconcile.slice(0, 15)) console.log('    ' + x);
      if (reconcile.length > 15) console.log(`    … and ${reconcile.length - 15} more`);
    }
    // Nothing is recorded when a requirement would vanish. Half a graph is
    // worse than none, because the half that landed is the harder half to see.
    if (vanished.length) die(`${vanished.length} requirement(s) would be recorded nowhere. Nothing was written.`, 1);
    // An unknown plan is a failure on every path out of here, not only the one
    // that goes on to commit — it used to exit 0 whenever there was also
    // nothing to add or `--dry-run` was passed, so a caller checking the exit
    // code alone never learned the ✗ line above had printed.
    if (!added.length) { ok('nothing to add — every plan already waits on what it says it comes after'); if (unknown.length) process.exit(1); return; }
    for (const a of added) console.log('  ' + a);
    // What those edges cost, in the only unit that matters here. The
    // cross-product is the safe default and it is also the one that turns a
    // round into a queue, and until this printed there was nothing to notice
    // that by: `check` shows a frontier either way.
    {
      const prof = waves(s).filter((w) => w.wave !== -1).map((w) => w.tasks.length);
      console.log(`\n  With these, the round runs in ${prof.length} wave(s): ${prof.join(' → ')}`);
      if (!onlyShared && prof.length > 2)
        console.log('  `step link --only-shared --dry-run` shows the same thing with only the edges\n' +
                    '  where two steps actually meet. It is usually far fewer, and far wider.');
    }
    if (dry) { console.log(`\n${added.length} link(s) — not recorded (--dry-run)`); if (unknown.length) process.exit(1); return; }
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
    const cut = severNeeds(s, gone);
    commit(s, 'step ' + argv[0], argv);
    ok(`${doomed.length} step(s) cancelled: ${doomed.map((t) => t.key).join(' ')}`);
    // "Dropped from the needs of" reads as bookkeeping. What actually happened
    // is that `check` was correctly holding these back on work that has not
    // landed — cancelling the prerequisite does not satisfy it, and a dependent
    // that opens now is opening on a hole its author never got to fill.
    if (cut.length) {
      console.log(`\n  ${cut.length} step(s) unblocked, but not because their dependency landed — it was`);
      console.log('  cancelled instead. Those edges are severed, not forgotten:');
      for (const c of cut) console.log(`    ${c.key.padEnd(12)} no longer needs ${c.lost.join(', ')}`);
      console.log('  Recording any of those keys again puts its edges back, so re-refining a');
      console.log('  cancelled plan does not leave a dependent opening on a hole. Until then');
      console.log('  `doctor` names them, and nothing else waits on that work.');
    }
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
  const wasCancelled = new Set(list.map((it) => it && it.key).filter((k) => k && depOf(s, k)?.status === 'cancelled'));
  const restored = [];
  for (const it of list) restored.push(...restoreSevered(s, it.key).map((k) => `${k} needs ${it.key} again`));
  for (const it of list) putStep(s, it);
  // What the board holds, not what the batch claimed. See `refine done`.
  const missing = list.map((it) => it.key).filter((k) => { const t = depOf(s, k); return !t || DEAD_STATUS.includes(t.status); });
  if (missing.length) die(`${missing.length} step(s) did not reach the board: ${missing.join(' ')}\n` +
    '  They were judged and written, and the register does not hold them as live work.\n' +
    '  Nothing was committed.', 1);
  commit(s, 'step add', argv);
  ok(`${list.length} step(s) recorded. ${tasks(s).filter((t) => t.status !== 'cancelled').length} live in the register.`);
  const revived = [...wasCancelled].filter((k) => depOf(s, k)?.status !== 'cancelled');
  if (revived.length) console.log(`  ${revived.length} of them were cancelled and are revived by this: ${revived.join(' ')}`);
  if (restored.length) {
    console.log(`  ${restored.length} dependency edge(s) that cancelling them took out are back:`);
    for (const r of restored) console.log('    ' + r);
  }
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
  // On a one-model runner a tier is an effort, and two tiers can be the same
  // effort. That collapse decides what these rows actually buy, so it is shown
  // here rather than left to be discovered in a launcher.
  const rn = runnerOf(s);
  const r = rn === 'cursor' ? null : runnerRow(rn);
  if (r) {
    // Tier to effort, whichever way this runner spells it: a ladder row per
    // tier, or one model and a map. Reading a ladder runner's `efforts` — an
    // array of the vocabulary it accepts — as if it were that map printed the
    // list's own indices as tiers ("0 → low   1 → medium"), which is a table
    // of nothing dressed as the one thing this paragraph exists to say.
    const byTier = r.ladder
      ? Object.fromEntries(r.ladder.map((x) => [x.tier, x.effort]))
      : (r.efforts || {});
    console.log(r.ladder
      ? `\nRunning on ${rn}: a tier picks the model and the effort together.`
      : `\nRunning on ${rn}: ${r.shown || r.model}, one model, so a tier is an effort.`);
    if (r.ladder) for (const x of r.ladder) console.log(`  ${x.tier.padEnd(10)} ${x.id}  ·  ${x.effort}`);
    const byEffort = {};
    for (const [t, e] of Object.entries(byTier)) (byEffort[e] ||= []).push(t);
    if (!r.ladder) console.log('  ' + Object.entries(byEffort).map(([e, ts]) => `${ts.join('/')} → ${e}`).join('   '));
    // Only a collapse WITHIN one model is a collapse: on a ladder runner two
    // tiers at the same effort on different models buy something after all.
    const same = r.ladder
      ? Object.entries(r.ladder.reduce((a, x) => ((a[x.id + ' · ' + x.effort] ||= []).push(x.tier), a), {}))
          .filter(([, ts]) => ts.length > 1).map(([what, ts]) => [ts, `the same model at the same effort (${what})`])
      : Object.entries(byEffort).filter(([, ts]) => ts.length > 1).map(([e, ts]) => [ts, `the same effort (${e})`]);
    for (const [ts, what] of same) console.log(`  ${andList(ts)} are ${what}, so moving between them changes nothing.`);
  }
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
    console.log('\nOpen all of them, in one command. Opening one at a time is the slowest thing');
    console.log(`this can do, and it is what happens when it takes ${f.accepted.length} commands to start a round:`);
    console.log(`  node ${SELF()} run open --all`);
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
  // The shape of the whole graph, not just its first row. A round that opens
  // one step at a time looks identical from here to a round that opens twelve —
  // both print a frontier — and the difference is the difference between a day
  // and a week. Nothing said it, so nothing was ever done about it: the profile
  // is what makes "this is a queue, not a round" visible while the register can
  // still be changed.
  const prof = waves(s).filter((w) => w.wave !== -1);
  if (prof.length > 1) {
    const live = tasks(s).filter((t) => !DEAD_STATUS.includes(t.status)).length;
    console.log(`\nThe shape of it: ${live} live step(s) in ${prof.length} wave(s) — ` +
      prof.map((w) => w.tasks.length).join(' → '));
    // Judged on the average width, not on the widest wave: an 18-step round
    // that opens 3 and then 2 at a time for eight more waves is a queue, and a
    // rule that looked only at its widest row would have called it a round.
    if (prof.length >= 4 && live / prof.length < 2.5) {
      console.log('  That is a queue, not a round. Before opening it, look at why:');
      console.log('    `step link` without --only-shared gives every step of a plan a need on every');
      console.log('    step of the plan it comes after — with two steps each that is four edges');
      console.log('    where one is real. `step link --only-shared --dry-run` shows the difference:');
      console.log('    it keeps only the edges where one step uses a symbol another provides, or');
      console.log('    the two move one serialisation point. A file they both write is not an edge.');
      console.log('    `doctor` names any serialisation point gating three or more steps, and any');
      console.log('    step that waits on four or more and frees nothing.');
      console.log('    If the round is a queue because every plan came back as ONE step, that is');
      console.log('    upstream of all of this: re-refine the plans whose parts write disjoint files.');
    }
  }
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
//
// It was 2, then 3, and the round trip is the argument for being back at 2.
// Raising it had a real case: a plan holding three disjoint file sets runs on
// three agents instead of one, and the third part was being refused for no
// reason but the number. What came with it was a brief that asked for one step
// per disjoint set — and disjoint file sets are the easy thing to find. Almost
// any plan names enough files to deal them into three piles, so almost every
// plan was dealt into three: eight plans came back as twenty-two steps, the
// ceiling read as a quota and applied to all of them rather than to the few
// that had a seam in them.
//
// So 2, and the brief below stops asking. Most plans are one step. A plan
// becomes two when it is really two pieces of work, not whenever its paths can
// be sorted into two piles.
//
// The failure both numbers guard is a plan carved into parts that all write the
// same files, which is more agents contending over one piece of work rather
// than more work in flight, and the taste for doing that grows with the room
// allowed for it.
const MAX_STEPS_PER_PLAN = 2;

// The floor under that ceiling. `refine done` has always enforced the most a
// plan may become and never once enforced the least. The test is stated in the
// refining brief in prose — a part must land before another can start, or parts
// write files that do not overlap at all — and nothing checked either half, so
// a refiner that cut every plan to the cap because the cap was permitted passed
// exactly as cleanly as one that found real seams. Nine plans came back as
// twenty-seven steps that way and the register took all of it without a word:
// twenty-seven worktrees, merges and runs for nine plans whose gates still
// passed or failed whole, which is the cost of the split with none of what it
// is bought for.
//
// So the ceiling stays a ceiling and stops being a target. One step is what a
// plan comes back as unless it has a real seam in it.
//
// Judged per part rather than per report, so the refusal can name which half
// did not earn its place and the file the two contend over, instead of
// rejecting the shape of the whole report without saying where it went wrong.
//
// A part earns its place by ordering OR by disjointness. Ordering is a `needs`
// edge in either direction between it and a sibling: the plan says this half
// cannot start until that half has landed, and then they were never going to
// run at once anyway. Disjointness is its files against every sibling's —
// nothing in common means the two CAN run at once on separate agents, which is
// the whole reason to split. Neither is several agents contending over one
// piece of work, slower than the one agent that would already have finished it.
//
// Note which way the file test runs here. Two steps of DIFFERENT plans owning
// one file is fine and is not a reason to make either wait — they build in
// separate worktrees and reconcile at the merge. Two parts of ONE plan owning
// one file is different: it is the evidence that the plan was never two parts.
function splitProblems(steps) {
  if (steps.length < 2) return [];
  const keyOf = (it) => String((it && it.key) || '');
  const out = [];
  for (const it of steps) {
    const me = keyOf(it);
    if (!me) continue;                      // `stepProblems` owns the keyless step
    const sibs = steps.filter((o) => keyOf(o) !== me);
    if (sibs.some((o) => (it.needs || []).includes(keyOf(o)) || (o.needs || []).includes(me)))
      continue;
    // Grouped by the file, not by the pair: the shape of the problem is one
    // file with claimants, not one entry per pairing. Under a two-step cap that
    // is a single other claimant and the grouping costs nothing to keep — it
    // was written when a plan could come back as three parts, and reporting it
    // pairwise printed the same path to each of them twice over.
    const shared = [];
    for (const a of it.owns || []) {
      if (typeof a !== 'string') continue;
      const others = sibs.filter((o) => (o.owns || []).some((b) => typeof b === 'string' && collides(a, b)));
      if (others.length) shared.push({ own: a, others: others.map(keyOf) });
    }
    if (shared.length) out.push({ key: me, shared });
  }
  return out;
}
const planSlug = (p) => String(p).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
const refineReport = (p) => sub('refine', planSlug(p) + '.json');
// Loaded plans other than this one that the working tree has changed. Only
// tracked, committed plans can be judged — an untracked plan has no committed
// text to differ from, and a repo that is not a repo cannot answer at all, so
// both cases come back empty rather than guessing.
function strayPlanEdits(s, mine) {
  let changed;
  // `git diff --name-only HEAD`, not `status --porcelain`: porcelain puts a
  // two-column status code in front of every path, and `sh` trims its output,
  // so the leading space of the first line's " M path" is eaten and every
  // fixed-offset slice of that one line is off by one. This form has no status
  // column to lose, and it already covers staged and unstaged alike.
  try { changed = new Set(shq('git', ['diff', '--name-only', 'HEAD', '--']).split('\n').filter(Boolean).map(norm)); }
  catch { return []; }   // no HEAD to diff against, or not a repo at all
  return (s.plans || []).map((p) => p.path).filter((p) => !samePlan(p, mine) && changed.has(norm(slashes(p))));
}

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

${rec.path} is the only file you may edit. Other plans are being refined at the
same time by other agents; a change you make to one of those is a change its own
agent will overwrite or contradict, and steps you key off text in it describe a
round that will not exist. A report is refused whole if the working tree shows
another plan changed.

Do two things:

1. Edit ${rec.path} in place. Replace every instruction that cannot be followed
   literally: a path that does not exist, a function that was renamed, a command
   that would not run, an order that is impossible. Leave the intent alone.

   The repository's own checks may grep your prose, not just its code. A plan
   that spells out a forbidden call verbatim has been read by a lint as the
   forbidden call itself. If you must write one, quote it and say it is
   forbidden in the same line.

2. Write your report to ${relCwd(out)} as JSON:

   {
     "summary": "what you changed and why, in a few sentences",
     "builtOn": [{"path": "src/x.ts", "what": "what is in it, written for whoever builds this"}],
     "openQuestions": ["anything you could not settle from the code"],
     "steps": [{
       "key": "${keyPrefix(rec.path)}.1",
       "title": "one line",
       "owns": ["every file this step may write, whole paths only"],
       "provides": ["symbols this step's work makes reachable from outside it"],
       "uses": ["symbols it consumes that some other step creates"],
       "serialises": ["shared invariants it moves: a lockfile, a migration head"],
       "needs": ["keys of steps that must land first"],
       "verify": ["the command that proves it worked"]
     }]
   }

   \`builtOn\` is not a note to the orchestrator. It is put in front of the agent
   that builds these steps, and besides the plan it is the whole of what that
   agent is told about this repository before it starts writing. Name what you
   actually read — the module it must call rather than reimplement, the helper it
   should extend, the test that shows the expected shape — and write the "what"
   for somebody arriving cold, not as a reminder to yourself. A bare path with no
   sentence beside it is worth almost nothing to them. Keep the paths
   repository-relative: it reads them from its own worktree, not from here.

   How many steps. One, unless this plan is genuinely two pieces of work — and
   most plans are not. ${rec.lines < 120
     ? `${rec.path} is ${rec.lines} lines, which is nearly always one step.`
     : `${rec.path} is ${rec.lines} lines, which is long, and length is not a
   seam: a long plan describing one coherent change is still one step.`}
   ${MAX_STEPS_PER_PLAN} is the most a plan may become, and a report with more is
   refused. It is the ceiling for the exception, not a shape to aim at.

   A second step has to earn its place, and it earns it only when BOTH hold:

     · the two halves are separable work — someone reading the plan would call
       them two things, not one thing described in two sections; and
     · either one half must land before the other can start, or their files do
       not overlap at all, so the two can run at once on separate agents.

   Only the second of those can be checked mechanically, which is why the first
   is the one to be honest about. Almost any plan names enough files to deal
   them into two piles that do not overlap, and dealing them is not a seam. If
   the halves look separate only because you sorted the paths, that is one step.

   What is checked: a part that writes a file another part of this plan also
   writes, and that neither waits on one of them nor is waited on by one of
   them, is refused — and the whole report goes back with it.

   When it is close, one step. A plan left whole is one agent finishing it; a
   plan split badly is two agents contending over one piece of work, each
   paying a worktree, a merge and a run, for a gate that still passes or fails
   whole.

   Key every step from this plan: ${keyPrefix(rec.path)}.1, ${keyPrefix(rec.path)}.2 — and the second only where there is a real second.
   Other plans in this round are being refined at the same time, and keys are
   unique across all of them: a report that reuses one another plan already
   holds is refused whole.

   \`needs\` names step keys, never plan ids. A key that is not a step in this
   round is refused.

   \`owns\` is the important one, and it comes out short far more often than it
   comes out long. Every file the step writes has to be on it or the work is
   refused after the fact, on a diff, by a check the agent doing it never saw.
   Walk it deliberately rather than copying the paths the plan happens to name:

     · the source files the plan names, and the tests for them;
     · anything your \`verify\` command WRITES — a snapshot it updates, a seed or
       fixture it regenerates, a coverage or build artefact it leaves behind;
     · the shared registry, barrel, index or manifest you have to add one line
       to for your own work to be reachable at all;
     · anything generated as a side effect of what you do: a migration file AND
       the journal or lock beside it, a generated client, a schema snapshot.

   The last three are the ones that get missed every time, because they are not
   in the plan — they are in the repository's own habits. Go and look.

   Two steps owning one file is fine and is not a reason to trim the list: they
   build in separate worktrees and reconcile at the merge. A list that is too
   narrow has no upside at all.

   \`serialises\` is the opposite: put as little on it as you can defend. It is
   a gate, not a note — every step naming a point runs alone against every other
   step naming it, so a point across five steps is five rounds instead of one.
   It is ONLY for something git merges cleanly and gets WRONG: a lockfile, a
   migration head, a closed list a test asserts on exactly. A file two steps
   both edit is not one of those — that is \`owns\`, and the merge sorts it out.
   If you cannot say what a clean merge of it would break, leave it off.

   When you do name one, use these exact words:

${vocabulary().map((v) => '     · ' + v).join('\n')}

   Invent a name only for something genuinely not on it, and then spell it the
   way the plan spells it. Two steps moving one shared thing are only held apart
   when they call it the same name. Where two steps move genuinely separate
   instances of one kind of thing — a migration directory per package, a
   lockfile per workspace — scope the name: "migration head: orders". Those run
   at the same time; two bare names do not.

   \`provides\` and \`uses\` are what decide build order, and they are the only
   fields that can say it. \`provides\` is what your step makes reachable from
   outside itself — an exported type or function, a table, a config key, the
   handler behind a route. \`uses\` is what it consumes that it does not create.

   Both are IDENTIFIERS: the thing you would type in an import. Not prose, and
   not the file it lives in — "ExamAttempt", never "the exam attempt type" and
   never "src/exam.ts". Both of those are refused, because both look filled in
   and match nothing. Name a route by its handler or its route constant, not by
   its URL, for the same reason. Case matters and both sides have to agree, so
   copy the identifier rather than retyping it from memory.

   This is what catches the dependency nothing else here can see. Two steps that
   share no file and no point still have an order when one imports what the
   other exports — and with these fields empty, that order is recorded nowhere
   and the later step opens against code that does not exist yet. A shared file
   does NOT do this job: two steps writing one file run together and reconcile
   at the merge, deliberately.

   If your step depends on work in a plan this one comes after, put the symbol
   in \`uses\` even when you cannot see which step of that plan will provide it.
   The match is made later, across every step in the round.

Report the file written, not a summary in your reply.`);
    return;
  }
  if (what === 'done') {
    if (!plan) die('refine done <plan>');
    const rec = findPlan(s, plan) || die(`"${plan}" is not a loaded plan`);
    const f = refineReport(rec.path);
    if (!fs.existsSync(f)) die(`no report at ${relCwd(f)} — the agent did not write one.\n  Its own reply is not a substitute: that route goes through a context that gets compacted.`);
    let rep; try { rep = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { die(`the report at ${f} is not valid JSON: ${e.message}`); }
    const steps = rep.steps || [];
    if (!steps.length) die('the report names no steps');
    // A plan is one step, and two only where the parts genuinely come apart.
    // The ceiling is checked first because it is the cheaper answer to read:
    // too many is too many whatever the reasons given for them.
    if (steps.length > MAX_STEPS_PER_PLAN) die(`the report splits ${rec.path} into ${steps.length} steps; ${MAX_STEPS_PER_PLAN} is the most a plan may become.
  Most plans are one step, and the ceiling is for the ones that are really two.
  Have the agent merge them and rewrite ${relCwd(f)}.`);
    // Then whether the split it did make was worth making. See `splitProblems`.
    const unearned = splitProblems(steps);
    if (unearned.length) {
      console.error(`✗ the report splits ${rec.path} into ${steps.length} steps, and ${unearned.length} of them ${unearned.length === 1 ? 'has' : 'have'} not earned it:`);
      for (const u of unearned) {
        const line = (x) => `${x.own}, which ${andList(x.others)} also write${x.others.length > 1 ? '' : 's'}`;
        console.error(`    ${u.key} writes ${line(u.shared[0])}`);
        for (const x of u.shared.slice(1)) console.error(`    ${' '.repeat(u.key.length)}    and ${line(x)}`);
      }
      console.error('\n  Two parts of one plan are worth separating when one must land before the other');
      console.error('  can start, or when their files do not overlap at all and they can therefore run');
      console.error('  at the same time on separate agents. These do neither: they write the same');
      console.error('  files and wait on nothing, so they are one piece of work handed to two');
      console.error('  agents to contend over — a merge, a run and a handover apiece, and slower than');
      console.error('  the single agent that would already have finished it.');
      console.error(`\n  Most plans are one step. ${MAX_STEPS_PER_PLAN} is the ceiling for the ones that are really two, not a number to fill.`);
      console.error('  Merge them back into one step; or, if they truly are separate work, give each');
      console.error('  its own files, or say in `needs` which of them has to land first.');
      console.error(`\nNothing from ${rec.path} was recorded. Have the agent rewrite ${relCwd(f)} and run this again.`);
      process.exit(1);
    }
    // A refining agent is told to edit one plan. Nothing checked that it did.
    // One rewrote nine of them in a single run and keyed steps off text that
    // was then reverted, so the register described plans that no longer said
    // any of it — and `refine done` had already printed a tick for each.
    // The other plans' diffs are the evidence, and they are read here, while
    // the report can still be refused whole.
    if (!argv.includes('--allow-plan-edits')) {
      const touched = strayPlanEdits(s, rec.path);
      if (touched.length) {
        console.error(`✗ refining ${rec.path} also changed ${touched.length} plan(s) it was not given:`);
        for (const p of touched) console.error('    ' + p);
        console.error('\n  A refining agent edits its own plan and nothing else. Steps keyed off text');
        console.error('  in somebody else\'s plan describe a round that will not exist once that plan');
        console.error('  is refined by the agent it belongs to.');
        console.error('\n  Look at what it did, then either revert those plans:');
        console.error('    git checkout -- ' + touched.join(' '));
        console.error(`  or, if the edits are right and you mean to keep them, say so:\n    node ${SELF()} refine done ${plan} --allow-plan-edits`);
        console.error(`\nNothing from ${rec.path} was recorded.`);
        process.exit(1);
      }
    }
    // Keys belong to the plan they came out of. `stepProblems` catches a key
    // another plan already holds; this catches the one it cannot see — a key
    // claiming the namespace of a plan whose own steps have not been recorded
    // yet, which is how a report registers work under a plan it was never
    // given.
    const mine = keyPrefix(rec.path);
    const poached = [];
    for (const it of steps) {
      const k = String(it && it.key || '');
      for (const other of s.plans || []) {
        if (samePlan(other.path, rec.path)) continue;
        const pre = keyPrefix(other.path);
        if (pre !== mine && (k === pre || k.startsWith(pre + '.'))) poached.push([k, other.path, pre]);
      }
    }
    if (poached.length) {
      console.error(`✗ the report keys ${poached.length} step(s) into another plan's numbering:`);
      for (const [k, p, pre] of poached) console.error(`    "${k}" is ${pre}…, which belongs to ${p}`);
      console.error(`\n  Every step of ${rec.path} is keyed ${mine}.1, ${mine}.2. Have the agent`);
      console.error(`  rewrite ${relCwd(f)}. Nothing was recorded.`);
      process.exit(1);
    }
    // Every step goes through the same gate as a hand-written one. The old
    // driver merged refined steps in raw, which put a hole in the one invariant
    // that matters on the path that creates almost every step. It is judged
    // entire and written entire: a report half-recorded and half-refused is a
    // register nobody planned, and the half that landed is the harder half to
    // see.
    // `builtOn` is the reading the refining agent did, and until now it reached
    // the report and went no further. It is recorded on every step of this plan
    // as `context`, which the brief prints. A step that named its own keeps it,
    // and a report carrying none leaves whatever a step already had alone rather
    // than blanking it — a second `refine done` must not empty a brief.
    const builtOn = Array.isArray(rep.builtOn) ? rep.builtOn : [];
    const ctxBad = contextProblems(rep.builtOn, 'builtOn');
    if (ctxBad.length) {
      console.error('✗ the report\'s "builtOn" cannot be recorded as written:');
      for (const x of ctxBad) console.error('    ' + x);
      console.error('\n  It is what the agent building these steps is told already exists, and it reads');
      console.error('  those paths from its own worktree. A path it cannot open is worse than none.');
      console.error(`\nNothing from ${rec.path} was recorded. Have the agent fix ${relCwd(f)} and run this again.`);
      process.exit(1);
    }
    const stamped = steps.map((it) => {
      const c = (it.context || []).length ? it.context : builtOn;
      return c.length ? { ...it, plan: rec.path, context: c } : { ...it, plan: rec.path };
    });
    const bad = vetBatch(s, stamped);
    if (bad.length) {
      console.error('✗ the report has steps that cannot be recorded as written:');
      for (const [k, ps] of bad) { console.error(`  ${k}:`); for (const x of ps) console.error('    ' + x); }
      console.error(`\nNothing from ${rec.path} was recorded. Have the agent fix ${relCwd(f)} and run this again.`);
      process.exit(1);
    }
    const restored = [];
    for (const it of stamped) restored.push(...restoreSevered(s, it.key).map((k) => `${k} needs ${it.key} again`));
    for (const it of stamped) putStep(s, it);
    rec.refined = new Date().toISOString();
    rec.openQuestions = rep.openQuestions || [];
    // A tick is a claim about the board, so it is read off the board. `refine
    // done` used to print "✓ 1 step(s) recorded" from the report it had just
    // read, which is true of the report whatever happened to the register: a
    // key that came back still cancelled was announced as recorded three times
    // running while the total beside it — the one number that would have said
    // otherwise — sat unchanged at 18.
    const missing = stamped.map((it) => it.key).filter((k) => {
      const t = depOf(s, k);
      return !t || DEAD_STATUS.includes(t.status);
    });
    if (missing.length) die(`${missing.length} step(s) from ${rec.path} did not reach the board: ${missing.join(' ')}\n` +
      '  They were judged and written, and the register does not hold them as live work.\n' +
      '  This is a fault in the tool, not in the report — nothing was committed. Say so with `events`.', 1);
    commit(s, 'refine done', argv);
    // The count that would have caught three plans overwriting each other is
    // the register's, not the report's. The report's number was always right.
    ok(`${steps.length} step(s) from ${rec.path}: ${steps.map((t) => t.key).join(' ')}  (${tasks(s).filter((t) => t.status !== 'cancelled').length} in the register)`);
    if (restored.length) {
      console.log(`\n  ${restored.length} dependency edge(s) that cancelling these took out are back:`);
      for (const r of restored) console.log('    ' + r);
    }
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

// How the launcher says the run ended, which is the one thing the log cannot
// say about itself. Both launchers write the same four tab-separated fields on
// every exit path, including the ones that die early:
//
//     exit 1<TAB>timeout<TAB>S-022.1<TAB>.claude/orch/logs/S-022.1.jsonl
//
// A backgrounded, detached run comes back as exit -1 whatever it did, so this
// file is the only place the process's own ending survives.
const statusFile = (key) => path.join(ORCH, 'runs', String(key) + '.status');
function runStatus(key) {
  const file = statusFile(key);
  if (!fs.existsSync(file)) return null;
  const line = String(fs.readFileSync(file, 'utf8')).split('\n').filter(Boolean).pop() || '';
  const [ex, outcome, k, log] = line.split('\t');
  if (!outcome) return null;
  return { file, exit: String(ex || '').replace(/^exit\s*/, '').trim(), outcome: outcome.trim(), key: k, log };
}
// What the branch actually holds, asked of git rather than of the run's own
// account of itself. Three separate facts, because they fail separately: a run
// that committed nothing, a run that left work uncommitted, and the subjects of
// whatever it did commit.
function branchWork(t) {
  if (!t.branch) return { error: `${t.key} has no branch — it was never opened` };
  const base = guessBase();
  try { shq('git', ['rev-parse', '--verify', t.branch]); }
  catch { return { error: `${t.branch} does not exist — nothing was opened, or it was removed` }; }
  let subjects = [];
  try { subjects = shq('git', ['log', '--format=%s', `${base}..${t.branch}`]).split('\n').filter(Boolean); }
  catch { return { error: `could not read ${base}..${t.branch}` }; }
  let dirty = [];
  if (t.worktree && fs.existsSync(t.worktree)) {
    // Tracked changes only, and never this tool's own state directory: an
    // untracked build directory is not an unfinished run.
    try {
      dirty = shq('git', ['-C', t.worktree, 'status', '--porcelain', '--', ':!.claude'])
        .split('\n').filter((l) => l.trim() && !l.startsWith('??'));
    } catch { /* a worktree git cannot read is reported by the branch checks above */ }
  }
  return { commits: subjects.length, subjects, dirty, base };
}

// Everything opening a step actually does: cut its worktree, mint its address,
// write its brief, mark it out. Lifted out of `run open` so that opening one
// step and opening the whole round are the same code — the round path used not
// to exist, and one call per step is how a round that could run wide ran narrow.
// Nothing here commits: the caller does, once, whether it opened one or nine.
function openOne(s, t) {
  const key = t.key;
  const row = tierOf(t.tier);
  t.branch = t.branch || `step/${key}`;
  // Beside the project, named after it. A bare `wt-<key>` in the parent
  // directory collides with every other project doing the same thing, and the
  // second one to try inherits a worktree pointing at somebody else's repo.
  const wtRoot = process.env.CURSOR_ORCH_WT || path.resolve(CWD, '..');
  t.worktree = t.worktree || path.join(wtRoot, `${path.basename(CWD)}-wt-${key}`);
  let justCreated = false;
  if (!fs.existsSync(t.worktree)) {
    try { sh('git', ['worktree', 'add', t.worktree, '-b', t.branch]); justCreated = true; }
    catch (e) { return { error: `could not make a worktree at ${t.worktree}\n  ${String(e.stderr || e.message).trim()}` }; }
  } else {
    // Something is already there. If git does not know about it, it is not a
    // worktree of this repo and opening onto it would write into a stranger.
    // `git worktree list` always prints forward slashes; `t.worktree` was
    // built with `path.join`, which on Windows prints backslashes — so this
    // could never match there, and re-opening a step after any interruption
    // died on the "not a worktree of this repo" branch every time.
    const known = (() => { try { return slashes(shq('git', ['worktree', 'list'])).toLowerCase().includes(slashes(t.worktree).toLowerCase()); } catch { return false; } })();
    if (!known) return { error: `${t.worktree} already exists and is not a worktree of this repo.\n` +
      `  Move it, or if it is stale: git worktree remove ${t.worktree}` };
  }
  // Cursor needs an address before it has a conversation, so one is minted
  // here. opencode puts `sessionID` on every event, so the address does not
  // exist until the run does and is read out of the log afterwards — minting
  // one would be inventing an id nothing will answer to.
  t.runner = runnerOf(s);
  // Claude Code takes a session id to claim (`--session-id`, confirmed against
  // the binary), so its address can be minted here the way Cursor's is — which
  // is what makes the launcher's automatic resume-after-a-cut-off available to
  // it. It needs no subprocess to mint one, only a uuid.
  if (t.runner === 'claude' && !t.chat) t.chat = crypto.randomUUID();
  if (t.runner === 'cursor' && !t.chat) {
    // Unlike the worktree add above, this used to have no try/catch at all: a
    // missing `agent` binary threw a raw stack trace straight past `commit()`,
    // leaving a branch and a worktree on disk with nothing in the record to say
    // so — `doctor` never mentions either. If this call made the worktree
    // itself, undo that; if the worktree already existed (a retry), leave it
    // and just say how to pick it up.
    try { t.chat = sh('bash', [path.join(HERE, 'scripts', 'cursor-chat.sh')]); }
    catch (e) {
      const msg = String(e.stderr || e.message).trim();
      if (justCreated) {
        try { execFileSync('git', ['worktree', 'remove', '--force', t.worktree], { stdio: 'ignore' }); } catch { /* best effort */ }
        try { execFileSync('git', ['branch', '-D', t.branch], { stdio: 'ignore' }); } catch { /* best effort */ }
        return { error: `could not start a chat for ${key}: ${msg}\n  The worktree and branch this call made were removed. Nothing was recorded.` };
      }
      return { error: `could not start a chat for ${key}: ${msg}\n` +
        `  Its worktree at ${t.worktree} is still there — fix the runner and \`run open ${key}\` again,\n` +
        `  or remove it by hand: git worktree remove ${t.worktree}` };
    }
  }
  const brief = sub('briefs', key + '.md');
  fs.writeFileSync(brief, briefText(s, t, row));
  t.briefFile = relCwd(brief);
  // What the brief was written from. A step whose owns or verify changed
  // afterwards is holding an agent to instructions nobody has revised.
  t.briefSha = briefKey(t);
  t.status = 'open'; t.openedAt = new Date().toISOString();
  const launcher = shortest(path.join(HERE, 'scripts', 'run.sh'));
  return { launch: `  bash ${launcher} \\\n` +
    `    --runner ${t.runner} --role chip --tier ${t.tier} --key ${key} --workspace ${t.worktree} \\\n` +
    (t.chat ? `    --chat ${t.chat} ` : '    ') + `--prompt-file ${t.briefFile}` };
}

CMDS.run = (argv) => {
  const [what, key] = argv;
  const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  const s = readState();

  // Opening the whole round in one command, because opening it one step at a
  // time is what actually happened. Every other part of this tool says to open
  // the full set — `check` prints it, `run open` counts what was left behind —
  // and then the only way to act on that was N invocations, each one a round
  // trip, each one printing its own launcher line to be collected by hand. The
  // set that can go is computed here already: `frontier().accepted` is exactly
  // it, and it is checked against itself as well as against open work, which is
  // what makes opening all of it at once safe.
  if (what === 'open' && (key === '--all' || argv.includes('--all'))) {
    if (key && key !== '--all')
      die(`run open --all opens everything that can go; naming ${key} as well says two different things.\n  Drop one of them.`);
    const f = frontier(s);
    if (!f.accepted.length) {
      console.log('Nothing new can open right now.');
      if (f.blocked.length) {
        console.log(`\n${f.blocked.length} step(s) are held by a serialisation point open work is moving:`);
        for (const { t, why } of f.blocked) for (const { o, i } of why) console.log(`  ${t.key} ↔ ${o.key}: ${i.points.join('; ')}`);
      }
      if (f.waiting.length) console.log('\nWaiting on work to reach the main line: ' + f.waiting.map((t) => t.key).join(' '));
      if (!f.blocked.length && !f.waiting.length && !f.open.length)
        console.log('  Nothing is planned, open or waiting — this round is done.');
      // Non-zero for "opened nothing", which is what a caller in a loop needs
      // to know. The lines above say whether that is a round finished or a
      // round held.
      process.exit(1);
    }
    const noModel = f.accepted.filter((t) => !t.tier);
    if (noModel.length) die(`${noModel.length} of them have no model yet: ${noModel.map((t) => t.key).join(' ')}\n  Run \`assess\` first — opening half a round is not opening it.`);
    const lines = [];
    for (const t of f.accepted) {
      const r = openOne(s, t);
      if (r.error) {
        // Whatever opened before this did make a worktree and a branch, and
        // those outlive the process. Recording them first is what keeps the
        // register and the disk in step — dying with them unrecorded would
        // leave `doctor` unable to mention either.
        if (lines.length) commit(s, 'run open --all (partial)', argv);
        die(`${t.key} could not open: ${r.error}\n` +
          (lines.length
            ? `  ${lines.length} step(s) opened before it and ARE recorded: ${f.accepted.slice(0, lines.length).map((x) => x.key).join(' ')}\n` +
              '  Launch those, fix this, and run `run open --all` again for the rest.'
            : '  Nothing was opened.'));
      }
      lines.push(r.launch);
    }
    commit(s, 'run open --all', argv);
    ok(`${f.accepted.length} step(s) open: ${f.accepted.map((t) => t.key).join(' ')}`);
    const outFile = sub('launch', new Date().toISOString().replace(/[:.]/g, '-') + '.txt');
    fs.writeFileSync(outFile, lines.join('\n\n') + '\n');
    console.log(`\nLaunch every one of them NOW, as its own backgrounded call, all in one`);
    console.log(`message. Not a loop that waits on each in turn — that is the same round`);
    console.log(`run end to end, and it is the single most expensive thing to get wrong here.`);
    console.log(`\nAlso written to ${relCwd(outFile)}:\n`);
    for (const l of lines) console.log(l + '\n');
    // One more backgrounded call, in the same message. Nothing else can wake
    // this session while the round is out: a wedged run never exits, and an
    // agent that decided the suite was already red says so in its log and keeps
    // going. This is the only thing that carries either of those back.
    console.log('And one more beside them, backgrounded too. It sleeps 15 minutes, looks at');
    console.log('every open run, and exits — and that exit is what wakes you if one has gone');
    console.log('quiet or has said it is stuck. Launch another each time it comes back:\n');
    console.log(`  node ${SELF()} vitals --wait\n`);
    if (f.merges.length) {
      console.log(`${f.merges.length} pair(s) of them share files — they still run together, and`);
      console.log('whichever lands second reconciles:');
      for (const m of f.merges) console.log('  ' + m.a.padEnd(10) + '↔ ' + m.b + '  ' + m.files.join('; '));
    }
    if (f.blocked.length) {
      console.log(`\n${f.blocked.length} step(s) stayed back on a serialisation point this round is moving:`);
      for (const { t, why } of f.blocked) for (const { o, i } of why) console.log(`  ${t.key} ↔ ${o.key}: ${i.points.join('; ')}`);
      console.log('  They open as soon as the step holding the point lands.');
    }
    return;
  }

  if (what === 'open') {
    const t = getTask(s, key);
    // A step whose `owns` or `verify` changed after it went out is holding an
    // agent to instructions nobody revised — `doctor` says so, and this is how
    // it is answered without cancelling the run.
    if (argv.includes('--rebrief')) {
      if (!OPEN_STATUSES.includes(t.status)) die(`${key} is ${t.status} — there is no agent holding a brief to replace`);
      const bf = sub('briefs', key + '.md');
      fs.writeFileSync(bf, briefText(s, t, tierOf(t.tier)));
      t.briefFile = relCwd(bf);
      t.briefSha = briefKey(t);
      commit(s, 'run open --rebrief', argv);
      ok(`${key}'s brief rewritten at ${t.briefFile}`);
      console.log('  It is a file on disk, not something the running agent re-reads. Send it:');
      console.log(`    node ${SELF()} sendback ${key} --why "Your brief changed. Re-read ${t.briefFile} before going further."`);
      return;
    }
    if (t.status !== 'planned') die(`${key} is already ${t.status}`);
    if (!t.tier) die(`${key} has no model yet — run \`assess\` first`);
    const held = heldNeeds(s, t);
    if (held.length) die(`${key} needs ${held.join(', ')} on the main line first`);
    // Edges `step rm` took out of this step's needs and nothing put back. The
    // dependency was cancelled rather than landed, so nothing waited for it —
    // which is right when that work is genuinely gone, and is a hole when it
    // came back under another key.
    const cutOff = (t.severed || []).map((x) => ({ ...x, dep: depOf(s, x.key) }));
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
    const r = openOne(s, t);
    if (r.error) die(r.error);
    commit(s, 'run open', argv);
    const rm = runnerModel(s, t.tier);
    ok(`${key} is open on ${rm.detail}`);
    if (!rm.verifiable) {
      console.log('  Its log will not name the model that answered, so the record says what was');
      console.log('  asked for and is marked unverified.');
    }
    if (cutOff.length) {
      const alive = cutOff.filter((x) => x.dep && !DEAD_STATUS.includes(x.dep.status));
      console.log(`  ⚠ it once needed ${cutOff.map((x) => x.key).join(', ')}, and cancelling those cut the edge.`);
      console.log(`     Nothing waited for that work, because nothing landed it. If any of it came`);
      console.log(`     back under a different key, this step is opening on a hole.`);
      if (alive.length) console.log(`     ${alive.map((x) => x.key).join(', ')} is live again and still not needed here — that is the case to look at.`);
    }
    if (unproven.length) {
      console.log(`  built on ${unproven.join(', ')} — merged, not yet proven. Its worktree is`);
      console.log(`  cut from that merge, so if the suite goes red there the fix lands as a`);
      console.log(`  forward commit; a reset would strand this worktree.`);
    }
    if (willReconcile.length) {
      console.log(`  shares files with open work — whichever lands second reconciles:`);
      for (const { o, m } of willReconcile) console.log(`    ↔ ${o.key}: ${m.files.join('; ')}`);
    }
    console.log(`  worktree  ${t.worktree}\n  branch    ${t.branch}` +
      (t.chat ? `\n  chat      ${t.chat}` : `\n  session   (${t.runner} mints one; it is read back out of the log)`) +
      `\n  brief     ${t.briefFile}`);
    console.log(`\nLaunch it in the background:\n${r.launch}`);
    // Opening one at a time is the slowest thing this can do, and it is easy to
    // do by accident — one `run open` reads like progress. So the ones still
    // waiting are counted here rather than left for somebody to run `check`.
    const more = frontier(readState()).accepted;
    if (more.length) {
      console.log(`\n⚠ ${more.length} more step(s) can open right now and are not: ${more.map((x) => x.key).join(' ')}`);
      console.log('  Open them in this same round. A shared serialisation point is the only');
      console.log('  reason to hold one back, and none of these shares one with open work.');
      console.log(`  All of them at once, in one command:  node ${SELF()} run open --all`);
    }
    return;
  }

  if (what === 'record') {
    const t = getTask(s, key);
    const log = flag('--log') || flag('--json');
    if (!log) die('run record <key> --log <run.jsonl>   (or --json <record.json> for a Claude Code step)');
    if (!fs.existsSync(log)) die(`no file at ${log}`);
    let rec;
    if (flag('--json')) {
      try { rec = JSON.parse(fs.readFileSync(log, 'utf8')); }
      catch (e) { die(`${log} is not valid JSON: ${e.message}`); }
    }
    else {
      // Harvest rather than ask: what the run did is in the log, and asking the
      // agent to summarise it is how 36 MB became five lines of prose.
      //
      // Which harvester depends on which runner wrote the log — the two formats
      // share nothing. The step records its runner when it opens, so an old
      // record with no runner is Cursor's, which is what it was.
      const which = t.runner || 'cursor';
      const args = which === 'opencode'
        ? [path.join(HERE, 'scripts', 'harvest-opencode.mjs'), log,
           // Paths in an opencode log are absolute and belong to the worktree,
           // so `guard` gets repo-relative ones only if the root is passed.
           '--root', t.worktree || CWD,
           '--model', runnerModel(s, t.tier).model, '--effort', runnerModel(s, t.tier).effort || '']
        : [path.join(HERE, 'scripts', 'harvest.mjs'), log];
      try { rec = JSON.parse(execFileSync('node', args, { encoding: 'utf8', maxBuffer: 1 << 28 })); }
      catch (e) { rec = e.stdout ? JSON.parse(e.stdout) : die('could not harvest ' + log); }
    }
    // opencode's address does not exist until the run does, so this is where it
    // is learned. `chat` is the one address field for either runner, which is
    // what lets `sendback` resume without knowing which one it is talking to.
    if (rec.session && !t.chat) t.chat = rec.session;
    // The log is one witness and it is the credulous one. A run the launcher
    // had to kill at its wall-clock limit still holds every event it managed to
    // emit, and a `step_finish` among them reads as a finished run — which is
    // how a step stopped mid-gate with everything uncommitted was recorded
    // `passed, 19m, 6 files changed` while its own status file said `exit 1
    // timeout` and its branch held nothing at all.
    //
    // So the record is the worst of what three independent witnesses say: the
    // log, the launcher's status line, and the branch. Anything less than all
    // three agreeing is not a pass.
    const doubts = [];
    const st = runStatus(key);
    if (st && st.outcome !== 'passed') doubts.push({ outcome: st.outcome,
      why: `the launcher recorded "${st.outcome}" (exit ${st.exit}) in ${relCwd(st.file)}` });
    else if (st && st.exit && st.exit !== '0') doubts.push({ outcome: 'failed',
      why: `the launcher recorded exit ${st.exit} in ${relCwd(st.file)}` });
    else if (!st && !flag('--json')) doubts.push({ outcome: null,
      why: `no status file at ${relCwd(statusFile(key))} — this run was not started through the launcher, so how the process ended is not recorded anywhere` });
    // What the branch has. A run that finished and did not commit did not
    // finish: `join` would merge nothing, `guard` would pass on an empty diff,
    // and the step would land as done having produced no work.
    const w = branchWork(t);
    if (w.error) doubts.push({ outcome: null, why: w.error });
    else {
      if (!w.commits) doubts.push({ outcome: 'no-commit',
        why: `${t.branch} has no commit on it — whatever the run did is not on the branch` });
      if (w.dirty.length) doubts.push({ outcome: 'uncommitted',
        why: `${w.dirty.length} uncommitted path(s) left in ${t.worktree} — the run stopped before it committed` });
    }
    const worse = doubts.map((d) => d.outcome).filter(Boolean);
    const outcome = rec.outcome === 'passed' && worse.length ? worse[0] : rec.outcome;
    rec.outcome = outcome;
    if (doubts.length) rec.doubts = doubts.map((d) => d.why);
    t.runs ||= [];
    const n = t.runs.length + 1;
    const out = sub('runs', key, n + '.json');
    fs.writeFileSync(out, JSON.stringify(rec, null, 2) + '\n');
    t.runs.push({ n, at: new Date().toISOString(), outcome, seconds: rec.seconds,
      files: (rec.files || []).length, model: rec.model, record: relCwd(out) });
    t.status = outcome === 'passed' ? 'reported' : t.status;
    // A run that died is a fact about the run, recorded where it can be seen —
    // not something for somebody to notice in a log tail and type in later.
    if (outcome !== 'passed') {
      (s.notes ||= []).push({ at: new Date().toISOString(), key, kind: outcome,
        text: rec.trouble?.tail || doubts.map((d) => d.why).join('; ') || `run ${n} ended ${outcome}` });
    }
    commit(s, 'run record', argv);
    const say = outcome === 'passed' ? ok : (m) => console.log('✗ ' + m);
    say(`${key} run ${n}: ${outcome}, ${Math.round((rec.seconds || 0) / 60)}m, ${(rec.files || []).length} file(s) changed`);
    if (worse.length) console.log(`  Its log says "passed". It is recorded as "${outcome}" because:`);
    else if (doubts.length) console.log('  Worth knowing about this run:');
    for (const d of doubts) console.log('    · ' + d.why);
    if (worse.length) {
      console.log(`  ${key} stays ${t.status}. Resume the agent that was doing it rather than`);
      console.log(`  starting again — its worktree still holds the work:`);
      console.log(`    node ${SELF()} sendback ${key} --why "<what to finish>"`);
    }
    // A commit named for what the orchestrator does with a branch, rather than
    // for what the branch did. Agents read `git log`, and the merge commits this
    // tool writes are the loudest thing in it — so the idiom gets copied back
    // into their own commits, where it says nothing about the change.
    // Anchored to the whole subject, not just its first word. `Merge branch
    // 'main' into step/S-1` is the reconciliation `sendback --why conflict`
    // asks for and is exactly right; what is wrong is a subject that is only a
    // bookkeeping verb and a key, describing nothing.
    const idiom = (w.subjects || []).filter((x) =>
      new RegExp('^(land|join|merge)\\s+(step\\s+)?' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s.:;,—–-]*$', 'i').test(x.trim()));
    if (idiom.length) {
      console.log(`\n⚠ ${idiom.length} commit(s) on ${t.branch} are named for the merge, not for the change:`);
      for (const x of idiom.slice(0, 6)) console.log('    ' + x);
      console.log('    "land <key>" is this tool\'s own merge message. Amend before joining:');
      console.log(`      git -C ${t.worktree} commit --amend -m "<what the change does>"`);
    }
    // Files it wrote that it does not own. The log knows this; no second diff.
    const stray = (rec.files || []).map((f) => f.path)
      .filter((p) => p !== BUGFILE(key) && !(t.owns || []).some((o) => collides(o, p)));
    if (stray.length) {
      console.log(`\n⚠ ${stray.length} file(s) written that ${key} does not own:`);
      for (const p of stray.slice(0, 12)) console.log('    ' + p);
      console.log(`  If the step really has to write them — a registry it adds a line to, the`);
      console.log(`  journal its own migration writes, a fixture its proof command regenerates —`);
      console.log(`  widen it rather than sending correct work back:`);
      console.log(`    node ${SELF()} step own ${key} ${stray.slice(0, 12).join(' ')}`);
    }
    // Recorded either way — the record is the point — but the exit code says
    // what was recorded. A caller that reads only the code used to be told a
    // timed-out run had gone in fine.
    if (outcome !== 'passed') process.exit(1);
    return;
  }
  die('run open <key> | run record <key> --log <file>');
};

// What the brief was written from. Three places computed this list separately —
// the two that write a brief and `doctor`, which decides whether the one in an
// agent's hands is still the current one — so a field added to the brief had to
// be added in three, and adding it in two makes every brief read as stale. One
// list, asked by all of them.
const briefKey = (t) => sha(JSON.stringify([t.owns, t.serialises, t.verify, t.needs, t.title, t.plan, t.context]));

// Where a step writes down a problem it did not deal with. One file per step
// rather than one shared file every step appends to: a shared one would be a
// path every agent in the round writes, which is the one thing this whole
// arrangement is built to avoid. It is owned implicitly — `guard` and
// `run record` both skip it — so writing there is never a stray, and a step
// never has to choose between reporting a problem and passing its guard.
const BUGFILE = (key) => `docs/temp_bugs/${key}.md`;

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
  // The plan this project is built from is explicit that this must not be left
  // unsaid: launching unattended (`--force --trust` on Cursor, `--auto` on
  // opencode) auto-approves every permission that is not explicitly denied,
  // which is the right setting for a worktree nothing else depends on and the
  // wrong one to leave undocumented. A brief that never named the runner, the
  // model or the effort it ran on left an agent unable to tell a person either.
  const rm = runnerModel(s, t.tier);
  L.push(`## How you are running`, '',
         `Runner: ${t.runner}. Model: ${rm.model}${rm.effort ? ` (effort: ${rm.effort})` : ''}.`,
         `This worktree was launched unattended, with every permission it is not`,
         `explicitly denied auto-approved — there is no prompt to answer and no one`,
         `watching for one. That is deliberate here, scoped to this worktree; do not`,
         `take it as licence to touch anything outside it.`, '');
  L.push(`## The plan`, '', `Read ${plan} in full before writing anything.`, '');
  if ((t.needs || []).length) L.push(`## Landed before you`, '', `These landed before you: ${t.needs.join(', ')}. Their work is in your`, `worktree already.`, '');
  // What the refining agent read, handed on. It was being thrown away: the
  // refine report asks for `builtOn` — a path and what is in it — and that field
  // appeared exactly once in the whole tool, in the template asking for it.
  // Nothing recorded it and nothing printed it, so every step went out knowing
  // its plan and its own file list and nothing else about the repository it was
  // building into. That is a building agent re-deriving the map its own refining
  // agent had drawn an hour earlier, and it is how a second copy of a helper
  // three directories away gets written.
  //
  // When there is none, say so. A section that simply vanishes reads as "there
  // is nothing already there", which is never true and is the more expensive of
  // the two mistakes.
  L.push(`## What is already there`, '');
  const ctx = (t.context || [])
    .map((c) => (typeof c === 'string' ? { path: c } : c || {}))
    .filter((c) => c.path);
  if (ctx.length) {
    L.push(`Read these before you write anything that overlaps them, and build on them`,
           `rather than writing your own:`, '');
    for (const c of ctx) {
      const mine = (t.owns || []).some((o) => collides(o, c.path));
      L.push(`  - ${c.path}${c.what ? ' — ' + c.what : ''}` +
             (mine ? '' : '   (read it, do not change it — it is not yours)'));
    }
    L.push('');
  } else {
    L.push(`Nothing was recorded for this step, which is a hole in the brief and not a`,
           `licence to invent. Go and look for what already does this before you write a`,
           `second one of it.`, '');
  }
  L.push(`## What you own`, '', `You may write these and nothing else:`, '');
  for (const o of t.owns || []) L.push(`  - ${o}`);
  L.push('', `Anything outside that list is another step's, and two steps writing one`,
         `file is the single failure this arrangement cannot survive. If you believe`,
         `you need a file you do not own, stop and say so instead of taking it.`, '',
         `Say it as early as you notice, not at the end. A shared registry you have`,
         `to add one line to, the journal your own migration writes, a fixture your`,
         `proof command regenerates — those are ordinary and they are usually just`,
         `missing from the list, not forbidden. Naming the path and why is what gets`,
         `it added; writing it anyway is what gets correct work sent back.`, '');
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
  L.push(`## A problem you did not deal with`, '',
         `If you hit a bug or a problem you are not fixing — something already broken`,
         `before you arrived, something outside what you own, something you worked`,
         `around — write it down before you finish, in ${BUGFILE(t.key)}. That file is`,
         `yours alone and you may write it even though it is not in the list above.`,
         `Say what you saw, where, and what you did about it.`, '',
         `It is not somewhere to send work you were asked to do. It is how a problem`,
         `outlives the session that found it, instead of dying in a log nobody reads.`, '');
  L.push(`## Finishing`, '',
         `Commit on ${t.branch}, and leave nothing uncommitted. Work still sitting in`,
         `the worktree is work that will not be merged: your branch is what gets read,`,
         `not your reply. If you are running out of room, commit what is finished`,
         `first and say what is left.`, '',
         `Write the commit message for the change, in the ordinary way — a short line`,
         `saying what the code now does. Do NOT write "land ${t.key}" or "merge`,
         `${t.key}" or anything else shaped like a step key. Those are the`,
         `orchestrator's own merge messages, which is why you will see them in`,
         `\`git log\` on the main line; copying that idiom into your own commit puts a`,
         `bookkeeping word where the description of the change should be, and it has`,
         `to be amended by hand before your branch can go in.`, '',
         `Do not add any co-author or generated-by trailer to the commit.`, '',
         `Your final answer should say what you changed, what you ran, and what came`,
         `back.`, '');
  L.push(`Everything about this run — the files you touched, the commands you ran and`,
         `their exit codes — is read out of your own log afterwards, so you do not`,
         `need to restate it. Say what a person could not read off a diff: what you`,
         `decided, and what you are unsure about.`);
  return L.join('\n') + '\n';
}

// The default branch, not "main" flatly — a repo with no remote has no
// origin/HEAD to ask, and a repo that calls its trunk something else is not
// wrong. Each fallback is tried in turn and the last one is a guess named as
// such by the error if it is also absent.
//
// What the repo's own branches say has to win over what `init.defaultBranch`
// merely prefers — Git for Windows ships that config set to "master" in its own
// gitconfig, so on a `main` repo it out-voted the branch that actually exists
// and `guard` died diffing a ref nothing pointed to. And every candidate is
// verified with `rev-parse` before it is returned: a config value or a stray
// local branch name is worth nothing if it does not resolve.
function guessBase() {
  const verified = (v) => { if (!v) return null; try { shq('git', ['rev-parse', '--verify', v]); return v; } catch { return null; } };
  for (const fn of [
    () => shq('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).split('/').pop(),
    () => (shq('git', ['branch', '--format=%(refname:short)']).split('\n').find((b) => b === 'main' || b === 'master')),
    () => shq('git', ['config', '--get', 'init.defaultBranch']),
  ]) { try { const v = verified(fn()); if (v) return v; } catch { /* try the next */ } }
  return 'main';
}

// ------------------------------------------------------------------- vitals
// Between opening a round and the first run coming back there is nothing. The
// only thing that wakes this orchestrator is a process exit, and a wedged run
// never exits — nor does one whose agent decided an hour ago that the suite was
// already red and has been saying so ever since. So one more backgrounded call
// goes out beside the round: it sleeps, looks at every open run's log, prints
// what it found and exits, and that exit is the wake-up.
//
// Two questions, both answerable from the log alone: is it still growing, and
// do the agent's own words say it is stuck. Neither is repaired here. A wedged
// run and a suite that was red before the step started are decisions, and they
// go to the person.
const VITALS = () => path.join(ORCH, 'vitals.json');
const VITALS_MIN = () => {
  const n = Number(process.env.CURSOR_ORCH_VITALS_MIN || 15);
  return Number.isFinite(n) && n > 0 ? n : 15;
};
// What the agent SAID, across both runners: Cursor puts it on `assistant`
// message content and on the final `result`, opencode on a `text` part and on
// `error`. Tool output is deliberately not here — a failing suite prints
// "failed" fifty times and none of those are the agent telling anyone anything.
function saidIn(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'assistant') return (ev.message?.content || []).map((p) => p.text || '').join(' ').trim() || null;
  if (ev.type === 'result' && typeof ev.result === 'string') return ev.result;
  if (ev.type === 'text') return ev.part?.text || null;
  if (ev.type === 'error') return 'error: ' + ((ev.error?.name || '') + ' ' + (ev.error?.data?.message || '')).trim();
  return null;
}
// Tight on purpose. A phrase here stops a round and wakes a person, so the cost
// of a loose one is that the check gets switched off. Each says which of the two
// things the person has to decide about it.
const DISTRESS = [
  ['ci', /\b(?:pre-?existing|already (?:red|broken|failing)|broken before|fails? on (?:main|master|the base)|unrelated to (?:my|this) change|not caused by (?:my|this) change)\b/i],
  ['stuck', /\b(?:i )?(?:can'?t|cannot|could not|unable to|won'?t be able to) (?:fix|resolve|proceed|continue|complete|do this)\b/i],
  ['stuck', /\b(?:blocked (?:on|by)|needs? (?:a )?(?:human|decision|your input)|requires? a decision|out of scope for (?:this|the) step|giving up|i am stuck|i'?m stuck)\b/i],
  ['stuck', /^error: \S/i],
];
const clipLine = (s, n = 160) => { const f = String(s ?? '').replace(/\s+/g, ' ').trim(); return f.length > n ? f.slice(0, n - 1) + '…' : f; };
const ago = (ms) => (ms >= 60000 ? Math.floor(ms / 60000) + 'm' : Math.round(ms / 1000) + 's');
const inKb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' bytes');

// One look at one open step. Says what to print and whether it needs a person.
function vitalsOf(t, seen, quietMs) {
  const st = runStatus(t.key);
  const log = (st && st.log) || path.join(ORCH, 'logs', t.key + '.jsonl');
  // A run that has ended has a log that correctly stops growing, so the status
  // file is asked before silence is judged. Reporting it is useful in itself:
  // a run that finished between two wake-ups is exactly what this arrives to
  // notice.
  if (st && st.outcome && st.outcome !== 'running')
    return { state: 'finished', note: `${st.outcome} — \`run record ${t.key}\`` };
  let stat;
  try { stat = fs.statSync(log); }
  catch {
    // A Claude Code subagent step writes no jsonl at all, and the Agent tool's
    // own completion wakes the orchestrator instead. Nothing to alarm about.
    if (!st) return { state: 'skipped', note: 'no log — a Claude Code step, or not launched yet' };
    return { alarm: true, state: 'ALARM', note: `no log at ${relCwd(log)} — the run never started` };
  }
  const quiet = Date.now() - stat.mtimeMs;
  const prev = seen[t.key] || { offset: 0 };
  // A log that was truncated and rewritten is shorter than where we got to;
  // reading from the old offset would read past the end and report silence on a
  // run that had just been relaunched. Start again from the top instead.
  let from = stat.size < prev.offset ? 0 : prev.offset;
  // A first look at a round already hours old can face 3.5 MB a run, and twelve
  // of those in one process. Only the newest slice is read; the partial line at
  // the cut simply fails to parse and is skipped, which is what the parser does
  // with any line that is not an event.
  const MOST = 8 * 1048576;
  if (stat.size - from > MOST) from = stat.size - MOST;
  const gained = stat.size - from;
  // Only what is new. Re-reading twelve megabyte logs every fifteen minutes is
  // pointless, and — the reason that actually matters — a phrase already
  // reported must not be raised a second time, or the second look stops the
  // round for something the person has already answered.
  let found = null;
  if (gained > 0) {
    let slice = '';
    try {
      const fd = fs.openSync(log, 'r');
      try {
        const buf = Buffer.alloc(gained);
        const got = fs.readSync(fd, buf, 0, gained, from);
        slice = buf.toString('utf8', 0, got);
      } finally { fs.closeSync(fd); }
    } catch { /* a log that cannot be read is judged on its mtime below */ }
    for (const line of slice.split('\n')) {
      const said = saidIn(line);
      if (!said) continue;
      for (const [family, re] of DISTRESS) if (re.test(said)) { found = { family, said: clipLine(said) }; break; }
      if (found) break;
    }
  }
  seen[t.key] = { offset: stat.size, at: new Date().toISOString() };
  if (found) return { alarm: true, state: 'ALARM', note: `${found.family}: "${found.said}"` };
  if (quiet >= quietMs) return { alarm: true, state: 'ALARM', note: `silent for ${ago(quiet)} — nothing written to ${relCwd(log)} since` };
  return { state: 'alive', note: `+${inKb(gained)} since the last look, last write ${ago(quiet)} ago` };
}

CMDS.vitals = (argv) => {
  const every = argv.includes('--every') ? Number(argv[argv.indexOf('--every') + 1]) : VITALS_MIN();
  if (!Number.isFinite(every) || every <= 0) die('--every takes a number of minutes');
  const s = readState();
  const out = tasks(s).filter((t) => t.status === 'open');
  // Nothing out is not a quiet success to wait fifteen minutes for. The round is
  // over, or has not started, and a watchdog left running past it is a process
  // looking at logs nobody is waiting on.
  if (!out.length) { console.log('Nothing is out — no run to check on.'); return; }
  if (argv.includes('--wait')) {
    const at = new Date(Date.now() + every * 60000);
    console.log(`Watching ${out.length} step(s): ${out.map((t) => t.key).join(' ')}.\n` +
      `The next look is at ${at.toTimeString().slice(0, 5)}. This exits then, and that exit is what wakes you.`);
    // A synchronous wait, because everything in this file is synchronous: a
    // timer would let the process fall off the end before the check ran.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, every * 60000);
  }
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(VITALS(), 'utf8')); } catch { /* the first look */ }
  const rows = out.map((t) => ({ key: t.key, ...vitalsOf(t, seen, every * 60000) }));
  fs.mkdirSync(ORCH, { recursive: true });
  // Not an event. Where a reader got to in a file is not a decision, and one
  // appended per open step per quarter hour would bury the record in it.
  try { fs.writeFileSync(VITALS(), JSON.stringify(seen, null, 2) + '\n'); } catch { /* best effort */ }
  for (const r of rows) console.log('  ' + r.key.padEnd(10) + r.state.padEnd(10) + r.note);
  const bad = rows.filter((r) => r.alarm);
  if (!bad.length) { console.log(`\nAll ${rows.length} accounted for. Launch another \`vitals --wait\` while they are still out.`); return; }
  console.log(`\n${bad.length} of ${rows.length} need a person.`);
  console.log('  Stop and ask the human. Do not send back and do not restart: a run that has');
  console.log('  gone quiet, and a suite that was red before the step started, are both');
  console.log('  decisions. Say which step, quote what it said, and let them choose.');
  process.exit(1);
};

CMDS.guard = (argv) => {
  const s = readState();
  const t = getTask(s, argv[0]);
  const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : guessBase();
  let changed;
  try { changed = sh('git', ['diff', '--name-only', `${base}...${t.branch}`]).split('\n').filter(Boolean); }
  catch { die(`could not diff ${base}...${t.branch}`); }
  // Its own bug file counts as owned wherever ownership is asked about: a step
  // that reported a problem it could not fix must not fail its guard for having
  // reported it.
  const mine = (p) => p === BUGFILE(t.key) || (t.owns || []).some((o) => collides(o, p));
  const stray = changed.filter((p) => !mine(p));
  t.guardedAt = new Date().toISOString(); t.guardedBase = base; t.guardedFiles = changed;
  commit(s, 'guard', argv);
  console.log(`${changed.length} file(s) changed on ${t.branch} against ${base}`);
  for (const p of changed) console.log('  ' + (mine(p) ? ' ' : '✗') + ' ' + p);
  if (!stray.length) { ok('everything it touched, it owns'); return; }
  // Two different faults used to come out as one sentence. A file another live
  // step owns is a trespass: two agents wrote it, one of them was not supposed
  // to, and sending it back is right. A file nobody owns is almost always the
  // opposite — the step's own plan or its own proof command required it to
  // write there, and the refined `owns` list was short. That happened three
  // times in one round, on shared registries every time, and each was correct
  // work failed by a list nobody could have written from the plan alone.
  const owners = (p) => tasks(s).filter((x) => x.key !== t.key && !DEAD_STATUS.includes(x.status) &&
    (x.owns || []).some((o) => collides(o, p))).map((x) => x.key);
  const trespass = stray.map((p) => ({ p, who: owners(p) })).filter((x) => x.who.length);
  const unclaimed = stray.filter((p) => !owners(p).length);
  console.error(`\n✗ ${stray.length} file(s) it does not own.`);
  if (trespass.length) {
    console.error(`\n  ${trespass.length} of them belong to another live step. That is the breach this whole`);
    console.error('  arrangement exists to prevent — send it back:');
    for (const { p, who } of trespass) console.error(`    ${p}  —  ${who.join(', ')} owns it`);
    console.error(`    node ${SELF()} sendback ${t.key} --why "You wrote ${trespass[0].p}, which belongs to ${trespass[0].who[0]}. Revert it."`);
  }
  if (unclaimed.length) {
    console.error(`\n  ${unclaimed.length} of them belong to nobody. Read the diff before sending anything back:`);
    for (const p of unclaimed) console.error('    ' + p);
    console.error('  A registry the step adds one line to, the journal its own migration writes, a');
    console.error('  fixture its proof command regenerates — none of those come out of a plan, and');
    console.error('  the work is right. Widen it and guard again:');
    console.error(`    node ${SELF()} step own ${t.key} ${unclaimed.join(' ')}`);
    console.error('  Only send it back if it had no business writing them.');
  }
  process.exit(1);
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
  const { can, held } = freedBy(s, keys);
  if (can.length) console.log(`  frees: ${can.map((x) => x.key).join(' ')} — open every one of them, in one round:\n    node ${SELF()} run open --all`);
  else console.log('  run `check`: a landing usually widens what can open.');
  if (held.length) console.log(`  held back on a serialisation point open work is moving: ${held.map((x) => x.t.key).join(' ')}`);
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
  // With no --stale, indexOf gives -1 and `argv[-1 + 1]` reads argv[0] — the
  // subcommand name — so staleMin came out NaN and every comparison against it
  // was false: the documented 30-minute default silently never applied.
  const staleFlag = argv.indexOf('--stale');
  const staleMin = Number(staleFlag === -1 ? 30 : (argv[staleFlag + 1] ?? 30));
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
    //
    // But a command that never started is not the same news, and used to be
    // reported as one: `npm` on Windows is a `npm.cmd` shim, execFileSync with
    // shell:false throws ENOENT for it before the process ever runs, and the
    // catch below turned that into a bare "exit 1" with `e.message` discarded —
    // indistinguishable from a genuinely red suite that printed nothing.
    let code = 0, spawnErr = null;
    try { execFileSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: false, env: process.env }); }
    catch (e) {
      if (e.code === 'ENOENT' && process.platform === 'win32') {
        // The one deliberate use of shell:true: cmd.exe is the thing that
        // resolves a .cmd/.bat shim, and Node quotes an array of args correctly
        // for it even with shell:true — this is not the same as turning
        // shell:true on everywhere, which would reopen the quoting bugs that
        // shell:false exists to avoid.
        try { execFileSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: true, env: process.env }); }
        catch (e2) { if (typeof e2.status === 'number') code = e2.status; else spawnErr = e2; }
      } else if (typeof e.status === 'number') {
        code = e.status;
      } else {
        spawnErr = e;
      }
    }
    if (spawnErr) {
      slotLog(name, `could not start: ${label} (${spawnErr.code || spawnErr.message})`);
      release();
      console.error(`✗ could not start "${cmd[0]}": ${spawnErr.message}`);
      process.exit(127);
    }
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
  // A cycle in `needs` is not a scheduling problem, it is a mistake — nothing
  // in it can ever open. `check` caught this; `doctor`, run right before
  // opening work, did not, because it never asked `waves` at all.
  const cyc = waves(s).find((w) => w.wave === -1);
  if (cyc) { bad++; console.log('✗ these steps depend on each other in a loop and could never open: ' + cyc.tasks.map((t) => t.key).join(' ')); }
  // A plan rewritten after its steps were cut from it leaves steps citing text
  // that no longer says what they were built on. Refining rewrites its own
  // plan, so drift there is expected and only worth saying for a plan nobody
  // has refined.
  for (const p of s.plans || []) {
    if (!fs.existsSync(path.resolve(CWD, p.path))) { bad++; console.log(`✗ the plan ${p.path} is gone — \`load\` again, or the steps built on it cite nothing`); continue; }
    if (sha(fs.readFileSync(path.resolve(CWD, p.path), 'utf8')) !== p.sha && !p.refined)
      soft.push(`${p.path} changed since it was loaded, and has not been refined`);
  }
  // The runner, once for the round rather than once per step. A missing binary
  // is the same fault forty-seven times over, and saying it forty-seven times
  // buries everything else.
  {
    const rn = runnerOf(s);
    const bin = runnerBin(rn);
    if (!bin.ok) {
      bad++;
      console.log(`✗ this round runs on ${rn}, which cannot be found:`);
      for (const l of String(bin.why).split('\n')) console.log('    ' + l.replace(/^✗ /, ''));
    } else if (rn !== 'cursor') {
      const r = runnerRow(rn);
      soft.push(`runs on ${rn} (${r ? r.shown || r.model : rn}) — its log does not name the model that answered, so every run is recorded unverified`);
    }
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
      if (briefKey(t) !== t.briefSha) probs.push('its brief is older than the step — rewrite it and tell the agent to re-read');
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
  // A point is a gate, and a gate across N steps costs N-1 rounds of
  // wall-clock. It is the right price for a lockfile and the wrong one for a
  // file that merely gets edited twice, and a refining agent that reaches for
  // the vocabulary too readily turns a round that could run wide into a queue —
  // which is exactly what it looks like from the outside: `check` names one
  // step, over and over, and nothing says why the other forty are not running.
  // So the price is printed with the name on it.
  {
    const wide = [...pts.entries()].map(([, v]) => v).filter((v) => v.length >= 3)
      .sort((a, b) => b.length - a.length);
    if (wide.length) {
      console.log(`· ${wide.length} serialisation point(s) gate three or more steps — each is a queue:`);
      for (const v of wide) console.log(`    ${String(v.length).padStart(2)}×  "${v[0].spelling}"  —  ${v.map((x) => x.key).join(' ')}`);
      console.log('    Those steps go one at a time, however little else they share. A point is');
      console.log('    for what git merges cleanly and gets wrong — a lockfile, a migration head,');
      console.log('    a closed list a test asserts on. A file two steps both edit is not one:');
      console.log('    that is `owns`, and they reconcile at the merge instead of queueing.');
      console.log('    Where two of them genuinely move separate things, scope the name:');
      console.log('    "migration head: orders" against "migration head: billing".');
    }
  }
  // A symbol a step consumes that no step in the round creates. This is the
  // failure the symbol fields exist to catch, and it is only visible from here:
  // the step is well-formed, its paths exist, its needs are real keys, and it
  // will still open against an import that nothing has written yet.
  //
  // Not fatal, because it is also what a symbol the repository ALREADY exports
  // looks like — a step consuming something that has been there all along names
  // it here and no step provides it. Only the round can say which, so this
  // names them and leaves the judgement.
  {
    const made = new Map();
    for (const t of live) for (const x of t.provides || []) {
      const v = normSym(x); if (!v) continue;
      (made.get(v) || made.set(v, []).get(v)).push(t.key);
    }
    const dangling = [];
    for (const t of live) for (const x of t.uses || []) {
      const v = normSym(x); if (!v || made.has(v)) continue;
      dangling.push({ key: t.key, sym: v });
    }
    if (dangling.length) {
      console.log(`· ${dangling.length} symbol(s) a step uses that no step in this round provides:`);
      for (const d of dangling.slice(0, 15)) console.log(`    ${d.key.padEnd(10)} uses "${d.sym}"`);
      if (dangling.length > 15) console.log(`    … and ${dangling.length - 15} more`);
      console.log('    Fine if the repository already exports it. If a step in this round is meant');
      console.log('    to write it, that step is missing it from `provides` — and until it is there,');
      console.log('    `step link --only-shared` records no edge and this step opens against nothing.');
    }
    // A step whose `provides` nothing consumes is not worth a line: most steps
    // are leaves and saying so forty times is noise.
  }
  // A step that waits on many and frees nothing. It is legitimate — an
  // integration suite really does assert across all of its predecessors — but
  // it is also what a cross-product link looks like from here, and the two are
  // worth telling apart before a round is committed to.
  //
  // Under `frontier` a leaf holds nothing back: nothing needs it, so it opens
  // beside whatever else can go rather than in front of it. That is only true
  // if it is actually run that way, which is `run open --all`.
  {
    const gates = (k) => live.filter((x) => (x.needs || []).includes(k)).length;
    const barriers = live.filter((t) => (t.needs || []).length >= 4 && gates(t.key) === 0)
      .sort((a, b) => (b.needs || []).length - (a.needs || []).length);
    if (barriers.length) {
      console.log(`· ${barriers.length} step(s) wait on four or more and free nothing:`);
      for (const t of barriers) console.log(`    ${t.key.padEnd(10)} needs ${(t.needs || []).length}, gates 0  —  ${String(t.title || '').slice(0, 40)}`);
      console.log('    Nothing waits on these, so they open beside the next round rather than in');
      console.log('    front of it — provided the round is opened with `run open --all`. If one is');
      console.log('    not an integration suite, its needs are probably a cross-product from');
      console.log('    `step link` without --only-shared, and most of them are not real.');
    }
  }
  // Edges `step rm` took out and nothing put back. The tool removed them, so
  // the tool is the one that has to keep saying so until somebody decides.
  {
    const cut = severedEdges(s);
    const alive = cut.filter((x) => x.dep && !DEAD_STATUS.includes(x.dep.status));
    if (alive.length) {
      bad += alive.length;
      console.log(`✗ ${alive.length} dependency edge(s) were severed and the step at the other end is live again:`);
      for (const x of alive) console.log(`    ${x.t.key} once needed ${x.lost}, which is ${x.dep.status} — and is not in its needs`);
      console.log('    Recording that key again restores the edge. This is the tool failing to,');
      console.log(`    and it opens ${alive[0].t.key} on work nothing is waiting for.`);
    }
    const dead = cut.filter((x) => !alive.includes(x));
    if (dead.length) {
      console.log(`· ${dead.length} dependency edge(s) were severed by a cancellation and never restored:`);
      for (const x of dead) console.log(`    ${x.t.key} no longer needs ${x.lost} (cancelled)`);
      console.log('    Right if that work is genuinely gone. If it came back under another key,');
      console.log(`    say so: \`step add\` with the needs it should have, and nothing else changes.`);
    }
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
  const before = shq('git', ['rev-parse', 'HEAD']);
  let conflicted = [], failed = false, errMsg = '';
  try {
    // Shaped like a merge, because it is one. It used to read `land S-4`, which
    // is the orchestrator's word for its own bookkeeping and reads like an
    // ordinary commit subject — and agents read `git log` to learn a project's
    // conventions, so they copied it onto their own commits, where it says
    // nothing about the change and had to be amended before joining.
    execFileSync('git', ['merge', '--no-ff', t.branch, '-m',
      `Merge step ${t.key}` + (t.title ? ` — ${t.title}` : '')],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    errMsg = String(e.stderr || e.message || e).trim();
    // Take the conflicted list before aborting; after the abort there is nothing
    // left to read it from.
    conflicted = shq('git', ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    try { execFileSync('git', ['merge', '--abort'], { stdio: 'ignore' }); } catch { /* nothing to abort, or already clean */ }
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
  // Not every failed merge leaves conflict markers: a missing branch, unrelated
  // histories, a rejecting hook, a locked index all throw `git merge` with
  // nothing in `--diff-filter=U`. Falling through to the success path here used
  // to set joinedAt on a merge that never happened — `join` on a step whose
  // branch was `step/does-not-exist` printed "merged cleanly" with the same SHA
  // before and after. Report the real failure instead, and don't stamp it landed.
  if (failed) { t.joinError = errMsg; return { conflicted: [], hardFail: true, error: errMsg }; }
  const after = shq('git', ['rev-parse', 'HEAD']);
  if (after === before) {
    // git exited 0 but HEAD did not move — not the ordinary "Already up to
    // date" (that can't happen for a fresh branch being landed) but cheap
    // insurance against the same silent-success failure mode by another route.
    const msg = 'git merge reported success but HEAD did not move';
    t.joinError = msg;
    return { conflicted: [], hardFail: true, error: msg };
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
    if (r.conflicted.length || r.hardFail) failed.push({ t, ...r });
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
  for (const { t, conflicted, others, hardFail, error } of failed) {
    if (hardFail) {
      console.log(`\n✗ ${t.key} could not be merged: ${error}`);
      console.log('  No conflict markers were left, so there is nothing to resolve by hand — check');
      console.log('  the branch exists, the histories are related, and no hook rejected it.');
    } else {
      console.log(`\n✗ ${t.key} conflicts with the main line on ${conflicted.length} file(s):`);
      for (const f of conflicted) console.log('    ' + f);
      if (others.length) console.log(`  The other side is ${others.map((x) => x.key).join(', ')}, already landed.`);
    }
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
  // Everything the batch put on the main line may already be built on — but
  // only what `run open` will actually take. See `freedBy`.
  const { can, held } = freedBy(s, merged.map((t) => t.key));
  if (can.length) {
    console.log(`\n  ${can.length} step(s) can open off this batch now: ${can.map((x) => x.key).join(' ')}`);
    console.log(`    node ${SELF()} run open --all`);
  }
  if (held.length) {
    console.log(`\n  ${held.length} step(s) this frees still cannot open — a serialisation point open`);
    console.log('  work is already moving:');
    for (const { t: x, why } of held) for (const { o, i } of why) console.log(`    ${x.key} ↔ ${o.key}: ${i.points.join('; ')}`);
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
  const { conflicted, others, hardFail, error } = mergeOne(s, t);

  if (conflicted.length || hardFail) {
    commit(s, 'join (conflict)', argv);
    if (hardFail) {
      console.log(`✗ ${t.key} could not be merged: ${error}`);
      console.log('  No conflict markers were left, so there is nothing to resolve by hand — check');
      console.log('  the branch exists, the histories are related, and no hook rejected it.');
    } else {
      console.log(`✗ ${t.key} conflicts with the main line on ${conflicted.length} file(s):`);
      for (const f of conflicted) console.log('    ' + f);
      if (others.length) console.log(`  The other side is ${others.map((x) => x.key).join(', ')}, already landed.`);
    }
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
    const { can, held } = freedBy(s, [t.key]);
    if (can.length) {
      console.log(`\n  This merge is on HEAD, so ${can.length} step(s) can open now without waiting`);
      console.log(`  for the suite: ${can.map((x) => x.key).join(' ')}`);
      console.log(`    node ${SELF()} run open --all`);
    }
    if (held.length) {
      console.log(`\n  ${held.length} step(s) this frees still cannot open — they move a serialisation`);
      console.log('  point open work is already moving:');
      for (const { t: x, why } of held) for (const { o, i } of why) console.log(`    ${x.key} ↔ ${o.key}: ${i.points.join('; ')}`);
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
  (t.sendbacks ||= []).push({ at: new Date().toISOString(), why: why.slice(0, 200), file: relCwd(f) });
  t.status = 'open';
  commit(s, 'sendback', argv);
  ok(`${t.key} sent back — the prompt is at ${relCwd(f)}`);
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
  console.log('\n  Resume the agent that wrote it, on its own conversation:');
  if ((t.runner || 'cursor') === 'opencode') {
    const bin = runnerBin('opencode');
    const rm = runnerModel(s, t.tier);
    // opencode's resume flag is `-s <sessionID>`, not `--session` — recorded at
    // docs/plans/running-steps-on-deepseek.md:273,321 from research against the
    // real binary. `--session` risks being silently ignored rather than
    // rejected, which resumes into a fresh session with no memory of the prior
    // run while this tool believes the same conversation continued. Not
    // confirmed against a live binary here — opencode is not installed.
    console.log(`    ${bin.ok ? bin.path : 'opencode'} run --dir ${t.worktree} -s ${t.chat} \\`);
    console.log(`      -m ${rm.model} --variant ${rm.effort} --auto --format json \\`);
    console.log(`      "$(cat ${relCwd(f)})"`);
  } else if ((t.runner || 'cursor') === 'claude') {
    const bin = runnerBin('claude');
    const rm = runnerModel(s, t.tier);
    // Claude Code takes the directory by being started in it, not by a flag —
    // so the prompt is read BEFORE the cd. The path printed here is relative to
    // the main checkout, and reading it from inside the worktree would look
    // exactly right and find nothing.
    console.log(`    P="$(cat ${relCwd(f)})" && (cd ${t.worktree} && \\`);
    console.log(`      ${bin.ok ? bin.path : 'claude'} -p --dangerously-skip-permissions \\`);
    console.log(`      --model ${rm.model} --effort ${rm.effort} --resume ${t.chat} "$P" < /dev/null)`);
  } else {
    console.log(`    agent -p --force --trust --resume ${t.chat} "$(cat ${relCwd(f)})"`);
  }
  console.log('\n  It has the context for why it made those changes. A new agent reading logs');
  console.log('  would have to reconstruct that from outside.');
};

// The header and `readState`'s own error promised this and nothing did it.
// Every event already carries the full state it produced (see `commit`), so
// the record does not need replaying instruction by instruction — the last
// line already holds the answer.
CMDS.rebuild = () => {
  if (!fs.existsSync(EVENTS)) die(`no ${EVENTS} to rebuild from`);
  const lines = fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) die(`${EVENTS} is empty — nothing to rebuild from`);
  let last;
  try { last = JSON.parse(lines[lines.length - 1]); }
  catch (e) { die(`the last line of ${EVENTS} is not valid JSON (${e.message}) — state.json cannot be rebuilt from it`); }
  if (!last.state) die(`the last event in ${EVENTS} carries no state snapshot — state.json cannot be rebuilt from it`);
  fs.mkdirSync(ORCH, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(last.state, null, 2) + '\n');
  ok(`state.json rebuilt from event ${last.seq} of ${lines.length} (${last.why}, ${last.at})`);
};

const HELP = `orchestrate — plan to merged code, on Cursor, opencode or Claude Code

  runner [use <name>]       which CLI runs the steps: cursor or opencode
  load <path>...            read the plan files, record them
  map                       which plans touch which files, and where the seams are
  assess [propose|set|critical|check]  how hard each step is, and which model
  refine brief <plan>       the prompt for a refining agent
  refine done <plan>        read its report; records the steps it found
  step add < json           record steps by hand, in one batch or not at all
  step own <key> <path>…    widen what a step may write, without re-refining it
  step rm <key>…            cancel a step; the edges into it are severed, not lost
  step link [--only-shared] turn each plan's requires: into needs between steps
                            --only-shared keeps only the edges that order the work:
                            one step uses a symbol another provides, or they share
                            a serialisation point. A file both write is not an edge
  step reset <plan>         cancel every live step of one plan
  check                     which steps can open together, and what blocks the rest
  run open --all            open every step that can go, in one round. The usual form.
  run open <key>            worktree, chat, brief — everything one step needs to start
  run open <key> --rebrief  rewrite the brief of a step already out
  run record <key> --log L  harvest a finished run into the record
  vitals [--wait]           look at every open run's log: still growing, and does
                            it say it is stuck. --wait sleeps 15 minutes first, so
                            its exit is what wakes you while a round is out
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
  rebuild                   replay the last event's state back into state.json

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
