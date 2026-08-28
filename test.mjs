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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'driver.mjs');
const KEEP = process.argv.includes('--keep');
let pass = 0; const failures = [];

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
const say = (m) => console.log('\n· ' + m);

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
{
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
}

// A partial report must not read like a success — it opens a defect on itself.
say('a half-failure is not a pass');
{
  const d = box('partial');
  drv(d, ['chip', 't2', '--id', 'chip-t2']);   // a report can only come from a chip that exists
  drv(d, ['done', 't2'], { stdin: '{"verified":"two of three suites","outcome":"partial"}' });
  const r = reg(d);
  ok('a partial report opens a defect', (r.defects || []).some((x) => x.kind === 'bug' && x.task === 't2'));
  ok('and it is on the waiting list', has(drv(d, ['outstanding']).out, 't2'));
}

// ------------------------------------------------------------------ the fixes
// Was: harvest stamps every recovered message kind 'derived', and both readers
// filtered on kind 'question' — so nothing ingest recovered could ever surface.
say('a message with no kind still reaches the waiting list');
{
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
}

// Was: ingest kept Claude Code's wrapper around the message and then cut the
// result at 2000 chars, so the conclusion of a long report was thrown away.
say('ingest keeps the message and drops the wrapper');
{
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
}

// Was: an owed item assigned to a task that landed was never mentioned again.
say('an owed item outliving its task is not lost quietly');
{
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
}

// Was: bundle merged everything describing the work but left defects and owed
// items naming a task it had just cancelled.
say('a bundle carries the absorbed task’s problems with it');
{
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
}

// Was: `readReg` locked before checking, and the lock's parent directory did not
// exist, so every command in a fresh project spun for ~7s then blamed a lock.
say('a project with no register says so');
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-blank-'));
  boxes.push(d);
  const t0 = Date.now();
  const res = drv(d, ['board']);
  ok('it says there is no register', has(res.out, 'no register'));
  ok('it does not blame a lock', !has(res.out, 'lock'));
  ok('and it does not spin first', Date.now() - t0 < 2000, (Date.now() - t0) + 'ms');
}

// A live holder must still be refused, or the fix above would have traded a bad
// message for a corrupt register.
say('the lock still holds against a live holder');
{
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
}

// Was: an edit to register.json from outside the tool became the trusted
// baseline at the very next command — commit() diffs against whatever is on
// disk — so the divergence was never recorded, never healed and never mentioned.
// Only a hand-run `verify` ever saw it.
say('an edit from outside the tool is noticed rather than absorbed');
{
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
}

// Was: `rebuild` is one of the two opposite fixes `verify` offers, and it
// overwrites the register from the record — then said "nothing was thrown away",
// which is true of backups/ and false of the file it just replaced.
say('rebuild names the ground it is about to take');
{
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
}

// Was: the backups are described as a second net, and on a gitignored register
// they are the only one — but their depth is counted in writes, not time, so a
// busy run silently thins the net. On a real run thirty states covered half an
// hour of three days, which is why the drift it carried could not be dated.
say('doctor says how far back the backup ring actually reaches');
{
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
}

// Was: r.ci held eight real results that no reader could reach any more.
say('legacy CI results become readable history and prove nothing');
{
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
}

// The archive is only safe because a removal is recorded like any other change.
say('archiving shrinks the register without breaking the record');
{
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
}

// ------------------------------------------------------------------ the parser
// Was: "takes a value unless the next word starts with --", so an agent whose
// words began with a dash had them replaced by the boolean true, and a flag
// nobody knew was dropped in silence while the command ran on without it.
say('the parser keeps what was written, and says so when it cannot');
{
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
}

// ------------------------------------------------------------------ the record
// Was: an empty record under a full register made `commit` append the delta
// alone, so the one line that resulted claimed to be the whole history and the
// next rebuild replayed it over the register — leaving {}.
say('a lost record does not take the register with it');
{
  const d = box('lostlog');
  fs.rmSync(path.join(d, '.claude/orchestration/events.jsonl'));
  drv(d, ['iam', 'zed']);
  drv(d, ['rebuild']);
  ok('the tasks are all still there', tasksOf(d).length === 3, tasksOf(d).length + ' task(s)');
  ok('and the record was seeded, not started as a delta', has(drv(d, ['verify']).out, 'agree exactly'));
}

// Was: rebuild, verify and log reseed wrote the register without taking the lock,
// landing on the same temp file a locked writer was using.
say('the commands that rewrite the record respect a lock somebody holds');
{
  const d = box('reclock');
  const lock = holdLock(d, process.pid);
  ok('rebuild waits and then refuses', drv(d, ['rebuild']).code !== 0);
  ok('verify does too', drv(d, ['verify']).code !== 0);
  ok('and so does log reseed', drv(d, ['log', 'reseed', '--why', 'x']).code !== 0);
  fs.rmSync(lock, { recursive: true, force: true });
}

// Was: --to rewound the register and left the log at full length, so every
// verify from then on reported the difference as damage.
say('rewinding the record moves both halves together');
{
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
}

// Was: the event's cmd column held the raw argv, and an argv leading with
// `--register <abs path>` pushed the command itself off the end of the line.
say('an event names the command even when --register comes first');
{
  const d = box('label');
  drv(d, ['--register', path.join(d, '.claude/orchestration/register.json'), 'iam', 'probe-name']);
  const first = drv(d, ['events', '--n', '1']).out.split('\n')[0];
  ok('the newest row says iam', has(first, 'iam'), first);
}

// Was: a record that is a directory came back as a raw Node stack trace out of
// every single command.
say('a record that is not a file is bad input, not a crash');
{
  const d = box('dirlog');
  const f = path.join(d, '.claude/orchestration/events.jsonl');
  fs.rmSync(f); fs.mkdirSync(f);
  const res = drv(d, ['verify']);
  ok('it says error and stops', res.code === 2 && has(res.out, 'error:'), 'exit ' + res.code);
  ok('and prints no stack trace', !traced(res.out));
}

// Was: a final line with no newline was concatenated with the next append, so
// two good events became one unreadable one and the reader dropped both — while
// verify went green on the loss because the register was never told.
say('a final line with no newline is closed, not welded to the next event');
{
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
}

// -------------------------------------------------------- dispatch, and the guard
// Was: "two tasks may not touch one file" was asserted in the error text above
// and then never checked against another task.
say('one path has one owner, and task add is where that is cheap to fix');
{
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
}

// Was: a chip could be opened with no id, on work that was already landed, on
// top of an unlanded requirement, or straight across something still open.
say('a chip only opens when it is safe to open one');
{
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
}

// Was: serialisation points were compared by exact string equality, so the check
// could only fire when two authors typed the same characters — and on the real
// run a docker-compose.yml collision this reported clean.
say('two chips may not move the same serialisation point, however it is spelled');
{
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
}

// Was: `git diff --name-only` with rename detection prints only a rename's
// destination, so `git mv other/x.ts src/x.ts` deleted a file the task did not
// own and guard called it clean. And the base was hardcoded to "main".
say('the guard sees a file renamed out of somewhere the task does not own');
{
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
}

// Was: the diff was built as a shell string, so a branch name was a command.
say('a branch name cannot run a command');
{
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
}

// Was: `done` was the one command an agent runs itself and the only one that did
// not check what state the task was in.
say('a report has to be about work that was actually handed out');
{
  const d = box('report');
  const never = drv(d, ['done', 't2'], { stdin: '{"verified":"v","outcome":"passed"}' });
  ok('a task nobody handed out cannot report', never.code !== 0 && has(never.out, 'never been handed out'));
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  const after = drv(d, ['done', 't1'], { stdin: '{"verified":"nothing","outcome":"failed"}' });
  ok('and a landed task cannot report again', after.code !== 0);
  ok('the landing survived the attempt', tasksOf(d).find((t) => t.key === 't1')?.status === 'landed');
}

// Was: landing did not ask whether the task had ever reported, nor whether what
// it was built on had landed.
say('nothing lands that has not reported, or that stands on unlanded work');
{
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
}

// Was: graph ended on "Nothing clashes. Every round above can run side by side."
// — an absolute sentence about a check that skips every pair with a landed side.
say('graph says what it actually looked at');
{
  const d = box('graph');
  const out = drv(d, ['graph']).out;
  ok('it counts the pairs it compared', has(out, 'pair(s) of tasks that could still collide were checked'));
  ok('and no longer claims a flat all-clear',
     !has(out, 'Nothing clashes. Every round above can run side by side.'));
}

// Was: an absorbed member's key still appeared in other tasks' `needs`, so the
// dependent was never placed and its chip could never open.
say('a bundle takes the dependencies of what it absorbed');
{
  const d = box('repoint');
  const out = drv(d, ['bundle', 't1', 't2', '--into', 't2']).out;
  ok('it says which task was repointed', has(out, 'repointed at t2'), out.split('\n').slice(-2)[0]);
  const t3 = tasksOf(d).find((t) => t.key === 't3') || {};
  ok('t3 now waits for the host', (t3.needs || []).includes('t2'));
  ok('and no longer for the cancelled member', !(t3.needs || []).includes('t1'));
  ok('so the graph can still be ordered', drv(d, ['graph']).code === 0);
}

// ------------------------------------------------------------------- the grill
// Was: SETTLED_HEADING matched "resolved" inside "Unresolved", so a section
// headed "Unresolved questions" silenced everything under it.
say('a section headed Unresolved is the opposite of settled');
{
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
}

// Was: the plain-words lint matched jargon as bare substrings, so "normal",
// "form", "platform", "performance" and "information" were all rejected.
say('ordinary English passes the plain-words lint and jargon still does not');
{
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
}

// Was: an empty gap list read the same as "everything was judged", and a status
// of "answered" was taken as the decision it only claims to be.
say('check will not call a session finished on a claim');
{
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
}

// ------------------------------------------------------------------ the ledger
// Was: attribution took the LONGEST key the message happened to mention, so a
// report from 1.1 that named 1.10 in passing was filed against 1.10.
say('a message belongs to the task it opens with');
{
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
}

// Was: a cut message was stored as a bare slice — no mark, no original length —
// so it was read afterwards as a complete statement.
say('a message too long to keep whole says so');
{
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
}

// Was: a `release` counted as an answer, so an agent waited for ever on a list
// that said nothing was waiting.
say('telling an agent to go ahead is not answering what it asked');
{
  const d = box('release');
  drv(d, ['heard', 't1', '--kind', 'question', '--text', 'which settings file did you mean']);
  drv(d, ['say', 't1', '--kind', 'release', '--text', 'released, rebase now']);
  ok('the question is still outstanding after a release',
     has(drv(d, ['outstanding']).out, 'asked you something'));
  drv(d, ['say', 't1', '--kind', 'reply', '--text', 'the one in config/']);
  ok('and only a reply clears it', !has(drv(d, ['outstanding']).out, 'asked you something'));
}

// Was: inbox, reply, ack, post and read were a whole message subsystem nothing
// called and nothing read back.
say('the dead message commands are gone');
{
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
}

// -------------------------------------------------------------------- the slot
// Was: `slot take` wrote a claim in a shape `slot run` did not read, so a slot
// held by hand did not hold at all.
say('a slot taken by hand holds against a run');
{
  const d = box('slot-hold');
  ok('taking it by hand works', drv(d, ['slot', 'take', 'ci', '--task', 'probe']).code === 0);
  const barge = drv(d, ['slot', 'run', 'ci', '--timeout', '1', '--', '/bin/echo', 'BARGED'],
    { timeout: 8000 });
  ok('a later run does not barge in', !has(barge.out, 'BARGED'));
  drv(d, ['slot', 'free', 'ci', '--force']);
  ok('and it can be handed back', !fs.existsSync(path.join(d, '.claude/orchestration/slots/ci.lock')));
}

// Was: the command after `--` was quoted word by word, so a leading VAR=value
// became a filename and the run died with 127.
say('a slot run takes a command that starts with an environment setting');
{
  const d = box('slot-env');
  const res = drv(d, ['slot', 'run', 'ci', '--', 'FOO=1', '/bin/echo', 'hi'], { timeout: 30000 });
  ok('it prints hi rather than exiting 127', res.code === 0 && /(^|\n)hi(\n|$)/.test(res.out),
     'exit ' + res.code + ': ' + res.out.split('\n').filter(Boolean).slice(-1)[0]);
}

// Was: the claim was taken with a plain existence check, so two runs starting at
// once both believed they had it — which is the crash the slot exists to stop.
say('two runs for one slot take their turn');
{
  const d = box('slot-race');
  const log = path.join(d, 'serial.log');
  fs.writeFileSync(log, '');
  const one = (n) => 'node ' + JSON.stringify(DRIVER) + ' slot run ci -- /bin/bash -c ' +
    JSON.stringify('echo START >> serial.log; sleep ' + n + '; echo END >> serial.log') + ' >/dev/null 2>&1 &';
  try {
    execFileSync('/bin/bash', ['-c', [one(3), 'sleep 1', one(1), 'wait'].join('\n')],
      { cwd: d, timeout: 60000, stdio: 'ignore' });
  } catch { /* the assertion below says what happened */ }
  const seen = readIf(log).split('\n').filter(Boolean).join(' ');
  ok('one finishes before the other starts', seen === 'START END START END', seen);
}

// Was: none of the words the heavy list looks for appear in "pnpm install", so
// every agent was told to run one bare and in parallel.
say('installing dependencies is heavy work and goes through the slot');
{
  const d = box('slot-install');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't2', verify: ['pnpm install', 'ruff check .'] }]) });
  const brief = drv(d, ['brief', 't2', '--stdout']).out;
  ok('pnpm install is put behind the slot wrapper', /with-ci-slot" pnpm install/.test(brief));
  ok('and a linter is still left to run straight away',
     /(^|\n)ruff check/.test(brief.replace(/.*with-ci-slot.*/g, '')));
}

// ------------------------------------------------------------------ stale briefs
// Was: briefSha was computed over fields the brief is not built from, or not at
// all, so an agent kept working from a brief the record had since contradicted.
say('a brief the record has moved past is called out');
{
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
}

// Was: cmdBrief rendered neither the task's own `notes` nor the pre-flight's
// notes, so a pre-flight — which exists to find what the plan missed before
// anyone starts — wrote its findings into a field the brief did not print. On a
// real run two thirds of tasks carried a note and every pre-flight finding was
// invisible to the agent it was written for.
say('a brief carries the notes the record holds for that task');
{
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
}

// Was: chip checked status, unmet needs and interference, and then said "can
// start now" over a brief the record had moved past — the one moment where the
// agent is about to start reading it. doctor said so and nothing stopped it.
say('chip will not hand over a brief the record has moved past');
{
  const d = box('chipstale');
  drv(d, ['brief', 't1']);
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', title: 'rewritten after briefing' }]) });
  const out = drv(d, ['chip', 't1', '--id', 'chip-t1']);
  ok('it refuses', out.code !== 0 && has(out.out, 'no longer matches the record'), out.out.split('\n')[0]);
  ok('and names the command that fixes it', has(out.out, 'brief t1'), out.out);
  ok('and no chip was recorded', !tasksOf(d).find((t) => t.key === 't1')?.chip);
  drv(d, ['brief', 't1']);
  ok('after re-briefing it opens', drv(d, ['chip', 't1', '--id', 'chip-t1']).code === 0);
}

// --------------------------------------------------------------- the grill, in full
// The gap commands are the register's edit surface. Together they take a plan
// with open questions, judge each candidate, settle it, and write the decisions
// file — and every one of them was part of the coverage gap before this block.
say('the grill runs a gap all the way to a rendered decision');
{
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
}

// A gap added by hand (via `add`) is a candidate for the same lifecycle, and a
// question marked batched lands on the batch list instead of being asked now.
say('an added gap can be batched and batched ones are approved in one list');
{
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
}

// -------------------------------------------------------------- refining a plan
// Refinement turns a settled plan into a buildable one. It reads the agent's own
// report file, records the proposed tasks, and reopens gaps it found.
say('refine drives a plan from settled to buildable');
{
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
}

// A refine done report can also come over stdin when the file is missing, but it
// must be told that is second best.
say('refine done falls back to stdin and says the file is better');
{
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
}

// Was: `refine brief` reads g.answer.choice and was the one such reader with no
// check that there is an answer to read, so a gap marked answered with nothing
// under it threw a raw TypeError out of the driver.
say('refine brief names a hollow claim rather than throwing');
{
  const d = planBox('refhollow', '# a plan\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'scope=in']);
  forceHollow(d, g);
  const out = drv(d, ['refine', 'brief', 'plan']);
  ok('it refuses', out.code !== 0);
  ok('it says which gap and what fixes it', has(out.out, g) && has(out.out, 'answer ' + g), out.out.split('\n')[1]);
  ok('and no stack trace reaches the user', !traced(out.out), out.out.slice(0, 200));
}

// ---------------------------------------------------------------- pre-flight
// A read-only agent tests a task's owns against the code before a chip exists.
say('pre-flight finds what the record missed and gates the round');
{
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
}

// ------------------------------------------------------------ whoami and the rest
// whoami reads the local session registry; a missing registry is a clean error.
say('whoami says when there is no session registry');
{
  const d = bare('whoami');
  const home = path.join(d, 'home');
  // Point HOME at a dir with no registry so the error path is real, not env wild.
  const old = process.env.HOME;
  process.env.HOME = home;
  const res = drv(d, ['whoami']);
  process.env.HOME = old;
  ok('whoami names the missing registry', res.code !== 0 && has(res.out, 'no session registry'));
}

// -------------------------------------------------------------- release, resume
// A task that has never been handed out has no chip; release refuses on a held
// task that is still waiting, and a live task with a landed requirement can be
// released.
say('release refuses blocked work and frees what it can');
{
  const d = box('release2');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  // t3 waits on t1; t1 is still unlanded, so t3's chip refuses.
  const c3 = drv(d, ['chip', 't3', '--id', 'chip-t3']);
  ok('a chip does not open on top of unlanded work', c3.code !== 0 && has(c3.out, 'still waits for t1'));
  // Release t1 after it has checked in.
  drv(d, ['agent', 't1', '--name', 'peer-a']);
  const rel = drv(d, ['release', 't1']);
  ok('release tells the agent to start', rel.code === 0 && has(rel.out, 'you may start'));
}

// ------------------------------------------------------------------- ci and wave
say('ci records a green run and the next round may open');
{
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
}

// ------------------------------------------------------------- bundle suggest
// Two unstarted, non-interfering siblings share a plan; suggest proposes one chip.
say('bundle suggest names the siblings worth merging');
{
  const d = box('bundle-suggest');
  ok('bundle suggest proposes a group', has(drv(d, ['bundle', 'suggest']).out, 'one chip'));
}

// Was: members were stored in whatever order the command line gave, and the
// brief printed the host first whether or not it was first — so a step could be
// listed above the step it needs. `bundle suggest` built its suggestion from
// discovery order too, and so suggested a command line with the same fault.
say('a bundled brief lists a step after the step it needs');
{
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
}

// --------------------------------------------------------------- hook install
// The SessionStart hook rewrites settings.json; installing twice is a no-op.
say('hook-install writes a SessionStart hook and is idempotent');
{
  const d = box('hook');
  const first = drv(d, ['hook-install']);
  ok('it writes the hook once', first.code === 0 && has(first.out, 'added a SessionStart hook'));
  const second = drv(d, ['hook-install']);
  ok('installing again says it is already there', has(second.out, 'already installed'));
  const settings = JSON.parse(fs.readFileSync(path.join(d, '.claude/settings.json'), 'utf8'));
  ok('the hook is on SessionStart', (settings.hooks.SessionStart || []).length === 1);
}

// -------------------------------------------------------------- resume the run
// A dead session's address is replaced; agents are re-announced.
say('resume takes over a run and names what to do next');
{
  const d = box('resume');
  drv(d, ['iam', 'old-boss']);
  ok('resume needs a name', drv(d, ['resume']).code !== 0);
  const out = drv(d, ['resume', '--name', 'new-boss']);
  ok('resume records the new address', out.code === 0 && has(out.out, 'now yours'));
  ok('the register carries it', (reg(d).orchestrator) === 'new-boss');
}

// ------------------------------------------------- load with globs and dirs
// A plan directory (or glob) is walked for plan files; a wildcard matches a
// segment at a time so `docs/**/*.md` resolves instead of looking literally.
say('load walks a directory and resolves a glob across nesting');
{
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
}

// ------------------------------------------------------------ list and status
// list filters by status, scope and plan; status reports the open and unsettled.
say('list filters the gap register and status reports the open ones');
{
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
}

// --------------------------------------------------------------- render --plan
// render can emit just the settled decisions for one plan, as a table to paste.
say('render --plan prints the settled table for one plan');
{
  const d = planBox('renderplan', '# the plan\n\n## What is open\n\nThe retry limit is TBD.\nThe upload cap is TBD too.\n');
  drv(d, ['scan']);
  const gs = gapsOf(d);
  const g0 = gs[0].id;
  drv(d, ['set', g0, 'status=gap', 'scope=in', 'title=Retry']);
  drv(d, ['answer', g0], { stdin: JSON.stringify({ choice: 'Store it', note: 'decided' }) });
  for (const x of gs) { if (x.id === g0) continue; drv(d, ['set', x.id, 'status=dropped']); }
  const out = drv(d, ['render', '--plan', 'docs/plan.md']);
  ok('render --plan emits the decision table', out.code === 0 && has(out.out, '| Decision | Choice |'));
}

// ----------------------------------------------------- a long decision is interned
// A standing decision repeated across tasks is stored once and referenced by a
// hash, so the register does not carry 413 KB of byte-identical text.
say('a repeated long decision is interned, not duplicated');
{
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
}

// ---------------------------------------------------------------- brief --all
// brief --all rewrites every open task's brief; an unchanged one writes nothing.
say('brief --all rewrites the open briefs and says which changed');
{
  const d = box('briefall');
  drv(d, ['brief', 't1']);
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['agent', 't1', '--name', 'peer-a']);
  const out = drv(d, ['brief', '--all']);
  ok('brief --all checks the open briefs in', out.code === 0 && has(out.out, 'brief(s) checked in'));
  ok('previously-written briefs are recognised as current', has(out.out, 'already current'));
}

// ------------------------------------------------------------------ whoami
// whoami --session reads one session's name from the registry.
say('whoami --session reads a name from the local session registry');
{
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
}

// -------------------------------------------------------------- ingest reclean
// A message recovered before the wrapper was stripped can be re-derived.
say('ingest --reclean re-derives entries already stored');
{
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
}

// ----------------------------------------------------- wave across earlier rounds
// wave names the earlier round still holding the current one up.
say('wave says which earlier round is still blocking');
{
  const d = box('waveblock');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  const out = drv(d, ['wave', '--wave', '2']).out;
  ok('wave names the earlier unfinished round', has(out, 'Earlier rounds still holding this one up') && has(out, 't2'));
}

// ---------------------------------------------------------------- events filters
// events narrows by sequence, task and grep — and reports how many it showed.
say('events filters by task, grep and since');
{
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
}

// Was: `lintText` names reference/plain-words.md as the authority for what it
// refuses, and was catching eighteen of the thirty-two words that file forbids.
// A question could reach the user saying "add a soft delete and a throttle,
// using RBAC to gate it" and be told it passed the plain-words rules.
say('the plain-words filter refuses every word its own reference forbids');
{
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
}

// ---------------------------------------------------- lint with nothing to say
// lint with no question yet is a calm message, not a crash.
say('lint says when no question has been written');
{
  const d = planBox('lintnone', '# p\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  ok('lint reports no questions written', drv(d, ['lint']).code === 0 && has(drv(d, ['lint']).out, 'no questions written yet'));
}

// ------------------------------------------------------- a missing task is named
// A command that names a task that is not on the record says the list it had.
say('a command names the task when one is missing');
{
  const d = box('missingtask');
  const res = drv(d, ['show', 'no-such']);
  ok('show says there is no such gap', res.code !== 0 && has(res.out, 'no gap no-such'));
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['agent', 't1', '--name', 'peer-a']);
  const rel = drv(d, ['release', 'ghost']);
  ok('release names the task it cannot find', rel.code !== 0 && has(rel.out, 'no task "ghost"'));
}

// ------------------------------------------------------------- task create/update
// task add ignores fields it does not set, and an update keeps a task's state.
say('task add records what it can and ignores the rest');
{
  const d = box('taskadd');
  const out = drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', title: 'first, rewritten', owns: ['src/a.py'], ignored: 'nope' },
  ]) });
  ok('a re-add updates the task in place', out.code === 0 && (tasksOf(d).find((t) => t.key === 't1')?.title === 'first, rewritten'));
  ok('the update keeps unrelated state', (tasksOf(d).find((t) => t.key === 't1')?.needs || []).length === 0);
  ok('the ignored field is reported, not saved', has(out.out, 'ignored'));
}

// ------------------------------------------------------------------ agent note
// agent on a task with a need that is not on the record says so.
say('agent points out a dependency that is not on the record');
{
  const d = box('agentnote');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', needs: ['missing-dep'] }]) });
  const out = drv(d, ['agent', 't1', '--name', 'peer-a']);
  ok('agent flags the unresolvable need', out.code === 0 && has(out.out, 'not on record'));
}

// ------------------------------------------------------------ ci, in its cover
// Red records a defect and names the landed work it covers; skipped needs a why.
say('ci covers red, skipped and an empty list');
{
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
}

// ------------------------------------------------------------------ slot doors
// slot status and free on an empty slot are calm; take claims it by hand.
say('slot status and free speak plainly when nothing is held');
{
  const d = box('slots');
  ok('slot status says nothing is held', has(drv(d, ['slot', 'status']).out, 'no slot is held'));
  ok('slot free says it was already free', has(drv(d, ['slot', 'free', 'ci']).out, 'already free'));
  const take = drv(d, ['slot', 'take', 'ci', '--task', 't1']);
  ok('slot take claims it by hand', take.code === 0 && has(take.out, 'taken'));
  const taken = drv(d, ['slot', 'take', 'ci', '--task', 't1']);
  ok('a second take is refused', taken.code !== 0 && has(taken.out, 'held by'));
}

// --------------------------------------------------------- board reports state
// Board shows the round, open owed items, and held work that can now start.
say('board reports the round and any held-but-freed work');
{
  const d = box('boardstate');
  drv(d, ['owed', 'add', '--to', 't1', '--what', 'drop the shim', '--why', 'window']);
  const out = drv(d, ['board']).out;
  ok('board names the owed item', has(out, 'owed: 1 open'));
  ok('board names the round', has(out, 'round 1 of 2'));
}

// ----------------------------------------------------- ingest from a transcript
// ingest reads the transcript directory under ~/.claude/projects, and an
// entry written from a subdirectory of the run still belongs to it.
say('ingest finds the transcript directory and keeps a subdir-cwd line');
{
  const d = box('ingestsub');
  // Override HOME so transcriptDir resolves to our scratch dir, and write a
  // transcript whose cwd is a subdirectory of this run.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-home-'));
  const proj = path.join(fakeHome, '.claude/projects');
  fs.mkdirSync(proj, { recursive: true });
  const projDir = path.join(proj, d.replace(/[/_]/g, '-'));
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
}

// --------------------------------------------------------------- owed settles
// owed done and defect fixed record a resolution.
say('owed done and defect fixed record a resolution');
{
  const d = box('oweddone');
  drv(d, ['owed', 'add', '--what', 'drop the shim', '--why', 'window']);
  const oid = (reg(d).owed || [])[0].id;
  drv(d, ['defect', 'add', '--task', 't1', '--kind', 'bug', '--what', 'w']);
  const did = (reg(d).defects || []).find((x) => x.task === 't1').id;
  ok('owed done settles it', has(drv(d, ['owed', 'done', oid]).out, 'settled'));
  ok('defect fixed clears it', has(drv(d, ['defect', 'fixed', did]).out, 'marked fixed'));
}

// --------------------------------------------------------- render, in its cover
// render with nothing answered dies; a hollow "answered" is refused cleanly.
say('render refuses an empty register and a hollow answer');
{
  const d = planBox('rendernone', '# p\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const none = drv(d, ['render']);
  ok('render with nothing answered says so', none.code !== 0 && has(none.out, 'nothing answered yet'));
  const g = gapsOf(d)[0].id;
  forceHollow(d, g);                       // a claim with no answer under it
  const hollow = drv(d, ['render']);
  ok('render refuses a hollow answered claim', hollow.code !== 0 && has(hollow.out, 'no answer recorded'));
}

// ------------------------------------------------------ refine check, all gates
// refine check refuses unrefined plans and a reopened gap, and reads git status.
say('refine check names every plan still unrefined');
{
  const d = planBox('refinecheck', '# p\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'status=gap', 'scope=in']);
  drv(d, ['answer', g], { stdin: JSON.stringify({ choice: 'Store it' }) });
  const chk = drv(d, ['refine', 'check']);
  ok('refine check refuses a never-refined plan', chk.code !== 0 && has(chk.out, 'not refined'));
}

// --------------------------------------------------------- graph, the collision
// graph reports two tasks that move the same serialisation point.
say('graph names a shared serialisation point');
{
  const d = box('graphpoint');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't2', serialises: ['alembic-head'] },
  ]) });
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', serialises: ['alembic-head'] },
  ]) });
  const out = drv(d, ['graph']);
  ok('graph names the shared point', out.code !== 0 && has(out.out, 'serialisation point'));
}

// Was: `covers` was every landed task in the round, resolved when the checkpoint
// was filed — so a task that landed WHILE CI was running was written down as
// proven by a run that never contained its code. Under ordinary use (land, kick
// CI, land again, record) that is not a risk, it is what happens.
say('a checkpoint proves only the work the run actually contained');
{
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
}

// Was: `landed` checked unmet needs and nothing else, so a task could land on
// top of its own open guard failure — and a clean guard wrote nothing at all, so
// afterwards there was no way to ask whether one had ever run.
say('nothing lands over a known break, and a guard leaves a trace');
{
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
}

// ------------------------------------------------------------- frontier, unproven
// A landing with no CI checkpoint is reported as unproven drift.
say('frontier reports landings beyond the last checkpoint');
{
  const d = box('frontierunproven');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  ok('frontier names the unproven landing', has(drv(d, ['frontier']).out, 'since the last CI checkpoint'));
}

// Was: `unblocks N` counted every task naming this one in `needs`, whatever its
// status — so work absorbed by `bundle` (which cancels rather than deletes) kept
// inflating the count AND the sort that decides what to offer opening next.
say('unblocks does not count work that has been absorbed');
{
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
}

// ------------------------------------------------------------------ whoami here
// whoami lists the sessions for this directory.
say('whoami lists the sessions for this directory');
{
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
}

// --------------------------------------------------- brief with a context it owns
// A brief says when a context path is also one of the files it may change.
say('brief marks a context it also owns as enditable');
{
  const d = box('briefcontext');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', context: [{ path: 'src/a.py', what: 'the helper' }], owns: ['src/a.py'] },
  ]) });
  ok('brief resolves a context path it also owns', drv(d, ['brief', 't1', '--stdout']).code === 0 &&
     !/\(read it, do not change it/.test(drv(d, ['brief', 't1', '--stdout']).out));
}

// ---------------------------------------------------------------- doctor points
// A serialisation point named by only one task gates nothing; doctor says so.
say('doctor reports a serialisation point nobody shares');
{
  const d = box('doctorlone');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', serialises: ['alembic-head'] }]) });
  const out = drv(d, ['doctor']);
  ok('doctor names the lone serialisation point', has(out.out, 'only one task names') && has(out.out, 'alembic-head'));
}

// Was: doctor computed exactly this and then reported only the lone case — the
// inverse question. `chip` refuses to open a second task on a point somebody
// holds, but `task add` can widen `serialises` on a task already in flight, and
// nothing looked afterwards.
say('two chips may not take one serialisation point, and doctor says when they have');
{
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
}

// Was: every path the register holds was resolved against whatever directory the
// command was run from, not against the project the register describes. Point
// --register at a project and stand somewhere else and doctor invents a "does
// not exist" failure for every plan and context path in a perfectly sound tree.
say('doctor judges paths against the project, not the shell');
{
  const d = box('doctorcwd');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', context: [{ path: 'docs/plans/p.md', what: 'the plan' }] },
  ]) });
  const abs = path.join(d, '.claude/orchestration/register.json');
  const here = drv(d, ['doctor', '--register', abs]).out;
  const away = drv(os.tmpdir(), ['doctor', '--register', abs]).out;
  ok('from the project root it finds every cited path', !has(here, 'does not exist'), here.slice(0, 300));
  ok('and from anywhere else it says the same thing', !has(away, 'does not exist'), away.slice(0, 300));
}

// Was: a pre-flight report is an ordinary file, and nothing but a person running
// `preflight done` folds it in. That step is required nowhere, so a report could
// be written and simply never acted on — 25 of 53 were, on a real run.
say('doctor names a pre-flight report nobody folded in');
{
  const d = box('doctororphan');
  const rep = path.join(d, '.claude/orchestration/preflight/t2.json');
  fs.mkdirSync(path.dirname(rep), { recursive: true });
  fs.writeFileSync(rep, JSON.stringify({ missing: [], serialises: [], verify: [], notes: 'nobody read this' }) + '\n');
  const out = drv(d, ['doctor']);
  ok('doctor names the unfolded report',
     has(out.out, 'never folded into the record') && has(out.out, 't2'), out.out.slice(0, 300));
  ok('and it counts as a problem', out.code !== 0);
}

// Was: `refined` was set both by an older driver that kept no report and by this
// one, which does. Nothing told them apart, so "the evidence predates this log"
// read exactly like "marked refined, never actually done" — half the plans on a
// real run were in that state and nothing said so.
say('doctor names a plan marked refined with nothing behind it');
{
  const d = box('doctorrefined');
  const p = path.join(d, '.claude/orchestration/register.json');
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  r.plans[0].refined = true;                       // as an older driver left it
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
  const out = drv(d, ['doctor']).out;
  ok('doctor names it', has(out, 'marked refined with no report on disk') && has(out, r.plans[0].path),
     out.slice(0, 300));
}

// --------------------------------------------------------------- ci next round
// Green with open owed items warns; a green close names the next round.
say('ci green names the next round and flags open owed items');
{
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
}

// ------------------------------------------------------------- digest and outstanding
// digest and outstanding both surface what is still waiting.
say('digest and outstanding surface the waiting work');
{
  const d = box('digestout');
  drv(d, ['heard', 't1', '--kind', 'question', '--text', 'which settings file did you mean']);
  ok('outstanding names the question', has(drv(d, ['outstanding']).out, 'asked you something'));
  ok('digest names it too', has(drv(d, ['digest']).out, 'Waiting on you'));
}

// --------------------------------------------------------- board, in its cover
// board shows a stuck-held task and a trespass in the main checkout.
say('board flags both stale briefs and a main-checkout trespass');
{
  const d = box('boardtres');
  // a dirty file that a task owns is a trespass
  fs.writeFileSync(path.join(d, 'src/a.py'), 'changed\n');
  const out = drv(d, ['board']).out;
  ok('board names the trespass', has(out, 'main checkout has changes') && has(out, 'src/a.py'));
}

// Was: trespass matched a dirty file against tasks of any status, so every edit
// to a file after its task had landed was reported as a violation — and the
// remedy it printed, "let t1 do it in its own copy", named a copy that no
// longer exists.
say('a file edited after its task landed is not a trespass');
{
  const d = box('trespassdone');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"commit":"abc","verified":"ran true; it said true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  fs.writeFileSync(path.join(d, 'src/a.py'), 'a later, unrelated change\n');
  const out = drv(d, ['board']).out;
  ok('board does not call it a trespass', !has(out, 'main checkout has changes'),
     out.split('\n').filter((l) => has(l, 'src/a.py')).join(' | '));
}

// -------------------------------------------------------------- slot run, wait
// slot run takes the slot, runs a command, and frees it; wait only waits.
say('slot run executes behind the slot and a stale holder is taken over');
{
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
}

// Was: SKILL.md and the README both promise a holder whose process is still
// there is waited on however long it runs — a suite that legitimately outlasts
// any limit is still running, and starting a second beside it is the crash the
// slot exists to prevent. The waiter applied its timeout regardless, so the
// guarantee held everywhere except the case it was written for.
say('a slot holder that is alive is waited on past the limit, as promised');
{
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
}

// --------------------------------------------------------- bundle carries a preflight
// Bundling absorbs a member's pre-flight into the host, and says what never flew.
say('bundle carries a member pre-flight to the host');
{
  const d = box('bundlecarry');
  const rep = path.join(d, '.claude/orchestration/preflight/t2.json');
  fs.mkdirSync(path.dirname(rep), { recursive: true });
  fs.writeFileSync(rep, JSON.stringify({ missing: [{ path: 'src/b.js', why: 'the helper', evidence: 'src/a.js:3', loadBearing: true }],
    serialises: [], verify: [], notes: 'carried' }) + '\n');
  drv(d, ['preflight', 'done', 't2']);
  const out = drv(d, ['bundle', 't1', 't2', '--into', 't1']);
  ok('the bundle carried the pre-flight gap', has(out.out, 'carried across: 1 pre-flight gap(s)'));
  ok('and said the never-flown member', has(out.out, 'never pre-flighted'));
}

// ------------------------------------------------------------- render in detail
// A full render writes rejected alternatives, conditions and reach-back notes.
say('render writes the rejected, carried and reach-back detail');
{
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
}

// ------------------------------------------------ owed assign to finished work
// owed assign refuses a task whose window is already shut.
say('owed assign refuses work that is already over');
{
  const d = box('owedshut');
  drv(d, ['owed', 'add', '--to', 't1', '--what', 'drop the shim', '--why', 'window']);
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  const oid = (reg(d).owed || [])[0].id;
  const res = drv(d, ['owed', 'assign', oid, '--to', 't1']);
  ok('assign to landed work is refused', res.code !== 0 && has(res.out, 'window is already shut'));
}

// ------------------------------------------ brief narrows a whole-tree check
// A pathable verify command is narrowed to the files the task actually owns.
say('brief narrows a whole-tree linter to the owned files');
{
  const d = box('scopetool');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', verify: ['ruff .'], owns: ['src/a.py'] }]) });
  const out = drv(d, ['brief', 't1', '--stdout']);
  ok('brief rewrites the whole-tree check', has(out.out, 'ruff src/a.py'));
}

// ------------------------------------------------------------- render across plans
// render reports which plans gained a decision and which were left alone.
say('render names the plans it touched and those it left');
{
  const d = planBox('rendertouch', '# p\n\n## What is open\n\nThe retry limit is TBD.\n\nThe upload cap is TBD too.\n');
  drv(d, ['scan']);
  const gs = gapsOf(d);
  const g0 = gs[0].id;
  drv(d, ['set', g0, 'status=gap', 'scope=in', 'title=Retry']);
  drv(d, ['answer', g0], { stdin: JSON.stringify({ choice: 'Store it' }) });
  for (const x of gs) { if (x.id === g0) continue; drv(d, ['set', x.id, 'status=dropped']); }
  const out = drv(d, ['render']);
  ok('render writes the decisions file', out.code === 0 && has(out.out, 'wrote'));
}

// ------------------------------------------------------- re-refinding a live task
// refine done on a task that already exists widens it rather than resetting it.
say('refine done widens a task that is already on the record');
{
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
}

// ---------------------------------------------------- digest with owed and drift
// digest reports an open owed item and unproven landings.
say('digest reports owed work and unproven landings');
{
  const d = box('digestdrift');
  drv(d, ['owed', 'add', '--to', 't1', '--what', 'drop the shim', '--why', 'window']);
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  drv(d, ['landed', 't1', '--sha', 'abc']);
  const out = drv(d, ['digest']).out;
  ok('digest names the open owed item', has(out, '**Owed**'));
  ok('digest reports unproven landings', has(out, 'landing(s) since the last CI checkpoint'));
}

// ------------------------------------------------------ outstanding, a report
// outstanding names work that has reported and is waiting on the check.
say('outstanding names reported work awaiting the check');
{
  const d = box('outreport');
  drv(d, ['chip', 't1', '--id', 'chip-t1']);
  drv(d, ['done', 't1'], { stdin: '{"verified":"ran true","outcome":"passed"}' });
  ok('outstanding puts the report on you', has(drv(d, ['outstanding']).out, 'waiting on your check'));
}

// ----------------------------------------------------------- ingest wrapper note
// ingest says when it re-derived an entry that had carried the wrapper.
say('ingest says when an old entry still carries the wrapper');
{
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
}

// ------------------------------------------ graph's mid-edit and read-only notes
// graph flags a task reading a file another task is rewriting in the same round.
say('graph flags a task reading a file a sibling is rewriting');
{
  const d = box('graphcontext');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', context: [{ path: 'src/b.py', what: 'the helper' }] },
  ]) });
  const out = drv(d, ['graph']);
  ok('graph names the mid-edit read', out.code !== 0 && has(out.out, 'mid-edit'));
}

// --------------------------------------------------------- graph, read-only note
// A task builds on a path it may not change, and the owner is also open.
say('graph says when a build-on path is read-only');
{
  const d = box('graphreadonly');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 't1', context: [{ path: 'src/b.py', what: 'the helper' }], owns: ['src/a.py'] },
  ]) });
  const out = drv(d, ['graph']);
  ok('graph names the read-only build-on', has(out.out, 'read-only'));
}

// ---------------------------------------------------------- tasks and their shape
// task add validates a context field and refuses a malformed one.
say('task add refuses a malformed context entry');
{
  const d = box('taskcontext');
  const res = drv(d, ['task', 'add'], { stdin: JSON.stringify([
    { key: 'x1', title: 'x', plan: 'docs/plans/p.md', owns: ['src/z.py'], needs: [], context: ['not-an-object'] },
  ]) });
  ok('a context that is not {path, what} is refused', res.code !== 0 && has(res.out, 'context must be'));
}

// --------------------------------------------------------- render, plan by plan
// render wrote one plan's decisions and left the other alone.
say('render touches one plan and names the other untouched');
{
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
}

// ------------------------------------------------------- refine with no tasks
// A refinement that proposes no task cannot be handed out.
say('refine check refuses a refinement that produced no task');
{
  const d = planBox('refinenotasks', '# p\n\n## What is open\n\nThe retry limit is TBD.\n');
  drv(d, ['scan']);
  const g = gapsOf(d)[0].id;
  drv(d, ['set', g, 'status=gap', 'scope=in']);
  drv(d, ['answer', g], { stdin: JSON.stringify({ choice: 'Store it' }) });
  drv(d, ['refine', 'done', 'plan'], { stdin: JSON.stringify({ summary: 'ok', builtOn: [], tasks: [], newGaps: [] }) });
  const chk = drv(d, ['refine', 'check']);
  ok('refine check refuses with no task proposed', chk.code !== 0 && has(chk.out, 'no tasks proposed'));
}

// ------------------------------------------- brief narrows a check in a subdir
// A whole-tree check scoped to a subdirectory is rebased onto those paths.
say('brief rebases a check that already runs in a subdirectory');
{
  const d = box('scopecwd');
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', verify: ['ruff --directory apps/api .'], owns: ['apps/api/src/a.py'] }]) });
  const out = drv(d, ['brief', 't1', '--stdout']);
  ok('brief keeps the tool in its subdirectory', has(out.out, 'ruff --directory apps/api'));
}

// -------------------------------------------------------------- defect list
// defect list shows open defects and --all the settled ones.
say('defect list separates open from fixed');
{
  const d = box('defectlist');
  drv(d, ['defect', 'add', '--task', 't1', '--kind', 'bug', '--what', 'a wrong helper']);
  const did = (reg(d).defects || []).find((x) => x.task === 't1').id;
  ok('defect list shows the open one', has(drv(d, ['defect', 'list']).out, did));
  drv(d, ['defect', 'fixed', did]);
  ok('defect list hides a fixed one', !has(drv(d, ['defect', 'list']).out, did));
  ok('defect list --all shows it again', has(drv(d, ['defect', 'list', '--all']).out, did));
}

// ----------------------------------------------------------------- the real corpus
// Everything else in this file was written to satisfy the check it feeds. This
// was not: it is a real run's record and register, trimmed but not invented.
say('verify is green on a recorded run nobody made up');
{
  const d = corpusBox('corpus');
  const out = drv(d, ['verify']);
  ok('the record replays to the register exactly', out.code === 0 && has(out.out, 'agree exactly'),
     out.out.split('\n').slice(0, 3).join(' '));
  ok('and it is a run of some size', tasksOf(d).length >= 20 &&
     readIf(path.join(d, '.claude/orchestration/events.jsonl')).split('\n').filter(Boolean).length >= 400);
}


// ============================================================================
// The eight instruction gaps — every one found by running the skill, not by
// reading it. Each case below failed before the fix it guards; the comment says
// what the old behaviour was, so the check can be watched failing.
// ============================================================================

// ------------------------------------------------- ownership on the UPDATE path
{
  say('task add re-checks ownership when an update widens owns');
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
}

// ------------------------------------------- a path in a pre-flight is a path
{
  say('preflight done refuses prose where a path belongs');
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
}

{
  say('doctor names an owns entry that is not a path');
  const d = box('docpath');
  // was: nothing anywhere reported prose sitting in owns. It matches itself, so
  // `preflight check` goes green on it and the pollution stops being visible.
  const r0 = reg(d);
  r0.tasks.find((t) => t.key === 't1').owns.push('the verify list itself');
  fs.writeFileSync(path.join(d, '.claude/orchestration/register.json'), JSON.stringify(r0, null, 2));
  const r = drv(d, ['doctor']);
  ok('doctor reports it', has(r.out, 'not a path') && has(r.out, 'the verify list itself'), r.out);
  ok('and fails on it', r.code !== 0);
}

// ----------------------------------------------- amending an owed item in place
{
  say('owed edit amends a claim that turned out wrong');
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
}

// ------------------------------------------------------- repointing a moved plan
{
  say('a renamed plan is repointed, not appended beside itself');
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
}

// --------------------------------------------- what a checkpoint actually proves
{
  say('a checkpoint says which work it newly proves');
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
}

// -------------------------------------------------- the two kind vocabularies
{
  say('say and heard name both kind vocabularies');
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
}

// -------------------------------------------- brief --all under a running agent
{
  say('brief --all can be asked what it would disturb');
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
}

// ------------------------------------------ the address, and who is really there
{
  say('agent checks the address against the task\'s worktree');
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
}

// ---------------------------------------------------------------------- report
if (!KEEP) for (const d of boxes) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
else console.log('\nsandboxes kept: ' + boxes.join('\n                '));

// The count is an assertion too. Without it a whole block can stop executing —
// an exception thrown before its first `ok`, a case quietly commented out — and
// the suite still ends on "all green", because green is only ever measured
// against however many checks happened to run.
const EXPECTED = 423;   // every check above counts; raise it deliberately when you add one

console.log('\n' + '-'.repeat(60));
if (pass + failures.length !== EXPECTED)
  failures.push('the suite ran ' + (pass + failures.length) + ' checks, not ' + EXPECTED +
    '\n      A block stopped part way, or a check was added without updating EXPECTED.');
if (!failures.length) { console.log(pass + ' checks, all green.'); process.exit(0); }
console.log(pass + ' passed, ' + failures.length + ' FAILED:');
for (const f of failures) console.log('  ✗ ' + f);
process.exit(1);
