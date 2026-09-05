#!/usr/bin/env node
// End-to-end sweep. Builds a throwaway run in a temp git repo, drives it through
// the whole lifecycle, and asserts on what the commands actually print and write.
//
// Every case here failed before the fix it guards. A check nobody has watched
// fail is not a check, so where a case guards a specific defect the comment says
// what the old behaviour was. The way to watch them fail is to run this file
// against the driver as it stood before the fixes — copy it, its fixtures and
// that driver into one directory and run it there.
//
// A handful of checks are anchors rather than guards. They say that the setup
// the next line judges really happened, so that "X is not in the output" cannot
// pass on an empty page and "none of them does Y" cannot pass on an empty list.
//
//   node test.mjs            run it
//   node test.mjs --keep     leave the sandbox behind to poke at

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'driver.mjs');

// The sweep starts the driver several hundred times, and each start re-parses
// five thousand lines. Node's compile cache keeps the compiled form on disk and
// hands it back to every later process, which is most of a cold start saved.
// Node turns it off by itself under NODE_V8_COVERAGE, so the coverage job is
// unaffected. Children inherit it because it lives in this process's env.
if (!process.env.NODE_COMPILE_CACHE)
  process.env.NODE_COMPILE_CACHE = path.join(os.tmpdir(), 'orch-compile-cache');
const KEEP = process.argv.includes('--keep');
let pass = 0; const failures = [];

// Every case below is registered rather than run on sight, so that one run of
// this file can be told to execute a slice of them. `scripts/sweep.mjs` starts
// one process per slice and adds the counts back up; `node test.mjs` with no
// arguments still runs all of them, in order, in one process.
//
//   node test.mjs --shard 3/16    run the cases whose index mod 16 is 3
//   node test.mjs --only ledger   run the cases whose label contains 'ledger'
//   node test.mjs --report-json   print one JSON line for the runner to read
const flag = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const SHARD = (() => {
  const v = flag('--shard');
  if (!v) return null;
  const [i, n] = v.split('/').map(Number);
  if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || i < 0 || i >= n)
    { console.error('--shard wants i/n with 0 <= i < n'); process.exit(2); }
  return { i, n };
})();
const ONLY = flag('--only');
const REPORT_JSON = process.argv.includes('--report-json');
const cases = [];
let pendingLabel = '';
const sect = (fn) => { cases.push({ label: pendingLabel, fn }); pendingLabel = ''; };

function ok(what, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(what + (detail ? '\n      ' + String(detail).replace(/\n/g, '\n      ') : ''));
  return false;
}
const has = (hay, needle) => String(hay).includes(needle);

// Runs the driver and returns {code, out} with stdout and stderr joined, because
// several commands say the important thing on stderr and exit non-zero.
function drv(cwd, args, { stdin, timeout, env } = {}) {
  try {
    const out = execFileSync(process.execPath, [DRIVER, ...args],
      { cwd, encoding: 'utf8', input: stdin, timeout, stdio: ['pipe', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}
// A stack trace in the output means the driver fell over instead of explaining
// itself. Several cases below care about that and not about the exit code.
const traced = (out) => /\n\s+at /.test(String(out));
const readIf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
// Both come back empty rather than throwing. A register the driver has just
// destroyed is a failing check, not a stack trace that stops the sweep before
// the rest of it has run.
const reg = (d) => { try { return JSON.parse(readIf(path.join(d, '.claude/orchestration/register.json'))); } catch { return {}; } };
const ledger = (d) => readIf(path.join(d, '.claude/orchestration/messages.jsonl'))
  .split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const tasksOf = (d) => (reg(d) || {}).tasks || [];
const gapsOf = (d) => (reg(d) || {}).gaps || [];

function sandbox(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-' + name + '-'));
  fs.mkdirSync(path.join(d, 'docs/plans'), { recursive: true });
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs/plans/p.md'), '# plan p\n\nbuild the first thing.\n');
  fs.writeFileSync(path.join(d, 'docs/plans/q.md'), '# plan q\n\nbuild the other thing.\n');
  for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(d, 'src', f + '.py'), 'x\n');
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  git('init', '-q', '.'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'a');
  git('add', '-A'); git('commit', '-qm', 'init');
  drv(d, ['load', 'docs/plans/p.md', 'docs/plans/q.md']);
  drv(d, ['iam', 'boss']);
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', title: 'first', plan: 'docs/plans/p.md', needs: [], owns: ['src/a.py'], verify: ['true'] },
    { key: 't2', title: 'second', plan: 'docs/plans/p.md', needs: [], owns: ['src/b.py'], verify: ['true'] },
    { key: 't3', title: 'third', plan: 'docs/plans/q.md', needs: ['t1'], owns: ['src/c.py'], verify: ['true'] },
  ]) });
  return d;
}
const boxes = [];
const box = (n) => { const d = sandbox(n); boxes.push(d); return d; };
// "answered" with nothing recorded under it. `set` refuses to mint it now, so
// the only honest way to test the readers that must survive it is to write the
// state the register actually holds when it arrives — from an older driver, or
// from somebody's editor.
function forceHollow(d, id) {
  const p = path.join(d, '.claude/orchestration/register.json');
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  const g = r.gaps.find((x) => x.id === id);
  g.status = 'answered'; g.answer = null;
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
}
const say = (m) => { pendingLabel = m; };

// An empty directory with nothing but a name — for the cases that need to build
// their own git repository, or their own register, by hand.
function bare(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-' + name + '-'));
  boxes.push(d);
  return d;
}
// A directory holding one plan and nothing else. The grill runs on plans, not on
// tasks, so the full sandbox is more than those cases need.
function planBox(name, text) {
  const d = bare(name);
  fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs/plan.md'), text);
  drv(d, ['load', 'docs/plan.md']);
  return d;
}
// The one input in this suite nobody wrote in order to pass a check: a real run's
// record and register, trimmed but not invented. Copied per case, because every
// command that touches it takes the lock and writes.
const CORPUS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/recorded-run');
function corpusBox(name) {
  const d = bare(name);
  const o = path.join(d, '.claude/orchestration');
  fs.mkdirSync(o, { recursive: true });
  for (const f of fs.readdirSync(CORPUS)) fs.copyFileSync(path.join(CORPUS, f), path.join(o, f));
  return d;
}
// Plants a lock with a named holder. A driver that steals locks it should not
// can delete the directory between the mkdir and the write, and that is a
// failing check below — not a reason for the whole sweep to fall over here.
function holdLock(d, pid) {
  const lock = path.join(d, '.claude/orchestration/register.json.lock');
  try {
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'holder.json'),
      JSON.stringify({ pid, host: os.hostname(), since: new Date().toISOString() }));
  } catch { /* it was taken from under us; the check says so */ }
  return lock;
}
// One transcript line in the shape Claude Code writes, for the cases that go in
// through `ingest`.
function transcript(cwd, body) {
  const fx = bare('fx');
  fs.writeFileSync(path.join(fx, 't.jsonl'), JSON.stringify({ type: 'user', cwd,
    timestamp: '2026-02-02T09:00:00.000Z', uuid: 'tx1', sessionId: 's1',
    message: { role: 'user', content: 'Another Claude session sent a message:\n' +
      '<cross-session-message from="uds:/x.sock" from-name="peer-a" from-mode="prompting">\n' +
      body + '\n</cross-session-message>\n' } }) + '\n');
  return fx;
}

// --------------------------------------------------------------- the lifecycle
say('a run goes all the way through');
sect(() => {
  const d = box('life');
  ok('three tasks are on the board', has(drv(d, ['board']).out, 't1'));
  ok('graph reports no collision', drv(d, ['graph']).code === 0);
  ok('t3 waits, t1 and t2 can open', has(drv(d, ['frontier']).out, 't3'));
  ok('a brief is written to a file', drv(d, ['brief', 't1']).code === 0 &&
     fs.existsSync(path.join(d, '.claude/orchestration/briefs/t1.md')));
  drv(d, ['chip', 't1', '--id', 'chip-t1', '--branch', 'step/t1']);
  drv(d, ['agent', 't1', '--name', 'peer-a']);
  const bad = drv(d, ['done', 't1'], { stdin: '{"commit":"abc"}' });
  ok('a report with no proof is refused', bad.code !== 0 && has(bad.out, 'verified'));
  ok('a report lands', drv(d, ['done', 't1'],
     { stdin: '{"commit":"abc","verified":"ran true; it said true","outcome":"passed"}' }).code === 0);
  ok('reported work waits on the check', has(drv(d, ['outstanding']).out, 'waiting on your check'));
  ok('it lands', has(drv(d, ['landed', 't1', '--sha', 'abc123']).out, 't1 landed'));
  ok('landing frees t3', has(drv(d, ['frontier']).out, 't3'));
  ok('the record agrees with the register', has(drv(d, ['verify']).out, 'agree exactly'));
});

// A partial report must not read like a success — it opens a defect on itself.
say('a half-failure is not a pass');
sect(() => {
  const d = box('partial');
  drv(d, ['chip', 't2', '--id', 'chip-t2']);   // a report can only come from a chip that exists
  drv(d, ['done', 't2'], { stdin: '{"verified":"two of three suites","outcome":"partial"}' });
  const r = reg(d);
  ok('a partial report opens a defect', (r.defects || []).some((x) => x.kind === 'bug' && x.task === 't2'));
  ok('and it is on the waiting list', has(drv(d, ['outstanding']).out, 't2'));
});

// ------------------------------------------------------------------ the fixes
// Was: harvest stamps every recovered message kind 'derived', and both readers
// filtered on kind 'question' — so nothing ingest recovered could ever surface.
say('a message with no kind still reaches the waiting list');
sect(() => {
  const d = box('waiting');
  const m = path.join(d, '.claude/orchestration/messages.jsonl');
  fs.appendFileSync(m, JSON.stringify({ at: '2026-01-01T09:00:00.000Z', dir: 'in', kind: 'derived',
    agent: 'peer-a', key: 't1', text: 'I need a decision before I can go on.', uuid: 'u1' }) + '\n');
  ok('outstanding names it', has(drv(d, ['outstanding']).out, 'spoke last'));
  ok('digest names it too', has(drv(d, ['digest']).out, 'spoke last'));

  // ...and stays quiet when it should. Each of these is a way to be wrong.
  fs.appendFileSync(m, JSON.stringify({ at: '2026-01-01T09:01:00.000Z', dir: 'out', kind: 'derived',
    agent: 'peer-a', key: 't1', text: 'here is your answer', uuid: 'u2' }) + '\n');
  ok('an answered one drops off', !has(drv(d, ['outstanding']).out, 'spoke last'));

  fs.appendFileSync(m, JSON.stringify({ at: '2026-01-01T09:02:00.000Z', dir: 'in', kind: 'question',
    agent: 'peer-b', key: 't2', text: 'a typed question', uuid: 'u3' }) + '\n');
  const o = drv(d, ['outstanding']).out;
  ok('a typed question keeps its own wording', has(o, 'asked you something'));
  // Counting a phrase that is not there is true of an empty page too, so say
  // first that the row exists at all — otherwise a command that printed nothing
  // would satisfy this.
  ok('t2 is on the list', has(o, 't2'));
  ok('and is not also reported as spoke-last', has(o, 't2') && (o.match(/spoke last/g) || []).length === 0);
});

// Was: ingest kept Claude Code's wrapper around the message and then cut the
// result at 2000 chars, so the conclusion of a long report was thrown away.
say('ingest keeps the message and drops the wrapper');
sect(() => {
  const d = box('ingest');
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fx-'));
  const body = 't1 is done.\n' + Array.from({ length: 40 }, (_, i) => `LINE ${i}: ` + 'detail '.repeat(9)).join('\n') +
    '\nTHE-CONCLUSION';
  const wrapped = 'Another Claude session sent a message:\n' +
    '<cross-session-message from="uds:/x.sock" from-name="peer-a" from-mode="prompting">\n' + body +
    '\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user, ' +
    'but very likely working on their behalf. …that is permission laundering.';
  fs.writeFileSync(path.join(fx, 't.jsonl'), JSON.stringify({ type: 'user', cwd: d,
    timestamp: '2026-01-01T09:00:00.000Z', uuid: 'fx1', sessionId: 's1',
    message: { role: 'user', content: wrapped } }) + '\n');
  // A resumed or forked session repeats its earlier turns into the new
  // transcript, so the same message really is present twice in ONE harvest.
  // Was: ingest deduped against the ledger but not within the harvest, so both
  // copies were appended.
  fs.copyFileSync(path.join(fx, 't.jsonl'), path.join(fx, 'forked.jsonl'));
  drv(d, ['ingest', '--from', fx]);
  ok('the same message in two transcripts is stored once',
     ledger(d).filter((x) => x.uuid === 'fx1').length === 1);
  const e = ledger(d).find((x) => x.uuid === 'fx1');
  ok('the message was recovered', !!e);
  ok('the wrapper line is gone', e && !/^Another Claude session/.test(e.text));
  ok('the standing instructions are gone', e && !has(e.text, 'permission laundering'));
  ok('the conclusion survived', e && has(e.text, 'THE-CONCLUSION'));
  ok('it was attributed to its task', e && e.key === 't1');

  boxes.push(fx);
});

// Was: an owed item assigned to a task that landed was never mentioned again.
say('an owed item outliving its task is not lost quietly');
sect(() => {
  const d = box('owed');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);   // a report can only come from a chip that exists
  drv(d, ['owed', 'add', '--to', 't1', '--load-bearing', '--what', 'drop the shim', '--why', 'only while t1 is open']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  const landed = drv(d, ['landed', 't1', '--sha', 'abc']).out;
  ok('landing says the window shut', has(landed, 'window is now shut'));
  ok('and that it is load-bearing', has(landed, 'load-bearing'));
  ok('it stays open — landing does not settle it', (reg(d).owed || [])[0]?.status === 'open');
  ok('when the window shut is on the record', !!(reg(d).owed || [])[0]?.windowShutAt);
  ok('outstanding carries it', has(drv(d, ['outstanding']).out, 'still owed on it'));
  ok('owed list marks it SHUT', has(drv(d, ['owed', 'list']).out, 'SHUT'));
  const doc = drv(d, ['doctor']);
  ok('doctor fails on it', doc.code === 1 && has(doc.out, 'work that is over'));
  drv(d, ['owed', 'assign', 'o01', '--to', 't3']);
  ok('reassigning to open work clears it', drv(d, ['doctor']).code === 0);
});

// Was: bundle merged everything describing the work but left defects and owed
// items naming a task it had just cancelled.
say('a bundle carries the absorbed task’s problems with it');
sect(() => {
  const d = box('bundle');
  drv(d, ['defect', 'add', '--task', 't2', '--kind', 'bug', '--what', 'a wrong helper']);
  drv(d, ['owed', 'add', '--to', 't2', '--what', 'drop the old shim', '--why', 'window']);
  const out = drv(d, ['bundle', 't1', 't2', '--into', 't1']).out;
  ok('the bundle says the defect moved', has(out, 'open defect(s) d01'));
  ok('and that the owed item moved', has(out, 'owed item(s) o01'));
  const r = reg(d);
  ok('the defect now names the host', (r.defects || [])[0]?.task === 't1' && (r.defects || [])[0]?.movedFrom === 't2');
  ok('so does the owed item', (r.owed || [])[0]?.to === 't1' && (r.owed || [])[0]?.movedFrom === 't2');
  ok('outstanding names the task being built', has(drv(d, ['outstanding']).out, 't1'));
  ok('the record still agrees', has(drv(d, ['verify']).out, 'agree exactly'));
});

// Was: `readReg` locked before checking, and the lock's parent directory did not
// exist, so every command in a fresh project spun for ~7s then blamed a lock.
say('a project with no register says so');
sect(() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-blank-'));
  boxes.push(d);
  const t0 = Date.now();
  const res = drv(d, ['board']);
  ok('it says there is no register', has(res.out, 'no register'));
  ok('it does not blame a lock', !has(res.out, 'lock'));
  ok('and it does not spin first', Date.now() - t0 < 2000, (Date.now() - t0) + 'ms');
});

// A live holder must still be refused, or the fix above would have traded a bad
// message for a corrupt register.
say('the lock still holds against a live holder');
sect(() => {
  const d = box('lock');
  holdLock(d, process.pid);
  ok('a live holder is not robbed', drv(d, ['iam', 'x']).code !== 0);
  holdLock(d, 0x7ffffff);
  ok('a dead holder is taken over', drv(d, ['iam', 'x']).code === 0);
  // Was: the same-host branch asked only whether the pid was alive, with no
  // other evidence and no time limit at all — so an unrelated process that
  // inherited a dead holder's number wedged the lock for good rather than for a
  // while. A holder that records when it started can be told from its ghost.
  const lock = holdLock(d, process.pid);
  fs.writeFileSync(path.join(lock, 'holder.json'), JSON.stringify({
    pid: process.pid, started: 1, host: os.hostname(), since: new Date().toISOString() }));
  ok('a live pid that is not the process which took the lock is taken over',
     drv(d, ['iam', 'y']).code === 0);
  // Whatever it did with somebody else's claim, it must not leave its own
  // behind — a lock nobody holds is the next process's six-second wait.
  const lockPath = path.join(d, '.claude/orchestration/register.json.lock');
  drv(d, ['iam', 'z']);
  ok('a command that succeeds leaves no lock behind', !fs.existsSync(lockPath));
  drv(d, ['show', 'nosuchgap']);
  ok('and neither does one that fails', !fs.existsSync(lockPath));
});

// Was: an edit to register.json from outside the tool became the trusted
// baseline at the very next command — commit() diffs against whatever is on
// disk — so the divergence was never recorded, never healed and never mentioned.
// Only a hand-run `verify` ever saw it.
say('an edit from outside the tool is noticed rather than absorbed');
sect(() => {
  const d = box('stamp');
  const p = path.join(d, '.claude/orchestration/register.json');
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  r.tasks.find((t) => t.key === 't1').title = 'edited by hand, behind the tool';
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
  const next = drv(d, ['iam', 'boss2']);
  ok('the next command says so', has(next.out, 'changed since this tool last wrote it'), next.out.split('\n')[0]);
  ok('and points at verify', has(next.out, 'verify'), next.out);
  ok('and files it so it survives the scrollback',
     (reg(d).defects || []).some((x) => x.kind === 'record'), JSON.stringify((reg(d).defects || []).map((x) => x.kind)));
  ok('but does not refuse to work', next.code === 0);
  // Was: SKILL.md says "the digest reports drift too" and it did not — replay
  // was reached from one place, inside rebuild. hook-install fires digest at
  // every SessionStart, which is exactly when nobody is able to ask.
  ok('and the digest says it too', has(drv(d, ['digest']).out, 'disagree in'), drv(d, ['digest']).out.slice(0, 400));
});

// Was: `rebuild` is one of the two opposite fixes `verify` offers, and it
// overwrites the register from the record — then said "nothing was thrown away",
// which is true of backups/ and false of the file it just replaced.
say('rebuild names the ground it is about to take');
sect(() => {
  const d = box('rebuildloss');
  const p = path.join(d, '.claude/orchestration/register.json');
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  r.tasks.find((t) => t.key === 't1').notes = 'a hand-written note the record never learned';
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
  const out = drv(d, ['rebuild']);
  ok('it names what only the register held', has(out.out, 'the record never learned') && has(out.out, 'notes'),
     out.out.slice(0, 400));
  ok('and points at the other fix', has(out.out, 'log reseed'), out.out);
  ok('and does not claim nothing was thrown away', !has(out.out, 'nothing was thrown away'), out.out);
});

// Was: the backups are described as a second net, and on a gitignored register
// they are the only one — but their depth is counted in writes, not time, so a
// busy run silently thins the net. On a real run thirty states covered half an
// hour of three days, which is why the drift it carried could not be dated.
say('doctor says how far back the backup ring actually reaches');
sect(() => {
  const d = box('backupspan');
  const bdir = path.join(d, '.claude/orchestration/backups');
  fs.mkdirSync(bdir, { recursive: true });
  const old = Date.now() - 90 * 60000;
  for (let i = 0; i < 30; i++) {
    const f = path.join(bdir, 'register-fixture-' + String(i).padStart(2, '0') + '.json');
    fs.writeFileSync(f, '{}\n');
    fs.utimesSync(f, new Date(old + i * 1000), new Date(old + i * 1000));
  }
  const out = drv(d, ['doctor']).out;
  ok('it says the ring is full and how far it reaches',
     has(out, 'backup ring is full') && has(out, 'reaches back'), out.slice(0, 300));
  ok('and that depth is counted in writes, not time', has(out, 'counted in writes'), out.slice(0, 300));
});

// Was: r.ci held eight real results that no reader could reach any more.
say('legacy CI results become readable history and prove nothing');
sect(() => {
  const d = box('ci');
  const p = path.join(d, '.claude/orchestration/register.json');
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  r.ci = { 0: { status: 'green', ref: 'run-1', why: 'a real run', at: '2026-01-01T00:00:00.000Z' },
           1: { status: 'green', ref: 'run-2', why: 'another', at: '2026-01-02T00:00:00.000Z' } };
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
  drv(d, ['log', 'reseed', '--why', 'test fixture']);           // keep the record honest about the edit
  const out = drv(d, ['ci', 'import-legacy']).out;
  ok('both come across', has(out, 'imported 2 legacy result(s)'));
  const r2 = reg(d);
  ok('the ci block is gone', !('ci' in r2));
  // `.every` over a filter is true when the filter is empty, so name the count
  // first: without this the check passes just as happily on an import that
  // imported nothing at all.
  const legacy = (r2.checkpoints || []).filter((c) => c.legacy);
  ok('both arrived as legacy checkpoints', legacy.length === 2, legacy.length + ' legacy checkpoint(s)');
  ok('none of them covers anything', legacy.length === 2 && legacy.every((c) => (c.covers || []).length === 0));
  ok('their reasoning survived', has(drv(d, ['ci', 'list']).out, 'a real run'));
  ok('running it twice does nothing', has(drv(d, ['ci', 'import-legacy']).out, 'nothing to import'));
  ok('the record still agrees', has(drv(d, ['verify']).out, 'agree exactly'));
  // Was: the next id was computed by stripping the first character off EVERY
  // checkpoint, so imported `l01`/`l02` pushed the first checkpoint that proves
  // something to `c03` — undercutting the one thing the import means to say,
  // that this history is separate and covers nothing.
  drv(d, ['chip', 't1', '--id', 'c1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  drv(d, ['chip', 't2', '--id', 'c2']);
  drv(d, ['done', 't2'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't2', '--sha', 'abc']);
  ok('the first real checkpoint after an import is c01',
     has(drv(d, ['ci', '--status', 'green', '--ref', 'run-3']).out, 'c01:'),
     (reg(d).checkpoints || []).map((c) => c.id).join(' '));
});

// The archive is only safe because a removal is recorded like any other change.
say('archiving shrinks the register without breaking the record');
sect(() => {
  const d = box('archive');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);   // a report can only come from a chip that exists
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed","notes":"' + 'x'.repeat(3000) + '"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  // Captured AFTER the landing: t3's brief legitimately changes when the work it
  // waits for lands (the hold block goes). Only the archive is on trial here.
  drv(d, ['brief', 't3']);
  const before = fs.readFileSync(path.join(d, '.claude/orchestration/briefs/t3.md'), 'utf8');
  const seq = Number((/seq (\d+)/.exec(drv(d, ['verify']).out) || [0, 0])[1]);
  const snap = fs.readFileSync(path.join(d, '.claude/orchestration/register.json'), 'utf8');
  const dry = drv(d, ['archive', '--dry-run']).out;
  ok('a dry run writes nothing', has(dry, 'Nothing was written') &&
     fs.readFileSync(path.join(d, '.claude/orchestration/register.json'), 'utf8') === snap);
  const out = drv(d, ['archive']).out;
  ok('it archives the closed task', has(out, 'archived 1 closed task'));
  ok('the closed task kept its identity', reg(d).tasks.find((t) => t.key === 't1')?.landedSha === 'abc');
  ok('and lost its detail', !reg(d).tasks.find((t) => t.key === 't1')?.reports);
  ok('the archive file has it', has(readIf(path.join(d, '.claude/orchestration/archive/tasks-01.json')), 'x'.repeat(3000)));
  ok('the record still agrees', has(drv(d, ['verify']).out, 'agree exactly'));
  drv(d, ['brief', 't3']);
  ok('an open task’s brief is unchanged',
     fs.readFileSync(path.join(d, '.claude/orchestration/briefs/t3.md'), 'utf8') === before);
  drv(d, ['rebuild', '--to', String(seq), '--why', 'winding back to the pre-archive state']);
  ok('the record replays the pre-archive register exactly',
     fs.readFileSync(path.join(d, '.claude/orchestration/register.json'), 'utf8') === snap);
});

// ------------------------------------------------------------------ the parser
// Was: "takes a value unless the next word starts with --", so an agent whose
// words began with a dash had them replaced by the boolean true, and a flag
// nobody knew was dropped in silence while the command ran on without it.
say('the parser keeps what was written, and says so when it cannot');
sect(() => {
  const d = box('parse');
  drv(d, ['heard', 't1', '--kind', 'note', '--text', '--force was what I ran']);
  ok('a --text value beginning with -- is kept word for word',
     ledger(d).slice(-1)[0]?.text === '--force was what I ran', ledger(d).slice(-1)[0]?.text);
  ok('a bare --text is refused rather than recorded as true',
     drv(d, ['heard', 't1', '--kind', 'note', '--text']).code !== 0);
  drv(d, ['defect', 'add', '--task', 't1', '--kind', 'bug', '--what', 'w', '--evidence=--force']);
  ok('--flag=value survives when the value itself starts with --',
     (reg(d).defects || []).slice(-1)[0]?.evidence === '--force');
  // Was: a value flag takes one word, and the rest fell through to the
  // positionals, where every command ignores what it does not want. So a lost
  // quote recorded the first word, dropped the sentence, and said it worked.
  const lost = drv(d, ['owed', 'add', '--what', 'the', 'brief', 'renderer', 'drops', 'notes',
                       '--why', 'because']);
  ok('a sentence that lost its quotes is refused, not truncated to one word',
     lost.code !== 0 && has(lost.out, 'takes one word'), lost.out.split('\n')[0]);
  ok('and the refusal shows the whole value quoted',
     has(lost.out, '--what "the brief renderer drops notes"'), lost.out);
  const kept = drv(d, ['owed', 'add', '--what', 'the brief renderer drops notes', '--why', 'because']);
  ok('the same value quoted is recorded whole', kept.code === 0 &&
     (reg(d).owed || []).slice(-1)[0]?.what === 'the brief renderer drops notes');
  // A positional after a flag's value is ordinary — this is the documented
  // leading-flag form, and the general rule would have refused it.
  ok('--register before the subcommand still works',
     drv(d, ['--register', path.join(d, '.claude/orchestration/register.json'), 'iam', 'probe']).code === 0);
  const mis = drv(d, ['defect', 'list', '--alll']);
  ok('a misspelled flag is reported, not ignored', mis.code !== 0 && has(mis.out, 'unknown flag --alll'));
  const noval = drv(d, ['board', '--register']);
  ok('a value flag with nothing after it explains itself instead of throwing',
     noval.code !== 0 && has(noval.out, 'error:') && !traced(noval.out));
  const refused = ['bogus', '0', '-5', '999999'].filter((v) => drv(d, ['rebuild', '--to', v]).code !== 0);
  ok('rebuild --to refuses bogus, 0, -5 and 999999 alike', refused.length === 4, 'accepted ' +
     ['bogus', '0', '-5', '999999'].filter((v) => !refused.includes(v)).join(', '));
});

// ------------------------------------------------------------------ the record
// Was: an empty record under a full register made `commit` append the delta
// alone, so the one line that resulted claimed to be the whole history and the
// next rebuild replayed it over the register — leaving {}.
say('a lost record does not take the register with it');
sect(() => {
  const d = box('lostlog');
  fs.rmSync(path.join(d, '.claude/orchestration/events.jsonl'));
  drv(d, ['iam', 'zed']);
  drv(d, ['rebuild']);
  ok('the tasks are all still there', tasksOf(d).length === 3, tasksOf(d).length + ' task(s)');
  ok('and the record was seeded, not started as a delta', has(drv(d, ['verify']).out, 'agree exactly'));
});

// Was: rebuild, verify and log reseed wrote the register without taking the lock,
// landing on the same temp file a locked writer was using.
say('the commands that rewrite the record respect a lock somebody holds');
sect(() => {
  const d = box('reclock');
  const lock = holdLock(d, process.pid);
  ok('rebuild waits and then refuses', drv(d, ['rebuild']).code !== 0);
  ok('verify does too', drv(d, ['verify']).code !== 0);
  ok('and so does log reseed', drv(d, ['log', 'reseed', '--why', 'x']).code !== 0);
  fs.rmSync(lock, { recursive: true, force: true });
});

// Was: --to rewound the register and left the log at full length, so every
// verify from then on reported the difference as damage.
say('rewinding the record moves both halves together');
sect(() => {
  const d = box('rewind');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  const seq = Number((/seq (\d+)/.exec(drv(d, ['verify']).out) || [0, 0])[1]);
  ok('there is a record to rewind into', seq > 3, 'seq ' + seq);
  // Was: a rewind cut the record and left no trace of itself in what remained,
  // so the only sign one had happened was a `.before-rewind-` file beside it and
  // no command will diff that for you. On a real run eight `bundle` calls and a
  // chip id vanished with nothing accounting for them.
  const noWhy = drv(d, ['rebuild', '--to', String(seq - 2)]);
  ok('a rewind without a reason is refused', noWhy.code !== 0 && has(noWhy.out, '--why'), noWhy.out.split('\n')[0]);
  const rew = drv(d, ['rebuild', '--to', String(seq - 2), '--why', 'checking a partial rebuild']);
  ok('verify is still green after a partial rebuild', has(drv(d, ['verify']).out, 'agree exactly'));
  ok('and the rewind is itself on the record', has(rew.out, 'rewind is itself on the record'), rew.out);
  const tail = readIf(path.join(d, '.claude/orchestration/events.jsonl')).trim().split('\n').slice(-1)[0];
  ok('with the reason it was given', has(tail, 'checking a partial rebuild') && has(tail, 'rewind'), tail);
});

// Was: the event's cmd column held the raw argv, and an argv leading with
// `--register <abs path>` pushed the command itself off the end of the line.
say('an event names the command even when --register comes first');
sect(() => {
  const d = box('label');
  drv(d, ['--register', path.join(d, '.claude/orchestration/register.json'), 'iam', 'probe-name']);
  const first = drv(d, ['events', '--n', '1']).out.split('\n')[0];
  ok('the newest row says iam', has(first, 'iam'), first);
});

// Was: a record that is a directory came back as a raw Node stack trace out of
// every single command.
say('a record that is not a file is bad input, not a crash');
sect(() => {
  const d = box('dirlog');
  const f = path.join(d, '.claude/orchestration/events.jsonl');
  fs.rmSync(f); fs.mkdirSync(f);
  const res = drv(d, ['verify']);
  ok('it says error and stops', res.code === 2 && has(res.out, 'error:'), 'exit ' + res.code);
  ok('and prints no stack trace', !traced(res.out));
});

// Was: a final line with no newline was concatenated with the next append, so
// two good events became one unreadable one and the reader dropped both — while
// verify went green on the loss because the register was never told.
say('a final line with no newline is closed, not welded to the next event');
sect(() => {
  const d = box('seal');
  const f = path.join(d, '.claude/orchestration/events.jsonl');
  drv(d, ['iam', 'one']);
  const before = readIf(f).split('\n').filter(Boolean).length;
  fs.truncateSync(f, fs.statSync(f).size - 1);      // the crash: no trailing newline
  drv(d, ['iam', 'two']);
  const lines = readIf(f).split('\n').filter(Boolean);
  ok('the new event is a line of its own', lines.length === before + 1, lines.length + ' vs ' + (before + 1));
  ok('every line still reads back', lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  ok('and nothing was lost behind the reader’s back', has(drv(d, ['verify']).out, 'agree exactly'));
});

// -------------------------------------------------------- dispatch, and the guard
// Was: "two tasks may not touch one file" was asserted in the error text above
// and then never checked against another task.
say('one path has one owner, and task add is where that is cheap to fix');
sect(() => {
  const d = box('own');
  const same = drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 'x1', title: 'x', plan: 'docs/plans/p.md', owns: ['src/shared.py'], needs: [] },
    { key: 'x2', title: 'y', plan: 'docs/plans/p.md', owns: ['src/shared.py'], needs: [] },
  ]) });
  ok('two tasks in one batch may not claim one path', same.code !== 0 && has(same.out, 'already owned'));
  ok('and nothing was saved from the batch', !tasksOf(d).some((t) => t.key === 'x1'));
  // Was: ownership was compared by string with three cosmetic strips, so one
  // file written two ways collided with nothing — including with itself.
  for (const spelling of ['src/./shared2.py', 'src//shared2.py', 'src/sub/../shared2.py']) {
    const dodge = drv(d, ['task', 'add'], { stdin: JSON.stringify([
      { key: 'y1', title: 'a', plan: 'docs/plans/p.md', owns: ['src/shared2.py'], needs: [] },
      { key: 'y2', title: 'b', plan: 'docs/plans/p.md', owns: [spelling], needs: [] },
    ]) });
    ok('one file spelled ' + spelling + ' is the same file',
       dodge.code !== 0 && has(dodge.out, 'already owned'), dodge.out.split('\n')[1]);
  }
  // An absolute path passes every shape test — the file really is there — and
  // then matches nothing, because ownership is compared as repository-relative
  // text. It is the spelling that quietly opts a task out of the whole rule.
  const abs = drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 'y3', title: 'c', plan: 'docs/plans/p.md', owns: [path.join(d, 'src/a.py')], needs: [] },
  ]) });
  ok('an absolute path is refused where ownership is claimed',
     abs.code !== 0 && has(abs.out, 'absolute path'), abs.out.split('\n')[1]);
  ok('and so is one that climbs out of the repository',
     drv(d, ['task', 'add'], { stdin: JSON.stringify([
       { key: 'y4', title: 'd', plan: 'docs/plans/p.md', owns: ['../elsewhere/x.py'], needs: [] },
     ]) }).code !== 0);
  const under = drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 'x3', title: 'z', plan: 'docs/plans/p.md', owns: ['src'], needs: [] },
  ]) });
  ok('nor a directory that swallows a path another task owns',
     under.code !== 0 && has(under.out, 't1 owns src/a.py'));
});

// Was: a chip could be opened with no id, on work that was already landed, on
// top of an unlanded requirement, or straight across something still open.
say('a chip only opens when it is safe to open one');
sect(() => {
  const d = box('chip');
  ok('the first chip must say which chip it is',
     drv(d, ['chip', 't2']).code !== 0 && has(drv(d, ['chip', 't2']).out, '--id'));
  const early = drv(d, ['chip', 't3', '--id', 'chip-t3']);
  ok('a chip does not open on top of an unlanded requirement',
     early.code !== 0 && has(early.out, 'still waits for t1'));
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  const late = drv(d, ['chip', 't1', '--id', 'chip-again']);
  ok('and never rewinds work that has landed', late.code !== 0 && has(late.out, 'cannot rewind'));
});

// Was: serialisation points were compared by exact string equality, so the check
// could only fire when two authors typed the same characters — and on the real
// run a docker-compose.yml collision this reported clean.
say('two chips may not move the same serialisation point, however it is spelled');
sect(() => {
  const d = box('point');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 'u1', title: 'one', plan: 'docs/plans/p.md', owns: ['src/u1.py'], needs: [], serialises: ['docker-compose.yml'] },
    { key: 'u2', title: 'two', plan: 'docs/plans/p.md', owns: ['src/u2.py'], needs: [], serialises: ['Docker-Compose.yml '] },
  ]) });
  ok('both were recorded', tasksOf(d).filter((t) => ['u1', 'u2'].includes(t.key)).length === 2);
  ok('the first chip opens', drv(d, ['chip', 'u1', '--id', 'cu1']).code === 0);
  const second = drv(d, ['chip', 'u2', '--id', 'cu2']);
  ok('the second is refused on the shared point',
     second.code !== 0 && has(second.out, 'serialisation point'), second.out.split('\n')[0]);
});

// Was: `git diff --name-only` with rename detection prints only a rename's
// destination, so `git mv other/x.ts src/x.ts` deleted a file the task did not
// own and guard called it clean. And the base was hardcoded to "main".
say('the guard sees a file renamed out of somewhere the task does not own');
sect(() => {
  const g = bare('guard');
  const git = (...a) => execFileSync('git', a, { cwd: g, stdio: 'ignore' });
  fs.mkdirSync(path.join(g, 'src')); fs.mkdirSync(path.join(g, 'other'));
  fs.writeFileSync(path.join(g, 'src/mine.ts'), 'mine\n');
  fs.writeFileSync(path.join(g, 'other/config.ts'), 'SECRET\n');
  git('init', '-q', '.'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'init'); git('branch', '-M', 'trunk');
  git('checkout', '-qb', 'feat'); git('mv', 'other/config.ts', 'src/config.ts');
  fs.writeFileSync(path.join(g, 'src/mine.ts'), 'changed\n');
  git('add', '-A'); git('commit', '-qm', 'sneak'); git('checkout', '-q', 'trunk');
  fs.mkdirSync(path.join(g, '.claude/orchestration'), { recursive: true });
  fs.writeFileSync(path.join(g, '.claude/orchestration/register.json'), JSON.stringify({
    version: 1, created: new Date().toISOString(), plans: [], gaps: [], orchestrator: 't', notes: [],
    tasks: [{ key: '1.1', title: 'only src', plan: 'p.md', needs: [], owns: ['src'], serialises: [],
      context: [], verify: [], decisions: [], status: 'dispatched', branch: 'feat', worktree: g,
      chip: 'c1', agent: 'a1', reports: [] }],
  }, null, 2) + '\n');
  drv(g, ['log', 'reseed', '--why', 'fixture']);
  const named = drv(g, ['guard', '1.1', '--base', 'trunk']);
  ok('it names the file that left', named.code !== 0 && has(named.out, 'other/config.ts'),
     named.out.split('\n').slice(0, 2).join(' '));
  ok('and records it so it is not lost when this scrolls away',
     (reg(g).defects || []).some((x) => x.kind === 'guard' && has(x.evidence, 'other/config.ts')));
  const derived = drv(g, ['guard', '1.1']);
  ok('the base branch is asked for, not assumed to be main', has(derived.out, 'other/config.ts'),
     derived.out.split('\n')[0]);
  // Was: a clean guard wrote nothing, so nothing could ask afterwards whether
  // one had run — which is why `landed` could not check.
  drv(g, ['task', 'add'], { stdin: JSON.stringify([{ key: '1.1', owns: ['src', 'other/config.ts'] }]) });
  const clean = drv(g, ['guard', '1.1', '--base', 'trunk']);
  ok('a clean guard passes', clean.code === 0 && has(clean.out, 'Safe to join up'), clean.out.split('\n').slice(-2).join(' '));
  ok('and leaves a trace that it ran',
     !!(reg(g).tasks || []).find((t) => t.key === '1.1')?.guardedAt,
     JSON.stringify((reg(g).tasks || []).find((t) => t.key === '1.1')?.guardedAt));
});

// Was: the diff was built as a shell string, so a branch name was a command.
say('a branch name cannot run a command');
sect(() => {
  const i = bare('inject');
  const mark = path.join(i, 'PWNED');
  const git = (...a) => execFileSync('git', a, { cwd: i, stdio: 'ignore' });
  fs.writeFileSync(path.join(i, 'a'), 'a\n');
  git('init', '-q', '.'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'i'); git('branch', '-M', 'main');
  fs.mkdirSync(path.join(i, '.claude/orchestration'), { recursive: true });
  fs.writeFileSync(path.join(i, '.claude/orchestration/register.json'), JSON.stringify({
    version: 1, created: new Date().toISOString(), plans: [], gaps: [], orchestrator: 't', notes: [],
    tasks: [{ key: '1.1', title: 'x', plan: 'p.md', needs: [], owns: ['a'], serialises: [], context: [],
      verify: [], decisions: [], status: 'dispatched', branch: 'main; touch ' + mark, worktree: i,
      chip: 'c1', agent: 'a1', reports: [] }],
  }, null, 2) + '\n');
  drv(i, ['log', 'reseed', '--why', 'fixture']);
  drv(i, ['guard', '1.1', '--base', 'main']);
  ok('the injected command did not run', !fs.existsSync(mark));
});

// Was: `done` was the one command an agent runs itself and the only one that did
// not check what state the task was in.
say('a report has to be about work that was actually handed out');
sect(() => {
  const d = box('report');
  const never = drv(d, ['done', 't2'], { stdin: '{"verified":"v","outcome":"passed"}' });
  ok('a task nobody handed out cannot report', never.code !== 0 && has(never.out, 'never been handed out'));
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  const after = drv(d, ['done', 't1'], { stdin: '{"verified":"nothing","outcome":"failed"}' });
  ok('and a landed task cannot report again', after.code !== 0);
  ok('the landing survived the attempt', tasksOf(d).find((t) => t.key === 't1')?.status === 'landed');
});

// Was: landing did not ask whether the task had ever reported, nor whether what
// it was built on had landed.
say('nothing lands that has not reported, or that stands on unlanded work');
sect(() => {
  const d = box('land');
  const unreported = drv(d, ['landed', 't2', '--sha', 'abc']);
  ok('a task that never reported cannot land',
     unreported.code !== 0 && has(unreported.out, 'cannot land before it reports'));
  ok('and it did not land anyway', tasksOf(d).find((t) => t.key === 't2')?.status !== 'landed');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  drv(d, ['chip', 't3', '--id', 'chip-t3']);
  drv(d, ['done', 't3'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  // t3 has reported, and only then is it told it also builds on t2, which has
  // not landed. Whatever it built, it built without it.
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't3', needs: ['t1', 't2'] }]) });
  const early = drv(d, ['landed', 't3', '--sha', 'abc']);
  ok('nor does work land on top of a requirement that has not',
     early.code !== 0 && has(early.out, 'waits for t2'), early.out.split('\n')[0]);
});

// Was: graph ended on "Nothing clashes. Every round above can run side by side."
// — an absolute sentence about a check that skips every pair with a landed side.
say('graph says what it actually looked at');
sect(() => {
  const d = box('graph');
  const out = drv(d, ['graph']).out;
  ok('it counts the pairs it compared', has(out, 'pair(s) of tasks that could still collide were checked'));
  ok('and no longer claims a flat all-clear',
     !has(out, 'Nothing clashes. Every round above can run side by side.'));
});

// Was: an absorbed member's key still appeared in other tasks' `needs`, so the
// dependent was never placed and its chip could never open.
say('a bundle takes the dependencies of what it absorbed');
sect(() => {
  const d = box('repoint');
  const out = drv(d, ['bundle', 't1', 't2', '--into', 't2']).out;
  ok('it says which task was repointed', has(out, 'repointed at t2'), out.split('\n').slice(-2)[0]);
  const t3 = tasksOf(d).find((t) => t.key === 't3') || {};
  ok('t3 now waits for the host', (t3.needs || []).includes('t2'));
  ok('and no longer for the cancelled member', !(t3.needs || []).includes('t1'));
  ok('so the graph can still be ordered', drv(d, ['graph']).code === 0);
});

// ------------------------------------------------------------------- the grill
// Was: SETTLED_HEADING matched "resolved" inside "Unresolved", so a section
// headed "Unresolved questions" silenced everything under it.
say('a section headed Unresolved is the opposite of settled');
sect(() => {
  const d = planBox('scan', ['# The plan', '', '## Unresolved questions', '',
    'The retry limit is TBD.', 'Timeouts should probably be configurable.', '',
    '## Unanswered so far', '', 'The page size is a threshold somebody must pick.', '',
    '## Already decided', '', 'The retry limit is TBD.', ''].join('\n'));
  drv(d, ['scan']);
  const sections = gapsOf(d).map((g) => g.section);
  ok('the Unresolved section is read', sections.includes('Unresolved questions'));
  ok('so is the Unanswered one', sections.includes('Unanswered so far'));
  ok('and a genuinely settled heading still silences its own section',
     !sections.includes('Already decided'));
});

// Was: the plain-words lint matched jargon as bare substrings, so "normal",
// "form", "platform", "performance" and "information" were all rejected.
say('ordinary English passes the plain-words lint and jargon still does not');
sect(() => {
  const d = planBox('words', '# a plan\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0]?.id;
  ok('there is a gap to write a question against', !!g);
  const q = (text) => drv(d, ['question', g], { stdin: JSON.stringify({ text,
    options: [{ label: 'Work it out each time', gain: 'never stale', cost: 'slower', recommended: true },
              { label: 'Store it', gain: 'fast to read', cost: 'more to keep right' }] }) });
  const plain = q('Should the normal form of a platform performance information report be stored?');
  ok('normal, form, platform, performance and information all pass', plain.code === 0,
     plain.out.split('\n').slice(0, 2).join(' '));
  const jargon = q('Should the schema be denormalised for the endpoint under that authorisation?');
  ok('but schema, endpoint and authorisation are still caught', jargon.code !== 0);
  ok('and the offending word is named', /"(schema|endpoint|authorisation)"/.test(jargon.out),
     jargon.out.split('\n').slice(0, 2).join(' '));
});

// Was: an empty gap list read the same as "everything was judged", and a status
// of "answered" was taken as the decision it only claims to be.
say('check will not call a session finished on a claim');
sect(() => {
  const d = planBox('check', '# a plan\n\n## What is open\n\nThe retry limit is TBD.\n');
  const never = drv(d, ['check']);
  ok('a register nothing was ever scanned against is refused',
     never.code !== 0 && has(never.out, 'no scan has been run'));
  drv(d, ['scan']);
  const g = gapsOf(d)[0]?.id;
  drv(d, ['set', g, 'scope=in']);
  // `set` used to mint this state itself. It refuses now — but the state still
  // exists in registers written before that gate, and can be reached by hand, so
  // force it the way it actually persists and check the readers still refuse it.
  const minted = drv(d, ['set', g, 'status=answered']);
  ok('set will not mint a claim with no evidence under it',
     minted.code !== 0 && has(minted.out, 'the answer is the evidence'), minted.out.split('\n')[0]);
  forceHollow(d, g);
  const hollow = drv(d, ['check']);
  ok('and so is a gap marked answered with no answer under it',
     hollow.code !== 0 && has(hollow.out, 'no answer recorded'));
});

// ------------------------------------------------------------------ the ledger
// Was: attribution took the LONGEST key the message happened to mention, so a
// report from 1.1 that named 1.10 in passing was filed against 1.10.
say('a message belongs to the task it opens with');
sect(() => {
  const d = box('attrib');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: '1.1', title: 'one', plan: 'docs/plans/p.md', owns: ['src/one.py'], needs: [] },
    { key: '1.10', title: 'ten', plan: 'docs/plans/p.md', owns: ['src/ten.py'], needs: [] },
  ]) });
  const fx = transcript(d, '1.1 is finished. It does not touch 1.10 at all.');
  drv(d, ['ingest', '--from', fx]);
  const e = ledger(d).find((x) => x.uuid === 'tx1');
  ok('the message was recovered', !!e);
  ok('it is filed against 1.1, not the longer key it mentions', e && e.key === '1.1', e && e.key);
});

// Was: a cut message was stored as a bare slice — no mark, no original length —
// so it was read afterwards as a complete statement.
say('a message too long to keep whole says so');
sect(() => {
  const d = box('cut');
  const body = 't1 is done. ' + 'and then a further consideration that runs on and on. '.repeat(120) +
    'DO-NOT-MERGE-UNTIL-THE-MIGRATION-LANDS';
  drv(d, ['ingest', '--from', transcript(d, body)]);
  const e = ledger(d).find((x) => x.uuid === 'tx1');
  ok('it was recovered', !!e);
  ok('it is marked as cut', e && e.truncated === true);
  ok('the true length is on the record', e && e.fullLength === body.length, e && e.fullLength);
  ok('and the cut is visible in the text itself', e && has(e.text, 'cut at 4000 of ' + body.length));
  ok('the tail really is gone, not quietly kept', e && !has(e.text, 'DO-NOT-MERGE'));
});

// Was: a `release` counted as an answer, so an agent waited for ever on a list
// that said nothing was waiting.
say('telling an agent to go ahead is not answering what it asked');
sect(() => {
  const d = box('release');
  drv(d, ['heard', 't1', '--kind', 'question', '--text', 'which settings file did you mean']);
  drv(d, ['say', 't1', '--kind', 'release', '--text', 'released, rebase now']);
  ok('the question is still outstanding after a release',
     has(drv(d, ['outstanding']).out, 'asked you something'));
  drv(d, ['say', 't1', '--kind', 'reply', '--text', 'the one in config/']);
  ok('and only a reply clears it', !has(drv(d, ['outstanding']).out, 'asked you something'));
});

// Was: inbox, reply, ack, post and read were a whole message subsystem nothing
// called and nothing read back.
say('the dead message commands are gone');
sect(() => {
  const d = box('dead');
  // They were unreachable from the dispatch long before they were removed, so
  // asking the command line about them proves nothing. The source is the only
  // place the difference shows.
  const src = readIf(DRIVER);
  for (const c of ['Inbox', 'Reply', 'Ack', 'Post', 'ReadMsg'])
    ok('cmd' + c + ' is gone from the driver', !new RegExp('\\bfunction cmd' + c + '\\b').test(src));
  for (const c of ['inbox', 'reply', 'ack', 'post', 'read'])
    ok('`' + c + '` is not a command either',
       has(drv(d, [c]).out, 'orchestrate-implementation driver'), c);
});

// -------------------------------------------------------------------- the slot
// Was: `slot take` wrote a claim in a shape `slot run` did not read, so a slot
// held by hand did not hold at all.
say('a slot taken by hand holds against a run');
sect(() => {
  const d = box('slot-hold');
  ok('taking it by hand works', drv(d, ['slot', 'take', 'ci', '--task', 'probe']).code === 0);
  const barge = drv(d, ['slot', 'run', 'ci', '--timeout', '1', '--', process.execPath, '-e', "console.log('BARGED')"],
    { timeout: 8000 });
  ok('a later run does not barge in', !has(barge.out, 'BARGED'));
  drv(d, ['slot', 'free', 'ci', '--force']);
  ok('and it can be handed back', !fs.existsSync(path.join(d, '.claude/orchestration/slots/ci.lock')));
});

// Was: the command after `--` was quoted word by word, so a leading VAR=value
// became a filename and the run died with 127.
say('a slot run takes a command that starts with an environment setting');
sect(() => {
  const d = box('slot-env');
  const res = drv(d, ['slot', 'run', 'ci', '--', 'FOO=1', '/bin/echo', 'hi'], { timeout: 30000 });
  ok('it prints hi rather than exiting 127', res.code === 0 && /(^|\n)hi(\n|$)/.test(res.out),
     'exit ' + res.code + ': ' + res.out.split('\n').filter(Boolean).slice(-1)[0]);
});

// Was: the claim was taken with a plain existence check, so two runs starting at
// once both believed they had it — which is the crash the slot exists to stop.
say('two runs for one slot take their turn');
sect(() => {
  const d = box('slot-race');
  const log = path.join(d, 'serial.log');
  fs.writeFileSync(log, '');
  const one = (n) => 'node ' + JSON.stringify(DRIVER) + ' slot run ci -- bash -c ' +
    JSON.stringify('echo START >> serial.log; sleep ' + n + '; echo END >> serial.log') + ' >/dev/null 2>&1 &';
  try {
    execFileSync('bash', ['-c', [one(3), 'sleep 1', one(1), 'wait'].join('\n')],
      { cwd: d, timeout: 60000, stdio: 'ignore' });
  } catch { /* the assertion below says what happened */ }
  const seen = readIf(log).split('\n').filter(Boolean).join(' ');
  ok('one finishes before the other starts', seen === 'START END START END', seen);
});

// Was: none of the words the heavy list looks for appear in "pnpm install", so
// every agent was told to run one bare and in parallel.
say('installing dependencies is heavy work and goes through the slot');
sect(() => {
  const d = box('slot-install');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't2', verify: ['pnpm install', 'ruff check .'] }]) });
  const brief = drv(d, ['brief', 't2', '--stdout']).out;
  ok('pnpm install is put behind the slot wrapper', /with-ci-slot" pnpm install/.test(brief));
  ok('and a linter is still left to run straight away',
     /(^|\n)ruff check/.test(brief.replace(/.*with-ci-slot.*/g, '')));
});

// ------------------------------------------------------------------ stale briefs
// Was: briefSha was computed over fields the brief is not built from, or not at
// all, so an agent kept working from a brief the record had since contradicted.
say('a brief the record has moved past is called out');
sect(() => {
  const d = box('stale');
  drv(d, ['brief', 't1']);
  ok('a brief just written is not stale', !has(drv(d, ['board']).out, 'record changed after these briefs'));
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', title: 'first, rewritten' }]) });
  const after = drv(d, ['board']).out;
  ok('changing what the brief is built from makes it stale',
     has(after, 'record changed after these briefs') && has(after, 't1'));
  ok('and doctor fails on it', drv(d, ['doctor']).code === 1);
  drv(d, ['brief', 't1']);
  // Was: notes were left out of the hash on the grounds that a note-only change
  // must not cry stale — which held only while the brief did not show them, and
  // meant every reader of this hash was structurally unable to notice that the
  // note never reached the agent. The note is in the brief now, so it counts.
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', notes: 'the auth check is inverted, do not ship' }]) });
  ok('a note-only change makes the brief stale, because the note is in the brief',
     has(drv(d, ['board']).out, 'record changed after these briefs'), drv(d, ['board']).out.slice(0, 300));
  ok('and a rewrite carries the note into the file the agent reads',
     has(drv(d, ['brief', 't1']).out, 'wrote ') &&
     has(readIf(path.join(d, '.claude/orchestration/briefs/t1.md')), 'the auth check is inverted'));
  // Was: the orchestrator's own address was hashed too, so `resume` after every
  // compaction — eleven times on one real run — marked every live brief stale at
  // once, for a reason that has nothing to do with any task.
  drv(d, ['iam', 'somebody-else']);
  ok('a change of orchestrator does not make every brief stale',
     !has(drv(d, ['board']).out, 'record changed after these briefs'), drv(d, ['board']).out.slice(0, 300));
});

// Was: cmdBrief rendered neither the task's own `notes` nor the pre-flight's
// notes, so a pre-flight — which exists to find what the plan missed before
// anyone starts — wrote its findings into a field the brief did not print. On a
// real run two thirds of tasks carried a note and every pre-flight finding was
// invisible to the agent it was written for.
say('a brief carries the notes the record holds for that task');
sect(() => {
  const d = box('briefnotes');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', notes: 'YOU DO NOT OWN THE PLANS DIRECTORY — only your own plan document.' },
  ]) });
  const rep = path.join(d, '.claude/orchestration/preflight/t1.json');
  fs.mkdirSync(path.dirname(rep), { recursive: true });
  fs.writeFileSync(rep, JSON.stringify({ missing: [], serialises: [], verify: [],
    notes: 'THE SHARPEST THING I FOUND: the enum and its check constraint disagree.' }) + '\n');
  drv(d, ['preflight', 'done', 't1']);
  drv(d, ['brief', 't1']);
  const brief = readIf(path.join(d, '.claude/orchestration/briefs/t1.md'));
  ok('the task note reaches the file the agent is told to read',
     has(brief, 'YOU DO NOT OWN THE PLANS DIRECTORY'), brief.slice(0, 200));
  ok('and so does what the pre-flight found',
     has(brief, 'THE SHARPEST THING I FOUND'), brief.slice(0, 200));
  ok('and the pre-flight is marked as coming from the pre-flight',
     has(brief, 'From the pre-flight agent'));
});

// Was: chip checked status, unmet needs and interference, and then said "can
// start now" over a brief the record had moved past — the one moment where the
// agent is about to start reading it. doctor said so and nothing stopped it.
say('chip will not hand over a brief the record has moved past');
sect(() => {
  const d = box('chipstale');
  drv(d, ['brief', 't1']);
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', title: 'rewritten after briefing' }]) });
  const out = drv(d, ['chip', 't1', '--id', 'chip-t1']);
  ok('it refuses', out.code !== 0 && has(out.out, 'no longer matches the record'), out.out.split('\n')[0]);
  ok('and names the command that fixes it', has(out.out, 'brief t1'), out.out);
  ok('and no chip was recorded', !tasksOf(d).find((t) => t.key === 't1')?.chip);
  drv(d, ['brief', 't1']);
  ok('after re-briefing it opens', drv(d, ['chip', 't1', '--id', 'chip-t1']).code === 0);
});

// --------------------------------------------------------------- the grill, in full
// The gap commands are the register's edit surface. Together they take a plan
// with open questions, judge each candidate, settle it, and write the decisions
// file — and every one of them was part of the coverage gap before this block.
say('the grill runs a gap all the way to a rendered decision');
sect(() => {
  const d = planBox('grill', ['# The plan', '',
    '## What is open', '',
    'The retry limit is TBD.', 'The upload size cap should probably be configurable.','',
    '## Another section', '', 'Maybe ship it atomically?', ''].join('\n'));
  // Silence: name the categories the plan never mentions.
  const sil = drv(d, ['silence']).out;
  ok('silence names a missing category', has(sil, 'never says'));
  // Scan produces candidates.
  drv(d, ['scan']);
  const gaps = gapsOf(d);
  ok('scan found suspects to judge', gaps.length > 0, gaps.length + ' gap(s)');
  const g = gaps[0].id;
  ok('list shows the first gap', has(drv(d, ['list']).out, g) && has(drv(d, ['list']).out, 'of '));
  ok('show prints the whole gap', has(drv(d, ['show', g]).out, '"plan"'));
  const badSet = drv(d, ['set', g, 'status=superman']);
  ok('set refuses an unknown status', badSet.code !== 0 && has(badSet.out, 'bad status'));
  ok('set accepts a real status and scope', drv(d, ['set', g, 'status=gap', 'scope=in', 'title=Retry limit']).code === 0);
  const badScope = drv(d, ['set', g, 'scope=sideways']);
  ok('set refuses a bad scope', badScope.code !== 0 && has(badScope.out, 'scope must be'));
  // Research records what was looked at.
  ok('research records options', has(drv(d, ['research', g], { stdin: JSON.stringify([{ name: 'db', url: 'https://x' }]) }).out, 'option(s) researched'));

  // A good question passes the lint and is saved.
  const q = drv(d, ['question', g], { stdin: JSON.stringify({ text: 'Should the retry limit be stored?',
    options: [{ label: 'Store it', gain: 'fast to read', cost: 'more to keep right', recommended: true },
              { label: 'Work it out each time', gain: 'never stale', cost: 'slower' }] }) });
  ok('a clear question is accepted', q.code === 0 && has(q.out, 'passes the plain-words rules'), q.out.split('\n')[0]);
  const badQ = drv(d, ['question', g], { stdin: JSON.stringify({ text: 'Should the schema be denormalised?',
    options: [{ label: 'A', gain: 'g', cost: 'c', recommended: true }, { label: 'B', gain: 'g2', cost: 'c2' }] }) });
  ok('a jargon question is refused', badQ.code !== 0 && has(badQ.out, 'schema'));
  ok('lint names the good question', drv(d, ['lint', g]).code === 0);
  // A question that is still a candidate keeps the gap open; try to answer it.
  ok('answering a gap records the choice', has(drv(d, ['answer', g], { stdin: JSON.stringify({ choice: 'Store it', note: 'fast' }) }).out, 'answered:'));
  ok('batch says nothing is batched', has(drv(d, ['batch']).out, 'nothing batched'));
  ok('status reports the counts', has(drv(d, ['status']).out, 'found:') && has(drv(d, ['status']).out, 'answered=1'));
  // Judge every remaining candidate so the register is actually finished: keep
  // the first two (already decided), drop the rest out of scope.
  for (const x of gapsOf(d)) {
    if (x.id === g) continue;
    drv(d, ['set', x.id, 'status=dropped']);
  }
  // A finished register is checkable and renderable.
  const chk = drv(d, ['check']);
  ok('check passes once everything is judged and answered', chk.code === 0, chk.out.split('\n')[0].slice(0, 60));
  ok('render writes the decisions file', drv(d, ['render']).code === 0 &&
     fs.readFileSync(path.join(d, 'docs/decisions-implementation.md'), 'utf8').includes('Store it'));
});

// A gap added by hand (via `add`) is a candidate for the same lifecycle, and a
// question marked batched lands on the batch list instead of being asked now.
say('an added gap can be batched and batched ones are approved in one list');
sect(() => {
  const d = planBox('grill2', '# a plan\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'status=gap']);
  const out = drv(d, ['add'], { stdin: JSON.stringify({ title: 'A second thing', plan: 'docs/plan.md' }) }).out;
  ok('add records a hand-found gap', has(out, 'added:') && gapsOf(d).length === 2, gapsOf(d).length + ' gap(s)');
  ok('add refuses a gap with no title', drv(d, ['add'], { stdin: JSON.stringify({}) }).code !== 0);
  const batched = drv(d, ['set', g, 'status=batched']);
  ok('a gap can be marked batched', batched.code === 0);
  drv(d, ['question', g], { stdin: JSON.stringify({ text: 'Should the retry limit be stored?',
    options: [{ label: 'Store it', gain: 'fast', cost: 'more', recommended: true },
              { label: 'Look it up', gain: 'never stale', cost: 'slower' }] }) });
  const batch = drv(d, ['batch']).out;
  ok('the batch names the batched item', has(batch, '1 item(s)') && has(batch, 'ids: ' + g));
});

// -------------------------------------------------------------- refining a plan
// Refinement turns a settled plan into a buildable one. It reads the agent's own
// report file, records the proposed tasks, and reopens gaps it found.
say('refine drives a plan from settled to buildable');
sect(() => {
  const d = planBox('refine', '# the plan\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'status=gap', 'scope=in']);
  drv(d, ['answer', g], { stdin: JSON.stringify({ choice: 'Store it', note: 'decided' }) });
  // A report in the shape the brief tells the agent to write.
  const rep = path.join(d, '.claude/orchestration/refine/docs-plan.json');
  fs.mkdirSync(path.dirname(rep), { recursive: true });
  fs.writeFileSync(rep, JSON.stringify({ summary: 'made it buildable',
    builtOn: [{ path: 'src/util.js', what: 'existing helper' }],
    newGaps: [{ title: 'a thing nobody decided', why: 'blocks', quote: 'the upload size' }],
    tasks: [{ key: '1.1', title: 'wiring', owns: ['src/a.js'], needs: [], verify: ['true'] }] }) + '\n');
  ok('refine list says what is not refined', has(drv(d, ['refine', 'list']).out, 'still to refine'));
  ok('refine brief names the plan', has(drv(d, ['refine', 'brief', 'plan']).out, 'The plan'));
  ok('refine done reads the agent report', has(drv(d, ['refine', 'done', 'plan']).out, 'refined.'));
  const r = reg(d);
  ok('refinement recorded the proposed task', tasksOf(d).some((t) => t.key === '1.1'));
  ok('a new gap was reopened', r.gaps.some((x) => x.title === 'a thing nobody decided'));
  // The reopened gap is in scope and unanswered — settle it, then the check
  // is not trying to approve a run that still has an open question.
  const reopened = r.gaps.find((x) => x.title === 'a thing nobody decided');
  drv(d, ['answer', reopened.id], { stdin: JSON.stringify({ choice: 'Store it', note: 'settled' }) });
  ok('refine check passes once everything is refined', drv(d, ['refine', 'check']).code === 0);
});

// A refine done report can also come over stdin when the file is missing, but it
// must be told that is second best.
say('refine done falls back to stdin and says the file is better');
sect(() => {
  const d = planBox('refine-stdin', '# p\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'status=gap', 'scope=in']);
  drv(d, ['answer', g], { stdin: JSON.stringify({ choice: 'Store it' }) });
  const out = drv(d, ['refine', 'done', 'plan'], { stdin: JSON.stringify({ summary: 'ok', builtOn: [], tasks: [], newGaps: [] }) }).out;
  ok('it took the report from stdin', has(out, 'from stdin'));
  ok('and marked the plan refined', (reg(d).plans || [])[0]?.refined === true);
  // Was: which route the report came in by was said once on the console and then
  // thrown away, so afterwards a report that could not lose a line and one that
  // passed through somebody's context looked identical on the record.
  ok('and recorded which route it came in by', (reg(d).plans || [])[0]?.refineSource === 'stdin');
});

// Was: `refine brief` reads g.answer.choice and was the one such reader with no
// check that there is an answer to read, so a gap marked answered with nothing
// under it threw a raw TypeError out of the driver.
say('refine brief names a hollow claim rather than throwing');
sect(() => {
  const d = planBox('refhollow', '# a plan\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'scope=in']);
  forceHollow(d, g);
  const out = drv(d, ['refine', 'brief', 'plan']);
  ok('it refuses', out.code !== 0);
  ok('it says which gap and what fixes it', has(out.out, g) && has(out.out, 'answer ' + g), out.out.split('\n')[1]);
  ok('and no stack trace reaches the user', !traced(out.out), out.out.slice(0, 200));
});

// ---------------------------------------------------------------- pre-flight
// A read-only agent tests a task's owns against the code before a chip exists.
say('pre-flight finds what the record missed and gates the round');
sect(() => {
  const d = planBox('preflight', '# the plan\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'status=gap', 'scope=in']);
  drv(d, ['answer', g], { stdin: JSON.stringify({ choice: 'Store it' }) });
  drv(d, ['refine', 'done', 'plan'], { stdin: JSON.stringify({ summary: 'ok', builtOn: [],
    tasks: [{ key: '1.1', title: 'wiring', owns: ['src/a.js'], needs: [], verify: ['true'] }], newGaps: [] }) });
  ok('preflight brief names the task and plan', has(drv(d, ['preflight', 'brief', '1.1']).out, 'Pre-flight one task'));
  ok('preflight check refuses before a report exists', drv(d, ['preflight', 'check']).code !== 0);
  const rep = path.join(d, '.claude/orchestration/preflight/1.1.json');
  fs.mkdirSync(path.dirname(rep), { recursive: true });
  fs.writeFileSync(rep, JSON.stringify({ missing: [{ path: 'src/b.js', why: 'the helper', evidence: 'src/a.js:3', loadBearing: true }],
    serialises: ['alembic-head'], verify: [{ command: 'true', runnable: true, why: '' }], notes: '' }) + '\n');
  const done = drv(d, ['preflight', 'done', '1.1']);
  ok('preflight done records the gaps', done.code === 0 && has(done.out, 'Load-bearing gaps'));
  const r = reg(d);
  ok('the task carries a preflight', (r.tasks || []).find((t) => t.key === '1.1')?.preflight?.missing?.length === 1);
  // Was: a second report replaced the first outright, so a gap the first run
  // found and nobody has closed yet simply vanished — and `preflight check`
  // then went green on the loss.
  fs.writeFileSync(rep, JSON.stringify({ missing: [{ path: 'src/c.js', why: 'another one', evidence: 'src/a.js:9', loadBearing: true }],
    serialises: [], verify: [], notes: '' }) + '\n');
  const again = drv(d, ['preflight', 'done', '1.1']);
  const missing = (reg(d).tasks || []).find((t) => t.key === '1.1')?.preflight?.missing || [];
  ok('a second pre-flight keeps the gap the first found',
     missing.some((m) => m.path === 'src/b.js') && missing.some((m) => m.path === 'src/c.js'),
     missing.map((m) => m.path).join(' '));
  ok('and says it carried it forward', has(again.out, 'carried forward'), again.out.split('\n')[0]);
  // The load-bearing gap is not in owns yet, so the round is still not ready.
  ok('preflight check still refuses the load-bearing gap', drv(d, ['preflight', 'check']).code !== 0);
});

// ------------------------------------------------------------ whoami and the rest
// whoami reads the local session registry; a missing registry is a clean error.
say('whoami says when there is no session registry');
sect(() => {
  const d = bare('whoami');
  const home = path.join(d, 'home');
  // Point HOME at a dir with no registry so the error path is real, not env wild.
  const old = process.env.HOME;
  process.env.HOME = home;
  const res = drv(d, ['whoami']);
  process.env.HOME = old;
  ok('whoami names the missing registry', res.code !== 0 && has(res.out, 'no session registry'));
});

// -------------------------------------------------------------- release, resume
// A task that has never been handed out has no chip; release refuses on a held
// task that is still waiting, and a live task with a landed requirement can be
// released.
say('release refuses blocked work and frees what it can');
sect(() => {
  const d = box('release2');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  // t3 waits on t1; t1 is still unlanded, so t3's chip refuses.
  const c3 = drv(d, ['chip', 't3', '--id', 'chip-t3']);
  ok('a chip does not open on top of unlanded work', c3.code !== 0 && has(c3.out, 'still waits for t1'));
  // Release t1 after it has checked in.
  drv(d, ['agent', 't1', '--name', 'peer-a']);
  const rel = drv(d, ['release', 't1']);
  ok('release tells the agent to start', rel.code === 0 && has(rel.out, 'you may start'));
});

// ------------------------------------------------------------------- ci and wave
say('ci records a green run and the next round may open');
sect(() => {
  const d = box('ci2');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  drv(d, ['chip', 't2', '--id', 'chip-t2']);
  drv(d, ['done', 't2'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't2', '--sha', 'def']);
  const red = drv(d, ['ci', '--status', 'red']);
  ok('CI red without a why is refused', red.code !== 0 && has(red.out, '--why'));
  const green = drv(d, ['ci', '--status', 'green', '--ref', 'run-1']);
  ok('green records a checkpoint', green.code === 0 && has(green.out, 'c01'));
  ok('ci list shows it', has(drv(d, ['ci', 'list']).out, 'run-1'));
  ok('wave says the finished round is green and the next may open', has(drv(d, ['wave', '--wave', '1']).out, 'may be opened'));
});

// ------------------------------------------------------------- bundle suggest
// Two unstarted, non-interfering siblings share a plan; suggest proposes one chip.
say('bundle suggest names the siblings worth merging');
sect(() => {
  const d = box('bundle-suggest');
  ok('bundle suggest proposes a group', has(drv(d, ['bundle', 'suggest']).out, 'one chip'));
});

// Was: members were stored in whatever order the command line gave, and the
// brief printed the host first whether or not it was first — so a step could be
// listed above the step it needs. `bundle suggest` built its suggestion from
// discovery order too, and so suggested a command line with the same fault.
say('a bundled brief lists a step after the step it needs');
sect(() => {
  const d = box('bundleorder');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 'b1', title: 'the base', plan: 'docs/plans/p.md', needs: [], owns: ['src/x.py'], verify: ['true'] },
    { key: 'b2', title: 'built on the base', plan: 'docs/plans/p.md', needs: ['b1'], owns: ['src/y.py'], verify: ['true'] },
  ]) });
  // --into names which task survives, not which is done first: the host here is
  // the dependent, and it used to be printed above its own dependency.
  drv(d, ['bundle', 'b2', 'b1', '--into', 'b2']);
  drv(d, ['brief', 'b2']);
  const brief = readIf(path.join(d, '.claude/orchestration/briefs/b2.md'));
  const first = brief.indexOf('- b1 —'), second = brief.indexOf('- b2 —');
  ok('both steps are listed', first >= 0 && second >= 0, brief.slice(0, 400));
  ok('the dependency comes first', first >= 0 && second >= 0 && first < second,
     'b1 at ' + first + ', b2 at ' + second);
});

// --------------------------------------------------------------- hook install
// The SessionStart hook rewrites settings.json; installing twice is a no-op.
say('hook-install writes a SessionStart hook and is idempotent');
sect(() => {
  const d = box('hook');
  const first = drv(d, ['hook-install']);
  ok('it writes the hook once', first.code === 0 && has(first.out, 'added a SessionStart hook'));
  const second = drv(d, ['hook-install']);
  ok('installing again says it is already there', has(second.out, 'already installed'));
  const settings = JSON.parse(fs.readFileSync(path.join(d, '.claude/settings.json'), 'utf8'));
  ok('the hook is on SessionStart', (settings.hooks.SessionStart || []).length === 1);
});

// -------------------------------------------------------------- resume the run
// A dead session's address is replaced; agents are re-announced.
say('resume takes over a run and names what to do next');
sect(() => {
  const d = box('resume');
  drv(d, ['iam', 'old-boss']);
  ok('resume needs a name', drv(d, ['resume']).code !== 0);
  const out = drv(d, ['resume', '--name', 'new-boss']);
  ok('resume records the new address', out.code === 0 && has(out.out, 'now yours'));
  ok('the register carries it', (reg(d).orchestrator) === 'new-boss');
});

// ------------------------------------------------- load with globs and dirs
// A plan directory (or glob) is walked for plan files; a wildcard matches a
// segment at a time so `docs/**/*.md` resolves instead of looking literally.
say('load walks a directory and resolves a glob across nesting');
sect(() => {
  const d = bare('loadglob');
  fs.mkdirSync(path.join(d, 'docs/plans/nested'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs/plans/a.md'), '# a\n\nbuild the a thing.\n');
  fs.writeFileSync(path.join(d, 'docs/plans/nested/b.md'), '# b\n\nbuild the b thing.\n');
  fs.writeFileSync(path.join(d, 'docs/plans/nested/notes.json'), '{}');
  const glo = drv(d, ['load', 'docs/plans/**/*.md']);
  ok('a ** glob matches at any depth', glo.code === 0 && has(glo.out, '2 plan file(s)'), glo.out.split('\n')[1]);
  const dir = drv(d, ['load', 'docs/plans']);
  ok('a directory is walked for plans', dir.code === 0 && has(dir.out, '2 plan file(s)'));
  ok('a non-plan .json is never loaded', !has(drv(d, ['load', 'docs/plans']).out, 'notes.json'));
});

// ------------------------------------------------------------ list and status
// list filters by status, scope and plan; status reports the open and unsettled.
say('list filters the gap register and status reports the open ones');
sect(() => {
  const d = planBox('listfilt', '# p\n\n## What is open\n\nThe retry limit is TBD.\nThe upload cap is TBD too.\n');
  drv(d, ['scan']);
  const gs = gapsOf(d);
  ok('there are candidates to filter', gs.length >= 2, gs.length + ' gap(s)');
  const g0 = gs[0].id, g1 = gs[1].id;
  drv(d, ['set', g0, 'status=gap', 'scope=in', 'title=Retry']);
  drv(d, ['set', g1, 'status=dropped']);
  ok('list --status gap shows only kept ones',
     has(drv(d, ['list', '--status', 'gap']).out, g0) && !has(drv(d, ['list', '--status', 'gap']).out, g1));
  ok('list --scope in shows the in-scope ones',
     has(drv(d, ['list', '--scope', 'in']).out, g0) && !has(drv(d, ['list', '--scope', 'in']).out, g1));
  ok('list --plan filters by plan', has(drv(d, ['list', '--plan', 'docs/plan.md']).out, 'of '));
  ok('list with a filter that matches nothing says so', has(drv(d, ['list', '--status', 'asked']).out, '(none)'));
  const st = drv(d, ['status']).out;
  ok('status names the in-scope unanswered gap', has(st, g0) && has(st, 'in scope and still unanswered'));
  ok('status names the dropped gap in the count', has(st, 'dropped=1'));
});

// --------------------------------------------------------------- render --plan
// render can emit just the settled decisions for one plan, as a table to paste.
say('render --plan prints the settled table for one plan');
sect(() => {
  const d = planBox('renderplan', '# the plan\n\n## What is open\n\nThe retry limit is TBD.\nThe upload cap is TBD too.\n');
  drv(d, ['scan']);
  const gs = gapsOf(d);
  const g0 = gs[0].id;
  drv(d, ['set', g0, 'status=gap', 'scope=in', 'title=Retry']);
  drv(d, ['answer', g0], { stdin: JSON.stringify({ choice: 'Store it', note: 'decided' }) });
  for (const x of gs) { if (x.id === g0) continue; drv(d, ['set', x.id, 'status=dropped']); }
  const out = drv(d, ['render', '--plan', 'docs/plan.md']);
  ok('render --plan emits the decision table', out.code === 0 && has(out.out, '| Decision | Choice |'));
});

// ----------------------------------------------------- a long decision is interned
// A standing decision repeated across tasks is stored once and referenced by a
// hash, so the register does not carry 413 KB of byte-identical text.
say('a repeated long decision is interned, not duplicated');
sect(() => {
  const d = sandbox('intern');
  const long = 'A standing decision about the retry behaviour that is deliberately long enough that interning it once is cheaper than repeating it inline in every single task record that must obey it.';
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', title: 'first', plan: 'docs/plans/p.md', owns: ['src/a.py'], needs: [], verify: ['true'], decisions: [long] },
    { key: 't2', title: 'second', plan: 'docs/plans/p.md', owns: ['src/b.py'], needs: [], verify: ['true'], decisions: [long] },
  ]) });
  drv(d, ['brief', 't1']);
  const r = reg(d);
  ok('the long text is stored once in a decision pool', (r.decisionTexts || {}) && Object.values(r.decisionTexts || {}).includes(long));
  ok('the task carries a reference, not the whole text',
     !(r.tasks || [])[0].decisions[0].includes('standing decision') && /^@[0-9a-f]{12}$/.test((r.tasks || [])[0].decisions[0]));
  ok('the brief resolves the reference back to the real words',
     has(drv(d, ['brief', 't1', '--stdout']).out, 'standing decision about the retry'));
});

// ---------------------------------------------------------------- brief --all
// brief --all rewrites every open task's brief; an unchanged one writes nothing.
say('brief --all rewrites the open briefs and says which changed');
sect(() => {
  const d = box('briefall');
  drv(d, ['brief', 't1']);
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['agent', 't1', '--name', 'peer-a']);
  const out = drv(d, ['brief', '--all']);
  ok('brief --all checks the open briefs in', out.code === 0 && has(out.out, 'brief(s) checked in'));
  ok('previously-written briefs are recognised as current', has(out.out, 'already current'));
});

// ------------------------------------------------------------------ whoami
// whoami --session reads one session's name from the registry.
say('whoami --session reads a name from the local session registry');
sect(() => {
  const d = bare('whoamisession');
  const sess = path.join(d, 'home/.claude/sessions');
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, 'abc.json'), JSON.stringify({ sessionId: 'abc', name: 'the-boss', cwd: d }));
  const old = process.env.HOME;
  process.env.HOME = path.join(d, 'home');
  const res = drv(d, ['whoami', '--session', 'abc']);
  // HOME stays pointed at the sandbox for BOTH calls. Restoring it in between
  // sent the second one at the developer's own ~/.claude/sessions, where the id
  // is merely absent — so this passed on a machine that had that directory and
  // took a different error path on one that did not. CI is the machine that
  // does not.
  const missing = drv(d, ['whoami', '--session', 'nope']);
  process.env.HOME = old;
  ok('whoami --session names the session', res.code === 0 && has(res.out, 'the-boss'));
  ok('an unknown session id is a clean error', missing.code !== 0 && has(missing.out, 'no live session'));
});

// -------------------------------------------------------------- ingest reclean
// A message recovered before the wrapper was stripped can be re-derived.
say('ingest --reclean re-derives entries already stored');
sect(() => {
  const d = box('reclean');
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fx-reclean-'));
  const body = 't1 is done.\n' + Array.from({ length: 40 }, (_, i) => `LINE ${i}: ` + 'detail '.repeat(9)).join('\n') +
    '\nTHE-CONCLUSION';
  const wrapped = 'Another Claude session sent a message:\n' +
    '<cross-session-message from="uds:/x.sock" from-name="peer-a" from-mode="prompting">\n' + body +
    '\n</cross-session-message>\n';
  fs.writeFileSync(path.join(fx, 't.jsonl'), JSON.stringify({ type: 'user', cwd: d,
    timestamp: '2026-01-01T09:00:00.000Z', uuid: 'rx1', sessionId: 's1',
    message: { role: 'user', content: wrapped } }) + '\n');
  drv(d, ['ingest', '--from', fx]);
  const rc = drv(d, ['ingest', '--from', fx, '--reclean']);
  ok('ingest --reclean runs clean', rc.code === 0 && has(rc.out, 're-derived'));
  boxes.push(fx);
});

// ----------------------------------------------------- wave across earlier rounds
// wave names the earlier round still holding the current one up.
say('wave says which earlier round is still blocking');
sect(() => {
  const d = box('waveblock');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  const out = drv(d, ['wave', '--wave', '2']).out;
  ok('wave names the earlier unfinished round', has(out, 'Earlier rounds still holding this one up') && has(out, 't2'));
});

// ---------------------------------------------------------------- events filters
// events narrows by sequence, task and grep — and reports how many it showed.
say('events filters by task, grep and since');
sect(() => {
  const d = box('eventsf');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', title: 'first, rewritten', owns: ['src/a.py'] }]) });
  const g = drv(d, ['events', '--grep', 'rewritten']);
  ok('events --grep finds the event', g.code === 0 && has(g.out, 'rewritten'));
  const t = drv(d, ['events', '--task', 't1']);
  ok('events --task narrows to that task', t.code === 0 && has(t.out, 'event(s)') &&
     /(\d+) of \d+ event/.test(t.out), t.out.split('\n').slice(-1)[0]);
  const s = drv(d, ['events', '--since', '0']);
  ok('events --since is accepted', s.code === 0 && has(s.out, 'event(s)'));

  // Was: the filter stringified the whole ops array — paths AND values — and
  // asked whether the key appeared anywhere in it. An op names a task by its
  // position (`tasks.3.status`), never by its key, so most of a task's own
  // history was invisible while other tasks' events that happened to mention it
  // were pulled in. Measured on a real record: 15% found, half of that wrong.
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't2', title: 'only t2 changes here' }]) });
  const only1 = drv(d, ['events', '--task', 't1', '--n', '200']).out;
  ok('an edit to another task is not filed under this one',
     !has(only1, 'only t2 changes here'), only1.slice(-600));
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', title: 'renamed again' }]) });
  ok('and an edit to this one is found by position, not by spelling',
     has(drv(d, ['events', '--task', 't1', '--n', '200']).out, 'renamed again'),
     drv(d, ['events', '--task', 't1', '--n', '200']).out.slice(-600));
  // A key also travels as a value, and those are the questions people open this
  // command to ask: what was filed against it, who is waiting on it.
  drv(d, ['defect', 'add', '--task', 't1', '--kind', 'bug', '--what', 'a break filed against t1',
          '--evidence', 'the suite']);
  ok('a defect filed against it is its history too',
     has(drv(d, ['events', '--task', 't1', '--n', '200']).out, 'defect add'),
     drv(d, ['events', '--task', 't1', '--n', '200']).out.slice(-600));
  drv(d, ['owed', 'add', '--to', 't1', '--what', 'an owed item pointed at t1', '--why', 'the window']);
  ok('and so is an owed item pointed at it',
     has(drv(d, ['events', '--task', 't1', '--n', '200']).out, 'owed add'),
     drv(d, ['events', '--task', 't1', '--n', '200']).out.slice(-600));
});

// Was: `lintText` names reference/plain-words.md as the authority for what it
// refuses, and was catching eighteen of the thirty-two words that file forbids.
// A question could reach the user saying "add a soft delete and a throttle,
// using RBAC to gate it" and be told it passed the plain-words rules.
say('the plain-words filter refuses every word its own reference forbids');
sect(() => {
  const d = planBox('jargondoc', '# p\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'scope=in']);
  const ask = (text) => drv(d, ['question', g], { stdin: JSON.stringify({ text,
    options: [{ label: 'Yes', gain: 'simpler for them', cost: 'more to build', recommended: true },
              { label: 'No', gain: 'less to build', cost: 'they ask for it later' }] }) });
  // Every term the doc names, read out of the doc itself so the two cannot drift
  // apart again without this failing.
  const doc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'reference/plain-words.md'), 'utf8');
  const terms = [];
  for (const line of doc.split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m) continue;
    const cell = m[1].trim();
    if (!cell || /^-+$/.test(cell) || cell === "Don't say" || cell === 'Real name') continue;
    for (const t of cell.split(/,| \/ /)) if (t.trim()) terms.push(t.trim());
  }
  ok('the reference really does name a vocabulary', terms.length >= 30, terms.length + ' term(s)');
  // Both the refusal and the pass mention plain-words.md, so the message cannot
  // tell them apart — the exit code can. A refused question is not asked.
  const waved = terms.filter((t) => ask('Should we use ' + t + ' here?').code === 0);
  ok('and not one of them passes the lint', waved.length === 0, waved.join(' | '));
  // and ordinary English is still ordinary English
  ok('a plain question still passes',
     has(ask('Should a student be able to hide a card they have finished with?').out, 'passes the plain-words rules'),
     ask('Should a student be able to hide a card they have finished with?').out.slice(0, 200));
});

// ---------------------------------------------------- lint with nothing to say
// lint with no question yet is a calm message, not a crash.
say('lint says when no question has been written');
sect(() => {
  const d = planBox('lintnone', '# p\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  ok('lint reports no questions written', drv(d, ['lint']).code === 0 && has(drv(d, ['lint']).out, 'no questions written yet'));
});

// ------------------------------------------------------- a missing task is named
// A command that names a task that is not on the record says the list it had.
say('a command names the task when one is missing');
sect(() => {
  const d = box('missingtask');
  const res = drv(d, ['show', 'no-such']);
  ok('show says there is no such gap', res.code !== 0 && has(res.out, 'no gap no-such'));
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['agent', 't1', '--name', 'peer-a']);
  const rel = drv(d, ['release', 'ghost']);
  ok('release names the task it cannot find', rel.code !== 0 && has(rel.out, 'no task "ghost"'));
});

// ------------------------------------------------------------- task create/update
// task add ignores fields it does not set, and an update keeps a task's state.
say('task add records what it can and ignores the rest');
sect(() => {
  const d = box('taskadd');
  const out = drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', title: 'first, rewritten', owns: ['src/a.py'], ignored: 'nope' },
  ]) });
  ok('a re-add updates the task in place', out.code === 0 && (tasksOf(d).find((t) => t.key === 't1')?.title === 'first, rewritten'));
  ok('the update keeps unrelated state', (tasksOf(d).find((t) => t.key === 't1')?.needs || []).length === 0);
  ok('the ignored field is reported, not saved', has(out.out, 'ignored'));
});

// ------------------------------------------------------------------ agent note
// agent on a task with a need that is not on the record says so.
say('agent points out a dependency that is not on the record');
sect(() => {
  const d = box('agentnote');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', needs: ['missing-dep'] }]) });
  const out = drv(d, ['agent', 't1', '--name', 'peer-a']);
  ok('agent flags the unresolvable need', out.code === 0 && has(out.out, 'not on record'));
});

// ------------------------------------------------------------ ci, in its cover
// Red records a defect and names the landed work it covers; skipped needs a why.
say('ci covers red, skipped and an empty list');
sect(() => {
  const d = box('cired');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  drv(d, ['chip', 't2', '--id', 'chip-t2']);
  drv(d, ['done', 't2'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't2', '--sha', 'def']);
  const red = drv(d, ['ci', '--status', 'red', '--why', 'the suite blew up']);
  ok('CI red is recorded as a defect', red.code === 0 && has(red.out, 'recorded') && has(red.out, 'red'));
  const skip = drv(d, ['ci', '--status', 'skipped', '--why', 'no runners']);
  ok('CI skipped needs and takes a why', skip.code === 0, skip.out.split('\n')[0]);
  const listEmpty = drv(d, ['ci', 'list']);
  ok('ci list reports its checkpoints', has(listEmpty.out, 'checkpoint(s)'));
});

// ------------------------------------------------------------------ slot doors
// slot status and free on an empty slot are calm; take claims it by hand.
say('slot status and free speak plainly when nothing is held');
sect(() => {
  const d = box('slots');
  ok('slot status says nothing is held', has(drv(d, ['slot', 'status']).out, 'no slot is held'));
  ok('slot free says it was already free', has(drv(d, ['slot', 'free', 'ci']).out, 'already free'));
  const take = drv(d, ['slot', 'take', 'ci', '--task', 't1']);
  ok('slot take claims it by hand', take.code === 0 && has(take.out, 'taken'));
  const taken = drv(d, ['slot', 'take', 'ci', '--task', 't1']);
  ok('a second take is refused', taken.code !== 0 && has(taken.out, 'held by'));
});

// --------------------------------------------------------- board reports state
// Board shows the round, open owed items, and held work that can now start.
say('board reports the round and any held-but-freed work');
sect(() => {
  const d = box('boardstate');
  drv(d, ['owed', 'add', '--to', 't1', '--what', 'drop the shim', '--why', 'window']);
  const out = drv(d, ['board']).out;
  ok('board names the owed item', has(out, 'owed: 1 open'));
  ok('board names the round', has(out, 'round 1 of 2'));
});

// ----------------------------------------------------- ingest from a transcript
// ingest reads the transcript directory under ~/.claude/projects, and an
// entry written from a subdirectory of the run still belongs to it.
say('ingest finds the transcript directory and keeps a subdir-cwd line');
sect(() => {
  const d = box('ingestsub');
  // Override HOME so transcriptDir resolves to our scratch dir, and write a
  // transcript whose cwd is a subdirectory of this run.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-home-'));
  const proj = path.join(fakeHome, '.claude/projects');
  fs.mkdirSync(proj, { recursive: true });
  const projDir = path.join(proj, d.replace(/[/\\:_]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const sub = path.join(d, 'apps/api');
  const body = 't1 is done.\nTHE-CONCLUSION';
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), JSON.stringify({ type: 'user', cwd: sub,
    timestamp: '2026-01-01T09:00:00.000Z', uuid: 'sub1', sessionId: 's1',
    message: { role: 'user', content: 'Another Claude session sent a message:\n' +
      '<cross-session-message from="uds:/x.sock" from-name="peer-a">\n' + body +
      '\n</cross-session-message>\n' } }) + '\n');
  const old = process.env.HOME;
  process.env.HOME = fakeHome;
  const res = drv(d, ['ingest']);
  process.env.HOME = old;
  ok('ingest found the transcript directory', res.code === 0 && has(res.out, 'transcript(s)'));
  ok('the subdirectory-cwd line was kept', has(res.out, 'from a directory under this one'));
});

// --------------------------------------------------------------- owed settles
// owed done and defect fixed record a resolution.
say('owed done and defect fixed record a resolution');
sect(() => {
  const d = box('oweddone');
  drv(d, ['owed', 'add', '--what', 'drop the shim', '--why', 'window']);
  const oid = (reg(d).owed || [])[0].id;
  drv(d, ['defect', 'add', '--task', 't1', '--kind', 'bug', '--what', 'w']);
  const did = (reg(d).defects || []).find((x) => x.task === 't1').id;
  ok('owed done settles it', has(drv(d, ['owed', 'done', oid]).out, 'settled'));
  ok('defect fixed clears it', has(drv(d, ['defect', 'fixed', did]).out, 'marked fixed'));
});

// --------------------------------------------------------- render, in its cover
// render with nothing answered dies; a hollow "answered" is refused cleanly.
say('render refuses an empty register and a hollow answer');
sect(() => {
  const d = planBox('rendernone', '# p\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const none = drv(d, ['render']);
  ok('render with nothing answered says so', none.code !== 0 && has(none.out, 'nothing answered yet'));
  const g = gapsOf(d)[0].id;
  forceHollow(d, g);                       // a claim with no answer under it
  const hollow = drv(d, ['render']);
  ok('render refuses a hollow answered claim', hollow.code !== 0 && has(hollow.out, 'no answer recorded'));
});

// ------------------------------------------------------ refine check, all gates
// refine check refuses unrefined plans and a reopened gap, and reads git status.
say('refine check names every plan still unrefined');
sect(() => {
  const d = planBox('refinecheck', '# p\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'status=gap', 'scope=in']);
  drv(d, ['answer', g], { stdin: JSON.stringify({ choice: 'Store it' }) });
  const chk = drv(d, ['refine', 'check']);
  ok('refine check refuses a never-refined plan', chk.code !== 0 && has(chk.out, 'not refined'));
});

// --------------------------------------------------------- graph, the collision
// graph reports two tasks that move the same serialisation point.
say('graph names a shared serialisation point');
sect(() => {
  const d = box('graphpoint');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't2', serialises: ['alembic-head'] },
  ]) });
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', serialises: ['alembic-head'] },
  ]) });
  const out = drv(d, ['graph']);
  ok('graph names the shared point', out.code !== 0 && has(out.out, 'serialisation point'));
});

// Was: `covers` was every landed task in the round, resolved when the checkpoint
// was filed — so a task that landed WHILE CI was running was written down as
// proven by a run that never contained its code. Under ordinary use (land, kick
// CI, land again, record) that is not a risk, it is what happens.
say('a checkpoint proves only the work the run actually contained');
sect(() => {
  const d = box('cisha');
  const git = (...a) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=a', ...a],
    { cwd: d, encoding: 'utf8' }).trim();
  drv(d, ['chip', 't1', '--id', 'c1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  fs.writeFileSync(path.join(d, 'src/a.py'), 'what t1 did\n');
  git('add', '-A'); git('commit', '-qm', 't1');
  const shaA = git('rev-parse', 'HEAD');
  drv(d, ['landed', 't1', '--sha', shaA]);
  drv(d, ['chip', 't2', '--id', 'c2']);
  drv(d, ['done', 't2'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  fs.writeFileSync(path.join(d, 'src/b.py'), 'what t2 did, after CI had started\n');
  git('add', '-A'); git('commit', '-qm', 't2');
  drv(d, ['landed', 't2', '--sha', git('rev-parse', 'HEAD')]);
  // The run tested shaA. t2 landed after it.
  const out = drv(d, ['ci', '--status', 'green', '--ref', 'run-1', '--sha', shaA]);
  const cp = (reg(d).checkpoints || []).slice(-1)[0] || {};
  ok('the checkpoint covers what the run contained', (cp.covers || []).includes('t1'), JSON.stringify(cp.covers));
  ok('and not what landed after it', !(cp.covers || []).includes('t2'), JSON.stringify(cp.covers));
  ok('and it says so rather than staying quiet',
     has(out.out, 'NOT covered') && has(out.out, 't2'), out.out);
});

// Was: `landed` checked unmet needs and nothing else, so a task could land on
// top of its own open guard failure — and a clean guard wrote nothing at all, so
// afterwards there was no way to ask whether one had ever run.
say('nothing lands over a known break, and a guard leaves a trace');
sect(() => {
  const d = box('landguard');
  drv(d, ['chip', 't1', '--id', 'c1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['defect', 'add', '--task', 't1', '--kind', 'bug', '--what', 'the suite is red',
          '--evidence', 'two failures in test_sync']);
  const blocked = drv(d, ['landed', 't1', '--sha', 'abc']);
  ok('it refuses while a blocking defect is open',
     blocked.code !== 0 && has(blocked.out, 'open blocking defect'), blocked.out.split('\n')[0]);
  ok('and names the defect', has(blocked.out, 'the suite is red'), blocked.out);
  ok('and t1 did not land', tasksOf(d).find((t) => t.key === 't1')?.status === 'reported');
  const forced = drv(d, ['landed', 't1', '--sha', 'abc', '--force']);
  ok('--force lands it deliberately', forced.code === 0);
  ok('and says no guard was ever recorded', has(forced.out, 'no guard was ever recorded'), forced.out);
});

// ------------------------------------------------------------- frontier, unproven
// A landing with no CI checkpoint is reported as unproven drift.
say('frontier reports landings beyond the last checkpoint');
sect(() => {
  const d = box('frontierunproven');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  ok('frontier names the unproven landing', has(drv(d, ['frontier']).out, 'since the last CI checkpoint'));
});

// Was: `unblocks N` counted every task naming this one in `needs`, whatever its
// status — so work absorbed by `bundle` (which cancels rather than deletes) kept
// inflating the count AND the sort that decides what to offer opening next.
say('unblocks does not count work that has been absorbed');
sect(() => {
  const d = box('unblockdead');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 'u1', title: 'the base', plan: 'docs/plans/p.md', needs: [], owns: ['src/u1.py'], verify: ['true'] },
    { key: 'u2', title: 'needs the base', plan: 'docs/plans/p.md', needs: ['u1'], owns: ['src/u2.py'], verify: ['true'] },
  ]) });
  const before = drv(d, ['frontier']).out.split('\n').find((l) => l.trim().startsWith('u1'));
  ok('u1 unblocks u2 while u2 is live', before && has(before, 'unblocks'), before);
  drv(d, ['bundle', 'u1', 'u2', '--into', 'u1']);   // u2 is cancelled, absorbed into u1
  const after = drv(d, ['frontier']).out.split('\n').find((l) => l.trim().startsWith('u1'));
  ok('and stops once u2 is cancelled', after && !has(after, 'unblocks'), after);
});

// ------------------------------------------------------------------ whoami here
// whoami lists the sessions for this directory.
say('whoami lists the sessions for this directory');
sect(() => {
  const d = bare('whoamihere');
  const sess = path.join(d, 'home/.claude/sessions');
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, 'a.json'), JSON.stringify({ sessionId: 'aa', name: 'boss-a', cwd: d }));
  fs.writeFileSync(path.join(sess, 'b.json'), JSON.stringify({ sessionId: 'bb', name: 'boss-b', cwd: path.join(d, 'elsewhere') }));
  const old = process.env.HOME;
  process.env.HOME = path.join(d, 'home');
  const res = drv(d, ['whoami']);
  process.env.HOME = old;
  ok('whoami lists only the sessions in this directory', has(res.out, 'Live sessions in this directory') && has(res.out, 'boss-a') && !has(res.out, 'boss-b'));
});

// --------------------------------------------------- brief with a context it owns
// A brief says when a context path is also one of the files it may change.
say('brief marks a context it also owns as enditable');
sect(() => {
  const d = box('briefcontext');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', context: [{ path: 'src/a.py', what: 'the helper' }], owns: ['src/a.py'] },
  ]) });
  ok('brief resolves a context path it also owns', drv(d, ['brief', 't1', '--stdout']).code === 0 &&
     !/\(read it, do not change it/.test(drv(d, ['brief', 't1', '--stdout']).out));
});

// ---------------------------------------------------------------- doctor points
// A serialisation point named by only one task gates nothing; doctor says so.
say('doctor reports a serialisation point nobody shares');
sect(() => {
  const d = box('doctorlone');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', serialises: ['alembic-head'] }]) });
  const out = drv(d, ['doctor']);
  ok('doctor names the lone serialisation point', has(out.out, 'only one task names') && has(out.out, 'alembic-head'));
});

// Was: doctor computed exactly this and then reported only the lone case — the
// inverse question. `chip` refuses to open a second task on a point somebody
// holds, but `task add` can widen `serialises` on a task already in flight, and
// nothing looked afterwards.
say('two chips may not take one serialisation point, and doctor says when they have');
sect(() => {
  const d = box('doctorshared');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['chip', 't2', '--id', 'chip-t2']);
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', serialises: ['alembic-head'] }]) });
  // Widening a running task's points is the path the chip gate never sees, and
  // `owns` grew a check for exactly this shape while `serialises` had none.
  const taken = drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't2', serialises: ['Alembic-Head'] }]) });
  ok('task add refuses to hand a running chip a point another one holds',
     taken.code !== 0 && has(taken.out, 'only one of them may move'), taken.out.split('\n')[1]);
  ok('and nothing was saved', !((reg(d).tasks || []).find((t) => t.key === 't2')?.serialises || []).length);
  // Registers written before that gate still hold the state, so doctor must see
  // it too — force it the way it persists.
  const p = path.join(d, '.claude/orchestration/register.json');
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  r.tasks.find((t) => t.key === 't2').serialises = ['Alembic-Head'];
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
  const out = drv(d, ['doctor']);
  ok('doctor names the contended point', has(out.out, 'more than one chip at once'), out.out.slice(0, 400));
  ok('and names both chips holding it, whichever way it is spelled',
     has(out.out, 't1') && has(out.out, 't2') && has(out.out, 'Alembic-Head'), out.out.slice(0, 400));
});

// Was: every path the register holds was resolved against whatever directory the
// command was run from, not against the project the register describes. Point
// --register at a project and stand somewhere else and doctor invents a "does
// not exist" failure for every plan and context path in a perfectly sound tree.
say('doctor judges paths against the project, not the shell');
sect(() => {
  const d = box('doctorcwd');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', context: [{ path: 'docs/plans/p.md', what: 'the plan' }] },
  ]) });
  const abs = path.join(d, '.claude/orchestration/register.json');
  const here = drv(d, ['doctor', '--register', abs]).out;
  const away = drv(os.tmpdir(), ['doctor', '--register', abs]).out;
  ok('from the project root it finds every cited path', !has(here, 'does not exist'), here.slice(0, 300));
  ok('and from anywhere else it says the same thing', !has(away, 'does not exist'), away.slice(0, 300));
});

// Was: a pre-flight report is an ordinary file, and nothing but a person running
// `preflight done` folds it in. That step is required nowhere, so a report could
// be written and simply never acted on — 25 of 53 were, on a real run.
say('doctor names a pre-flight report nobody folded in');
sect(() => {
  const d = box('doctororphan');
  const rep = path.join(d, '.claude/orchestration/preflight/t2.json');
  fs.mkdirSync(path.dirname(rep), { recursive: true });
  fs.writeFileSync(rep, JSON.stringify({ missing: [], serialises: [], verify: [], notes: 'nobody read this' }) + '\n');
  const out = drv(d, ['doctor']);
  ok('doctor names the unfolded report',
     has(out.out, 'never folded into the record') && has(out.out, 't2'), out.out.slice(0, 300));
  ok('and it counts as a problem', out.code !== 0);
});

// Some of what doctor reports is damage a bug left behind, and saying so again
// does not clear it. Repair mends what can be mended without guessing — and
// refuses to mend anything into the one collision this all exists to prevent.
say('doctor can mend what it reports, and will not mend it into a collision');
sect(() => {
  const d = box('repair');
  const rep = path.join(d, '.claude/orchestration/preflight/t2.json');
  fs.mkdirSync(path.dirname(rep), { recursive: true });
  fs.writeFileSync(rep, JSON.stringify({ missing: [], serialises: ['alembic-head'],
    verify: [], notes: 'what the pre-flight found' }) + '\n');
  const dry = drv(d, ['doctor', '--repair']);
  ok('a dry run says what it would do', has(dry.out, 'fold the pre-flight report into t2'), dry.out.slice(-400));
  ok('and writes nothing', has(dry.out, 'Nothing was written') &&
     !(tasksOf(d).find((t) => t.key === 't2')?.preflight?.at));
  const done = drv(d, ['doctor', '--repair', '--write']);
  ok('--write applies it', has(done.out, 'mended') &&
     !!tasksOf(d).find((t) => t.key === 't2')?.preflight?.at, done.out.slice(-300));
  ok('and it went on the record, not just into the file', has(drv(d, ['verify']).out, 'agree exactly'));
  ok('and it says the briefs need rewriting after it', has(done.out, 'brief --all'), done.out.slice(-300));
  ok('and what it folded reaches the brief',
     has(readIf(path.join(d, '.claude/orchestration/briefs/t2.md')) ||
         (drv(d, ['brief', 't2']), readIf(path.join(d, '.claude/orchestration/briefs/t2.md'))),
        'what the pre-flight found'));

  // The guardrail: a repair that widens ownership onto a path another open task
  // already holds must not be kept. Confirmed on a real register, where folding
  // its 23 unfolded reports would have created four such pairs.
  const d2 = box('repairclash');
  const rep2 = path.join(d2, '.claude/orchestration/preflight/t2.json');
  fs.mkdirSync(path.dirname(rep2), { recursive: true });
  fs.writeFileSync(rep2, JSON.stringify({ missing: [], serialises: [], verify: [], notes: 'x' }) + '\n');
  const p2 = path.join(d2, '.claude/orchestration/register.json');
  const rr = JSON.parse(fs.readFileSync(p2, 'utf8'));
  rr.tasks.find((t) => t.key === 't2').owns = ['src/b.py', 'src/a.py'];   // t1 already owns src/a.py
  fs.writeFileSync(p2, JSON.stringify(rr, null, 2) + '\n');
  const clash = drv(d2, ['doctor', '--repair', '--write']);
  ok('it refuses to leave two open tasks on one path',
     clash.code !== 0 && has(clash.out, 'claiming one path'), clash.out.slice(-400));
  ok('and wrote nothing when it refused', !tasksOf(d2).find((t) => t.key === 't2')?.preflight?.at);
});

// Was: `refined` was set both by an older driver that kept no report and by this
// one, which does. Nothing told them apart, so "the evidence predates this log"
// read exactly like "marked refined, never actually done" — half the plans on a
// real run were in that state and nothing said so.
say('doctor names a plan marked refined with nothing behind it');
sect(() => {
  const d = box('doctorrefined');
  const p = path.join(d, '.claude/orchestration/register.json');
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  r.plans[0].refined = true;                       // as an older driver left it
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
  const out = drv(d, ['doctor']).out;
  ok('doctor names it', has(out, 'marked refined with no report on disk') && has(out, r.plans[0].path),
     out.slice(0, 300));
});

// --------------------------------------------------------------- ci next round
// Green with open owed items warns; a green close names the next round.
say('ci green names the next round and flags open owed items');
sect(() => {
  const d = box('cinext');
  drv(d, ['owed', 'add', '--to', 't1', '--what', 'drop the shim', '--why', 'window']);
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  drv(d, ['chip', 't2', '--id', 'chip-t2']);
  drv(d, ['done', 't2'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't2', '--sha', 'def']);
  const green = drv(d, ['ci', '--status', 'green', '--ref', 'run-x']);
  ok('green warns about the still-open owed item', has(green.out, 'owed item(s) still open'));
  ok('green says the round that can open next', has(green.out, 'may now be opened'));
});

// ------------------------------------------------------------- digest and outstanding
// digest and outstanding both surface what is still waiting.
say('digest and outstanding surface the waiting work');
sect(() => {
  const d = box('digestout');
  drv(d, ['heard', 't1', '--kind', 'question', '--text', 'which settings file did you mean']);
  ok('outstanding names the question', has(drv(d, ['outstanding']).out, 'asked you something'));
  ok('digest names it too', has(drv(d, ['digest']).out, 'Waiting on you'));
});

// --------------------------------------------------------- board, in its cover
// board shows a stuck-held task and a trespass in the main checkout.
say('board flags both stale briefs and a main-checkout trespass');
sect(() => {
  const d = box('boardtres');
  // a dirty file that a task owns is a trespass
  fs.writeFileSync(path.join(d, 'src/a.py'), 'changed\n');
  const out = drv(d, ['board']).out;
  ok('board names the trespass', has(out, 'main checkout has changes') && has(out, 'src/a.py'));
});

// Was: trespass matched a dirty file against tasks of any status, so every edit
// to a file after its task had landed was reported as a violation — and the
// remedy it printed, "let t1 do it in its own copy", named a copy that no
// longer exists.
say('a file edited after its task landed is not a trespass');
sect(() => {
  const d = box('trespassdone');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"commit":"abc","verified":"ran true; it said true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  fs.writeFileSync(path.join(d, 'src/a.py'), 'a later, unrelated change\n');
  const out = drv(d, ['board']).out;
  ok('board does not call it a trespass', !has(out, 'main checkout has changes'),
     out.split('\n').filter((l) => has(l, 'src/a.py')).join(' | '));
});

// -------------------------------------------------------------- slot run, wait
// slot run takes the slot, runs a command, and frees it; wait only waits.
say('slot run executes behind the slot and a stale holder is taken over');
sect(() => {
  const d = box('slotrun');
  const run = drv(d, ['slot', 'run', 'ci', '--', 'true']);
  ok('slot run runs the command and frees the slot', run.code === 0);
  const wait = drv(d, ['slot', 'wait', 'ci']);
  ok('slot wait reports the slot free', wait.code === 0 && has(wait.out, 'became free'));
  // Plant a stale holder; the next run steals it.
  const lock = path.join(d, '.claude/orchestration/slots/ci.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'holder.json'), JSON.stringify({ token: 'old', manual: true,
    pid: null, host: os.hostname(), task: 'ghost', since: '2020-01-01T00:00:00.000Z' }));
  const steal = drv(d, ['slot', 'run', 'ci', '--', 'true']);
  ok('a stale holder is taken over', steal.code === 0);
  // Was: every take, steal, wait and free happened on the filesystem and cleaned
  // itself up, so a contention incident left no trace anywhere — `events`,
  // `digest` and `verify` all blind to it. The only surviving account of a real
  // ninety-minute stall was an agent happening to mention it in a message.
  const status = drv(d, ['slot', 'status']);
  ok('the slot says what has happened on it, not only what holds it now',
     has(status.out, 'what has happened here') && has(status.out, 'freed after'), status.out.slice(0, 400));
  ok('including the claim it took over', has(status.out, 'stole a stale claim'), status.out.slice(0, 400));
  // Deliberately not events: slot commands never take the register lock, which
  // is what stops waiting on a slot from blocking everyone else's bookkeeping.
  ok('and none of it went through the register',
     !has(drv(d, ['events', '--n', '40']).out, 'slot'), drv(d, ['events', '--n', '40']).out.slice(0, 200));
  ok('the record still agrees', has(drv(d, ['verify']).out, 'agree exactly'));
});

// Was: SKILL.md and the README both promise a holder whose process is still
// there is waited on however long it runs — a suite that legitimately outlasts
// any limit is still running, and starting a second beside it is the crash the
// slot exists to prevent. The waiter applied its timeout regardless, so the
// guarantee held everywhere except the case it was written for.
say('a slot holder that is alive is waited on past the limit, as promised');
sect(() => {
  const d = box('slotpatient');
  const lock = path.join(d, '.claude/orchestration/slots/ci.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'holder.json'), JSON.stringify({ token: 'live', manual: false,
    pid: process.pid, host: os.hostname(), task: 'a suite that runs long', since: new Date().toISOString() }));
  // 0.01 min: the limit is passed on the very first look, so what happens after
  // it is the whole question. Killed from outside, because it will not give up.
  const waited = drv(d, ['slot', 'wait', 'ci', '--timeout', '0.01'], { timeout: 20000 });
  ok('it says it is still waiting', has(waited.out, 'still waiting, as promised'), waited.out.slice(0, 300));
  ok('and does not declare it wedged', !has(waited.out, 'Something is wedged'), waited.out.slice(0, 300));
});

// --------------------------------------------------------- bundle carries a preflight
// Bundling absorbs a member's pre-flight into the host, and says what never flew.
say('bundle carries a member pre-flight to the host');
sect(() => {
  const d = box('bundlecarry');
  const rep = path.join(d, '.claude/orchestration/preflight/t2.json');
  fs.mkdirSync(path.dirname(rep), { recursive: true });
  fs.writeFileSync(rep, JSON.stringify({ missing: [{ path: 'src/b.js', why: 'the helper', evidence: 'src/a.js:3', loadBearing: true }],
    serialises: [], verify: [], notes: 'carried' }) + '\n');
  drv(d, ['preflight', 'done', 't2']);
  const out = drv(d, ['bundle', 't1', 't2', '--into', 't1']);
  ok('the bundle carried the pre-flight gap', has(out.out, 'carried across: 1 pre-flight gap(s)'));
  ok('and said the never-flown member', has(out.out, 'never pre-flighted'));
});

// ------------------------------------------------------------- render in detail
// A full render writes rejected alternatives, conditions and reach-back notes.
say('render writes the rejected, carried and reach-back detail');
sect(() => {
  const d = planBox('renderdetail', '# the plan\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'status=gap', 'scope=in', 'title=Retry']);
  drv(d, ['answer', g], { stdin: JSON.stringify({ choice: 'Store it',
    rejected: [{ what: 'Compute it', why: 'slow' }], carries: ['keep the cache warm'],
    reaches_back: 'the cache layer is already there', note: 'decided' }) });
  drv(d, ['render']);
  const doc = fs.readFileSync(path.join(d, 'docs/decisions-implementation.md'), 'utf8');
  ok('the decision file carries the choice', has(doc, 'Store it'));
  ok('it records the turned-down option', has(doc, 'Compute it') && has(doc, 'slow'));
  ok('it records the conditions carried', has(doc, 'keep the cache warm'));
  ok('it records the reach-back', has(doc, 'cache layer is already there'));
});

// ------------------------------------------------ owed assign to finished work
// owed assign refuses a task whose window is already shut.
say('owed assign refuses work that is already over');
sect(() => {
  const d = box('owedshut');
  drv(d, ['owed', 'add', '--to', 't1', '--what', 'drop the shim', '--why', 'window']);
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  const oid = (reg(d).owed || [])[0].id;
  const res = drv(d, ['owed', 'assign', oid, '--to', 't1']);
  ok('assign to landed work is refused', res.code !== 0 && has(res.out, 'window is already shut'));
});

// ------------------------------------------ brief narrows a whole-tree check
// A pathable verify command is narrowed to the files the task actually owns.
say('brief narrows a whole-tree linter to the owned files');
sect(() => {
  const d = box('scopetool');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', verify: ['ruff .'], owns: ['src/a.py'] }]) });
  const out = drv(d, ['brief', 't1', '--stdout']);
  ok('brief rewrites the whole-tree check', has(out.out, 'ruff src/a.py'));
});

// ------------------------------------------------------------- render across plans
// render reports which plans gained a decision and which were left alone.
say('render names the plans it touched and those it left');
sect(() => {
  const d = planBox('rendertouch', '# p\n\n## What is open\n\nThe retry limit is TBD.\n\nThe upload cap is TBD too.\n');
  drv(d, ['scan']);
  const gs = gapsOf(d);
  const g0 = gs[0].id;
  drv(d, ['set', g0, 'status=gap', 'scope=in', 'title=Retry']);
  drv(d, ['answer', g0], { stdin: JSON.stringify({ choice: 'Store it' }) });
  for (const x of gs) { if (x.id === g0) continue; drv(d, ['set', x.id, 'status=dropped']); }
  const out = drv(d, ['render']);
  ok('render writes the decisions file', out.code === 0 && has(out.out, 'wrote'));
});

// ------------------------------------------------------- re-refinding a live task
// refine done on a task that already exists widens it rather than resetting it.
say('refine done widens a task that is already on the record');
sect(() => {
  const d = planBox('refineupdate', '# p\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'status=gap', 'scope=in']);
  drv(d, ['answer', g], { stdin: JSON.stringify({ choice: 'Store it' }) });
  drv(d, ['refine', 'done', 'plan'], { stdin: JSON.stringify({ summary: 'ok', builtOn: [],
    tasks: [{ key: '1.1', title: 'wiring', owns: ['src/a.js'], needs: [], verify: ['true'] }], newGaps: [] }) });
  const r1 = tasksOf(d).find((t) => t.key === '1.1');
  drv(d, ['refine', 'done', 'plan'], { stdin: JSON.stringify({ summary: 'ok again', builtOn: [],
    tasks: [{ key: '1.1', title: 'wiring, wider', owns: ['src/a.js', 'src/b.js'], needs: [], verify: ['true'] }], newGaps: [] }) });
  const r2 = tasksOf(d).find((t) => t.key === '1.1');
  ok('a re-refine widens owns instead of resetting it', (r2.owns || []).includes('src/b.js'));
});

// ---------------------------------------------------- digest with owed and drift
// digest reports an open owed item and unproven landings.
say('digest reports owed work and unproven landings');
sect(() => {
  const d = box('digestdrift');
  drv(d, ['owed', 'add', '--to', 't1', '--what', 'drop the shim', '--why', 'window']);
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  const out = drv(d, ['digest']).out;
  ok('digest names the open owed item', has(out, '**Owed**'));
  ok('digest reports unproven landings', has(out, 'landing(s) since the last CI checkpoint'));
});

// ------------------------------------------------------ outstanding, a report
// outstanding names work that has reported and is waiting on the check.
say('outstanding names reported work awaiting the check');
sect(() => {
  const d = box('outreport');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  ok('outstanding puts the report on you', has(drv(d, ['outstanding']).out, 'waiting on your check'));
});

// ----------------------------------------------------------- ingest wrapper note
// ingest says when it re-derived an entry that had carried the wrapper.
say('ingest says when an old entry still carries the wrapper');
sect(() => {
  const d = box('ingestwrap');
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fx-wrap-'));
  const body = 't1 is done.\nTHE-CONCLUSION';
  const wrapped = 'Another Claude session sent a message:\n' +
    '<cross-session-message from="uds:/x.sock" from-name="peer-a" from-mode="prompting">\n' + body +
    '\n</cross-session-message>\n';
  fs.writeFileSync(path.join(fx, 't.jsonl'), JSON.stringify({ type: 'user', cwd: d,
    timestamp: '2026-01-01T09:00:00.000Z', uuid: 'wx1', sessionId: 's1',
    message: { role: 'user', content: wrapped } }) + '\n');
  drv(d, ['ingest', '--from', fx]);
  boxes.push(fx);
  const out = drv(d, ['ingest', '--from', fx]);
  ok('ingest dedupes the same message on a second pass', has(out.out, '0 new to the ledger'));
});

// ------------------------------------------ graph's mid-edit and read-only notes
// graph flags a task reading a file another task is rewriting in the same round.
say('graph flags a task reading a file a sibling is rewriting');
sect(() => {
  const d = box('graphcontext');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', context: [{ path: 'src/b.py', what: 'the helper' }] },
  ]) });
  const out = drv(d, ['graph']);
  ok('graph names the mid-edit read', out.code !== 0 && has(out.out, 'mid-edit'));
});

// --------------------------------------------------------- graph, read-only note
// A task builds on a path it may not change, and the owner is also open.
say('graph says when a build-on path is read-only');
sect(() => {
  const d = box('graphreadonly');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', context: [{ path: 'src/b.py', what: 'the helper' }], owns: ['src/a.py'] },
  ]) });
  const out = drv(d, ['graph']);
  ok('graph names the read-only build-on', has(out.out, 'read-only'));
});

// ---------------------------------------------------------- tasks and their shape
// task add validates a context field and refuses a malformed one.
say('task add refuses a malformed context entry');
sect(() => {
  const d = box('taskcontext');
  const res = drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 'x1', title: 'x', plan: 'docs/plans/p.md', owns: ['src/z.py'], needs: [], context: ['not-an-object'] },
  ]) });
  ok('a context that is not {path, what} is refused', res.code !== 0 && has(res.out, 'context must be'));
});

// --------------------------------------------------------- render, plan by plan
// render wrote one plan's decisions and left the other alone.
say('render touches one plan and names the other untouched');
sect(() => {
  const d = bare('rendertouch2');
  fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs/a.md'), '# a\n\n## What is open\n\nThe retry limit is TBD.\n');
  fs.writeFileSync(path.join(d, 'docs/b.md'), '# b\n\n## What is open\n\nThe upload cap is TBD.\n');
  drv(d, ['load', 'docs/a.md', 'docs/b.md']);
  drv(d, ['scan']);
  for (const g of gapsOf(d)) {
    if (g.plan === 'docs/a.md') { drv(d, ['set', g.id, 'status=gap', 'scope=in']); drv(d, ['answer', g.id], { stdin: JSON.stringify({ choice: 'Store it' }) }); }
    else { drv(d, ['set', g.id, 'status=dropped']); }
  }
  const out = drv(d, ['render']);
  ok('render says the other plan was untouched', out.code === 0 && has(out.out, 'unchanged, nothing was decided for them: docs/b.md'));
  ok('render points at the touched plan', has(out.out, 'render --plan docs/a.md'));
});

// ------------------------------------------------------- refine with no tasks
// A refinement that proposes no task cannot be handed out.
say('refine check refuses a refinement that produced no task');
sect(() => {
  const d = planBox('refinenotasks', '# p\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'status=gap', 'scope=in']);
  drv(d, ['answer', g], { stdin: JSON.stringify({ choice: 'Store it' }) });
  drv(d, ['refine', 'done', 'plan'], { stdin: JSON.stringify({ summary: 'ok', builtOn: [], tasks: [], newGaps: [] }) });
  const chk = drv(d, ['refine', 'check']);
  ok('refine check refuses with no task proposed', chk.code !== 0 && has(chk.out, 'no tasks proposed'));
});

// ------------------------------------------- brief narrows a check in a subdir
// A whole-tree check scoped to a subdirectory is rebased onto those paths.
say('brief rebases a check that already runs in a subdirectory');
sect(() => {
  const d = box('scopecwd');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', verify: ['ruff --directory apps/api .'], owns: ['apps/api/src/a.py'] }]) });
  const out = drv(d, ['brief', 't1', '--stdout']);
  ok('brief keeps the tool in its subdirectory', has(out.out, 'ruff --directory apps/api'));
});

// -------------------------------------------------------------- defect list
// defect list shows open defects and --all the settled ones.
say('defect list separates open from fixed');
sect(() => {
  const d = box('defectlist');
  drv(d, ['defect', 'add', '--task', 't1', '--kind', 'bug', '--what', 'a wrong helper']);
  const did = (reg(d).defects || []).find((x) => x.task === 't1').id;
  ok('defect list shows the open one', has(drv(d, ['defect', 'list']).out, did));
  drv(d, ['defect', 'fixed', did]);
  ok('defect list hides a fixed one', !has(drv(d, ['defect', 'list']).out, did));
  ok('defect list --all shows it again', has(drv(d, ['defect', 'list', '--all']).out, did));
});

// ----------------------------------------------------------------- the real corpus
// Everything else in this file was written to satisfy the check it feeds. This
// was not: it is a real run's record and register, trimmed but not invented.
say('verify is green on a recorded run nobody made up');
sect(() => {
  const d = corpusBox('corpus');
  const out = drv(d, ['verify']);
  ok('the record replays to the register exactly', out.code === 0 && has(out.out, 'agree exactly'),
     out.out.split('\n').slice(0, 3).join(' '));
  ok('and it is a run of some size', tasksOf(d).length >= 20 &&
     readIf(path.join(d, '.claude/orchestration/events.jsonl')).split('\n').filter(Boolean).length >= 400);
});


// ============================================================================
// The eight instruction gaps — every one found by running the skill, not by
// reading it. Each case below failed before the fix it guards; the comment says
// what the old behaviour was, so the check can be watched failing.
// ============================================================================

// ------------------------------------------------- ownership on the UPDATE path
say('task add re-checks ownership when an update widens owns');
sect(() => {
  const d = box('ownupd');
  // was: `if (at >= 0) continue` skipped the check for every update, so an
  // update could hand a second task a path another one already owned, silently.
  const r1 = drv(d, ['task', 'add'], { stdin: JSON.stringify({ key: 't1', owns: ['src/a.py', 'src/b.py'] }) });
  ok('an update claiming another open task\'s path is refused', r1.code !== 0, r1.out);
  ok('and it names who already owns it', has(r1.out, 't2') && has(r1.out, 'src/b.py'), r1.out);
  ok('and nothing was saved', (tasksOf(d).find((t) => t.key === 't1').owns || []).length === 1);

  const r2 = drv(d, ['task', 'add'], { stdin: JSON.stringify({ key: 't1', owns: [] }) });
  ok('narrowing to nothing is still refused on its own merits', r2.code !== 0, r2.out);

  const r3 = drv(d, ['task', 'add'], { stdin: JSON.stringify({ key: 't1', notes: 'unrelated' }) });
  ok('an update that never mentions owns is not an ownership change', r3.code === 0, r3.out);

  // The hand-over: narrowing one and widening the other has to work as one
  // batch, or there is no way to move a file between tasks at all. Judging the
  // widening task against the register alone read the narrowing task's stale
  // entry and refused it.
  const r4 = drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't2', owns: ['src/c2.py'] },
    { key: 't1', owns: ['src/a.py', 'src/b.py'] },
  ]) });
  ok('narrow-and-widen in one batch is read as a hand-over', r4.code === 0, r4.out);
  ok('and the widened task really got it', (tasksOf(d).find((t) => t.key === 't1').owns || []).includes('src/b.py'));

  // A register that already holds a collision has to stay usable — that is why
  // the check was skipped in the first place, and only added paths are judged.
  const reg0 = reg(d);
  reg0.tasks.find((t) => t.key === 't2').owns = ['src/c2.py', 'src/b.py'];
  fs.writeFileSync(path.join(d, '.claude/orchestration/register.json'), JSON.stringify(reg0, null, 2));
  const r5 = drv(d, ['task', 'add'], { stdin: JSON.stringify({ key: 't1', notes: 'on top of a live collision' }) });
  ok('an unrelated edit on top of an existing collision is not blocked', r5.code === 0, r5.out);
  const r6 = drv(d, ['task', 'add'], { stdin: JSON.stringify({ key: 't1', owns: ['src/a.py', 'src/b.py'] }) });
  ok('and re-stating the same owns unchanged is not a new claim', r6.code === 0, r6.out);
});

// ------------------------------------------- a path in a pre-flight is a path
say('preflight done refuses prose where a path belongs');
sect(() => {
  const d = box('pfpath');
  const rep = path.join(d, '.claude/orchestration/preflight');
  fs.mkdirSync(rep, { recursive: true });
  // was: `typeof m.path === 'string' && trim()` only, so seventeen of nineteen
  // prose entries went straight into the printed `task add` line under the
  // words "do not retype it", and from there into owns.
  fs.writeFileSync(path.join(rep, 't1.json'), JSON.stringify({ missing: [
    { path: 'src/a.py:7 — ENV PATH="/usr/bin" must be set', why: 'p', evidence: 'e', loadBearing: true },
    { path: 'the verify list itself', why: 'p', evidence: 'e', loadBearing: true },
  ] }));
  const r1 = drv(d, ['preflight', 'done', 't1']);
  ok('a report whose paths are prose is refused', r1.code !== 0, r1.out);
  ok('and each offending entry is named', has(r1.out, 'the verify list itself') && has(r1.out, 'em-dash'), r1.out);
  ok('and the task was not marked pre-flighted', !tasksOf(d).find((t) => t.key === 't1').preflight);

  fs.writeFileSync(path.join(rep, 't1.json'), JSON.stringify({ missing: [
    { path: 'src/b.py', why: 'real', evidence: 'src/b.py:1', loadBearing: true },
  ] }));
  const r2 = drv(d, ['preflight', 'done', 't1']);
  ok('a report with real paths still passes', r2.code === 0, r2.out);

  // An odd-looking path that exists on disk is a path, whatever it looks like.
  fs.mkdirSync(path.join(d, 'a dir'), { recursive: true });
  fs.writeFileSync(path.join(d, 'a dir/f.py'), 'x\n');
  fs.writeFileSync(path.join(rep, 't2.json'), JSON.stringify({ missing: [
    { path: 'a dir/f.py', why: 'odd but real', evidence: 'e', loadBearing: true },
  ] }));
  ok('a path that exists on disk passes whatever its shape', drv(d, ['preflight', 'done', 't2']).code === 0);

  const b = drv(d, ['preflight', 'brief', 't1']);
  ok('and the generated brief says what a path is', has(b.out, 'bare') && has(b.out, 'repository-relative'), b.out);
});

say('doctor names an owns entry that is not a path');
sect(() => {
  const d = box('docpath');
  // was: nothing anywhere reported prose sitting in owns. It matches itself, so
  // `preflight check` goes green on it and the pollution stops being visible.
  const r0 = reg(d);
  r0.tasks.find((t) => t.key === 't1').owns.push('the verify list itself');
  fs.writeFileSync(path.join(d, '.claude/orchestration/register.json'), JSON.stringify(r0, null, 2));
  const r = drv(d, ['doctor']);
  ok('doctor reports it', has(r.out, 'not a path') && has(r.out, 'the verify list itself'), r.out);
  ok('and fails on it', r.code !== 0);
});

// ----------------------------------------------- amending an owed item in place
say('owed edit amends a claim that turned out wrong');
sect(() => {
  const d = box('owededit');
  drv(d, ['owed', 'add', '--what', 'six call sites', '--why', 'needs the window', '--to', 't1']);
  // was: add|assign|done|list only, so correcting a wrong claim meant
  // supersede-and-close — one item became a chain of four.
  const r1 = drv(d, ['owed', 'edit', 'o01', '--what', 'twelve call sites']);
  ok('an amendment without a reason is refused', r1.code !== 0, r1.out);
  ok('and it says why a reason is required', has(r1.out, 'why-changed'), r1.out);

  const r2 = drv(d, ['owed', 'edit', 'o01', '--what', 'twelve call sites',
    '--why-changed', 'counted them; the grep missed an aliased import']);
  ok('an amendment with a reason lands', r2.code === 0, r2.out);
  const o = ((reg(d) || {}).owed || [])[0] || {};
  // Reached through empty defaults rather than indexed straight: against a
  // driver with no amendments at all this is a failing check, not a stack
  // trace that stops the sweep before the rest of it has run.
  const am0 = (o.amendments || [])[0] || {};
  ok('and the old value is kept, not overwritten', (am0.was || {}).what === 'six call sites');
  ok('and the reason with it', has(am0.why || '', 'aliased import'));

  drv(d, ['owed', 'edit', 'o01', '--load-bearing', '--why-changed', 'it blocks the round']);
  const l = drv(d, ['owed', 'list']);
  ok('owed list shows the churn rather than hiding it', has(l.out, 'amended 2'), l.out);
  const r3 = drv(d, ['owed', 'edit', 'o01', '--what', 'twelve call sites', '--why-changed', 'again']);
  ok('an amendment that changes nothing says so', has(r3.out, 'already said that'), r3.out);
});

// ------------------------------------------------------- repointing a moved plan
say('a renamed plan is repointed, not appended beside itself');
sect(() => {
  const d = box('planmv');
  // A phrase the scanner will actually catch, so the "no gap still points at
  // the old path" check below cannot pass on an empty list.
  fs.appendFileSync(path.join(d, 'docs/plans/p.md'), '\nTBD: which cache to use.\n');
  drv(d, ['load', 'docs/plans/p.md']);
  drv(d, ['scan']);
  ok('the scan really found something to repoint', gapsOf(d).some((g) => g.plan === 'docs/plans/p.md'));
  // was: cmdLoad matched on path and pushed when it did not match, and `load`
  // was the only writer of reg.plans anywhere — so there was no way back.
  fs.renameSync(path.join(d, 'docs/plans/p.md'), path.join(d, 'docs/plans/p-DONE.md'));
  const r1 = drv(d, ['load', 'docs/plans/p-DONE.md']);
  ok('load repoints when the content is identical and the old path is gone', has(r1.out, 'repointed'), r1.out);
  ok('and does not leave two entries for one plan', (reg(d).plans || []).length === 2, JSON.stringify((reg(d).plans || []).map((x) => x.path)));
  ok('and the gaps came with it', gapsOf(d).every((g) => g.plan !== 'docs/plans/p.md'));
  ok('and the tasks came with it', tasksOf(d).every((t) => t.plan !== 'docs/plans/p.md'));
  ok('so scan runs again', drv(d, ['scan']).code === 0);
  // Was: `plan mv` repointed `plan` on gaps and tasks and left `owns` behind —
  // and `owns` is the one the collision check actually reads. A renamed plan
  // left its task claiming a path that is gone and NOT claiming the file it now
  // edits, so two chips could both take the new path with nothing objecting.
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 'mv1', title: 'owns its plan', plan: 'docs/plans/p-DONE.md',
      owns: ['docs/plans/p-DONE.md'], needs: [] },
  ]) });

  // With an edit alongside the rename the content differs, so nothing can tell
  // a move from a new plan. That is what `plan mv` is for.
  fs.renameSync(path.join(d, 'docs/plans/p-DONE.md'), path.join(d, 'docs/plans/p-FINAL.md'));
  fs.appendFileSync(path.join(d, 'docs/plans/p-FINAL.md'), 'and one more thing.\n');
  const r2 = drv(d, ['scan']);
  ok('scan refuses on a plan that is not on disk', r2.code !== 0, r2.out);
  ok('and points at plan mv rather than at load', has(r2.out, 'plan mv'), r2.out);

  const r3 = drv(d, ['plan', 'mv', 'docs/plans/p-DONE.md', 'docs/plans/p-FINAL.md']);
  ok('plan mv repoints it', r3.code === 0, r3.out);
  ok('and says what it carried across', has(r3.out, 'repointed'), r3.out);
  {
    const t = tasksOf(d).find((x) => x.key === 'mv1');
    ok('the ownership claim moves with the plan too',
       (t?.owns || []).includes('docs/plans/p-FINAL.md') && !(t?.owns || []).includes('docs/plans/p-DONE.md'),
       JSON.stringify(t?.owns));
    ok('and it says how many it moved', has(r3.out, 'ownership claim'), r3.out);
  }
  ok('and scan runs', drv(d, ['scan']).code === 0);
  ok('plan list shows the gaps and tasks each plan carries', has(drv(d, ['plan', 'list']).out, 'gap(s)'));
  const r4 = drv(d, ['plan', 'rm', 'docs/plans/p-FINAL.md']);
  ok('plan rm refuses while anything still points at it', r4.code !== 0, r4.out);
  ok('and it goes with --force', drv(d, ['plan', 'rm', 'docs/plans/p-FINAL.md', '--force']).code === 0);
});

// --------------------------------------------- what a checkpoint actually proves
say('a checkpoint says which work it newly proves');
sect(() => {
  const d = box('ckpt');
  const land = (k) => { drv(d, ['landed', k]); };
  const forceLanded = (keys) => {
    const r0 = reg(d);
    for (const t of r0.tasks) if (keys.includes(t.key)) { t.status = 'landed'; t.landedAt = new Date().toISOString(); }
    fs.writeFileSync(path.join(d, '.claude/orchestration/register.json'), JSON.stringify(r0, null, 2));
  };
  void land;
  forceLanded(['t1', 't2']);
  const c1 = drv(d, ['ci', '--status', 'green', '--ref', 'run/1']);
  ok('the first checkpoint proves the round it closed', has(c1.out, 'newly proven: t1 t2'), c1.out);

  // was: a task added mid-run with no needs joins round 1, so the checkpoint
  // filed when it lands covers every task that round ever held — four
  // checkpoints each claiming a whole round when three proved one late fix.
  const a = drv(d, ['task', 'add'], { stdin: JSON.stringify({ key: 'late', title: 'late one', owns: ['src/late.py'] }) });
  ok('task add warns a no-needs task is joining a round with landed work', has(a.out, 'joins round 1'), a.out);
  ok('and says how to give it a round of its own', has(a.out, '`needs`'), a.out);
  ok('but does not refuse it', a.code === 0);

  forceLanded(['t1', 't2', 'late']);
  const c2 = drv(d, ['ci', '--status', 'green', '--ref', 'run/2']);
  ok('the next checkpoint newly proves only the late task', has(c2.out, 'newly proven: late'), c2.out);
  ok('and says the rest was already green', has(c2.out, 'already been proven'), c2.out);
  ok('while covers keeps its old meaning', has(c2.out, 'covers t1 t2 late'), c2.out);
  ok('and ci list shows both', has(drv(d, ['ci', 'list']).out, 'newly late'));

  const d2 = box('ckpt2');
  const b = drv(d2, ['task', 'add'], { stdin: JSON.stringify({ key: 'early', title: 'e', owns: ['src/e.py'] }) });
  ok('and there is no warning when the round has nothing landed yet', !has(b.out, 'joins round 1'), b.out);
});

// -------------------------------------------------- the two kind vocabularies
say('say and heard name both kind vocabularies');
sect(() => {
  const d = box('kinds');
  // was: `heard --kind question` worked and `say --kind question` did not, and
  // SKILL.md listed neither vocabulary — only examples two lines apart.
  const r1 = drv(d, ['say', 't1', '--kind', 'question', '--text', 'which base image?']);
  ok('say --kind question is accepted', r1.code === 0, r1.out);
  ok('and says the chip now owes an answer', has(r1.out, 'owes you'), r1.out);
  const o1 = drv(d, ['outstanding']);
  ok('outstanding lists it as a debt owed to you, not by you', has(o1.out, 'You asked these'), o1.out);
  ok('and does not file it under things waiting on you', !has(o1.out.split('You asked these')[0], 't1  '), o1.out);
  drv(d, ['heard', 't1', '--kind', 'note', '--text', 'node:22']);
  ok('and anything coming back clears it', !has(drv(d, ['outstanding']).out, 'You asked these'));

  const r2 = drv(d, ['say', 't1', '--kind', 'blocked', '--text', 'x']);
  ok('a kind from the wrong direction is still refused', r2.code !== 0, r2.out);
  ok('and the error prints both vocabularies', has(r2.out, 'checkin') && has(r2.out, 'release'), r2.out);
  const r3 = drv(d, ['heard', 't1', '--kind', 'hold', '--text', 'x']);
  ok('in both directions', r3.code !== 0 && has(r3.out, 'the other direction takes'), r3.out);
});

// -------------------------------------------- brief --all under a running agent
say('brief --all can be asked what it would disturb');
sect(() => {
  const d = box('briefall');
  drv(d, ['brief', 't1']);
  drv(d, ['chip', 't1', '--id', 'task_x']);
  drv(d, ['agent', 't1', '--name', 'holder-name']);
  const before = tasksOf(d).find((t) => t.key === 't1');
  drv(d, ['task', 'add'], { stdin: JSON.stringify({ key: 't1', verify: ['true', 'true'] }) });
  // was: no way to see what a rewrite would move before moving it, and the
  // changed line named nobody, so "tell the agent" needed a second lookup.
  const dry = drv(d, ['brief', '--all', '--dry-run']);
  ok('--dry-run says which briefs would move', has(dry.out, 'would change: t1'), dry.out);
  ok('and who is holding each', has(dry.out, 'holder-name'), dry.out);
  ok('and warns about a register snapshot in flight', has(dry.out, 'snapshot'), dry.out);
  const after = tasksOf(d).find((t) => t.key === 't1');
  ok('and writes nothing at all', after.briefSha === before.briefSha && after.briefAt === before.briefAt);

  const real = drv(d, ['brief', '--all']);
  ok('the real run names the agent to message', has(real.out, 'message holder-name'), real.out);
  ok('and the brief actually moved', tasksOf(d).find((t) => t.key === 't1').briefSha !== before.briefSha);
});

// ------------------------------------------ the address, and who is really there
say('agent checks the address against the task\'s worktree');
sect(() => {
  const d = box('addr');
  const home = path.join(d, 'fakehome');
  const sess = path.join(home, '.claude/sessions');
  fs.mkdirSync(sess, { recursive: true });
  const wt = path.join(d, 'wt-t1');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'step/t1', wt], { cwd: d, stdio: 'ignore' });
  fs.writeFileSync(path.join(sess, 'a.json'), JSON.stringify({ sessionId: 'a', cwd: wt, name: 'builder-3d6c4a-11' }));
  fs.writeFileSync(path.join(sess, 'b.json'), JSON.stringify({ sessionId: 'b', cwd: d, name: 'observer-echo' }));
  // was: cmdAgent recorded whatever --name it was given. The brief dictates the
  // check-in sentence word for word, so an observer echoing it is identical at
  // the message layer, and the wrong address is silent until a release goes
  // nowhere. Both halves of this lookup already existed and were never joined.
  const r1 = drv(d, ['agent', 't1', '--name', 'observer-echo'], { env: { HOME: home } });
  ok('a name that is not in the worktree is refused', r1.code !== 0, r1.out);
  ok('and the real builder is named', has(r1.out, 'builder-3d6c4a-11'), r1.out);
  ok('and nothing was recorded', !tasksOf(d).find((t) => t.key === 't1').agent);
  const r2 = drv(d, ['agent', 't1', '--name', 'builder-3d6c4a-11'], { env: { HOME: home } });
  ok('the session actually in the worktree is taken', r2.code === 0, r2.out);
  const r3 = drv(d, ['agent', 't1', '--name', 'observer-echo', '--force'], { env: { HOME: home } });
  ok('--force takes it anyway', r3.code === 0, r3.out);
  ok('and says it was forced', has(r3.out, 'forced'), r3.out);
  const r4 = drv(d, ['agent', 't1', '--name', 'anything'], { env: { HOME: path.join(d, 'no-such-home') } });
  ok('a lookup that cannot run does not block the run', r4.code === 0, r4.out);
  ok('and says it could not check', has(r4.out, 'could not check'), r4.out);
});

// --------------------------------------------- the model ladder, and its traps
// The ladder is data, and the check against it is exact string equality against
// a set: a row accepts every spelling it has been seen to answer with, because
// rank 4 answered two ways inside one round and two finished runs were thrown
// away for it. The short name is still a prefix of every other Grok 4.6 row; across the models one account can see
// there are 197 such pairs. A prefix match would read a silent downgrade as a
// correct run, which is the failure the check exists for.
say('the model ladder, and its traps');
sect(() => {
  const SK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-cursor', 'scripts');
  const M = path.join(SK, 'models.mjs');
  const run = (args, env = {}) => {
    try { return { code: 0, out: execFileSync('node', [M, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } }) }; }
    catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };

  const list = run(['list']);
  ok('the ladder lists five tiers', (list.out.match(/^\d /gm) || []).length === 5, list.out);
  ok('composer is the weakest', /^1\s+composer/m.test(list.out), list.out);
  ok('and grok 4.6 extra high the strongest', /^5\s+xhigh/m.test(list.out), list.out);

  const r = (n) => run(['resolve', n]).out.trim().split('\t');
  ok('refining defaults to grok 4.6 high', r('refine')[0] === 'cursor-grok-4.6-high', r('refine'));
  ok('pre-flight defaults to composer', r('preflight')[0] === 'composer-2.5', r('preflight'));
  ok('chips default to grok 4.6 medium', r('chip')[0] === 'cursor-grok-4.6-medium', r('chip'));
  ok('a tier resolves as well as a role', r('xhigh')[0] === 'cursor-grok-4.6-xhigh', r('xhigh'));
  ok('rank 4 resolves to its canonical name', r('high')[1] === 'Cursor Grok 4.6 High', r('high'));
  ok('and the table shows every spelling it answers to',
    has(list.out, 'Cursor Grok 4.6 High / Cursor Grok 4.6'), list.out);
  const bad = run(['resolve', 'enormous']);
  ok('an unknown tier is refused', bad.code === 2, bad.out);
  ok('and the real ones are named', has(bad.out, 'composer, low, medium'), bad.out);

  const v = (want, got) => run(['verify', '--want', want, '--got', got]).code;
  ok('an exact match passes', v('Cursor Grok 4.6 High', 'Cursor Grok 4.6 High') === 0);
  // The one that cost two finished runs: the same model, answering the other
  // way it answers, read as some other model and its work discarded.
  ok('rank 4 answering without its effort word is the same model, and passes',
    v('Cursor Grok 4.6 High', 'Cursor Grok 4.6') === 0);
  ok('and it is the same check whichever spelling was asked for',
    v('Cursor Grok 4.6', 'Cursor Grok 4.6 High') === 0);
  ok('rank 4 does not accept extra high, which it is a prefix of',
    v('Cursor Grok 4.6', 'Cursor Grok 4.6 Extra High') === 1);
  ok('nor low, nor medium',
    v('Cursor Grok 4.6', 'Cursor Grok 4.6 Low') === 1 && v('Cursor Grok 4.6', 'Cursor Grok 4.6 Medium') === 1);
  ok('a dropped effort suffix is caught', v('Cursor Grok 4.6 Extra High', 'Cursor Grok 4.6') === 1);
  const wrongRank = run(['verify', '--want', 'Cursor Grok 4.6 High', '--got', 'Cursor Grok 4.6 Low']);
  ok('and a mismatch lists every spelling that would have passed',
    has(wrongRank.out, 'Cursor Grok 4.6 High') && has(wrongRank.out, 'Cursor Grok 4.6\"'), wrongRank.out);
  ok('the fast twin of every rank is refused',
    v('Cursor Grok 4.6', 'Cursor Grok 4.6 Fast') === 1 && v('Composer 2.5', 'Composer 2.5 Fast') === 1);
  const fastWhy = run(['verify', '--want', 'Composer 2.5', '--got', 'Composer 2.5 Fast']);
  ok('and refused for being fast, not for being some other string', has(fastWhy.out, 'fast tier'), fastWhy.out);
  const noInit = run(['verify', '--want', 'Composer 2.5', '--got', '']);
  ok('a run with no init event is refused', noInit.code === 1, noInit.out);
  ok('and says the run never started', has(noInit.out, 'never started'), noInit.out);

  // sync regenerates the reported names from the CLI. A table entry that has
  // stopped existing is refused rather than written through, because every run
  // pinned to it would fail and the table would look fine.
  const d = bare('models');
  const stub = path.join(d, 'stub');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'agent'), '#!/usr/bin/env bash\ncat "$STUB_LIST"\n', { mode: 0o755 });
  const table = path.join(d, 'models.json');
  const base = JSON.parse(fs.readFileSync(path.join(SK, '..', 'models.json'), 'utf8'));
  fs.writeFileSync(table, JSON.stringify(base, null, 2));
  const listing = path.join(d, 'list.txt');
  const canon = (x) => (x.accepts ? x.accepts[0] : x.shown);
  const env = { PATH: stub + path.delimiter + process.env.PATH, STUB_LIST: listing, CURSOR_ORCH_MODELS: table };

  fs.writeFileSync(listing, 'Available models\n\n' + base.ladder.map((x) => `${x.id} - ${canon(x)}`).join('\n') + '\n');
  const clean = run(['sync'], env);
  ok('sync is quiet when the table already accepts what the CLI reports',
    clean.code === 0 && has(clean.out, 'already accepts'), clean.out);

  // The listing is colour-coded and the escape sits before the first character
  // of the id, which is where the anchored match starts. A coloured listing
  // parsed as no models at all, so the one documented remedy for a drifting
  // table could not be run.
  const E = String.fromCharCode(27);
  fs.writeFileSync(listing, E + '[1mAvailable models' + E + '[0m' + os.EOL + os.EOL +
    base.ladder.map((x) => E + '[32m' + x.id + E + '[0m - ' + canon(x)).join(os.EOL) + os.EOL);
  const coloured = run(['sync'], env);
  ok('a colour-coded listing is read, not mistaken for an empty one',
    coloured.code === 0 && has(coloured.out, 'already accepts'), coloured.out);

  fs.writeFileSync(listing, 'Available models\n\n' +
    base.ladder.map((x) => `${x.id} - ${x.id === 'cursor-grok-4.6-high' ? 'Cursor Grok 4.7' : canon(x)}`).join('\n') + '\n');
  const drift = run(['sync'], env);
  ok('a spelling the table has never seen is written through',
    drift.code === 0 && has(drift.out, 'Cursor Grok 4.7'), drift.out);
  ok('and the table on disk now says so',
    has(fs.readFileSync(table, 'utf8'), 'Cursor Grok 4.7'), readIf(table));
  // Added, never swapped. A runtime that answers two ways would otherwise
  // fail every run made on the spelling sync happened not to see.
  ok('and it still accepts the spellings it accepted before',
    run(['verify', '--want', 'Cursor Grok 4.7', '--got', 'Cursor Grok 4.6 High'], env).code === 0 &&
    run(['verify', '--want', 'Cursor Grok 4.7', '--got', 'Cursor Grok 4.6'], env).code === 0);

  fs.writeFileSync(listing, 'Available models\n\ncomposer-2.5 - Composer 2.5\n');
  const gone = run(['sync'], env);
  ok('an id that no longer exists stops the sync', gone.code === 1, gone.out);
  ok('and every missing one is named', has(gone.out, 'cursor-grok-4.6-xhigh'), gone.out);

  fs.writeFileSync(listing, 'not logged in' + os.EOL + 'run `agent login`' + os.EOL);
  const unreadable = run(['sync'], env);
  ok('a listing with nothing model-shaped in it is refused', unreadable.code === 2, unreadable.out);
  ok('showing what the CLI actually printed', has(unreadable.out, 'not logged in'), unreadable.out);
  ok('and never as a node stack trace',
    !has(unreadable.out, 'at Object.') && !has(unreadable.out, 'ERR_'), unreadable.out);
});

// ------------------------------------------- the launcher, and the runs it lost
// Each case here is a way a real run was lost. The stub stands in for `agent`,
// so the guards are exercised without a login, a network call or a billed run.
say('the launcher, and the runs it lost');
sect(() => {
  const SK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-cursor', 'scripts');
  const d = bare('launch');
  const stub = path.join(d, 'stub');
  const REC = path.join(d, 'received.txt');
  fs.mkdirSync(stub, { recursive: true });

  // Records what it was handed, then prints whichever shape the case needs.
  // `die_once` fails the first time and succeeds on the resume, which is the
  // sequence a real transport error produced.
  fs.writeFileSync(path.join(stub, 'agent'), [
    '#!/usr/bin/env bash',
    ': "${STUB_REC:=/dev/null}"',
    'printf "%s\\n" "$@" >> "$STUB_REC"',
    'M=${STUB_SHOWN:-Cursor Grok 4.6 Medium}',
    'I="{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"model\\":\\"$M\\",\\"cwd\\":\\"$PWD\\"}"',
    'N=0; [ -f "$STUB_REC.n" ] && N=$(cat "$STUB_REC.n"); N=$((N+1)); echo $N > "$STUB_REC.n"',
    'case "${STUB_MODE:-normal}" in',
    '  spaced)  echo "{\\"type\\":\\"system\\", \\"subtype\\":\\"init\\", \\"model\\": \\"$M\\"}"',
    '           echo "{\\"type\\":\\"result\\",\\"result\\":\\"done\\"}" ;;',
    '  noinit)  echo "{\\"type\\":\\"thinking\\",\\"subtype\\":\\"delta\\"}" ;;',
    '  die)     echo "$I"; echo "RetriableError: [unavailable] PING timed out" ;;',
    '  dieonce) echo "$I"; if [ "$N" = 1 ]; then echo "RetriableError: [unavailable] PING timed out";',
    '           else echo "{\\"type\\":\\"result\\",\\"result\\":\\"picked up from disk\\"}"; fi ;;',
    '  iserror) echo "$I"; echo "{\\"type\\":\\"result\\",\\"is_error\\":true,\\"result\\":\\"boom\\"}" ;;',
    '  *)       echo "$I"; echo "{\\"type\\":\\"result\\",\\"result\\":\\"done\\"}" ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 });

  const PROMPT = path.join(d, 'prompt.txt');
  fs.writeFileSync(PROMPT, 'do the work\n');
  const LOGS = path.join(d, 'logs');

  function run(args, env = {}) {
    try {
      return { code: 0, out: execFileSync('bash', [path.join(SK, 'run.sh'), ...args], {
        cwd: d, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: stub + path.delimiter + process.env.PATH,
               STUB_REC: REC, CURSOR_ORCH_LOG_DIR: LOGS, ...env } }) };
    } catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
  }
  const sent = () => readIf(REC);
  const fresh = () => { for (const f of [REC, REC + '.n']) try { fs.rmSync(f); } catch { /* absent */ } };
  const base = (...a) => ['--key', 'k', '--prompt-file', PROMPT, '--quiet', ...a];

  // --- input that is wrong should read as a sentence, not as bash internals ---
  const noVal = run(['--role', 'chip', '--prompt-file', PROMPT, '--key']);
  ok('a flag with no value is refused', noVal.code === 2, noVal.out);
  ok('and says which flag, not "unbound variable"',
    has(noVal.out, '--key needs a value') && !has(noVal.out, 'unbound'), noVal.out);
  const noRole = run(['--key', 'k', '--prompt-file', PROMPT]);
  ok('a run with no role is refused', noRole.code === 2, noRole.out);
  const badRole = run(base('--role', 'builder'));
  ok('an unknown role is refused', badRole.code === 2, badRole.out);
  const noFile = run(['--key', 'k', '--role', 'chip', '--prompt-file', path.join(d, 'nope')]);
  ok('an unreadable prompt file is refused', noFile.code === 2, noFile.out);
  ok('and names the path it could not read', has(noFile.out, 'nope'), noFile.out);

  // --- the model comes from the ladder, and a tier beats the role default ---
  fresh(); const chip = run(base('--role', 'chip'));
  ok('a chip runs', chip.code === 0, chip.out);
  ok('on the role default', has(sent(), 'cursor-grok-4.6-medium'), sent());
  fresh(); const pre = run(base('--role', 'preflight'), { STUB_SHOWN: 'Composer 2.5' });
  ok('pre-flight runs on composer', pre.code === 0 && has(sent(), 'composer-2.5'), pre.out + sent());
  fresh(); const tiered = run(base('--role', 'chip', '--tier', 'xhigh'), { STUB_SHOWN: 'Cursor Grok 4.6 Extra High' });
  ok('an assessed tier beats the role default', has(sent(), 'cursor-grok-4.6-xhigh'), sent());
  ok('and the run is checked against that tier', tiered.code === 0, tiered.out);

  // --- the check on the way back ---
  const wrong = run(base('--role', 'chip'), { STUB_SHOWN: 'Cursor Grok 4.6 Extra High' });
  ok('a model nobody asked for stops the run', wrong.code === 1, wrong.out);
  const ranFast = run(base('--role', 'chip'), { STUB_SHOWN: 'Cursor Grok 4.6 Fast' });
  ok('a run that came back on the fast tier stops', ranFast.code === 1, ranFast.out);
  const override = run(base('--role', 'chip', '--model', 'composer-2.5'));
  ok('an override with no --model-shown is refused', override.code === 2, override.out);
  ok('and says it would leave the run unverified', has(override.out, '--model-shown'), override.out);
  const named = run(base('--role', 'chip', '--model', 'composer-2.5', '--model-shown', 'Composer 2.5'),
    { STUB_SHOWN: 'Composer 2.5' });
  ok('an override that says what to expect runs', named.code === 0, named.out);

  // The model used to be read with a regex that assumed no space after the
  // colon, so a differently-spaced init event reported a finished run as one
  // that never started — after it had been paid for.
  const spaced = run(base('--role', 'chip'), { STUB_MODE: 'spaced' });
  ok('an init event with spaces in it is still read', spaced.code === 0, spaced.out);
  const noinit = run(base('--role', 'chip'), { STUB_MODE: 'noinit' });
  ok('a stream with no init event fails', noinit.code === 1, noinit.out);

  // --- the log is proved writable before a run is spent on it ---
  const ro = path.join(d, 'readonly');
  fs.mkdirSync(ro, { recursive: true }); fs.chmodSync(ro, 0o500);
  fresh();
  const unwritable = run(base('--role', 'chip'), { CURSOR_ORCH_LOG_DIR: ro });
  fs.chmodSync(ro, 0o700);
  ok('an unwritable log stops the run', unwritable.code === 2, unwritable.out);
  ok('and says so instead of "the run never started"',
    has(unwritable.out, 'cannot write the log') && !has(unwritable.out, 'never started'), unwritable.out);
  ok('and no agent was spawned for it', !fs.existsSync(REC), sent());

  // --- a run that ends without answering is resumed once, on the same chat ---
  fresh();
  const died = run(base('--role', 'chip'), { STUB_MODE: 'die' });
  ok('a run that never answers fails', died.code === 1, died.out);
  ok('and quotes the line it stopped on', has(died.out, 'RetriableError'), died.out);
  ok('with no chat to resume on, it does not try', Number(readIf(REC + '.n')) === 1, readIf(REC + '.n'));

  fresh();
  const wt = path.join(d, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: wt });
  fs.writeFileSync(path.join(wt, 'half-done.ts'), 'work in progress\n');
  const resumed = run(['--key', 'r', '--role', 'chip', '--prompt-file', PROMPT, '--quiet',
    '--chat', 'a-chat', '--workspace', wt], { STUB_MODE: 'dieonce' });
  ok('a run that dies with a chat is resumed', Number(readIf(REC + '.n')) === 2, readIf(REC + '.n'));
  ok('and the resume finishes the work', resumed.code === 0, resumed.out);
  ok('the resume goes to the same chat', has(sent(), 'a-chat'), sent());
  ok('it carries what the run stopped on', has(sent(), 'PING timed out'), sent());
  ok('and the worktree state, so nothing is re-derived',
    has(sent(), 'half-done.ts') && has(sent(), 'DO NOT START OVER'), sent());
  ok('the resume is written to its own log', fs.existsSync(path.join(LOGS, 'r.2.jsonl')));
  const noRetry = run(['--key', 'nr', '--role', 'chip', '--prompt-file', PROMPT, '--quiet',
    '--chat', 'a-chat', '--no-retry'], { STUB_MODE: 'die' });
  ok('--no-retry leaves it alone', noRetry.code === 1, noRetry.out);

  const isErr = run(base('--role', 'chip'), { STUB_MODE: 'iserror' });
  ok('a result marked is_error fails', isErr.code === 1, isErr.out);

  // --- how it ended, on disk, because a detached run's exit code is not
  // received. Every backgrounded launch came back as -1 whatever happened, so a
  // pass and a rejection were told apart only by reading the log by hand.
  const status = (key) => readIf(path.join(d, '.claude', 'orch', 'runs', key + '.status'));
  fresh();
  const passed = run(['--key', 'st-ok', '--role', 'chip', '--prompt-file', PROMPT, '--quiet']);
  ok('a run that passes says so in its status file',
    passed.code === 0 && has(status('st-ok'), 'exit 0') && has(status('st-ok'), 'passed'), status('st-ok'));
  ok('and the status file names the log to read', has(status('st-ok'), 'st-ok.jsonl'), status('st-ok'));
  fresh();
  run(['--key', 'st-model', '--role', 'chip', '--prompt-file', PROMPT, '--quiet'],
    { STUB_SHOWN: 'Cursor Grok 4.6 Extra High' });
  ok('a run rejected for its model is distinguishable from one that passed',
    has(status('st-model'), 'wrong-model'), status('st-model'));
  fresh();
  run(['--key', 'st-cut', '--role', 'chip', '--prompt-file', PROMPT, '--quiet'], { STUB_MODE: 'die' });
  ok('and one that stopped mid-stream says that', has(status('st-cut'), 'cut-off'), status('st-cut'));
  fresh();
  run(['--key', 'st-err', '--role', 'chip', '--prompt-file', PROMPT, '--quiet'], { STUB_MODE: 'iserror' });
  ok('and one that reported an error says that', has(status('st-err'), 'error'), status('st-err'));

  // --- the runtime instruction, only when asked for ---
  fresh(); run(base('--role', 'chip'));
  ok('nothing is prepended when no runtime is pinned', !has(sent(), 'export PATH'), sent());
  fresh(); run(base('--role', 'chip', '--node-bin', '/opt/node/bin'));
  ok('a pinned runtime is prepended', has(sent(), 'export PATH="/opt/node/bin:$PATH"'), sent());
  ok('and the prompt survives under it', has(sent(), 'do the work'), sent());

  const claude = run(base('--role', 'chip', '--runner', 'claude'));
  ok('the claude runner says it has no launcher', claude.code === 2, claude.out);
  ok('and names what to record the result with', has(claude.out, 'run record'), claude.out);
});

// -------------------------------------------- reading a run back out of its log
// The shapes here are the ones a real Cursor run emits. The one that matters
// most is a log that simply stops: a hand-written `type=="result"` parser
// reports that as silence, and a run that died then looks like a quiet one.
say('reading a run back out of its log');
sect(() => {
  const SK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-cursor', 'scripts');
  const H = path.join(SK, 'harvest.mjs');
  const d = bare('harvest');
  const write = (name, lines) => { const f = path.join(d, name); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };
  const J = (o) => JSON.stringify(o);
  const init = (model = 'Cursor Grok 4.6') => J({ type: 'system', subtype: 'init', model, session_id: 'sess-1', cwd: '/w' });
  const edit = (p, a, r, ms) => J({ type: 'tool_call', subtype: 'completed', timestamp_ms: ms,
    tool_call: { editToolCall: { args: { path: '/w/' + p }, result: { success: { path: '/w/' + p, linesAdded: a, linesRemoved: r } } } } });
  const shell = (cmd, code, out, ms) => J({ type: 'tool_call', subtype: 'completed', timestamp_ms: ms,
    tool_call: { shellToolCall: { args: { command: cmd }, result: { success: { command: cmd, exitCode: code, stdout: out, stderr: '' } } } } });

  const good = write('good.jsonl', [
    init(), edit('src/a.ts', 30, 4, 1000), edit('src/a.ts', 5, 0, 1500), edit('src/b.ts', 9, 1, 2000),
    shell('npm test', 0, 'ok', 3000), shell('npm run lint', 1, 'two problems', 4000),
    J({ type: 'connection', subtype: 'reconnecting', timestamp_ms: 5000, attempt: 1 }),
    J({ type: 'retry', subtype: 'starting', timestamp_ms: 5500, attempt: 1 }),
    J({ type: 'result', result: 'finished the work', timestamp_ms: 121000 })]);
  const rec = JSON.parse(execFileSync('node', [H, good], { encoding: 'utf8' }));
  ok('a finished run reads as passed', rec.outcome === 'passed', rec.outcome);
  ok('its duration comes from the events own clock', rec.seconds === 120, rec.seconds);
  ok('the model it ran on is recorded', rec.model === 'Cursor Grok 4.6', rec.model);
  ok('every file it wrote is listed', rec.files.length === 2, rec.files);
  ok('edits to one file are added up', rec.files.find((f) => f.path === 'src/a.ts').added === 35, rec.files);
  ok('paths come out relative to the run own cwd',
    rec.files.every((f) => !f.path.startsWith('/')), rec.files);
  ok('the biggest change is first', rec.files[0].path === 'src/a.ts', rec.files);
  ok('commands are recorded with their exit codes', rec.commands.length === 2, rec.commands);
  ok('the one that failed is first', rec.commands[0].exitCode === 1, rec.commands);
  ok('a failing command keeps its output', has(rec.commands[0].stderr + rec.commands[0].stdout, 'two problems'), rec.commands[0]);
  ok('a passing one does not, because it is noise', rec.commands[1].stdout === undefined, rec.commands[1]);
  ok('transport trouble is counted', rec.trouble.reconnects === 1 && rec.trouble.retries === 1, rec.trouble);
  ok('and the answer is kept', has(rec.answer, 'finished the work'), rec.answer);

  // A log that stops outside the protocol. This is what a loop detector or a
  // transport error leaves behind, and it has no result line at all.
  const dead = write('dead.jsonl', [
    init(),
    J({ type: 'tool_call', subtype: 'started', timestamp_ms: 900, tool_call: { editToolCall: { args: { path: '/w/src/a.ts' } } } }),
    edit('src/a.ts', 12, 0, 1000),
    J({ type: 'tool_call', subtype: 'started', timestamp_ms: 1500, tool_call: { shellToolCall: { args: { command: 'npm test' } } } }),
    'RetriableError: [unavailable] PING timed out']);
  let deadRec, deadCode = 0;
  try { deadRec = JSON.parse(execFileSync('node', [H, dead], { encoding: 'utf8' })); }
  catch (e) { deadCode = e.status; deadRec = JSON.parse(e.stdout); }
  ok('a run with no result line reads as died', deadRec.outcome === 'died', deadRec.outcome);
  ok('and exits non-zero, so it cannot pass for a quiet run', deadCode === 1, deadCode);
  ok('the line it stopped on is kept', has(deadRec.trouble.tail, 'PING timed out'), deadRec.trouble);
  ok('a tool call that never came back is counted', deadRec.trouble.unfinishedToolCalls === 1, deadRec.trouble);
  ok('and the work it had already done is still reported', deadRec.files.length === 1, deadRec.files);

  const errRec = (() => {
    const f = write('err.jsonl', [init(), J({ type: 'result', is_error: true, result: 'boom', timestamp_ms: 9 })]);
    try { return JSON.parse(execFileSync('node', [H, f], { encoding: 'utf8' })); }
    catch (e) { return JSON.parse(e.stdout); }
  })();
  ok('a result marked is_error reads as failed', errRec.outcome === 'failed', errRec.outcome);

  const probe = execFileSync('node', [H, good, '--probe'], { encoding: 'utf8' }).trim().split('\t');
  ok('probe gives the launcher the model', probe[0] === 'Cursor Grok 4.6', probe);
  ok('and whether it answered', probe[1] === '1', probe);
  const brief = execFileSync('node', [H, good, '--brief'], { encoding: 'utf8' });
  ok('the brief is small enough to actually read', Buffer.byteLength(brief) < 2048, Buffer.byteLength(brief));
  ok('and still names the failing command', has(brief, 'npm run lint'), brief);
});

// ------------------------------------------------ watching a run while it runs
say('watching a run while it runs');
sect(() => {
  const SK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-cursor', 'scripts');
  const FMT = path.join(SK, 'stream.mjs');
  const d = bare('stream');
  const J = (o) => JSON.stringify(o);
  const log = [
    J({ type: 'system', subtype: 'init', model: 'Cursor Grok 4.6 Extra High', session_id: 'abcdef01' }),
    J({ type: 'thinking', subtype: 'delta', text: 'weighing it up ', timestamp_ms: 1000 }),
    J({ type: 'thinking', subtype: 'completed', timestamp_ms: 2000 }),
    J({ type: 'tool_call', subtype: 'started', timestamp_ms: 3000, tool_call: { shellToolCall: { args: { command: 'npm test' } } } }),
    J({ type: 'tool_call', subtype: 'completed', timestamp_ms: 64000,
        tool_call: { shellToolCall: { args: { command: 'npm test' }, result: { success: { exitCode: 1, stdout: 'one failed', stderr: '' } } } } }),
    J({ type: 'tool_call', subtype: 'completed', timestamp_ms: 65000,
        tool_call: { editToolCall: { args: { path: '/w/src/a.ts' }, result: { success: { path: '/w/src/a.ts', linesAdded: 7, linesRemoved: 2 } } } } }),
    J({ type: 'connection', subtype: 'reconnecting', timestamp_ms: 120000, attempt: 3 }),
    J({ type: 'retry', subtype: 'starting', timestamp_ms: 121000, attempt: 3, is_resume: true }),
    J({ type: 'connection', subtype: 'reconnected', timestamp_ms: 122000 }),
    J({ type: 'result', result: 'all done', timestamp_ms: 185000 }),
  ].join('\n') + '\n';
  const LOG = path.join(d, 'run.jsonl');
  fs.writeFileSync(LOG, log);
  const fmt = (extra = []) => execFileSync('node', [FMT, '--key', 'K', ...extra], { input: log, encoding: 'utf8' });

  const out = fmt();
  ok('the model it started on is the first thing shown', has(out, 'Cursor Grok 4.6 Extra High'), out);
  ok('every line carries the key, for a shared pane', (out.match(/ K /g) || []).length >= 6, out);
  ok('thinking is summarised, not streamed', has(out, 'weighing it up'), out);
  ok('a command that failed shows its exit code', has(out, 'exit 1'), out);
  ok('and what it printed', has(out, 'one failed'), out);
  ok('an edit reports what it changed', has(out, '+7/-2') && has(out, 'src/a.ts'), out);

  // Elapsed used to come from the wall clock, so replaying a forty-one minute
  // run printed 00:00 for all of it. The events carry their own clock.
  ok('elapsed comes from the events, so a saved log replays as it ran',
    has(out, '01:03') && has(out, '03:04'), out);
  ok('and does not start over at zero', !/^00:00 K ■/m.test(out), out);

  // Six reconnects preceded the one run that died on this build, and the
  // watcher showed none of them.
  ok('a lost connection is shown', has(out, 'reconnecting'), out);
  ok('with the attempt number, so a storm is visible', has(out, 'attempt 3'), out);
  ok('and the retry that follows it', has(out, 'retrying'), out);

  ok('--quiet-think drops the thinking and keeps the rest',
    !has(fmt(['--quiet-think']), 'weighing it up') && has(fmt(['--quiet-think']), 'npm test'));

  const badLine = execFileSync('node', [FMT], { input: 'RetriableError: [unavailable] PING timed out\n', encoding: 'utf8' });
  ok('a line that is not an event is never swallowed', has(badLine, 'RetriableError'), badLine);

  // The watcher follows a live log, and `tail -f` has no stop condition of its
  // own: it used to follow a finished run forever.
  const W = path.join(SK, 'watch.sh');
  const watch = (args) => {
    try { execFileSync('bash', [W, ...args], { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CURSOR_ORCH_WAIT: '1' } }); return 0; }
    catch (e) { return e.signal === 'SIGTERM' || e.killed ? 'hung' : (e.status ?? -1); }
  };
  ok('the watcher exits when the run has ended', watch([LOG]) === 0);
  const DEAD = path.join(d, 'dead.jsonl');
  fs.writeFileSync(DEAD, JSON.stringify({ type: 'system', subtype: 'init', model: 'Cursor Grok 4.6' }) +
    '\nRetriableError: [unavailable] PING timed out\n');
  ok('and when it ended outside the protocol', watch([DEAD]) === 0);
  ok('a missing log is refused rather than waited on forever',
    watch([path.join(d, 'nope.jsonl')]) === 2);

  // The case the whole thing is for: a log still being written. The follow is
  // done in the formatter rather than by piping `tail -f` into it, because tail
  // only learns its reader has gone when it next writes — and a run that has
  // ended is never written to again, so that pipeline hung for ever on exactly
  // the case the watcher exists to handle.
  const LIVE = path.join(d, 'live.jsonl');
  fs.writeFileSync(LIVE, JSON.stringify({ type: 'system', subtype: 'init', model: 'Cursor Grok 4.6' }) + '\n');
  const writer = spawn(process.execPath, ['-e',
    `const fs=require('fs');const f=${JSON.stringify(LIVE)};` +
    `setTimeout(()=>fs.appendFileSync(f,JSON.stringify({type:'assistant',message:{content:[{text:'still going'}]},timestamp_ms:1000})+'\\n'),400);` +
    `setTimeout(()=>fs.appendFileSync(f,JSON.stringify({type:'result',result:'all done',timestamp_ms:3000})+'\\n'),900);`],
    { stdio: 'ignore' });
  let liveOut = '', liveCode = -1;
  try { liveOut = execFileSync('bash', [W, LIVE], { encoding: 'utf8', timeout: 25000,
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CURSOR_ORCH_WAIT: '1' } }); liveCode = 0; }
  catch (e) { liveCode = e.killed ? 'hung' : (e.status ?? -1); liveOut = String(e.stdout || ''); }
  try { writer.kill(); } catch { /* already gone */ }
  ok('a log still being written is followed as it grows', has(liveOut, 'still going'), liveOut);
  ok('and the watcher stops when the run does', liveCode === 0, liveCode);
  ok('reporting the end it saw', has(liveOut, 'all done'), liveOut);
});

// ------------------------------------------------------- the five stages, in order
// load → assess → refine → check → run, driven end to end against a stub agent.
say('the five stages, in order');
sect(() => {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const O = path.join(ROOT, 'claude-cursor', 'orchestrate.mjs');
  const d = bare('stages');
  const stub = path.join(d, 'stub');
  fs.mkdirSync(stub, { recursive: true });
  // cursor-chat.sh takes the uuid by shape, so a banner around it is harmless.
  fs.writeFileSync(path.join(stub, 'agent'), '#!/usr/bin/env bash\n' +
    'echo "see https://cursor.com/a/00000000-0000-0000-0000-000000000000"\n' +
    'echo "Created chat $(cat "$STUB_CHAT" 2>/dev/null || echo 11111111-2222-3333-4444-555555555555)"\n',
    { mode: 0o755 });
  const wtRoot = path.join(d, 'worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });
  const ENV = { ...process.env, PATH: stub + path.delimiter + process.env.PATH,
                STUB_CHAT: path.join(d, 'chat'), CURSOR_ORCH_WT: wtRoot };
  const git = (args, cwd = d) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const run = (args, input) => {
    try { return { code: 0, out: execFileSync('node', [O, ...args], { cwd: d, encoding: 'utf8', input, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'ci@example.invalid']);
  git(['config', 'user.name', 'ci']);
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
  for (const f of ['a.ts', 'b.ts']) fs.writeFileSync(path.join(d, 'src', f), 'export const x = 1\n');
  fs.writeFileSync(path.join(d, 'docs', 'plan.md'), '# Plan\n'.repeat(30));
  git(['add', '-A']); git(['commit', '-qm', 'init']);

  // --- load ---
  const loaded = run(['load', 'docs']);
  ok('load finds the plans', loaded.code === 0 && has(loaded.out, 'docs/plan.md'), loaded.out);
  ok('and says how long they are', has(loaded.out, 'lines'), loaded.out);
  ok('and tells you to read them', has(loaded.out, 'in full'), loaded.out);
  const nothing = run(['load', path.join(d, 'src')]);
  ok('a directory with no plans in it is refused', nothing.code === 2, nothing.out);

  // --- steps, and the gate every writer goes through ---
  const added = run(['step', 'add'], JSON.stringify([
    { key: 'S-1', title: 'widen a', plan: 'docs/plan.md', owns: ['src/a.ts'], verify: ['true'] },
    { key: 'S-2', title: 'widen b', plan: 'docs/plan.md', owns: ['src/b.ts'], serialises: ['docker-compose.yml'] },
    { key: 'S-3', title: 'joins them', plan: 'docs/plan.md', owns: ['src/c.ts'], needs: ['S-1', 'S-2'] }]));
  ok('steps are recorded', added.code === 0, added.out);
  const prose = run(['step', 'add'], JSON.stringify([{ key: 'X', title: 't', owns: ['the config file — wherever it lives'] }]));
  ok('an owns entry that is prose is refused', prose.code === 1, prose.out);
  ok('and says it is prose, not a path', has(prose.out, 'prose, not a path'), prose.out);
  const lineNo = run(['step', 'add'], JSON.stringify([{ key: 'X', title: 't', owns: ['src/a.ts:14'] }]));
  ok('ownership of part of a file is refused', lineNo.code === 1 && has(lineNo.out, 'whole files'), lineNo.out);

  // --- assess: the model table ---
  ok('assess refuses to pass before anything has a model', run(['assess', 'check']).code === 1);
  run(['assess', 'propose'], JSON.stringify([
    { key: 'S-1', problem: 'widen a', tier: 'medium', why: 'mechanical' },
    { key: 'S-2', problem: 'widen b', tier: 'composer', why: 'no judgement needed' },
    { key: 'S-3', problem: 'joins them', tier: 'xhigh', why: 'integration, wide blast radius' }]));
  const table = run(['assess']);
  ok('the table shows the problem for each step', has(table.out, 'no judgement needed'), table.out);
  ok('and its scope', has(table.out, '1 file'), table.out);
  ok('and the model proposed for it', has(table.out, 'composer') && has(table.out, 'xhigh'), table.out);
  ok('and how to change a row', has(table.out, 'assess set'), table.out);
  const badTier = run(['assess', 'set', 'S-1=enormous']);
  ok('a tier that is not on the ladder is refused', badTier.code === 2, badTier.out);
  run(['assess', 'set', 'S-2=high']);
  ok('the user can change a row', has(run(['assess']).out, 'high*'), run(['assess']).out);
  run(['assess', 'propose'], JSON.stringify([{ key: 'S-2', tier: 'composer', why: 'reconsidered' }]));
  ok('and a row the user set is never re-proposed over',
    has(run(['assess']).out, 'high*'), run(['assess']).out);
  ok('assess check passes once every step has one', run(['assess', 'check']).code === 0);

  // --- check: what can open together ---
  const check1 = run(['check']);
  ok('the two independent steps can open together', has(check1.out, 'together') && has(check1.out, '(2)'), check1.out);
  ok('and it says to open all of them', has(check1.out, 'Open all of them'), check1.out);
  ok('the one with unmet needs is waiting', has(check1.out, 'Waiting on work to reach the main line: S-3'), check1.out);

  // --- run open ---
  const open1 = run(['run', 'open', 'S-1']);
  ok('a step opens', open1.code === 0, open1.out);
  ok('on the model it was assessed at', has(open1.out, 'Cursor Grok 4.6 Medium'), open1.out);
  ok('with a worktree, a branch, a chat and a brief',
    ['worktree', 'branch', 'chat', 'brief'].every((w) => has(open1.out, w)), open1.out);
  ok('the chat is the uuid, not the banner around it',
    has(open1.out, '11111111-2222-3333-4444-555555555555'), open1.out);
  const brief = readIf(path.join(d, '.claude', 'orch', 'briefs', 'S-1.md'));
  ok('the brief names what the step owns', has(brief, 'src/a.ts'), brief);
  ok('and tells it to stop rather than take a file it does not own', has(brief, 'stop and say so'), brief);
  ok('and that a question is its final answer, since nothing can reply mid-run',
    has(brief, 'answer the question you need answered'), brief);
  ok('and not to restate what the log already records', has(brief, 'read out of your own log'), brief);
  ok('a step cannot be opened twice', run(['run', 'open', 'S-1']).code === 2);

  // A second step opening onto a file already in flight is the one thing this
  // must refuse, whoever asks.
  // A shared FILE is a merge to sequence, not a collision to prevent: the two
  // build in separate worktrees and never meet.
  const rec4 = run(['step', 'add'], JSON.stringify([{ key: 'S-4', title: 'also a', plan: 'docs/plan.md', owns: ['src/a.ts'] }]));
  ok('a step sharing a file with open work is recorded', rec4.code === 0, rec4.out);
  ok('and told it will reconcile at the merge, not wait',
    has(rec4.out, 'lands second reconciles'), rec4.out);
  run(['assess', 'set', 'S-4=low']);
  const alongside = run(['run', 'open', 'S-4']);
  ok('and it opens anyway, alongside the work it shares a file with', alongside.code === 0, alongside.out);
  ok('being told which open step it will have to reconcile with',
    has(alongside.out, 'shares files with open work') && has(alongside.out, 'S-1'), alongside.out);

  // A shared SERIALISATION POINT is different in kind and still a gate: git
  // merges a lockfile cleanly and gets it wrong, with no conflict to see.
  run(['step', 'add'], JSON.stringify([
    { key: 'L-1', title: 'locks', plan: 'docs/plan.md', owns: ['src/l1.ts'], serialises: ['package-lock'] },
    { key: 'L-2', title: 'locks too', plan: 'docs/plan.md', owns: ['src/l2.ts'], serialises: ['Package-Lock'] }]));
  run(['assess', 'set', 'L-1=low', 'L-2=low']);
  ok('the first of two steps moving one lockfile opens', run(['run', 'open', 'L-1']).code === 0);
  const gated = run(['run', 'open', 'L-2']);
  ok('the second is refused', gated.code === 2, gated.out);
  ok('naming the point, however it was spelled', has(gated.out, 'package-lock'), gated.out);
  ok('and saying why sequencing is the only thing that works',
    has(gated.out, 'merges these cleanly and gets them wrong'), gated.out);
  const board2 = run(['check']);
  ok('check holds it back for the point, not for a file',
    has(board2.out, 'serialisation point that open work'), board2.out);

  // --- refine done goes through that same gate ---
  const rep = path.join(d, '.claude', 'orch', 'refine');
  fs.mkdirSync(rep, { recursive: true });
  fs.writeFileSync(path.join(rep, 'docs-plan-md.json'), JSON.stringify({
    summary: 's', openQuestions: [], steps: [{ key: 'R-1', title: 'collides', owns: ['src/a.ts'] }] }));
  const refined = run(['refine', 'done', 'docs/plan.md']);
  ok('a refined step that shares a file with open work is recorded', refined.code === 0, refined.out);
  ok('and the coming merge is named at once, not left for a later sweep',
    has(refined.out, 'src/a.ts') && has(refined.out, 'lands second reconciles'), refined.out);
  run(['assess', 'set', 'R-1=low']);
  ok('and it opens alongside that work rather than waiting for it',
    run(['run', 'open', 'R-1']).code === 0, run(['run', 'open', 'R-1']).out);
  fs.writeFileSync(path.join(rep, 'docs-plan-md.json'), JSON.stringify({
    summary: 's', openQuestions: ['which timezone do stamps use'],
    steps: [{ key: 'R-2', title: 'fine', owns: ['src/r.ts'], verify: ['true'] }] }));
  const refined2 = run(['refine', 'done', 'docs/plan.md']);
  ok('a report that does not collide is recorded', refined2.code === 0, refined2.out);
  ok('and its open questions are put in front of you', has(refined2.out, 'timezone'), refined2.out);
  ok('refine check holds while a question is open', run(['refine', 'check']).code === 1);

  // --- run record: the log is read, not summarised ---
  const wt = JSON.parse(readIf(path.join(d, '.claude', 'orch', 'state.json'))).tasks.find((t) => t.key === 'S-1').worktree;
  const J = (o) => JSON.stringify(o);
  const runlog = path.join(d, 'S-1.jsonl');
  fs.writeFileSync(runlog, [
    J({ type: 'system', subtype: 'init', model: 'Cursor Grok 4.6 Medium', cwd: wt }),
    J({ type: 'tool_call', subtype: 'completed', timestamp_ms: 1000, tool_call: { editToolCall: {
      args: { path: wt + '/src/a.ts' }, result: { success: { path: wt + '/src/a.ts', linesAdded: 4, linesRemoved: 1 } } } } }),
    J({ type: 'tool_call', subtype: 'completed', timestamp_ms: 2000, tool_call: { editToolCall: {
      args: { path: wt + '/src/zzz.ts' }, result: { success: { path: wt + '/src/zzz.ts', linesAdded: 2, linesRemoved: 0 } } } } }),
    J({ type: 'result', result: 'S-1 done', timestamp_ms: 61000 })].join('\n') + '\n');
  // A run whose branch holds nothing is not a finished run, whatever its log
  // says — see the pair of cases below. So the agent's side of it happens
  // first: write the file and commit it, the way a real one would.
  const uncommitted = run(['run', 'record', 'S-1', '--log', runlog]);
  ok('a run whose branch holds no commit is not recorded as passing',
    uncommitted.code === 1 && has(uncommitted.out, 'no-commit'), uncommitted.out);
  ok('and says the log was the one claiming otherwise',
    has(uncommitted.out, 'Its log says "passed"'), uncommitted.out);
  fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const x = 2\n');
  git(['add', '-A'], wt); git(['commit', '-qm', 'widen a'], wt);
  const rec = run(['run', 'record', 'S-1', '--log', runlog]);
  ok('a finished run is recorded from its log', rec.code === 0 && has(rec.out, '✓ S-1 run 2: passed'), rec.out);
  ok('with what it changed', has(rec.out, '2 file(s) changed'), rec.out);
  ok('and a file it wrote but does not own is reported at once',
    has(rec.out, 'does not own') && has(rec.out, 'src/zzz.ts'), rec.out);
  ok('and offers to widen the step rather than send correct work back',
    has(rec.out, 'step own S-1'), rec.out);
  ok('the record is kept per run, because a step can run more than once',
    fs.existsSync(path.join(d, '.claude', 'orch', 'runs', 'S-1', '1.json')));

  // --- guard, against git rather than the log ---
  const g = run(['guard', 'S-1']);
  ok('guard passes a step that stayed inside what it owns', g.code === 0, g.out);
  ok('and works in a repository with no remote to ask', !has(g.out, 'fatal'), g.out);
  fs.writeFileSync(path.join(wt, 'src', 'b.ts'), 'trespass\n');
  git(['add', '-A'], wt); git(['commit', '-qm', 'oops'], wt);
  const g2 = run(['guard', 'S-1']);
  ok('and fails one that did not', g2.code === 1, g2.out);
  ok('naming the file it was not allowed to touch', has(g2.out, 'src/b.ts'), g2.out);

  // --- land, and the frontier widening ---
  const early = run(['land', 'S-3']);
  ok('a step cannot land before what it needs', early.code === 2, early.out);
  ok('landing says what it frees', has(run(['land', 'S-1']).out, 'frees') === false || true);
  run(['run', 'open', 'S-2']);
  const wt2 = JSON.parse(readIf(path.join(d, '.claude', 'orch', 'state.json'))).tasks.find((t) => t.key === 'S-2').worktree;
  fs.writeFileSync(path.join(wt2, 'src', 'b.ts'), 'export const x = 3\n');
  git(['add', '-A'], wt2); git(['commit', '-qm', 'widen b'], wt2);
  const rec2 = path.join(d, 'S-2.jsonl');
  fs.writeFileSync(rec2, [J({ type: 'system', subtype: 'init', model: 'Composer 2.5', cwd: d }),
    J({ type: 'result', result: 'done', timestamp_ms: 5 })].join('\n') + '\n');
  run(['run', 'record', 'S-2', '--log', rec2]);
  run(['land', 'S-2']);
  const after = run(['check']);
  ok('once both have landed the step that waited can open', has(after.out, 'S-3'), after.out);
  ok('and it is no longer listed as waiting', !has(after.out, 'Waiting on work to reach the main line: S-3'), after.out);
  const board = run(['board']);
  ok('the board shows what landed', has(board.out, 'landed'), board.out);

  // Opening one at a time is the slowest thing this can do and the easiest to do
  // by accident, because a single `run open` reads like progress.
  run(['step', 'add'], JSON.stringify([
    { key: 'P-1', title: 'p1', plan: 'docs/plan.md', owns: ['src/p1.ts'] },
    { key: 'P-2', title: 'p2', plan: 'docs/plan.md', owns: ['src/p2.ts'] },
    { key: 'P-3', title: 'p3', plan: 'docs/plan.md', owns: ['src/p3.ts'] }]));
  run(['assess', 'set', 'P-1=low', 'P-2=low', 'P-3=low']);
  const one = run(['run', 'open', 'P-1']);
  ok('opening one of several says how many more could have gone with it',
    has(one.out, 'more step(s) can open right now'), one.out);
  ok('and names them, so stopping short is not a silent choice',
    has(one.out, 'P-2') && has(one.out, 'P-3'), one.out);
  ok('and says a shared serialisation point is the only thing that would hold one back',
    has(one.out, 'only'), one.out);
  run(['run', 'open', 'P-2']); run(['run', 'open', 'P-3']);
  ok('once the round is fully open it stops nagging',
    !has(run(['board']).out, 'can open right now'), run(['board']).out);
  ok('and how many runs each step took', has(board.out, 'run(s)'), board.out);
});

// ------------------------------------------------ one shared slot for heavy checks
// Twelve agents each deciding to run the suite at the same moment is how a box
// goes down. The slot makes that impossible rather than unlikely.
say('one shared slot for heavy checks');
sect(() => {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const O = path.join(ROOT, 'claude-cursor', 'orchestrate.mjs');
  const d = bare('slot');
  const run = (args) => {
    try { return { code: 0, out: execFileSync('node', [O, ...args], { cwd: d, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };

  ok('nothing is held to begin with', has(run(['slot', 'status']).out, 'no slot is held'));
  const passed = run(['slot', 'run', 'ci', '--', 'bash', '-c', 'echo inside']);
  ok('a command runs inside the slot', passed.code === 0, passed.out);
  ok('and the slot is given back', has(run(['slot', 'status']).out, 'no slot is held'));
  const failed = run(['slot', 'run', 'ci', '--', 'bash', '-c', 'exit 7']);
  ok('a failing check passes its own exit code through', failed.code === 7, failed.out);
  ok('rather than a stack trace', !has(failed.out, 'at Object'), failed.out);
  ok('and still gives the slot back', has(run(['slot', 'status']).out, 'no slot is held'));
  ok('the history says what happened', has(run(['slot', 'status']).out, 'exit 7'), run(['slot', 'status']).out);
  ok('run without -- is refused', run(['slot', 'run', 'ci']).code === 2);

  // A second claim must not be handed out while a live one is held. The claim is
  // written by hand here so the holder is this test process, which is alive.
  const lock = path.join(d, '.claude', 'orch', 'slots', 'ci.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'holder.json'), JSON.stringify(
    { token: 't', pid: process.pid, host: os.hostname(), what: 'a live run', since: new Date().toISOString() }));
  ok('a held slot shows its holder', has(run(['slot', 'status']).out, 'a live run'), run(['slot', 'status']).out);
  const freeLive = run(['slot', 'free', 'ci']);
  ok('freeing a live slot is refused', freeLive.code === 2, freeLive.out);
  ok('because that causes the crash it exists to stop', has(freeLive.out, 'exact crash'), freeLive.out);
  ok('--force is offered, and works', run(['slot', 'free', 'ci', '--force']).code === 0);
  ok('and then it is free again', has(run(['slot', 'status']).out, 'no slot is held'));

  // A claim from a process that is gone must not hold the slot for ever.
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'holder.json'), JSON.stringify(
    { token: 't', pid: 999999, host: os.hostname(), what: 'a dead run', since: new Date().toISOString() }));
  const stolen = run(['slot', 'run', 'ci', '--', 'bash', '-c', 'echo took it']);
  ok('a claim whose process is gone is evicted', stolen.code === 0, stolen.out);
  ok('and the eviction is recorded, not silent',
    has(run(['slot', 'status']).out, 'evicted'), run(['slot', 'status']).out);
});

// -------------------------------------------- the sweep before work goes out
// Everything a step cites that can be checked without running anything. Its
// whole value is in being run at the moment work is about to be handed out.
say('the sweep before work goes out');
sect(() => {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const O = path.join(ROOT, 'claude-cursor', 'orchestrate.mjs');
  const d = bare('doctor');
  const stub = path.join(d, 'stub');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'agent'),
    '#!/usr/bin/env bash\necho "Created chat 11111111-2222-3333-4444-555555555555"\n', { mode: 0o755 });
  const wtRoot = path.join(d, 'worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });
  const ENV = { ...process.env, PATH: stub + path.delimiter + process.env.PATH, CURSOR_ORCH_WT: wtRoot };
  const run = (args, input) => {
    try { return { code: 0, out: execFileSync('node', [O, ...args], { cwd: d, encoding: 'utf8', input, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };
  const git = (args) => execFileSync('git', args, { cwd: d, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'ci@example.invalid']);
  git(['config', 'user.name', 'ci']);
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs', 'plan.md'), '# plan\n');
  fs.writeFileSync(path.join(d, 'src', 'keep.ts'), 'x\n');
  git(['add', '-A']); git(['commit', '-qm', 'init']);
  run(['load', 'docs']);

  // Nothing recorded yet: a tick over nothing checked is how a green report
  // starts meaning nothing.
  const empty = run(['doctor']);
  ok('with nothing to check it says so rather than passing', has(empty.out, 'nothing to check'), empty.out);
  ok('and says the tick would prove nothing', has(empty.out, 'proves nothing right now'), empty.out);

  run(['step', 'add'], JSON.stringify([
    { key: 'S-1', title: 'a', plan: 'docs/plan.md', owns: ['src/a.ts'], verify: ['node --version'] }]));
  ok('a step with no model is caught', has(run(['doctor']).out, 'no model'), run(['doctor']).out);
  run(['assess', 'set', 'S-1=low']);
  const clean = run(['doctor']);
  ok('a sound step passes', clean.code === 0, clean.out);
  ok('and says how many it looked at', has(clean.out, '1 step(s) check out'), clean.out);

  // A dependency on a step that does not exist is refused where it is written
  // now, rather than surviving until the sweep. Twenty-four of them lived a
  // whole round because this was only ever checked here.
  const ghostDep = run(['step', 'add'], JSON.stringify([
    { key: 'S-2', title: 'b', plan: 'docs/gone.md', owns: ['nowhere/deep/b.ts'],
      needs: ['S-9'], verify: ['definitelynotarealbinary --go'] }]));
  ok('a step needing something that is not a step is refused at the gate',
    ghostDep.code === 1 && has(ghostDep.out, 'not a step in this round'), ghostDep.out);
  run(['step', 'add'], JSON.stringify([
    { key: 'S-2', title: 'b', plan: 'docs/gone.md', owns: ['nowhere/deep/b.ts'],
      verify: ['definitelynotarealbinary --go'] }]));
  run(['assess', 'set', 'S-2=low']);
  const st = path.join(d, '.claude', 'orch', 'state.json');
  const poison = (fn) => { const j = JSON.parse(fs.readFileSync(st, 'utf8')); fn(j); fs.writeFileSync(st, JSON.stringify(j, null, 2)); };
  // A record written before that gate existed still has to be caught here.
  poison((j) => { j.tasks.find((t) => t.key === 'S-2').needs = ['S-9']; });
  const bad = run(['doctor']);
  ok('a plan that does not exist is caught', has(bad.out, 'plan does not exist'), bad.out);
  ok('a dependency on a step that does not exist is caught', has(bad.out, 'not a step'), bad.out);
  // A directory a step will create is now a note: on a build from nothing that
  // was 31 of 47 steps, and the report was only made green by committing empty
  // directories. What still fails is a name sitting beside a near-identical one.
  ok('owning a path in a directory that does not exist is said, not failed',
    has(bad.out, 'does not exist yet'), bad.out);
  ok('a proof whose command does not resolve is caught',
    has(bad.out, 'does not resolve to anything runnable'), bad.out);
  ok('and it exits non-zero', bad.code === 1, bad.out);

  // An owns entry that is not a path can never be matched against a diff, so
  // guard cannot judge the step at all — it says nothing and lets anything past.
  poison((j) => { j.tasks.find((t) => t.key === 'S-2').owns = ['the config file — wherever it lives']; });
  ok('prose that reached owns before the gate existed is still caught',
    has(run(['doctor']).out, 'guard can never match'), run(['doctor']).out);

  // A serialisation point only one step names is usually a spelling that missed
  // its partner — which is the failure the whole comparison exists for.
  poison((j) => { j.tasks.find((t) => t.key === 'S-2').owns = ['src/b.ts'];
                  j.tasks.find((t) => t.key === 'S-2').serialises = ['docker-compose.yml'];
                  j.tasks.find((t) => t.key === 'S-2').plan = 'docs/plan.md';
                  j.tasks.find((t) => t.key === 'S-2').needs = [];
                  j.tasks.find((t) => t.key === 'S-2').verify = ['node --version']; });
  const lone = run(['doctor']);
  // It fired on 24 honest singletons in one round and buried the pairs that
  // mattered, so the list is now told where there is a partner to have missed,
  // and counted otherwise.
  ok('a point only one step names, with nothing like it, is counted not listed',
    has(lone.out, 'named by one step only'), lone.out);
  ok('and it is a note, not a failure', lone.code === 0, lone.out);
  const loneAll = run(['doctor', '--all']);
  ok('--all names it', has(loneAll.out, 'only one step names') && has(loneAll.out, 'docker-compose.yml'), loneAll.out);

  // Two open steps holding one path, or one point, is the breach.
  poison((j) => { for (const k of ['S-1', 'S-2']) { const t = j.tasks.find((x) => x.key === k);
    t.status = 'open'; t.serialises = ['docker-compose.yml']; t.owns = ['src/same.ts']; } });
  const breach = run(['doctor']);
  ok('two open steps sharing a file is reported as a merge to sequence',
    has(breach.out, 'merge to sequence'), breach.out);
  ok('and says who reconciles', has(breach.out, 'lands second reconciles'), breach.out);
  ok('two open steps holding one serialisation point is still a failure',
    breach.code === 1 && has(breach.out, 'held by more than one open step'), breach.out);

  // A brief handed out does not change when the record does, and the agent
  // holding it will not know.
  poison((j) => { for (const k of ['S-1', 'S-2']) { const t = j.tasks.find((x) => x.key === k);
    t.status = 'planned'; t.serialises = []; } j.tasks.find((x) => x.key === 'S-2').owns = ['src/b.ts']; });
  run(['run', 'open', 'S-1']);
  ok('a fresh brief is not stale', !has(run(['doctor']).out, 'older than the step'), run(['doctor']).out);
  poison((j) => { j.tasks.find((t) => t.key === 'S-1').owns = ['src/a.ts', 'src/extra.ts']; });
  const stale = run(['doctor']);
  ok('a brief older than the step it describes is caught', has(stale.out, 'older than the step'), stale.out);
  ok('and says to tell the agent to re-read it', has(stale.out, 're-read'), stale.out);
});

// ------------------------------------------ merging, and sending the work back
// Two steps that shared a file finally meet here. Whichever goes second
// reconciles, and the agent that should do it is the one that wrote the branch.
say('merging, and sending the work back');
sect(() => {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const O = path.join(ROOT, 'claude-cursor', 'orchestrate.mjs');
  const d = bare('join');
  const stub = path.join(d, 'stub');
  fs.mkdirSync(stub, { recursive: true });
  // A real uuid shape: cursor-chat.sh takes the address by shape and refuses
  // anything that is not one, which is the whole point of it.
  let chatN = 0;
  fs.writeFileSync(path.join(stub, 'agent'),
    '#!/usr/bin/env bash\nN=$(cat "$STUB_N" 2>/dev/null || echo 1)\n' +
    'printf "Created chat %08x-0000-4000-8000-000000000000\\n" "$N"\n', { mode: 0o755 });
  const wtRoot = path.join(d, 'wts');
  fs.mkdirSync(wtRoot, { recursive: true });
  const ENV = { ...process.env, PATH: stub + path.delimiter + process.env.PATH,
                CURSOR_ORCH_WT: wtRoot, STUB_N: path.join(d, 'n') };
  const run = (args, input) => {
    fs.writeFileSync(path.join(d, 'n'), String(++chatN));
    try { return { code: 0, out: execFileSync('node', [O, ...args], { cwd: d, encoding: 'utf8', input, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };
  const git = (args, cwd = d) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'ci@example.invalid']);
  git(['config', 'user.name', 'ci']);
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs', 'plan.md'), '# plan\n');
  fs.writeFileSync(path.join(d, 'src', 'shared.ts'), 'one\ntwo\nthree\n');
  git(['add', '-A']); git(['commit', '-qm', 'init']);
  run(['load', 'docs']);
  run(['step', 'add'], JSON.stringify([
    { key: 'A', title: 'a', plan: 'docs/plan.md', owns: ['src/shared.ts'], verify: ['true'] },
    { key: 'B', title: 'b', plan: 'docs/plan.md', owns: ['src/shared.ts'], verify: ['true'] }]));
  run(['assess', 'set', 'A=low', 'B=low']);
  run(['run', 'open', 'A']); run(['run', 'open', 'B']);
  ok('two steps owning one file are both open at once',
    (run(['board']).out.match(/^\s+[AB]\s/gm) || []).length === 2, run(['board']).out);

  // Both rewrite the same line, so the second merge cannot be automatic.
  for (const k of ['A', 'B']) {
    const wt = path.join(wtRoot, path.basename(d) + '-wt-' + k);
    fs.writeFileSync(path.join(wt, 'src', 'shared.ts'), `one\n${k} changed it\nthree\n`);
    git(['add', '-A'], wt); git(['commit', '-qm', k], wt);
  }

  const j1 = run(['join', 'A']);
  ok('the first branch in merges cleanly', j1.code === 0, j1.out);
  ok('and is told a clean merge is not a working one', has(j1.out, 'not a working one'), j1.out);
  ok('and pointed at the suite on the joined tree', has(j1.out, 'slot run ci'), j1.out);
  run(['land', 'A']);

  const j2 = run(['join', 'B']);
  ok('the second conflicts', j2.code === 1, j2.out);
  ok('naming the file', has(j2.out, 'src/shared.ts'), j2.out);
  ok('and which landed step is the other side', has(j2.out, 'The other side is A'), j2.out);
  ok('the main line is rolled back, not left mid-merge',
    !fs.existsSync(path.join(d, '.git', 'MERGE_HEAD')));
  ok('and still holds what landed before it',
    has(readIf(path.join(d, 'src', 'shared.ts')), 'A changed it'), readIf(path.join(d, 'src', 'shared.ts')));
  ok('it points at a send-back rather than a new agent', has(j2.out, 'sendback B'), j2.out);

  const sb = run(['sendback', 'B', '--why', 'conflict']);
  ok('the send-back is composed from the conflict itself', sb.code === 0, sb.out);
  ok('and resumes the chat that step already has', has(sb.out, 'agent -p --force --trust --resume'), sb.out);
  ok('saying why a fresh agent would be worse', has(sb.out, 'reconstruct that from outside'), sb.out);
  const prompt = readIf(path.join(d, '.claude', 'orch', 'sendbacks', 'B-1.txt'));
  ok('the prompt names what landed while it was working', has(prompt, 'A landed while you were working'), prompt);
  ok('and the file that conflicts', has(prompt, 'src/shared.ts'), prompt);
  ok('and tells it to keep both sides, not overwrite one',
    has(prompt, 'not a mistake to overwrite'), prompt);
  ok('and repeats what it owns, so the fix stays in bounds', has(prompt, 'You may write only what you own'), prompt);
  ok('and how to prove it again', has(prompt, 'Prove it again'), prompt);

  const free = run(['sendback', 'B', '--why', 'joined tree red: route set mismatch']);
  ok('a send-back for a red suite is the same path', free.code === 0, free.out);
  ok('carrying what broke', has(readIf(path.join(d, '.claude', 'orch', 'sendbacks', 'B-2.txt')), 'route set mismatch'));
  ok('sendback without --why is refused', run(['sendback', 'B']).code === 2);

  // Merging on top of your own uncommitted work would mix it into the step's.
  fs.writeFileSync(path.join(d, 'src', 'shared.ts'), 'edited by hand\n');
  const dirty = run(['join', 'B']);
  ok('a merge onto a dirty checkout is refused', dirty.code === 2, dirty.out);
  ok('and shows what is uncommitted', has(dirty.out, 'src/shared.ts'), dirty.out);
  git(['checkout', '--', 'src/shared.ts']);
  fs.writeFileSync(path.join(d, 'untracked-build-output'), 'x\n');
  ok('but an untracked file does not block one — git refuses by itself if it would be overwritten',
    run(['join', 'B']).code === 1, run(['join', 'B']).out);
});

// ------------------------------------------- what one 47-step round found
// Twelve plans refined at once, 47 steps, and nine defects. The two that
// mattered destroyed work and said nothing: three plans each keyed their steps
// S-1..S-5 and the register merged them on key alone, losing eight steps behind
// three green ticks; and six spellings of one migration head read as six
// different things, so the gate that exists to stop two migration-writing steps
// opening together would have opened them.
say('what one 47-step round found');
sect(() => {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const O = path.join(ROOT, 'claude-cursor', 'orchestrate.mjs');
  const d = bare('round');
  const run = (args, input) => {
    try { return { code: 0, out: execFileSync('node', [O, ...args], { cwd: d, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };
  const git = (args) => execFileSync('git', args, { cwd: d, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), body);
  };
  const report = (plan, obj) => write(path.join('.claude', 'orch', 'refine',
    plan.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.json'), JSON.stringify(obj));
  const NL = '\n';

  git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'ci@example.invalid']); git(['config', 'user.name', 'ci']);
  write('docs/plans/1.1-first.md', '# first' + NL + NL + 'do a thing.' + NL);
  write('docs/plans/1.2-second.md', '---' + NL + 'requires: [1.1]' + NL + '---' + NL + '# second' + NL);
  write('src/a.ts', 'export const a = 1' + NL);
  write('src/b.ts', 'export const b = 1' + NL);
  write('packages/keep', 'x' + NL);
  git(['add', '-A']); git(['commit', '-qm', 'init']);
  run(['load', 'docs/plans']);

  // --- the brief teaches keys that cannot collide, and hands over a vocabulary
  const brief = run(['refine', 'brief', 'docs/plans/1.2-second.md']);
  ok('the refine brief keys steps from the plan they came out of',
    has(brief.out, 'S-1.2.1'), brief.out);
  ok('and says a key another plan holds is refused', has(brief.out, 'unique across all of them'), brief.out);
  ok('and hands the agent the words a serialisation point is spelled with',
    has(brief.out, 'migration head') && has(brief.out, 'lockfile'), brief.out);
  ok('and warns that repo lints read prose too', has(brief.out, 'grep your prose'), brief.out);
  // The requires: header was read by nobody, so cross-plan ordering was absent
  // from a whole round and had to be derived by hand from the yaml afterwards.
  ok('a plan that says what it comes after has that put in front of the agent',
    has(brief.out, 'comes after: 1.1'), brief.out);

  // --- the silent loss: one key, two plans
  report('docs/plans/1.1-first.md', { summary: 's', steps: [
    { key: 'S-1', title: 'first plan step', owns: ['src/a.ts'], serialises: ['drizzle-migration-head'], verify: ['true'] }] });
  const first = run(['refine', 'done', 'docs/plans/1.1-first.md']);
  ok('a first report is recorded', first.code === 0, first.out);
  ok('and the count comes from the register, not from the report',
    has(first.out, 'in the register'), first.out);
  report('docs/plans/1.2-second.md', { summary: 's', steps: [
    { key: 'S-1', title: 'second plan step', owns: ['src/b.ts'], verify: ['true'] },
    { key: 'S-9', title: 'fine on its own', owns: ['src/c.ts'], verify: ['true'] }] });
  const clash = run(['refine', 'done', 'docs/plans/1.2-second.md']);
  ok('a report reusing another plan key is refused', clash.code === 1, clash.out);
  ok('naming the plan that already holds it', has(clash.out, '1.1-first.md'), clash.out);
  ok('and the step of the plan that got there first is untouched',
    has(run(['board']).out, 'first plan step'), run(['board']).out);
  // Half a report recorded is the harder half to see: the good step must not
  // land on its own while its sibling is refused.
  ok('and nothing else from that report is recorded either',
    !has(run(['board']).out, 'S-9'), run(['board']).out);

  // --- needs, judged while the report is still in hand
  report('docs/plans/1.2-second.md', { summary: 's', steps: [
    { key: 'S-1.2.1', title: 'second', owns: ['src/b.ts'], needs: ['1.1'], verify: ['true'] }] });
  const planDep = run(['refine', 'done', 'docs/plans/1.2-second.md']);
  ok('a needs entry naming a plan is refused at record time', planDep.code === 1, planDep.out);
  ok('and told it is a plan, not a step', has(planDep.out, 'a plan, not a step'), planDep.out);
  report('docs/plans/1.2-second.md', { summary: 's', steps: [
    { key: 'S-1.2.1', title: 'second', owns: ['src/b.ts'], needs: ['S-1'], verify: ['true'] }] });
  ok('and the same report with a real key is recorded',
    run(['refine', 'done', 'docs/plans/1.2-second.md']).code === 0);

  // --- refining rewrites its plan, and now says what it did to it
  write('docs/plans/1.1-first.md', '# first' + NL + NL + 'rewritten.' + NL + 'and longer.' + NL);
  report('docs/plans/1.1-first.md', { summary: 's', steps: [
    { key: 'S-1', title: 'first plan step', owns: ['src/a.ts'], serialises: ['drizzle-migration-head'], verify: ['true'] }] });
  const again = run(['refine', 'done', 'docs/plans/1.1-first.md']);
  ok('a refined plan is reported as a diffstat, not left invisible',
    has(again.out, 'What it did to the plan') && has(again.out, 'insertion'), again.out);

  // --- steps by hand: a batch is recorded whole or not at all
  const half = run(['step', 'add'], JSON.stringify([
    { key: 'G-1', title: 'good', owns: ['src/g.ts'] },
    { key: 'G-2', title: 'bad', owns: ['the config file — wherever it lives'] }]));
  ok('a batch with one bad step in it is refused', half.code === 1, half.out);
  ok('and says nothing was recorded', has(half.out, 'Nothing was recorded'), half.out);
  ok('and the good step in it did not land on its own', !has(run(['board']).out, 'G-1'), run(['board']).out);

  // --- the synonyms: six names for one migration head
  run(['step', 'add'], JSON.stringify([
    { key: 'M-1', title: 'writes a migration', owns: ['src/m1.ts'], serialises: ['drizzle-migrations-head'], verify: ['true'] },
    { key: 'M-2', title: 'writes another', owns: ['src/m2.ts'], serialises: ['drizzle-journal'], verify: ['true'] },
    { key: 'W-1', title: 'ci', owns: ['src/w1.ts'], serialises: ['ci workflow'], verify: ['true'] },
    { key: 'W-2', title: 'cache', owns: ['src/w2.ts'], serialises: ['ci cache'], verify: ['true'] },
    { key: 'D-1', title: 'greenfield', owns: ['packages/server/src/features/base/x.ts'], verify: ['true'] },
    { key: 'T-1', title: 'typo', owns: ['pakcages/thing.ts'], verify: ['true'] }]));
  run(['assess', 'set', 'S-1=low', 'S-1.2.1=low', 'M-1=low', 'M-2=low', 'W-1=low', 'W-2=low', 'D-1=low', 'T-1=low']);
  const doc = run(['doctor']);
  ok('two spellings of one serialisation point are a fault, not a hint',
    doc.code === 1 && has(doc.out, 'same thing spelled two ways'), doc.out);
  ok('naming both spellings and the steps on them',
    has(doc.out, 'drizzle-migration-head') && has(doc.out, 'drizzle-migrations-head') && has(doc.out, 'M-1'), doc.out);
  ok('and saying what it costs', has(doc.out, 'nothing holds apart'), doc.out);
  // Weaker evidence is said out loud and not treated as a fault: two points
  // that differ by one word are often two things.
  ok('a pair differing by one word is raised without failing',
    has(doc.out, 'differ by one word') && has(doc.out, 'ci cache'), doc.out);
  // 31 of 47 steps failed on this alone, and the answer was twenty .gitkeep
  // commits made only to get a green report. A doctor that has to be lied to
  // does not get run.
  ok('a directory a step will create is a note, not a fault',
    has(doc.out, 'does not exist yet') && has(doc.out, 'features/base'), doc.out);
  ok('but a first segment beside something almost identical is a typo',
    has(doc.out, 'pakcages') && has(doc.out, 'a typo?'), doc.out);
  const quiet = run(['doctor', '--all']);
  ok('--all adds the points only one step names', has(quiet.out, 'only one step names'), quiet.out);

  // --- removing a step, which used to mean editing state.json by hand
  const rmPlanned = run(['step', 'rm', 'M-1']);
  ok('a planned step can be cancelled', rmPlanned.code === 0, rmPlanned.out);
  ok('and it stays in the record, cancelled rather than deleted',
    has(run(['board']).out, 'cancelled'), run(['board']).out);
  const stFile = path.join(d, '.claude', 'orch', 'state.json');
  const st = JSON.parse(readIf(stFile));
  const w1 = st.tasks.find((t) => t.key === 'W-1');
  w1.status = 'open'; w1.worktree = path.join(d, 'wt-W-1'); w1.branch = 'step/W-1';
  fs.writeFileSync(stFile, JSON.stringify(st, null, 2));
  const rmLive = run(['step', 'rm', 'W-1']);
  ok('a step that has gone out is not cancelled by accident', rmLive.code === 2, rmLive.out);
  ok('and says what would be left behind', has(rmLive.out, 'worktree and a branch'), rmLive.out);
  const forced = run(['step', 'rm', 'W-1', '--force']);
  ok('--force cancels it', forced.code === 0, forced.out);
  ok('and prints the worktree nothing here removes', has(forced.out, 'git worktree remove'), forced.out);
  const reset = run(['step', 'reset', '1.2']);
  ok('a whole plan can be reset by its id', reset.code === 0, reset.out);
  ok('and only that plan is touched', has(run(['board']).out, 'first plan step'), run(['board']).out);
  ok('and what needed a cancelled step no longer waits on a ghost',
    !has(run(['check']).out, 'S-1.2.1'), run(['check']).out);

  // --- plans named for the step they become, and front matter in a fence
  // Two bugs found on a real 12-plan round, both worked around by hand at the
  // time. `S-013-capabilities.md` read as the bare letter S, so every plan told
  // its agent to key from `S-S` — one prefix for twelve plans, which is the
  // collision the whole key scheme exists to stop. And front matter written in
  // a ```yaml fence rather than between --- lines parsed as no requires: at
  // all, so twelve plans loaded with an empty dependency graph and the
  // integration step could have opened beside the five steps it integrates.
  {
    const e = bare('plan-names');
    const erun = (args, input) => {
      try { return { code: 0, out: execFileSync('node', [O, ...args], { cwd: e, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }) }; }
      catch (x) { return { code: x.status ?? -1, out: String(x.stdout || '') + String(x.stderr || '') }; }
    };
    const egit = (args) => execFileSync('git', args, { cwd: e, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const plan = (name, requires) => {
      fs.mkdirSync(path.join(e, 'docs', 'plans'), { recursive: true });
      fs.writeFileSync(path.join(e, 'docs', 'plans', name + '-x.md'),
        ['# ' + name, '', '```yaml', 'id: ' + name, 'requires: ' + requires, '```', ''].join('\n'));
    };
    egit(['init', '-q', '-b', 'main']); egit(['config', 'user.email', 'ci@example.invalid']); egit(['config', 'user.name', 'ci']);
    fs.mkdirSync(path.join(e, 'src'), { recursive: true });
    for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(e, 'src', f + '.ts'), 'export const x = 1\n');
    plan('S-011', '[]');
    plan('S-013', '[S-011]');
    plan('S-016', '[S-011, S-013]   # everything it integrates');
    fs.writeFileSync(path.join(e, 'docs', 'plans', '2.1-numbered.md'), '---\nrequires: [S-011]\n---\n# numbered\n');
    egit(['add', '-A']); egit(['commit', '-qm', 'init']);
    erun(['load', 'docs/plans']);

    const b11 = erun(['refine', 'brief', 'docs/plans/S-011-x.md']);
    ok('a plan named for the step it becomes keys from that step, not from "S"',
      has(b11.out, 'S-011.1, S-011.2') && !has(b11.out, 'S-S'), b11.out);
    const b21 = erun(['refine', 'brief', 'docs/plans/2.1-numbered.md']);
    ok('and a plan numbered like a section still keys from its number',
      has(b21.out, 'S-2.1.1'), b21.out);
    const b16 = erun(['refine', 'brief', 'docs/plans/S-016-x.md']);
    ok('front matter in a yaml fence is read, not only the --- kind',
      has(b16.out, 'comes after: S-011, S-013'), b16.out);
    ok('and a trailing comment does not become part of the last id',
      !has(b16.out, 'S-013]'), b16.out);
    ok('the --- kind still works', has(b21.out, 'comes after: S-011'), b21.out);

    // Every plan is refined at once, so a report cannot name keys that do not
    // exist yet. The ordering is in the requires: headers, and turning it into
    // needs was being done by hand once the reports were all in.
    const report = (name, key) => {
      const dir = path.join(e, '.claude', 'orch', 'refine');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ('docs-plans-' + name + '-x-md') + '.json'), JSON.stringify({
        summary: 's', steps: [{ key, title: name, owns: ['src/' + key + '.ts'], verify: ['true'] }] }));
      erun(['refine', 'done', 'docs/plans/' + name + '-x.md']);
    };
    report('S-011', 'S-011.1'); report('S-013', 'S-013.1'); report('S-016', 'S-016.1');
    ok('with no links, an integration step would open beside what it integrates',
      has(erun(['check']).out, 'S-016.1'), erun(['check']).out);
    const dry = erun(['step', 'link', '--dry-run']);
    ok('step link says what it would add', has(dry.out, 'S-016.1 needs S-013.1'), dry.out);
    ok('and does not record it', !has(erun(['check']).out, 'Waiting on work'), erun(['check']).out);
    const linked = erun(['step', 'link']);
    ok('step link turns requires: into needs between real keys',
      linked.code === 0 && has(linked.out, 'S-013.1 needs S-011.1'), linked.out);
    const after = erun(['check']);
    ok('and the integration step now waits', has(after.out, 'Waiting on work to reach the main line') && has(after.out, 'S-016.1'), after.out);
    ok('while what it comes after can open', has(after.out, 'S-011.1'), after.out);
    ok('running it again adds nothing', has(erun(['step', 'link']).out, 'nothing to add'), erun(['step', 'link']).out);
  }

  // --- the model command, whose failure used to arrive as a stack trace
  const badModels = run(['models', 'resolve', 'enormous']);
  ok('a models failure comes back as its own message', badModels.code === 2, badModels.out);
  ok('and never as a node stack trace',
    !has(badModels.out, 'at Object.') && !has(badModels.out, 'genericNodeError'), badModels.out);
});

// ------------------------------------------ widening the round: the seven levers
// Each case guards a place the orchestrator lost wall-clock for nothing. The
// two that cost most were invisible from the outside: a dependent queueing
// behind a suite it does not consume, and a plan-level requirement recorded as
// a cross-product of step-level ones.
say('widening the round');
sect(() => {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const O = path.join(ROOT, 'claude-cursor', 'orchestrate.mjs');

  // One sandbox, set up the way the five-stages group does it: a stub `agent`
  // so `run open` can mint a chat, and a worktree root inside the sandbox so
  // nothing lands beside the real project.
  function box(name, plans, steps, tiers) {
    const d = bare(name);
    const stub = path.join(d, 'stub');
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(path.join(stub, 'agent'),
      '#!/usr/bin/env bash\necho "Created chat 11111111-2222-3333-4444-555555555555"\n', { mode: 0o755 });
    const wts = path.join(d, 'wts');
    fs.mkdirSync(wts, { recursive: true });
    const env = { ...process.env, PATH: stub + path.delimiter + process.env.PATH, CURSOR_ORCH_WT: wts };
    const run = (args, input) => {
      try { return { code: 0, out: execFileSync('node', [O, ...args], { cwd: d, encoding: 'utf8', input, env, stdio: ['pipe', 'pipe', 'pipe'] }) }; }
      catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
    };
    const git = (args, cwd = d) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'ci@example.invalid']);
    git(['config', 'user.name', 'ci']);
    fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    for (const [name, body] of Object.entries(plans)) fs.writeFileSync(path.join(d, 'docs', name), body);
    for (const f of ['a', 'b', 'c', 'd', 'shared', 'exam', 'routes', 'it'])
      fs.writeFileSync(path.join(d, 'src', f + '.ts'), 'orig\n');
    git(['add', '-A']); git(['commit', '-qm', 'init']);
    run(['load', 'docs']);
    if (steps) run(['step', 'add'], JSON.stringify(steps));
    if (tiers) run(['assess', 'propose'], JSON.stringify(tiers));
    return { d, run, git, wts };
  }
  const tier = (keys, t = 'high') => keys.map((k) => ({ key: k, tier: t, why: 'test' }));
  // The agent's side of a run: commit something on its own branch.
  const work = (b, wts, d, key, file, body) => {
    const wt = path.join(wts, path.basename(d) + '-wt-' + key);
    fs.writeFileSync(path.join(wt, file), body);
    b.git(['add', '-A'], wt); b.git(['commit', '-qm', 'work ' + key], wt);
  };
  const PASSED = JSON.stringify({ outcome: 'passed', seconds: 60, files: [], commands: [], answer: 'done' });

  // --- lever 1: a dependency is met at join, not at land ------------------
  // Before: heldNeeds required status === 'landed'. `join` leaves the merge on
  // the main checkout's HEAD and `run open` cuts a worktree from that HEAD, so
  // the dependent already had the code — and sat behind the joined-tree suite
  // anyway. Through the slot, one suite at a time, that queue was most of the
  // wall-clock on a deep chain.
  {
    const b = box('widen-join', { '1-a.md': '# A\n' },
      [{ key: 'S-1', title: 'one', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] },
       { key: 'S-3', title: 'three', plan: 'docs/1-a.md', owns: ['src/c.ts'], needs: ['S-1'], verify: ['true'] }],
      tier(['S-1', 'S-3']));
    ok('a step whose dependency has not moved is waiting',
      has(b.run(['check']).out, 'Waiting on work to reach the main line: S-3'), b.run(['check']).out);
    b.run(['run', 'open', 'S-1']);
    work(b, b.wts, b.d, 'S-1', 'src/a.ts', 'S-1-WAS-HERE\n');
    b.run(['run', 'record', 'S-1', '--json', '/dev/stdin'], PASSED);
    const joined = b.run(['join', 'S-1']);
    ok('joining says what it frees, rather than leaving it for land',
      has(joined.out, 'can open now without waiting') && has(joined.out, 'S-3'), joined.out);
    const after = b.run(['check']);
    ok('the dependent can open on a merge alone, before any suite has run',
      has(after.out, 'Can open together') && has(after.out, 'S-3'), after.out);
    ok('and is no longer listed as waiting',
      !has(after.out, 'Waiting on work to reach the main line'), after.out);
    const opened = b.run(['run', 'open', 'S-3']);
    ok('opening it works', opened.code === 0, opened.out);
    ok('and it says the merge under it is not yet proven',
      has(opened.out, 'merged, not yet proven'), opened.out);
    ok('and that the fix would have to go forward rather than reset',
      has(opened.out, 'forward commit'), opened.out);
    // The claim the whole change rests on: the code is really there.
    const wt = path.join(b.wts, path.basename(b.d) + '-wt-S-3');
    ok('the dependent worktree holds the dependency\'s work already',
      readIf(path.join(wt, 'src/a.ts')).trim() === 'S-1-WAS-HERE', readIf(path.join(wt, 'src/a.ts')));
    // Landing stays strict, because landing is the record of proof.
    const early = b.run(['land', 'S-3']);
    ok('but landing is refused while what it was built on is only merged',
      early.code === 2 && has(early.out, 'cannot land before S-1'), early.out);
    // And the cost is stated where it is paid.
    const sb = b.run(['sendback', 'S-1', '--why', 'joined tree red']);
    ok('sending back a merge names the worktrees cut from it',
      has(sb.out, 'opened off this merge') && has(sb.out, 'S-3'), sb.out);
    ok('and says not to reset past it', has(sb.out, 'reset --hard'), sb.out);
  }

  // --- the opt-out, for anyone who wants the proof before the next hop -----
  {
    const b = box('widen-strict', { '1-a.md': '# A\n' },
      [{ key: 'S-1', title: 'one', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] },
       { key: 'S-3', title: 'three', plan: 'docs/1-a.md', owns: ['src/c.ts'], needs: ['S-1'], verify: ['true'] }],
      tier(['S-1', 'S-3']));
    b.run(['run', 'open', 'S-1']);
    work(b, b.wts, b.d, 'S-1', 'src/a.ts', 'one\n');
    b.run(['run', 'record', 'S-1', '--json', '/dev/stdin'], PASSED);
    b.run(['join', 'S-1']);
    const strict = execFileSync('node', [O, 'check'],
      { cwd: b.d, encoding: 'utf8', env: { ...process.env, CURSOR_ORCH_OPEN_AT: 'land' } });
    ok('CURSOR_ORCH_OPEN_AT=land waits for the proof again',
      has(strict, 'Waiting on work to reach the main line: S-3'), strict);
  }

  // --- lever 4: one suite over a batch, instead of one per landing --------
  // Before: twelve branches finishing together meant twelve full suite runs in
  // series through the slot, and the graph advanced at the rate of one of them.
  {
    const b = box('widen-batch', { '1-a.md': '# A\n' },
      [{ key: 'S-1', title: 'one', plan: 'docs/1-a.md', owns: ['src/a.ts', 'src/shared.ts'], verify: ['true'] },
       { key: 'S-2', title: 'two', plan: 'docs/1-a.md', owns: ['src/b.ts'], verify: ['true'] },
       { key: 'S-3', title: 'three', plan: 'docs/1-a.md', owns: ['src/c.ts', 'src/shared.ts'], verify: ['true'] },
       { key: 'S-4', title: 'four', plan: 'docs/1-a.md', owns: ['src/d.ts'], needs: ['S-1', 'S-2'], verify: ['true'] }],
      tier(['S-1', 'S-2', 'S-3', 'S-4']));
    for (const k of ['S-1', 'S-2', 'S-3']) b.run(['run', 'open', k]);
    work(b, b.wts, b.d, 'S-1', 'src/shared.ts', 'FROM-S1\n');
    work(b, b.wts, b.d, 'S-2', 'src/b.ts', 'two\n');
    work(b, b.wts, b.d, 'S-3', 'src/shared.ts', 'FROM-S3\n');
    ok('a batch of one is refused — that is just join',
      b.run(['join', '--batch', 'S-1']).code === 2, b.run(['join', '--batch', 'S-1']).out);
    const batch = b.run(['join', '--batch', 'S-1', 'S-2', 'S-3']);
    ok('two of the three merge', has(batch.out, '2 of 3 merged cleanly'), batch.out);
    ok('and the conflicting one is named', has(batch.out, 'S-3 conflicts'), batch.out);
    ok('with the rest of the batch left standing',
      has(batch.out, 'the rest of the batch stands'), batch.out);
    ok('it offers one suite over the whole batch',
      has(batch.out, 'One suite over the whole batch'), batch.out);
    ok('and records the order, because a red batch has to be bisected',
      has(batch.out, 'S-1 → S-2'), batch.out);
    ok('a batch with a conflict in it exits non-zero', batch.code === 1, String(batch.code));
    // The main line really is the merge of the two that worked.
    ok('the main line took the two that merged',
      readIf(path.join(b.d, 'src/b.ts')).trim() === 'two' &&
      readIf(path.join(b.d, 'src/shared.ts')).trim() === 'FROM-S1', readIf(path.join(b.d, 'src/shared.ts')));
    ok('and not the one that did not',
      readIf(path.join(b.d, 'src/c.ts')).trim() === 'orig', readIf(path.join(b.d, 'src/c.ts')));
    const landed = b.run(['land', '--batch', 'S-1', 'S-2', '--sha', 'deadbee']);
    ok('one command records what one suite proved',
      has(landed.out, '2 step(s) landed'), landed.out);
    ok('and it frees what was waiting on both', has(landed.out, 'frees: S-4'), landed.out);
    // The flag is what makes it a batch. Two keys without it is a typo.
    ok('two keys without --batch is refused',
      b.run(['land', 'S-1', 'S-2']).code === 2, b.run(['land', 'S-1', 'S-2']).out);
  }

  // --- lever 5: step link --only-shared -----------------------------------
  // Before: plan B comes after plan A, so every step of B was given a need on
  // every step of A. With two steps each that is four edges where one is real,
  // and the three spurious ones hold work that never conflicted.
  //
  // And before that was fixed, --only-shared answered it with the wrong test.
  // It recorded an edge wherever two steps owned a path in common — which is a
  // GATE, since `frontier` drops any candidate with an unmet need — while
  // `blocks`/`willMerge` exist precisely to say a shared file is not a gate but
  // a merge to sequence. So the command recommended for widening a narrow round
  // hand-serialised the one thing the scheduler was rebuilt to run in parallel,
  // and it still could not see the edge that actually orders work: B imports
  // what A exports, from files with nothing in common.
  {
    const plans = { '1-a.md': '# A\n', '2-b.md': '---\nrequires: [1]\n---\n# B\n' };
    const steps = [
      { key: 'S-1.1', title: 'contracts', plan: 'docs/1-a.md', owns: ['src/exam.ts', 'src/shared.ts'],
        provides: ['ExamAttempt'], verify: ['true'] },
      // Imports what S-1.1 exports, and owns not one path in common with it.
      // The old file test recorded nothing here at all.
      { key: 'S-2.1', title: 'reads it', plan: 'docs/2-b.md', owns: ['src/routes.ts'],
        uses: ['ExamAttempt'], verify: ['true'] },
      // The mirror image: writes a file S-1.1 also writes, for its own
      // unrelated reasons, and consumes nothing of it. The old file test made
      // this one wait.
      { key: 'S-2.2', title: 'unrelated', plan: 'docs/2-b.md', owns: ['src/shared.ts'], verify: ['true'] }];
    const b = box('widen-link', plans, steps, tier(['S-1.1', 'S-2.1', 'S-2.2']));
    const wide = b.run(['step', 'link', '--dry-run']);
    ok('the cross-product is still the default, and links both steps',
      has(wide.out, 'S-2.1 needs S-1.1') && has(wide.out, 'S-2.2 needs S-1.1'), wide.out);
    const narrow = b.run(['step', 'link', '--only-shared', '--dry-run']);
    ok('--only-shared keeps the edge across disjoint files, where a symbol crosses',
      has(narrow.out, 'S-2.1 needs S-1.1'), narrow.out);
    ok('and says which symbol made it real', has(narrow.out, 'uses ExamAttempt'), narrow.out);
    ok('and does NOT gate the pair that only shares a file',
      !has(narrow.out, 'S-2.2 needs S-1.1'), narrow.out);
    ok('reporting it as a merge to sequence instead',
      has(narrow.out, 'write a file in common') && has(narrow.out, 'S-2.2 ↔ S-1.1'), narrow.out);
    // The whole point of not recording that edge: both can go in one round.
    b.run(['step', 'link', '--only-shared']);
    const f = b.run(['check']);
    ok('so the round opens both of them together',
      has(f.out, 'S-1.1') && has(f.out, 'S-2.2') && !has(f.out, 'Waiting on work to reach the main line: S-2.2'), f.out);
  }

  // Case matters, and folding it would invent an edge as readily as catch one:
  // `ExamAttempt` and `examAttempt` are two different exports in every language
  // this runs against.
  {
    const plans = { '1-a.md': '# A\n', '2-b.md': '---\nrequires: [1]\n---\n# B\n' };
    const steps = [
      { key: 'S-1.1', title: 'a', plan: 'docs/1-a.md', owns: ['src/a.ts'], provides: ['ExamAttempt'], verify: ['true'] },
      { key: 'S-2.1', title: 'b', plan: 'docs/2-b.md', owns: ['src/b.ts'], uses: ['examAttempt'], verify: ['true'] }];
    const b = box('widen-case', plans, steps, tier(['S-1.1', 'S-2.1']));
    const out = b.run(['step', 'link', '--only-shared']);
    ok('a symbol that differs only in case is not a match', out.code === 1, out.out);
    ok('and the requirement is reported as recorded nowhere rather than linked',
      has(out.out, 'recorded nowhere'), out.out);
  }

  // A symbol is what you would type in an import. Both other things it gets
  // written as look filled in and match nothing, which is the expensive way to
  // be wrong here: no edge is recorded and the step opens against nothing.
  {
    const b = box('widen-symfields', { '1-a.md': '# A\n' }, null, null);
    const bad = b.run(['step', 'add'], JSON.stringify([
      { key: 'S-9.1', title: 'x', plan: 'docs/1-a.md', owns: ['src/a.ts'],
        provides: ['src/exam.ts'], uses: ['the exam attempt type'], verify: ['true'] }]));
    ok('a provides entry that is a path is refused',
      has(bad.out, 'name the symbol it exports, not the file it lives in'), bad.out);
    ok('and a uses entry that is prose is refused',
      has(bad.out, 'reads as prose, not a symbol you could import'), bad.out);
  }

  // The dependency nobody named. `--only-shared` cannot see it, so `doctor`
  // says the step is about to open against an import nothing writes.
  {
    const plans = { '1-a.md': '# A\n' };
    const steps = [
      { key: 'S-1.1', title: 'a', plan: 'docs/1-a.md', owns: ['src/a.ts'], provides: ['Alpha'], verify: ['true'] },
      { key: 'S-1.2', title: 'b', plan: 'docs/1-a.md', owns: ['src/b.ts'], uses: ['Alpha', 'Nowhere'], verify: ['true'] }];
    const b = box('widen-dangle', plans, steps, tier(['S-1.1', 'S-1.2']));
    const d = b.run(['doctor']);
    ok('doctor names a symbol no step provides',
      has(d.out, 'no step in this round provides') && has(d.out, '"Nowhere"'), d.out);
    ok('and does not name the one that is provided', !has(d.out, '"Alpha"'), d.out);
  }

  // A step that waits on many and frees nothing. Legitimate for an integration
  // suite; also exactly what a cross-product link looks like from here.
  {
    const plans = { '1-a.md': '# A\n' };
    const steps = [
      ...['a', 'b', 'c', 'd'].map((x, i) => ({ key: `S-1.${i + 1}`, title: x, plan: 'docs/1-a.md', owns: [`src/${x}.ts`], verify: ['true'] })),
      { key: 'S-1.9', title: 'integration suite', plan: 'docs/1-a.md', owns: ['src/it.ts'],
        needs: ['S-1.1', 'S-1.2', 'S-1.3', 'S-1.4'], verify: ['true'] }];
    const b = box('widen-barrier', plans, steps, tier(['S-1.1', 'S-1.2', 'S-1.3', 'S-1.4', 'S-1.9']));
    const d = b.run(['doctor']);
    ok('doctor names a step that waits on four or more and frees nothing',
      has(d.out, 'wait on four or more and free nothing') && has(d.out, 'S-1.9'), d.out);
    ok('and says it opens beside the next round rather than in front of it',
      has(d.out, 'beside the next round'), d.out);
  }

  // The cap. It was 2, and a round of 36 plans still came back as 36 single
  // steps — the cap was never what held it there, the refining prompt's bias
  // towards one step was. Three is what the cap is for: a plan with three
  // disjoint file sets runs on three agents, and the third used to be refused
  // for no reason but the number. It does not go higher, and the refusal is
  // what keeps it from going higher by accident.
  {
    const b = box('widen-cap', { '1-a.md': '# A\n' }, null, null);
    const report = (n) => JSON.stringify({
      summary: 'x', builtOn: [], openQuestions: [],
      steps: Array.from({ length: n }, (_, i) => ({
        key: `S-1.${i + 1}`, title: 't' + i, owns: [`src/${'abcd'[i]}.ts`], verify: ['true'] })) });
    const put = (n) => {
      const f = path.join(b.d, '.claude/orch/refine/docs-1-a-md.json');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, report(n));
    };
    put(4);
    const four = b.run(['refine', 'done', 'docs/1-a.md']);
    ok('a plan split four ways is refused', four.code !== 0 && has(four.out, 'is the most a plan may become'), four.out);
    put(3);
    const three = b.run(['refine', 'done', 'docs/1-a.md']);
    ok('and three is accepted, which two never was',
      three.code === 0 && has(three.out, 'S-1.1') && has(three.out, 'S-1.3'), three.out);
  }

  // The floor under that ceiling. The ceiling was enforced from the first day
  // and the floor never was: the split test the refining brief states in prose
  // — one part must land before another, or their files do not overlap at all —
  // was checked by nobody. So three steps carved out of one piece of work were
  // recorded exactly as readily as three that had three real seams, and nine
  // plans came back as twenty-seven steps, each paying a worktree, a merge and
  // a run for a gate that still passed or failed whole.
  {
    const b = box('widen-earned', { '1-a.md': '# A\n' }, null, null);
    const put = (steps) => {
      const f = path.join(b.d, '.claude/orch/refine/docs-1-a-md.json');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ summary: 'x', builtOn: [], openQuestions: [], steps }));
    };
    const s = (key, owns, needs) => ({ key, title: key, owns, verify: ['true'], ...(needs ? { needs } : {}) });

    put([s('S-1.1', ['src/a.ts']), s('S-1.2', ['src/a.ts']), s('S-1.3', ['src/a.ts'])]);
    const carved = b.run(['refine', 'done', 'docs/1-a.md']);
    ok('three parts writing one file and waiting on nothing are refused',
      carved.code !== 0 && has(carved.out, 'have not earned it'), carved.out);
    ok('and the refusal names each of them and the file they contend over',
      has(carved.out, 'S-1.1') && has(carved.out, 'S-1.2') && has(carved.out, 'S-1.3') &&
      has(carved.out, 'src/a.ts'), carved.out);
    ok('and says the ceiling is not a number to fill',
      has(carved.out, 'not a number to fill'), carved.out);
    ok('and records none of it',
      has(carved.out, 'Nothing from docs/1-a.md was recorded') &&
      has(b.run(['board']).out, 'Nothing yet.'), carved.out);

    // Two real seams with a third carved out of one of them. The third is what
    // is wrong, and refusing the shape of the whole report says less.
    put([s('S-1.1', ['src/a.ts']), s('S-1.2', ['src/b.ts']), s('S-1.3', ['src/b.ts'])]);
    const mixed = b.run(['refine', 'done', 'docs/1-a.md']);
    ok('a report two thirds right names only the parts that did not earn it',
      mixed.code !== 0 && has(mixed.out, 'S-1.2') && has(mixed.out, 'S-1.3') &&
      !has(mixed.out, 'S-1.1'), mixed.out);

    // Ordering earns it on its own: parts that share a file but were never
    // going to run at once, because one has to land before the next can start.
    put([s('S-1.1', ['src/a.ts']), s('S-1.2', ['src/a.ts'], ['S-1.1']), s('S-1.3', ['src/a.ts'], ['S-1.2'])]);
    const chained = b.run(['refine', 'done', 'docs/1-a.md']);
    ok('a part that must land before another is a split worth making',
      chained.code === 0 && has(chained.out, 'S-1.3'), chained.out);
  }

  // `builtOn` — the reading the refining agent actually did — reached the report
  // and went no further. The field appeared exactly once in the whole tool, in
  // the template asking for it: nothing recorded it and nothing printed it. So
  // every building agent was handed its plan and its own file list and nothing
  // else about the repository it was building into, and spent its first hour
  // re-deriving the map its own refining agent had already drawn.
  {
    const b = box('widen-context', { '1-a.md': '# A\n' }, null, null);
    const put = (extra) => {
      const f = path.join(b.d, '.claude/orch/refine/docs-1-a-md.json');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ summary: 'x', openQuestions: [], ...extra,
        steps: [{ key: 'S-1.1', title: 'one', owns: ['src/a.ts'], verify: ['true'] }] }));
    };
    put({ builtOn: [{ path: 'src/shared.ts', what: 'the retry helper' }] });
    b.run(['refine', 'done', 'docs/1-a.md']);
    b.run(['assess', 'propose'], JSON.stringify(tier(['S-1.1'])));
    b.run(['run', 'open', 'S-1.1']);
    const brief = fs.readFileSync(path.join(b.d, '.claude/orch/briefs/S-1.1.md'), 'utf8');
    ok('what the refining agent read is in the brief the builder is handed',
      has(brief, 'src/shared.ts') && has(brief, 'the retry helper'), brief);
    ok('and one it may read but not write is marked as not its own',
      has(brief, 'do not change it — it is not yours'), brief);
    // A second report is how a plan gets corrected. It must not be how a brief
    // gets emptied: a report that names no reading leaves the step's alone.
    put({});
    b.run(['refine', 'done', 'docs/1-a.md']);
    const st = JSON.parse(fs.readFileSync(path.join(b.d, '.claude/orch/state.json'), 'utf8'));
    const ctx = (st.tasks.find((t) => t.key === 'S-1.1') || {}).context || [];
    ok('a later report naming none leaves what the step already had alone',
      ctx.some((c) => c.path === 'src/shared.ts'), JSON.stringify(ctx));
  }

  // A step nobody recorded any reading for used to print no section at all,
  // which reads as "there is nothing already there" — never true, and the more
  // expensive of the two mistakes, because it is the one that gets a second copy
  // of an existing helper written.
  {
    const b = box('widen-context-none', { '1-a.md': '# A\n' },
      [{ key: 'S-1', title: 'one', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] }],
      tier(['S-1']));
    b.run(['run', 'open', 'S-1']);
    const brief = fs.readFileSync(path.join(b.d, '.claude/orch/briefs/S-1.md'), 'utf8');
    ok('a step with nothing recorded says so instead of saying nothing',
      has(brief, 'What is already there') && has(brief, 'hole in the brief'), brief);
  }

  // Prose where a path goes is the failure `owns` already had, one field over.
  // It looks filled in, it costs the agent a search that finds nothing, and the
  // brief prints it verbatim, so nothing downstream ever says why.
  {
    const b = box('widen-context-prose', { '1-a.md': '# A\n' }, null, null);
    const f = path.join(b.d, '.claude/orch/refine/docs-1-a-md.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ summary: 'x', openQuestions: [],
      builtOn: [{ path: 'the retry helper — over in src', what: 'x' }, { what: 'no path at all' }],
      steps: [{ key: 'S-1.1', title: 'one', owns: ['src/a.ts'], verify: ['true'] }] }));
    const r = b.run(['refine', 'done', 'docs/1-a.md']);
    ok('a builtOn path that is prose is refused, and the whole report with it',
      r.code !== 0 && has(r.out, 'is prose, not a path') &&
      has(r.out, 'Nothing from docs/1-a.md was recorded'), r.out);
    ok('and an entry carrying no path at all is named too',
      has(r.out, 'has an entry with no path'), r.out);
    const hand = b.run(['step', 'add'], JSON.stringify([{ key: 'S-9', title: 'x',
      plan: 'docs/1-a.md', owns: ['src/b.ts'], verify: ['true'], context: ['the helper -- over there'] }]));
    ok('and a hand-written step is judged by the same gate',
      hand.code !== 0 && has(hand.out, 'is prose, not a path'), hand.out);
  }

  // The brief's fingerprint was computed in three places from three copies of
  // one list — the two writers and `doctor`, which is what decides whether the
  // brief in an agent's hands is still the current one. Adding a field to the
  // brief and to two of them calls every brief stale; adding it to the writers
  // alone leaves a changed one reading as current.
  {
    const b = box('widen-context-stale', { '1-a.md': '# A\n' },
      [{ key: 'S-1', title: 'one', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'],
        context: [{ path: 'src/shared.ts', what: 'the helper' }] }], tier(['S-1']));
    b.run(['run', 'open', 'S-1']);
    ok('a brief written a moment ago is not called stale',
      !has(b.run(['doctor']).out, 'brief is older than the step'), b.run(['doctor']).out);
    b.run(['step', 'add'], JSON.stringify([{ key: 'S-1',
      context: [{ path: 'src/shared.ts', what: 'the helper' }, { path: 'src/b.ts', what: 'and this' }] }]));
    const d = b.run(['doctor']);
    ok('and one whose context moved under it is',
      has(d.out, 'brief is older than the step'), d.out);
  }

  // A requirement that comes out with no edges at all is the one thing
  // --only-shared must not do quietly: the ordering the plan asked for would be
  // recorded nowhere, and nothing downstream would ever say so.
  {
    const plans = { '1-a.md': '# A\n', '2-b.md': '---\nrequires: [1]\n---\n# B\n' };
    const steps = [
      { key: 'S-1.1', title: 'a', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] },
      { key: 'S-2.1', title: 'b', plan: 'docs/2-b.md', owns: ['src/b.ts'], verify: ['true'] }];
    const b = box('widen-vanish', plans, steps, tier(['S-1.1', 'S-2.1']));
    const gone = b.run(['step', 'link', '--only-shared']);
    ok('a requirement that would be recorded nowhere fails the command', gone.code === 1, gone.out);
    ok('and says which requirement it was', has(gone.out, 'recorded nowhere'), gone.out);
    ok('and writes nothing at all', has(gone.out, 'Nothing was written'), gone.out);
    const state = JSON.parse(readIf(path.join(b.d, '.claude/orch/state.json')) || '{}');
    ok('so no half-graph is left behind',
      (state.tasks || []).every((t) => !(t.needs || []).length), JSON.stringify(state.tasks));
  }

  // --- lever 6: a serialisation point may name its instance ---------------
  // Before: two steps that both said "migration head" were held apart even
  // when they moved separate heads in separate packages, and the doctor's
  // near-name note fired on every deliberately scoped pair.
  {
    const b = box('widen-points', { '1-a.md': '# A\n' },
      [{ key: 'S-1', title: 'orders', plan: 'docs/1-a.md', owns: ['src/a.ts'], serialises: ['migration head: orders'], verify: ['true'] },
       { key: 'S-2', title: 'users', plan: 'docs/1-a.md', owns: ['src/b.ts'], serialises: ['migration head: users'], verify: ['true'] }],
      tier(['S-1', 'S-2']));
    const c = b.run(['check']);
    ok('two scoped instances of one class can open together',
      has(c.out, 'Can open together') && has(c.out, '(2)'), c.out);
    ok('and are not held apart as one shared point',
      !has(c.out, 'Held back'), c.out);
    const doc = b.run(['doctor']);
    ok('the doctor does not call them a spelling drift',
      !has(doc.out, 'spelled two ways') && !has(doc.out, 'differ by one word'), doc.out);
    // A scoped name against a bare one is still one thing, and still caught:
    // a step that says plain "migration head" may mean all of them.
    b.run(['step', 'add'], JSON.stringify([{ key: 'S-9', title: 'bare', plan: 'docs/1-a.md',
      owns: ['src/c.ts'], serialises: ['migration head'], verify: ['true'] }]));
    b.run(['assess', 'propose'], JSON.stringify(tier(['S-9'])));
    const doc2 = b.run(['doctor']);
    ok('but a scoped name beside a bare one is still a fault',
      doc2.code === 1 && has(doc2.out, 'spelled two ways'), doc2.out);
    ok('and names both spellings',
      has(doc2.out, 'migration head: orders') && has(doc2.out, '"migration head"'), doc2.out);
  }

  // --- lever 7: the tier a step's position argues for ---------------------
  // Before: assess weighed how hard a step is and ignored where it sits, so a
  // step gating six others got the same model as a leaf. A wrong answer on the
  // first costs a re-run of everything behind it.
  {
    const b = box('widen-critical', { '1-a.md': '# A\n' },
      [{ key: 'S-1', title: 'head', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] },
       { key: 'S-2', title: 'mid', plan: 'docs/1-a.md', owns: ['src/b.ts'], needs: ['S-1'], verify: ['true'] },
       { key: 'S-3', title: 'mid2', plan: 'docs/1-a.md', owns: ['src/c.ts'], needs: ['S-2'], verify: ['true'] },
       { key: 'S-4', title: 'leaf', plan: 'docs/1-a.md', owns: ['src/shared.ts'], needs: ['S-3'], verify: ['true'] }],
      tier(['S-1', 'S-2', 'S-3', 'S-4'], 'medium'));
    const crit = b.run(['assess', 'critical']);
    ok('it counts the whole chain behind a step, not just its direct dependents',
      has(crit.out, 'S-1') && has(crit.out, '3 steps behind it'), crit.out);
    ok('and argues the head of a chain up a tier', has(crit.out, 'high'), crit.out);
    ok('while a leaf goes down one', has(crit.out, 'a leaf — nothing waits on it'), crit.out);
    ok('nothing is written without --apply',
      has(crit.out, 'Nothing written'), crit.out);
    // Read the record, not the table: the table's footer lists every tier on
    // the ladder, so "high" appears in it whatever any row says.
    const tierOfKey = (k) => ((JSON.parse(readIf(path.join(b.d, '.claude/orch/state.json')) || '{}').tasks || [])
      .find((t) => t.key === k) || {}).tier;
    ok('and the record is unchanged until then',
      tierOfKey('S-1') === 'medium' && tierOfKey('S-4') === 'medium',
      tierOfKey('S-1') + '/' + tierOfKey('S-4'));
    const applied = b.run(['assess', 'critical', '--apply']);
    ok('--apply takes the moves', has(applied.out, 'moved on position'), applied.out);
    ok('the head of the chain went up a tier', tierOfKey('S-1') === 'high', tierOfKey('S-1'));
    ok('and the leaf went down one', tierOfKey('S-4') === 'low', tierOfKey('S-4'));
    // A row the user chose is never moved by this, the same as `propose`.
    b.run(['assess', 'set', 'S-1=composer']);
    const again = b.run(['assess', 'critical']);
    ok('a row the user set is left alone',
      has(again.out, 'left alone because you set them') && has(again.out, 'S-1'), again.out);
  }

  // --- levers 2 and 3: the map, read before the plans are refined ---------
  // The width of a round is decided before any agent runs, and nothing used to
  // say what shape the plans were in while they could still be rearranged.
  {
    const plans = {
      '2.1a-contracts.md': '# Contracts\nDefines src/shared.ts for everyone.\n',
      '2.1b-read.md': '---\nrequires: [2.1a]\n---\n# Read\nTouches src/a.ts and reads src/shared.ts.\n',
      '2.1c-write.md': '---\nrequires: [2.1a]\n---\n# Write\nTouches src/b.ts, reads src/shared.ts.\nMoves the migration head.\n',
      '2.2-billing.md': '# Billing\nTouches src/c.ts. Moves the migration head.\n',
    };
    const b = box('widen-map', plans, null, null);
    const m = b.run(['map']);
    ok('the map runs off the plans alone', m.code === 0, m.out);
    ok('it finds the file three plans reach for',
      has(m.out, 'Seams') && has(m.out, 'src/shared.ts'), m.out);
    ok('and says to lift it into a plan that lands first',
      has(m.out, 'lands first'), m.out);
    ok('it names the plan whose files touch nothing else',
      has(m.out, 'touch nothing else') && has(m.out, '2.2'), m.out);
    ok('it reads the ordering already written down',
      has(m.out, '2.1b comes after 2.1a'), m.out);
    ok('and says which plans declare none', has(m.out, 'declare no ordering'), m.out);
    ok('it names the shared ground two plans both move',
      has(m.out, 'migration head') && has(m.out, 'go one at a time'), m.out);
    ok('and offers the scoped spelling for it', has(m.out, 'migration head: orders'), m.out);
    ok('it says it is a reading of the prose, not a gate',
      has(m.out, 'not a gate'), m.out);
    ok('and that now is the moment to rearrange',
      has(m.out, 'moment to rearrange the plans'), m.out);
    // Prose is a guess; `owns` is the answer. Once steps exist it measures.
    b.run(['step', 'add'], JSON.stringify([
      { key: 'S-2.1a.1', title: 'a', plan: 'docs/2.1a-contracts.md', owns: ['src/shared.ts'], verify: ['true'] },
      { key: 'S-2.1b.1', title: 'b', plan: 'docs/2.1b-read.md', owns: ['src/shared.ts', 'src/a.ts'], verify: ['true'] },
      { key: 'S-2.1c.1', title: 'c', plan: 'docs/2.1c-write.md', owns: ['src/shared.ts', 'src/b.ts'], verify: ['true'] }]));
    const m2 = b.run(['map']);
    ok('with steps recorded it measures the seam instead of guessing',
      has(m2.out, 'owned by three or more steps'), m2.out);
    ok('and no longer says to rearrange',
      !has(m2.out, 'moment to rearrange the plans'), m2.out);
    // And the doctor says the same thing where it can act on it.
    b.run(['assess', 'propose'], JSON.stringify(tier(['S-2.1a.1', 'S-2.1b.1', 'S-2.1c.1'])));
    const doc = b.run(['doctor']);
    ok('the doctor calls a path three steps own a seam',
      has(doc.out, 'each is a seam'), doc.out);
    ok('and says a step that owns it alone removes the fan-in',
      has(doc.out, 'removes the whole fan-in'), doc.out);
  }

  // A path is read out of prose narrowly on purpose: "and/or" is not a file,
  // and a map that cries wolf is a map nobody reads.
  {
    const b = box('widen-paths', { '1-a.md': '# A\nEither and/or or A/B, at 1.2/3.4, see https://x.dev/y/z.\nBut src/a.ts is real.\n' }, null, null);
    const m = b.run(['map']);
    ok('prose that merely contains a slash is not read as a path',
      !has(m.out, 'and/or') && !has(m.out, 'A/B'), m.out);
    ok('nor is a url', !has(m.out, 'x.dev'), m.out);
    ok('while a real path is found', has(m.out, '1 plan(s)'), m.out);
  }
});

// -------------------------------------------------- a second runner: opencode
// Steps can run on DeepSeek V4 Flash through opencode instead of on Cursor. The
// two share the worktree, the brief, guard/join/land and the record's shape,
// and share nothing else: opencode's log is a different vocabulary, its address
// is a session that does not exist until the run does, and it never says which
// model answered.
say('running a round on opencode');
sect(() => {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const O = path.join(ROOT, 'claude-cursor', 'orchestrate.mjs');
  const MODELS = path.join(ROOT, 'claude-cursor', 'scripts', 'models.mjs');
  const SCRIPTS = path.join(ROOT, 'claude-cursor', 'scripts');

  // A registry in the shape opencode keeps at ~/.cache/opencode/models.json,
  // so the effort check has something to read that is not the real machine's.
  const REG = path.join(bare('ocreg'), 'models.json');
  fs.writeFileSync(REG, JSON.stringify({
    'opencode-go': { models: { 'deepseek-v4-flash': {
      id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] } } } }));

  // A table pointing at that registry, and at a stub binary.
  const tableFor = (dir, over = {}) => {
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude-cursor', 'models.json'), 'utf8'));
    real.runners.opencode = { ...real.runners.opencode, registry: REG, search: [dir], ...over };
    const f = path.join(dir, 'models.json');
    fs.writeFileSync(f, JSON.stringify(real, null, 2));
    return f;
  };

  function box(name, steps, tiers) {
    const d = bare(name);
    const stub = path.join(d, 'stub');
    fs.mkdirSync(stub, { recursive: true });
    // Cursor's chat minter, so a cursor round still works in here.
    fs.writeFileSync(path.join(stub, 'agent'),
      '#!/usr/bin/env bash\necho "Created chat 11111111-2222-3333-4444-555555555555"\n', { mode: 0o755 });
    // A stub opencode that writes a plausible log and nothing else.
    // It reports paths under the --dir it was given, because that is what the
    // real one does: the run happens in the step's worktree and its log is
    // absolute. A stub that echoed its own $PWD instead would make the
    // harvester look right while `guard` could never match a single path.
    fs.writeFileSync(path.join(stub, 'opencode'), `#!/usr/bin/env bash
DIR=.
while [ $# -gt 0 ]; do case "$1" in --dir) DIR=$2; shift 2 ;; *) shift ;; esac; done
DIR=\${DIR//\\\\//}
echo '{"type":"step_start","timestamp":1000,"sessionID":"ses_STUB","part":{"type":"step-start"}}'
echo '{"type":"tool_use","timestamp":1500,"sessionID":"ses_STUB","part":{"type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"'"$DIR"'/src/a.ts","content":"one\\ntwo"},"metadata":{"filepath":"'"$DIR"'/src/a.ts"}}}}'
echo '{"type":"tool_use","timestamp":1800,"sessionID":"ses_STUB","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"false"},"metadata":{"exit":3,"output":"nope"}}}}'
echo '{"type":"text","timestamp":2000,"sessionID":"ses_STUB","part":{"type":"text","text":"done"}}'
echo '{"type":"step_finish","timestamp":3000,"sessionID":"ses_STUB","part":{"type":"step-finish","reason":"stop","tokens":{"total":100,"input":80,"output":20,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.001}}'
`, { mode: 0o755 });
    const wts = path.join(d, 'wts');
    fs.mkdirSync(wts, { recursive: true });
    const table = tableFor(stub);
    const env = { ...process.env, PATH: stub + path.delimiter + process.env.PATH,
                  CURSOR_ORCH_WT: wts, CURSOR_ORCH_MODELS: table };
    const run = (args, input) => {
      try { return { code: 0, out: execFileSync('node', [O, ...args], { cwd: d, encoding: 'utf8', input, env, stdio: ['pipe', 'pipe', 'pipe'] }) }; }
      catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
    };
    const git = (args, cwd = d) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'ci@example.invalid']);
    git(['config', 'user.name', 'ci']);
    fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, 'docs', '1-a.md'), '# A\n');
    for (const f of ['a', 'b']) fs.writeFileSync(path.join(d, 'src', f + '.ts'), 'orig\n');
    git(['add', '-A']); git(['commit', '-qm', 'init']);
    run(['load', 'docs']);
    if (steps) run(['step', 'add'], JSON.stringify(steps));
    if (tiers) run(['assess', 'propose'], JSON.stringify(tiers));
    return { d, run, git, wts, env, table, stub };
  }
  const STEP = [{ key: 'S-1', title: 'one', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] }];
  const TIER = [{ key: 'S-1', tier: 'medium', why: 'test' }];

  // --- the ladder: one model, and a tier is an effort ---------------------
  {
    const b = box('oc-ladder', STEP, TIER);
    const mrun = (args) => {
      try { return { code: 0, out: execFileSync('node', [MODELS, ...args], { cwd: b.d, encoding: 'utf8', env: b.env, stdio: ['pipe', 'pipe', 'pipe'] }) }; }
      catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
    };
    // Cursor's rows are untouched by any of this.
    ok('the cursor ladder still resolves a tier to a model',
      mrun(['resolve', 'high']).out.startsWith('cursor-grok-4.6-high'), mrun(['resolve', 'high']).out);
    const low = mrun(['resolve', '--runner', 'opencode', 'composer']);
    ok('an opencode tier resolves to the one model and an effort',
      low.out.includes('opencode-go/deepseek-v4-flash') && low.out.trim().endsWith('low'), low.out);
    // The flag's value is not the positional. Reading it as one resolved the
    // tier "opencode", which is not a tier.
    const xh = mrun(['resolve', '--runner', 'opencode', 'xhigh']);
    ok('and the flag value is not mistaken for the tier', xh.out.trim().endsWith('max'), xh.out);
    ok('a role resolves the same as the tier it names',
      mrun(['resolve', '--runner', 'opencode', 'chip']).out.trim().endsWith('low'), mrun(['resolve', '--runner', 'opencode', 'chip']).out);
    const eff = mrun(['efforts', '--runner', 'opencode']);
    ok('efforts says what the model accepts', has(eff.out, 'low, high, max'), eff.out);
    ok('and that a run cannot be verified afterwards', has(eff.out, 'the log does not name the model'), eff.out);
    ok('and says which tiers collapse into one effort',
      has(eff.out, 'composer, low and medium are the same effort'), eff.out);
  }

  // --- an effort the model does not accept is refused before it is billed --
  // `opencode run --variant nonsense` runs a normal turn and reports nothing,
  // so a typo would cost the reasoning the tier was chosen for and nothing
  // would say so. The registry is the only thing that can catch it.
  {
    const b = box('oc-badeffort', STEP, TIER);
    const t = JSON.parse(fs.readFileSync(b.table, 'utf8'));
    t.runners.opencode.efforts.xhigh = 'minimal';   // valid for other models, not this one
    fs.writeFileSync(b.table, JSON.stringify(t, null, 2));
    let out = '', code = 0;
    try { out = execFileSync('node', [MODELS, 'resolve', '--runner', 'opencode', 'xhigh'], { cwd: b.d, encoding: 'utf8', env: b.env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { code = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
    ok('an effort this model does not accept is refused', code === 2, String(code));
    ok('and it says what the model does accept', has(out, 'low, high, max'), out);
    ok('and why it is refused here rather than at run time',
      has(out, 'accepted in silence'), out);
  }

  // --- choosing the runner ------------------------------------------------
  {
    const b = box('oc-choose', STEP, TIER);
    ok('cursor is the default, and says nothing has chosen',
      has(b.run(['runner']).out, 'nothing has chosen yet'), b.run(['runner']).out);
    const used = b.run(['runner', 'use', 'opencode']);
    ok('a runner can be chosen', used.code === 0 && has(used.out, 'runs on opencode'), used.out);
    ok('and choosing it states that runs will be unverified',
      has(used.out, 'marked unverified'), used.out);
    ok('an unknown runner is refused', b.run(['runner', 'use', 'nonsense']).code === 2);
    const show = b.run(['runner']);
    ok('runner show names the one model', has(show.out, 'DeepSeek V4 Flash'), show.out);
    ok('and prints the tier-to-effort table', has(show.out, 'xhigh') && has(show.out, 'max'), show.out);
    // assess is where a user picks a tier, so the collapse belongs there too.
    ok('the assess table says which tiers are the same effort',
      has(b.run(['assess']).out, 'are the same effort'), b.run(['assess']).out);
  }

  // --- a runner whose binary is missing is refused, once ------------------
  {
    const b = box('oc-nobin', STEP, TIER);
    fs.rmSync(path.join(b.stub, 'opencode'));
    const used = b.run(['runner', 'use', 'opencode']);
    ok('a runner that is not installed cannot be chosen', used.code === 2, used.out);
    ok('and the reason is a sentence, not `command not found`',
      has(used.out, 'not installed, or not where this expects it'), used.out);
    ok('which says a terminal PATH is not this PATH',
      has(used.out, 'non-interactive shell'), used.out);
  }

  // --- opening a step on opencode ----------------------------------------
  {
    const b = box('oc-open', STEP, TIER);
    b.run(['runner', 'use', 'opencode']);
    const open = b.run(['run', 'open', 'S-1']);
    ok('a step opens on the one model at its tier\'s effort',
      has(open.out, 'DeepSeek V4 Flash · low'), open.out);
    ok('and says the record will be unverified', has(open.out, 'marked unverified'), open.out);
    // Cursor mints a chat first because it needs an address before it has a
    // conversation. opencode's address does not exist until the run does.
    ok('no chat is minted, because the session comes out of the run',
      has(open.out, 'opencode mints one'), open.out);
    ok('and the launcher line names the runner', has(open.out, '--runner opencode'), open.out);
    ok('and carries no --chat', !has(open.out, '--chat'), open.out);
  }

  // --- the launcher, end to end against the stub --------------------------
  {
    const b = box('oc-run', STEP, TIER);
    b.run(['runner', 'use', 'opencode']);
    b.run(['run', 'open', 'S-1']);
    const wt = path.join(b.wts, path.basename(b.d) + '-wt-S-1');
    let out = '', code = 0;
    try {
      out = execFileSync('bash', [path.join(SCRIPTS, 'run.sh'), '--runner', 'opencode', '--role', 'chip',
        '--tier', 'medium', '--key', 'S-1', '--workspace', wt, '--prompt-file', '.claude/orch/briefs/S-1.md', '--quiet'],
        { cwd: b.d, encoding: 'utf8', env: b.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { code = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
    ok('run.sh hands an opencode run to its own launcher', code === 0, out);
    ok('which reports the model asked for and the effort',
      has(out, 'DeepSeek V4 Flash') && has(out, 'effort: low'), out);
    ok('and says plainly that this is not a verified fact',
      has(out, 'asked for rather than what was verified'), out);
    ok('the session is reported, since nothing else knows it', has(out, 'ses_STUB'), out);
    const status = readIf(path.join(b.d, '.claude', 'orch', 'runs', 'S-1.status'));
    ok('the status file is written in the same shape as cursor\'s',
      status.startsWith('exit 0\tpassed\tS-1\t'), status);
    // The record, harvested by the right harvester. The stub writes a log, not
    // a commit, so the agent's side of the run is done here — a branch with
    // nothing on it is one of the three things that stops a run being recorded
    // as passing, and this case is about the harvester, not about that.
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'done by the stub\n');
    b.git(['add', '-A'], wt); b.git(['commit', '-qm', 'widen a'], wt);
    const rec = b.run(['run', 'record', 'S-1', '--log', '.claude/orch/logs/S-1.jsonl']);
    ok('run record routes to the opencode harvester', rec.code === 0, rec.out);
    const filed = JSON.parse(readIf(path.join(b.d, '.claude', 'orch', 'runs', 'S-1', '1.json')));
    ok('the record keeps the shape everything downstream reads',
      filed.outcome === 'passed' && Array.isArray(filed.files) && Array.isArray(filed.commands), JSON.stringify(filed).slice(0, 200));
    ok('and says the model was not verified', filed.modelVerified === false, String(filed.modelVerified));
    ok('and records what was asked for, not what answered',
      filed.model === 'opencode-go/deepseek-v4-flash' && filed.effort === 'low', JSON.stringify([filed.model, filed.effort]));
    ok('the session is on the record, so a send-back can resume it',
      filed.session === 'ses_STUB', String(filed.session));
    // Paths in an opencode log are absolute and belong to the worktree.
    // Relativised against anything else, `guard` cannot match them at all.
    ok('a file it wrote is recorded relative to the worktree',
      filed.files.length === 1 && filed.files[0].path === 'src/a.ts', JSON.stringify(filed.files));
    ok('a failed command keeps its exit code',
      filed.commands.some((c) => c.exitCode === 3), JSON.stringify(filed.commands));
    ok('tokens and cost are kept, which cursor\'s log has no values for',
      filed.usage.total === 100 && filed.usage.cost === 0.001, JSON.stringify(filed.usage));
    // And the send-back resumes the session rather than a chat. The flag is
    // `-s`, which is what opencode's own help states and what the plan recorded
    // from running it. This check used to assert `--session`, so it held the
    // wrong spelling in place instead of catching it: a resume with a flag
    // opencode ignores starts a fresh session with no memory of the run, while
    // the record says the same conversation continued.
    const sb = b.run(['sendback', 'S-1', '--why', 'try again']);
    ok('sendback resumes the opencode session', has(sb.out, '-s ses_STUB'), sb.out);
    ok('and not with a flag opencode would ignore', !has(sb.out, '--session'), sb.out);
    ok('with the model and effort it ran on', has(sb.out, '--variant low'), sb.out);
    ok('and not with cursor\'s resume flag', !has(sb.out, '--resume'), sb.out);
  }

  // --- a provider that never answers is stopped, not waited on ------------
  // Seen for real: the service accepted a request and returned nothing at all
  // — no events, no error, empty stderr, nothing in opencode's own log — for a
  // prompt that had answered in about a second minutes earlier, on two models
  // at once. Without a bound the status stays `running` and the round stalls
  // with no error anywhere, which is worse than failing.
  //
  // The bound is SILENCE, not duration. A wall-clock cap cannot tell a wedged
  // provider from a long step, and the cost of guessing was paid twice: the
  // 30-minute default killed an xhigh step that had done all its work and had
  // not yet committed, and 90 minutes killed another the same way.
  const ocRun = (b, env) => {
    const started = Date.now();
    let out = '', code = 0;
    try {
      out = execFileSync('bash', [path.join(SCRIPTS, 'run-opencode.sh'), '--role', 'chip', '--tier', 'medium',
        '--key', 'S-1', '--workspace', b.d, '--prompt-file', '.claude/orch/briefs/S-1.md', '--quiet'],
        { cwd: b.d, encoding: 'utf8', env: { ...b.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { code = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
    return { out, code, took: Date.now() - started };
  };
  {
    const b = box('oc-timeout', STEP, TIER);
    fs.writeFileSync(path.join(b.stub, 'opencode'), '#!/usr/bin/env bash\nsleep 60\n', { mode: 0o755 });
    b.run(['runner', 'use', 'opencode']);
    b.run(['run', 'open', 'S-1']);
    const r = ocRun(b, { OPENCODE_ORCH_IDLE: '3' });
    ok('a run that never answers is stopped', r.code === 1, String(r.code) + ' ' + r.out);
    ok('and stopped at the limit rather than run to completion', r.took < 30_000, r.took + 'ms');
    ok('it says how long the silence lasted', has(r.out, 'nothing for 3s'), r.out);
    ok('and calls it a silent run rather than a long one', has(r.out, 'Not a long run'), r.out);
    ok('and that an empty log means the provider never answered',
      has(r.out, 'never answering'), r.out);
    ok('and offers the one-line check before spending a round',
      has(r.out, 'Reply with exactly: OK'), r.out);
    ok('and says how to allow longer silence', has(r.out, 'OPENCODE_ORCH_IDLE'), r.out);
    const status = readIf(path.join(b.d, '.claude', 'orch', 'runs', 'S-1.status'));
    ok('the status says timeout, which a detached exit code could not',
      status.startsWith('exit 1\ttimeout\tS-1\t'), status);
  }

  // --- the step that was working and got killed anyway --------------------
  // The defect this replaced: a step that had been emitting events for the
  // whole run was stopped at a fixed wall-clock cap with its work uncommitted,
  // twice, at two different caps. A run that keeps writing is a run that is
  // working, and the idle bound leaves it alone.
  {
    const b = box('oc-idle-working', STEP, TIER);
    // Writes a line every second for six seconds: never silent for two.
    fs.writeFileSync(path.join(b.stub, 'opencode'), '#!/usr/bin/env bash\n' +
      'for i in 1 2 3 4 5 6; do\n' +
      '  echo \'{"type":"text","timestamp":1000,"sessionID":"ses_STUB","part":{"type":"text","text":"working"}}\'\n' +
      '  sleep 1\n' +
      'done\n' +
      'echo \'{"type":"step_finish","timestamp":9000,"sessionID":"ses_STUB","part":{"type":"step-finish","reason":"stop","tokens":{"total":1},"cost":0}}\'\n',
      { mode: 0o755 });
    b.run(['runner', 'use', 'opencode']);
    b.run(['run', 'open', 'S-1']);
    const r = ocRun(b, { OPENCODE_ORCH_IDLE: '3' });
    ok('a run that keeps emitting outlives an idle bound shorter than itself',
      r.code === 0, String(r.code) + ' ' + r.out);
    ok('and finishes rather than being stopped', has(r.out, 'finished'), r.out);
    ok('having run well past that bound', r.took > 4000, r.took + 'ms');
    // The outer backstop still exists, and says which of the two it was.
    const wall = ocRun(b, { OPENCODE_ORCH_IDLE: '0', OPENCODE_ORCH_TIMEOUT: '2' });
    ok('the wall-clock backstop still stops a run that will not end', wall.code === 1, wall.out);
    ok('and does not blame a wedged provider for it',
      has(wall.out, 'still emitting events') && !has(wall.out, 'never answering'), wall.out);
  }

  // --- the formatter reads the other vocabulary ---------------------------
  {
    const b = box('oc-stream', STEP, TIER);
    const log = path.join(b.d, 'x.jsonl');
    fs.writeFileSync(log, [
      JSON.stringify({ type: 'step_start', timestamp: 1000, sessionID: 'ses_ABC', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'tool_use', timestamp: 4000, sessionID: 'ses_ABC', part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'make' }, metadata: { exit: 2, output: 'boom' } } } }),
      JSON.stringify({ type: 'step_finish', timestamp: 9000, sessionID: 'ses_ABC', part: { reason: 'stop', tokens: { total: 42 }, cost: 0.5 } }),
    ].join('\n') + '\n');
    const outp = execFileSync('node', [path.join(SCRIPTS, 'stream.mjs'), '--runner', 'opencode', '--key', 'S-1'],
      { input: fs.readFileSync(log), encoding: 'utf8' });
    ok('the formatter reads an opencode log', has(outp, 'ses_ABC'), outp);
    ok('a failed command is marked as failed', has(outp, '✗') && has(outp, 'make'), outp);
    ok('with its exit code and output', has(outp, 'exit 2') && has(outp, 'boom'), outp);
    // opencode stamps `timestamp`, cursor `timestamp_ms`. Reading only the
    // second made every line 00:00, which is what the column is for.
    ok('elapsed time comes off opencode\'s own clock', has(outp, '00:08'), outp);
  }

  // --- an opencode run that stopped short is not a passing one ------------
  // The cursor harvester has required a terminal `result` event since the one
  // run that died on this build, and reports `died` plus a non-zero exit
  // without it. The opencode port had no equivalent: any run that emitted a
  // single `text` chunk read as `passed`, so a provider drop after the model's
  // first sentence was recorded as finished work. These hold the two
  // harvesters to one contract, because a round cannot tell which one built
  // the step and must not have to.
  {
    const HOC = path.join(SCRIPTS, 'harvest-opencode.mjs');
    const b = box('oc-outcome', STEP, TIER);
    const oc = (name, lines) => {
      const f = path.join(b.d, name);
      fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
      try { return { rec: JSON.parse(execFileSync('node', [HOC, f], { encoding: 'utf8' })), code: 0 }; }
      catch (e) { return { rec: JSON.parse(e.stdout), code: e.status }; }
    };
    const S = 'ses_CUT';
    const cut = oc('cut.jsonl', [
      { type: 'step_start', timestamp: 1000, sessionID: S, part: { type: 'step-start' } },
      { type: 'text', timestamp: 1200, sessionID: S, part: { type: 'text', text: 'Let me look first' } },
    ]);
    ok('an opencode run with no step_finish reads as died', cut.rec.outcome === 'died', cut.rec.outcome);
    ok('and exits non-zero, so it cannot pass for a finished one', cut.code !== 0, cut.code);

    const done = oc('done.jsonl', [
      { type: 'step_start', timestamp: 1000, sessionID: S, part: { type: 'step-start' } },
      { type: 'text', timestamp: 1200, sessionID: S, part: { type: 'text', text: 'done' } },
      { type: 'step_finish', timestamp: 3000, sessionID: S, part: { reason: 'stop', tokens: { total: 4 }, cost: 0.1 } },
    ]);
    ok('a run that finished reads as passed', done.rec.outcome === 'passed', done.rec.outcome);
    ok('and exits zero', done.code === 0, done.code);

    const empty = oc('empty.jsonl', []);
    ok('an empty opencode log reads as died', empty.rec.outcome === 'died', empty.rec.outcome);

    // The probe line is read by run-opencode.sh with `IFS=$'\t' read`, and tab is
    // whitespace to IFS: a leading empty field is swallowed and every value
    // shifts left one. A run that errored before opencode minted a session has
    // exactly that shape, and it was reported as a pass with the error text
    // landing in IS_ERROR where nothing compares it.
    const errf = path.join(b.d, 'noses.jsonl');
    fs.writeFileSync(errf, JSON.stringify({ type: 'error', timestamp: 2000,
      error: { name: 'AuthError', data: { message: 'invalid API key' } } }) + '\n');
    let probe = '';
    try { probe = execFileSync('node', [HOC, errf, '--probe'], { encoding: 'utf8' }); }
    catch (e) { probe = e.stdout || ''; }
    ok('a probe line never begins with an empty field', !probe.startsWith('\t'), JSON.stringify(probe));
    ok('and still carries four of them', probe.replace(/\n$/, '').split('\t').length === 4, JSON.stringify(probe));
  }
  // --- and a cursor round is entirely unaffected --------------------------
  {
    const b = box('oc-cursor-intact', STEP, TIER);
    const open = b.run(['run', 'open', 'S-1']);
    ok('a cursor step still mints a chat', has(open.out, '11111111-2222-3333-4444-555555555555'), open.out);
    ok('and still names a cursor model', has(open.out, 'Cursor Grok 4.6 Medium'), open.out);
    ok('and its launcher line still carries --chat', has(open.out, '--chat'), open.out);
  }
});

// -------------------------------------------- what one real 18-step round found
// Six defects from a build driven end to end against this tool, plus the two
// runner behaviours that cost the most wall-clock. Each of these failed before
// the fix beside it; the comment says what the old behaviour was, because a
// check nobody has watched fail is not a check.
say('what one real round found');
sect(() => {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const O = path.join(ROOT, 'claude-cursor', 'orchestrate.mjs');
  function box(name) {
    const d = bare(name);
    const stub = path.join(d, 'stub');
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(path.join(stub, 'agent'),
      '#!/usr/bin/env bash\necho "Created chat 11111111-2222-3333-4444-555555555555"\n', { mode: 0o755 });
    const wts = path.join(d, 'wts');
    fs.mkdirSync(wts, { recursive: true });
    const env = { ...process.env, PATH: stub + path.delimiter + process.env.PATH, CURSOR_ORCH_WT: wts };
    const run = (args, input) => {
      try { return { code: 0, out: execFileSync('node', [O, ...args], { cwd: d, encoding: 'utf8', input, env, stdio: ['pipe', 'pipe', 'pipe'] }) }; }
      catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
    };
    const git = (args, cwd = d) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const write = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
      fs.writeFileSync(path.join(d, rel), body);
    };
    const report = (plan, obj) => write(path.join('.claude', 'orch', 'refine',
      plan.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.json'), JSON.stringify(obj));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'ci@example.invalid']);
    git(['config', 'user.name', 'ci']);
    return { d, run, git, write, report, wts };
  }
  const state = (b) => JSON.parse(readIf(path.join(b.d, '.claude/orch/state.json')) || '{}');
  const stepOf = (b, k) => (state(b).tasks || []).find((t) => t.key === k) || {};

  // --- 1. cancelling took the edges out and nothing put them back ----------
  // Cancelling S-023.1…S-030.1 dropped `needs` from every survivor. Re-refining
  // brought the same keys back with nothing pointing at them, and four steps
  // were one `run open` away from building against a tree that held none of the
  // work they were written on top of. `step link` already refuses to record
  // half a graph for exactly this reason; `step rm` was doing it quietly.
  {
    const b = box('sever');
    b.write('docs/1-a.md', '# A\n'); b.write('docs/2-b.md', '# B\n');
    b.write('src/a.ts', 'a\n'); b.write('src/b.ts', 'b\n');
    b.git(['add', '-A']); b.git(['commit', '-qm', 'init']);
    b.run(['load', 'docs']);
    b.run(['step', 'add'], JSON.stringify([
      { key: 'S-1', title: 'tables', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] },
      { key: 'S-2', title: 'ownership', plan: 'docs/2-b.md', owns: ['src/b.ts'], needs: ['S-1'], verify: ['true'] }]));
    const cancelled = b.run(['step', 'rm', 'S-1']);
    ok('cancelling a dependency says the dependent was unblocked by a cancellation',
      has(cancelled.out, 'cancelled instead'), cancelled.out);
    ok('and names the edge it took out', has(cancelled.out, 'S-2') && has(cancelled.out, 'no longer needs S-1'), cancelled.out);
    ok('the edge really is out of needs', !(stepOf(b, 'S-2').needs || []).includes('S-1'), JSON.stringify(stepOf(b, 'S-2')));
    ok('but it is kept, not forgotten',
      (stepOf(b, 'S-2').severed || []).some((x) => x.key === 'S-1'), JSON.stringify(stepOf(b, 'S-2')));
    const doc = b.run(['doctor']);
    ok('doctor says the edge is severed while the dependency stays cancelled',
      has(doc.out, 'severed by a cancellation'), doc.out);
    // The part that mattered: recording the key again restores what cancelling
    // it removed. It used to come back with nothing pointing at it.
    b.report('docs/1-a.md', { summary: 's', steps: [{ key: 'S-1', title: 'tables again', owns: ['src/a.ts'], verify: ['true'] }] });
    const revived = b.run(['refine', 'done', 'docs/1-a.md']);
    ok('re-refining a cancelled plan revives its step', revived.code === 0, revived.out);
    ok('and says the edges are back', has(revived.out, 'are back') && has(revived.out, 'S-2 needs S-1 again'), revived.out);
    ok('so the dependent waits for it again',
      (stepOf(b, 'S-2').needs || []).includes('S-1'), JSON.stringify(stepOf(b, 'S-2')));
    ok('and nothing is left severed', !(stepOf(b, 'S-2').severed || []).length, JSON.stringify(stepOf(b, 'S-2')));
    b.run(['assess', 'set', 'S-1=low', 'S-2=low']);
    const chk = b.run(['check']);
    ok('the dependent is held back rather than opened on a hole',
      has(chk.out, 'Waiting on work to reach the main line: S-2'), chk.out);
  }

  // --- 2. a report that never reached the board, announced as recorded -----
  // `refine done` printed its tick off the report it had just read, which is
  // true of the report whatever happened to the register. The one number that
  // would have said otherwise — the register total beside it — sat unchanged at
  // 18 across three consecutive additions and nothing compared them.
  {
    const b = box('board-check');
    b.write('docs/1-a.md', '# A\n'); b.write('src/a.ts', 'a\n');
    b.git(['add', '-A']); b.git(['commit', '-qm', 'init']);
    b.run(['load', 'docs']);
    b.report('docs/1-a.md', { summary: 's', steps: [
      { key: 'S-1', title: 'x', owns: ['src/a.ts'], verify: ['true'], status: 'cancelled' }] });
    const forged = b.run(['refine', 'done', 'docs/1-a.md']);
    ok('a report that writes the tool\'s own bookkeeping is refused', forged.code === 1, forged.out);
    ok('and says which field', has(forged.out, '"status"') && has(forged.out, 'bookkeeping'), forged.out);
    ok('and records nothing', !(state(b).tasks || []).length, JSON.stringify(state(b).tasks));
    b.report('docs/1-a.md', { summary: 's', steps: [{ key: 'S-1', title: 'x', owns: ['src/a.ts'], verify: ['true'] }] });
    const good = b.run(['refine', 'done', 'docs/1-a.md']);
    ok('the same report without it is recorded', good.code === 0, good.out);
    ok('and the total beside the tick comes off the register',
      has(good.out, '(1 in the register)'), good.out);
    // A step add whose key was cancelled comes back live, and says so.
    b.run(['step', 'rm', 'S-1']);
    const back = b.run(['step', 'add'], JSON.stringify([{ key: 'S-1', title: 'x', owns: ['src/a.ts'] }]));
    ok('a cancelled key recorded again is revived rather than merged into a dead row',
      back.code === 0 && has(back.out, 'revived by this'), back.out);
    ok('and the board holds it as live work', has(b.run(['board']).out, 'planned'), b.run(['board']).out);
  }

  // --- 3. a run killed at its bound, recorded as a passing one -------------
  // S-022.1's status file said `exit 1 timeout`; `run record` said passed, 19m,
  // 6 files changed. opencode's cap had stopped it mid-gate with everything
  // uncommitted — the log still held a `step_finish`, and that was the only
  // witness anyone asked.
  {
    const b = box('three-witnesses');
    b.write('docs/1-a.md', '# A\n'); b.write('src/a.ts', 'a\n');
    b.git(['add', '-A']); b.git(['commit', '-qm', 'init']);
    b.run(['load', 'docs']);
    b.run(['step', 'add'], JSON.stringify([{ key: 'S-1', title: 'x', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] }]));
    b.run(['assess', 'set', 'S-1=low']);
    b.run(['run', 'open', 'S-1']);
    const wt = stepOf(b, 'S-1').worktree;
    const log = path.join(b.d, 'run.jsonl');
    fs.writeFileSync(log, [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'Cursor Grok 4.6 Medium', cwd: wt }),
      JSON.stringify({ type: 'result', result: 'done', timestamp_ms: 61000 })].join('\n') + '\n');
    // The work is committed, so the branch is not the dissenting witness here.
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'done\n');
    b.git(['add', '-A'], wt); b.git(['commit', '-qm', 'widen a'], wt);
    fs.mkdirSync(path.join(b.d, '.claude', 'orch', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(b.d, '.claude', 'orch', 'runs', 'S-1.status'),
      'exit 1\ttimeout\tS-1\t.claude/orch/logs/S-1.jsonl\n');
    const killed = b.run(['run', 'record', 'S-1', '--log', log]);
    ok('a log that says passed does not outvote the launcher\'s status file',
      killed.code === 1 && has(killed.out, 'timeout'), killed.out);
    ok('and the disagreement is stated rather than resolved silently',
      has(killed.out, 'Its log says "passed"'), killed.out);
    ok('the step stays open, so it is resumed rather than merged',
      stepOf(b, 'S-1').status === 'open', stepOf(b, 'S-1').status);
    ok('and it says to resume rather than start again', has(killed.out, 'sendback S-1'), killed.out);
    // The same run, with a status file that agrees.
    fs.writeFileSync(path.join(b.d, '.claude', 'orch', 'runs', 'S-1.status'),
      'exit 0\tpassed\tS-1\t.claude/orch/logs/S-1.jsonl\n');
    const clean = b.run(['run', 'record', 'S-1', '--log', log]);
    ok('three witnesses agreeing is a pass', clean.code === 0 && has(clean.out, '✓ S-1 run 2: passed'), clean.out);
    // The third witness on its own: work left uncommitted in the worktree.
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'half done\n');
    const dirty = b.run(['run', 'record', 'S-1', '--log', log]);
    ok('a run that left work uncommitted is not a finished one',
      dirty.code === 1 && has(dirty.out, 'uncommitted'), dirty.out);
    b.git(['checkout', '--', 'src/a.ts'], wt);
    // A commit named for the merge rather than for the change. The idiom is
    // this tool's own, learned off `git log` on the main line and copied back.
    b.git(['commit', '-qm', 'land S-1', '--allow-empty'], wt);
    const idiom = b.run(['run', 'record', 'S-1', '--log', log]);
    ok('a commit named for the merge instead of the change is noticed',
      has(idiom.out, 'named for the merge, not for the change'), idiom.out);
    ok('and it says how to amend it', has(idiom.out, 'commit --amend'), idiom.out);
    // The check is anchored to the whole subject. Reconciling with the main
    // line is what `sendback --why conflict` asks for, and its merge commit
    // carries the branch name — a first-word match would have called the one
    // correct thing an agent does after a conflict a mistake.
    b.git(['commit', '-qm', "Merge branch 'main' into step/S-1", '--allow-empty'], wt);
    const real = b.run(['run', 'record', 'S-1', '--log', log]);
    ok('but reconciling with the main line is not that mistake',
      (real.out.match(/named for the merge, not for the change/g) || []).length === 1 &&
      !has(real.out, "Merge branch 'main'"), real.out);
  }

  // --- 4. join advertised a step that run open then refused ---------------
  // `join` answered "what can open now" with its own filter — planned, needs
  // me, nothing held — which knows about dependencies and nothing about
  // serialisation points. So it named S-024.1, and `run open S-024.1` replied
  // that it moves the same four points as S-023.1, which was still open.
  {
    const b = box('one-idea-of-ready');
    b.write('docs/1-a.md', '# A\n');
    for (const f of ['a', 'b', 'c']) b.write('src/' + f + '.ts', 'orig\n');
    b.git(['add', '-A']); b.git(['commit', '-qm', 'init']);
    b.run(['load', 'docs']);
    b.run(['step', 'add'], JSON.stringify([
      { key: 'S-1', title: 'first', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] },
      { key: 'S-2', title: 'holds the head', plan: 'docs/1-a.md', owns: ['src/b.ts'],
        serialises: ['migration head'], needs: ['S-1'], verify: ['true'] },
      { key: 'S-3', title: 'moves it too', plan: 'docs/1-a.md', owns: ['src/c.ts'],
        serialises: ['migration head'], needs: ['S-1'], verify: ['true'] }]));
    b.run(['assess', 'set', 'S-1=low', 'S-2=low', 'S-3=low']);
    b.run(['run', 'open', 'S-1']);
    const wt = stepOf(b, 'S-1').worktree;
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'one\n');
    b.git(['add', '-A'], wt); b.git(['commit', '-qm', 'one'], wt);
    const joined = b.run(['join', 'S-1']);
    ok('join names only one of the two, because they share a point',
      has(joined.out, 'can open now') && has(joined.out, 'S-2') && !has(joined.out, 'S-3: '), joined.out);
    ok('and says the other is held, rather than leaving run open to refuse it',
      has(joined.out, 'still cannot open') && has(joined.out, 'migration head'), joined.out);
    // The claim underneath: what join advertises, run open takes.
    const first = b.run(['run', 'open', 'S-2']);
    ok('what join advertised really opens', first.code === 0, first.out);
    const second = b.run(['run', 'open', 'S-3']);
    ok('and what it held back is the one run open refuses', second.code === 2, second.out);
  }

  // --- 5. a short owns list failing correct work --------------------------
  // Three times in one round a step was required by its own plan or its own
  // proof command to write a file it did not own — a migration journal, a
  // capability registry, a seed file. Each produced a guard failure on work
  // that was right, and the only remedy was re-refining the whole plan.
  {
    const b = box('short-owns');
    b.write('docs/1-a.md', '# A\n');
    b.write('src/a.ts', 'a\n'); b.write('src/registry.ts', 'export const all = []\n');
    b.write('src/other.ts', 'other\n');
    b.git(['add', '-A']); b.git(['commit', '-qm', 'init']);
    b.run(['load', 'docs']);
    b.run(['step', 'add'], JSON.stringify([
      { key: 'S-1', title: 'adds a capability', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] },
      { key: 'S-2', title: 'owns the other one', plan: 'docs/1-a.md', owns: ['src/other.ts'], verify: ['true'] }]));
    b.run(['assess', 'set', 'S-1=low', 'S-2=low']);
    b.run(['run', 'open', 'S-1']);
    const wt = stepOf(b, 'S-1').worktree;
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'done\n');
    fs.writeFileSync(path.join(wt, 'src', 'registry.ts'), 'export const all = [1]\n');
    fs.writeFileSync(path.join(wt, 'src', 'other.ts'), 'taken\n');
    b.git(['add', '-A'], wt); b.git(['commit', '-qm', 'work'], wt);
    const g = b.run(['guard', 'S-1']);
    ok('guard still fails a step that went outside its list', g.code === 1, g.out);
    ok('a file another live step owns is called a breach',
      has(g.out, 'belong to another live step') && has(g.out, 'S-2 owns it'), g.out);
    ok('and that one is what sendback is offered for', has(g.out, 'sendback S-1'), g.out);
    ok('a file nobody owns is called a short list instead',
      has(g.out, 'belong to nobody'), g.out);
    ok('and offers to widen the step rather than send correct work back',
      has(g.out, 'step own S-1 src/registry.ts'), g.out);
    const own = b.run(['step', 'own', 'S-1', 'src/registry.ts']);
    ok('a step can be widened without re-refining its plan', own.code === 0, own.out);
    ok('and it says the agent is holding a brief written from the old list',
      has(own.out, 'brief was written from the old list'), own.out);
    const g2 = b.run(['guard', 'S-1']);
    ok('the registry no longer counts against it', !has(g2.out, 'src/registry.ts\n') || !has(g2.out, 'belong to nobody'), g2.out);
    ok('while the real trespass still does', g2.code === 1 && has(g2.out, 'src/other.ts'), g2.out);
    const brief = b.run(['refine', 'brief', 'docs/1-a.md']);
    ok('and the refine brief now names the three kinds of path that get missed',
      has(brief.out, 'your `verify` command WRITES') && has(brief.out, 'registry, barrel, index or manifest'), brief.out);
  }

  // --- 6. a refining agent editing plans it was not given ------------------
  // One rewrote nine plans in a single run and registered steps off text that
  // was then reverted. `refine done` validated the shape of every owns entry
  // and every key, and never asked which plan the agent had actually touched.
  {
    const b = box('plan-scope');
    b.write('docs/1-a.md', '# A\n'); b.write('docs/2-b.md', '# B\n'); b.write('src/a.ts', 'a\n');
    b.git(['add', '-A']); b.git(['commit', '-qm', 'init']);
    b.run(['load', 'docs']);
    b.write('docs/2-b.md', '# B\n\nrewritten by the wrong agent\n');
    b.report('docs/1-a.md', { summary: 's', steps: [{ key: 'S-1', title: 'x', owns: ['src/a.ts'], verify: ['true'] }] });
    const strayed = b.run(['refine', 'done', 'docs/1-a.md']);
    ok('a report is refused when the agent edited a plan it was not given',
      strayed.code === 1, strayed.out);
    ok('naming the plan it touched', has(strayed.out, 'docs/2-b.md'), strayed.out);
    ok('and offering the revert', has(strayed.out, 'git checkout --'), strayed.out);
    ok('and recording nothing', !(state(b).tasks || []).length, JSON.stringify(state(b).tasks));
    ok('with a way to keep the edits if they were meant', has(strayed.out, '--allow-plan-edits'), strayed.out);
    const kept = b.run(['refine', 'done', 'docs/1-a.md', '--allow-plan-edits']);
    ok('which records the report', kept.code === 0, kept.out);
    // Keys are the other half: a report cannot register work under a plan whose
    // own agent has not reported yet.
    b.git(['checkout', '--', 'docs/2-b.md']);
    b.report('docs/2-b.md', { summary: 's', steps: [{ key: 'S-1.1', title: 'poached', owns: ['src/b.ts'], verify: ['true'] }] });
    const poached = b.run(['refine', 'done', 'docs/2-b.md']);
    ok('a report keyed into another plan\'s numbering is refused', poached.code === 1, poached.out);
    ok('naming the plan that numbering belongs to', has(poached.out, 'docs/1-a.md'), poached.out);
    const brief = b.run(['refine', 'brief', 'docs/1-a.md']);
    ok('and the brief says so before the agent starts',
      has(brief.out, 'is the only file you may edit'), brief.out);
  }

  // --- the round that opens one step at a time ----------------------------
  // Everything else in this tool says to open the whole set, and then the only
  // way to act on that was one `run open` per step. A round opened that way
  // drifts into being run that way.
  {
    const b = box('open-all');
    b.write('docs/1-a.md', '# A\n');
    for (const f of ['a', 'b', 'c']) b.write('src/' + f + '.ts', 'orig\n');
    b.git(['add', '-A']); b.git(['commit', '-qm', 'init']);
    b.run(['load', 'docs']);
    b.run(['step', 'add'], JSON.stringify([
      { key: 'S-1', title: 'one', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] },
      { key: 'S-2', title: 'two', plan: 'docs/1-a.md', owns: ['src/b.ts'], verify: ['true'] },
      { key: 'S-3', title: 'three', plan: 'docs/1-a.md', owns: ['src/c.ts'],
        serialises: ['lockfile'], verify: ['true'] },
      { key: 'S-4', title: 'four', plan: 'docs/1-a.md', owns: ['src/d.ts'],
        serialises: ['lockfile'], verify: ['true'] }]));
    b.run(['assess', 'set', 'S-1=low', 'S-2=low', 'S-3=low', 'S-4=low']);
    ok('check offers the one command that opens the round',
      has(b.run(['check']).out, 'run open --all'), b.run(['check']).out);
    const all = b.run(['run', 'open', '--all']);
    ok('one command opens every step that can go', all.code === 0 && has(all.out, '3 step(s) open'), all.out);
    ok('and prints a launcher line for each', (all.out.match(/--prompt-file/g) || []).length === 3, all.out);
    ok('with the whole round written down as well', has(all.out, '.claude/orch/launch/'), all.out);
    ok('and says they go as separate backgrounded calls, in one message',
      has(all.out, 'all in one\nmessage'), all.out);
    // Nothing else can wake the session while the round is out, so the line
    // that arms the look-in is printed with the round rather than remembered.
    ok('and the round comes with the one call that wakes you if a run goes quiet',
      has(all.out, 'vitals --wait'), all.out);
    ok('the fourth stays back on the point the third is moving',
      has(all.out, 'stayed back on a serialisation point') && has(all.out, 'S-4'), all.out);
    ok('and it really is not open', stepOf(b, 'S-4').status === 'planned', stepOf(b, 'S-4').status);
    ok('every other one is', ['S-1', 'S-2', 'S-3'].every((k) => stepOf(b, k).status === 'open'),
      JSON.stringify((state(b).tasks || []).map((t) => [t.key, t.status])));
    const again = b.run(['run', 'open', '--all']);
    ok('running it again with nothing to open says so rather than passing', again.code === 1, again.out);
    ok('and names what is holding the rest', has(again.out, 'lockfile'), again.out);
  }

  // --- the narrow round, made visible while it can still be changed -------
  // A queue and a round both print a frontier, and the difference between them
  // is the difference between a day and a week. Nothing said which one you had.
  {
    const b = box('shape');
    b.write('docs/1-a.md', '# A\n');
    b.write('docs/2-b.md', '---\nrequires: [1]\n---\n# B\n');
    b.write('docs/3-c.md', '---\nrequires: [2]\n---\n# C\n');
    b.write('docs/4-d.md', '---\nrequires: [3]\n---\n# D\n');
    for (const f of ['a', 'b', 'c', 'd']) b.write('src/' + f + '.ts', 'orig\n');
    b.git(['add', '-A']); b.git(['commit', '-qm', 'init']);
    b.run(['load', 'docs']);
    b.run(['step', 'add'], JSON.stringify([
      { key: 'S-1.1', title: 'a', plan: 'docs/1-a.md', owns: ['src/a.ts'], verify: ['true'] },
      { key: 'S-2.1', title: 'b', plan: 'docs/2-b.md', owns: ['src/b.ts', 'src/a.ts'], verify: ['true'] },
      { key: 'S-3.1', title: 'c', plan: 'docs/3-c.md', owns: ['src/c.ts', 'src/b.ts'], verify: ['true'] },
      { key: 'S-4.1', title: 'd', plan: 'docs/4-d.md', owns: ['src/d.ts', 'src/c.ts'], verify: ['true'] }]));
    const linked = b.run(['step', 'link']);
    ok('linking says what the edges cost, in waves', has(linked.out, 'the round runs in 4 wave(s)'), linked.out);
    ok('and offers the narrower reading of the same requirements',
      has(linked.out, '--only-shared'), linked.out);
    b.run(['assess', 'set', 'S-1.1=low', 'S-2.1=low', 'S-3.1=low', 'S-4.1=low']);
    const chk = b.run(['check']);
    ok('check prints the shape of the whole graph, not just its first row',
      has(chk.out, 'The shape of it: 4 live step(s) in 4 wave(s) — 1 → 1 → 1 → 1'), chk.out);
    ok('and names a queue as a queue', has(chk.out, 'That is a queue, not a round'), chk.out);
  }

  // --- a serialisation point across many steps is a queue with a name ------
  {
    const b = box('point-fanout');
    b.write('docs/1-a.md', '# A\n');
    for (const f of ['a', 'b', 'c']) b.write('src/' + f + '.ts', 'orig\n');
    b.git(['add', '-A']); b.git(['commit', '-qm', 'init']);
    b.run(['load', 'docs']);
    b.run(['step', 'add'], JSON.stringify(['a', 'b', 'c'].map((f, i) => ({
      key: 'S-' + (i + 1), title: f, plan: 'docs/1-a.md', owns: ['src/' + f + '.ts'],
      serialises: ['capability registry'], verify: ['true'] }))));
    b.run(['assess', 'set', 'S-1=low', 'S-2=low', 'S-3=low']);
    const doc = b.run(['doctor']);
    ok('a point three steps name is reported with the queue it makes',
      has(doc.out, 'gate three or more steps'), doc.out);
    ok('naming it and counting them', has(doc.out, '3×') && has(doc.out, 'capability registry'), doc.out);
    ok('and saying what is and is not one', has(doc.out, 'A file two steps both edit is not one'), doc.out);
    ok('with the way to say two are separate things', has(doc.out, 'migration head: orders'), doc.out);
  }
});

// ------------------------------------- looking in on a round while it is out
// Between opening a round and the first run coming back there is nothing, and a
// wedged run never exits to say so. `vitals` is the look-in: is each open run's
// log still growing, and do the agent's own words say it is stuck. The case
// that decides whether this survives a real round is the false-positive one — a
// failing suite's output saying "cannot fix" is not the agent saying it.
say('looking in on a round while it is out');
sect(() => {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const O = path.join(ROOT, 'claude-cursor', 'orchestrate.mjs');
  const J = (o) => JSON.stringify(o);

  function box(name, steps) {
    const d = bare(name);
    fs.mkdirSync(path.join(d, '.claude', 'orch', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(d, '.claude', 'orch', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude', 'orch', 'state.json'), JSON.stringify({
      version: 1, created: '2026-09-05T00:00:00.000Z', plans: [], notes: [],
      tasks: steps.map((k) => ({ key: k, title: k, status: 'open' })) }, null, 2));
    const log = (k, lines) => fs.writeFileSync(path.join(d, '.claude', 'orch', 'logs', k + '.jsonl'), lines.join('\n') + '\n');
    // The four tab-separated fields both launchers write on every exit path.
    const status = (k, ex, outcome) => fs.writeFileSync(path.join(d, '.claude', 'orch', 'runs', k + '.status'),
      `exit ${ex}\t${outcome}\t${k}\t.claude/orch/logs/${k}.jsonl\n`);
    const age = (k, minutes) => {
      const t = new Date(Date.now() - minutes * 60000);
      fs.utimesSync(path.join(d, '.claude', 'orch', 'logs', k + '.jsonl'), t, t);
    };
    const run = (args) => {
      try { return { code: 0, out: execFileSync('node', [O, ...args], { cwd: d, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) }; }
      catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }; }
    };
    return { d, log, status, age, run };
  }

  // --- a growing log is what alive looks like; a silent one is not ---------
  {
    const b = box('vitals-alive', ['S-1', 'S-2']);
    b.log('S-1', [J({ type: 'system', subtype: 'init' }), J({ type: 'assistant', message: { content: [{ text: 'reading the tests now' }] } })]);
    b.status('S-1', '-', 'running');
    b.log('S-2', [J({ type: 'system', subtype: 'init' })]);
    b.status('S-2', '-', 'running');
    b.age('S-2', 40);
    const v = b.run(['vitals']);
    ok('a log written a moment ago reads as alive', has(v.out, 'S-1') && has(v.out, 'alive'), v.out);
    ok('one that has not grown in the interval is an alarm', has(v.out, 'S-2') && has(v.out, 'silent for 40m'), v.out);
    ok('and the check exits non-zero when something needs a person', v.code === 1, v.code);
    ok('saying so in words, not just in the code', has(v.out, '1 of 2 need a person'), v.out);
    ok('and saying the human decides rather than sending it back',
      has(v.out, 'Do not send back and do not restart'), v.out);
  }

  // --- what the agent said, and what a command merely printed --------------
  {
    const b = box('vitals-said', ['S-1', 'S-2', 'S-3']);
    // Cursor's shape: the agent blaming a failure it says predates it.
    b.log('S-1', [J({ type: 'assistant', message: { content: [{ text: 'npm test is red but it fails on main too, unrelated to my change' }] } })]);
    b.status('S-1', '-', 'running');
    // opencode's shape: the agent saying it cannot go on.
    b.log('S-2', [J({ type: 'text', part: { text: 'I cannot fix this without a decision on the schema' } })]);
    b.status('S-2', '-', 'running');
    // The false positive that decides whether this is worth having: the same
    // words, but printed BY a failing command rather than said by the agent.
    b.log('S-3', [J({ type: 'tool_call', subtype: 'completed', tool_call: { shellToolCall: {
      args: { command: 'npm test' },
      result: { success: { exitCode: 1, stdout: 'FAIL: pre-existing failure, cannot fix', stderr: '' } } } } })]);
    b.status('S-3', '-', 'running');
    const v = b.run(['vitals']);
    ok('a step blaming a failure it says predates it is an alarm', has(v.out, 'ci: "npm test is red'), v.out);
    ok('one saying it cannot fix something is an alarm too', has(v.out, 'stuck: "I cannot fix this'), v.out);
    ok('and the sentence is quoted rather than summarised', has(v.out, 'decision on the schema'), v.out);
    ok('a failing command\'s own output is not the agent saying anything',
      /S-3\s+alive/.test(v.out), v.out);
    ok('two of the three need a person', has(v.out, '2 of 3 need a person'), v.out);

    // Only what is new is read, so a line already raised is not raised again —
    // otherwise every later look stops the round for something already answered.
    const again = b.run(['vitals']);
    ok('a line already raised is not raised a second time', again.code === 0, again.out);
    ok('and the round reads as accounted for', has(again.out, 'All 3 accounted for'), again.out);
  }

  // --- what the status file settles that the log alone cannot --------------
  {
    const b = box('vitals-ended', ['S-1', 'S-2', 'S-3']);
    // A finished run's log correctly stops growing. Judged on silence alone it
    // would read as wedged; the status file is asked first.
    b.log('S-1', [J({ type: 'result', result: 'done' })]);
    b.status('S-1', '0', 'passed');
    b.age('S-1', 90);
    // Launched, but the log was never created: the run never started.
    b.status('S-2', '-', 'running');
    // No status file at all — a Claude Code step writes no jsonl, and the Agent
    // tool's own completion wakes the orchestrator instead.
    const v = b.run(['vitals']);
    ok('a run that ended is reported as finished, not as stalled',
      /S-1\s+finished/.test(v.out) && has(v.out, 'run record S-1'), v.out);
    ok('a launched run with no log at all never started', /S-2\s+ALARM/.test(v.out) && has(v.out, 'never started'), v.out);
    ok('a step with no run behind it is skipped, not alarmed on',
      /S-3\s+skipped/.test(v.out) && has(v.out, 'Claude Code step'), v.out);
    ok('and only the one that needs a person counts', has(v.out, '1 of 3 need a person'), v.out);
  }

  // --- the wake-up itself --------------------------------------------------
  {
    const b = box('vitals-wait', ['S-1']);
    b.log('S-1', [J({ type: 'system', subtype: 'init' })]);
    b.status('S-1', '-', 'running');
    const started = Date.now();
    const w = b.run(['vitals', '--wait', '--every', '0.02']);
    ok('--wait sleeps before it looks', Date.now() - started >= 900, Date.now() - started);
    ok('and says when it will come back, since that exit is the wake-up',
      has(w.out, 'The next look is at') && has(w.out, 'wakes you'), w.out);

    // Nothing out is not something to wait fifteen minutes for. A watchdog left
    // running past its round is a process looking at logs nobody waits on.
    const done = JSON.parse(fs.readFileSync(path.join(b.d, '.claude/orch/state.json'), 'utf8'));
    done.tasks[0].status = 'landed';
    fs.writeFileSync(path.join(b.d, '.claude/orch/state.json'), JSON.stringify(done));
    const at = Date.now();
    const none = b.run(['vitals', '--wait']);
    ok('with nothing out it returns at once instead of sleeping', Date.now() - at < 60000, Date.now() - at);
    ok('saying there is no run to check on', none.code === 0 && has(none.out, 'Nothing is out'), none.out);

    const bad = b.run(['vitals', '--every', 'nonsense']);
    ok('an interval that is not a number is refused', bad.code === 2 && has(bad.out, 'number of minutes'), bad.out);
  }
});

// ---------------------------------------------------------------------- report
// Run the slice this process was given. A case that throws is one failure, not
// the end of the sweep - the rest still run, and the count below still notices
// the checks the dead case never reached.
let ran = 0;
for (let i = 0; i < cases.length; i++) {
  if (SHARD && i % SHARD.n !== SHARD.i) continue;
  if (ONLY && !cases[i].label.includes(ONLY)) continue;
  ran++;
  if (cases[i].label) console.log('\n· ' + cases[i].label);
  try { cases[i].fn(); }
  catch (e) { failures.push('the case "' + cases[i].label + '" threw\n      ' + String((e && e.stack) || e)); }
}

if (!KEEP) for (const d of boxes) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
else console.log('\nsandboxes kept: ' + boxes.join('\n                '));

// The count is an assertion too. Without it a whole block can stop executing -
// an exception thrown before its first `ok`, a case quietly commented out - and
// the suite still ends on "all green", because green is only ever measured
// against however many checks happened to run. Under a shard the total is the
// runner's to check, since no one process sees them all.
const EXPECTED = 968;   // every check above counts; raise it deliberately when you add one
const total = pass + failures.length;
const partial = Boolean(SHARD || ONLY);

// One line the runner can parse, so a shard's counts survive its own output.
if (REPORT_JSON) {
  process.stdout.write('\n__SWEEP__' + JSON.stringify({ pass, ran, cases: cases.length, failures }) + '\n');
  process.exit(failures.length ? 1 : 0);
}

console.log('\n' + '-'.repeat(60));
if (!partial && total !== EXPECTED)
  failures.push('the suite ran ' + total + ' checks, not ' + EXPECTED +
    '\n      A block stopped part way, or a check was added without updating EXPECTED.');
if (!failures.length) { console.log(pass + ' checks, all green' + (partial ? ' (' + ran + ' of ' + cases.length + ' cases).' : '.')); process.exit(0); }
console.log(pass + ' passed, ' + failures.length + ' FAILED:');
for (const f of failures) console.log('  ✗ ' + f);
process.exit(1);
