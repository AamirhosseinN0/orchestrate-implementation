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
function drv(cwd, args, { stdin, timeout } = {}) {
  try {
    const out = execFileSync(process.execPath, [DRIVER, ...args],
      { cwd, encoding: 'utf8', input: stdin, timeout, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const lock = path.join(d, '.claude/orchestration/register.json.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'holder.json'),
    JSON.stringify({ pid: process.pid, host: os.hostname(), since: new Date().toISOString() }));
  ok('a live holder is not robbed', drv(d, ['iam', 'x']).code !== 0);
  fs.writeFileSync(path.join(lock, 'holder.json'),
    JSON.stringify({ pid: 0x7ffffff, host: os.hostname(), since: new Date().toISOString() }));
  ok('a dead holder is taken over', drv(d, ['iam', 'x']).code === 0);
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
  drv(d, ['rebuild', '--to', String(seq)]);
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
  const lock = path.join(d, '.claude/orchestration/register.json.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'holder.json'),
    JSON.stringify({ pid: process.pid, host: os.hostname(), since: new Date().toISOString() }));
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
  drv(d, ['rebuild', '--to', String(seq - 2)]);
  ok('verify is still green after a partial rebuild', has(drv(d, ['verify']).out, 'agree exactly'));
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
  drv(d, ['set', g, 'status=answered']);
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
  drv(d, ['task', 'add'], { stdin: JSON.stringify([{ key: 't1', notes: 'a note changes nothing' }]) });
  ok('a note-only change does not cry stale on its own',
     has(drv(d, ['brief', 't1']).out, 'wrote ') &&
     !has(drv(d, ['board']).out, 'record changed after these briefs'));
}

// ------------------------------------------------------------- the real corpus
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

// ---------------------------------------------------------------------- report
if (!KEEP) for (const d of boxes) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
else console.log('\nsandboxes kept: ' + boxes.join('\n                '));

// The count is an assertion too. Without it a whole block can stop executing —
// an exception thrown before its first `ok`, a case quietly commented out — and
// the suite still ends on "all green", because green is only ever measured
// against however many checks happened to run.
const EXPECTED = 143;   // every check above counts; raise it deliberately when you add one

console.log('\n' + '-'.repeat(60));
if (pass + failures.length !== EXPECTED)
  failures.push('the suite ran ' + (pass + failures.length) + ' checks, not ' + EXPECTED +
    '\n      A block stopped part way, or a check was added without updating EXPECTED.');
if (!failures.length) { console.log(pass + ' checks, all green.'); process.exit(0); }
console.log(pass + ' passed, ' + failures.length + ' FAILED:');
for (const f of failures) console.log('  ✗ ' + f);
process.exit(1);
