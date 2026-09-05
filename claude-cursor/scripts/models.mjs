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

// ------------------------------------------------------------ other runners
// The ladder above is Cursor's. A second runner has its own row in `runners`
// and is never compared against it.
const homeOf = (p) => String(p).replace(/^~(?=\/|$)/, process.env.HOME || process.env.USERPROFILE || '~');
const runnerOf = (m, name) => {
  if (!name || name === 'cursor') return null;
  const r = (m.runners || {})[name];
  if (!r) die(`unknown runner "${name}". Known: cursor, ${Object.keys(m.runners || {}).join(', ')}`);
  return r;
};
// Where the binary is. It is not on a non-interactive PATH — the login profile
// adds it — so the places it is normally installed are tried too, and the
// failure is a sentence rather than `command not found` from inside a launcher.
function binOf(r) {
  try { return execFileSync('bash', ['-c', 'command -v -- ' + JSON.stringify(r.bin)], { encoding: 'utf8' }).trim(); }
  catch { /* not on PATH, which is the usual case */ }
  for (const d of r.search || []) {
    const p = path.join(homeOf(d), r.bin);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
// The efforts this model actually accepts, out of opencode's own registry.
//
// `opencode run --variant <anything>` is accepted in silence: a bogus one runs
// a normal turn and reports nothing, so a typo costs the reasoning the tier was
// chosen for and nothing says so. The vocabulary is per model and varies a lot
// — grok-4.6 takes low/medium/high/xhigh, deepseek-v4-flash takes low/high/max,
// and `minimal` from the CLI's own help text is not valid for either. So the
// only defence is to look it up before spending anything.
// Returns `{ values, why }`. `values` is the list to check against, or null
// when there is nothing to check against — and `why` says the specific reason,
// because a caller that gets null back is not just missing a nice-to-have: it
// is the one substantive guard this runner has, doing nothing. That happens
// on the most ordinary machine there is — one that has never run `opencode`
// interactively, so `~/.cache/opencode/models.json` was never written — and a
// null that is checked with `if (allowed && ...)` and otherwise ignored is
// exactly how that goes unnoticed: `resolve` and `effort-check` both used to
// return success silently rather than say the check never ran.
function effortsOf(r) {
  const f = homeOf(r.registry || '');
  let reg;
  try { reg = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) {
    const reason = e && e.code === 'ENOENT' ? 'no such file' : (e && e.message) || String(e);
    return { values: null, why: `the registry at ${f} could not be read (${reason})` };
  }
  const prov = reg[r.provider];
  const models = prov && (prov.models || prov);
  const id = String(r.model).split('/').pop();
  const entry = models && models[id];
  if (!entry) return { values: null, why: `${r.model} is not listed in the registry at ${f}` };
  const opt = (entry.reasoning_options || []).find((o) => o.type === 'effort');
  if (!opt) return { values: null, why: `${r.model}'s registry entry names no effort options` };
  return { values: opt.values, why: null };
}

// "a", "a and b", "a, b and c" — for saying which tiers collapsed onto one
// effort, which is two of them or three depending on where the ladder's
// default sits.
const andList = (xs) => xs.length < 2 ? String(xs[0] ?? '')
  : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];

// Every spelling a row answers to. `shown` is the old single-string form and is
// still read, so a table written before this change still works.
export const namesOf = (row) => (row.accepts && row.accepts.length ? row.accepts : [row.shown]).filter(Boolean);
const rowFor = (m, want) => m.ladder.find((r) => r.id === want || namesOf(r).includes(want));

// The whole check. `-fast` is refused on its own line rather than folded into
// the mismatch, so a fast run is reported for being fast instead of for being
// some other string than expected.
//
// `accepts` is a list because the runtime is not consistent about effort
// suffixes: rank 4 answered two different ways inside one round, and comparing
// against a single string threw away two runs that had done the work. What is
// not relaxed is the comparison itself — exact equality against each entry,
// because the short name is a prefix of four other rows.
export function verdict(want, got, accepts) {
  const names = (accepts && accepts.length ? accepts : [want]).filter(Boolean);
  if (!got) return { ok: false, why: 'no init event — the run never started, so nothing says what it ran on' };
  if (/\bFast\b/.test(got)) return { ok: false, why: `ran on the fast tier ("${got}"). That bills at roughly double for speed this work does not need` };
  if (!names.includes(got)) {
    return { ok: false, why: `ran on "${got}", and the model asked for answers to ${names.map((n) => `"${n}"`).join(' or ')}.\n` +
      `  If "${got}" is that same model under another spelling, add it: node scripts/models.mjs sync` };
  }
  return { ok: true };
}

// `agent --list-models` prints "id - Shown Name", one per line, under a banner.
// Take lines by shape rather than by position so the banner cannot become a row.
//
// It also colours its output, and an escape sequence sits before the first
// character of the id — which is where the anchored match starts, so a coloured
// listing parsed as no models at all and sync became unusable. Strip the codes
// before matching, and when nothing matches, show what actually arrived rather
// than only saying that nothing did.
const decolour = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
function listModels() {
  let out;
  try {
    out = execFileSync('agent', ['--list-models'], { encoding: 'utf8', timeout: 60_000 });
  } catch (e) {
    die(`could not run \`agent --list-models\`: ${e.message}\n  Is the Cursor CLI installed and logged in? Try \`agent status\`.`);
  }
  const seen = new Map();
  for (const line of out.split('\n')) {
    const m = /^([A-Za-z0-9._-]+) - (.+?)\s*$/.exec(decolour(line).trim());
    if (m) seen.set(m[1], m[2]);
  }
  if (!seen.size) {
    const head = out.split('\n').filter((l) => l.trim()).slice(0, 5).map((l) => '    ' + decolour(l).trim());
    die('`agent --list-models` printed nothing that looks like "id - Name".' +
      (head.length ? '\n  Its first lines were:\n' + head.join('\n') : '\n  It printed nothing at all.'));
  }
  return seen;
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(n); return i === -1 ? null : rest[i + 1]; };
// Arguments that are not a flag and not a flag's value. Filtering on the `--`
// prefix alone reads `--runner opencode high` as the positional "opencode",
// which is the flag's value wearing a tier's clothes.
const VALUE_FLAGS = ['--runner', '--want', '--got'];
const positionals = (() => {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (VALUE_FLAGS.includes(rest[i])) { i++; continue; }
    if (rest[i].startsWith('--')) continue;
    out.push(rest[i]);
  }
  return out;
})();
const m = load();

switch (cmd) {
  case 'list': {
    const byTier = Object.entries(m.roles).reduce((a, [r, t]) => ((a[t] ||= []).push(r), a), {});
    console.log('rank  tier      id                          answers to                                default for');
    for (const r of m.ladder) {
      console.log(
        String(r.rank).padEnd(6) + r.tier.padEnd(10) + r.id.padEnd(28) +
        namesOf(r).join(' / ').padEnd(42) + (byTier[r.tier] || []).join(', '));
    }
    break;
  }

  case 'resolve': {
    const name = positionals[0];
    if (!name) die('resolve needs a role or tier — try `models.mjs list`');
    const r = runnerOf(m, flag('--runner'));
    // Cursor: a tier picks a model, and the name it must report comes with it.
    if (!r) {
      const row = resolve(m, name);
      process.stdout.write(row.id + '\t' + namesOf(row)[0] + '\n');
      break;
    }
    // Another runner: one model, so a tier picks an effort instead. Same
    // tab-separated shape, with the effort in the third field.
    const tier = m.roles[name] || name;
    const effort = (r.efforts || {})[tier];
    if (!effort) die(`runner "${flag('--runner')}" has no effort for tier "${tier}".\n` +
      `  tiers: ${Object.keys(r.efforts || {}).join(', ')}`);
    const allowed = effortsOf(r);
    if (allowed.values && !allowed.values.includes(effort)) die(
      `the ladder maps tier "${tier}" to effort "${effort}", which ${r.model} does not accept.\n` +
      `  it accepts: ${allowed.values.join(', ')}\n` +
      `  An effort this model does not know is accepted in silence and thrown away,\n` +
      `  so this is refused here rather than billed for.`);
    // Not fatal — the effort itself may well be fine — but this is the one
    // substantive guard this runner has, and a machine that has never run
    // `opencode` interactively (so its registry cache was never written) would
    // otherwise sail through with no check having happened and nothing said.
    if (!allowed.values) console.error(`⚠ ${allowed.why} — "${effort}" was not checked against what ${r.model} actually accepts.`);
    process.stdout.write(r.model + '\t' + (r.shown || r.model) + '\t' + effort + '\n');
    break;
  }

  // The registry check `resolve` makes, exposed on its own so a launcher can
  // run it even when `--model`/`--effort` were both supplied directly and
  // never went through `resolve` at all. That path used to skip the guard
  // entirely — the one thing here built specifically to catch a `--variant`
  // opencode accepts and silently ignores.
  case 'effort-check': {
    const r = runnerOf(m, flag('--runner'));
    if (!r) die('effort-check is for a non-Cursor runner — try `models.mjs list`');
    const effort = flag('--effort');
    if (!effort) die('effort-check needs --effort <name>');
    const model = flag('--model') || r.model;
    const allowed = effortsOf({ ...r, model });
    if (allowed.values && !allowed.values.includes(effort)) die(
      `effort "${effort}" is not accepted by ${model}.\n` +
      `  it accepts: ${allowed.values.join(', ')}\n` +
      `  An effort this model does not know is accepted in silence and thrown away,\n` +
      `  so this is refused here rather than billed for.`);
    if (!allowed.values) {
      console.error(`⚠ ${allowed.why} — "${effort}" was not checked against what ${model} actually accepts.`);
      console.log('ok, unchecked');
    } else {
      console.log('ok');
    }
    break;
  }

  // Where a runner's binary is, or a sentence saying it is not installed.
  case 'which': {
    const r = runnerOf(m, flag('--runner') || positionals[0]);
    if (!r) { process.stdout.write('agent\n'); break; }
    const p = binOf(r);
    if (!p) die(`${r.bin} is not installed, or not where this expects it.\n` +
      `  Looked on PATH and in: ${(r.search || []).join(', ')}\n` +
      `  A non-interactive shell does not get the login profile's PATH, so being able\n` +
      `  to run it in a terminal is not the same as this being able to.`);
    process.stdout.write(p + '\n');
    break;
  }

  // What the round would run, before it runs it.
  case 'efforts': {
    const r = runnerOf(m, flag('--runner') || positionals[0]);
    if (!r) die('efforts is for a non-Cursor runner — try `models.mjs list`');
    const allowed = effortsOf(r);
    console.log(`${r.shown || r.model}  (${r.model})`);
    console.log(`  accepts: ${allowed.values ? allowed.values.join(', ') : `(${allowed.why} — nothing to check against)`}`);
    console.log(`  verified after the run: ${r.verifiable ? 'yes' : 'no — the log does not name the model'}`);
    console.log('\n  tier      effort');
    for (const [t, e] of Object.entries(r.efforts || {})) {
      const bad = allowed.values && !allowed.values.includes(e);
      console.log('  ' + t.padEnd(10) + e + (bad ? '   ✗ not accepted by this model' : ''));
    }
    // The collapse is real, so it is said rather than left to be noticed.
    // It is not always two tiers — five onto three leaves a three-way one —
    // so the list is joined properly rather than with `and` between every pair.
    const byEffort = {};
    for (const [t, e] of Object.entries(r.efforts || {})) (byEffort[e] ||= []).push(t);
    const shared = Object.entries(byEffort).filter(([, ts]) => ts.length > 1);
    if (shared.length) {
      console.log('');
      for (const [e, ts] of shared) console.log(`  ${andList(ts)} are the same effort here (${e}).`);
    }
    break;
  }

  case 'verify': {
    const want = flag('--want'), got = flag('--got');
    if (want === null) die('verify needs --want <name the model should report>');
    // The caller passes the canonical name; the row it belongs to knows every
    // other spelling that is the same model.
    const row = rowFor(m, want);
    const v = verdict(want, got || '', row ? namesOf(row) : null);
    if (!v.ok) { console.error('✗ ' + v.why); process.exit(1); }
    console.log('model: ' + got);
    break;
  }

  // Regenerating rather than hand-editing is the point: `shown` is the CLI's
  // string, not ours, and a table that drifts from it fails every run at once.
  case 'sync': {
    // `sync` only knows how to regenerate Cursor's `shown` names, off
    // `agent --list-models`. opencode has one model, and the only thing about
    // it that can go stale — which efforts it accepts — is already read live
    // out of its own registry on every `resolve` and `effort-check`, so there
    // is nothing here to regenerate for it. Silently running the Cursor sync
    // anyway when asked for opencode would look like it did something.
    const runnerFlag = flag('--runner');
    if (runnerFlag && runnerFlag !== 'cursor') die(
      `sync only regenerates the cursor ladder's "shown" names, from \`agent --list-models\`.\n` +
      `  opencode has one model, and its accepted efforts are read live from its own\n` +
      `  registry on every \`resolve\`/\`effort-check\` — there is nothing here to sync.\n` +
      `  See \`models.mjs efforts --runner opencode\`.`);
    const dry = rest.includes('--dry-run');
    const live = listModels();
    const changes = [], gone = [];
    for (const row of m.ladder) {
      const shown = live.get(row.id);
      if (shown === undefined) { gone.push(row); continue; }
      // Added, never replaced. The runtime has answered two ways for one id
      // within a single round, so a name seen once stays accepted — dropping it
      // is how the next run on the other spelling gets thrown away.
      const names = namesOf(row);
      if (!names.includes(shown)) { changes.push([row, shown]); row.accepts = [shown, ...names]; }
      else if (!row.accepts) row.accepts = names;
      delete row.shown;
    }
    // A missing id is not a cosmetic drift. Every run pinned to it would fail,
    // so this refuses rather than quietly writing a table with a hole in it.
    if (gone.length) {
      console.error('✗ ' + gone.length + ' model id(s) in the ladder no longer exist:');
      for (const r of gone) console.error(`    rank ${r.rank} (${r.tier}): ${r.id}`);
      console.error('  Pick replacements from `agent --list-models` and edit models.json, then sync again.');
      process.exit(1);
    }
    for (const [row, added] of changes) {
      console.log(`  rank ${row.rank} (${row.tier}): now also answers to "${added}"`);
    }
    if (!changes.length) { console.log(`✓ all ${m.ladder.length} models report a name the table already accepts`); break; }
    if (dry) { console.log(`${changes.length} new spelling(s) — not written (--dry-run)`); break; }
    fs.writeFileSync(TABLE, JSON.stringify(m, null, 2) + '\n');
    console.log(`✓ wrote ${changes.length} new spelling(s) to ${TABLE}`);
    break;
  }

  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(cmd ? 2 : 0);
}
