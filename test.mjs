#!/usr/bin/env node
// End-to-end sweep. Builds a throwaway run in a temp git repo, drives it through
// the whole lifecycle, and asserts on what the commands actually print and write.
//
// Every case here failed before the fix it guards. A check nobody has watched
// fail is not a check, so where a case guards a specific defect the comment says
// what the old behaviour was.
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
function drv(cwd, args, { stdin } = {}) {
  try {
    const out = execFileSync(process.execPath, [DRIVER, ...args],
      { cwd, encoding: 'utf8', input: stdin, stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}
const readIf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const reg = (d) => JSON.parse(fs.readFileSync(path.join(d, '.claude/orchestration/register.json'), 'utf8'));
const ledger = (d) => fs.readFileSync(path.join(d, '.claude/orchestration/messages.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

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

// --------------------------------------------------------------- the lifecycle
say('a run goes all the way through');
{
  const d = box('life');
  ok('three tasks are on the board', has(drv(d, ['board']).out, 't1'));
  ok('graph reports no collision', drv(d, ['graph']).code === 0);
  ok('t3 waits, t1 and t2 can open', has(drv(d, ['frontier']).out, 't3'));
  ok('a brief is written to a file', drv(d, ['brief', 't1']).code === 0 &&
     fs.existsSync(path.join(d, '.claude/orchestration/briefs/t1.md')));
  drv(d, ['chip', 't1', '--branch', 'step/t1']);
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
  ok('and is not also reported as spoke-last', (o.match(/spoke last/g) || []).length === 0);
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
  drv(d, ['ingest', '--from', fx]);
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
  ok('none of them covers anything', (r2.checkpoints || []).filter((c) => c.legacy).every((c) => (c.covers || []).length === 0));
  ok('their reasoning survived', has(drv(d, ['ci', 'list']).out, 'a real run'));
  ok('running it twice does nothing', has(drv(d, ['ci', 'import-legacy']).out, 'nothing to import'));
  ok('the record still agrees', has(drv(d, ['verify']).out, 'agree exactly'));
}

// The archive is only safe because a removal is recorded like any other change.
say('archiving shrinks the register without breaking the record');
{
  const d = box('archive');
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

// ---------------------------------------------------------------------- report
if (!KEEP) for (const d of boxes) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
else console.log('\nsandboxes kept: ' + boxes.join('\n                '));

console.log('\n' + '-'.repeat(60));
if (!failures.length) { console.log(pass + ' checks, all green.'); process.exit(0); }
console.log(pass + ' passed, ' + failures.length + ' FAILED:');
for (const f of failures) console.log('  ✗ ' + f);
process.exit(1);
