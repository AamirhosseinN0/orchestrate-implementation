#!/usr/bin/env bash
# Run one Cursor CLI agent and put its whole stream on disk.
#
# The flags below are not preferences. --trust is required because every
# worktree is a directory Cursor has not seen; without --force the run proposes
# changes, writes nothing, and still exits 0.
set -uo pipefail

# Each kind of agent runs on its own model, and every run is checked against the
# name the agent reports for itself. Asking for a model is not the same as
# getting it: effort suffixes have historically been dropped silently, so the
# only trustworthy answer is the one in the agent's own opening event.
#
#   refine, chip  cursor-grok-4.6-xhigh   Grok 4.6 at Extra High thinking
#   preflight     composer-2.5            Composer 2.5
#
# Never the -fast tier, whatever the role: it bills at roughly double for speed
# this work does not need.
role_model() {
  case "$1" in
    refine|chip) echo 'cursor-grok-4.6-xhigh' ;;
    preflight)   echo 'composer-2.5' ;;
  esac
}
role_shown() {
  case "$1" in
    refine|chip) echo 'Cursor Grok 4.6 Extra High' ;;
    preflight)   echo 'Composer 2.5' ;;
  esac
}

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
STREAM=${CURSOR_ORCH_STREAM:-0}

KEY= WS=. CHAT= ROLE= PROMPT_FILE=
MODEL="${CURSOR_ORCH_MODEL:-}"
SHOWN_WANT="${CURSOR_ORCH_MODEL_SHOWN:-}"
NODE_BIN="${CURSOR_ORCH_NODE_BIN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY=$2; shift 2 ;;
    --workspace) WS=$2; shift 2 ;;
    --chat) CHAT=$2; shift 2 ;;
    --role) ROLE=$2; shift 2 ;;
    --model) MODEL=$2; shift 2 ;;
    --model-shown) SHOWN_WANT=$2; shift 2 ;;
    --node-bin) NODE_BIN=$2; shift 2 ;;
    --prompt-file) PROMPT_FILE=$2; shift 2 ;;
    --stream) STREAM=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$KEY" ] || { echo "--key <name> is required — it names the log" >&2; exit 2; }
case "$ROLE" in
  refine|preflight|chip) ;;
  '') echo "--role <refine|preflight|chip> is required — it selects the model and the check" >&2; exit 2 ;;
  *)  echo "unknown role: $ROLE — expected refine, preflight or chip" >&2; exit 2 ;;
esac
[ -n "$PROMPT_FILE" ] && [ -r "$PROMPT_FILE" ] || { echo "--prompt-file <path> is required and must be readable" >&2; exit 2; }

DEFAULT_MODEL=$(role_model "$ROLE")
DEFAULT_SHOWN=$(role_shown "$ROLE")

# The fast tier bills at roughly double and is not what this skill runs on.
# Checked first, so a -fast model is refused for being fast rather than for
# missing the --model-shown it would never be allowed to use anyway.
case "${MODEL:-}" in
  *-fast) echo "✗ refusing $MODEL — this skill runs the non-fast tier. Drop the -fast suffix." >&2; exit 2 ;;
esac

# An override may not switch the check off. Whatever model is asked for, this
# script has to know what that model calls itself, or it cannot tell a silent
# downgrade from a correct run — which is exactly what the check is for.
if [ -z "$MODEL" ] || [ "$MODEL" = "$DEFAULT_MODEL" ]; then
  MODEL=$DEFAULT_MODEL
  SHOWN_WANT=${SHOWN_WANT:-$DEFAULT_SHOWN}
elif [ -z "$SHOWN_WANT" ]; then
  echo "✗ refusing $MODEL for role $ROLE without --model-shown (or CURSOR_ORCH_MODEL_SHOWN)." >&2
  echo "  The run is verified against the name the agent reports; overriding the model" >&2
  echo "  without saying what it should report would leave the run unverified." >&2
  exit 2
fi

LOG_DIR=${CURSOR_ORCH_LOG_DIR:-.claude/orchestration/cursor}
mkdir -p "$LOG_DIR" || exit 2
LOG="$LOG_DIR/$KEY.jsonl"

# PATH inside an agent is rebuilt from the login profile — what this script
# exports does not order it, so bare `node` is whatever that profile defaults
# to. A project that pins a runtime has to say so in the prompt, per command.
PROMPT=$(cat "$PROMPT_FILE")
if [ -n "$NODE_BIN" ]; then
  PROMPT="Runtime, before anything else: bare \`node\` inside this agent is the login
profile's default, not the runtime this project pins. Every command you run that
depends on the project's runtime must begin with:

    export PATH=\"$NODE_BIN:\$PATH\";

Prefix it per command — an export in one shell call does not reach the next one.

$PROMPT"
fi

set -- -p --force --trust --output-format stream-json --model "$MODEL" --workspace "$WS"
[ -n "$CHAT" ] && set -- "$@" --resume "$CHAT"

# --stream puts a readable account of the run on stdout while the untouched
# jsonl still lands in the log. Backgrounded, that account is what shows in the
# task pane, so a run stops being a silent several minutes. The log is written
# by tee and is byte-for-byte what the redirect produced, so everything that
# reads it afterwards is unaffected.
if [ "$STREAM" = 1 ]; then
  agent "$@" "$PROMPT" 2>&1 | tee "$LOG" | node "$SELF_DIR/cursor-stream.mjs" --key "$KEY"
  rc=${PIPESTATUS[0]}
else
  agent "$@" "$PROMPT" > "$LOG" 2>&1
  rc=$?
fi

TAIL=$(tail -n 1 "$LOG" 2>/dev/null)

# What actually ran, from the agent's own opening event. Read the first line
# that carries a model field rather than line 1 flatly: a warning printed ahead
# of the init event would otherwise read as a run that never started.
SHOWN=$(grep -m1 -o '"model":"[^"]*"' "$LOG" 2>/dev/null | head -1 | sed 's/^"model":"//; s/"$//')
if [ -z "$SHOWN" ]; then
  echo "✗ $KEY: no init event — the run never started. Read $LOG" >&2
  [ -n "$TAIL" ] && echo "  last line: $TAIL" >&2
  exit 1
fi
echo "model: $SHOWN"
case "$SHOWN" in
  *Fast*) echo "✗ $KEY ran on the fast tier ($SHOWN) despite asking for $MODEL. Stop and fix this." >&2; exit 1 ;;
esac
if [ "$SHOWN" != "$SHOWN_WANT" ]; then
  echo "✗ $KEY asked for $MODEL (role $ROLE) but ran on \"$SHOWN\" — expected \"$SHOWN_WANT\"." >&2
  exit 1
fi

# A log whose last line is not an event is a stream that stopped outside the
# protocol — a loop detector, a transport error. The exit code has covered this
# every time it has been seen, but the tail is the thing that actually says so.
BADTAIL=0
case "$TAIL" in
  '{'*'}') ;;
  *) BADTAIL=1 ;;
esac

if [ $rc -ne 0 ] || [ $BADTAIL -eq 1 ] || printf '%s' "$TAIL" | grep -q '"is_error":true'; then
  echo "✗ $KEY failed (exit $rc). The whole stream is at $LOG" >&2
  [ -n "$TAIL" ] && echo "  last line: $TAIL" >&2
  exit 1
fi
echo "✓ $KEY finished. Stream: $LOG"
