#!/usr/bin/env bash
# Run one agent and put its whole stream on disk.
#
# --trust is required because every worktree is a directory Cursor has not seen;
# without --force the run proposes changes, writes nothing, and still exits 0.
# Both are always passed, so neither is a decision anyone has to remember.
set -uo pipefail

SELF=$(cd "$(dirname "$0")" && pwd)
MODELS="$SELF/models.mjs"
HARVEST="$SELF/harvest.mjs"
STREAM="$SELF/stream.mjs"

KEY= WS=. CHAT= ROLE= PROMPT_FILE= RUNNER=cursor
MODEL="${CURSOR_ORCH_MODEL:-}"
SHOWN_WANT="${CURSOR_ORCH_MODEL_SHOWN:-}"
NODE_BIN="${CURSOR_ORCH_NODE_BIN:-}"
QUIET=0 RETRY=1

die() { echo "✗ $*" >&2; exit 2; }
# A flag whose value is missing used to fall out of bash as "$2: unbound
# variable". Every other bad input gets a sentence, so this one does too.
need() { [ "$2" -ge 2 ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --key)          need "$1" $#; KEY=$2; shift 2 ;;
    --workspace)    need "$1" $#; WS=$2; shift 2 ;;
    --chat)         need "$1" $#; CHAT=$2; shift 2 ;;
    --role)         need "$1" $#; ROLE=$2; shift 2 ;;
    --model)        need "$1" $#; MODEL=$2; shift 2 ;;
    --model-shown)  need "$1" $#; SHOWN_WANT=$2; shift 2 ;;
    --node-bin)     need "$1" $#; NODE_BIN=$2; shift 2 ;;
    --prompt-file)  need "$1" $#; PROMPT_FILE=$2; shift 2 ;;
    --runner)       need "$1" $#; RUNNER=$2; shift 2 ;;
    --quiet)        QUIET=1; shift ;;
    --no-retry)     RETRY=0; shift ;;
    --stream)       shift ;;   # kept so old call sites still work; streaming is the default
    *) die "unknown argument: $1" ;;
  esac
done

# The Claude Code runner has no command line — a step on it is spawned by the
# orchestrator's own Agent tool. Saying so beats pretending to support it.
if [ "$RUNNER" = claude ]; then
  echo "This step runs on Claude Code, which has no launcher: spawn it with the Agent" >&2
  echo "tool from the orchestrating session, then record the result with" >&2
  echo "    node claude-cursor/orchestrate.mjs run record $KEY --json <file>" >&2
  exit 2
elif [ "$RUNNER" != cursor ]; then
  die "unknown runner: $RUNNER — expected cursor or claude"
fi

[ -n "$KEY" ] || die "--key <name> is required — it names the log"
[ -n "$ROLE" ] || die "--role <name> is required — it selects the model and the check"
[ -n "$PROMPT_FILE" ] || die "--prompt-file <path> is required"
[ -r "$PROMPT_FILE" ] || die "cannot read the prompt file at $PROMPT_FILE"

# The model, from the table rather than from a case statement in here.
if [ -z "$MODEL" ]; then
  IFS=$'\t' read -r MODEL DEFAULT_SHOWN < <(node "$MODELS" resolve "$ROLE") || exit 2
  [ -n "$MODEL" ] || die "could not resolve a model for role $ROLE"
  SHOWN_WANT=${SHOWN_WANT:-$DEFAULT_SHOWN}
elif [ -z "$SHOWN_WANT" ]; then
  # An override may not switch the check off. Without knowing what the model
  # calls itself, a silent downgrade and a correct run look identical.
  echo "✗ refusing $MODEL without --model-shown (or CURSOR_ORCH_MODEL_SHOWN)." >&2
  echo "  The run is verified against the name the agent reports; overriding the model" >&2
  echo "  without saying what it should report would leave the run unverified." >&2
  exit 2
fi

LOG_DIR=${CURSOR_ORCH_LOG_DIR:-.claude/orchestration/cursor}
LOG="$LOG_DIR/$KEY.jsonl"

# Defect: in streaming mode `tee` failed only once the agent was already
# running, so a whole billed run would finish, print its answer, and then be
# reported as "the run never started". The log has to be proved writable before
# anything is spawned.
if ! mkdir -p "$(dirname "$LOG")" 2>/dev/null || ! : 2>/dev/null > "$LOG"; then
  die "cannot write the log at $LOG — fix that before spending a run on it"
fi

PROMPT=$(cat "$PROMPT_FILE")
# PATH inside an agent is rebuilt from the login profile, so what this script
# exports does not order it: bare `node` is whatever that profile defaults to.
# A project that pins a runtime has to say so in the prompt, per command.
if [ -n "$NODE_BIN" ]; then
  PROMPT="Runtime, before anything else: bare \`node\` inside this agent is the login
profile's default, not the runtime this project pins. Every command you run that
depends on the project's runtime must begin with:

    export PATH=\"$NODE_BIN:\$PATH\";

Prefix it per command — an export in one shell call does not reach the next one.

$PROMPT"
fi

launch() {   # $1 = log to write, $2 = prompt
  local log=$1 prompt=$2
  local -a a=(-p --force --trust --output-format stream-json --model "$MODEL" --workspace "$WS")
  [ -n "$CHAT" ] && a+=(--resume "$CHAT")
  if [ "$QUIET" = 1 ]; then
    agent "${a[@]}" "$prompt" > "$log" 2>&1
  else
    # The formatter deliberately drains to EOF rather than exiting on the result
    # event: it shares this pipe with the tee writing the log, and exiting early
    # would cut the log short.
    agent "${a[@]}" "$prompt" 2>&1 | tee "$log" | node "$STREAM" --key "$KEY"
  fi
}

report() {   # $1 = log; sets MODEL_SHOWN / HAS_RESULT / IS_ERROR / TAIL
  IFS=$'\t' read -r MODEL_SHOWN HAS_RESULT IS_ERROR TAIL < <(node "$HARVEST" "$1" --probe)
}

launch "$LOG" "$PROMPT"
report "$LOG"

# What actually ran, read out of the agent's own opening event by a JSON parser
# rather than a regex that assumed no space after the colon.
node "$MODELS" verify --want "$SHOWN_WANT" --got "$MODEL_SHOWN" || {
  echo "  (role $ROLE asked for $MODEL. The whole stream is at $LOG)" >&2; exit 1; }

# A run with no result line ended outside the protocol — a transport error, a
# loop detector. On a real build two of seven chip runs ended this way, 36% of
# all chip runtime, and each was recovered by hand with a resume that carried
# the worktree's state. That resume is mechanical, so it happens here.
if [ "$HAS_RESULT" = 0 ] && [ -n "$CHAT" ] && [ "$RETRY" = 1 ]; then
  echo "⟳ $KEY ended without answering (${TAIL:-no tail}). Resuming once on the same chat." >&2
  STATE=$(cd "$WS" 2>/dev/null && git status --porcelain 2>/dev/null | head -40)
  COUNT=$(printf '%s' "$STATE" | grep -c . || true)
  LOG2="$LOG_DIR/$KEY.2.jsonl"
  : 2>/dev/null > "$LOG2" || die "cannot write the resume log at $LOG2"
  launch "$LOG2" "Your previous run was cut off before it finished. The last thing on the
wire was:

    ${TAIL:-(the stream simply stopped)}

Your worktree at $WS still holds your work, uncommitted — $COUNT changed path(s):

$STATE

DO NOT START OVER and do not re-derive what is already on disk. Read the current
state of those files first and continue from exactly where you stopped."
  LOG=$LOG2
  report "$LOG"
  node "$MODELS" verify --want "$SHOWN_WANT" --got "$MODEL_SHOWN" >/dev/null || {
    echo "✗ $KEY: the resume ran on the wrong model. Stream at $LOG" >&2; exit 1; }
fi

if [ "$HAS_RESULT" = 0 ]; then
  echo "✗ $KEY ended without answering. Stream at $LOG" >&2
  [ -n "$TAIL" ] && echo "  last line: $TAIL" >&2
  exit 1
fi
if [ "$IS_ERROR" = 1 ]; then
  echo "✗ $KEY reported an error. Stream at $LOG" >&2
  exit 1
fi
echo "✓ $KEY finished. Stream: $LOG"
node "$HARVEST" "$LOG" --brief
