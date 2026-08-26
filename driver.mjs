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
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';

const CWD = process.cwd();
const CMDLINE = process.argv.slice(2).join(' ').slice(0, 200);
// The resolved subcommand — `refine done`, `defect add`, `iam` — filled in by the
// dispatch at the bottom. The raw argv is kept alongside it, but argv is not what
// belongs in a narrow column: an invocation that leads with `--register <abs path>`
// pushes the command itself off the end of the line, and the log then reads as
// hundreds of rows that name no command at all.
let CMDNAME = '';
let REG_PATH = path.join(CWD, '.claude', 'orchestration', 'register.json');

const die = (m) => { console.error('error: ' + m); process.exit(2); };
const now = () => new Date().toISOString();

// Every flag that carries words an agent wrote goes through here. Checking only
// truthiness let a boolean `true` through and recorded it as the agent's words —
// a success message over a message that no longer existed.
function strFlag(flags, name, why) {
  const v = flags[name];
  if (typeof v !== 'string' || !v.trim()) die(why);
  return v;
}
// Same for the numeric ones: Number(true) is 1 and Number('bogus') is NaN, and
// both used to sail into a filter that silently matched nothing.
function numFlag(flags, name, { min = 0, max = Infinity, what } = {}) {
  if (flags[name] === undefined) return undefined;
  const n = Number(flags[name]);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max)
    die('--' + name + ' needs ' + (what || 'a whole number from ' + min +
        (max === Infinity ? ' up' : ' to ' + max)) + ' — got "' + flags[name] + '"');
  return n;
}

function readReg() {          // for read-modify-write: holds the lock until exit
  // Ask whether there is anything to read BEFORE taking the lock. Locking first
  // means a project with no register at all reports a lock conflict, which is
  // both wrong and the least useful thing it could say.
  if (!fs.existsSync(REG_PATH)) die('no register at ' + rel(REG_PATH) + ' — run `load` first');
  acquireLock();
  return readRegRO();
}
// Writes land by atomic rename, so a reader never sees a torn file. Commands
// that only look (and commands a chip runs from its own process) use this and
// never wait on anyone.
function readRegRO() {
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
  // The lock lives beside the register, so on the very first write its parent
  // does not exist yet. Without this the mkdir below fails with ENOENT, which
  // read as contention and spun for six seconds before blaming a process that
  // was never there.
  try { fs.mkdirSync(path.dirname(lockDir()), { recursive: true }); } catch { /* reported below */ }
  for (let i = 0; i < 60; i++) {
    try {
      fs.mkdirSync(lockDir(), { recursive: false });
      // Say who holds it, so a stale lock can be told from a slow one by asking
      // the operating system rather than by guessing from a timestamp.
      try { fs.writeFileSync(path.join(lockDir(), 'holder.json'),
        JSON.stringify({ pid: process.pid, host: os.hostname(), since: now() })); } catch { /* best effort */ }
      HAS_LOCK = true; process.on('exit', releaseLock); return;
    } catch (e) {
      // Only EEXIST means somebody else holds it. A permission error, a full
      // disk or a missing parent are not contention and waiting will not help.
      if (e && e.code && e.code !== 'EEXIST')
        die('cannot create the register lock at ' + rel(lockDir()) + ': ' + e.code + ' — ' + e.message);
      if (lockIsDead()) { try { fs.rmSync(lockDir(), { recursive: true, force: true }); } catch { /* raced */ } continue; }
      try { execSync('sleep 0.1'); } catch { /* keep spinning */ }
    }
  }
  die('another driver process has held the register lock for a while: ' + rel(lockDir()) +
      '\n       If nothing is actually running, remove that directory.');
}
function releaseLock() { if (HAS_LOCK) { try { fs.rmSync(lockDir(), { recursive: true, force: true }); } catch { /* gone */ } HAS_LOCK = false; } }

// A holder whose process is gone is dead however recently it started. A holder
// that is alive is not stale however long it has run — a command that legitimately
// takes a minute must not have its lock stolen out from under it.
function lockIsDead() {
  let h = null;
  try { h = JSON.parse(fs.readFileSync(path.join(lockDir(), 'holder.json'), 'utf8')); } catch { /* none */ }
  if (!h || !h.pid) {
    try { return Date.now() - fs.statSync(lockDir()).mtimeMs > 15000; } catch { return false; }
  }
  if (h.host && h.host !== os.hostname()) return Date.now() - Date.parse(h.since || 0) > 15 * 60000;
  try { process.kill(h.pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

function writeReg(r) {
  // Nothing writes the register without holding the lock. `rebuild`, `verify` and
  // `log reseed` used to call straight in here and land on the same
  // `register.json.tmp` a locked writer was using, so a chip's concurrent `done`
  // was overwritten without a word. The commands take the lock themselves, and
  // this is the backstop that makes "no unlocked writer" true by construction.
  if (!HAS_LOCK) acquireLock();
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


// ------------------------------------------------------------- the event log
// The register is a projection. events.jsonl is the record, and it is written
// by observing what actually changed rather than by asking 23 commands to
// describe what they were about to do. That matters more than it sounds: a diff
// taken after the fact IS the resolved outcome, so the ambient reads scattered
// through this file (a wave index recomputed from the whole graph, a status
// derived from every dependency, an id allocated from the current maximum)
// cannot resolve differently on replay. There is nothing to re-derive.
function eventsPath() { return path.join(path.dirname(path.resolve(CWD, REG_PATH)), 'events.jsonl'); }

function diffOps(a, b, at = [], out = []) {
  if (a === b) return out;
  const prim = (v) => v === null || typeof v !== 'object';
  if (prim(a) || prim(b) || Array.isArray(a) !== Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ p: at, v: b });
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && b.length < a.length) {
    // a shortened array is one assignment, not a run of deletes
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ p: at, v: b });
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in b)) { out.push({ p: [...at, k], d: 1 }); continue; }
    if (!(k in a)) { out.push({ p: [...at, k], v: b[k] }); continue; }
    diffOps(a[k], b[k], [...at, k], out);
  }
  return out;
}

// Pure. No clock, no filesystem, no ambient reads — every value is already in
// the op. Assignment-shaped, so applying the same event twice is a no-op.
function applyOps(state, ops) {
  for (const op of ops) {
    if (!Array.isArray(op.p)) continue;
    if (!op.p.length) { state = op.v; continue; }
    let cur = state;
    for (let i = 0; i < op.p.length - 1; i++) {
      const k = op.p[i];
      if (cur[k] === null || cur[k] === undefined || typeof cur[k] !== 'object')
        cur[k] = /^[0-9]+$/.test(String(op.p[i + 1])) ? [] : {};
      cur = cur[k];
    }
    const last = op.p[op.p.length - 1];
    if (op.d) { if (Array.isArray(cur)) cur.splice(Number(last), 1); else delete cur[last]; }
    else cur[last] = op.v;
  }
  return state;
}

// A crash mid-append leaves a partial final line. That one is droppable. A bad
// line anywhere else is corruption and must never be quietly skipped — this is
// the source of truth, not a message ledger.
function readEvents({ tolerateTail = true } = {}) {
  const f = eventsPath();
  if (!fs.existsSync(f)) return { events: [], problems: [], bytesGood: 0, ends: [] };
  // A record that is a directory, or that this user cannot read, is bad input like
  // any other bad input. It used to come out as a raw Node stack trace from every
  // single command, which tells the person nothing about what to do next.
  let raw;
  try {
    const st = fs.statSync(f);
    if (!st.isFile())
      die('the record at ' + rel(f) + ' is a ' + (st.isDirectory() ? 'directory' : 'special file') +
          ', not a file — one JSON event per line is what belongs there.');
    raw = fs.readFileSync(f, 'utf8');
  } catch (e) {
    die('cannot read the record at ' + rel(f) + ': ' + ((e && e.code) || 'unreadable') + '.\n' +
        '       Fix its permissions, or recover it from .claude/orchestration/backups/.');
  }
  const lines = raw.split('\n');
  const events = [], problems = [], ends = [];
  let bytesGood = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) { if (i < lines.length - 1) bytesGood += 1; continue; }
    const isLast = i === lines.length - 1 || lines.slice(i + 1).every((x) => !x);
    let e;
    try { e = JSON.parse(line); }
    catch {
      if (isLast && tolerateTail) { problems.push({ line: i + 1, why: 'truncated final line — a crash mid-append; dropped' }); break; }
      problems.push({ line: i + 1, why: 'unreadable line in the middle of the log — this is corruption', fatal: true });
      continue;
    }
    if (!e || typeof e !== 'object' || !Array.isArray(e.ops)) {
      problems.push({ line: i + 1, why: 'not an event record', fatal: true }); continue;
    }
    events.push(e);
    bytesGood += Buffer.byteLength(line) + 1;
    ends.push(bytesGood);   // where this event's line ends — what `--to` truncates at
  }
  return { events, problems, bytesGood, ends };
}

// A final line with no trailing newline is not corruption yet, but the next append
// concatenates onto it and turns two good events into one unparseable one — which
// the reader then drops as a torn tail, losing both, while `verify` goes green on
// the loss because the register was never told. Close the line before appending.
function sealLastLine(f) {
  let st;
  try { st = fs.statSync(f); } catch { return; }
  if (!st.isFile() || st.size === 0) return;
  let last = null;
  try {
    const fd = fs.openSync(f, 'r');
    const b = Buffer.alloc(1);
    try { if (fs.readSync(fd, b, 0, 1, st.size - 1) === 1) last = b[0]; } finally { fs.closeSync(fd); }
  } catch { return; }
  if (last !== null && last !== 0x0a) fs.appendFileSync(f, '\n');
}

function replay(events) {
  let state = {}; let last = 0; const problems = [];
  for (const e of events) {
    if (typeof e.seq === 'number') {
      if (e.seq <= last) { problems.push({ seq: e.seq, why: 'repeated or out-of-order — skipped' }); continue; }
      if (e.seq !== last + 1) problems.push({ seq: e.seq, why: 'gap in the record: expected ' + (last + 1) });
      last = e.seq;
    }
    state = applyOps(state, e.ops);
  }
  return { state, problems, lastSeq: last };
}

// Every register write goes through here, and the event lands FIRST. A crash
// between the two leaves an event with no projection, which a rebuild repairs
// exactly; the other order would leave a change that the record never learned,
// which nothing can repair.
function commit(r, why) {
  const f = eventsPath();
  let before = {};
  try { before = JSON.parse(fs.readFileSync(path.resolve(CWD, REG_PATH), 'utf8')); } catch { /* first write */ }
  const { events, problems, bytesGood } = readEvents();
  // A register with content sitting on top of an empty log is a hole in the
  // history, and appending only the delta to it is the worst of both worlds: the
  // one line that results claims to be the whole record, so the next `rebuild`
  // replays it over the register and everything the register still held is gone.
  // Seed the whole state instead, exactly as `log reseed` does, and say why.
  const lost = !events.length && before && typeof before === 'object' && Object.keys(before).length > 0;
  const ops = lost ? [{ p: [], v: r }] : diffOps(before, r);
  if (!ops.length) return writeReg(r);          // no-op: burns no backup, records nothing
  const fatal = problems.find((x) => x.fatal);
  if (fatal) die('the record at ' + rel(f) + ' is damaged at line ' + fatal.line + '.\n' +
    '       Refusing to append to a log with a hole in it — a partial record is worse than none.\n' +
    '       Recover from .claude/orchestration/backups/, or start a fresh log with: log reseed');
  if (problems.length) {
    // truncate the torn tail back to the last good newline, or the next append
    // concatenates onto it and the damage becomes permanent
    try { fs.truncateSync(f, bytesGood); } catch { /* nothing to trim */ }
  }
  const seq = (events.length ? Math.max(...events.map((e) => e.seq || 0)) : 0) + 1;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  sealLastLine(f);
  const rec = { seq, at: now(), cmd: why || CMDNAME || CMDLINE, argv: CMDLINE, ops };
  if (lost) {
    rec.reseed = true;
    rec.why = 'the record at ' + rel(f) + ' was missing or empty while the register still held ' +
      Object.keys(before).length + ' top-level field(s); seeded from the register as it stood, ' +
      'so everything before this point is lost history.';
    console.error('· the record at ' + rel(f) + ' was missing or empty, and the register was not.');
    console.error('  Seeded a fresh record from the register as it stands, marked as a hole in the history.');
  }
  fs.appendFileSync(f, JSON.stringify(rec) + '\n');
  return writeReg(r);
}

function cmdRebuild(flags) {
  // Both of these read the register and the record and compare them, so both need
  // the pair to be a single moment. `verify` locks for the same reason it reads
  // twice; `rebuild` locks because it writes.
  acquireLock();
  const { events, problems, ends } = readEvents();
  const fatal = problems.find((x) => x.fatal);
  if (fatal) die('the record is damaged at line ' + fatal.line + ' — ' + fatal.why + '.\n' +
    '       Not rebuilding from a log with a hole in it.');
  if (!events.length) die('no record at ' + rel(eventsPath()) + ' — nothing to rebuild from.');
  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq || 0), 0);
  const to = numFlag(flags, 'to', { min: 1, max: maxSeq,
    what: 'a sequence number from 1 to ' + maxSeq + ' (the record ends there)' });
  const upto = to === undefined ? Infinity : to;
  const use = events.filter((e) => (e.seq || 0) <= upto);
  const { state, problems: rp, lastSeq } = replay(use);
  for (const x of problems) console.error('· ' + x.why);
  for (const x of rp) console.error('· seq ' + x.seq + ': ' + x.why);
  if (flags.check) {
    let actual = null;
    try { actual = JSON.parse(fs.readFileSync(path.resolve(CWD, REG_PATH), 'utf8')); } catch { /* none */ }
    const drift = diffOps(state, actual === null ? {} : actual);
    if (!drift.length) { console.log('✓ the record and the register agree exactly (' + use.length + ' event(s), seq ' + lastSeq + ').'); return; }
    console.error('✗ they disagree in ' + drift.length + ' place(s):');
    for (const o of drift.slice(0, 12)) console.error('    ' + o.p.join('.') + (o.d ? '  (only in the record)' : '  → ' + JSON.stringify(o.v).slice(0, 70)));
    if (drift.length > 12) console.error('    …and ' + (drift.length - 12) + ' more');
    console.error('\n  Two different causes, opposite fixes — nothing can tell them apart for you:');
    console.error('    rebuild            the register was edited or damaged; take the record as truth');
    console.error('    log reseed         the record lost its tail; take the register as truth');
    process.exit(1);
  }
  writeReg(state);
  console.log('rebuilt ' + rel(REG_PATH) + ' from ' + use.length + ' event(s) (seq ' + lastSeq + ').');
  console.log('The previous file was kept in backups/ — nothing was thrown away.');
  // Rewinding the register while leaving the record at full length leaves the run
  // permanently drifted: the register says seq N, the log says seq maxSeq, and
  // every `verify` from then on reports the difference as damage. The two halves
  // move together or not at all — so cut the log to the same point, keeping the
  // full original beside it so the rewind is still reversible.
  if (to !== undefined) {
    const f = eventsPath();
    const cutIdx = events.reduce((m, e, i) => ((e.seq || 0) <= upto ? i : m), -1);
    const cut = cutIdx >= 0 ? ends[cutIdx] : 0;
    let size = 0;
    try { size = fs.statSync(f).size; } catch { /* gone */ }
    if (cut < size) {
      const keep = f + '.before-rewind-' + now().replace(/[:.]/g, '-');
      fs.copyFileSync(f, keep);
      fs.truncateSync(f, cut);
      console.log('The record was cut to the same point, so the two stay in step.');
      console.log('The full record as it was is kept at ' + rel(keep) + ' — ' +
        (events.length - use.length) + ' event(s) beyond seq ' + lastSeq + ' are only there now.');
    }
  }
}

// Events written before the command was recorded by name hold the raw argv, and
// an argv that leads with `--register <abs path>` fills the whole column with the
// path. Nothing can be done about what was written, but the column can drop the
// flags nobody reads and show the words that actually name the command.
function cmdLabel(e) {
  const raw = String(e.cmd || '');
  if (e.argv === undefined) {          // an old row: raw argv, flags and all
    const words = [];
    const parts = raw.split(/\s+/).filter(Boolean);
    for (let i = 0; i < parts.length && words.length < 3; i++) {
      const p = parts[i];
      if (p === '--') break;
      if (p.startsWith('--')) {
        // Once the command's own words have started, a flag ends them. Reading on
        // past it picks up the loose words of a long `--why "..."` and renders
        // them as if they were the command.
        if (words.length) break;
        if (!p.includes('=') && parts[i + 1] && !parts[i + 1].startsWith('--')) i++;
        continue;
      }
      words.push(p);
    }
    return words.join(' ') || raw;
  }
  return raw;
}

function cmdEvents(flags) {
  const { events, problems } = readEvents();
  for (const x of problems) console.error('· ' + x.why);
  let show = events;
  const since = numFlag(flags, 'since', { min: 0 });
  if (since !== undefined) show = show.filter((e) => (e.seq || 0) > since);
  if (typeof flags.task === 'string') show = show.filter((e) => JSON.stringify(e.ops).includes('"' + flags.task + '"') || cmdLabel(e).includes(flags.task));
  if (typeof flags.grep === 'string') show = show.filter((e) => JSON.stringify(e).includes(flags.grep));
  const n = numFlag(flags, 'n', { min: 1 }) ?? 40;
  for (const e of show.slice(-n)) {
    console.log(String(e.seq).padStart(5) + '  ' + String(e.at).slice(0, 19).replace('T', ' ') + '  ' + cmdLabel(e).slice(0, 46));
    for (const o of e.ops.slice(0, 4))
      console.log('        ' + (o.d ? '- ' : '  ') + o.p.join('.') + (o.d ? '' : ' → ' + JSON.stringify(o.v).slice(0, 60)));
    if (e.ops.length > 4) console.log('        …' + (e.ops.length - 4) + ' more change(s)');
  }
  console.log('\n' + show.length + ' of ' + events.length + ' event(s)' + (show.length > n ? ', last ' + n + ' shown' : '') + '.');
}

function cmdLogReseed(flags) {
  strFlag(flags, 'why', 'log reseed --why "..." — say what happened to the old record; this marks a hole in the history');
  // Replaces the record wholesale from the register; a concurrent writer changing
  // the register underneath that would be baked into the seed and then lost.
  acquireLock();
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(path.resolve(CWD, REG_PATH), 'utf8')); } catch { die('no register to reseed from'); }
  const f = eventsPath();
  if (fs.existsSync(f)) {
    const keep = f + '.superseded-' + now().replace(/[:.]/g, '-');
    fs.renameSync(f, keep);
    console.log('the old record was kept as ' + rel(keep));
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify({ seq: 1, at: now(), cmd: 'log reseed', reseed: true,
    why: flags.why, ops: [{ p: [], v: cur }] }) + '\n');
  console.log('started a fresh record from the register as it stands.');
  console.log('It carries an explicit note that history before this point was lost, and why.');
}

// ---------------------------------------------------------------- resolving

// Every plan file under a directory, deepest last, dot-dirs and node_modules
// skipped.
function walkPlans(root) {
  const out = [];
  (function walk(d) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|markdown|txt|rst)$/i.test(e.name)) out.push(p);
    }
  })(root);
  return out.sort();
}

// A wildcard was only ever read in the last segment, so `docs/*/plan.md` looked
// in a directory literally named "*" and reported "no files matched"; and a
// wildcard that matched a directory handed that directory to readFileSync,
// which threw EISDIR. Both are fixed by matching segment by segment: `*` inside
// one name, `**` across any depth, and a directory that survives the match is
// walked for plans rather than read as one.
function globPlans(arg) {
  const abs = path.resolve(CWD, arg);
  const parts = abs.split(path.sep).filter(Boolean);
  const seg = (s) => new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
  let here = [path.sep];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const next = [];
    if (part === '**') {
      // any depth, this level included
      for (const d of here) {
        next.push(d);
        for (const sub of (function all(x, acc) {
          let es = [];
          try { es = fs.readdirSync(x, { withFileTypes: true }); } catch { return acc; }
          for (const e of es) {
            if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
            const p = path.join(x, e.name); acc.push(p); all(p, acc);
          }
          return acc;
        })(d, [])) next.push(sub);
      }
    } else if (part.includes('*')) {
      const re = seg(part);
      for (const d of here) {
        let es = [];
        try { es = fs.readdirSync(d); } catch { continue; }
        for (const e of es) if (re.test(e)) next.push(path.join(d, e));
      }
    } else {
      for (const d of here) {
        const p = path.join(d, part);
        if (fs.existsSync(p)) next.push(p);
      }
    }
    here = [...new Set(next)];
    if (!here.length) return [];
  }
  const out = [];
  for (const p of here) {
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walkPlans(p));
    else out.push(p);
  }
  return [...new Set(out)].sort();
}

function expand(arg) {
  const abs = path.resolve(CWD, arg);
  if (arg.includes('*')) return globPlans(arg);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return walkPlans(abs);
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

// Whole words only, and never the negation of one. Unanchored, "resolved" sits
// inside "unresolved" and "answered" inside "unanswered", so a section headed
// "Unresolved questions" turned suppression ON and every gap under it was
// dropped without a word — the sections most likely to hold undecided things
// were exactly the ones skipped, and `check` then went green. The boundaries
// stop the run-together forms; the lookbehind stops "un-resolved" and
// "un answered", which a boundary alone lets through.
const SETTLED_HEADING = /(?<!\bun[- ])\b(settled|do not relitigate|already decided|resolved|answered)\b|\bdecisions \(/i;
const FENCE = /^\s*(```|~~~)/;

// Which lines sit inside a code fence. Toggling a flag line by line meant a
// plan with an odd number of fence lines left the fence open for ever, so
// every line after the last ``` was treated as code and never scanned. An
// unterminated fence is a typo in the plan, not an instruction to stop reading
// it: the unmatched opener is ignored, the rest is scanned as prose, and the
// operator is told the plan needs fixing.
function fencedLines(lines) {
  const marks = [];
  lines.forEach((l, i) => { if (FENCE.test(l)) marks.push(i); });
  let unterminated = false;
  if (marks.length % 2 === 1) { marks.pop(); unterminated = true; }
  const inFence = new Array(lines.length).fill(false);
  for (let k = 0; k + 1 < marks.length; k += 2)
    for (let i = marks[k]; i <= marks[k + 1]; i++) inFence[i] = true;
  return { inFence, unterminated };
}

function scanFile(p) {
  const lines = readPlan(p).split('\n');
  const hits = [];
  const { inFence, unterminated } = fencedLines(lines);
  if (unterminated)
    console.error('note: ' + rel(p) + ' has an odd number of code fence lines — the last one is ' +
                  'never closed. Reading past it as prose; fix the fence in the plan.');
  let heading = '', settled = false;
  lines.forEach((line, i) => {
    if (inFence[i]) return;
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
//
// Each word below is matched as a WORD, not as a run of letters. Matched as
// bare substrings, "deliberate" and "separate" both read as *rate*, "download"
// read as *load*, "against" as *again* and "capture" as *cap* — so a plan that
// says nothing at all about limits or growth was recorded as covering both, and
// on the real corpus 11 of 14 genuine silences went unreported. A trailing `*`
// means "this word and anything grown from it" (migrat* → migrate, migration,
// migrating); without it the whole word must stand alone.
const CATEGORIES = [
  { id: 'failure',    ask: 'what happens when it fails',        words: ['fail*', 'error*', 'crash*', 'retry*', 'timeout*', 'rollback*', 'roll back', 'exception*', 'goes wrong'] },
  { id: 'limits',     ask: 'how much is too much',              words: ['limit*', 'quota*', 'cap', 'caps', 'maximum', 'max', 'rate', 'rates', 'rate-limit*', 'throttl*', 'too many', 'size*'] },
  { id: 'permission', ask: 'who is allowed to do it',           words: ['who can', 'allow*', 'permission*', 'role', 'roles', 'actor*', 'access*', 'may not', 'forbidden'] },
  { id: 'repeat',     ask: 'what happens if it runs twice',     words: ['twice', 'duplicat*', 'idempot*', 'replay*', 'again', 'already', 'repeat*', 're-run', 'rerun*'] },
  { id: 'existing',   ask: 'what happens to what already exists',words: ['migrat*', 'backfill*', 'existing', 'already stored', 'upgrade*', 'old rows', 'historic*'] },
  { id: 'proof',      ask: 'how anyone knows it works',         words: ['test*', 'fixture*', 'golden', 'verif*', 'prove*', 'proof', 'assert*', 'check that', 'acceptance'] },
  { id: 'undo',       ask: 'how it is undone or deleted',       words: ['undo', 'undone', 'delete*', 'remove*', 'removal', 'revert*', 'erase*', 'erasure', 'retention', 'purge*', 'cancel*'] },
  { id: 'growth',     ask: 'what it looks like at ten times the size', words: ['scale*', 'scaling', 'grow*', 'growth', 'volume*', 'load', 'loads', 'how many', 'per second', 'concurren*', 'thousand*'] },
];

// `foo*` → the word and anything grown from it; `foo` → that word alone.
// Built once, because `silence` runs this over every plan in the register.
const CATEGORY_RE = new Map(CATEGORIES.map((c) => [c.id, new RegExp(
  c.words.map((w) => {
    const stem = w.endsWith('*') ? w.slice(0, -1) : w;
    const src = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ -]/g, '[ -]');
    return '\\b' + src + (w.endsWith('*') ? '[a-z]*' : '\\b');
  }).join('|'), 'i')]));

function silenceFile(p) {
  const text = readPlan(p);
  return CATEGORIES.filter((c) => !CATEGORY_RE.get(c.id).test(text));
}

// Every read of a plan file goes through here. A plan that has been renamed or
// moved since `load` used to come back as a raw ENOENT stack trace, which says
// nothing about what to do; this names the file and the way out.
function readPlan(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT')
      die('the plan ' + rel(p) + ' is on the register but not on disk — it has been renamed,\n' +
          '       moved or deleted since `load`. Re-run `load` with its new path, or restore it.');
    if (e && e.code === 'EISDIR') die(rel(p) + ' is a directory, not a plan file.');
    if (e && e.code === 'EACCES') die('cannot read the plan ' + rel(p) + ' — permission denied.');
    throw e;
  }
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
  commit(reg);
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
  // So `check` can tell "everything was judged" from "nothing was ever looked
  // at". An empty gap list means both, and only this says which.
  reg.scannedAt = now();
  commit(reg);
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
  commit(reg);
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
  commit(reg);
  console.log(g.id + '  ' + g.status + '  ' + g.scope + '  ' + (g.title || '(untitled)'));
}

function cmdResearch(id) {
  const reg = readReg(); const g = getGap(reg, id);
  const inp = stdinJson();
  g.research = Array.isArray(inp) ? inp : [inp];
  commit(reg);
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

// Each entry above is a STEM, and a stem only counts where a word starts. Held
// as bare substrings they matched inside ordinary English — "orm" sits in
// normal, format, information, performance and platform, "api" in rapid — so
// the linter refused plain words and, naming only the stem, never said which
// word of the question it had objected to. Anchored to a word start and run on
// to the end of that word, it catches the growths a stem is there for
// ("schema" in schemas, "authoris" in authorisation) and reports the word the
// writer actually used.
const JARGON_RE = new RegExp(
  '\\b(?:' + JARGON.map((j) => j.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[a-z]*', 'i');

const PATHY = /(^|\s|\()[\w.\-/]*\/[\w.\-/]+|\b\w+\.(md|ts|tsx|js|mjs|py|json|sql|toml|yaml|yml|sh|rs|go|java|rb)\b|`[^`]+`/i;

function words(s) { return s.trim().split(/\s+/).filter(Boolean); }

function lintText(label, s, maxWords) {
  const p = [];
  if (!s || !s.trim()) { p.push(label + ' is empty'); return p; }
  const w = words(s);
  if (w.length > maxWords) p.push(label + ' is ' + w.length + ' words, max ' + maxWords);
  if (PATHY.test(s)) p.push(label + ' names a file or path — say what it does instead');
  const j = s.match(JARGON_RE);
  if (j) p.push(label + ' uses "' + j[0] + '" — say what it does instead (see reference/plain-words.md)');
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
  commit(reg);
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
  commit(reg);
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

// The gate before the record gets written. It used to read status strings and
// nothing else, which made it a formality: an empty gap list satisfied every
// condition, and `set <id> status=answered` walked straight past it without an
// answer ever being recorded — after which `render` died with a raw TypeError
// on the very register `check` had just blessed. It now asks whether the work
// was actually done, not whether a word says so.
function cmdCheck() {
  const reg = readReg();
  const cand = reg.gaps.filter((g) => g.status === 'candidate');
  const unset = reg.gaps.filter((g) => g.scope === 'unset' && !['dropped', 'candidate'].includes(g.status));
  const open = reg.gaps.filter((g) => g.scope === 'in' && !['answered', 'dropped'].includes(g.status));
  // "answered" with nothing recorded under it is the state `render` cannot
  // read. A status is a claim; the answer is the evidence for it.
  const hollow = reg.gaps.filter((g) => g.status === 'answered' &&
    !(g.answer && typeof g.answer.choice === 'string' && g.answer.choice.trim()));
  let fail = false;
  if (!reg.plans.length) { console.error('✗ no plans loaded — nothing has been read, so nothing can be finished. Run `load`.'); fail = true; }
  else if (!reg.scannedAt) {
    console.error('✗ no scan has been run against these plans, so there is nothing to have judged.');
    console.error('  Read every plan in full, then run `scan` (and `silence`).');
    fail = true;
  }
  if (cand.length) { console.error('✗ ' + cand.length + ' candidate(s) never judged — keep or drop each one'); fail = true; }
  if (unset.length) { console.error('✗ ' + unset.length + ' gap(s) with no scope — in or out?'); fail = true; }
  if (open.length) { console.error('✗ ' + open.length + ' in-scope gap(s) unanswered:'); for (const g of open) console.error('    ' + g.id + '  ' + (g.title || g.quote.slice(0, 60))); fail = true; }
  if (hollow.length) {
    console.error('✗ ' + hollow.length + ' gap(s) marked answered with no answer recorded — a status is not a decision:');
    for (const g of hollow) console.error('    ' + g.id + '  ' + (g.title || g.quote.slice(0, 60)) + '   — run `answer ' + g.id + '`');
    fail = true;
  }
  if (fail) { console.error('\nnot finished. Do not report this session as done.'); process.exit(1); }
  const answered = reg.gaps.filter((g) => g.status === 'answered').length;
  console.log('✓ every candidate judged, every in-scope gap answered, ' + answered +
              ' answer(s) on record. Safe to write the record.');
}

// ------------------------------------------------------------------- render

function cmdRender(flags) {
  const reg = readReg();
  const done = reg.gaps.filter((g) => g.status === 'answered');
  if (!done.length) die('nothing answered yet');
  // Belt as well as braces: `check` refuses these now, but `render` can be run
  // without it, and a raw TypeError deep in the writer says nothing useful.
  const hollow = done.filter((g) => !(g.answer && typeof g.answer.choice === 'string' && g.answer.choice.trim()));
  if (hollow.length)
    die(hollow.length + ' gap(s) are marked answered with no answer recorded: ' +
        hollow.map((g) => g.id).join(', ') + '\n       Record each with `answer <id>`, or set it back to gap.');
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

// ------------------------------------------------------- shared decision text
// Standing decisions repeat across every task that must obey them. On a real
// 51-task run, 817 decision entries were only 131 distinct strings, and seven
// of them appeared on every single task — 413 KB of byte-identical repetition,
// 37% of the register, and now a cost in every event that carries one too. Long
// texts are interned once and referenced; short ones stay inline, because a
// reference is only worth it when it is shorter than the thing it replaces.
const DECISION_REF = /^@([0-9a-f]{12})$/;
function decisionPool(r) { return (r.decisionTexts ||= {}); }
function internDecision(r, text) {
  const t = String(text);
  if (t.length < 120) return t;
  const h = crypto.createHash('sha256').update(t).digest('hex').slice(0, 12);
  decisionPool(r)[h] = t;
  return '@' + h;
}
function decisionText(r, entry) {
  const m = DECISION_REF.exec(String(entry));
  if (!m) return String(entry);
  const t = (r.decisionTexts || {})[m[1]];
  return t === undefined ? '(a decision whose text is missing from the record — run rebuild)' : t;
}
function decisionsOf(r, t) { return (t.decisions || []).map((d) => decisionText(r, d)); }

function briefSha(t, r) {
  // exactly the fields the brief's text is built from — no more (a notes-only
  // change must not cry stale) and no less (a new orchestrator address must)
  return crypto.createHash('sha256').update(JSON.stringify({
    key: t.key, title: t.title, plan: t.plan, needs: t.needs, owns: t.owns,
    serialises: t.serialises || [], context: t.context, verify: t.verify,
    decisions: r ? decisionsOf(r, t) : t.decisions, branch: t.branch, orchestrator: (r && r.orchestrator) || '',
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
  commit(r);
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

// A serialisation point is a shared invariant named in prose by whoever wrote
// the task — "docker-compose.yml", "docker compose file", "Docker-Compose.yml".
// Comparing those by exact string equality is a check that can only ever fire
// when two authors typed the same characters, and on a real run it never fired
// once: a pre-flight found a docker-compose.yml collision this reported clean.
// Normalise before comparing; keep both spellings when reporting so the
// mismatch is visible and can be tidied.
function normPoint(s) { return String(s).trim().toLowerCase().replace(/\s+/g, ' '); }
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
    plans.push({ it, at, label });
  }
  // "two tasks may not touch one file" was asserted in the message above and
  // then never checked against another task. A path claimed twice is the one
  // failure this whole arrangement exists to prevent, so a NEW task claiming a
  // path some still-open task already owns is refused here, at the only moment
  // it is cheap to fix. Existing state is not re-judged — `doctor` reports that
  // — because a register with the collision already in it must stay usable.
  const contender = (t) => !['landed', 'cancelled'].includes(t.status);
  for (let n = 0; n < plans.length; n++) {
    const { it, at, label } = plans[n];
    if (at >= 0) continue;                       // an update, not a new claim
    for (const own of it.owns || []) {
      const clashes = [];
      for (const other of tasks(r)) {
        if (other.key === it.key || !contender(other)) continue;
        for (const b of other.owns || []) if (collides(own, b)) clashes.push(other.key + ' owns ' + b);
      }
      for (let m = 0; m < plans.length; m++) {
        if (m === n || plans[m].it.key === it.key) continue;
        for (const b of plans[m].it.owns || []) if (collides(own, b)) clashes.push(plans[m].it.key + ' (same batch) owns ' + b);
      }
      if (clashes.length)
        errs.push(label + ' claims ' + own + ', which is already owned: ' + [...new Set(clashes)].join('; ') +
          ' — two tasks may not touch one file. Narrow one of them, or make one wait for the other and split the file.');
    }
  }
  if (errs.length) die('nothing was saved:\n       ' + errs.join('\n       '));
  const said = [];
  for (const { it, at } of plans) {
    const ignored = Object.keys(it).filter((k) => k !== 'key' && !TASK_FIELDS.includes(k));
    const tail = ignored.length ? '   ignored: ' + ignored.join(', ') + ' (not settable here)' : '';
    if (at >= 0) {
      const t = tasks(r)[at];
      const touched = [];
      for (const k of TASK_FIELDS) if (it[k] !== undefined) {
        t[k] = k === 'decisions' ? it[k].map((d) => internDecision(r, d)) : it[k];
        touched.push(k);
      }
      said.push('updated ' + it.key + ': ' + (touched.join(', ') || '(nothing — no known field was sent)') + tail);
    } else {
      tasks(r).push({
        key: it.key, title: it.title, plan: it.plan || '', needs: it.needs || [],
        owns: it.owns, serialises: it.serialises || [], context: it.context || [],
        verify: it.verify || [], decisions: (it.decisions || []).map((d) => internDecision(r, d)), notes: it.notes || '',
        branch: it.branch || ('step/' + it.key), worktree: '', chip: '',
        status: 'planned', reports: [],
      });
      said.push('created ' + it.key + tail);
    }
  }
  commit(r);
  for (const line of said) console.log(line);
  console.log(tasks(r).length + ' task(s) on record. Run `graph` to check nothing clashes.');
}

function cmdGraph() {
  const r = readReg(); const ws = waves(r);
  if (!ws.length) die('no tasks yet');
  let bad = 0, pairs = 0, skipped = 0;
  const history = [];
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
      if (a.status === 'landed' || b.status === 'landed') {
        // Still worth naming: the pair is not a gating decision, but "these two
        // did share a file" is exactly the thing somebody reads this to find out.
        skipped++;
        const o = overlap(a, b), s = sharedPoints(a, b);
        if (o.length) history.push('Round ' + (w.wave + 1) + ': ' + a.key + ' ↔ ' + b.key + ' share ' + o.join('; '));
        if (s.length) history.push('Round ' + (w.wave + 1) + ': ' + a.key + ' ↔ ' + b.key + ' share serialisation point ' + s.join(', '));
        continue;
      }
      pairs++;
      const o = overlap(a, b);
      if (o.length) {
        bad++;
        lines.push('  ⚠ **' + a.key + '** and **' + b.key + '** would both change the same files: ' + o.join('; '));
        lines.push('    Split the work, or make one wait for the other. They cannot run together.');
      }
      // A shared file is the easy case. A shared invariant — a migration chain
      // head, a lockfile, a closed list some test asserts exact equality over —
      // collides in CI with zero file overlap.
      const shared = sharedPoints(a, b);
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
  // The all-clear used to be "Nothing clashes. Every round above can run side by
  // side." — an absolute sentence about a check that is anything but. Pairs
  // where either side has landed are skipped on purpose (merged work is not a
  // contender), so the same register says "nothing clashes" today and would
  // have said "these two collide" yesterday. Say what was actually looked at.
  if (history.length) {
    console.log('\nAlready merged, so not a gate — but it is what happened:');
    for (const h of history) console.log('  · ' + h);
  }
  const scope = pairs + ' pair(s) of tasks that could still collide were checked for shared files\n' +
    'and shared serialisation points' +
    (skipped ? ('; ' + skipped + ' pair(s) were skipped because one side has already landed.') : '.');
  if (bad) { console.error('\n' + bad + ' problem(s) — fix the plan before creating any chip.\n' + scope); process.exit(1); }
  console.log('\n✓ ' + scope);
  console.log('Nothing among them clashes, so every round above can run side by side.');
  if (skipped) console.log('That is not a statement about the run as a whole — a landed task is not re-judged.');
}


// ------------------------------------------------------------------ frontier
// The old rule was a round at a time. The better rule: open every task whose
// requirements have landed and whose files and serialisation points touch
// nothing that is currently open. Interference, not round membership, is what
// actually breaks parallel work.
function interference(t, other) {
  const files = overlap(t, other);
  const points = sharedPoints(t, other);
  return files.length || points.length ? { files, points } : null;
}
// A task is open — its files are in somebody's hands — from the moment it is
// handed out until it lands. This used to be keyed off `x.chip`, the chip id,
// which is bookkeeping and which the documented invocation never passes. The
// effect was that every gate reading this went dark: `frontier` saw nothing
// open, `chip` refused nothing, and two tasks owning one file both went ready
// with no complaint. Status is what actually says whether work is out there.
const OPEN_STATUSES = ['held', 'ready', 'reported'];
function openTasks(r, except) {
  return tasks(r).filter((x) => x.key !== except && OPEN_STATUSES.includes(x.status));
}


// ------------------------------------------------------------------ bundling
// One chip per step is the wrong grain. A chip pays a large fixed cost before it
// writes a line — its brief, and the whole plan behind it — and six sibling
// steps from one plan each pay it for the same plan. Measured on a real run:
// 33k tokens of reading per chip, of which a full megabyte across the run was
// siblings re-reading text a sibling had already read.
//
// Steps that share a plan and do not interfere with anything else can be one
// chip that works through them in order. A dependency BETWEEN them is not an
// obstacle — inside a single agent it is just the order to do them in, and it
// removes a merge, a CI run and a handover.
function bundleCandidates(r) {
  const byPlan = {};
  for (const t of tasks(r)) {
    if (t.status !== 'planned' || t.chip) continue;
    (byPlan[t.plan || '(none)'] ||= []).push(t);
  }
  const groups = [];
  for (const [plan, list] of Object.entries(byPlan)) {
    if (list.length < 2) continue;
    const keys = new Set(list.map((t) => t.key));
    // a group must be closed: nothing outside it may sit in the middle of its
    // dependency chain, or bundling would jump a queue that exists for a reason
    const closed = list.filter((t) => (t.needs || []).every((n) => {
      const d = depOf(r, n);
      return !d || d.status === 'landed' || keys.has(n);
    }));
    if (closed.length < 2) continue;
    // and it must not collide with work that is open right now
    const open = openTasks(r, null);
    const safe = closed.filter((t) => !open.some((o) => interference(t, o)));
    if (safe.length < 2) continue;
    // nor may two members claim the same serialisation point as each other and
    // still be split — that is another reason they belong together
    groups.push({ plan, members: safe });
  }
  return groups;
}

function cmdBundle(sub, rest, flags) {
  const r = readReg();
  // `bundle a b c --into a` — the first key is not a subcommand
  if (sub && !['suggest', 'do'].includes(sub)) { rest = [sub, ...rest]; sub = 'do'; }
  if (!sub || sub === 'suggest') {
    const groups = bundleCandidates(r);
    if (!groups.length) return console.log('nothing worth bundling — no plan has two or more unstarted, non-interfering steps.');
    let saved = 0;
    console.log('Steps that could be one chip instead of several. Each group shares a plan, so');
    console.log('one agent reads it once instead of every member reading it again.\n');
    for (const g of groups) {
      const keys = g.members.map((t) => t.key);
      const owns = new Set(g.members.flatMap((t) => t.owns || []));
      let planBytes = 0;
      try { planBytes = fs.statSync(path.resolve(CWD, g.plan)).size; } catch { /* gone */ }
      saved += planBytes * (g.members.length - 1);
      console.log('  ' + g.plan.replace(/^docs\/plans\//, ''));
      console.log('    ' + keys.join(' ') + '   → one chip, ' + owns.size + ' file(s)');
      console.log('    saves ' + (g.members.length - 1) + ' re-read(s) of a ' + Math.round(planBytes / 1024) + ' KB plan, ' +
                  (g.members.length - 1) + ' fewer merge(s) and CI run(s)');
      console.log('    bundle ' + keys.join(' ') + ' --into ' + keys[0]);
      console.log('');
    }
    console.log('Bundling all of the above: ' + (groups.reduce((n, g) => n + g.members.length - 1, 0)) +
                ' fewer chips, roughly ' + Math.round(saved / 4 / 1000) + 'k tokens of re-reading saved.');
    console.log('\nBundle what genuinely belongs together. Two steps that share a plan but nothing');
    console.log('else are still two jobs — the saving is not worth handing one agent an incoherent brief.');
    return;
  }
  if (!flags.into) die('bundle suggest | bundle <key> <key>... --into <key>');
  const keys = rest.filter(Boolean);
  if (keys.length < 2) die('name at least two tasks to bundle');
  const into = flags.into;
  if (!keys.includes(into)) die('--into must name one of the tasks being bundled');
  const members = keys.map((k) => getTask(r, k));
  for (const m of members) {
    if (m.status !== 'planned') die(m.key + ' is ' + m.status + ' — only unstarted work can be bundled');
    if (m.chip) die(m.key + ' already has a chip');
  }
  const host = getTask(r, into);
  const others = members.filter((m) => m.key !== into);
  const uniq = (xs) => [...new Set(xs)];
  host.owns = uniq(members.flatMap((m) => m.owns || []));
  host.serialises = uniq(members.flatMap((m) => m.serialises || []));
  host.verify = uniq(members.flatMap((m) => m.verify || []));
  host.decisions = uniq(members.flatMap((m) => m.decisions || []));
  host.context = uniq(members.flatMap((m) => (m.context || []).map((c) => JSON.stringify(c)))).map((x) => JSON.parse(x));
  host.needs = uniq(members.flatMap((m) => m.needs || []).filter((n) => !keys.includes(n)));
  // Bundling twice into the same host used to throw SyntaxError out of the
  // driver: the entries already on `host.bundled` are objects, and they were fed
  // to JSON.parse alongside the freshly stringified new ones.
  host.bundled = uniq([...(host.bundled || []), ...others.map((m) => ({ key: m.key, title: m.title }))]
    .map((x) => JSON.stringify(x))).map((x) => JSON.parse(x));
  host.title = host.title + ' (+ ' + others.map((m) => m.key).join(', ') + ')';
  // the absorbed tasks are cancelled, not deleted — the record keeps them
  for (const m of others) { m.status = 'cancelled'; m.bundledInto = into; }
  // A member's key still appears in OTHER tasks' `needs`, and nothing used to
  // repoint them. `waves` drops a cancelled task, so a dependent was never
  // placed and `graph` exited 1 for ever; `heldNeeds` reads a cancelled dep as
  // not-landed, so its chip could never open. The work did not disappear — it
  // moved to the host — so the dependency moves with it.
  const absorbed = new Set(others.map((m) => m.key));
  const repointed = [];
  for (const t of tasks(r)) {
    if (absorbed.has(t.key) || !(t.needs || []).some((n) => absorbed.has(n))) continue;
    t.needs = uniq(t.needs.map((n) => (absorbed.has(n) ? into : n))).filter((n) => n !== t.key);
    repointed.push(t.key);
  }
  // A pre-flight gap belongs to the files, not to the key that happened to own
  // them. Left behind on a cancelled member it stops being read, and `preflight
  // check` — which skips cancelled tasks — flipped from red to green because
  // the work was renamed rather than done.
  const pfs = members.map((m) => m.preflight).filter(Boolean);
  const neverFlown = members.filter((m) => !m.preflight).map((m) => m.key);
  if (pfs.length) {
    host.preflight = {
      at: now(),
      missing: uniq(pfs.flatMap((p) => p.missing || []).map((x) => JSON.stringify(x))).map((x) => JSON.parse(x)),
      verify: uniq(pfs.flatMap((p) => p.verify || []).map((x) => JSON.stringify(x))).map((x) => JSON.parse(x)),
      notes: pfs.map((p) => p.notes).filter(Boolean).join('\n'),
    };
  }
  // Everything else about a member moved to the host; its open problems and its
  // owed items have to move too, or they stay filed against a key nobody is
  // building. The brief is written from the host's record, so an unmoved defect
  // is one the agent doing that work never reads.
  const moved = { defects: [], owed: [] };
  for (const d of defectList(r))
    if (d.status === 'open' && others.some((m) => m.key === d.task)) {
      d.movedFrom = d.task; d.task = into; moved.defects.push(d.id);
    }
  for (const o of owedList(r))
    if (o.status === 'open' && others.some((m) => m.key === o.to)) {
      o.movedFrom = o.to; o.to = into; moved.owed.push(o.id);
    }
  commit(r);
  console.log('bundled ' + keys.join(' + ') + ' into ' + into);
  console.log('  owns ' + host.owns.length + ' file(s), ' + host.verify.length + ' check(s), waits for ' + (host.needs.join(', ') || 'nothing'));
  console.log('  ' + others.length + ' task(s) marked cancelled and recorded as absorbed — nothing was deleted.');
  if (moved.defects.length) console.log('  moved to ' + into + ': open defect(s) ' + moved.defects.join(' ') + ' — they are that agent\'s to fix now.');
  if (moved.owed.length) console.log('  moved to ' + into + ': owed item(s) ' + moved.owed.join(' ') + ' — put them in the brief.');
  if (repointed.length) console.log('  repointed at ' + into + ': ' + repointed.join(', ') +
    ' waited on an absorbed key. Without this they wait for ever on a cancelled task.');
  const openGaps = (host.preflight?.missing || []).filter((m) => m.loadBearing &&
    !(host.owns || []).some((o) => coveredBy(o, m.path)));
  if (pfs.length) console.log('  carried across: ' + (host.preflight.missing || []).length +
    ' pre-flight gap(s)' + (openGaps.length ? ', ' + openGaps.length + ' of them load-bearing and still outside `owns`' : ''));
  if (neverFlown.length) console.log('  ⚠ never pre-flighted: ' + neverFlown.join(', ') +
    ' — the host now owns their files on nobody\'s word. Run `preflight brief ' + into + '`.');
  console.log('\nRe-run `graph` and `preflight brief ' + into + '` — the brief now covers all of it.');
}

function cmdFrontier() {
  const r = readReg();
  const open = openTasks(r, null);
  const unblocksOf = (key) => tasks(r).filter((x) => (x.needs || []).includes(key)).length;
  const cands = tasks(r)
    .filter((t) => t.status === 'planned' && !t.chip && heldNeeds(r, t).length === 0)
    .sort((a, b) => unblocksOf(b.key) - unblocksOf(a.key) || (a.key < b.key ? -1 : 1));
  const accepted = [], blocked = [];
  for (const t of cands) {
    const against = [...open, ...accepted];
    const clash = against.map((o) => ({ o, i: interference(t, o) })).filter((x) => x.i);
    if (clash.length) blocked.push({ t, why: clash });
    else accepted.push(t);
  }
  const waiting = tasks(r).filter((t) => t.status === 'planned' && !t.chip && heldNeeds(r, t).length > 0);
  if (open.length) {
    console.log('Already open (' + open.length + '): ' + open.map((t) => t.key + '[' + t.status + ']').join('  '));
    console.log('');
  }
  if (accepted.length) {
    console.log('Can open RIGHT NOW, nothing they touch is in flight (' + accepted.length + '):');
    for (const t of accepted) console.log('  ' + t.key.padEnd(10) + t.title.slice(0, 50) + (unblocksOf(t.key) ? '   → unblocks ' + unblocksOf(t.key) : ''));
    console.log('\nFor each: preflight if not done, brief, then chip.');
  } else console.log('Nothing new can open right now.');
  if (blocked.length) {
    console.log('\nBuildable but held back — they would interfere:');
    for (const { t, why } of blocked) {
      for (const { o, i } of why) {
        const what = [...i.files, ...i.points.map((x) => 'serialisation point ' + x)].join('; ');
        console.log('  ' + t.key.padEnd(10) + '↔ ' + o.key + '  on ' + what);
      }
    }
  }
  if (waiting.length) console.log('\nStill waiting on work to land: ' + waiting.map((t) => t.key).join('  '));
  // CI checkpoints are no longer a hard gate, so keep the drift visible instead
  const unproven = unprovenLanded(r).length;
  if (unproven) {
    console.log('\n' + (unproven >= 5 ? '⚠ ' : '') + unproven + ' landing(s) since the last CI checkpoint.' +
      (unproven >= 5 ? ' That is a lot of unproven main line — record one at the next pause:' : ' Record one when the frontier pauses:'));
    console.log('  driver.mjs ci --status green --ref <run>   (or red, or skipped --why)');
  }
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


// One wrapper, generated into the project, so every agent queues for the
// machine the same way instead of six of them implementing six poll loops.
function ensureSlotWrapper() {
  const bin = orchDir('bin');
  const f = path.join(bin, 'with-ci-slot');
  const body = '#!/bin/sh\n' +
    '# Heavy checks share one machine: two full suites at once is a memory panic.\n' +
    '# This waits for the shared CI slot (checking every ~10s), takes it atomically,\n' +
    '# runs your command, and frees the slot even if the command fails or dies.\n' +
    'exec node "' + path.resolve(process.argv[1] || 'driver.mjs') + '" --register "' +
    path.resolve(CWD, REG_PATH) + '" slot run ci -- "$@"\n';
  fs.writeFileSync(f, body);
  fs.chmodSync(f, 0o755);
  return f;
}


// A check only needs the shared machine if running two of it at once would
// actually hurt. A linter reading files does not; a suite that takes a database,
// a build that eats the disk, or anything that binds a port does. Measured on a
// real run: 131 queued checks, 38 of them the same whole-repo lint, all waiting
// behind each other for no reason.
const HEAVY = /\b(pytest|jest|vitest|mocha|test|e2e|playwright|cypress|migrate|alembic|docker|compose|build|bundle|webpack|vite build|tsc --build|gradle|mvn|cargo (test|build)|make)\b/i;
const LIGHT = /\b(ruff|eslint|prettier|black|isort|flake8|mypy|pyright|tsc --noEmit|typecheck|fmt|lint|shellcheck|actionlint)\b/i;
// Installing dependencies is as heavy as anything here — it saturates the network,
// rewrites a shared store and can churn gigabytes of disk — and none of the words
// above appear in it, so `pnpm install` used to read as LIGHT and every agent was
// told to run one bare and in parallel. That is precisely the stampede the slot
// exists to stop, so installs are named outright and they outrank LIGHT.
const INSTALL = /\b(?:pnpm|npm|yarn|bun)\s+(?:ci|install|add|i)\b|\bpip3?\s+install\b|\bpoetry\s+(?:install|lock|sync)\b|\buv\s+(?:sync|lock|pip\s+install)\b|\bbundle\s+install\b|\bcargo\s+(?:fetch|vendor)\b|\bgo\s+mod\s+download\b|\bcomposer\s+install\b/i;
function needsSlot(cmd) {
  const c = String(cmd);
  if (INSTALL.test(c)) return true;
  if (LIGHT.test(c) && !HEAVY.test(c)) return false;
  return HEAVY.test(c) || /\bpnpm (run )?(test|build)\b|\bnpm (run )?(test|build)\b/.test(c);
}
// A whole-repo check run once per task is the same work N times. Where a command
// plainly takes paths, narrow it to what this task actually owns — the same idea
// as a path filter on a CI job.
const PATHABLE = /\b(ruff|eslint|prettier|black|isort|flake8|mypy|shellcheck)\b/;
// ...but only the files that tool can actually read. A task's `owns` list is
// whatever it touches — README.md, .env.example, package.json, a lockfile, a .sh —
// and handing those to ruff makes it parse them as Python and fail on line 1.
const TOOL_EXTS = [
  [/\b(?:ruff|black|isort|flake8|mypy)\b/, /\.pyi?$/],
  [/\beslint\b/,     /\.[cm]?[jt]sx?$/],
  [/\bshellcheck\b/, /\.(?:sh|bash|ksh|zsh)$/],
  [/\bprettier\b/,   /\.(?:[cm]?[jt]sx?|json|ya?ml|md|css|s[ac]ss|html)$/],
];
// And the tool's cwd is not always the repo root. `uv --directory apps/api run ruff
// check .` puts ruff in apps/api, while `owns` is repo-relative — so the paths have
// to be re-based onto that directory, and anything outside it dropped, or the tool
// is handed names that do not exist and reports a clean run over nothing.
const CWD_PREFIX = [/--directory[= ]([^\s]+)/, /--prefix[= ]([^\s]+)/, /\bcd\s+([^\s;&|]+)\s*&&/, /\s-C\s+([^\s]+)/];
const shPathArg = (p) => /^[\w@./+-]+$/.test(p) ? p : "'" + p.replace(/'/g, "'\\''") + "'";
function scopeToOwned(cmd, owns) {
  const c = String(cmd).trim();
  if (!PATHABLE.test(c)) return c;                     // not a tool that takes paths
  if (!/\s\.\s*$/.test(c)) return c;                    // only rewrite an explicit whole-tree "."
  let paths = (owns || []).filter((o) => o && !o.includes('*'));
  const ext = (TOOL_EXTS.find(([tool]) => tool.test(c)) || [])[1];
  if (ext) paths = paths.filter((p) => ext.test(p));
  for (const re of CWD_PREFIX) {
    const m = re.exec(c);
    if (!m) continue;
    const base = m[1].replace(/^\.\//, '').replace(/\/+$/, '') + '/';
    if (base === '/' || base === './') break;
    paths = paths.filter((p) => p.startsWith(base)).map((p) => p.slice(base.length));
    break;
  }
  // Nothing of ours that this tool can read: leave the whole-tree check alone
  // rather than narrow it down to an empty argument list that passes vacuously.
  if (!paths.length) return c;
  return c.replace(/\s\.\s*$/, ' ' + paths.map(shPathArg).join(' '));
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
  if ((t.bundled || []).length) {
    B.push('**This is several steps of one plan, given to you together** so the plan is read once');
    B.push('rather than once per step. Do them in this order, and say which you finished if you');
    B.push('cannot finish them all:');
    B.push('');
    B.push('- ' + t.key + ' — ' + String(t.title).replace(/ \(\+ [^)]*\)$/, ''));
    for (const b of t.bundled) B.push('- ' + b.key + ' — ' + b.title);
    B.push('');
  }
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
    // resolved here — an agent must never be handed a reference it cannot read
    B.push('**Already settled with the author. Do not reopen, do not improve on:**');
    B.push('');
    for (const d of decisionsOf(r, t)) B.push('- ' + d);
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
  const wrapper = ensureSlotWrapper();
  B.push('**Before you say you are done, all of these must pass, and you must paste the output.**');
  B.push('');
  B.push('The machine is shared, but not every check needs it. A linter reading files can run');
  B.push('alongside anything; a suite that takes a database or a build that eats the disk cannot.');
  B.push('So the cheap ones run straight away and the heavy ones go through the slot wrapper, which');
  B.push('waits its turn (checking every ~10 seconds), runs your command, and frees the slot by');
  B.push('itself even if the run fails or you crash.');
  B.push('');
  B.push('Never run a heavy check bare, and never empty the slot by hand — another agent\'s run may');
  B.push('be inside it, and freeing under it causes the exact crash the slot exists to stop. If the');
  B.push('wait ever times out, say so and ask — do not run without the slot.');
  B.push('');
  const vlist = t.verify || [];
  const heavy = vlist.filter(needsSlot), light = vlist.filter((v) => !needsSlot(v));
  B.push('```bash');
  if (!vlist.length) B.push('# ⚠ nothing recorded. Ask what counts as proof before you start.');
  if (light.length) {
    B.push('# these are cheap and read-only — run them straight away, no queueing');
    for (const v of light) B.push(scopeToOwned(v, t.owns));
  }
  if (heavy.length) {
    if (light.length) B.push('');
    B.push('# these take the machine, so they go through the slot, one at a time');
    for (const v of heavy) B.push('"' + wrapper + '" ' + v);
  }
  B.push('```');
  B.push('');
  B.push('**Then commit your work on your branch.** One clear message, no attribution trailers.');
  B.push('');
  B.push('**If it is not clean, say so — do not round it up.** `outcome` takes `partial` or');
  B.push('`failed`, and either opens a record against this task that stays visible until somebody');
  B.push('deals with it. A half-passing run reported as passing is the one thing here that wastes');
  B.push('everybody\'s time, because the next piece gets built on it.');
  B.push('');
  B.push('**Then report, both ways — the message is how it hears, the list is what survives:**');
  B.push('');
  B.push('```bash');
  B.push('node ~/.claude/skills/orchestrate-implementation/driver.mjs --register \'' +
         path.resolve(CWD, REG_PATH) + '\' done \'' + t.key + '\' <<\'J\'');
  B.push('{"commit": "<sha>",');
  B.push(' "verified": "<what you ran and what it said>",');
  B.push(' "outcome": "passed",');
  B.push(' "notes": "<anything the next one needs>"}');
  B.push('J');
  B.push('```');
  B.push('');
  B.push('`outcome` is `passed`, `partial` or `failed`. It is JSON, so do not put a comment in it.');
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
  const sha = briefSha(t, r);
  // `brief --all` is the command `resume` tells you to run after a dead session,
  // and it used to stamp briefAt on every task every time — so twenty tasks
  // burned twenty of the thirty backup slots, and two runs wiped the ring that
  // is the register's only history. An unchanged brief now writes nothing.
  let unchanged = t.briefSha === sha && t.briefFile === out;
  if (unchanged) { try { unchanged = fs.readFileSync(out, 'utf8') === body; } catch { unchanged = false; } }
  if (!unchanged) {
    fs.writeFileSync(out, body);
    t.briefSha = sha; t.briefAt = now(); t.briefFile = out;
    commit(r);
  }
  console.log((unchanged ? 'unchanged ' : 'wrote ') + out);
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
  let same = 0;
  for (const t of tasks(r)) {
    if (['cancelled', 'landed'].includes(t.status)) continue;
    const before = t.briefSha;
    cmdBriefQuiet(t.key);
    n++;
    if (getTask(readReg(), t.key).briefSha === before) same++;
    const now2 = getTask(readReg(), t.key).briefSha;
    if (before && before !== now2) console.log('  changed: ' + t.key + '  → any chip already holding it is out of date');
  }
  console.log(n + ' brief(s) checked in ' + orchDir('briefs') + '; ' + (n - same) + ' rewritten, ' + same + ' already current.');
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
  commit(r);
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
    // "not handed out yet" is a status, not the presence of a chip id — the id
    // is optional bookkeeping, and reading it here picked the wrong round
    // whenever one had not been passed.
    const cand = ws.find((w) => w.tasks.some((t) => t.status === 'planned'));
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
// The register is the working state; the record is the history. Detail from
// finished work is neither, and on a long run it is most of the file — reports,
// pre-flights, context notes and decision references on tasks that are landed
// or cancelled. It moves out to a file beside the run.
//
// This is safe because of how the record works, and it was checked before it
// was written: `commit` diffs the register and appends the resulting ops, and a
// removed field becomes a delete op (diffOps, `{p, d: 1}`), so replaying the
// record reproduces the SLIM register rather than fighting it — `verify` stays
// clean. The values are not lost either: the events that originally set them
// are untouched, so `rebuild --to <seq>` from before the archive brings
// everything back. Two independent copies, the archive file and the record.
//
// Gaps stay. Answered ones are read by `refine brief` as what was already
// settled with the author, so archiving them would change a brief that has not
// been written yet.
const ARCHIVE_FIELDS = ['reports', 'preflight', 'context', 'decisions'];
function archiveDir() { return path.join(path.dirname(path.resolve(CWD, REG_PATH)), 'archive'); }

function cmdArchive(flags) {
  const r = readReg();
  const closed = tasks(r).filter((t) => DEAD_STATUS.includes(t.status));
  const rows = [];
  for (const t of closed) {
    const keep = {};
    for (const f of ARCHIVE_FIELDS) {
      const v = t[f];
      if (v === undefined || (Array.isArray(v) && !v.length)) continue;
      keep[f] = v;
    }
    if (Object.keys(keep).length) rows.push({ key: t.key, status: t.status, ...keep });
  }
  if (!rows.length) return console.log('nothing to archive — no closed task is still carrying its detail.');
  const before = JSON.stringify(r).length;
  const saved = JSON.stringify(rows).length;
  if (flags['dry-run']) {
    console.log(rows.length + ' closed task(s) are still carrying ' + Math.round(saved / 1024) + ' KB of finished detail');
    console.log('(the register is ' + Math.round(before / 1024) + ' KB):\n');
    for (const x of rows)
      console.log('  ' + x.key.padEnd(12) + x.status.padEnd(11) + Object.keys(x).filter((k) => !['key', 'status'].includes(k)).join(', '));
    console.log('\nNothing was written. Run `archive` without --dry-run to move it.');
    return;
  }
  // The file lands before the register loses anything, so no crash can cost
  // both copies at once — the same order `writeReg` keeps for its backups.
  fs.mkdirSync(archiveDir(), { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(archiveDir())) {
    const m = /^tasks-([0-9]+)\.json$/.exec(f);
    if (m) n = Math.max(n, Number(m[1]));
  }
  const file = path.join(archiveDir(), 'tasks-' + String(n + 1).padStart(2, '0') + '.json');
  fs.writeFileSync(file, JSON.stringify({ at: now(), register: rel(REG_PATH), tasks: rows }, null, 2) + '\n');
  for (const t of closed) for (const f of ARCHIVE_FIELDS) delete t[f];
  commit(r);
  const after = JSON.stringify(r).length;
  console.log('archived ' + rows.length + ' closed task(s) to ' + rel(file));
  console.log('  register ' + Math.round(before / 1024) + ' KB → ' + Math.round(after / 1024) + ' KB (' +
              Math.round((before - after) / before * 100) + '% smaller). The 30 backups turn over at the new size.');
  console.log('\nNothing is lost. That file has it, and so does the record — `events --task <key>` shows');
  console.log('which entries carry it, and `rebuild --to <seq>` from before now reproduces the register');
  console.log('exactly as it was. `verify` still passes, because a removal is recorded like any other change.');
}

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
  // `task add` refuses a new claim on a path some other open task already owns.
  // Nothing ever looked at what was already on record, and on a real run 52 of
  // 203 owned paths turned out to be claimed twice, one of them seven times.
  // This is the only place that says so.
  const open = tasks(r).filter((t) => !['landed', 'cancelled'].includes(t.status));
  const dup = [];
  for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
    const o = overlap(open[i], open[j]);
    if (o.length) dup.push(open[i].key + ' ↔ ' + open[j].key + '   ' + o.join('; '));
  }
  if (dup.length) {
    bad += dup.length;
    console.log('✗ ' + dup.length + ' pair(s) of open tasks claim the same path:');
    for (const x of dup.slice(0, 40)) console.log('    ' + x);
    if (dup.length > 40) console.log('    … and ' + (dup.length - 40) + ' more.');
    console.log('    Ownership is the rule everything else rests on. Narrow one side of each pair,');
    console.log('    or make one wait for the other — they cannot both be handed out.');
  }
  // Duplicates where one side has already merged are history, not a gate — but
  // the count says how often the rule was broken while nothing was checking.
  const everything = tasks(r).filter((t) => t.status !== 'cancelled');
  let past = 0;
  for (let i = 0; i < everything.length; i++) for (let j = i + 1; j < everything.length; j++)
    if ((everything[i].status === 'landed' || everything[j].status === 'landed') &&
        overlap(everything[i], everything[j]).length) past++;
  if (past) console.log('· ' + past + ' further pair(s) share a path with work that has already landed — history, not a gate.');
  // A serialisation point is a claim about something two tasks share. One named
  // by a single task is either a typo for somebody else's spelling, or a note
  // that gates nothing — and it reads, wrongly, like a live constraint.
  const byPoint = new Map();
  for (const t of open) for (const s of t.serialises || []) {
    const e = byPoint.get(normPoint(s)) || { keys: new Set(), spellings: new Set() };
    e.keys.add(t.key); e.spellings.add(s);
    byPoint.set(normPoint(s), e);
  }
  const lone = [...byPoint.entries()].filter(([, e]) => e.keys.size === 1);
  if (lone.length) {
    console.log('· ' + lone.length + ' serialisation point(s) only one task names:');
    for (const [, e] of lone) console.log('    ' + [...e.spellings][0] + '   (' + [...e.keys][0] + ' alone)');
    console.log('    A point nobody else claims gates nothing. Either another task should be naming');
    console.log('    it — check the spelling against theirs — or it does not belong in `serialises`.');
  }
  // An owed item outlives the task it was assigned to, and nothing else looks.
  const shut = allShutWindows(r);
  if (shut.length) {
    bad += shut.length;
    console.log('✗ ' + shut.length + ' owed item(s) assigned to work that is over:');
    for (const o of shut) console.log('    ' + o.id + ' → ' + o.to + ' (' + o.carrierStatus + ')' +
      (o.loadBearing ? '  LOAD-BEARING' : '') + '  ' + String(o.what || '').replace(/\s+/g, ' ').slice(0, 100));
    console.log('    Their window is shut. Reassign or settle each — `owed list` shows them as SHUT.');
  }
  // A tick over nothing checked is how a green report starts meaning nothing.
  if (!bad && !checked) console.log('· nothing to check — every task is landed, cancelled, or not yet handed out.\n  Run this again when work is about to go out; it proves nothing right now.');
  else if (!bad) console.log('✓ ' + checked + ' task(s): every cited path exists, every verify binary resolves, no brief is stale.');
  console.log('\nWhat this cannot see: a verify target that is unreachable (a database down, a service');
  console.log('not started), and any number quoted in a note. Run each verify once by hand before a');
  console.log('brief asserts it, and never put a number in a brief that the run itself can change —');
  console.log('write where to read it instead.');
  if (bad) { console.error('\n' + bad + ' problem(s). Fix the record (`brief --all` after), reassign or settle any shut\n' +
    'owed item, then run doctor again.'); process.exit(1); }
}

// --------------------------------------------------------------------- owed
// Work that is only possible in a window between two pieces, recorded so the
// window closing is a decision somebody made rather than a thing nobody saw.
function owedList(r) { return (r.owed ||= []); }

// An owed item is work that is only possible while some other piece is still
// open. When the task carrying it lands, that window is shut: the item is still
// owed, it simply has nobody left to do it. Landing must NOT settle it — that
// would make the loss automatic. It surfaces instead, which is the whole point
// of the list: a window closing should be a decision somebody made.
// Cancelled counts as shut too: a task absorbed by a bundle, or dropped, is not
// going to carry anything either. Only the wording differs.
const DEAD_STATUS = ['landed', 'cancelled'];
function shutWindows(r, key) {
  const t = tasks(r).find((x) => x.key === key);
  if (!t || !DEAD_STATUS.includes(t.status)) return [];
  return owedList(r).filter((o) => o.status === 'open' && o.to === key);
}
function allShutWindows(r) {
  const dead = new Map(tasks(r).filter((t) => DEAD_STATUS.includes(t.status)).map((t) => [t.key, t.status]));
  return owedList(r).filter((o) => o.status === 'open' && o.to && dead.has(o.to))
                    .map((o) => ({ ...o, carrierStatus: dead.get(o.to) }));
}


// ------------------------------------------------------------------ defects
// A failure used to survive only as prose in the ledger — and worse, sending
// work back cleared the agent's unanswered question, so rejecting work made it
// invisible. A defect is a record: it has an id, it names the task, and nothing
// closes over it silently.
const DEFECT_KINDS = ['sendback', 'guard', 'ci', 'blocked', 'bug'];
function defectList(r) { return (r.defects ||= []); }
function nextDefectId(r) {
  const n = defectList(r).reduce((m, d) => Math.max(m, parseInt(String(d.id).slice(1), 10) || 0), 0);
  return 'd' + String(n + 1).padStart(2, '0');
}
// Returns the record. Callers must writeReg themselves — several of these fire
// inside commands that are otherwise read-only.
function recordDefect(r, { task, kind, what, evidence, blocking }) {
  const d = {
    id: nextDefectId(r), task: task || '', kind,
    what: String(what || '').slice(0, 500), evidence: String(evidence || '').slice(0, 2000),
    blocking: blocking !== false, status: 'open', at: now(), resolvedAt: '',
  };
  defectList(r).push(d);
  return d;
}
function openDefects(r, key) {
  return defectList(r).filter((d) => d.status === 'open' && (!key || d.task === key));
}

function cmdDefect(sub, rest, flags) {
  const r = readReg();
  if (sub === 'add') {
    const what = strFlag(flags, 'what', 'defect add --task <key> --kind <' + DEFECT_KINDS.join('|') + '> --what "..." [--evidence "..."] [--not-blocking]');
    const kind = flags.kind || 'bug';
    if (!DEFECT_KINDS.includes(kind)) die('--kind must be one of: ' + DEFECT_KINDS.join(', '));
    if (flags.task !== undefined) { if (typeof flags.task !== 'string') die('--task needs a key'); getTask(r, flags.task); }
    const d = recordDefect(r, { task: flags.task || '', kind, what,
                                evidence: flags.evidence === undefined ? ''
                                  : strFlag(flags, 'evidence', '--evidence was given with nothing in it — leave it off, or say what you saw'),
                                blocking: !flags['not-blocking'] });
    commit(r);
    console.log(d.id + '  ' + d.kind + (d.task ? '  ' + d.task : '') + (d.blocking ? '  (blocking)' : ''));
    console.log('It stays on `outstanding` until you run: defect fixed ' + d.id);
    return;
  }
  if (sub === 'fixed') {
    const d = defectList(r).find((x) => x.id === rest[0]);
    if (!d) die('no defect ' + rest[0] + ' (have: ' + defectList(r).map((x) => x.id).join(', ') + ')');
    if (d.status === 'fixed') return console.log(d.id + ' was already marked fixed at ' + d.resolvedAt);
    d.status = 'fixed'; d.resolvedAt = now();
    commit(r);
    console.log(d.id + ' marked fixed.');
    return;
  }
  if (sub === 'list') {
    const all = defectList(r);
    const show = flags.all ? all : all.filter((d) => d.status === 'open');
    if (!show.length) return console.log(flags.all ? 'no defects recorded.' : 'no open defects.');
    for (const d of show) {
      console.log((d.status === 'open' ? '✗' : '·') + ' ' + d.id + '  ' + d.kind.padEnd(9) +
        (d.task || '-').padEnd(10) + (d.blocking && d.status === 'open' ? '[blocking] ' : '') + d.what.slice(0, 60));
      if (d.evidence) console.log('     ' + d.evidence.split('\n')[0].slice(0, 76));
    }
    console.log('\n' + show.length + (flags.all ? ' total.' : ' open. `defect list --all` for the rest.'));
    return;
  }
  die('defect add|fixed <id>|list [--all]');
}

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
    commit(r);
    console.log(id + ' recorded' + (flags.to ? ', assigned to ' + flags.to : ' — UNASSIGNED. An owed item nobody owns is one the window closes on.'));
  } else if (sub === 'assign') {
    const o = owedList(r).find((x) => x.id === rest[0]); if (!o) die('no owed item ' + rest[0]);
    if (!flags.to) die('need --to <task key>');
    // Assigning to work that is over is how an item is lost while looking
    // settled: `owed list` shows it SHUT again the moment it is written, and the
    // advice printed here — put it in that task's brief — cannot be followed.
    const carrier = getTask(r, flags.to);
    if (['landed', 'cancelled'].includes(carrier.status))
      die(flags.to + ' is ' + carrier.status + ' — its window is already shut, so it cannot carry ' +
        o.id + '.\n       Assign it to work that is still open (`frontier` says which), or settle it: owed done ' + o.id);
    o.to = flags.to; commit(r);
    console.log(o.id + ' → ' + flags.to + '. Put it in that task\'s brief — an assignment the agent never sees is not one.');
  } else if (sub === 'done') {
    const o = owedList(r).find((x) => x.id === rest[0]); if (!o) die('no owed item ' + rest[0]);
    o.status = 'done'; o.doneAt = now(); commit(r); console.log(o.id + ' settled.');
  } else if (sub === 'list' || sub === undefined) {
    const os = owedList(r);
    if (!os.length) return console.log('nothing is owed.');
    const shut = new Set(allShutWindows(r).map((o) => o.id));
    for (const o of os) {
      const to = o.to ? '→ ' + o.to + (shut.has(o.id) ? ' SHUT' : '') : 'UNASSIGNED';
      console.log(o.id + '  ' + o.status.padEnd(6) + (o.loadBearing ? 'LOAD-BEARING  ' : '              ') +
        to.padEnd(19) + o.what);
      if (o.status === 'open') console.log('      why: ' + o.why + (o.window ? '   window: ' + o.window : ''));
    }
    const sh = allShutWindows(r);
    if (sh.length) {
      console.log('\n' + sh.length + ' item(s) marked SHUT: the task they were assigned to has landed or been');
      console.log('cancelled, so nothing is carrying them any more. ' + sh.filter((o) => o.loadBearing).length +
                  ' of those is load-bearing.');
      console.log('Reassign each to work that is still open, or settle it — leaving it is the loss.');
    }
  } else die('owed add|assign <id> --to <key>|done <id>|list');
}


// --------------------------------------------------------------------- slots
// Six agents running the full suite at once is a memory panic. A slot is a
// shared, single-holder claim on something the machine can only do once at a
// time. Taking it is atomic (mkdir — only one wins), freeing is tied to the
// holder's process exiting rather than to anyone remembering, and a holder
// that died or held too long is stolen. Slot commands never read the register,
// so waiting on a slot never blocks anyone else's bookkeeping.
function slotLockPath(name) {
  const d = path.join(path.dirname(REG_PATH), 'slots');
  fs.mkdirSync(d, { recursive: true });
  // A steal that is killed between the rename and the delete leaves the carried-off
  // claim behind. It holds nothing and nothing reads it, so sweep the old ones.
  try {
    for (const f of fs.readdirSync(d)) {
      if (!f.includes('.evicted.')) continue;
      const p = path.join(d, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 600000) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
  return path.join(d, slug(name) + '.lock');
}
function slotHolder(lock) {
  try { return JSON.parse(fs.readFileSync(path.join(lock, 'holder.json'), 'utf8')); } catch { return null; }
}
// Every claim carries a token nobody else can guess. It is what makes "free this
// slot" mean "free the claim I took" rather than "delete whatever is at that path"
// — the difference between a process tidying up after itself and an evicted one
// wiping out the run that replaced it.
function slotToken() {
  return crypto.randomBytes(9).toString('hex') + '-' + process.pid;
}
// `manual` marks a claim taken by `slot take`, where the process that wrote the
// claim exits immediately by design. Judging such a claim by whether its pid is
// still alive declares it dead a moment after it is made, which is no exclusion
// at all — so a manual take records no pid to check and lives on the time limit.
function slotTryTake(name, task, { manual = false } = {}) {
  const lock = slotLockPath(name);
  try { fs.mkdirSync(lock, { recursive: false }); } catch { return null; }
  const claim = {
    token: slotToken(), manual: !!manual, pid: manual ? null : process.pid,
    host: os.hostname(), task: task || '', since: now(),
  };
  // Written by rename so a waiter never reads a half-written claim and mistakes
  // it for the "holder unknown" leftover case.
  const tmp = path.join(lock, 'holder.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(claim, null, 2) + '\n');
  fs.renameSync(tmp, path.join(lock, 'holder.json'));
  return { lock, token: claim.token };
}
// Never steal from a holder we can prove is alive. A suite that legitimately runs
// past the time limit is still running: taking its slot away starts a second one
// beside it, which is the crash this whole mechanism exists to prevent. So the
// liveness question is asked FIRST, and the time limit applies only to a holder
// whose liveness cannot be established — a different host, or no pid to check.
function slotIsStale(lock, staleMs) {
  const h = slotHolder(lock);
  if (!h) { try { return Date.now() - fs.statSync(lock).mtimeMs > 10000; } catch { return false; } }
  if (h.pid && h.host === os.hostname()) {
    try { process.kill(h.pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
    // EPERM means the process is there and owned by someone else: alive, not ours to judge.
  }
  return Date.now() - Date.parse(h.since || 0) > staleMs;
}
// Take a stale claim away by renaming the whole lock directory out of the path.
// Rename is atomic and only one racer can win it, so two waiters cannot both
// conclude they evicted the holder and both proceed — which check-then-rmSync let
// them do. The token we judged is checked against what we actually carried off;
// if a fresh claim slipped in between the judgement and the rename, it is put
// straight back and we go on waiting.
function slotSteal(lock, judgedToken) {
  const carried = lock + '.evicted.' + process.pid + '.' + Date.now();
  try { fs.renameSync(lock, carried); } catch { return false; }   // someone else got there first
  const got = slotHolder(carried);
  if (got && judgedToken && got.token !== judgedToken) {
    try {                                       // not the claim we judged — hand it back
      fs.mkdirSync(lock, { recursive: false });
      fs.renameSync(path.join(carried, 'holder.json'), path.join(lock, 'holder.json'));
      fs.rmSync(carried, { recursive: true, force: true });
      return false;
    } catch {
      console.error('slot: a claim changed hands mid-eviction and could not be restored.');
    }
  }
  fs.rmSync(carried, { recursive: true, force: true });
  return true;
}
// Free only what we hold. `expect` is the token from our own take; if the claim
// sitting there now is somebody else's, we were evicted long ago and deleting it
// would drop a live run's protection on the floor.
function slotDrop(lock, expect) {
  const h = slotHolder(lock);
  if (expect && h && h.token && h.token !== expect) return false;
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* already gone */ }
  return true;
}
function describeHolder(lock) {
  const h = slotHolder(lock);
  if (!h) return 'held (holder unknown — claim being written, or leftover)';
  const mins = Math.round((Date.now() - Date.parse(h.since || 0)) / 60000);
  return 'held by ' + (h.task || (h.pid ? 'pid ' + h.pid : 'a manual take')) + ' on ' + h.host +
         ' for ' + mins + ' min' + (h.manual ? ' (taken by hand)' : '');
}

// The command after `--` is handed to bash, so every word has to be quoted or a
// path with a space becomes two arguments. But quoting the FIRST word turns a
// leading `FOO=1` into a command named "FOO=1" — and the register is full of
// verify lines in exactly that shape, so `slot run ci -- FOO=1 ./scripts/test`
// died with "FOO=1: command not found" before it ran anything at all.
//
// Shell grammar says a leading run of NAME=value words are assignments and the
// first word that is not one is the command, so reproduce that: keep the names
// bare, quote the values, quote everything after.
const SH_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
function bashCommandLine(raw) {
  const words = raw.map(String);
  const out = [];
  let i = 0;
  for (; i < words.length; i++) {
    const m = SH_ASSIGN.exec(words[i]);
    if (!m) break;
    out.push(m[1] + '=' + shq(m[2]));
  }
  for (; i < words.length; i++) out.push(shq(words[i]));
  return out.join(' ');
}

function cmdSlot(sub, rest, flags, raw) {
  const name = rest[0] || 'ci';
  const lock = slotLockPath(name);
  const staleMs = (numFlag(flags, 'stale', { min: 1, what: 'a whole number of minutes' }) ?? 30) * 60000;

  if (sub === 'status') {
    const d = path.dirname(lock);
    const all = fs.readdirSync(d).filter((f) => f.endsWith('.lock'));
    if (!all.length) return console.log('no slot is held.');
    for (const f of all) console.log(f.replace(/\.lock$/, '') + ': ' + describeHolder(path.join(d, f)));
    return;
  }
  if (sub === 'free') {
    if (!fs.existsSync(lock)) return console.log(name + ' is already free.');
    const held = slotHolder(lock);
    // The `--force` guard exists for one case: a `slot run` holder with a live
    // command inside it. A claim taken by hand has no run inside it — the process
    // that took it exited on purpose — so freeing one plainly is the normal path
    // and does not need the flag whose refusal is the load-bearing part.
    const byHand = !!(held && held.manual);
    if (!flags.force && !byHand && !slotIsStale(lock, staleMs))
      die(name + ' is ' + describeHolder(lock) + " — its run may be inside it right now.\n" +
          '       Freeing under a live run causes the exact crash the slot exists to stop.\n' +
          '       If you are certain the holder is gone: slot free ' + name + ' --force');
    // Drop the claim we just looked at, not whatever happens to be at that path by
    // the time the rm runs — otherwise a slow decision deletes somebody's fresh run.
    if (!slotDrop(lock, held && held.token))
      return console.log(name + ' changed hands while we looked — it is now ' + describeHolder(lock) + ', left alone.');
    console.log(name + ' freed.');
    return;
  }
  if (sub === 'take') {
    const got = slotTryTake(name, flags.task, { manual: true });
    if (got) return console.log(name + ' taken. Free it the moment you are done: slot free ' + name +
      '\n(--force is only for a slot whose holder you know is gone — do not reach for it by habit.)');
    die(name + ' is ' + describeHolder(lock) + '. Prefer `slot run` — it frees itself.');
  }
  if (sub === 'wait' || sub === 'run') {
    if (sub === 'run' && !raw.length) die('slot run ' + name + ' -- <command> — the command goes after the --');
    const timeoutMs = (Number(flags.timeout) > 0 ? Number(flags.timeout) : 90) * 60000;
    const t0 = Date.now();
    let told = false;
    let mine = null;
    for (;;) {
      mine = slotTryTake(name, flags.task);
      if (mine) break;
      const held = slotHolder(lock);
      if (slotIsStale(lock, staleMs)) {
        if (slotSteal(lock, held && held.token))
          console.error('slot ' + name + ': holder is gone, or unreachable and over the ' +
                        Math.round(staleMs / 60000) + ' min limit — taking over.');
        continue;
      }
      if (Date.now() - t0 > timeoutMs)
        die('slot ' + name + ' still ' + describeHolder(lock) + ' after ' + Math.round(timeoutMs / 60000) +
            ' min.\n       Something is wedged — check `slot status` and talk to the orchestrator. Do NOT run without the slot.');
      if (!told) { console.error('slot ' + name + ': ' + describeHolder(lock) + ' — waiting, checking every ~10s.'); told = true; }
      // ~10s with jitter, so a crowd of waiters does not stampede the same instant
      try { execSync('sleep ' + (8 + Math.floor(Math.random() * 5))); } catch { /* keep waiting */ }
    }
    // Free our own claim by its token. If we were evicted while the suite ran, the
    // lock now belongs to whoever replaced us and is not ours to delete.
    const free = () => { try { slotDrop(mine.lock, mine.token); } catch { /* gone */ } };
    if (sub === 'wait') { free(); return console.log(name + ' became free.'); }
    process.on('exit', free);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { free(); process.exit(130); });
    const q = bashCommandLine(raw);
    console.error('slot ' + name + ': taken — running: ' + raw.join(' '));
    const res = spawnSync('/bin/bash', ['-c', q], { stdio: 'inherit', cwd: process.cwd() });
    free();
    console.error('slot ' + name + ': freed.');
    process.exit(res.status === null ? 1 : res.status);
  }
  die('slot run <name> -- <cmd> | status | wait <name> | take <name> | free <name> [--force]   (default name: ci)');
}

// -------------------------------------------------------------- wave gating
// A wave is finished when every task in it has landed AND the main line has
// been through CI. Not before, and no chip of the next wave exists until then.

// A run's result used to be filed under a round number. Round numbers are a
// position in a topological sort of the whole task graph, so adding one task
// renumbers every round after it — and the record for one round silently
// becomes the record for another. A checkpoint instead names the task keys it
// actually covered, which stays true no matter what is added later.
function checkpoints(r) { return (r.checkpoints ||= []); }
function nextCheckpointId(r) {
  const n = checkpoints(r).reduce((m, c) => Math.max(m, parseInt(String(c.id).slice(1), 10) || 0), 0);
  return 'c' + String(n + 1).padStart(2, '0');
}
// A task is proven when a green checkpoint covering it was recorded after it
// landed. Nothing needs deleting when new work lands — it is simply not covered
// yet, which is the truth rather than an erasure.
function provenAt(r, t) {
  if (!t.landedAt) return null;
  return checkpoints(r).find((c) => ['green', 'skipped'].includes(c.status) &&
    (c.covers || []).includes(t.key) && Date.parse(c.at) >= Date.parse(t.landedAt)) || null;
}
function unprovenLanded(r) {
  return tasks(r).filter((t) => t.status === 'landed' && !provenAt(r, t));
}

function waveOf(r, key) {
  for (const w of waves(r)) if (w.tasks.some((t) => t.key === key)) return w.wave;
  return -1;
}
function waveState(r, n) {
  const w = waves(r).find((x) => x.wave === n);
  if (!w) return null;
  const landed = w.tasks.filter((t) => t.status === 'landed');
  const ci = landed.length ? provenAt(r, landed[landed.length - 1]) : null;
  const allCovered = landed.length > 0 && landed.every((t) => provenAt(r, t));
  return { n, tasks: w.tasks, landed, allLanded: landed.length === w.tasks.length, ci,
           green: allCovered };
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

// Results used to be filed under a round number in `r.ci`. When checkpoints
// replaced that, every reader went with it and the data stayed — eight real
// runs, with their references and the reasoning about what was contention and
// what was code, that nothing in the tool could reach any more.
//
// They cannot be converted honestly. A checkpoint's `covers` is the whole
// point of it, and a round number cannot be turned back into the task keys it
// meant, because rounds renumber — that is why they were abandoned. So they
// come across with `covers: []`, which is not a gap in the import: it says
// they prove nothing that can still be named, and `provenAt` will never count
// them. What they are is history, and history is worth keeping readable.
function cmdCiImportLegacy() {
  const r = readReg();
  const old = r.ci && typeof r.ci === 'object' ? r.ci : null;
  const rounds = old ? Object.keys(old).sort((a, b) => Number(a) - Number(b)) : [];
  if (!rounds.length) return console.log('nothing to import — there is no `ci` block on this register.');
  let n = checkpoints(r).reduce((m, c) => Math.max(m, /^l/.test(String(c.id)) ? parseInt(String(c.id).slice(1), 10) || 0 : 0), 0);
  for (const k of rounds) {
    const o = old[k] || {};
    checkpoints(r).push({
      id: 'l' + String(++n).padStart(2, '0'),
      status: o.status || 'green', ref: o.ref || '',
      why: '[imported from round ' + (Number(k) + 1) + '; the tasks it covered were never recorded] ' + (o.why || ''),
      covers: [], legacy: true, mainSha: o.mainSha || o.sha || '', at: o.at || now(),
    });
  }
  delete r.ci;
  commit(r);
  console.log('imported ' + rounds.length + ' legacy result(s) as l01…l' + String(n).padStart(2, '0') + ', and removed the `ci` block.');
  console.log('Each carries covers: [] — they prove nothing that can still be named, because a round');
  console.log('number cannot be turned back into task keys. They are kept as history, and `ci list`');
  console.log('reads them. Nothing landed becomes proven or unproven by this.');
}

function cmdCiList() {
  const r = readReg();
  const cs = checkpoints(r);
  if (!cs.length) return console.log('no checkpoint has been recorded yet.');
  for (const c of [...cs].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    console.log(String(c.id).padEnd(5) + String(c.status).padEnd(8) + String(c.at).slice(0, 19).replace('T', ' ') +
      '  ' + (c.ref || '(no ref)'));
    console.log('     covers ' + (c.covers && c.covers.length ? c.covers.join(' ')
      : '(nothing — proves no task)' + (c.legacy ? ', imported history' : '')));
    if (c.why) console.log('     ' + String(c.why).replace(/\s+/g, ' ').slice(0, 150));
  }
  const un = unprovenLanded(r);
  console.log('\n' + cs.length + ' checkpoint(s). ' + un.length + ' landed task(s) are not covered by a green one' +
    (un.length ? ': ' + un.map((t) => t.key).join(' ') : '.'));
}

function cmdCi(flags) {
  const r = readReg();
  const wa = waveArg(flags);
  const n = wa !== undefined ? wa : currentWave(r);
  const st = waveState(r, n);
  if (!st) die('there is no round ' + (n + 1));
  const status = flags.status;
  if (!['green', 'red', 'skipped'].includes(status)) die('--status must be green, red or skipped');
  if (status === 'skipped' && typeof flags.why !== 'string') die('--status skipped needs --why "..." — a missing CI run is a decision, not an omission');
  if (status === 'red' && typeof flags.why !== 'string') die('--status red needs --why "..." — what broke is the whole point of recording it');
  if (!st.allLanded && status !== 'red')
    die('round ' + (n + 1) + ' has not all landed yet, so this cannot close it:\n       ' +
        st.tasks.filter((t) => t.status !== 'landed').map((t) => t.key).join(' '));
  // resolved at write time: exactly which landed work this run saw
  const covers = st.tasks.filter((t) => t.status === 'landed').map((t) => t.key);
  const cp = { id: nextCheckpointId(r), status, ref: flags.ref || '', why: flags.why || '',
               covers, mainSha: flags.sha || '', at: now() };
  checkpoints(r).push(cp);
  commit(r);
  console.log(cp.id + ': round ' + (n + 1) + ' ' + status + (flags.ref ? '  ' + flags.ref : ''));
  console.log('  covers ' + (covers.length ? covers.join(' ') : '(nothing landed)') +
              ' — filed against those, not against a round number that moves.');
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
  } else if (status === 'red') {
    const covered = st.tasks.filter((t) => t.status === 'landed').map((t) => t.key);
    const d = recordDefect(r, { task: '', kind: 'ci',
      what: 'CI red on round ' + (n + 1) + (flags.ref ? ' (' + flags.ref + ')' : ''),
      evidence: 'why: ' + flags.why + '\ncovers: ' + (covered.join(' ') || '(nothing landed)'), blocking: true });
    commit(r);
    console.log('recorded ' + d.id + ' naming the ' + covered.length + ' landed task(s) it covers.');
    console.log('Nothing of the next round is created. Send the break back to whoever owns those files.');
  }
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
  if (!t.chip) {
    // The record has to be able to say which chip is which — without it there is
    // no way back from a key to the thing actually running the work.
    if (!flags.id)
      die('chip ' + key + ' --id <task_id> — the chip id is how the record points at the running\n' +
          '       agent. Take it from the tool that created the chip. Add --worktree <path> too if\n' +
          '       the copy it works in is not the branch\'s own worktree.');
    const pending = heldNeeds(r, t);
    if (pending.length) {
      console.error('✗ ' + key + ' still waits for ' + pending.join(', ') + ' to land.');
      console.error('  A chip opens only when everything it builds on is already in the main line —');
      console.error('  a copy taken earlier is stale by exactly what it waited for. Run `frontier`');
      console.error('  to see what can open instead.');
      process.exit(1);
    }
    const clashes = openTasks(r, key).map((o) => ({ o, i: interference(t, o) })).filter((x) => x.i);
    if (clashes.length) {
      console.error('✗ ' + key + ' would interfere with work that is open right now:');
      for (const { o, i } of clashes) {
        for (const f of i.files) console.error('    ' + o.key + '  ↔  ' + f);
        for (const x of i.points) console.error('    ' + o.key + '  ↔  serialisation point ' + x);
      }
      console.error('  Two of them changing one thing is the one failure this arrangement cannot');
      console.error('  survive. It opens the moment ' + [...new Set(clashes.map((c) => c.o.key))].join('/') + ' lands — `frontier` will say.');
      process.exit(1);
    }
  }
  if (flags.id) t.chip = flags.id;
  if (flags.worktree) t.worktree = flags.worktree;
  // --branch used to be accepted and then dropped on the floor, so `guard` and
  // `release` went looking for a branch nobody had ever created.
  if (flags.branch) t.branch = flags.branch;
  const held = heldNeeds(r, t);
  t.status = held.length ? 'held' : 'ready';
  commit(r);
  console.log(t.key + '  ' + t.status + (held.length ? '  waiting for ' + held.join(', ') : '  can start now'));
  if (held.length) {
    console.log('');
    console.log('⚠ This should not have happened — a chip only opens once everything it needs has');
    console.log('  landed, so none is ever created on hold. Most likely ' + held.join(', ') + ' finished but was');
    console.log('  never recorded with `landed`. Check `board` and `frontier` before anyone clicks this.');
  }
}

function cmdAgent(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  if (!flags.name) die('need --name <peer name it checked in from>');
  t.agent = flags.name;
  // heldNeeds treats a requirement that is not on record as unlanded and names
  // it. Reading it with getTask instead used to abort the whole command with
  // "no task X (have: ...)", which reads like the task being checked in is the
  // one that does not exist.
  const stillHeld = heldNeeds(r, t);
  if (t.status === 'planned') t.status = stillHeld.length ? 'held' : 'ready';
  commit(r);
  console.log(key + ' is reachable at ' + t.agent + '  (' + t.status + ')');
  const missing = (t.needs || []).filter((n) => !depOf(r, n));
  if (missing.length) console.log('⚠ it waits on ' + missing.join(', ') + ', which ' +
    (missing.length > 1 ? 'are' : 'is') + ' not on record — a typo, or a task never added. Fix `needs`.');
  if (stillHeld.length) console.log('Reply to it now: you are on hold until ' + stillHeld.join(', ') + ' land. Do not start.');
}

function cmdRelease(key) {
  const r = readReg(); const t = getTask(r, key);
  if (['landed', 'reported', 'cancelled'].includes(t.status))
    die(key + ' is ' + t.status + ' — releasing it would rewind finished work.');
  const held = heldNeeds(r, t);
  if (held.length) { console.error('✗ cannot release ' + key + ' — still waiting for ' + held.join(', ') + ' (not landed)'); process.exit(1); }
  t.status = 'ready';
  commit(r);
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

const OUTCOMES = ['passed', 'partial', 'failed'];
// `chip`, `release` and `landed` all refuse to move a task that is not in a
// state the move makes sense from. `done` did not, and it is the one command an
// agent runs itself: a report on a landed task rewound it to `reported` while
// keeping its landedAt, and a report on a task nobody had ever handed out was
// accepted as if there were work behind it.
const REPORTABLE = ['held', 'ready', 'reported'];
function cmdDone(key) {
  const r = readReg(); const t = getTask(r, key);
  if (!REPORTABLE.includes(t.status))
    die(key + ' is "' + t.status + '" — ' + (t.status === 'planned'
      ? 'it has never been handed out, so there is no work to report on.\n' +
        '       Create the chip first: driver.mjs chip ' + key + ' --id <task_id>'
      : 'a report cannot rewind finished work. If this is really meant to run\n' +
        '       again, that is a new task.'));
  const rep = stdinJson();
  // This one is run by the chip's own process, so it takes untrusted input.
  if (rep === null || typeof rep !== 'object' || Array.isArray(rep))
    die('the report must be an object: {"commit": "...", "verified": "...", "outcome": "passed|partial|failed", "notes": "..."}');
  const outcome = rep.outcome === undefined ? 'passed' : rep.outcome;
  if (!OUTCOMES.includes(outcome)) die('outcome must be one of: ' + OUTCOMES.join(', '));
  for (const k of ['commit', 'verified', 'notes'])
    if (rep[k] !== undefined && typeof rep[k] !== 'string') die(k + ' must be a string');
  if (typeof rep.verified !== 'string' || !rep.verified.trim())
    die('"verified" is required — say what you ran and what it said. A report with no proof is not a report.');
  (t.reports ||= []).push({ commit: String(rep.commit || ''), verified: rep.verified,
                            outcome, notes: String(rep.notes || ''), at: now() });
  t.status = 'reported';
  let d = null;
  if (outcome !== 'passed') d = recordDefect(r, { task: key, kind: 'bug',
    what: key + ' reported itself as ' + outcome, evidence: rep.verified.slice(0, 500), blocking: outcome === 'failed' });
  commit(r);
  console.log(key + ' recorded as ' + outcome + ' by its own account. Not landed until it is checked again.');
  if (d) console.log('  recorded ' + d.id + ' — it said so itself, so it will not be lost.');
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

// git, run as an argument vector rather than a shell string. Nothing here is
// interpolated into a command line: a branch name arrives from agent-authored
// `task add < json`, and as a shell string one called `main; touch /tmp/PWNED`
// did exactly that. `-z` also stops core.quotePath mangling any path that is
// not ASCII, which used to be recorded as a blocking trespass defect.
function gitZ(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0');
}
// `main` was hardcoded, so guard was unusable in any repo whose default branch
// is called something else. Ask the repo what its integration branch is.
function defaultBase() {
  for (const ref of ['refs/remotes/origin/HEAD', 'HEAD']) {
    try {
      const out = execFileSync('git', ['symbolic-ref', '--short', '-q', ref],
        { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out) return out.replace(/^origin\//, '');
    } catch { /* not set, or not a repo */ }
  }
  return 'main';
}

function cmdGuard(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  const wt = worktreeFor(t);
  if (!wt) die('cannot find a copy of the repository on branch ' + t.branch +
    '\n       Record it: driver.mjs chip ' + key + ' --worktree <path>');
  const base = flags.base || defaultBase();
  for (const [what, v] of [['--base', base], ['the branch', t.branch]])
    if (!v || v.startsWith('-')) die(what + ' is not a usable git ref: "' + v + '"');
  // --no-renames matters: with renames detected, `git diff --name-only` prints
  // only a rename's destination. `git mv other/config.ts src/config.ts` deletes
  // a file this task does not own, and guard used to call that clean.
  const range = base + '...' + t.branch;
  const cmdText = 'git diff --no-renames -z --name-only ' + range;
  let changed;
  try {
    changed = gitZ(['diff', '--no-renames', '-z', '--name-only', range, '--'], wt)
      .map((x) => x.trim()).filter(Boolean);
  } catch (e) { die('could not diff ' + range + ' in ' + wt + '\n       (is "' + base + '" a branch this repo has? pass --base <ref> if not)'); }
  if (!changed.length) {
    const d = recordDefect(r, { task: key, kind: 'guard',
      what: key + ' reported finished but its branch changed nothing against ' + base,
      evidence: cmdText + ' → empty', blocking: true });
    commit(r);
    console.log('⚠ ' + key + ' changed nothing at all against ' + base + '. That is not finished work.');
    console.log('  recorded ' + d.id + '. Ask which branch it committed to — do not go looking yourself.');
    process.exit(1);
  }
  const allowed = t.owns || [];
  const bad = changed.filter((f) => !allowed.some((o) => collides(f, o)));
  console.log(key + ' changed ' + changed.length + ' file(s) on ' + t.branch + ':');
  for (const f of changed) console.log('  ' + (bad.includes(f) ? '✗' : '✓') + ' ' + f);
  if (bad.length) {
    console.log('\n✗ ' + bad.length + ' file(s) outside what it was allowed to touch:');
    for (const f of bad) console.log('    ' + f);
    console.log('\n  Allowed: ' + allowed.join(', '));
    const d = recordDefect(r, { task: key, kind: 'guard',
      what: bad.length + ' file(s) changed outside what ' + key + ' owns',
      evidence: bad.join('\n'), blocking: true });
    commit(r);
    console.log('  recorded ' + d.id + ' with the file list — it will not be forgotten when this scrolls away.');
    console.log('  Send it back. Do not fix it here — you would be writing code, and you would be');
    console.log('  writing it in the one place that has to stay able to judge it.');
    process.exit(1);
  }
  console.log('\n✓ everything it changed was its to change. Safe to join up.');
}

function cmdLanded(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  if (t.status !== 'reported') die(key + ' is "' + t.status + '" — it cannot land before it reports finished');
  // Landing on top of an unlanded requirement puts work in the main line that
  // was built without the thing it was told to build on.
  const held = heldNeeds(r, t);
  if (held.length) {
    console.error('✗ ' + key + ' cannot land — it waits for ' + held.join(', ') + ', and ' +
      (held.length > 1 ? 'those have' : 'that has') + ' not landed.');
    console.error('  Whatever it built, it built without them. Land them first, or fix `needs` if');
    console.error('  the requirement is not real.');
    process.exit(1);
  }
  t.status = 'landed'; t.landedAt = now();
  t.landedSha = flags.sha || '';
  // No checkpoint is destroyed by a landing. The new work is simply not covered
  // by any run yet, which `frontier` and `digest` report as drift.
  const un = unprovenLanded(r).length + 1;
  if (un > 1) console.log(un + ' landing(s) now sit beyond the last checkpoint.');
  if (!t.landedSha) console.log('(no --sha given: a released chip cannot then prove its copy carries this work)');
  // Anything owed on this task can no longer be done by it. Stamp when the
  // window shut so the record says it, and say it here — this is the one moment
  // somebody is looking, and after it the item has no carrier at all.
  const shut = shutWindows(r, key);
  for (const o of shut) if (!o.windowShutAt) o.windowShutAt = now();
  commit(r);
  const freed = tasks(r).filter((x) => x.status === 'held' && (x.needs || []).includes(key) &&
    heldNeeds(r, x).length === 0);
  console.log(key + ' landed.');
  if (shut.length) {
    const lb = shut.filter((o) => o.loadBearing);
    console.log('\n⚠ ' + shut.length + ' owed item(s) were assigned to ' + key + '. Its window is now shut —');
    console.log('  it landed without them, and nothing else is carrying them:');
    for (const o of shut) console.log('    ' + o.id + (o.loadBearing ? '  LOAD-BEARING  ' : '                ') + o.what);
    console.log('  Reassign each (`owed assign <id> --to <key>`) or settle it (`owed done <id>`).');
    if (lb.length) console.log('  ' + lb.length + ' of them is load-bearing. Something depends on it being done.');
    console.log('  They stay open and on `outstanding` until you do one or the other.');
  }
  if (freed.length) { console.log('\nHeld chips waiting only on it (legacy — new chips open instead of waiting):'); for (const f of freed) console.log('  driver.mjs release ' + f.key); }
  console.log('\nRun `frontier` — this landing may have opened more than its direct dependents,');
  console.log('and its files are no longer in flight, so tasks it was blocking can open too.');
}

// The orchestrator builds nothing. If work is sitting in the main checkout on
// files that belong to a task, somebody has done a chip's job here.
function trespass(r) {
  let out = [];
  try {
    // -z, so a non-ASCII path is not handed back quoted and mangled, and so a
    // rename's two halves arrive as two records instead of one " -> " line.
    // Both halves count: renaming a file away is changing it.
    const parts = gitZ(['status', '--porcelain', '-z'], CWD);
    const dirty = [];
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (!e) continue;
      const xy = e.slice(0, 2), p = e.slice(3).trim();
      if (p) dirty.push(p);
      if (/[RC]/.test(xy)) { const src = (parts[++i] || '').trim(); if (src) dirty.push(src); }
    }
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

// ------------------------------------------------------- deriving the ledger
// Logging a message by hand only works if the orchestrator remembers, and a
// compaction is exactly the event that makes it forget. It does not have to:
// Claude Code already writes every turn to a transcript on disk, inbound
// cross-session messages included, with sender and timestamp. So the ledger is
// derived from that rather than typed — retroactively, and for messages the
// orchestrator can no longer see.
function transcriptDir() {
  const base = path.join(process.env.HOME, '.claude', 'projects');
  if (!fs.existsSync(base)) return null;
  const guess = path.join(base, CWD.replace(/[/_]/g, '-'));
  if (fs.existsSync(guess)) return guess;
  // fall back to whichever project dir whose records name this cwd
  for (const d of fs.readdirSync(base)) {
    const dir = path.join(base, d);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files.slice(0, 3)) {
      try {
        const head = fs.readFileSync(path.join(dir, f), 'utf8').split('\n', 40);
        for (const line of head) {
          if (!line) continue;
          try { if (JSON.parse(line).cwd === CWD) return dir; } catch { /* not this one */ }
        }
      } catch { /* unreadable */ }
    }
  }
  return null;
}

function textOf(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => b && b.text ? b.text : '').join('');
  return '';
}

// The task a message is about, if it names one. A message is addressed at its
// start — "0.9 — stop, and do not write anything…" is about 0.9 — and mentions
// come later. Walking the keys longest-first and returning the first that
// matched ANYWHERE in the first 400 characters ignored position entirely, so
// that message was filed under 1.8b because 1.8b happened to be named in a
// later sentence and is one character longer; 22 real messages were filed
// under a task they merely mentioned.
//
// The length sort existed so "1.9" would not swallow "1.9a", but the boundary
// regex below already prevents that — "1.9" cannot match inside "1.9a" because
// "a" is a word character. So the rule is simply: earliest match wins, and a
// tie (the same position, which only a prefix could produce) goes to the
// longer key.
function keyIn(text, keys) {
  const head = text.slice(0, 400);
  let best = '', at = Infinity;
  for (const k of keys) {
    const m = head.match(new RegExp('(^|[^A-Za-z0-9._-])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9._-]|$)'));
    if (!m) continue;
    const pos = m.index + m[1].length;
    if (pos < at || (pos === at && k.length > best.length)) { at = pos; best = k; }
  }
  return best;
}

// Everything outside the tags is Claude Code's own wrapper — the "Another
// Claude session sent a message:" line before it, the standing instructions
// after it — and none of it was written by the peer. Taking only what is
// BETWEEN them keeps their words and nothing else. It also stops the wrapper
// from spending the character budget, which is the part that was losing data:
// reports are the longest messages in a run, and on the live ledger 83 of 102
// recovered messages were being cut off at the cap.
function innerMessage(text) {
  const m = text.match(/<cross-session-message[^>]*>([\s\S]*?)<\/cross-session-message>/);
  if (m) return m[1].trim();
  // No closing tag: a truncated transcript line. Keep what follows the opening
  // tag rather than dropping the message — some of it beats none of it.
  return text.replace(/^[\s\S]*?<cross-session-message[^>]*>/, '')
             .replace(/^Another Claude session sent a message:\s*/, '').trim();
}
// An agent's report is the substance of the run, not chatter. The old 2000 was
// cutting the conclusion off the end of most of them.
const MSG_CAP = 4000;

// A cut message used to be stored as `body.slice(0, MSG_CAP)` and nothing else
// — no ellipsis, no flag, no original length — so 33 of 311 entries on the real
// ledger ended mid-sentence and were read afterwards as complete statements.
// The mark is in the text where a reader will see it, and the two fields say
// exactly how much is missing so a total can be trusted.
function capped(body) {
  const s = String(body);
  if (s.length <= MSG_CAP) return { text: s };
  return { text: s.slice(0, MSG_CAP) + '\n\n… [cut at ' + MSG_CAP + ' of ' + s.length + ' characters]',
           truncated: true, fullLength: s.length };
}

// The peer that sent a message, off the opening tag. Claude Code writes two
// wrapper shapes and only one of them carries from-name:
//
//   <cross-session-message from="uds:/…/1234.sock" from-name="lms-v2-3d" …>
//   <cross-session-message from="local_<uuid>" name="<title>" encoded="1">
//
// The second is what it emits when the peer channel is gone and the transcript
// is the only surviving copy of the message — which is precisely the case
// `ingest` exists for. Requiring from-name counted those lines as candidates
// and then dropped them in silence, so `ingest` reported success having lost
// them; on the real run that was 3 complete task reports, about 14.6 KB. Here
// the name is taken from whichever attribute carries one, and `name` is kept
// separately because on that shape it is the message's title, not the sender.
function senderOf(openTag) {
  const attr = (n) => { const m = openTag.match(new RegExp('\\b' + n + '="([^"]*)"')); return m ? m[1] : ''; };
  const fromName = attr('from-name');
  const from = attr('from');
  return { agent: fromName || from, subject: fromName ? '' : attr('name') };
}

// Whether a transcript line was written from this run. An exact string match
// dropped every line whose cwd was a subdirectory — and the orchestrator
// routinely works from apps/api and the like — which on the real run cost 13
// outbound "released, rebase now" messages, exactly the ones `waitingOn` reads
// to decide a question has been answered.
function underCwd(cwd) {
  if (!cwd) return true;
  const a = path.resolve(cwd), b = path.resolve(CWD);
  return a === b || a.startsWith(b + path.sep);
}

function harvest(dir, keys) {
  const out = [];
  const seen = { files: 0, lines: 0, candidates: 0, parsed: 0, wrongCwd: 0, underCwd: 0 };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    let lines;
    try { lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n'); } catch { continue; }
    seen.files++; seen.lines += lines.length;
    for (const line of lines) {
      if (!line || (!line.includes('cross-session-message') && !line.includes('SendMessage'))) continue;
      seen.candidates++;
      let j; try { j = JSON.parse(line); } catch { continue; }
      seen.parsed++;
      if (j.cwd && j.cwd !== CWD) { if (underCwd(j.cwd)) seen.underCwd++; else { seen.wrongCwd++; continue; } }
      if (j.type === 'user') {
        const text = textOf(j.message);
        const open = text.match(/<cross-session-message[^>]*>/);
        if (!open) continue;
        const who = senderOf(open[0]);
        const body = innerMessage(text);
        out.push({ at: j.timestamp, dir: 'in', kind: 'derived', agent: who.agent,
                   key: keyIn(body, keys), ...capped(body), uuid: j.uuid, session: j.sessionId,
                   ...(who.subject ? { summary: who.subject } : {}) });
      } else if (j.type === 'assistant' && Array.isArray(j.message && j.message.content)) {
        for (const b of j.message.content) {
          if (!b || b.type !== 'tool_use' || b.name !== 'SendMessage' || !b.input) continue;
          const body = String(b.input.message || '');
          out.push({ at: j.timestamp, dir: 'out', kind: 'derived', agent: String(b.input.to || ''),
                     key: keyIn(body, keys), ...capped(body), uuid: b.id || j.uuid, session: j.sessionId,
                     summary: b.input.summary || '' });
        }
      }
    }
  }
  out.seen = seen;
  return out;
}

function cmdIngest(flags) {
  // Reads only — and it walks every transcript on disk, which can take far
  // longer than the lock's staleness window. Holding the write lock here is how
  // two processes end up believing they hold it.
  const r = readRegRO();
  const dir = flags.from ? path.resolve(CWD, flags.from) : transcriptDir();
  if (!dir) die('cannot find the transcript directory for this project under ~/.claude/projects.\n' +
                '       Pass it: ingest --from <dir>');
  const keys = tasks(r).map((t) => t.key).sort((a, b) => b.length - a.length);
  const found = harvest(dir, keys);
  const seen = found.seen;
  // The transcript format belongs to Claude Code, not to us, and it changes
  // between versions. "I found nothing" and "I can no longer read this" look
  // identical from the outside — so say which, loudly.
  if (seen.candidates > 0 && found.length === 0) {
    console.error('✗ ' + seen.candidates + ' line(s) in ' + rel(dir) + ' mention a message, and none could be read.');
    console.error('  The transcript format is internal to Claude Code and changes between versions;');
    console.error('  this most likely means it changed under us. DO NOT read this as "no messages" —');
    console.error('  the ledger is now incomplete. Fall back to `say`/`heard` by hand and say so.');
    process.exit(1);
  }
  if (seen.files === 0) {
    console.error('✗ no transcript files in ' + rel(dir) + '. Wrong directory, or they have been cleaned up');
    console.error('  (Claude Code keeps them ~30 days by default). Nothing can be recovered from here.');
    process.exit(1);
  }
  // Dedupe within this harvest as well as against the ledger. A session that
  // was resumed or forked carries its earlier turns into the new transcript, so
  // the same message is genuinely found twice in one pass, and checking only
  // what is already stored lets both copies through.
  const have = new Set(ledger().map((e) => e.uuid).filter(Boolean));
  const fresh = [];
  for (const e of found) {
    if (!e.uuid || have.has(e.uuid)) continue;
    have.add(e.uuid);      // …and against the rest of THIS harvest, not just the ledger
    fresh.push(e);
  }
  fresh.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const e of fresh) append(e);
  // Entries recovered before the wrapper was being stripped still carry it, and
  // several were cut short by it. They are derived, so they can simply be
  // derived again — the transcript is still the source. Only the text of
  // entries harvest can still see is touched; anything typed by hand, and
  // anything whose transcript has aged out, is left exactly as it is.
  let recleaned = null;
  if (flags.reclean) {
    const byUuid = new Map(found.map((e) => [e.uuid, e]));
    const cur = ledger();
    let fixed = 0, gained = 0, marked = 0;
    for (const e of cur) {
      const f = e.uuid && byUuid.get(e.uuid);
      if (!f || typeof f.text !== 'string') continue;
      // An entry already at the cap cannot be lengthened — the transcript
      // yields the same cut text — but it CAN stop passing itself off as
      // whole. Carry the marks across whether or not the text changed, and
      // count them apart from text actually recovered, so the "+n chars"
      // figure never claims the cut-here note as content.
      const wasCut = !!e.truncated;
      if (f.truncated && !wasCut) { e.truncated = true; e.fullLength = f.fullLength; marked++; }
      if (f.text === e.text) continue;
      const before = String(e.text || '').length;
      e.text = f.text; if (!e.key && f.key) e.key = f.key;
      gained += (f.truncated ? MSG_CAP : f.text.length) - (wasCut ? before : Math.min(before, MSG_CAP));
      fixed++;
    }
    if (fixed || marked) {
      fs.copyFileSync(ledgerPath(), ledgerPath() + '.bak');
      fs.writeFileSync(ledgerPath(), cur.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    recleaned = { fixed, gained, marked };
  }
  console.log('read ' + rel(dir) + '  (' + seen.files + ' transcript(s), ' + seen.candidates + ' candidate line(s))');
  if (seen.underCwd)
    console.log('  ' + seen.underCwd + ' from a directory under this one (a worktree or a package) — kept.');
  if (seen.wrongCwd)
    console.log('  ' + seen.wrongCwd + ' line(s) belong to another project entirely — skipped.');
  console.log('  ' + found.length + ' message(s) in the transcripts, ' + fresh.length + ' new to the ledger.');
  const named = fresh.filter((e) => e.key).length;
  console.log('  ' + named + ' name a task; ' + (fresh.length - named) + ' do not (still logged, just unattributed).');
  const cut = fresh.filter((e) => e.truncated).length;
  if (cut) console.log('  ' + cut + ' were longer than ' + MSG_CAP + ' characters and are stored cut, and marked as cut.');
  if (recleaned) {
    console.log('  re-derived ' + recleaned.fixed + ' entr(ies) already in the ledger' +
      (recleaned.fixed ? ': ' + (recleaned.gained >= 0 ? '+' : '') + recleaned.gained +
        ' chars of message text recovered, previous file kept as messages.jsonl.bak' : ' — nothing to repair'));
    if (recleaned.marked)
      console.log('  ' + recleaned.marked + ' entr(ies) already at the cap could not be lengthened — the transcript');
    if (recleaned.marked)
      console.log('  holds the same cut text — but are now marked as cut, with their true length.');
  } else if (ledger().some((e) => /^Another Claude session sent a message:/.test(String(e.text || '')))) {
    console.log('\nSome entries still carry the wrapper Claude Code puts around a message, and were');
    console.log('cut short by it. They can be derived again: `ingest --reclean`.');
  }
  if (fresh.length) {
    const ins = fresh.filter((e) => e.dir === 'in').length;
    console.log('  ' + ins + ' inbound, ' + (fresh.length - ins) + ' outbound.');
    console.log('\nRun `outstanding` — questions you never answered may have surfaced.');
  }
}

const OUT_KINDS = ['release', 'reply', 'sendback', 'note', 'hold', 'announce'];
const IN_KINDS = ['checkin', 'report', 'question', 'blocked', 'note'];

function cmdSay(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  const kind = flags.kind || 'note';
  if (!OUT_KINDS.includes(kind)) die('kind must be one of: ' + OUT_KINDS.join(', '));
  if (typeof flags.text !== 'string' || !flags.text.trim()) die('need --text "what you actually sent"');
  append({ dir: 'out', key, kind, agent: t.agent || '', text: flags.text });
  console.log('logged: → ' + key + ' [' + kind + ']');
  if (kind === 'sendback') {
    const d = recordDefect(r, { task: key, kind: 'sendback', what: flags.text, evidence: '', blocking: true });
    commit(r);
    console.log('  recorded ' + d.id + ' — ' + key + ' stays on `outstanding` until you run: defect fixed ' + d.id);
    console.log('  (sending work back is not answering it; both are now tracked separately)');
  }
}

function cmdHeard(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  const kind = flags.kind || 'note';
  if (!IN_KINDS.includes(kind)) die('kind must be one of: ' + IN_KINDS.join(', '));
  const text = strFlag(flags, 'text', 'need --text "what they actually said"');
  append({ dir: 'in', key, kind, agent: t.agent || '', text });
  t.lastHeard = now();
  let d = null;
  if (kind === 'blocked') d = recordDefect(r, { task: key, kind: 'blocked', what: text, evidence: '', blocking: true });
  commit(r);
  console.log('logged: ← ' + key + ' [' + kind + ']');
  if (d) console.log('  recorded ' + d.id + ' — it stays open until you run: defect fixed ' + d.id);
  if (kind === 'question')
    console.log('  It is now waiting on you. `outstanding` says so until you log a reply (only a reply clears it).');
}


// ------------------------------------------------------------------- digest
// After a compaction the orchestrator still has every file, and no idea which
// of them matter. This is the smallest thing that rebuilds "what is true and
// what is waiting on me" — a few hundred words, not a 1 MB register. Meant to
// be injected by a SessionStart hook (matcher compact|resume) as well as read
// by hand.
function cmdDigest() {
  const r = readReg();
  const T = tasks(r);
  const L = [];
  const n = (st) => T.filter((t) => t.status === st).length;
  L.push('# Orchestration state — rebuilt from disk, not from memory');
  L.push('');
  L.push('You are running an implementation. Your address is **' + (r.orchestrator || '(not recorded — run `whoami` then `iam`)') + '**.');
  L.push('State: `' + rel(REG_PATH) + '`. Briefs: `' + rel(orchDir('briefs')) + '`. Ledger: `' + rel(ledgerPath()) + '`.');
  L.push('You refine nothing and write no product code — agents and chips do that.');
  L.push('');
  L.push('**Work:** ' + T.length + ' tasks — ' + n('landed') + ' landed, ' + n('ready') + ' open, ' +
         n('reported') + ' awaiting your check, ' + n('planned') + ' not yet handed out.');
  const open = T.filter((t) => t.chip && !['landed', 'cancelled'].includes(t.status));
  if (open.length) {
    L.push('');
    L.push('**Open right now** (reply to these addresses):');
    for (const t of open) L.push('- `' + t.key + '` ' + t.title.slice(0, 44) + ' — ' + (t.agent || '⚠ never checked in') + (t.status === 'reported' ? '  **← waiting on your check**' : ''));
  }
  // Exactly what `outstanding` says, because it is the same function. This was
  // a second copy of the rules, which is how one blind spot shipped twice.
  const waits = waitingOn(r, ledger());
  if (waits.length) {
    L.push('');
    L.push('**Waiting on you:**');
    // The same clipping `outstanding` does, and for a stronger reason: this is
    // what a SessionStart hook feeds a freshly compacted context, so one agent
    // report printed raw — newlines, headings, code fences and all — buried
    // every other line here at exactly the moment they were needed most.
    for (const w of waits.slice(0, 8)) {
      const d = String(w.detail || '').replace(/\s+/g, ' ').trim();
      L.push('- ' + w.key + ' ' + w.why + (d ? ': ' + d.slice(0, 70) + (d.length > 70 ? '…' : '') : ''));
    }
    if (waits.length > 8)
      L.push('- …and ' + (waits.length - 8) + ' more. Run `outstanding` — this list is cut, not complete.');
  }
  const owed = owedList(r).filter((o) => o.status !== 'done');
  if (owed.length) {
    L.push('');
    L.push('**Owed** (' + owed.length + ' open, ' + owed.filter((o) => !o.to).length + ' unassigned) — a window closing on one closes for good:');
    for (const o of owed.slice(0, 5)) L.push('- ' + o.id + ' ' + String(o.what).slice(0, 60) + (o.to ? ' → ' + o.to : ' → **nobody**'));
  }
  const unproven = unprovenLanded(r).length;
  if (unproven) L.push('\n**' + unproven + ' landing(s) since the last CI checkpoint.**' + (unproven >= 5 ? ' That is a lot of unproven main line.' : ''));
  L.push('');
  L.push('**Next:** `frontier` (what can open) · `outstanding` (who is waiting) · `board` (everything).');
  L.push('Before trusting the ledger after a gap, run `ingest` — it rebuilds it from the transcripts.');
  console.log(L.join('\n'));
}

function cmdHookInstall() {
  const self = path.resolve(process.argv[1]);
  const reg = path.resolve(CWD, REG_PATH);
  const dir = path.join(CWD, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'settings.json');
  let j = {};
  if (fs.existsSync(f)) { try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { die('cannot parse ' + rel(f) + ': ' + e.message); } }
  const cmd = "node '" + self + "' --register '" + reg + "' digest 2>/dev/null || true";
  const entry = { matcher: 'compact|resume|startup', hooks: [{ type: 'command', command: cmd }] };
  const list = ((j.hooks ||= {}).SessionStart ||= []);
  const already = list.some((e) => JSON.stringify(e) === JSON.stringify(entry));
  if (already) return console.log('already installed in ' + rel(f) + ' — nothing to do.');
  list.push(entry);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log('added a SessionStart hook to ' + rel(f) + '.');
  console.log('After a compaction, a resume, or a fresh start, the digest is put back in front of you');
  console.log('automatically — so the run survives losing its context.');
  console.log('\nIt runs: ' + cmd);
}

// What is waiting on the orchestrator, decided in ONE place. This used to be
// written out twice — here and again inside `digest` — and both times a rule
// was wrong it was wrong in both copies. A rule that two commands depend on
// belongs in neither of them.
function waitingOn(r, log) {
  const rows = [];
  for (const t of tasks(r)) {
    const mine = log.filter((e) => e.key === t.key);
    let spokeFor = false;
    const lastAsk = [...mine].reverse().find((e) => e.dir === 'in' && ['question', 'blocked'].includes(e.kind));
    if (lastAsk) {
      // Only an actual reply answers a question. Sending the work back is a
      // rejection, not an answer — counting it as one is how an agent ends up
      // waiting for ever on a list that says nothing is waiting. A `release`
      // was counted here for the same reason a sendback once was, and it is
      // the same hole: telling somebody to go ahead is not telling them the
      // thing they asked. `heard` promises the operator "only a reply clears
      // it", and now that is what happens.
      const replied = mine.some((e) => e.dir === 'out' && e.kind === 'reply' && e.at > lastAsk.at);
      if (!replied) {
        spokeFor = true;
        // A blocked message did not ask anything — saying it did sends the
        // operator looking for a question that was never put.
        rows.push({ key: t.key, why: lastAsk.kind === 'blocked'
            ? 'says it is blocked and has had nothing back'
            : 'asked you something and has had no answer',
          detail: String(lastAsk.text || '').slice(0, 90), since: lastAsk.at });
      }
    }
    for (const d of openDefects(r, t.key))
      rows.push({ key: t.key, why: (d.blocking ? 'is blocked by ' : 'has an open ') + d.kind + ' (' + d.id + ') — `defect fixed ' + d.id + '` when it is dealt with',
        detail: d.what.slice(0, 90), since: d.at });
    if (t.status === 'reported') {
      spokeFor = true;
      rows.push({ key: t.key, why: 'says it is finished and is waiting on your check',
        detail: ((t.reports || []).slice(-1)[0] || {}).verified || '', since: ((t.reports || []).slice(-1)[0] || {}).at || '' });
    }
    // A message `ingest` recovers from a transcript carries no kind — the
    // transcript never recorded one — so every rule that tests for 'question'
    // is blind to it, and after a compaction that is most of the ledger. This
    // rule asks nothing about kind and guesses nothing: they spoke last, and
    // nothing has gone back. Both halves are read straight off the ledger.
    if (!spokeFor && !['landed', 'cancelled'].includes(t.status)) {
      const lastIn = [...mine].reverse().find((e) => e.dir === 'in');
      if (lastIn && !mine.some((e) => e.dir === 'out' && e.at > lastIn.at))
        rows.push({ key: t.key, why: 'spoke last and has had no answer from you',
          detail: String(lastIn.text || '').slice(0, 90), since: lastIn.at });
    }
    if (t.status === 'held' && (t.needs || []).every((n) => { const d = tasks(r).find((x) => x.key === n); return d && d.status === 'landed'; }))
      rows.push({ key: t.key, why: 'is free to start and has not been released', detail: 'waited for ' + (t.needs || []).join(', '), since: '' });
    if (t.status === 'planned' && t.agent)
      rows.push({ key: t.key, why: 'checked in but was never told where it stands', detail: '', since: '' });
    for (const o of shutWindows(r, t.key))
      rows.push({ key: t.key, why: (t.status === 'landed' ? 'landed with ' : 'was cancelled with ') +
        o.id + ' still owed on it' + (o.loadBearing ? ' — LOAD-BEARING' : '') +
        ' — reassign it (`owed assign ' + o.id + ' --to <key>`) or settle it (`owed done ' + o.id + '`)',
        detail: String(o.what || '').slice(0, 90), since: o.windowShutAt || o.at || '' });
  }
  for (const d of openDefects(r, null).filter((x) => !x.task))
    rows.push({ key: '(no task)', why: 'open ' + d.kind + ' (' + d.id + ')', detail: d.what.slice(0, 90), since: d.at });
  return rows;
}

function cmdOutstanding() {
  const r = readReg();
  const rows = waitingOn(r, ledger());
  if (!rows.length) return console.log('Nothing is waiting on you.');
  console.log('These are waiting on you. Deal with each one — none of them will ask twice.\n');
  for (const x of rows) {
    console.log('  ' + x.key.padEnd(10) + x.why);
    // Clip here rather than in each rule: a thorough agent's report runs to
    // thousands of characters, and one of them printed whole buries the other
    // nine rows. This is the index, not the document — `show <key>` has it all.
    const d = String(x.detail || '').replace(/\s+/g, ' ').trim();
    if (d) console.log('             “' + d.slice(0, 110) + (d.length > 110 ? '…”' : '”'));
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
  commit(r);
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
// Both sets are declared, because the old rule — "takes a value unless the next
// word starts with --" — silently turned a value into `true` whenever an agent
// wrote one that began with a dash, and silently ate a positional whenever a
// boolean was not on the short list. Both failures reported success.
const BOOL_FLAGS = new Set(['stdout', 'all', 'load-bearing', 'dry-run', 'force',
  'not-blocking', 'reclean', 'check']);
const VALUE_FLAGS = new Set(['base', 'branch', 'evidence', 'from', 'grep', 'id', 'into', 'key',
  'kind', 'n', 'name', 'note', 'out', 'plan', 'ref', 'register', 'scope', 'session',
  'sha', 'since', 'stale', 'status', 'subject', 'task', 'text', 'timeout', 'title',
  'to', 'wave', 'what', 'why', 'window', 'worktree']);
const flagName = (s) => s.startsWith('--') ? s.slice(2).split('=')[0] : null;
const isKnownFlag = (s) => {
  const k = flagName(s);
  return k !== null && (BOOL_FLAGS.has(k) || VALUE_FLAGS.has(k));
};
const raw = [];   // everything after `--`, verbatim — the command a slot runs
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { raw.push(...argv.slice(i + 1)); break; }
  if (!a.startsWith('--')) { rest.push(a); continue; }
  let k = a.slice(2), v;
  const eq = k.indexOf('=');
  if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
  if (!BOOL_FLAGS.has(k) && !VALUE_FLAGS.has(k))
    die('unknown flag --' + k + '\n       A misspelled flag used to be ignored, and the command ran on without it.');
  if (BOOL_FLAGS.has(k)) {
    if (v !== undefined) die('--' + k + ' is a yes/no flag and takes no value');
    flags[k] = true; continue;
  }
  if (v === undefined) {
    // Consume whatever comes next, dash or not — that is the whole point. Only a
    // flag this driver actually knows stops it, so `--text "--force broke it"` is
    // kept while `--text --kind note` is reported as the missing value it is.
    if (i + 1 >= argv.length || argv[i + 1] === '--' || isKnownFlag(argv[i + 1]))
      die('--' + k + ' needs a value.\n       If the value itself starts with --, write it as --' + k + '="--like this".');
    v = argv[++i];
  }
  flags[k] = v;
}
if (flags.register !== undefined) REG_PATH = path.resolve(CWD, flags.register);

const cmd = rest.shift();
// What the record calls this invocation. The commands below that read a second
// word out of `rest` need that word too — `refine done` and `refine brief` are
// different events and must not both show up as `refine`.
const SUB_COMMANDS = new Set(['ci', 'defect', 'log', 'owed', 'preflight', 'refine', 'slot', 'task']);
if (cmd) CMDNAME = cmd + (SUB_COMMANDS.has(cmd) && rest[0] && !rest[0].startsWith('--') ? ' ' + rest[0] : '');

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
  archive [--dry-run]       move finished detail off landed and cancelled tasks into archive/.
                            The record still holds it, and verify stays clean.
  defect add|fixed|list     a failure that must not be forgotten: a sendback, a trespass, a red run,
                            a blocker, a bug found between sessions. Recorded automatically where
                            those happen; --all includes the fixed ones.
  owed add|assign|done|list work only possible in a window between two pieces — record it, assign
                            it, and close no round on top of it silently.
  brief <key> [--stdout]    write the chip's brief to a file; print what to send. --all rewrites every one.
  chip <key> --id <task_id> [--worktree p] [--branch b]   record the chip, set held or ready.
                            --id is required the first time: it is how the record points at the
                            agent actually doing the work. Refuses while the task would interfere
                            with anything still open.
  agent <key> --name <peer>  record where a chip checked in from — without it you cannot release it.
  release <key>             refuses while a requirement has not landed; prints the release message.
  done <key>     < json     {commit, verified, notes} — a chip's own report.
  guard <key> [--base b]    diff its branch and name any file it was not allowed to touch. Exits 1.
                            The base defaults to the repo's own default branch, not to "main".
  say <key> --kind k --text t     log what you sent (release|reply|sendback|note|hold|announce).
  heard <key> --kind k --text t   log what arrived (checkin|report|question|blocked|note).
  ingest [--from dir]       rebuild the ledger from the on-disk transcripts — both directions,
                            retroactively, including messages a compaction already took.
         [--reclean]        also re-derive entries already in the ledger, for ones recovered
                            before the message wrapper was being stripped off.
  outstanding               who is waiting on you, and since when.
  verify                    replay the record and prove it still equals the register. Exits 1 on drift.
  rebuild [--to seq]        rewrite the register from the record. Total recovery from a lost register.
  events [--since n] [--task k] [--grep s] [--n 40]   what happened, and which command did it.
  log reseed --why "..."    start a fresh record from the register, marking the lost history honestly.
  digest                    the whole run in a few hundred words — what is true, what waits on you.
  hook-install              run the digest automatically after every compaction and resume.
  resume --name <peer>      take over a run after the session running it ended.
  landed <key>              record the merge, and name who that frees.
  board                     every task, its state, and what it waits for.
  bundle suggest            steps that should be one chip rather than several — a chip pays for its
                            plan once, so siblings sharing one plan pay for it again and again.
  bundle <k>... --into <k>  merge them; the absorbed ones are cancelled, never deleted.
  frontier                  every chip that can open right now without touching anything in
                            flight, and exactly why the rest cannot.
  slot run <n> -- <cmd>     wait for the shared machine slot (~10s polls), run the command,
                            free the slot even if it fails. Also: slot status|wait|take|free.
  wave [--wave n]           the round in flight: what is left, and whether the next may open.
  ci --status green|red|skipped [--ref r] [--why w]   record CI for the round just landed.
  ci list                   every checkpoint, oldest first, and what each one covers.
  ci import-legacy          one-off: move results still filed under a round number into
                            checkpoints as history. They cover nothing and prove nothing.

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
  case 'iam': { const r = readReg(); r.orchestrator = rest[0] || die('need a name'); commit(r); console.log('briefs will tell chips to report to ' + r.orchestrator); break; }
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
  case 'archive': cmdArchive(flags); break;
  case 'owed': cmdOwed(rest.shift(), rest, flags); break;
  case 'defect': cmdDefect(rest.shift(), rest, flags); break;
  case 'slot': cmdSlot(rest.shift(), rest, flags, raw); break;
  case 'frontier': cmdFrontier(); break;
  case 'bundle': cmdBundle(rest.shift(), rest, flags); break;
  case 'ci':
    if (rest[0] === 'import-legacy') cmdCiImportLegacy();
    else if (rest[0] === 'list') cmdCiList();
    else cmdCi(flags);
    break;
  case 'say': cmdSay(rest[0], flags); break;
  case 'heard': cmdHeard(rest[0], flags); break;
  case 'ingest': cmdIngest(flags); break;
  case 'rebuild': cmdRebuild(flags); break;
  case 'verify': cmdRebuild({ ...flags, check: true }); break;
  case 'events': cmdEvents(flags); break;
  case 'log': if (rest.shift() !== 'reseed') die('log reseed --why "..."'); cmdLogReseed(flags); break;
  case 'digest': cmdDigest(); break;
  case 'hook-install': cmdHookInstall(); break;
  case 'outstanding': cmdOutstanding(); break;
  case 'resume': cmdResume(flags); break;
  default: console.log(HELP); process.exit(cmd ? 2 : 0);
}
