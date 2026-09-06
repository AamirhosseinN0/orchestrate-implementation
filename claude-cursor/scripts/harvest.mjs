#!/usr/bin/env node
// Read a run's log into a record small enough to keep.
//
// A real chip run is 2-3 MB of jsonl — every thinking token, every tool call,
// every diff. The orchestrator cannot read that, so historically it read none of
// it and typed a sentence from memory instead: on one real 8.8-hour build, 36 MB
// across 27 runs became 5,670 characters of hand-written prose and a five-line
// ledger. Everything else was thrown away, including 282 file edits that the log
// records with path and exact line counts.
//
// This turns one log into ~2 KB of structured fact. What it reports is what the
// run did, not what the agent claims it did — the agent's own verdict still
// arrives separately.
//
//   harvest.mjs <log>                 the record, as JSON
//   harvest.mjs <log> --brief         a few lines a person can read
//   harvest.mjs <log> --probe         TSV for the launcher: model, result, error, tail
import fs from 'node:fs';

const args = process.argv.slice(2);
const LOG = args.find((a) => !a.startsWith('-'));
const MODE = args.includes('--probe') ? 'probe' : args.includes('--brief') ? 'brief' : 'json';
if (!LOG) { console.error('usage: harvest.mjs <log> [--brief|--probe]'); process.exit(2); }
if (!fs.existsSync(LOG)) { console.error('✗ no log at ' + LOG); process.exit(2); }

// The shell result is wrapped in a success/failure branch and the wrapper name
// is not load-bearing; find the branch that carries the output.
function findOutput(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (typeof node.stdout === 'string') return node;
  for (const k of Object.keys(node)) { const hit = findOutput(node[k], depth + 1); if (hit) return hit; }
  return null;
}
const toolOf = (tc) => {
  if (!tc) return [null, null];
  for (const k of Object.keys(tc)) if (/ToolCall$/.test(k) && tc[k] && typeof tc[k] === 'object') return [k, tc[k]];
  return [null, null];
};
const clip = (s, n) => { const f = String(s ?? '').replace(/\s+/g, ' ').trim(); return f.length > n ? f.slice(0, n - 1) + '…' : f; };

const r = {
  log: LOG, model: null, session: null,
  startedAt: null, endedAt: null, seconds: 0,
  outcome: 'died', answer: '',
  files: [], commands: [], reads: [], searched: [],
  cwd: null,
  trouble: { reconnects: 0, retries: 0, unfinishedToolCalls: 0, tail: null, badLines: 0 },
  counts: { events: 0, toolCalls: 0, thinkingBlocks: 0, assistantMessages: 0 },
};

const byPath = new Map();
// Claude Code's Bash calls and their outcomes arrive in separate events, so a
// command waits here between the two.
const pending = new Map();
let started = 0, completed = 0, sawResult = false, lastLine = '';

for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  lastLine = line;
  let ev;
  // A line that is not an event is the stream stopping outside the protocol.
  // This is the case a hand-written `type=="result"` parser reports as silence,
  // and it is exactly how the one run that died on this build ended.
  try { ev = JSON.parse(line); } catch { r.trouble.badLines++; r.trouble.tail = line.trim(); continue; }
  r.counts.events++;
  if (ev.timestamp_ms) {
    if (r.startedAt === null) r.startedAt = ev.timestamp_ms;
    r.endedAt = ev.timestamp_ms;
  }
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') { r.model = ev.model || null; r.session = ev.session_id || null; r.cwd = ev.cwd || null; }
      break;
    case 'thinking': if (ev.subtype === 'completed') r.counts.thinkingBlocks++; break;
    case 'assistant': {
      r.counts.assistantMessages++;
      // Claude Code has no `tool_call` events: its tool calls are content
      // blocks inside this message. Without reading them a Claude run harvests
      // as "0 file(s) changed, 0 command(s)" no matter what it did — the exact
      // loss this whole file exists to prevent.
      for (const b of (ev.message && ev.message.content) || []) {
        if (!b || b.type !== 'tool_use') continue;
        r.counts.toolCalls++; started++;
        const inp = b.input || {};
        if (inp.file_path && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name)) {
          // No line counts here: a Claude tool call carries the content it
          // wrote, not a diff. The path and the number of edits are real, and
          // `guard` reads the branch for the rest.
          const prev = byPath.get(inp.file_path) || { path: inp.file_path, added: 0, removed: 0, edits: 0 };
          prev.edits++; byPath.set(inp.file_path, prev);
        } else if (b.name === 'Bash' && inp.command) {
          const c = { command: clip(inp.command, 400), exitCode: null };
          r.commands.push(c); pending.set(b.id, c);
        } else if (inp.file_path || inp.pattern || inp.path) {
          r.reads.push(clip(inp.file_path || inp.pattern || inp.path, 120));
        }
      }
      break;
    }
    case 'user': {
      // The other half of the pair: whether each of those calls worked. A
      // Claude tool result carries no exit code, only `is_error` — so a failed
      // command is recorded as 1, which is what every reader of this field
      // actually asks of it.
      for (const b of (ev.message && ev.message.content) || []) {
        if (!b || b.type !== 'tool_result') continue;
        completed++;
        const c = pending.get(b.tool_use_id);
        if (!c) continue;
        c.exitCode = b.is_error ? 1 : 0;
        if (b.is_error) c.stdout = clip(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 1500);
        pending.delete(b.tool_use_id);
      }
      break;
    }
    case 'connection': if (ev.subtype === 'reconnecting') r.trouble.reconnects++; break;
    case 'retry': if (ev.subtype === 'starting') r.trouble.retries++; break;
    case 'result':
      sawResult = true;
      r.outcome = ev.is_error ? 'failed' : 'passed';
      if (typeof ev.result === 'string') r.answer = ev.result;
      break;
    case 'tool_call': {
      if (ev.subtype === 'started') { started++; break; }
      if (ev.subtype !== 'completed') break;
      completed++; r.counts.toolCalls++;
      const [kind, call] = toolOf(ev.tool_call);
      if (!kind) break;
      const ok = call.result && call.result.success;
      if (kind === 'editToolCall' && ok) {
        // The signal nothing was reading: path and exact line counts, per edit.
        // Better than `git diff --name-only` after the fact, because it is
        // attributed and ordered.
        const p = ok.path || call.args?.path || '(unknown)';
        const prev = byPath.get(p) || { path: p, added: 0, removed: 0, edits: 0 };
        prev.added += ok.linesAdded || 0; prev.removed += ok.linesRemoved || 0; prev.edits++;
        byPath.set(p, prev);
      } else if (kind === 'shellToolCall') {
        const out = findOutput(call) || {};
        const code = out.exitCode !== undefined ? out.exitCode : null;
        // A green command's output is noise; a red one's is the whole reason to
        // keep the record. So output is kept only where it explains something.
        const c = { command: clip(call.args?.command, 400), exitCode: code };
        if (code) { c.stdout = clip(out.stdout, 1500); c.stderr = clip(out.stderr, 1500); }
        r.commands.push(c);
      } else if (kind === 'readToolCall' || kind === 'grepToolCall' || kind === 'globToolCall') {
        const p = call.args?.path || call.args?.pattern || call.args?.globPattern;
        if (p) r.reads.push(clip(p, 120));
      } else if (kind === 'webSearchToolCall' || kind === 'webFetchToolCall') {
        r.searched.push(clip(call.args?.searchTerm || call.args?.url, 160));
      }
      break;
    }
  }
}

// The log records absolute paths inside the worktree. Made relative to the run's
// own cwd they line up with a task's `owns`, which is the whole point of having
// them — a trespass is then a set difference, not a second `git diff`.
const rel = (p) => (r.cwd && p.startsWith(r.cwd + '/') ? p.slice(r.cwd.length + 1) : p);
r.files = [...byPath.values()].map((f) => ({ ...f, path: rel(f.path) }))
  .sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
r.reads = r.reads.map(rel);
// Failures first: a run's twenty green commands are noise next to its one red one.
r.commands.sort((a, b) => (a.exitCode ? 0 : 1) - (b.exitCode ? 0 : 1));
r.trouble.unfinishedToolCalls = Math.max(0, started - completed);
r.seconds = r.startedAt && r.endedAt ? Math.round((r.endedAt - r.startedAt) / 1000) : 0;
// What it read is worth a number and a sample, not a list of 124 paths.
const readSet = [...new Set(r.reads)];
r.readCount = readSet.length;
r.reads = readSet.slice(0, 25);
if (!sawResult) {
  r.outcome = 'died';
  if (!r.trouble.tail) r.trouble.tail = clip(lastLine, 300);
}

const mmss = (s) => Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';

if (MODE === 'probe') {
  // For the launcher, which needs four facts and no JSON parser in bash.
  process.stdout.write([r.model || '', sawResult ? '1' : '0',
    r.outcome === 'failed' ? '1' : '0', (r.trouble.tail || '').replace(/\t/g, ' ')].join('\t') + '\n');
} else if (MODE === 'brief') {
  const t = r.trouble;
  console.log(`${r.outcome.toUpperCase()}  ${mmss(r.seconds)}  ${r.model || 'unknown model'}`);
  console.log(`  ${r.files.length} file(s) changed, ${r.commands.length} command(s), ${r.counts.toolCalls} tool calls`);
  for (const f of r.files.slice(0, 12))
    console.log(`    ${f.added || f.removed ? `+${f.added}/-${f.removed}` : `${f.edits} edit(s)`}  ${f.path}`);
  if (r.files.length > 12) console.log(`    … ${r.files.length - 12} more`);
  const bad = r.commands.filter((c) => c.exitCode);
  if (bad.length) {
    console.log(`  ${bad.length} command(s) exited non-zero:`);
    for (const c of bad.slice(0, 5)) console.log(`    [${c.exitCode}] ${clip(c.command, 120)}`);
  }
  if (t.reconnects || t.retries || t.unfinishedToolCalls)
    console.log(`  trouble: ${t.reconnects} reconnect(s), ${t.retries} retry(ies), ${t.unfinishedToolCalls} tool call(s) never finished`);
  if (t.tail) console.log(`  ended outside the protocol: ${clip(t.tail, 200)}`);
  if (r.answer) console.log(`  answer: ${clip(r.answer, 300)}`);
} else {
  console.log(JSON.stringify(r, null, 2));
}
process.exit(r.outcome === 'passed' ? 0 : 1);
