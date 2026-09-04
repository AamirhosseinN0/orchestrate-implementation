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
// `passed` requires a `step_finish` — a genuine completion signal, the same
// role Cursor's `result` event plays. Text alone is not enough: a run cut off
// mid-stream (provider drop, OOM kill, crash) can emit one `text` chunk and
// then nothing, and that is a run that died, not one that finished. `reason`
// on `step_finish` is read too — `stop` is a clean finish; anything else
// (opencode's own word for hitting a length or tool-call limit) means the run
// was cut short even though it technically finished, and that is `failed`,
// not a silent `passed`.
//
// Exit code matches harvest.mjs: 0 for `passed`, 1 for `died`/`failed`, 2 for
// a usage/IO error (bad args, unreadable log) — in every mode, because a
// caller piping `--probe` still needs to tell "the run failed" from "this
// process could not even open the log".
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
// A UTF-8 BOM on the first line is not valid JSON whitespace, so it took the
// whole first event down as an unparseable line — silently, since a bad line
// is a warning, not a failure. Strip it before anything is split.
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

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
    const out = !r || r.startsWith('..') ? abs : r;
    // `path.relative` on Windows returns backslashes. `guard` compares this
    // against `git diff --name-only`, which always emits forward slashes —
    // and Cursor's own harvester never produces a backslash, because its
    // `rel` is a plain string slice rather than a `path` call. Left alone,
    // every file a DeepSeek run touches on Windows is recorded in a spelling
    // `guard` cannot match, and a step that did its job legitimately gets
    // sent back for it.
    return out.replace(/\\/g, '/');
  } catch { return String(p); }
};
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  let cut = t.slice(0, n);
  // Don't leave a lone leading surrogate at the cut point — slicing by UTF-16
  // code unit can land inside a two-unit character (an emoji, most of
  // supplementary-plane Unicode), and writing that half-character out turns
  // into U+FFFD on the way to a terminal or a file rather than staying text.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '…';
};
// Tab and newline are the field and record separators of --probe's TSV, so
// anything opencode might put in a value that flows into that format has to
// be flattened the same way `clip` already flattens it for `tail` — a raw
// field skips `clip` (it isn't clipped for length) but still needs this.
const flatten = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
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
  // opencode's own word for why generation stopped, off the last `step_finish`
  // seen. `stop` is a clean finish; anything else — a length limit, a
  // tool-call limit, whatever this model's vocabulary turns out to hold — is
  // the run being cut short while still emitting a well-formed terminal
  // event, which `sawFinish` alone cannot tell apart from a real finish.
  finishReason: null,
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
let started = 0, completed = 0, sawText = false, sawFinish = false;
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
        //
        // A call that never reached `completed` or `error` — the run was cut
        // off mid-command — has no exit code at all. Defaulting that to 0
        // would record a command that never finished as one that succeeded,
        // which is worse than not knowing: `exitCode: null` says plainly that
        // this is unread, rather than reading as a green command.
        const finished = st.status === 'completed' || st.status === 'error';
        const c = {
          command: clip(input.command, 400),
          exitCode: typeof meta.exit === 'number' ? meta.exit : (st.status === 'error' ? 1 : (finished ? 0 : null)),
          output: clip(meta.output ?? st.output, 2000),
        };
        if (!finished) c.unfinished = true;
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
          // `multiedit` carries its edits as an array rather than a single
          // pair of strings — everything above misses it entirely and the
          // file was listed with a permanent +0/-0. The field name and shape
          // are a guess (the plan that built this never saw a real multiedit
          // event), so this reads defensively: only strings inside array
          // entries that look like edits are counted, and anything else is
          // still fine because the file is still listed via `tools`.
          if (Array.isArray(input.edits)) {
            for (const e of input.edits) {
              if (!e || typeof e !== 'object') continue;
              if (typeof e.newString === 'string') f.added += e.newString.split('\n').length;
              if (typeof e.oldString === 'string') f.removed += e.oldString.split('\n').length;
            }
          }
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
      // The terminal event. A run can be cut off after emitting `text` and
      // before this ever arrives — that is `died`, not `passed` — and even
      // when it does arrive, `reason` says whether generation actually
      // completed (`stop`) or was cut short (anything else). Kept as the
      // LAST value seen: an agentic run has one `step_finish` per internal
      // step, most of which end mid-run for an ordinary reason (a tool was
      // called), so only the final one speaks for the run as a whole.
      sawFinish = true;
      if (typeof part.reason === 'string' && part.reason) r.finishReason = part.reason;
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
// Failures first, and a command that never finished counts as one: a null
// exit code is exactly as much "not green" as a non-zero one, and sorting it
// to the back with the successes is how it went unnoticed before.
const isBad = (c) => c.exitCode !== 0;
r.commands.sort((a, b) => (isBad(a) ? 0 : 1) - (isBad(b) ? 0 : 1));
r.counts.unfinishedToolCalls = Math.max(0, started - completed);
r.trouble.unfinishedToolCalls = r.counts.unfinishedToolCalls;
r.seconds = r.startedAt && r.endedAt ? Math.round((r.endedAt - r.startedAt) / 1000) : 0;
r.usage.cost = Math.round(r.usage.cost * 1e6) / 1e6;

// `passed` requires a genuine completion signal — `step_finish` — the same
// role Cursor's `result` event plays there. `sawText` alone said "the model
// wrote a sentence at some point", which a run cut off after its first
// sentence also satisfies; that is precisely the run that must read as
// `died`, not `passed`. An error beats everything, a cut-short finish reason
// counts as `failed` rather than a silent `passed`, and no `step_finish` at
// all is `died` — a log with no events is the same case, before it started.
if (r.trouble.errors) {
  r.outcome = 'failed';
} else if (sawFinish) {
  if (r.finishReason && r.finishReason !== 'stop') {
    r.outcome = 'failed';
    if (!r.trouble.tail) r.trouble.tail = clip(`step_finish reason: ${r.finishReason}`, 300);
  } else {
    r.outcome = 'passed';
  }
} else {
  r.outcome = 'died';
  if (!r.trouble.tail) r.trouble.tail = clip(lastLine, 300) || 'the log is empty';
}

if (MODE === 'probe') {
  // `read -r` with `IFS=$'\t'` treats tab as IFS whitespace, which bash
  // collapses: a leading (or repeated) tab is not an empty field, it is no
  // field at all, and every value after it shifts left by one. A run whose
  // provider rejected the request before minting a session — bad auth, an
  // unknown model — has no sessionID on any event, so this field was empty,
  // was the first field, and every downstream read (`HAS_ANSWER`, `IS_ERROR`,
  // `TAIL`) silently took the next field's value. That is how an errored run
  // read as `HAS_ANSWER=1`-shaped-like-something and the error branch never
  // fired. `-` is not a real session id and is never emitted any other way,
  // so it is unambiguous as "no session" on the reading side.
  process.stdout.write([
    flatten(r.session) || '-',
    r.outcome === 'passed' ? '1' : '0',
    (r.trouble.errors || r.outcome === 'failed') ? '1' : '0',
    flatten(r.trouble.tail),
  ].join('\t') + '\n');
} else if (MODE === 'brief') {
  console.log(`${r.outcome.toUpperCase()}  ${mmss(r.seconds)}  ${r.model || 'model not recorded'}` +
    (r.effort ? `  effort: ${r.effort}` : '') + '  (unverified)');
  console.log(`  ${r.files.length} file(s) changed, ${r.commands.length} command(s), ${r.counts.toolCalls} tool calls`);
  for (const f of r.files.slice(0, 12)) console.log(`    +${f.added}/-${f.removed}  ${f.path}`);
  if (r.files.length > 12) console.log(`    … ${r.files.length - 12} more`);
  const bad = r.commands.filter(isBad);
  if (bad.length) {
    console.log(`  ${bad.length} command(s) failed:`);
    for (const c of bad.slice(0, 5)) console.log(`    [${c.exitCode === null ? 'never finished' : c.exitCode}] ${clip(c.command, 90)}`);
  }
  console.log(`  ${r.usage.total.toLocaleString()} tokens, $${r.usage.cost.toFixed(4)}`);
  if (r.trouble.badLines) console.log(`  ${r.trouble.badLines} unparseable line(s) in the log`);
  // Cursor's --brief says this; opencode's silently didn't, which is exactly
  // the shape of gap a human reading a "PASSED" summary would never notice on
  // their own — a tool call that never finished leaves no other trace here.
  if (r.trouble.unfinishedToolCalls) console.log(`  trouble: ${r.trouble.unfinishedToolCalls} tool call(s) never finished`);
  if (r.finishReason && r.finishReason !== 'stop') console.log(`  finished for reason: ${r.finishReason}`);
  if (r.trouble.tail) console.log(`  last: ${r.trouble.tail}`);
} else {
  console.log(JSON.stringify(r, null, 2));
}

// Same contract as harvest.mjs: 0 only for a run that actually passed, so a
// caller that checks the exit code — not just the printed fields — cannot
// mistake a died or failed run for a clean one in any mode, `--probe`
// included.
process.exit(r.outcome === 'passed' ? 0 : 1);
