#!/usr/bin/env node
// scripts/sweep.mjs — run test.mjs across every core this machine has.
//
// The sweep is a few hundred cases, each of which starts the driver a handful of
// times in a temp directory of its own. Nothing in it is shared between cases,
// so the only reason it ever took a minute and a half was that one process did
// all of it. This starts one process per shard, hands each an interleaved slice
// of the cases, and adds the counts back up. The total is still asserted against
// the suite's own EXPECTED, so a case that silently stops running is still
// caught — it is caught here now rather than inside any one shard.
//
//   node scripts/sweep.mjs             all cores
//   node scripts/sweep.mjs -j 8        eight shards
//   node scripts/sweep.mjs --serial    one process, the old behaviour
//   node scripts/sweep.mjs --only x    pass a filter through to the suite
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEST = path.join(ROOT, 'test.mjs');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

// Each shard is mostly waiting on child processes and on the disk, so it is
// worth running more of them than there are cores. Capped at the case count.
const CORES = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const JOBS = argv.includes('--serial') ? 1
  : Math.max(1, Number(flag('-j') || flag('--jobs') || process.env.SWEEP_JOBS || Math.ceil(CORES * 1.5)));
const ONLY = flag('--only');
const passthrough = ONLY ? ['--only', ONLY] : [];

// One compile cache for every shard and every driver they start, seeded by
// whichever process gets there first.
if (!process.env.NODE_COMPILE_CACHE)
  process.env.NODE_COMPILE_CACHE = path.join(os.tmpdir(), 'orch-compile-cache');

function runShard(i, n) {
  return new Promise((resolve) => {
    const args = [TEST, '--report-json', ...passthrough];
    if (n > 1) args.push('--shard', i + '/' + n);
    const p = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { out += b; });
    p.on('close', (code) => {
      // A crashed shard is not a zero — it is a shard whose cases never ran,
      // and the total below has to notice that rather than folding it into an
      // ordinary "ran N not M" count.
      const crash = (why) => resolve({ i, code, pass: 0, ran: 0, cases: null, crashed: true,
        failures: ['shard ' + i + ' ' + why + ' (exit ' + code + ')\n      ' + out.trim().split('\n').slice(-25).join('\n      ')] });
      // Found by lastIndexOf + a plain trim, not a `/\n__SWEEP__(.*)\n?/`
      // regex: that pattern assumes the report is exactly one line with no
      // embedded newline, which is true only as long as test.mjs's
      // JSON.stringify never pretty-prints. Reporting is a marker plus
      // whatever follows it, parsed defensively, so a report that ever did
      // span lines fails this one shard with a clear reason instead of
      // throwing straight out of the close handler and taking the whole
      // sweep down with it.
      const at = out.lastIndexOf('__SWEEP__');
      if (at === -1) return crash('produced no report');
      const payload = out.slice(at + '__SWEEP__'.length).trim();
      let r;
      try { r = JSON.parse(payload); }
      catch (e) { return crash('produced an unparseable report (' + e.message + ')'); }
      resolve({ i, code, ...r, crashed: false });
    });
  });
}

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: JOBS }, (_, i) => runShard(i, JOBS)));
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const pass = results.reduce((a, r) => a + r.pass, 0);
const ran = results.reduce((a, r) => a + r.ran, 0);
const failures = results.flatMap((r) => r.failures);
const cases = results.find((r) => r.cases != null)?.cases ?? null;

// The same assertion the single-process suite makes, made once over the whole
// fleet: every case ran somewhere, and the checks add up to the expected number.
// Read off the suite rather than copied here, so there is still one place to
// raise it when a check is added.
const EXPECTED = (() => {
  const m = /^const EXPECTED = (\d+);/m.exec(fs.readFileSync(TEST, 'utf8'));
  if (!m) { console.error('test.mjs no longer declares EXPECTED'); process.exit(2); }
  return Number(m[1]);
})();
const total = pass + failures.length;
if (!ONLY && cases != null && ran !== cases)
  failures.push('the fleet ran ' + ran + ' cases, not ' + cases + ' — a shard dropped work.');
if (!ONLY && total !== EXPECTED)
  failures.push('the fleet ran ' + total + ' checks, not ' + EXPECTED +
    '\n      A case stopped part way, or a check was added without updating EXPECTED in test.mjs.');

console.log('-'.repeat(60));
console.log(JOBS + (JOBS === 1 ? ' shard, ' : ' shards, ') + ran + ' cases, ' + secs + 's');
if (!failures.length) { console.log(pass + ' checks, all green.'); process.exit(0); }
console.log(pass + ' passed, ' + failures.length + ' FAILED:');
for (const f of failures) console.log('  ✗ ' + f);
process.exit(1);
