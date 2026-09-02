#!/usr/bin/env bash
# Read an agent's answer back out of its stream.
#
# The log is one JSON object per line, and the text a run produced is buried in
# it. Every caller was writing the same parser; this is that parser, plus the
# case the hand-written ones miss — a run that dies without ever emitting a
# result line, whose log simply ends in a bare error string.
set -uo pipefail

MODE=all TARGET=
while [ $# -gt 0 ]; do
  case "$1" in
    --last) MODE=last; shift ;;
    --tool-output) MODE=tools; shift ;;
    -*) echo "unknown argument: $1" >&2; exit 2 ;;
    *) TARGET=$1; shift ;;
  esac
done
[ -n "$TARGET" ] || { echo "usage: cursor-result.sh [--last|--tool-output] <key|log-path>" >&2; exit 2; }

# A bare key resolves against the log directory; anything path-shaped is taken
# as written.
LOG=$TARGET
if [ ! -f "$LOG" ]; then
  LOG="${CURSOR_ORCH_LOG_DIR:-.claude/orchestration/cursor}/$TARGET.jsonl"
fi
[ -f "$LOG" ] || { echo "✗ no log at $TARGET or $LOG" >&2; exit 2; }

node -e '
const fs = require("fs");
const [log, mode] = process.argv.slice(1);
const lines = fs.readFileSync(log, "utf8").split("\n").filter(l => l.trim());

// Depth-first for the first object carrying a stdout field. The shell result is
// wrapped in a success/failure branch and the wrapper name is not load-bearing.
function findOutput(node, depth) {
  depth = depth || 0;
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (typeof node.stdout === "string") return node;
  for (const key of Object.keys(node)) {
    const hit = findOutput(node[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

const results = [];
const tools = [];
let lastBad = "";          // the tail of a run that died outside the protocol
let errored = false;

for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { lastBad = line; continue; }
  if (ev.type === "result") {
    if (ev.is_error) errored = true;
    if (typeof ev.result === "string") results.push(ev.result);
  } else if (ev.type === "tool_call" && ev.subtype === "completed") {
    const call = ev.tool_call && ev.tool_call.shellToolCall;
    if (call) {
      // The captured output sits under result.success, and under result.failure
      // when the command exits non-zero. Find the branch that carries it rather
      // than naming one, so a schema that grows a third branch still reports.
      const out = findOutput(call) || {};
      tools.push({
        command: (call.args && call.args.command) || "",
        stdout: out.stdout || "",
        stderr: out.stderr || "",
        exitCode: out.exitCode !== undefined ? out.exitCode : "?",
      });
    }
  }
}

if (mode === "tools") {
  if (!tools.length) { console.error("✗ no completed shell calls in " + log); process.exit(1); }
  for (const t of tools) {
    console.log("$ " + t.command);
    if (t.stdout) process.stdout.write(t.stdout.endsWith("\n") ? t.stdout : t.stdout + "\n");
    if (t.stderr) process.stderr.write(t.stderr.endsWith("\n") ? t.stderr : t.stderr + "\n");
    console.log("[exit " + t.exitCode + "]");
  }
  process.exit(0);
}

// No result line at all. This is a run that was killed outside the protocol —
// a loop detector, a transport error — and reporting nothing for it is how a
// dead run gets mistaken for a quiet one.
if (!results.length) {
  console.error("✗ no result line in " + log + " — the run ended without answering.");
  if (lastBad) console.error("  last line: " + lastBad);
  process.exit(1);
}

const out = mode === "last" ? results.slice(-1) : results;
for (const r of out) console.log(r);
process.exit(errored ? 1 : 0);
' "$LOG" "$MODE"
