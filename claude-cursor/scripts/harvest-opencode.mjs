#!/usr/bin/env node
// Read an opencode run out of its own log.
//
// Same job and same output shape as harvest.mjs, so everything downstream is
// unchanged: `run record` files `{outcome, seconds, files, commands, answer}`
// whichever runner produced it, and the record shape is already the contract
// that lets a Claude Code step be recorded by hand.
//
// What is different is the log. opencode emits one JSON object per line:
//
//   {"type":"step_start",  "sessionID":"ses_…","part":{"type":"step-start"}}
//   {"type":"tool_use",    "sessionID":"ses_…","part":{"type":"tool","tool":"write",
//                            "state":{"status":"completed","input":{…},"metadata":{…}}}}
//   {"type":"text",        "sessionID":"ses_…","part":{"type":"text","text":"…"}}
//   {"type":"step_finish", "sessionID":"ses_…","part":{"tokens":{…},"cost":0.0018,"reason":"stop"}}
//   {"type":"error",       "sessionID":"ses_…","error":{"name":"…","data":{…}}}
//
// Two fields exist here that Cursor's log has no values for — `tokens` and
// `cost` — and one does not: nothing anywhere names the model that answered.
// `model` is therefore what was ASKED for, passed in by the launcher, and
// `modelVerified` is false. It is never inferred from the log, because the log
// cannot know.
//
//   harvest-opencode.mjs <log>                  the record, as JSON
//   harvest-opencode.mjs <log> --brief          a few lines a person can read
//   harvest-opencode.mjs <log> --probe          TSV: session, answered, error, tail
//
// --root is the worktree the run happened in; paths are relativised against it.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const LOG = args.find((a) => !a.startsWith('--'));
const MODE = args.includes('--probe') ? 'probe' : args.includes('--brief') ? 'brief' : 'json';
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
if (!LOG) { console.error('usage: harvest-opencode.mjs <log> [--brief|--probe] [--root DIR] [--model M] [--effort E]'); process.exit(2); }

let raw = '';
try { raw = fs.readFileSync(LOG, 'utf8'); } catch { console.error('✗ cannot read ' + LOG); process.exit(2); }

// Paths in an opencode log are absolute, and the run happened in the step's
// worktree — not here. Relativising against this process's cwd turns
// `/tmp/wt-S-1/src/a.ts` into a string of `../..`, and `guard` compares what a
// step touched against `owns`, which is repo-relative. So the root is passed
// in, and only falls back to cwd when nobody said.
const ROOT = path.resolve(flag('--root') || process.cwd());
const rel = (p) => {
  try {
    const abs = path.resolve(String(p));
    const r = path.relative(ROOT, abs);
    // Outside the worktree entirely: keep it absolute rather than emit a path
    // made of `..`, which nothing can match and everything would silently pass.
    return !r || r.startsWith('..') ? abs : r;
  } catch { return String(p); }
};
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const mmss = (s) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;

const r = {
  runner: 'opencode',
  // What was asked for. Not what answered — opencode does not say, so this is
  // never presented as a verified fact.
  model: flag('--model') || null,
  effort: flag('--effort') || null,
  modelVerified: false,
  session: null,
  startedAt: null, endedAt: null, seconds: 0,
  outcome: 'died', answer: '',
  files: [], commands: [], reads: [],
  counts: { toolCalls: 0, steps: 0 },
  usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
  trouble: { errors: 0, unfinishedToolCalls: 0, tail: null, badLines: 0 },
};

// Which tools mean what. opencode names them plainly; anything not listed is
// counted as a tool call and otherwise left alone, so a new tool cannot make
// this throw or silently drop a run.
const WRITES = new Set(['write', 'edit', 'patch', 'multiedit']);
const READS = new Set(['read', 'grep', 'glob', 'list', 'webfetch']);

const byPath = new Map();
let started = 0, completed = 0, sawText = false;
let lastLine = '';

for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  lastLine = line;
  let ev;
  try { ev = JSON.parse(line); } catch { r.trouble.badLines++; r.trouble.tail = clip(line, 300); continue; }
  if (ev.sessionID && !r.session) r.session = ev.sessionID;
  const ts = ev.timestamp;
  if (typeof ts === 'number') {
    if (r.startedAt === null || ts < r.startedAt) r.startedAt = ts;
    if (r.endedAt === null || ts > r.endedAt) r.endedAt = ts;
  }
  const part = ev.part || {};

  switch (ev.type) {
    case 'step_start':
      r.counts.steps++;
      break;

    case 'text':
      if (typeof part.text === 'string' && part.text) { r.answer += (r.answer ? '\n' : '') + part.text; sawText = true; }
      break;

    case 'tool_use': {
      r.counts.toolCalls++;
      started++;
      const st = part.state || {};
      if (st.status === 'completed' || st.status === 'error') completed++;
      const input = st.input || {}, meta = st.metadata || {};
      const tool = part.tool;

      if (tool === 'bash') {
        // metadata.exit is the exit code. It is the one field that says a
        // command failed, and it is what `run record` reports failures from.
        const c = {
          command: clip(input.command, 400),
          exitCode: typeof meta.exit === 'number' ? meta.exit : (st.status === 'error' ? 1 : 0),
          output: clip(meta.output ?? st.output, 2000),
        };
        r.commands.push(c);
      } else if (WRITES.has(tool)) {
        const p = meta.filepath || input.filePath || input.path;
        if (p) {
          const key = rel(p);
          const f = byPath.get(key) || { path: key, added: 0, removed: 0, tools: [] };
          // opencode does not report a line delta, so it is counted from what
          // was written rather than invented. An edit whose replacement text is
          // not in the event contributes 0 and is still listed, because the
          // file having been touched is the fact `guard` cares about.
          if (typeof input.content === 'string') f.added += input.content.split('\n').length;
          if (typeof input.newString === 'string') f.added += input.newString.split('\n').length;
          if (typeof input.oldString === 'string') f.removed += input.oldString.split('\n').length;
          if (!f.tools.includes(tool)) f.tools.push(tool);
          byPath.set(key, f);
        }
      } else if (READS.has(tool)) {
        const p = meta.filepath || input.filePath || input.path || input.pattern;
        if (p) r.reads.push(rel(String(p)));
      }
      break;
    }

    case 'step_finish': {
      const t = part.tokens || {};
      r.usage.input += t.input || 0;
      r.usage.output += t.output || 0;
      r.usage.reasoning += t.reasoning || 0;
      r.usage.total += t.total || 0;
      r.usage.cacheRead += (t.cache && t.cache.read) || 0;
      r.usage.cacheWrite += (t.cache && t.cache.write) || 0;
      r.usage.cost += part.cost || 0;
      break;
    }

    case 'error': {
      r.trouble.errors++;
      const e = ev.error || {};
      r.trouble.tail = clip((e.name ? e.name + ': ' : '') + ((e.data && e.data.message) || JSON.stringify(e.data || {})), 300);
      break;
    }

    default: break;   // a type this does not know is not a reason to lose the run
  }
}

r.files = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
// Failures first: a run's twenty green commands are noise beside its one red one.
r.commands.sort((a, b) => (a.exitCode ? 0 : 1) - (b.exitCode ? 0 : 1));
r.counts.unfinishedToolCalls = Math.max(0, started - completed);
r.trouble.unfinishedToolCalls = r.counts.unfinishedToolCalls;
r.seconds = r.startedAt && r.endedAt ? Math.round((r.endedAt - r.startedAt) / 1000) : 0;
r.usage.cost = Math.round(r.usage.cost * 1e6) / 1e6;

// An outcome is only `passed` when the run said something and nothing errored.
// A log with no events at all is a run that died before it started, which is
// exactly what the launcher needs to tell apart from a run that failed.
if (r.trouble.errors) r.outcome = 'failed';
else if (sawText) r.outcome = 'passed';
else { r.outcome = 'died'; if (!r.trouble.tail) r.trouble.tail = clip(lastLine, 300) || 'the log is empty'; }

if (MODE === 'probe') {
  process.stdout.write([
    r.session || '',
    sawText ? '1' : '0',
    r.trouble.errors ? '1' : '0',
    (r.trouble.tail || '').replace(/\t/g, ' '),
  ].join('\t') + '\n');
} else if (MODE === 'brief') {
  console.log(`${r.outcome.toUpperCase()}  ${mmss(r.seconds)}  ${r.model || 'model not recorded'}` +
    (r.effort ? `  effort: ${r.effort}` : '') + '  (unverified)');
  console.log(`  ${r.files.length} file(s) changed, ${r.commands.length} command(s), ${r.counts.toolCalls} tool calls`);
  for (const f of r.files.slice(0, 12)) console.log(`    +${f.added}/-${f.removed}  ${f.path}`);
  if (r.files.length > 12) console.log(`    … ${r.files.length - 12} more`);
  const bad = r.commands.filter((c) => c.exitCode);
  if (bad.length) {
    console.log(`  ${bad.length} command(s) failed:`);
    for (const c of bad.slice(0, 5)) console.log(`    [${c.exitCode}] ${clip(c.command, 90)}`);
  }
  console.log(`  ${r.usage.total.toLocaleString()} tokens, $${r.usage.cost.toFixed(4)}`);
  if (r.trouble.badLines) console.log(`  ${r.trouble.badLines} unparseable line(s) in the log`);
  if (r.trouble.tail) console.log(`  last: ${r.trouble.tail}`);
} else {
  console.log(JSON.stringify(r, null, 2));
}
