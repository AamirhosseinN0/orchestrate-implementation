#!/usr/bin/env node
// The model ladder: resolve a role or tier to a model, and prove a finished run
// actually used it.
//
// Asking for a model is not the same as getting one. Effort suffixes have been
// dropped silently, and the fast tier bills at roughly double for speed this
// work does not need. The only trustworthy answer to "what ran" is the name the
// agent reports in its own opening event, so every run is checked against it.
//
//   models.mjs list                       the ladder, as a table
//   models.mjs resolve <role|tier>        prints "id<TAB>shown"
//   models.mjs verify --want W --got G    exit 0 if the run is what was asked for
//   models.mjs sync [--dry-run]           regenerate `shown` from `agent --list-models`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE = process.env.CURSOR_ORCH_MODELS || path.join(HERE, '..', 'models.json');

function load() {
  let raw;
  try { raw = fs.readFileSync(TABLE, 'utf8'); }
  catch { die(`no model table at ${TABLE}`); }
  try { return JSON.parse(raw); }
  catch (e) { die(`the model table at ${TABLE} is not valid JSON: ${e.message}`); }
}
function die(msg, code = 2) { console.error('✗ ' + msg); process.exit(code); }

// A role names a tier; a tier names a row. Both spellings resolve, so callers
// can pass --role chip or a tier a user picked in the approval table.
function resolve(m, name) {
  const tier = m.roles[name] || name;
  const row = m.ladder.find((r) => r.tier === tier);
  if (!row) {
    const roles = Object.keys(m.roles).join(', ');
    const tiers = m.ladder.map((r) => r.tier).join(', ');
    die(`unknown role or tier "${name}".\n  roles: ${roles}\n  tiers: ${tiers}`);
  }
  return row;
}

// The whole check. `-fast` is refused on its own line rather than folded into
// the mismatch, so a fast run is reported for being fast instead of for being
// some other string than expected.
export function verdict(want, got) {
  if (!got) return { ok: false, why: 'no init event — the run never started, so nothing says what it ran on' };
  if (/\bFast\b/.test(got)) return { ok: false, why: `ran on the fast tier ("${got}"). That bills at roughly double for speed this work does not need` };
  if (got !== want) return { ok: false, why: `ran on "${got}" but "${want}" was asked for` };
  return { ok: true };
}

// `agent --list-models` prints "id - Shown Name", one per line, under a banner.
// Take lines by shape rather than by position so the banner cannot become a row.
function listModels() {
  let out;
  try {
    out = execFileSync('agent', ['--list-models'], { encoding: 'utf8', timeout: 60_000 });
  } catch (e) {
    die(`could not run \`agent --list-models\`: ${e.message}\n  Is the Cursor CLI installed and logged in? Try \`agent status\`.`);
  }
  const seen = new Map();
  for (const line of out.split('\n')) {
    const m = /^([A-Za-z0-9._-]+) - (.+?)\s*$/.exec(line.trim());
    if (m) seen.set(m[1], m[2]);
  }
  if (!seen.size) die('`agent --list-models` printed nothing that looks like a model. Read its output by hand.');
  return seen;
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(n); return i === -1 ? null : rest[i + 1]; };
const m = load();

switch (cmd) {
  case 'list': {
    const byTier = Object.entries(m.roles).reduce((a, [r, t]) => ((a[t] ||= []).push(r), a), {});
    console.log('rank  tier      id                          reports itself as             default for');
    for (const r of m.ladder) {
      console.log(
        String(r.rank).padEnd(6) + r.tier.padEnd(10) + r.id.padEnd(28) +
        r.shown.padEnd(30) + (byTier[r.tier] || []).join(', '));
    }
    break;
  }

  case 'resolve': {
    const name = rest[0];
    if (!name) die('resolve needs a role or tier — try `models.mjs list`');
    const row = resolve(m, name);
    process.stdout.write(row.id + '\t' + row.shown + '\n');
    break;
  }

  case 'verify': {
    const want = flag('--want'), got = flag('--got');
    if (want === null) die('verify needs --want <name the model should report>');
    const v = verdict(want, got || '');
    if (!v.ok) { console.error('✗ ' + v.why); process.exit(1); }
    console.log('model: ' + got);
    break;
  }

  // Regenerating rather than hand-editing is the point: `shown` is the CLI's
  // string, not ours, and a table that drifts from it fails every run at once.
  case 'sync': {
    const dry = rest.includes('--dry-run');
    const live = listModels();
    const changes = [], gone = [];
    for (const row of m.ladder) {
      const shown = live.get(row.id);
      if (shown === undefined) { gone.push(row); continue; }
      if (shown !== row.shown) { changes.push([row, row.shown, shown]); row.shown = shown; }
    }
    // A missing id is not a cosmetic drift. Every run pinned to it would fail,
    // so this refuses rather than quietly writing a table with a hole in it.
    if (gone.length) {
      console.error('✗ ' + gone.length + ' model id(s) in the ladder no longer exist:');
      for (const r of gone) console.error(`    rank ${r.rank} (${r.tier}): ${r.id}`);
      console.error('  Pick replacements from `agent --list-models` and edit models.json, then sync again.');
      process.exit(1);
    }
    for (const [row, before, after] of changes) {
      console.log(`  rank ${row.rank} (${row.tier}): "${before}" → "${after}"`);
    }
    if (!changes.length) { console.log(`✓ all ${m.ladder.length} models still report the names in the table`); break; }
    if (dry) { console.log(`${changes.length} change(s) — not written (--dry-run)`); break; }
    fs.writeFileSync(TABLE, JSON.stringify(m, null, 2) + '\n');
    console.log(`✓ wrote ${changes.length} change(s) to ${TABLE}`);
    break;
  }

  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(cmd ? 2 : 0);
}
