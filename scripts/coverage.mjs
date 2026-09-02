#!/usr/bin/env node
// scripts/coverage.mjs — run the end-to-end sweep under Node's built-in V8
// coverage and report aggregated function/block coverage across every driver
// process the harness spawns.
//
// The project is deliberately zero-dependency, so this uses only node built-ins:
// every driver subprocess inherits NODE_V8_COVERAGE and writes a dump; we merge
// them by function/block body offsets and count a unit "covered" when any
// process executed it.
//
// Usage:
//   node scripts/coverage.mjs            run sweep + report + threshold check
//   node scripts/coverage.mjs --report   just aggregate an existing dir
//   node scripts/coverage.mjs --dir P --report-only
//   ORCHESTRATE_COV_THRESHOLD=80 node scripts/coverage.mjs   override threshold
//
// Exit code: 0 if the sweep passes AND function coverage >= threshold, else 1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DRIVER = path.join(ROOT, 'driver.mjs');
const ORCH = path.join(ROOT, 'claude-cursor', 'orchestrate.mjs');
const TEST = path.join(ROOT, 'test.mjs');

const argv = process.argv.slice(2);
const onlyList = ['--report', '--report-only'].filter((f) => argv.includes(f));
const reportOnly = onlyList.length > 0;

function pull(dir, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dir;
}

// --- run the sweep under coverage ---
function runSweep() {
  const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cov-'));
  const res = spawnSync(process.execPath, [TEST], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: covDir },
    timeout: 600000,
  });
  const out = String(res.stdout || '') + String(res.stderr || '');
  const passed = res.status === 0;
  console.log(out.trim() ? out : '(no output)');
  if (res.error) console.error('\nerror running sweep:', res.error.message);
  return { covDir, passed, status: res.status };
}

// --- merge dumps ---
function mergeCoverage(covDir) {
  const files = fs.existsSync(covDir)
    ? fs.readdirSync(covDir).filter((f) => f.endsWith('.json'))
    : [];
  const fns = new Map(); // key -> {url,start,end,fnName,executed}
  const blocks = new Map(); // key -> {url,executed}

  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(covDir, f), 'utf8'));
    } catch {
      continue;
    }
    for (const scr of j.result || []) {
      if (!scr.url || !scr.url.endsWith('.mjs')) continue;
      for (const fn of scr.functions || []) {
        if (!fn.ranges || !fn.ranges.length) continue;
        const r0 = fn.ranges[0];
        const key = `${scr.url}\u0000${r0.startOffset}\u0000${r0.endOffset}`;
        const executed = fn.ranges.some((r) => (r.count || 0) > 0);
        if (!fns.has(key)) {
          fns.set(key, {
            url: scr.url,
            start: r0.startOffset,
            end: r0.endOffset,
            fnName: fn.functionName || '',
            executed,
          });
        } else if (executed) {
          fns.get(key).executed = true;
        }
        for (const r of fn.ranges) {
          const bk = `${scr.url}\u0000${r.startOffset}\u0000${r.endOffset}`;
          const cur = blocks.get(bk) || { url: scr.url, executed: false };
          if ((r.count || 0) > 0) cur.executed = true;
          blocks.set(bk, cur);
        }
      }
    }
  }
  return { fns, blocks, files: files.length };
}

function stat(itemMap, predicate) {
  let total = 0;
  let hit = 0;
  const miss = [];
  for (const [k, v] of itemMap) {
    if (!predicate(v.url)) continue;
    total++;
    if (v.executed) hit++;
    else miss.push({ fnName: v.fnName || `fn@${v.start}`, start: v.start });
  }
  const pct = total ? (100 * hit) / total : null;
  return { total, hit, miss, pct };
}

function offsetToLine(src, off) {
  let n = 0;
  const lines = src.split('\n');
  for (let line = 0; line < lines.length; line++) {
    n += lines[line].length + 1;
    if (n > off) return line + 1;
  }
  return lines.length;
}

async function main() {
  let ownedDir = '';        // only remove what this process made
  let covDir = pull('', '--dir');
  let passed = true;
  let status = 0;

  if (!reportOnly) {
    const run = runSweep();
    passed = run.passed;
    status = run.status ?? -1;
    covDir = covDir || run.covDir;
    ownedDir = run.covDir;
  }

  if (!covDir) {
    console.error('error: no coverage directory — pass --dir or run the sweep');
    process.exit(1);
  }

  const { fns, blocks, files } = mergeCoverage(covDir);
  const isDriver = (u) => u.includes('driver.mjs');
  const isTest = (u) => u.includes('test.mjs');

  const isOrch = (u) => u.includes('orchestrate.mjs');
  const driverFns = stat(fns, isDriver);
  const driverBlocks = stat(blocks, isDriver);
  const orchFns = stat(fns, isOrch);
  const testFns = stat(fns, isTest);

  console.log(`\ncoverage dumps merged: ${files}`);
  console.log(`DRIVER   functions: ${driverFns.hit}/${driverFns.total} (${(driverFns.pct ?? 0).toFixed(1)}%)`);
  console.log(`DRIVER   blocks:    ${driverBlocks.hit}/${driverBlocks.total} (${(driverBlocks.pct ?? 0).toFixed(1)}%)`);
  console.log(`ORCH     functions: ${orchFns.hit}/${orchFns.total} (${(orchFns.pct ?? 0).toFixed(1)}%)`);
  console.log(`TEST     functions: ${testFns.hit}/${testFns.total} (${(testFns.pct ?? 0).toFixed(1)}%)`);

  {
    const src = fs.existsSync(DRIVER) ? fs.readFileSync(DRIVER, 'utf8') : '';
    const misses = driverFns.miss.slice().sort((a, b) => a.start - b.start);
    console.log(`\n--- ${misses.length} uncovered driver functions ---`);
    for (const m of misses) console.log(`  L${offsetToLine(src, m.start)}  ${m.fnName}`);
  }
  {
    const src = fs.existsSync(ORCH) ? fs.readFileSync(ORCH, 'utf8') : '';
    const misses = orchFns.miss.slice().sort((a, b) => a.start - b.start);
    console.log(`\n--- ${misses.length} uncovered orchestrate functions ---`);
    for (const m of misses) console.log(`  L${offsetToLine(src, m.start)}  ${m.fnName}`);
  }

  // The point of a floor is that it can be hit. Driver-function coverage sits at
  // ~92%, so a 60% floor allowed a thirty-point regression without a word — the
  // same shape of check this project exists to stop shipping. Set just under the
  // real number; raise it when the real number rises.
  const DEFAULT_THRESHOLD = 88;
  const raw = process.env.ORCHESTRATE_COV_THRESHOLD;
  let threshold = DEFAULT_THRESHOLD;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = Number(raw);
    // An empty or unreadable value used to become 0, which silently turned the
    // gate off — the one failure mode a coverage gate must not have.
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      console.error('error: ORCHESTRATE_COV_THRESHOLD must be a number from 0 to 100 — got "' + raw + '"');
      process.exit(2);
    }
    threshold = n;
  }
  // Each sweep spawns ~600 driver processes and each writes a dump; a run left
  // behind 137 MB. Clear it once the numbers are out of it.
  const sweep = () => { if (ownedDir) try { fs.rmSync(ownedDir, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on('exit', sweep);
  // The backend of the cursor skill gets its own floor, spaced under its real
  // number the same way. Two files, two gates: a regression in one must not be
  // masked by the other being large and well covered.
  const ORCH_THRESHOLD = Number(process.env.ORCHESTRATE_ORCH_COV_THRESHOLD ?? 85);
  const pct = driverFns.pct ?? 0;
  const orchPct = orchFns.total ? (orchFns.pct ?? 0) : 100;
  const driverOk = pct >= threshold;
  const orchOk = orchPct >= ORCH_THRESHOLD;
  const coverOk = driverOk && orchOk;
  console.log(`\nthreshold: ${threshold}% driver-function coverage -> ${driverOk ? 'PASS' : 'BELOW'}`);
  console.log(`threshold: ${ORCH_THRESHOLD}% orchestrate-function coverage -> ${orchOk ? 'PASS' : 'BELOW'}`);

  if (!passed) {
    console.log('\nSWEEP: FAILED (test.mjs exited non-zero)');
    process.exit(status || 1);
  }
  if (!coverOk) {
    console.log('\nCOVERAGE: BELOW THRESHOLD');
    process.exit(1);
  }
  console.log('\nCOVERAGE: OK');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
