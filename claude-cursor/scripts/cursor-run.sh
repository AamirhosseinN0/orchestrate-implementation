#!/usr/bin/env bash
# Run one Cursor CLI agent and put its whole stream on disk.
#
# The flags below are not preferences. --trust is required because every
# worktree is a directory Cursor has not seen; without --force the run proposes
# changes, writes nothing, and still exits 0.
set -uo pipefail

# Every agent this skill runs uses Grok 4.6 at Extra High thinking, and never
# the -fast tier. Highest reasoning, standard speed. Both halves are checked
# below — asking for it is not the same as getting it.
PINNED_MODEL=cursor-grok-4.6-xhigh
PINNED_SHOWN='Cursor Grok 4.6 Extra High'

KEY= WS=. CHAT= MODEL="${CURSOR_ORCH_MODEL:-$PINNED_MODEL}" PROMPT_FILE=
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY=$2; shift 2 ;;
    --workspace) WS=$2; shift 2 ;;
    --chat) CHAT=$2; shift 2 ;;
    --model) MODEL=$2; shift 2 ;;
    --prompt-file) PROMPT_FILE=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$KEY" ] || { echo "--key <name> is required — it names the log" >&2; exit 2; }
[ -n "$PROMPT_FILE" ] && [ -r "$PROMPT_FILE" ] || { echo "--prompt-file <path> is required and must be readable" >&2; exit 2; }

# The fast tier bills at roughly double and is not what this skill runs on.
case "$MODEL" in
  *-fast) echo "✗ refusing $MODEL — this skill runs the non-fast tier. Drop the -fast suffix." >&2; exit 2 ;;
esac

LOG_DIR=${CURSOR_ORCH_LOG_DIR:-.claude/orchestration/cursor}
mkdir -p "$LOG_DIR" || exit 2
LOG="$LOG_DIR/$KEY.jsonl"

set -- -p --force --trust --output-format stream-json --model "$MODEL" --workspace "$WS"
[ -n "$CHAT" ] && set -- "$@" --resume "$CHAT"

agent "$@" "$(cat "$PROMPT_FILE")" > "$LOG" 2>&1
rc=$?

# What actually ran, from the agent's own opening event. The flag is a request;
# this is the answer, and an effort suffix silently dropped shows up only here.
SHOWN=$(sed -n '1p' "$LOG" | sed -n 's/.*"model":"\([^"]*\)".*/\1/p')
if [ -z "$SHOWN" ]; then
  echo "✗ $KEY: no init event — the run never started. Read $LOG" >&2
  exit 1
fi
echo "model: $SHOWN"
case "$SHOWN" in
  *Fast*) echo "✗ $KEY ran on the fast tier ($SHOWN) despite asking for $MODEL. Stop and fix this." >&2; exit 1 ;;
esac
if [ "$MODEL" = "$PINNED_MODEL" ] && [ "$SHOWN" != "$PINNED_SHOWN" ]; then
  echo "✗ $KEY asked for $MODEL but ran on \"$SHOWN\" — the effort suffix was dropped." >&2
  exit 1
fi

if [ $rc -ne 0 ] || tail -n 1 "$LOG" | grep -q '"is_error":true'; then
  echo "✗ $KEY failed (exit $rc). The whole stream is at $LOG" >&2
  exit 1
fi
echo "✓ $KEY finished. Stream: $LOG"
