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
let LOCK_TOKEN = null;
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
      //
      // This used to be best-effort, and the failure it swallowed is the one
      // that matters: a lock directory with no holder inside it is invisible to
      // `lockIsDead`, which then falls back to a bare fifteen-second age test
      // and declares a process that is very much alive to be dead. Written by
      // rename so a reader never sees half of it, and if it cannot be written
      // at all the claim is given back rather than held anonymously.
      LOCK_TOKEN = crypto.randomBytes(9).toString('hex') + '-' + process.pid;
      try {
        const tmp = lockDir() + '.holder.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ token: LOCK_TOKEN, pid: process.pid,
          started: procStartTime(process.pid), host: os.hostname(), since: now() }));
        fs.renameSync(tmp, path.join(lockDir(), 'holder.json'));
      } catch (e) {
        try { fs.rmSync(lockDir(), { recursive: true, force: true }); } catch { /* gone */ }
        die('took the register lock and could not say who holds it (' + (e && e.code) + ').\n' +
            '       An unmarked lock reads as an abandoned one to the next process along, so it\n' +
            '       has been given back rather than held anonymously.');
      }
      HAS_LOCK = true;
      process.on('exit', releaseLock);
      // The slot next door has had these since it was written. The register lock
      // — which guards more — had only `exit`, so a holder killed from outside
      // left its claim behind to be aged out rather than dropped at once.
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
        process.on(sig, () => { releaseLock(); process.exit(130); });
      return;
    } catch (e) {
      // Only EEXIST means somebody else holds it. A permission error, a full
      // disk or a missing parent are not contention and waiting will not help.
      if (e && e.code && e.code !== 'EEXIST')
        die('cannot create the register lock at ' + rel(lockDir()) + ': ' + e.code + ' — ' + e.message);
      if (lockIsDead()) { try { fs.rmSync(lockDir(), { recursive: true, force: true }); } catch { /* raced */ } continue; }
      sleepSync(100);
    }
  }
  die('another driver process has held the register lock for a while: ' + rel(lockDir()) +
      '\n       If nothing is actually running, remove that directory.');
}
// Free only what we still hold. This deleted whatever was at the path, so a
// process whose lock had been taken from it — rightly or wrongly — went on to
// delete the lock of whoever had replaced it, and two writers proceeded into one
// register. The slot has judged its claims by an unguessable token since it was
// written; so does this now.
function releaseLock() {
  if (!HAS_LOCK) return;
  HAS_LOCK = false;
  let h = null;
  try { h = JSON.parse(fs.readFileSync(path.join(lockDir(), 'holder.json'), 'utf8')); } catch { /* gone */ }
  if (h && h.token && LOCK_TOKEN && h.token !== LOCK_TOKEN) return;   // not ours any more
  try { fs.rmSync(lockDir(), { recursive: true, force: true }); } catch { /* gone */ }
}

// When a process began, so a recycled pid can be told from the process that
// really holds the lock. Linux keeps it in field 22 of /proc/<pid>/stat, in
// clock ticks since boot. There is no /proc on Windows, so a holder is asked
// through PowerShell instead — slower, but the only source that will still
// agree with itself when a different process reads back what another one
// wrote: both the write at acquire time and a later read during a staleness
// check go through this same query, so the value one process records for its
// own pid is exactly what another process gets back asking about that pid,
// with no unit mismatch between a cheap self estimate and an exact read of
// somebody else. Where neither source is available there is simply no extra
// evidence and the pid check stands on its own, exactly as it did before.
function procStartTime(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]) || null;
  } catch { /* not Linux — try the Windows source below */ }
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-Process -Id ' + Number(pid) + ' -ErrorAction Stop).StartTime.ToFileTimeUtc()'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
      return out ? Number(out) || null : null;
    } catch { return null; }
  }
  return null;
}

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
  try { process.kill(h.pid, 0); } catch (e) { return e.code === 'ESRCH'; }
  // The pid is alive — but pids are reused, and this branch had no other
  // evidence and no time limit at all, so an unrelated process inheriting a dead
  // holder's number wedged the lock for good rather than for a while. If we know
  // when the holder started and the process sitting on that pid started at a
  // different moment, it is not the holder.
  const started = procStartTime(h.pid);
  if (h.started && started && h.started !== started) return true;
  return false;
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
  writeStamp(next);
}

// What the register looked like when this tool last wrote it. Kept beside the
// register rather than inside it: a field within would never be set by `replay`,
// so `verify` would report it as drift for ever unless `verify` and `rebuild`
// both grew an exception for it — the many-sites special-casing the event log
// exists to avoid.
function stampPath() { return path.resolve(CWD, REG_PATH) + '.stamp'; }
const registerStamp = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
function writeStamp(text) {
  try {
    const tmp = stampPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ sha: registerStamp(text), at: now() }) + '\n');
    fs.renameSync(tmp, stampPath());        // by rename: readers are not locked
  } catch { /* the stamp is evidence, not state — never fail a write over it */ }
}
// Did anything change the register other than this tool? Returns null when there
// is nothing to compare — a first run, a register from before stamping, a stamp
// swept by a cleaner — because "cannot tell" and "was edited" are different
// answers and only one of them is worth interrupting somebody for.
function stampSaysEdited(text) {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(stampPath(), 'utf8')); } catch { return null; }
  if (!st || typeof st.sha !== 'string') return null;
  return st.sha !== registerStamp(text);
}
// Always forward slashes, on every OS. `path.relative` answers in the native
// separator, so on Windows every plan/gap/task got written as `docs\plans\p.md`
// while every lookup — a `--plan` filter, a link in a report, a needle a user
// typed — is spelled with `/`. Nothing but this function's own output ever
// disagreed with itself; the only victims were comparisons against it.
const rel = (p) => (path.relative(CWD, p) || p).split(path.sep).join('/');
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

// Every path in the register — a plan, a context entry, a file a task owns — is
// relative to the project the register describes, and was being resolved against
// whatever directory the command happened to be run from. Point `--register` at
// a project and stand somewhere else and `doctor` invents dozens of "path does
// not exist" failures against a tree that is perfectly sound.
//
// The register lives at <root>/.claude/orchestration/register.json, so when it
// is in that shape the root is knowable and used. A register somewhere else —
// a copy taken aside to inspect — has no project to point at, and falls back to
// where the command was run, which is what every path did before.
let PROJECT_ROOT = null;
function projectRoot() {
  if (PROJECT_ROOT) return PROJECT_ROOT;
  const dir = path.dirname(path.resolve(CWD, REG_PATH));
  const up = path.resolve(dir, '..', '..');
  PROJECT_ROOT = (path.basename(dir) === 'orchestration' && path.basename(path.dirname(dir)) === '.claude')
    ? up : CWD;
  return PROJECT_ROOT;
}
// A path the record holds, made absolute against the project rather than the shell.
const inProject = (p) => path.resolve(projectRoot(), p);

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
  let before = {}, beforeText = null;
  try { beforeText = fs.readFileSync(path.resolve(CWD, REG_PATH), 'utf8'); before = JSON.parse(beforeText); }
  catch { /* first write */ }
  // The register is a projection, and this diffs against whatever is on disk. So
  // anything that edited it outside this tool — an editor, a stray script, a
  // half-finished merge — became the trusted baseline at the very next command,
  // and the divergence was never recorded, never healed and never mentioned.
  // Only a hand-run `verify` ever saw it. Not fatal: a crash between writing the
  // register and writing its stamp would otherwise brick every later command,
  // making a bug in this tool indistinguishable from somebody's edit.
  if (beforeText !== null && stampSaysEdited(beforeText) === true) {
    console.log('⚠ ' + rel(REG_PATH) + ' changed since this tool last wrote it.');
    console.log('  Taking it as it stands — but the record never learned whatever that was.');
    console.log('  Run `verify` to see the difference before it is built on further.');
    recordDefect(r, { task: '', kind: 'record',
      what: 'the register was changed outside the tool',
      evidence: 'detected by ' + (why || CMDNAME || 'a command') + ' at ' + now() +
                '; the edit itself is not in the record. `verify` names the fields.',
      blocking: false });
  }
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
  // A rewind cuts the record, and left no trace of itself in what remained. The
  // only sign one had happened was a `.before-rewind-` file sitting beside it,
  // and no command will diff that for you — so on a real run eight `bundle`
  // calls and a chip id vanished with nothing accounting for them.
  if (to !== undefined && !flags.check && (typeof flags.why !== 'string' || !flags.why.trim()))
    die('rebuild --to needs --why "..." — a rewind removes events, and the record\n' +
        '       has to be able to say why it is shorter than it was.');
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
  // `verify` offers `rebuild` as one of two opposite fixes and says nothing can
  // tell them apart for you. Choosing it overwrites the register from the record
  // — so anything the record never learned is about to go, and this said the
  // opposite: "nothing was thrown away", which is true of backups/ and false of
  // the file it is replacing. Show the ground it is about to take.
  let losing = [];
  try { losing = diffOps(state, JSON.parse(fs.readFileSync(path.resolve(CWD, REG_PATH), 'utf8'))); }
  catch { /* no register yet — nothing to lose */ }
  if (losing.length) {
    console.log('This replaces ' + losing.length + ' thing(s) the register holds and the record never learned:');
    for (const o of losing.slice(0, 12))
      console.log('    ' + o.p.join('.') + (o.d ? '  (only in the record)' : '  → ' + JSON.stringify(o.v).slice(0, 70)));
    if (losing.length > 12) console.log('    …and ' + (losing.length - 12) + ' more');
    console.log('  If any of that is real work, stop: `log reseed` is the other fix, and it keeps');
    console.log('  the register instead. This keeps the record.');
  }
  writeReg(state);
  console.log('rebuilt ' + rel(REG_PATH) + ' from ' + use.length + ' event(s) (seq ' + lastSeq + ').');
  console.log('The register as it stood is in backups/' +
    (losing.length ? ' — the ' + losing.length + ' thing(s) above exist only there now.' : '.'));
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
      // Append the rewind itself, so the record accounts for its own gap rather
      // than simply being shorter than it was.
      const rec = { seq: lastSeq + 1, at: now(), cmd: 'rebuild --to', argv: CMDLINE,
        rewind: { to: upto, cut: events.length - use.length, kept: rel(keep) },
        why: flags.why, ops: [] };
      sealLastLine(f);
      fs.appendFileSync(f, JSON.stringify(rec) + '\n');
      console.log('The rewind is itself on the record now, at seq ' + rec.seq + '.');
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
  let partial = false;
  if (typeof flags.task === 'string') {
    const { keep, unlabelled } = eventsTouching(events, flags.task);
    show = show.filter((e) => keep.has(e));
    partial = unlabelled;
  }
  if (typeof flags.grep === 'string') show = show.filter((e) => JSON.stringify(e).includes(flags.grep));
  const n = numFlag(flags, 'n', { min: 1 }) ?? 40;
  for (const e of show.slice(-n)) {
    console.log(String(e.seq).padStart(5) + '  ' + String(e.at).slice(0, 19).replace('T', ' ') + '  ' + cmdLabel(e).slice(0, 46));
    for (const o of e.ops.slice(0, 4))
      console.log('        ' + (o.d ? '- ' : '  ') + o.p.join('.') + (o.d ? '' : ' → ' + JSON.stringify(o.v).slice(0, 60)));
    if (e.ops.length > 4) console.log('        …' + (e.ops.length - 4) + ' more change(s)');
  }
  console.log('\n' + show.length + ' of ' + events.length + ' event(s)' + (show.length > n ? ', last ' + n + ' shown' : '') + '.');
  if (partial)
    console.log('Some of this record predates commands recording which one they were, so a few older\n' +
                'events can only be matched by the words in their command line. Where a task is not\n' +
                'named there, its events cannot be found — read around the sequence numbers instead.');
}

// Which events touched a task. The old filter stringified the whole ops array —
// paths AND values — and asked whether the key appeared anywhere in it, then
// also matched the command label. Measured against a real 2,078-event record
// that found 15% of a task's events and was wrong about half of what it did
// find, while the footer printed a bare count that made a partial answer look
// like a complete one.
//
// An op's path names a task by its position, never by its key — `tasks.3.status`
// — so the positions have to be resolved. That is safe: `r.tasks` is only ever
// appended to, never spliced or reordered, and a key is never reassigned. One
// forward pass with the same `applyOps` the replay uses, so a root-level reseed
// event (which re-seats every task at once) is handled by construction rather
// than by pattern-matching paths.
//
// A key also travels as a VALUE in four places, and those are exactly the
// questions people open this command to ask — what was filed against this task,
// who is waiting on it — so resolving positions alone would have traded one kind
// of blindness for another.
const KEY_BEARING = [['defects', 'task'], ['owed', 'to'], ['tasks', 'bundledInto']];
function eventsTouching(events, key) {
  const keep = new Set();
  let unlabelled = false;
  let state = {};
  for (const e of events) {
    state = applyOps(state, e.ops);
    const tasks = (state && state.tasks) || [];
    let hit = false;
    for (const op of (e.ops || [])) {
      const p = op.p || [];
      if (!p.length) { hit = hit || tasks.some((t) => t && t.key === key); continue; }  // a reseed re-seats everything
      if (String(p[0]) === 'tasks' && p.length >= 2) {
        const t = tasks[Number(p[1])];
        if (t && t.key === key) { hit = true; continue; }
      }
      for (const [top, field] of KEY_BEARING)
        if (String(p[0]) === top && namesKey(op.v, field, key)) hit = true;
      if (String(p[0]) === 'tasks' && namesKey(op.v, 'needs', key)) hit = true;
    }
    if (!hit && !e.argv && cmdLabel(e).includes(key)) { hit = true; }
    if (!e.argv) unlabelled = true;
    if (hit) keep.add(e);
  }
  return { keep, unlabelled };
}
// Does this op's value name the key at the given field? The value can be the key
// itself (`owed.3.to` set to it), the object holding it (a whole defect pushed),
// or the whole collection (the first defect creates the array), so this has to
// look through what it is given rather than assume a shape.
function namesKey(v, field, key, depth = 0) {
  if (v === key) return true;
  if (depth > 4 || v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => namesKey(x, field, key, depth + 1));
  if (Object.prototype.hasOwnProperty.call(v, field)) {
    const f = v[field];
    if (f === key || (Array.isArray(f) && f.includes(key))) return true;
  }
  return Object.values(v).some((x) => x !== null && typeof x === 'object' && namesKey(x, field, key, depth + 1));
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
  // The root itself was assumed to be a single separator character, which is
  // true on POSIX (`/`) but not on Windows: `path.join('\\', 'C:')` makes
  // `\C:`, a path that cannot exist, so `here` emptied out on the very first
  // segment and every glob matched nothing. `path.parse().root` gives the real
  // root either way — `C:\`, a UNC share's `\\host\share\`, or `/` — and the
  // remaining segments are walked from there same as before.
  const root = path.parse(abs).root;
  const parts = abs.slice(root.length).split(path.sep).filter(Boolean);
  const seg = (s) => new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*') + '$');
  let here = [root];
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
          '       moved or deleted since `load`. Repoint the record at where it went:\n' +
          '         plan mv ' + rel(p) + ' <new-path>\n' +
          '       which carries its gaps and tasks across. Re-running `load` on the new path only\n' +
          '       appends a second entry beside this one unless the content is byte-identical.');
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
  const repointed = [];
  for (const f of files) {
    const body = fs.readFileSync(f, 'utf8');
    const entry = {
      path: rel(f),
      lines: body.split('\n').length,
      bytes: Buffer.byteLength(body),
      sha: crypto.createHash('sha256').update(body).digest('hex').slice(0, 12),
    };
    const at = reg.plans.findIndex((x) => x.path === entry.path);
    if (at >= 0) { reg.plans[at] = entry; continue; }
    // A plan that moved rather than a plan that is new: the registered path is
    // gone from disk and the content is byte-identical. Appending here is what
    // left nine stale entries beside nine live ones, with nothing able to tell
    // them apart afterwards and `scan` refusing on the stale half.
    const moved = reg.plans.findIndex((x) => x.sha === entry.sha &&
      !fs.existsSync(inProject(x.path)));
    if (moved >= 0) {
      const was = reg.plans[moved].path;
      for (const g of reg.gaps) if (g.plan === was) g.plan = entry.path;
      for (const t of reg.tasks || []) if (t.plan === was) t.plan = entry.path;
      reg.plans[moved] = entry;
      repointed.push(was + '  →  ' + entry.path);
      continue;
    }
    reg.plans.push(entry);
  }
  commit(reg);
  console.log('register: ' + rel(REG_PATH));
  for (const m of repointed) console.log('repointed (same content, old path gone): ' + m);
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
    for (const h of scanFile(inProject(p.path))) {
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
    const missing = silenceFile(inProject(p.path));
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
  if (flags.plan) gs = gs.filter((g) => norm(g.plan).includes(norm(flags.plan)));
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

// "answered" with nothing recorded under it is a claim with no evidence, and
// every reader that trusts the status and reaches for `g.answer.choice` breaks
// on it. `check` and `render` each grew their own copy of this test; `refine
// brief` never did, and threw a raw TypeError out of the driver instead. One
// definition, so the next reader cannot be the one that forgot.
function hollowGaps(gaps) {
  return gaps.filter((g) => g.status === 'answered' &&
    !(g.answer && typeof g.answer.choice === 'string' && g.answer.choice.trim()));
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
    // This is where a gap became "answered" with nothing under it — the state
    // that then broke `refine brief` and that `check` and `render` both refuse.
    // A status is a claim; `answer` is what records the evidence for it.
    if (k === 'status' && v === 'answered' && hollowGaps([{ ...g, status: 'answered' }]).length)
      die('cannot set ' + g.id + ' answered here — nothing would be recorded under it.\n' +
          '       A status is a claim; the answer is the evidence. Run: answer ' + g.id);
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
  // Every remaining term reference/plain-words.md names, from both of its
  // tables. `lintText` cites that file as the authority for what it refuses,
  // and was catching eighteen of its thirty-two words — so a question could
  // reach the user saying "add a soft delete and a throttle, using RBAC to
  // gate it" and be told it passed the plain-words rules. A method's real
  // name is the same failure wearing a lab coat: "FSRS" tells somebody who
  // is not an engineer exactly as little as "RBAC" does.
  'route', 'permission model', 'rbac', 'cache invalidation', 'marshal', 'eventual consistency',
  'configurable', 'retention policy', 'rate limit', 'throttl', 'optimistic locking',
  'audit trail', 'soft delete', 'partition', 'schema-on-read', 'parameteris', 'parameteriz',
  'fsrs', 'sm-17', 'sm-2', 'leitner', 'glicko', 'item response theory',
  'bayesian knowledge tracing', 'operational transform', 'exponential backoff',
  'bloom filter', 'token bucket', 'write-ahead log',
  'authoris', 'authoriz', 'provision', 'orchestrat', 'instantiat', 'parameteris', 'parameteriz'];

// Each entry above is a STEM, and a stem only counts where a word starts. Held
// as bare substrings they matched inside ordinary English — "orm" sits in
// normal, format, information, performance and platform, "api" in rapid — so
// the linter refused plain words and, naming only the stem, never said which
// word of the question it had objected to. Anchored to a word start and run on
// to the end of that word, it catches the growths a stem is there for
// ("schema" in schemas, "authoris" in authorisation) and reports the word the
// writer actually used.
// Short names that are also the start of ordinary words. A stem grows to the end
// of the word it begins, which is what makes "schema" catch "schemas" — and what
// would make "elo" catch "eloquent". These are matched whole and nothing else.
const JARGON_EXACT = ['elo'];
const JARGON_RE = new RegExp(
  '\\b(?:' + JARGON.map((j) => j.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[a-z]*' +
  '|\\b(?:' + JARGON_EXACT.join('|') + ')\\b', 'i');

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
  const hollow = hollowGaps(reg.gaps);
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
  const hollow = hollowGaps(done);
  if (hollow.length)
    die(hollow.length + ' gap(s) are marked answered with no answer recorded: ' +
        hollow.map((g) => g.id).join(', ') + '\n       Record each with `answer <id>`, or set it back to gap.');
  if (flags.plan) {
    const gs = done.filter((g) => norm(g.plan).includes(norm(flags.plan)));
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
  // Tolerant of either slash spelling on both sides — the needle a user typed
  // and a `.path` a register may still hold from before `rel` normalised.
  const need = norm(needle);
  const hits = r.plans.filter((x) => norm(x.path).includes(need));
  if (!hits.length) die('no plan matching "' + needle + '"');
  if (hits.length > 1) die('"' + needle + '" matches ' + hits.length + ': ' + hits.map((h) => h.path).join(', '));
  return hits[0];
}

// `load` matches a plan by its path, so a renamed plan is a new entry beside a
// stale one, and `load` was the only thing that ever wrote `reg.plans` — there
// was no way back. This project renames a plan when every piece of it lands, so
// the workflow guarantees the paths go stale, and `scan` then refuses outright
// while telling you to re-run `load` — which is what appends the duplicate. The
// instruction caused the state it was diagnosing.
function planRefs(r, p) {
  return {
    gaps: r.gaps.filter((g) => g.plan === p),
    tasks: tasks(r).filter((t) => t.plan === p),
  };
}

function cmdPlan(sub, rest, flags) {
  const r = readReg();
  if (sub === 'mv') {
    const [from, to] = rest;
    if (!from || !to) die('plan mv <old-path> <new-path> — repoint a plan the tree has moved');
    const e = planEntry(r, from);
    const dest = path.resolve(CWD, to);
    if (!fs.existsSync(dest)) die('nothing at ' + rel(dest) + ' — mv the file first, then repoint the record');
    const was = e.path;
    const newPath = rel(dest);
    if (was === newPath) return console.log(was + ' is already where the record says.');
    const clash = r.plans.find((x) => x.path === newPath && x !== e);
    // the duplicate this command exists to undo: fold it back rather than refuse
    if (clash) r.plans.splice(r.plans.indexOf(clash), 1);
    const body = fs.readFileSync(dest, 'utf8');
    e.path = newPath;
    e.lines = body.split('\n').length;
    e.bytes = Buffer.byteLength(body);
    e.sha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
    // A rename that moves the entry and leaves the back-references orphans the
    // gaps instead of the plan, which is the same loss wearing a different hat.
    const ref = planRefs(r, was);
    for (const g of ref.gaps) g.plan = newPath;
    for (const t of ref.tasks) t.plan = newPath;
    // `owns` is a back-reference too, and the one the collision check actually
    // reads. Leaving it behind meant a renamed plan left its task claiming a
    // path that no longer exists and NOT claiming the file it now edits — so two
    // chips could both take the new path with nothing objecting. Scan every
    // task, not just the ones whose `plan` matched: the two fields move
    // independently, and on a real record six tasks had them disagreeing.
    let owned = 0;
    for (const t of tasks(r)) {
      const owns = t.owns || [];
      for (let i = 0; i < owns.length; i++)
        if (norm(owns[i]) === norm(was) && !owns.some((o) => norm(o) === norm(newPath))) { owns[i] = newPath; owned++; }
    }
    commit(r);
    console.log(was + '  →  ' + newPath);
    console.log('  ' + ref.gaps.length + ' gap(s) and ' + ref.tasks.length + ' task(s) repointed' +
      (owned ? ', ' + owned + ' ownership claim(s) moved with it' : '') +
      (clash ? '; the duplicate entry a previous `load` appended was folded in' : '') + '.');
  } else if (sub === 'rm') {
    const [which] = rest;
    if (!which) die('plan rm <path> — drop a plan entry from the record');
    const e = planEntry(r, which);
    const ref = planRefs(r, e.path);
    if ((ref.gaps.length || ref.tasks.length) && !flags.force)
      die(e.path + ' still has ' + ref.gaps.length + ' gap(s) and ' + ref.tasks.length + ' task(s) pointing at it.\n' +
          '       Dropping it orphans them. Repoint with `plan mv`, or pass --force if the plan is\n' +
          '       really gone and those references are meant to dangle.');
    r.plans.splice(r.plans.indexOf(e), 1);
    commit(r);
    console.log('dropped ' + e.path + '. ' + r.plans.length + ' plan(s) left on record.');
    if (ref.gaps.length || ref.tasks.length)
      console.log('⚠ ' + ref.gaps.length + ' gap(s) and ' + ref.tasks.length + ' task(s) now point at a plan that is not on record.');
  } else if (sub === 'list' || sub === undefined) {
    if (!r.plans.length) return console.log('no plans loaded.');
    for (const p of r.plans) {
      const there = fs.existsSync(inProject(p.path));
      const ref = planRefs(r, p.path);
      console.log((there ? '  ' : '✗ ') + p.path.padEnd(50) +
        String(ref.gaps.length).padStart(3) + ' gap(s) ' + String(ref.tasks.length).padStart(3) + ' task(s)' +
        (there ? '' : '   NOT ON DISK — `plan mv` it to where it went'));
    }
  } else die('plan mv <old> <new>|rm <path> [--force]|list');
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

// Exactly the fields the brief's text is built from. `notes` and the pre-flight
// notes are in it now BECAUSE they are rendered now — they were excluded on the
// grounds that a notes-only change must not cry stale, which was true only while
// the brief did not show them, and which meant every reader of this hash was
// structurally unable to notice the omission. Editing a task's note to "the auth
// check is inverted, do not ship" changed nothing anybody could see.
//
// `orchestrator` is NOT in it. `resume` reassigns that address after every
// compaction — eleven times on one real run — and each reassignment marked all
// 116 briefs stale at once for a reason that has nothing to do with any task,
// forcing a rewrite of live briefs under the agents holding them. A handover is
// worth surfacing; it is not a change to the work.
function briefSha(t, r) {
  return crypto.createHash('sha256').update(JSON.stringify({
    key: t.key, title: t.title, plan: t.plan, needs: t.needs, owns: t.owns,
    serialises: t.serialises || [], context: t.context, verify: t.verify,
    decisions: r ? decisionsOf(r, t) : t.decisions, branch: t.branch,
    notes: t.notes || '', preflightNotes: (t.preflight && t.preflight.notes) || '',
    bundleOrder: t.bundleOrder || [],
  })).digest('hex').slice(0, 12);
}

function cmdRefineBrief(needle) {
  const r = readReg(); const p = planEntry(r, needle);
  const mine = r.gaps.filter((g) => g.status === 'answered' && g.plan === p.path);
  // Was a raw TypeError out of the driver: this reads g.answer.choice below and
  // was the one such reader with no check that there is an answer to read. Say
  // which gaps, and what fixes them, the way `check` and `render` already do.
  const hollow = hollowGaps(mine);
  if (hollow.length)
    die(hollow.length + ' gap(s) on this plan are marked answered with nothing recorded under them,\n' +
        '       so the brief cannot say what was settled:\n' +
        hollow.map((g) => '         ' + g.id + '  ' + (g.title || g.quote.slice(0, 60)) +
                          '   — run `answer ' + g.id + '`').join('\n'));
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
  let rep, source;
  if (fs.existsSync(src)) {
    source = 'file';
    try { rep = JSON.parse(fs.readFileSync(src, 'utf8')); }
    catch (e) { die('the report at ' + rel(src) + ' is not valid JSON: ' + e.message + '\n       Send it back to the agent — do not retype it yourself.'); }
    console.log("read the agent's own report: " + rel(src));
  } else {
    // Older flow, and the escape hatch: JSON piped in. Still works, but the file
    // is better — it cannot lose a line to a compaction on the way here.
    source = 'stdin';
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
    if (!raw.trim()) die('no report at ' + rel(src) + ' and nothing on stdin.\n' +
      '       The agent was told to write its report to that path. Ask it to,\n' +
      '       rather than retyping what it told you — that is how files get dropped.');
    try { rep = JSON.parse(raw); } catch (e) { die('bad JSON on stdin: ' + e.message); }
    console.log('⚠ took the report from stdin, not from the agent\'s own file.');
    console.log('  It passed through your context to get here, so check nothing was lost.');
  }
  // Which of the two routes a report came in by is a fact about how much to
  // trust it — the file cannot lose a line to a compaction, stdin can. It was
  // said once on the console and then thrown away, so afterwards the two were
  // indistinguishable. `refined` on its own is also indistinguishable from a
  // plan marked refined by an older driver that kept no report at all; naming
  // the source is what lets `doctor` tell those apart.
  p.refined = true; p.refinedAt = now(); p.refineSource = source;
  p.refineSummary = rep.summary || '';
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
// Every ownership question comes down to "are these two strings the same file",
// and this was answering it by string equality with three cosmetic strips. So
// `apps/api/x.py` did not collide with `apps/api//x.py`, with `apps/api/./x.py`,
// with `apps/api/sub/../x.py`, or — the one that reached a real record — with an
// absolute spelling of itself. Each of those defeats the gate the whole parallel
// arrangement rests on: same file means one waits.
//
// Deliberately NOT trimmed, and deliberately not case-folded. Two of the callers
// compare against git's own output, where a name may legitimately carry a space
// and where git is case-sensitive whatever the filesystem underneath; a compare
// function that quietly equated those would make `guard` accept a file that is
// not the one it was shown. Whitespace is trimmed where paths are authored.
function norm(p) {
  // A register written before `rel` was fixed to emit forward slashes still has
  // `docs\plans\p.md` on disk, and a Windows shell will hand this a needle spelled
  // the same way even now — so backslashes are folded to `/` before anything else
  // runs, and old and new records read alike.
  let x = String(p).replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/\*+$/, '');
  while (x.startsWith('./')) x = x.slice(2);
  // after the strips, not before: normalize leaves a trailing slash alone
  x = path.posix.normalize(x);
  return x === '.' ? '' : x.replace(/\/+$/, '');
}
// one-directional: does the owned entry `own` cover the path `p`?
function coveredBy(own, p) { const o = norm(own), x = norm(p); return x === o || x.startsWith(o + '/'); }

// A path field that only had to be a non-empty string let a pre-flight report
// come back with seventeen of nineteen entries written as prose — "the verify
// list itself", "apps/api/Dockerfile:7 — ENV PATH=… must be set" — and the
// `task add` line printed from it put every one of them into `owns`. Once
// there, prose matches itself, so `preflight check` goes green on it and the
// pollution stops being visible. This is the check that says a path is a path.
// Anything that actually exists on disk passes whatever it looks like: that is
// the one unambiguous signal available, and it costs a stat.
function pathProblem(s) {
  const v = String(s).trim();
  if (!v) return 'is empty';
  try { if (fs.existsSync(inProject(v))) return null; } catch { /* unreadable is not proof */ }
  if (/\s[—–]\s|\s--\s/.test(v)) return 'contains an em-dash clause — that is prose, not a path';
  if (/["'`$=]/.test(v)) return 'contains quote or shell characters';
  if (/:\d+/.test(v)) return 'carries a :line suffix — ownership is whole files';
  if (v.split(/\s+/).length > 2) return 'reads as a sentence, not a path';
  if (!/[/.]/.test(v)) return 'has no directory separator and no extension';
  return null;
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
  // `pathProblem` guards the pre-flight intake and backstops in `doctor`, but
  // never ran here — the primary way a path reaches `owns`. Shape is checked
  // there; what has to be checked HERE is that the spelling can be compared:
  // ownership is matched between tasks as repository-relative text, so an
  // absolute path silently collides with nothing, including its own relative
  // twin. It passes `pathProblem` too, because the file it names really exists.
  for (const k of ['owns', 'context'])
    for (const e of (Array.isArray(it[k]) ? it[k] : [])) {
      const v = typeof e === 'string' ? e : (e && e.path);
      if (typeof v !== 'string' || !v.trim()) continue;
      if (path.isAbsolute(v.trim()))
        probs.push(k + ' entry "' + v.trim().slice(0, 60) + '" is an absolute path — ownership is compared ' +
          'between tasks as repository-relative text, so this matches nothing, not even the same file written the usual way');
      else if (norm(v.trim()).split('/').includes('..'))
        probs.push(k + ' entry "' + v.trim().slice(0, 60) + '" climbs out of the repository');
    }
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
    // Trim here, where a path is authored, rather than in the compare function —
    // a file may legitimately carry a leading or trailing space, and `guard` and
    // `board` compare against git's own output, where quietly equating "x.py "
    // with "x.py" would accept a file that is not the one they were shown.
    if (Array.isArray(it.owns)) it.owns = it.owns.map((o) => o.trim());
    if (Array.isArray(it.context)) it.context = it.context.map((c) => ({ ...c, path: String(c.path).trim() }));
    if (Array.isArray(it.serialises)) it.serialises = it.serialises.map((s) => s.trim());
    plans.push({ it, at, label });
  }
  // "two tasks may not touch one file" was asserted in the message above and
  // then never checked against another task. A path claimed twice is the one
  // failure this whole arrangement exists to prevent, so a NEW task claiming a
  // path some still-open task already owns is refused here, at the only moment
  // it is cheap to fix. Existing state is not re-judged — `doctor` reports that
  // — because a register with the collision already in it must stay usable.
  const contender = (t) => !['landed', 'cancelled'].includes(t.status);
  // An update used to skip this check entirely, on the grounds that existing
  // state must not be re-judged. But an update that ADDS a path is a new claim
  // wearing an update's clothes, and `preflight done` prints exactly such an
  // update under the words "do not retype it" — so the one collision this whole
  // arrangement exists to prevent arrived through the door left open for it.
  // Only the paths an update adds are judged; the ones it already had stay
  // grandfathered, so a register with a collision already in it is still usable
  // and `doctor` remains the thing that reports those.
  const claimedNow = (p) => {
    if (p.at < 0) return p.it.owns || [];
    if (p.it.owns === undefined) return [];               // not an ownership change
    const had = new Set(tasks(r)[p.at].owns || []);
    return p.it.owns.filter((o) => !had.has(o));
  };
  // What each still-open task will own once this batch applies. Judging against
  // the register alone read a narrowing task's stale entry, so the one correct
  // way to hand a file over — narrow one and widen the other in a single batch —
  // was refused against ownership that the same batch was giving up.
  const after = new Map();
  const fromBatch = new Set();
  for (const t of tasks(r)) if (contender(t)) after.set(t.key, [...(t.owns || [])]);
  for (const p of plans) {
    if (p.at >= 0 && !contender(tasks(r)[p.at])) continue; // finished work claims nothing
    if (p.it.owns !== undefined) { after.set(p.it.key, [...p.it.owns]); fromBatch.add(p.it.key); }
    else if (p.at < 0) after.set(p.it.key, []);
  }
  for (const p of plans) {
    const { it, at, label } = p;
    if (at >= 0 && !contender(tasks(r)[at])) continue;
    for (const own of claimedNow(p)) {
      const clashes = [];
      for (const [key, owns] of after) {
        if (key === it.key) continue;
        for (const b of owns) if (collides(own, b))
          clashes.push(key + (fromBatch.has(key) ? ' (same batch)' : '') + ' owns ' + b);
      }
      if (clashes.length)
        errs.push(label + ' claims ' + own + ', which is already owned: ' + [...new Set(clashes)].join('; ') +
          ' — two tasks may not touch one file. Narrow one of them, or make one wait for the other and split the file.');
    }
  }
  // The same question for serialisation points, which had no version of it at
  // all. `owns` gained this check because a widening update could hand two open
  // chips one file; `serialises` can hand two open chips one invariant the same
  // way, and that is the thing only one of them may move. Judged against work
  // that is actually in flight — two PLANNED tasks naming a point is ordinary,
  // and `chip` is what refuses to open the second of them.
  const flying = new Map();
  for (const t of tasks(r)) if (OPEN_STATUSES.includes(t.status))
    flying.set(t.key, (t.serialises || []).map(normPoint));
  for (const { it, at, label } of plans) {
    if (it.serialises === undefined) continue;
    if (at < 0 || !OPEN_STATUSES.includes(tasks(r)[at].status)) continue;   // not in flight: chip will judge it
    const held = new Set((tasks(r)[at].serialises || []).map(normPoint));
    for (const s of it.serialises) {
      if (held.has(normPoint(s))) continue;                                 // already theirs
      for (const [key, points] of flying) {
        if (key === it.key) continue;
        if (points.includes(normPoint(s)))
          errs.push(label + ' takes the serialisation point "' + s + '", which ' + key +
            ' is holding while it runs — a point is the thing only one of them may move.' +
            ' Wait for ' + key + ' to land, or take the point off one of them.');
      }
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
  // Waves are recomputed from `needs` on every call, so a task created with none
  // joins round 1 however late it is — and the checkpoint filed when it lands
  // then covers every task round 1 ever held. Adding work to an open round is
  // legitimate; being unable to tell afterwards is not. So: warn, do not refuse.
  const fresh = plans.filter((p) => p.at < 0 && !(p.it.needs || []).length).map((p) => p.it.key);
  if (fresh.length) {
    const w0 = waves(r).find((w) => w.wave === 0);
    const landed = w0 ? w0.tasks.filter((t) => t.status === 'landed').map((t) => t.key) : [];
    if (landed.length) {
      console.log('\n⚠ ' + fresh.join(', ') + ' ' + (fresh.length > 1 ? 'have' : 'has') +
        ' no `needs`, so ' + (fresh.length > 1 ? 'they join' : 'it joins') + ' round 1 — which already has ' +
        landed.length + ' landed task(s). The checkpoint filed when ' +
        (fresh.length > 1 ? 'they land' : 'it lands') + ' will re-cover ' + landed.join(', ') + '.');
      console.log('  Give ' + (fresh.length > 1 ? 'them' : 'it') + ' `needs` naming the last landed task if ' +
        (fresh.length > 1 ? 'they should be a round' : 'it should be a round') + ' of its own.');
    }
  }
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

// A bundle's members are handed to one agent as a list to work through, and the
// brief prints that list as "do them in this order". The order was whatever the
// command line happened to say — and `bundle suggest` built its own suggestion
// from the order tasks were added, which is not dependency order and on a real
// plan was sometimes exactly backwards. Sort it here, once, so both the stored
// order and the suggested command line are orders that can actually be worked.
//
// Stable: members with no dependency between them keep the order they came in,
// so a coherent hand-written list is not shuffled for no reason. A cycle cannot
// be ordered, so what is left over is appended rather than dropped — a bundle
// that names one is still bundled, and `graph` is where a cycle gets reported.
function bundleOrder(members) {
  const mine = new Set(members.map((m) => m.key));
  const left = [...members];
  const out = [], done = new Set();
  while (left.length) {
    const i = left.findIndex((m) => (m.needs || []).every((n) => !mine.has(n) || done.has(n)));
    if (i < 0) { out.push(...left); break; }          // cycle — keep them, do not lose them
    const [m] = left.splice(i, 1);
    out.push(m); done.add(m.key);
  }
  return out;
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
      // Dependency order, not discovery order — this line is copied and run
      // verbatim, and `bundle` keeps the order it is given as the order the
      // agent is told to work in.
      const keys = bundleOrder(g.members).map((t) => t.key);
      const owns = new Set(g.members.flatMap((t) => t.owns || []));
      let planBytes = 0;
      try { planBytes = fs.statSync(inProject(g.plan)).size; } catch { /* gone */ }
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
  // The working order is every member sorted by what each one needs — including
  // the host, which the brief prints first whether or not it is first. Keep it
  // whole rather than deriving it at render time: the members are cancelled a
  // few lines below, and their `needs` are the only surviving record of the
  // order they had to be done in.
  const ordered = bundleOrder(members);
  host.bundleOrder = ordered.map((m) => m.key);
  const others = ordered.filter((m) => m.key !== into);
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
  // Work that has landed or been cancelled is not unblocked by anything — it is
  // over. Counting it inflated the number printed beside each candidate AND the
  // sort that decides what to offer first, so a task whose every dependent had
  // been absorbed by `bundle` still read as the one to open next.
  const unblocksOf = (key) => tasks(r).filter((x) =>
    !DEAD_STATUS.includes(x.status) && (x.needs || []).includes(key)).length;
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
    // The host is not necessarily the first step — `--into` picks which task
    // survives, not which one is done first. Printing it at the top regardless
    // put a step before its own dependency. Use the recorded order when there
    // is one; older bundles have none, and fall back to what they had.
    const titles = new Map([[t.key, String(t.title).replace(/ \(\+ [^)]*\)$/, '')],
      ...t.bundled.map((b) => [b.key, b.title])]);
    const seq = (t.bundleOrder || []).length ? t.bundleOrder
      : [t.key, ...t.bundled.map((b) => b.key)];
    for (const k of seq) if (titles.has(k)) B.push('- ' + k + ' — ' + titles.get(k));
    B.push('');
  }
  if (t.plan) {
    B.push('**The plan.** Read it in full before writing anything:');
    B.push('');
    B.push('    ' + inProject(t.plan));
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
  // `notes` and the pre-flight's own notes were the two fields nothing ever
  // rendered. A pre-flight exists to find what the plan missed BEFORE anyone
  // starts, and every word of what it found was landing in a field the brief did
  // not print — so the agent it was written for never saw it. Two thirds of the
  // tasks on a real run carried a note, including "you do not own the plans
  // directory", and the orchestrator ended up hand-writing a second file beside
  // the brief to carry them, which nothing in this tool knows how to keep current.
  const notes = String(t.notes || '').trim();
  const pfNotes = String((t.preflight && t.preflight.notes) || '').trim();
  if (notes || pfNotes) {
    B.push('**Read this before you start. It is here because somebody found it the hard way:**');
    B.push('');
    if (notes) { for (const line of notes.split('\n')) B.push(line); B.push(''); }
    if (pfNotes) {
      B.push('From the pre-flight agent that read this task against the real code:');
      B.push('');
      for (const line of pfNotes.split('\n')) B.push('> ' + line);
      B.push('');
    }
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
  // Was: "it will not be inside your own copy of the repository." Nothing in
  // this tool writes into a worktree, but something outside it copies
  // `.claude/orchestration/` into each one — so there often IS a copy in there,
  // it is a snapshot of the moment the chip opened, and no command can refresh
  // it. Telling the agent the file is only over here made the stale copy in its
  // own tree look like the same file. Say which one is authoritative instead.
  console.log('Read it at that absolute path, in the main checkout. If a copy of it exists inside');
  console.log('your own tree, it is a snapshot from when this chip opened and nothing updates it —');
  console.log('the one above is the live one.');
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

function cmdBriefAll(flags) {
  const r = readReg();
  let n = 0;
  let same = 0;
  const moved = [];
  // "Run it after any correction" is safe advice only while nothing is holding a
  // brief. A rewrite moves briefSha and briefAt under whoever has it, so an agent
  // part-way through — one taking a snapshot of the register, in particular —
  // finds its own copy no longer reproduces. --dry-run answers "what would this
  // disturb" without disturbing it.
  if (flags && flags['dry-run']) {
    for (const t of tasks(r)) {
      if (['cancelled', 'landed'].includes(t.status)) continue;
      n++;
      if (t.briefSha && t.briefSha !== briefSha(t, r)) moved.push(t);
    }
    console.log(n + ' live brief(s); ' + moved.length + ' would be rewritten. Nothing was written.');
    for (const t of moved) console.log('  would change: ' + t.key + '  (' + t.status + ')' +
      (t.agent ? '  — held by ' + t.agent : '  — not handed out'));
    if (moved.some((t) => t.agent))
      console.log('\nAn agent holding one of these has to be told to re-read it. If one is taking a\n' +
                  'register snapshot right now, let it commit first — a snapshot has to be the last\n' +
                  'thing it does before committing, or it cannot reproduce its own copy.');
    return;
  }
  for (const t of tasks(r)) {
    if (['cancelled', 'landed'].includes(t.status)) continue;
    const before = t.briefSha;
    cmdBriefQuiet(t.key);
    n++;
    const after = getTask(readReg(), t.key);
    if (after.briefSha === before) same++;
    // Naming the agent turns "somebody should be told" into an instruction that
    // can be carried out without looking anything up.
    else if (before) {
      moved.push(after);
      console.log('  changed: ' + t.key + '  → ' +
        (after.agent ? 'message ' + after.agent + ' to re-read it' : 'not handed out yet, so nobody is holding it'));
    }
  }
  console.log(n + ' brief(s) checked in ' + orchDir('briefs') + '; ' + (n - same) + ' rewritten, ' + same + ' already current.');
  if (moved.some((t) => t.agent))
    console.log('A held brief that moved is one its agent is no longer working from. Tell each named\n' +
                'agent above; if one is mid-snapshot of the register, its copy will not reproduce.');
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
  if (t.plan) B.push('**Its plan, read it in full:** ' + inProject(t.plan));
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
  B.push('`path` is a **bare repository-relative file path** and nothing else — no `:line` suffix,');
  B.push('no explanation, no prose. It goes straight into the task\'s ownership list, so a sentence');
  B.push('there becomes a file nobody owns. Everything you want to say about it goes in `why`.');
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
    // `path` goes straight into `owns` through the line printed below, so a
    // path that is not a path has to stop here rather than downstream.
    else if (Array.isArray(rep.missing))
      for (const m of rep.missing) {
        const why = pathProblem(m.path);
        if (why) bad.push('missing path "' + String(m.path).slice(0, 60) + '" ' + why +
          '\n         — `path` is a bare repository-relative file path; the explanation belongs in `why`');
      }
    if (rep.serialises !== undefined && (!Array.isArray(rep.serialises) ||
        rep.serialises.some((x) => typeof x !== 'string' || !x.trim())))
      bad.push('serialises must be a list of names');
    if (rep.verify !== undefined && (!Array.isArray(rep.verify) ||
        rep.verify.some((v) => !v || typeof v !== 'object')))
      bad.push('verify must be a list of {command, runnable, why}');
  }
  if (bad.length) die('the report at ' + rel(src) + ' is not usable — send it back rather than fixing it here:\n       ' + bad.join('\n       '));
  // A second pre-flight used to replace the first outright, so a gap the first
  // run found and nobody has closed yet simply vanished — and `preflight check`
  // then went green on the loss. Carry forward anything the new report does not
  // mention and `owns` does not already cover: a gap stops being owed because it
  // was settled, not because it was left out of the next report.
  const fresh = rep.missing || [];
  const named = new Set(fresh.map((m) => m.path));
  const kept = ((t.preflight && t.preflight.missing) || []).filter((m) =>
    !named.has(m.path) && !(t.owns || []).some((o) => coveredBy(o, m.path)));
  t.preflight = { at: now(), missing: [...fresh, ...kept],
    verify: rep.verify || [], notes: rep.notes || '' };
  if (kept.length)
    console.log('carried forward ' + kept.length + ' gap(s) the earlier pre-flight found and this one does not mention: ' +
      kept.map((m) => m.path).join(' '));
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

// Is `b` something the shell that runs `verify` would actually find? This used
// to shell out to `command -v` under `/bin/bash`, which does not exist on
// native Windows Node — so `spawnSync` came back ENOENT for every single verify
// binary and `doctor` reported the whole project broken. Walking PATH by hand
// needs no shell at all, so it works the same on every OS, and it is what
// `command -v` was doing internally anyway.
function findBin(b) {
  if (b.includes('/') || b.includes('\\')) {                 // given as a path, not a bare name
    try { return fs.statSync(b).isFile() ? b : null; } catch { return null; }
  }
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const cand = path.join(dir, b + ext);
      try {
        if (!fs.statSync(cand).isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(cand, fs.constants.X_OK);
        return cand;
      } catch { /* not this one */ }
    }
  }
  return null;
}

function cmdDoctor(flags = {}) {
  const r = readReg();
  const binCache = {};
  const binOk = (b) => {
    if (!(b in binCache)) binCache[b] = !!findBin(b);
    return binCache[b];
  };
  let bad = 0, checked = 0;
  for (const t of tasks(r)) {
    if (['landed', 'cancelled'].includes(t.status)) continue;
    checked++;
    const probs = [];
    if (t.plan && !fs.existsSync(inProject(t.plan))) probs.push('its plan does not exist: ' + t.plan);
    for (const c of t.context || []) {
      if (!c || typeof c !== 'object' || typeof c.path !== 'string') { probs.push('a context entry is not {path, what} — fix the record'); continue; }
      if (!fs.existsSync(inProject(c.path))) probs.push('told to build on a path that does not exist: ' + c.path);
    }
    const vlist = Array.isArray(t.verify) ? t.verify : (t.verify ? [String(t.verify)] : []);
    for (const v of vlist) {
      // skip leading VAR=value assignments — `CI=1 pnpm test` tests pnpm, not CI=1
      const toks = String(v).trim().split(/\s+/).filter(Boolean);
      const bin = (toks.find((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) || '').replace(/^[(]+/, '');
      if (bin && !binOk(bin)) probs.push('verify command\'s binary is not on PATH: `' + bin + '`  (' + v + ')');
    }
    // The backstop for prose that reached `owns` before the gate above existed.
    // An entry that is not a path can never be matched by a diff, so `guard`
    // cannot judge it and `preflight check` goes green on it matching itself.
    for (const own of t.owns || []) {
      const why = pathProblem(own);
      if (why) probs.push('owns an entry that is not a path: "' + String(own).slice(0, 60) + '" — ' + why);
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
  // The other half of the same question, and the one that is actually a breach.
  // Two tasks may both NAME a point — that is what a point is for. What may not
  // happen is both being in flight at once, because a point is the thing only
  // one of them may move. `chip` refuses to open the second, but `task add` and
  // `preflight done` can widen `serialises` on a task that is already running,
  // and nothing looked afterwards. Only the lone case was ever reported.
  const flying = tasks(r).filter((t) => OPEN_STATUSES.includes(t.status));
  const shared = new Map();
  for (const t of flying) for (const s of t.serialises || []) {
    const e = shared.get(normPoint(s)) || { keys: new Set(), spellings: new Set() };
    e.keys.add(t.key); e.spellings.add(s);
    shared.set(normPoint(s), e);
  }
  const contended = [...shared.entries()].filter(([, e]) => e.keys.size > 1);
  if (contended.length) {
    bad += contended.length;
    console.log('✗ ' + contended.length + ' serialisation point(s) held by more than one chip at once:');
    for (const [, e] of contended)
      console.log('    ' + [...e.spellings].join(' ≈ ') + '   (' + [...e.keys].join(' ↔ ') + ')');
    console.log('    A point is the thing only one of them may move. Whichever was opened second');
    console.log('    should not have been — hold it until the other lands.');
  }
  // A pre-flight report is an ordinary file an agent writes; nothing folds it
  // into the record but a person running `preflight done`. That step is not
  // required anywhere, so a report can be written and simply never acted on —
  // on a real run 25 of 53 were, eight of them still naming load-bearing gaps.
  const orphans = [];
  try {
    for (const f of fs.readdirSync(orchDir('preflight'))) {
      if (!f.endsWith('.json')) continue;
      const t = tasks(r).find((x) => fileKey(x.key) + '.json' === f);
      if (!t) { orphans.push(f + '  (no task by that key)'); continue; }
      if (!(t.preflight && t.preflight.at)) orphans.push(f + '  → ' + t.key + ' — run `preflight done ' + t.key + '`');
    }
  } catch { /* no preflight dir yet */ }
  if (orphans.length) {
    bad += orphans.length;
    console.log('✗ ' + orphans.length + ' pre-flight report(s) written but never folded into the record:');
    for (const x of orphans.slice(0, 20)) console.log('    ' + x);
    if (orphans.length > 20) console.log('    … and ' + (orphans.length - 20) + ' more.');
    console.log('    What the agent found is sitting on disk where nothing reads it.');
  }
  // The backups are described as a second net, and on a gitignored register they
  // are the only one. Their depth is counted in writes, not in time, so a busy
  // run silently thins the net: thirty states covered one hour and three quarters
  // of a seventy-hour run, which is why the drift that run carried could no
  // longer be dated. Say what the net actually reaches.
  try {
    const bdir = path.join(path.dirname(path.resolve(CWD, REG_PATH)), 'backups');
    const bs = fs.readdirSync(bdir).filter((f) => f.startsWith('register-')).sort();
    if (bs.length >= 30) {
      const oldest = fs.statSync(path.join(bdir, bs[0])).mtimeMs;
      const hrs = (Date.now() - oldest) / 3600000;
      const span = hrs < 2 ? Math.round(hrs * 60) + ' minutes' : Math.round(hrs) + ' hours';
      console.log('· the backup ring is full (' + bs.length + ' states) and reaches back ' + span + '.');
      console.log('    Depth is counted in writes, not time — a busy run thins it without saying so.');
      console.log('    If the register is gitignored, that is the whole of its history.');
    }
  } catch { /* no backups yet */ }
  // `refined` was set by an older driver that kept no report, and by this one
  // which does. Nothing distinguished them, so "refined, and the evidence
  // predates the log" read exactly like "marked refined, never actually done".
  const unevidenced = (r.plans || []).filter((p) => p.refined && !p.refineSource &&
    !fs.existsSync(reportPath(p.path)));
  if (unevidenced.length) {
    console.log('· ' + unevidenced.length + ' plan(s) marked refined with no report on disk and no source recorded:');
    for (const p of unevidenced) console.log('    ' + p.path);
    console.log('    Either the refining predates this record, or it never happened. Nothing here can');
    console.log('    tell you which — re-run `refine brief` on any you cannot vouch for.');
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
  if (flags.repair) { repair(r, flags); return; }
  if (bad) { console.error('\n' + bad + ' problem(s). Fix the record (`brief --all` after), reassign or settle any shut\n' +
    'owed item, then run doctor again.'); process.exit(1); }
}

// Some of what `doctor` reports is damage a bug left behind, and saying so over
// and over does not clear it. This mends the two kinds that can be mended
// without guessing, and says plainly what it is inferring where it infers
// anything. Dry by default: it prints what it would do and writes nothing until
// asked, because a repair is a write to somebody's record on the strength of a
// reading of it.
function repair(r, flags) {
  const write = !!flags.write;
  const did = [];

  // Exact. A report on disk, a task by that key, and nothing folded in.
  for (const t of tasks(r)) {
    const src = preflightReportPath(t.key);
    if (!fs.existsSync(src) || (t.preflight && t.preflight.at)) continue;
    let rep = null;
    try { rep = JSON.parse(fs.readFileSync(src, 'utf8')); } catch { /* not usable */ }
    if (!rep || typeof rep !== 'object' || Array.isArray(rep)) {
      console.log('· ' + t.key + ': its pre-flight report is not readable — send it back, do not fold it.');
      continue;
    }
    did.push({ what: 'fold the pre-flight report into ' + t.key, apply: () => {
      t.preflight = { at: now(), missing: rep.missing || [], verify: rep.verify || [], notes: rep.notes || '' };
      for (const x of rep.serialises || []) { (t.serialises ||= []); if (!t.serialises.includes(x)) t.serialises.push(x); }
    } });
  }

  // Inferred, and said so. `plan mv` used to repoint a task's `plan` and leave
  // its `owns` claim on the old path — so the tell is an owned path that is not
  // on disk while a plan on record differs from it only in the part that names
  // the plan's status. Only where exactly one plan matches; otherwise it is a
  // guess and gets reported instead.
  const stem = (x) => x.replace(/--[^/]*$/, '');
  for (const t of tasks(r)) {
    for (let i = 0; i < (t.owns || []).length; i++) {
      const o = t.owns[i];
      if (fs.existsSync(inProject(o))) continue;
      const cands = (r.plans || []).filter((pl) =>
        stem(pl.path) === stem(o) && pl.path !== o && fs.existsSync(inProject(pl.path)));
      if (cands.length !== 1) {
        console.log('· ' + t.key + ' owns ' + o + ', which is not on disk, and nothing on record clearly replaces it.');
        continue;
      }
      const to = cands[0].path;
      did.push({ what: t.key + ': repoint owns ' + o + ' → ' + to + '  (inferred: same plan, renamed)',
        apply: () => { t.owns[i] = to; } });
    }
  }

  if (!did.length) { console.log('\nNothing here can be mended without guessing.'); return; }
  console.log('\n' + did.length + ' thing(s) can be mended:');
  for (const x of did) console.log('    ' + x.what);
  if (!write) {
    console.log('\nNothing was written. Run it again with --write to apply.');
    return;
  }
  for (const x of did) x.apply();

  // A repair that widens or repoints ownership can create the very collision
  // this tool exists to prevent, so the result is judged before it is kept.
  const open = tasks(r).filter((t) => !DEAD_STATUS.includes(t.status));
  const clash = [];
  for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
    const o = overlap(open[i], open[j]);
    if (o.length) clash.push(open[i].key + ' ↔ ' + open[j].key + '   ' + o.join('; '));
  }
  if (clash.length) {
    console.error('\n✗ that would leave ' + clash.length + ' pair(s) of open tasks claiming one path:');
    for (const x of clash.slice(0, 10)) console.error('    ' + x);
    console.error('  Nothing was written. Settle the ownership by hand — a repair may not create');
    console.error('  the one collision this whole arrangement exists to prevent.');
    process.exit(1);
  }
  commit(r, 'doctor --repair');
  console.log('\nDone. ' + did.length + ' thing(s) mended, and each is on the record.');
  console.log('Run `brief --all` — a task whose ownership moved has a brief that no longer matches.');
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
  } else if (sub === 'edit') {
    // An owed item is a claim about the tree made in the past, not a fact, and
    // some of them turn out wrong — the wrong cause named, a count short, six
    // where it was twelve. The only way to correct one used to be to supersede
    // and close it, so one item became a chain of four, and a churned record is
    // one nobody trusts. Amending it is allowed; amending it *silently* is not,
    // which is why the reason is required and the old value is kept. Three
    // corrections then read as one item that was hard to pin down, which is
    // true, rather than four that appeared and vanished, which is not.
    const o = owedList(r).find((x) => x.id === rest[0]); if (!o) die('no owed item ' + rest[0]);
    const F = ['what', 'why', 'window'];
    for (const k of F) if (flags[k] !== undefined && typeof flags[k] !== 'string') die('--' + k + ' needs text');
    if (flags['load-bearing'] && flags['not-load-bearing'])
      die('--load-bearing and --not-load-bearing cannot both be given');
    const wants = F.filter((k) => flags[k] !== undefined);
    const flips = !!flags['load-bearing'] || !!flags['not-load-bearing'];
    if (!wants.length && !flips)
      die('owed edit <id> [--what "..."] [--why "..."] [--window "..."] [--load-bearing|--not-load-bearing] --why-changed "..."');
    if (typeof flags['why-changed'] !== 'string' || !flags['why-changed'].trim())
      die('owed edit needs --why-changed "..." — what you have learned since. An amendment nobody\n' +
          '       can account for is the churn that makes a record untrustworthy.');
    const was = { what: o.what, why: o.why, window: o.window, loadBearing: o.loadBearing };
    for (const k of wants) o[k] = flags[k];
    if (flags['load-bearing']) o.loadBearing = true;
    if (flags['not-load-bearing']) o.loadBearing = false;
    const changed = Object.keys(was).filter((k) => was[k] !== (k === 'loadBearing' ? o.loadBearing : o[k]));
    if (!changed.length) return console.log(o.id + ' already said that — nothing amended.');
    (o.amendments ||= []).push({ at: now(), why: flags['why-changed'], was, fields: changed });
    commit(r);
    console.log(o.id + ' amended: ' + changed.join(', ') + '  (' + o.amendments.length + ' amendment(s) on record)');
    for (const k of changed) console.log('  ' + k + ': ' + JSON.stringify(was[k]) + ' → ' + JSON.stringify(o[k]));
    if (o.status === 'done') console.log('Note: this item is already settled. The amendment is recorded against it as it stands.');
  } else if (sub === 'done') {
    const o = owedList(r).find((x) => x.id === rest[0]); if (!o) die('no owed item ' + rest[0]);
    o.status = 'done'; o.doneAt = now(); commit(r); console.log(o.id + ' settled.');
  } else if (sub === 'list' || sub === undefined) {
    const os = owedList(r);
    if (!os.length) return console.log('nothing is owed.');
    const shut = new Set(allShutWindows(r).map((o) => o.id));
    for (const o of os) {
      const to = o.to ? '→ ' + o.to + (shut.has(o.id) ? ' SHUT' : '') : 'UNASSIGNED';
      const am = (o.amendments || []).length;
      console.log(o.id + '  ' + o.status.padEnd(6) + (o.loadBearing ? 'LOAD-BEARING  ' : '              ') +
        to.padEnd(19) + o.what + (am ? '  (amended ' + am + '\u00d7)' : ''));
      if (o.status === 'open') console.log('      why: ' + o.why + (o.window ? '   window: ' + o.window : ''));
    }
    const sh = allShutWindows(r);
    if (sh.length) {
      console.log('\n' + sh.length + ' item(s) marked SHUT: the task they were assigned to has landed or been');
      console.log('cancelled, so nothing is carrying them any more. ' + sh.filter((o) => o.loadBearing).length +
                  ' of those is load-bearing.');
      console.log('Reassign each to work that is still open, or settle it — leaving it is the loss.');
    }
  } else die('owed add|assign <id> --to <key>|edit <id> --why-changed "..."|done <id>|list');
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
// Can the holder be positively shown to be running? Not the negation of
// staleness: "cannot tell" is false here, so the time limit still reaches a
// claim from another host or one taken by hand, exactly as documented.
function slotAlive(lock) {
  const h = slotHolder(lock);
  if (!h || !h.pid || h.host !== os.hostname()) return false;
  try { process.kill(h.pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
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

// The shell that runs a verify or a slot command. `/bin/bash` was hardcoded,
// which is a real path on Linux and macOS and nowhere on Windows — Node's
// CreateProcess takes it literally rather than resolving it as a shell name,
// so it ENOENTed every single time and a slot run "failed" whatever the
// command actually was. Git for Windows ships a real bash on PATH, so find
// that; the result never changes for the life of the process.
let BASH_PATH;
function bashPath() {
  if (BASH_PATH === undefined) BASH_PATH = findBin('bash');
  return BASH_PATH;
}

// A synchronous, portable sleep. `execSync('sleep ' + n)` shelled out to a
// POSIX `sleep` binary that plain Windows does not have, and — since the
// failure was swallowed as "keep waiting" — turned the wait into a tight
// zero-delay spin instead of the ~10s backoff the jitter comment promises.
// Atomics.wait blocks the calling thread for real, in Node, on every OS,
// without shelling out to anything.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* best effort — never let a sleep failure abort the wait loop */ }
}

// Everything the slot does happens on the filesystem and cleans itself up, so a
// contention incident left no trace anywhere: `events`, `digest` and `verify`
// cannot see it, and the only surviving account of a real ninety-minute stall
// was an agent happening to narrate it in a message. Deliberately NOT an event —
// slot commands never touch the register, which is what keeps waiting on a slot
// from blocking everybody else's bookkeeping. An ordinary append-only line
// beside the locks costs nothing and answers "what happened on this machine".
function slotLogAppend(name, what) {
  try {
    const d = path.join(path.dirname(path.resolve(CWD, REG_PATH)), 'slots');
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, 'slot.log'),
      JSON.stringify({ at: now(), slot: name, what, pid: process.pid }) + '\n');
  } catch { /* a log of the queue must never be able to stop the queue */ }
}

function cmdSlot(sub, rest, flags, raw) {
  const name = rest[0] || 'ci';
  const lock = slotLockPath(name);
  const staleMs = (numFlag(flags, 'stale', { min: 1, what: 'a whole number of minutes' }) ?? 30) * 60000;

  if (sub === 'status') {
    const d = path.dirname(lock);
    const all = fs.readdirSync(d).filter((f) => f.endsWith('.lock'));
    if (!all.length) console.log('no slot is held.');
    for (const f of all) console.log(f.replace(/\.lock$/, '') + ': ' + describeHolder(path.join(d, f)));
    // The queue used to be entirely present-tense: whatever was holding a slot
    // right now, and nothing at all about what had happened. A ninety-minute
    // stall left no trace anywhere once it cleared.
    let log = [];
    try { log = fs.readFileSync(path.join(d, 'slot.log'), 'utf8').split('\n').filter(Boolean); } catch { /* none yet */ }
    if (log.length) {
      const n = numFlag(flags, 'n', { min: 1, what: 'a whole number of lines' }) ?? 10;
      console.log('\nwhat has happened here (' + log.length + ' line(s), last ' + Math.min(n, log.length) + '):');
      for (const l of log.slice(-n)) {
        let e; try { e = JSON.parse(l); } catch { continue; }
        console.log('  ' + String(e.at).slice(0, 19).replace('T', ' ') + '  ' + e.slot + '  ' + e.what);
      }
    }
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
    let told = false, toldLong = false;
    let mine = null;
    for (;;) {
      mine = slotTryTake(name, flags.task);
      if (mine) break;
      const held = slotHolder(lock);
      if (slotIsStale(lock, staleMs)) {
        if (slotSteal(lock, held && held.token)) {
          slotLogAppend(name, 'stole a stale claim from ' + (held && held.task ? held.task : 'an unknown holder'));
          console.error('slot ' + name + ': holder is gone, or unreachable and over the ' +
                        Math.round(staleMs / 60000) + ' min limit — taking over.');
        }
        continue;
      }
      // SKILL.md and the README both promise that a holder whose process is
      // still there is waited on however long it runs — a suite that legitimately
      // outlasts any limit is still running, and starting a second one beside it
      // is the crash this whole mechanism exists to prevent. The waiter applied
      // its timeout regardless, so the guarantee held everywhere except where it
      // mattered. The limit belongs to a holder whose liveness cannot be
      // established, which is the same rule `slotIsStale` already follows.
      if (Date.now() - t0 > timeoutMs && !slotAlive(lock))
        die('slot ' + name + ' still ' + describeHolder(lock) + ' after ' + Math.round(timeoutMs / 60000) +
            ' min.\n       Something is wedged — check `slot status` and talk to the orchestrator. Do NOT run without the slot.');
      if (Date.now() - t0 > timeoutMs && !toldLong) {
        console.error('slot ' + name + ': past the ' + Math.round(timeoutMs / 60000) +
                      ' min mark, but its holder is alive — still waiting, as promised.');
        toldLong = true;
      }
      if (!told) {
        slotLogAppend(name, 'waiting: ' + describeHolder(lock) + (flags.task ? ' (for ' + flags.task + ')' : ''));
        console.error('slot ' + name + ': ' + describeHolder(lock) + ' — waiting, checking every ~10s.'); told = true;
      }
      // ~10s with jitter, so a crowd of waiters does not stampede the same instant
      sleepSync((8 + Math.floor(Math.random() * 5)) * 1000);
    }
    // Free our own claim by its token. If we were evicted while the suite ran, the
    // lock now belongs to whoever replaced us and is not ours to delete.
    const free = () => { try { slotDrop(mine.lock, mine.token); } catch { /* gone */ } };
    if (sub === 'wait') { free(); return console.log(name + ' became free.'); }
    process.on('exit', free);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { free(); process.exit(130); });
    const q = bashCommandLine(raw);
    console.error('slot ' + name + ': taken — running: ' + raw.join(' '));
    slotLogAppend(name, 'took it' + (told ? ' after waiting' : '') + (flags.task ? ' for ' + flags.task : ''));
    const bash = bashPath();
    if (!bash) {
      free();
      slotLogAppend(name, 'freed after ' + Math.round((Date.now() - t0) / 1000) + 's, could not start: no bash on PATH');
      console.error('slot ' + name + ': no bash on PATH to run the command — freed, not run.');
      process.exit(127);
    }
    const res = spawnSync(bash, ['-c', q], { stdio: 'inherit', cwd: process.cwd() });
    free();
    // `status` is null both when the process could never start and when it died
    // to a signal — those used to collapse onto the same bare exit 1, so "the
    // command wasn't found" and "the command ran and failed" looked identical.
    // 127 is what a shell itself reports for "command not found"; use it here
    // for the same failure at one remove up, so a caller can tell the two apart.
    const code = res.error ? 127 : (res.status === null ? 127 : res.status);
    slotLogAppend(name, 'freed after ' + Math.round((Date.now() - t0) / 1000) + 's, exit ' +
      (res.error ? 'could not start (' + res.error.code + ')' : res.status));
    console.error('slot ' + name + ': freed.');
    process.exit(code);
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
  // Only the real ones. `ci import-legacy` mints `l01…` into the same array and
  // numbers itself correctly, but this counted every id whatever its prefix — so
  // importing five rounds of history made the first checkpoint that actually
  // proves something `c06`, which is exactly the "these are separate" the import
  // exists to say.
  const n = checkpoints(r).reduce((m, c) =>
    /^c/.test(String(c.id)) ? Math.max(m, parseInt(String(c.id).slice(1), 10) || 0) : m, 0);
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
    // recorded from c02 on; older checkpoints simply do not carry it
    if (c.newly) console.log('     newly ' + (c.newly.length ? c.newly.join(' ') : '(nothing new)'));
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
  // What the run actually saw, not what the bookkeeping happens to say now.
  // `covers` was every task the round holds that has landed, resolved at the
  // moment the checkpoint is filed — so a task that landed WHILE CI was running
  // was written down as proven by a run that never contained its code. Under
  // ordinary use — land, kick CI, land again, record — that is not a risk, it is
  // what happens. `--sha` names the commit the run tested; a task whose own
  // landing is not an ancestor of it was not in it.
  let covers = st.tasks.filter((t) => t.status === 'landed').map((t) => t.key);
  const outran = [];
  if (flags.sha) {
    const inRun = (t) => {
      if (!t.landedSha) return null;                 // nothing to compare — leave it be
      try { gitZ(['merge-base', '--is-ancestor', t.landedSha, flags.sha], CWD); return true; }
      catch (e) { return e && e.status === 1 ? false : null; }   // 1 = not an ancestor; anything else = cannot tell
    };
    const keep = [];
    for (const t of st.tasks.filter((x) => x.status === 'landed')) {
      if (inRun(t) === false) outran.push(t.key); else keep.push(t.key);
    }
    covers = keep;
  }
  // A task added mid-run with no `needs` joins round 1, so when it lands the
  // round is "all landed" again and a checkpoint is filed over every task that
  // round ever held. Four checkpoints each claimed a whole round when three of
  // them proved one late fix. The run genuinely did re-test all of it, so
  // `covers` is not a lie — it is just uninformative, and repeated it reads as
  // one. `newly` is the part that was not already proven green.
  const proven = new Set(checkpoints(r).filter((c) => c.status === 'green').flatMap((c) => c.covers || []));
  const newly = covers.filter((k) => !proven.has(k));
  const already = covers.filter((k) => proven.has(k));
  const cp = { id: nextCheckpointId(r), status, ref: flags.ref || '', why: flags.why || '',
               covers, newly, mainSha: flags.sha || '', at: now() };
  checkpoints(r).push(cp);
  commit(r);
  console.log(cp.id + ': round ' + (n + 1) + ' ' + status + (flags.ref ? '  ' + flags.ref : ''));
  console.log('  newly proven: ' + (newly.length ? newly.join(' ') : '(nothing — every task here was already green)'));
  console.log('  covers ' + (covers.length ? covers.join(' ') : '(nothing landed)') +
              ' — filed against those, not against a round number that moves.');
  if (already.length)
    console.log('  ' + already.length + ' of those had already been proven by an earlier checkpoint: ' + already.join(' '));
  if (outran.length) {
    console.log('\n⚠ ' + outran.length + ' landed task(s) are NOT covered: they landed after ' + flags.sha +
                ', so this run did not contain them:');
    console.log('    ' + outran.join(' '));
    console.log('  They are still unproven. Run CI again on the main line as it stands now.');
  }
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
  // The record has to be able to say which chip is which — without it there is
  // no way back from a key to the thing actually running the work.
  if (!t.chip && !flags.id)
    die('chip ' + key + ' --id <task_id> — the chip id is how the record points at the running\n' +
        '       agent. Take it from the tool that created the chip. Add --worktree <path> too if\n' +
        '       the copy it works in is not the branch\'s own worktree.');
  // Both gates below used to sit behind `if (!t.chip)`, so re-pointing a chip ran
  // no check at all — and what a task owns can widen after its first chip, by
  // `preflight done` or by a later `task add`. The second call is exactly when
  // the answer may have changed, so it is the last call that may skip it.
  {
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
  // The brief is the whole of what the agent is given, and this is the moment it
  // is handed over — after which the agent is reading and building from it. A
  // brief the record has moved past was reported by `doctor` and by nothing that
  // could stop it being used: `chip` checked status, unmet needs and
  // interference, and then said "can start now" over a brief that no longer
  // matched the task. Refuse, and say the one command that fixes it.
  if (t.briefSha && t.briefSha !== briefSha(t, r)) {
    console.error('✗ ' + key + '\'s brief no longer matches the record — the task changed after it was');
    console.error('  written, so what the agent would read is not what this task now says.');
    console.error('  Run `brief ' + key + '` first. If an agent has already been given the old one,');
    console.error('  tell it to read the file again — the path does not change.');
    process.exit(1);
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

// The brief dictates the exact check-in sentence, so two senders produce the
// same bytes — and on a real run every chip checked in twice, once from the
// builder and once from an observer echoing it verbatim. At the message layer
// they cannot be told apart, and this command believed whichever arrived. The
// discriminator is which session is sitting in the task's worktree, and both
// halves of that lookup were already in this file, never called together:
// worktreeFor() maps a branch to a worktree, cmdWhoami() reads the session
// registry. Recording the wrong address is silent until a release goes nowhere.
function sessionsIn(dir) {
  const reg = path.join(process.env.HOME || '', '.claude', 'sessions');
  if (!dir || !fs.existsSync(reg)) return null;
  try {
    const want = realCase(dir);
    const out = [];
    for (const f of fs.readdirSync(reg)) {
      if (!f.endsWith('.json')) continue;
      let o; try { o = JSON.parse(fs.readFileSync(path.join(reg, f), 'utf8')); } catch { continue; }
      if (!o || !o.cwd || !o.name) continue;
      const c = realCase(o.cwd);
      if (c === want || c.startsWith(want + path.sep)) out.push(o.name);
    }
    return out;
  } catch { return null; }
}

function cmdAgent(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  if (!flags.name) die('need --name <peer name it checked in from>');
  const wt = worktreeFor(t);
  const here = sessionsIn(wt);
  // An unavailable check must not become a blocked run: no git, no session
  // registry, no worktree yet — say so and take the name.
  if (here === null || !wt) {
    console.log('(could not check the address against a worktree' +
      (wt ? ' — no session registry readable' : ' — no worktree recorded for ' + t.branch) + '; taking the name as given)');
  } else if (!here.includes(flags.name) && !flags.force) {
    die(flags.name + ' is not a session in ' + rel(wt) + ', which is where ' + key + ' is being built.\n' +
        '       The brief dictates the check-in sentence word for word, so an observer echoing it\n' +
        '       sends a message identical to the builder\'s. The worktree is what tells them apart.\n' +
        (here.length ? '       Sessions actually in that worktree: ' + here.join(', ') + '\n'
                     : '       No session is in that worktree yet — the chip may not have started.\n') +
        '       Record one of those, or pass --force if you know this lookup is the thing that is wrong.');
  } else if (!here.includes(flags.name)) {
    console.log('⚠ forced: ' + flags.name + ' is not a session in ' + rel(wt) +
      (here.length ? ' (those are: ' + here.join(', ') + ')' : ' (no session is in it)'));
  }
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

// The one spelling of a directory that every OS-level comparison agrees on.
// git prints long-form, forward-slash paths on Windows; Node hands back
// short 8.3 names for the very same directory (`CENTRA~1` for `CentralServer`)
// when it was reached that way — and `fs.realpathSync` (the plain JS one)
// does not undo that, so two callers naming the same worktree compared
// unequal and `rel()` on it produced a path stitched together from unrelated
// segments. `fs.realpathSync.native` asks the OS for the canonical path
// (GetFinalPathNameByHandle on Windows) and does resolve it, so run every
// worktree path through this before it is stored, compared, or displayed.
function realCase(p) {
  try { return (fs.realpathSync.native || fs.realpathSync)(p); } catch { return p; }
}
function worktreeFor(t) {
  if (t.worktree && fs.existsSync(t.worktree)) return realCase(t.worktree);
  try {
    const out = execSync('git worktree list --porcelain', { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) cur = line.slice(9).trim();
      if (line.startsWith('branch ') && line.slice(7).trim() === 'refs/heads/' + t.branch) return realCase(cur);
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
  // A clean guard used to write nothing at all, so afterwards there was no way
  // to ask whether it had ever run — and `landed` could not check. Record what
  // was judged and against what, so the answer survives the scrollback.
  t.guardedAt = now();
  t.guardedBase = base;
  t.guardedFiles = changed.length;
  commit(r);
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
  // A blocking defect is the record saying this work is known to be wrong. It
  // was checked nowhere on the way in, so a task could land over its own open
  // guard failure — and `board`, unlike `digest` and `outstanding`, showed
  // nothing amiss afterwards.
  const blocking = openDefects(r, key).filter((d) => d.blocking !== false);
  if (blocking.length && !flags.force) {
    console.error('✗ ' + key + ' has ' + blocking.length + ' open blocking defect(s) against it:');
    for (const d of blocking) console.error('    ' + d.id + '  ' + d.kind + '  ' + String(d.what).slice(0, 90));
    console.error('  Settle each with `defect fixed <id>`, or land it anyway with --force and say why');
    console.error('  in the record — landing over a known break is a decision, not a formality.');
    process.exit(1);
  }
  // Not a refusal: a guard is run against a worktree, and by the time some work
  // lands the copy may be gone. But nothing recorded it either way, so say so.
  if (!t.guardedAt)
    console.log('⚠ no guard was ever recorded for ' + key + ' — nothing checked that what it changed\n' +
                '  was its to change. Run `guard ' + key + '` before this, while the copy still exists.');
  t.status = 'landed'; t.landedAt = now();
  t.landedSha = flags.sha || '';
  // No checkpoint is destroyed by a landing. The new work is simply not covered
  // by any run yet, which `frontier` and `digest` report as drift.
  const un = unprovenLanded(r).length;   // t is already landed above, so it is counted
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
    // Only work that is still out there can be trespassed on. A landed task has
    // no copy of the repository any more, so `board` telling you to undo your
    // change and "let it do it in its own copy" named something that does not
    // exist — and every ordinary edit to a file after its task landed read as a
    // violation.
    for (const f of dirty) for (const t of tasks(r)) {
      if (DEAD_STATUS.includes(t.status)) continue;
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
  const base = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
  if (!fs.existsSync(base)) return null;
  // Claude Code's own convention: every `/`, `\`, `:` or `_` becomes a `-`,
  // uncollapsed — `C:\Users\x` becomes `C--Users-x`, the doubled dash where the
  // drive colon and the path separator land back to back included. The regex
  // only stripped `/` and `_`, so `\` and `:` sailed through on Windows and the
  // fast path never once matched; readdirSync below still found the real
  // directory by content, so this was silent rather than broken, but it did
  // the readdir-and-grep the fast path exists to skip on every single call.
  const guess = path.join(base, CWD.replace(/[\\/:_]/g, '-'));
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

// The two vocabularies are deliberately different — you are never `blocked`,
// a chip never puts you on `hold` — but `question` was missing from the
// outbound half for no reason anyone stated, so asking a chip something had to
// be logged as a `note` and vanished from every list that tracks a debt. The
// asymmetry that remains is real; the one that bit was an oversight.
const OUT_KINDS = ['release', 'reply', 'sendback', 'note', 'hold', 'announce', 'question'];
const IN_KINDS = ['checkin', 'report', 'question', 'blocked', 'note'];
const kindHelp = (mine, theirs, dir) => 'kind must be one of: ' + mine.join(', ') +
  '\n       (those are the ' + dir + ' kinds; the other direction takes ' + theirs.join(', ') + ')';

function cmdSay(key, flags) {
  const r = readReg(); const t = getTask(r, key);
  const kind = flags.kind || 'note';
  if (!OUT_KINDS.includes(kind)) die(kindHelp(OUT_KINDS, IN_KINDS, 'say/outbound'));
  if (typeof flags.text !== 'string' || !flags.text.trim()) die('need --text "what you actually sent"');
  append({ dir: 'out', key, kind, agent: t.agent || '', text: flags.text });
  console.log('logged: → ' + key + ' [' + kind + ']');
  if (kind === 'question')
    console.log('  It now owes you an answer. `outstanding` says so until anything comes back from it.');
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
  if (!IN_KINDS.includes(kind)) die(kindHelp(IN_KINDS, OUT_KINDS, 'heard/inbound'));
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
// One line about whether the record and the register still agree, cheap enough
// to run wherever the run is being summarised. Returns null when they do.
function driftLines(r) {
  try {
    const { events, problems } = readEvents();
    if (problems.some((x) => x.fatal))
      return '**The record is damaged.** `verify` names the line. Nothing should be built on this until it is settled.';
    if (!events.length) return null;
    const { state } = replay(events);
    const drift = diffOps(state, r);
    if (!drift.length) return null;
    return '**The register and the record disagree in ' + drift.length + ' place(s)** — ' +
      drift.slice(0, 3).map((o) => o.p.join('.')).join(', ') + (drift.length > 3 ? ', …' : '') +
      '. Run `verify`; it names them and says what the two opposite fixes are.';
  } catch { return null; }
}

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
  // SKILL.md says "the digest reports drift too" and it did not: `replay` was
  // reached from exactly one place, inside `rebuild`. That matters more than a
  // wrong sentence, because `hook-install` fires this at every SessionStart —
  // so the one moment the orchestrator has lost its own memory is the moment it
  // was handed a state summary with the integrity check quietly missing.
  const drifted = driftLines(r);
  if (drifted) L.push('\n⚠ ' + drifted);
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

// The reverse debt. `outstanding` answers "who is waiting on me", and a question
// you asked and never got an answer to is the other direction — so it gets its
// own section rather than being filed under a heading that would make it false.
// Anything at all coming back from the chip clears it: if it spoke after you
// asked, you are no longer the one waiting, whatever it chose to say.
function awaitingReply(r, log) {
  const rows = [];
  for (const t of tasks(r)) {
    if (['landed', 'cancelled'].includes(t.status)) continue;
    const mine = log.filter((e) => e.key === t.key);
    const lastAsk = [...mine].reverse().find((e) => e.dir === 'out' && e.kind === 'question');
    if (!lastAsk) continue;
    if (mine.some((e) => e.dir === 'in' && e.at > lastAsk.at)) continue;
    rows.push({ key: t.key, detail: String(lastAsk.text || '').slice(0, 90), since: lastAsk.at });
  }
  return rows;
}

function cmdOutstanding() {
  const r = readReg();
  const log = ledger();
  const rows = waitingOn(r, log);
  const asked = awaitingReply(r, log);
  const showAsked = () => {
    if (!asked.length) return;
    console.log('\nYou asked these and have had nothing back:\n');
    for (const x of asked) {
      console.log('  ' + x.key.padEnd(10) + 'has not answered');
      const d = String(x.detail || '').replace(/\s+/g, ' ').trim();
      if (d) console.log('             \u201c' + d.slice(0, 110) + (d.length > 110 ? '\u2026\u201d' : '\u201d'));
      if (x.since) console.log('             since ' + x.since.slice(0, 19).replace('T', ' '));
    }
    console.log('\n' + asked.length + ' unanswered question(s) you put.');
  };
  if (!rows.length) {
    console.log('Nothing is waiting on you.');
    return showAsked();
  }
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
  showAsked();
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
  console.log('key'.padEnd(14) + 'state'.padEnd(11) + 'waits for'.padEnd(14) + 'address'.padEnd(26) + 'title');
  console.log('-'.repeat(90));
  for (const t of tasks(r)) {
    const held = (t.needs || []).filter((n) => { const d = tasks(r).find((x) => x.key === n); return !d || d.status !== 'landed'; });
    console.log(t.key.padEnd(14) + ((ICON[t.status] || '?') + ' ' + t.status).padEnd(11) +
      (held.length ? held.join(',') : '—').padEnd(14) +
      (t.agent || 'not checked in').slice(0, 24).padEnd(26) + t.title.slice(0, 32));
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
const BOOL_FLAGS = new Set(['stdout', 'all', 'load-bearing', 'not-load-bearing', 'dry-run', 'force',
  'not-blocking', 'reclean', 'check', 'repair', 'write']);
const VALUE_FLAGS = new Set(['base', 'branch', 'evidence', 'from', 'grep', 'id', 'into', 'key',
  'kind', 'n', 'name', 'note', 'out', 'plan', 'ref', 'register', 'scope', 'session',
  'sha', 'since', 'stale', 'status', 'subject', 'task', 'text', 'timeout', 'title',
  'to', 'wave', 'what', 'why', 'why-changed', 'window', 'worktree']);
// The value flags that carry a sentence rather than a token. These are the ones
// a lost quote silently truncates to its first word, and the only ones for which
// a bare word following the value is certainly part of it.
const PROSE_FLAGS = new Set(['evidence', 'note', 'subject', 'text', 'title', 'what', 'why',
  'why-changed', 'window']);
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
    // A value flag takes exactly one word, and the words after it fall through
    // to the positionals, where every command that wants a fixed number of them
    // ignores the rest. So `--what a long sentence` recorded "a", said nothing,
    // and reported success — losing a quote is the commonest way a long value
    // is written wrong, and it was the one mistake this parser did not catch.
    //
    // Only for the flags that carry a sentence. A positional after a flag is
    // perfectly ordinary otherwise — `--register <path> iam <name>` is the
    // documented leading-flag form — so the general rule would refuse the very
    // invocation the docs teach.
    const stray = PROSE_FLAGS.has(k) ? [] : null;
    if (stray) for (let j = i + 1; j < argv.length && argv[j] !== '--' && !argv[j].startsWith('--'); j++) stray.push(argv[j]);
    if (stray && stray.length)
      die('--' + k + ' takes one word, and ' + stray.length + ' more followed it: ' +
          stray.slice(0, 6).map((s) => JSON.stringify(s)).join(' ') + (stray.length > 6 ? ' …' : '') +
          '\n       They would have been dropped and the command would have reported success.' +
          '\n       Quote the whole value: --' + k + ' "' + v + ' ' + stray.join(' ') + '"');
  }
  flags[k] = v;
}
if (flags.register !== undefined) REG_PATH = path.resolve(CWD, flags.register);

const cmd = rest.shift();
// What the record calls this invocation. The commands below that read a second
// word out of `rest` need that word too — `refine done` and `refine brief` are
// different events and must not both show up as `refine`.
const SUB_COMMANDS = new Set(['ci', 'defect', 'log', 'owed', 'plan', 'preflight', 'refine', 'slot', 'task']);
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
  plan mv <old> <new>       repoint the record at a plan the tree moved, carrying its gaps and
                            tasks across. Also: plan rm <path> [--force], plan list.
  owed add|assign|edit|done|list  work only possible in a window between two pieces — record it,
                            assign it, and close no round on top of it silently. edit amends a claim
                            that turned out wrong, keeping the old value and the reason for the change.
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
  case 'brief': if (flags.all) cmdBriefAll(flags); else cmdBrief(rest[0], flags); break;
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
  case 'doctor': cmdDoctor(flags); break;
  case 'archive': cmdArchive(flags); break;
  case 'owed': cmdOwed(rest.shift(), rest, flags); break;
  case 'plan': cmdPlan(rest.shift(), rest, flags); break;
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
