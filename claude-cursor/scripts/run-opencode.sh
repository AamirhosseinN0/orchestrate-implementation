#!/usr/bin/env bash
# Run one step on opencode and put its whole stream on disk.
#
# Beside run.sh rather than inside it. The two share only the contracts that
# `run record` and `run open` read — the log path, and the .status line — and
# nothing else, because almost nothing else is the same:
#
#   · There is no chat to mint first. Cursor needs an address before it has a
#     conversation, so `cursor-chat.sh` makes one; opencode puts `sessionID` on
#     every event, so the address falls out of the run. `--session` is only for
#     a send-back, and its value comes from the record of the first run.
#   · There is no model to verify afterwards. opencode's JSON names the model
#     nowhere, so the check run.sh makes has nothing to read. What is checked
#     instead happens BEFORE the run: that the effort is one this model accepts.
#     See models.mjs `effortsOf`.
#   · --auto is what --force --trust is for Cursor: it auto-approves every
#     permission that is not explicitly denied. Right for an unattended worktree
#     run, and said out loud here because it is not a small thing.
set -uo pipefail

SELF=$(cd "$(dirname "$0")" && pwd)
MODELS="$SELF/models.mjs"
HARVEST="$SELF/harvest-opencode.mjs"
STREAM="$SELF/stream.mjs"

KEY= WS=. SESSION= ROLE= TIER= PROMPT_FILE=
MODEL="${OPENCODE_ORCH_MODEL:-}"
EFFORT="${OPENCODE_ORCH_EFFORT:-}"
NODE_BIN="${CURSOR_ORCH_NODE_BIN:-}"
QUIET=0

die() { echo "✗ $*" >&2; exit 2; }
need() { [ "$2" -ge 2 ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --key)          need "$1" $#; KEY=$2; shift 2 ;;
    --workspace)    need "$1" $#; WS=$2; shift 2 ;;
    --session)      need "$1" $#; SESSION=$2; shift 2 ;;
    --chat)         need "$1" $#; SESSION=$2; shift 2 ;;   # the name run open prints for either runner
    --role)         need "$1" $#; ROLE=$2; shift 2 ;;
    --tier)         need "$1" $#; TIER=$2; shift 2 ;;
    --model)        need "$1" $#; MODEL=$2; shift 2 ;;
    --effort)       need "$1" $#; EFFORT=$2; shift 2 ;;
    --node-bin)     need "$1" $#; NODE_BIN=$2; shift 2 ;;
    --prompt-file)  need "$1" $#; PROMPT_FILE=$2; shift 2 ;;
    --runner)       need "$1" $#; shift 2 ;;   # already here by being this script
    --quiet)        QUIET=1; shift ;;
    --no-retry)     shift ;;                   # accepted for symmetry; see below
    --stream)       shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$KEY" ] || die "--key <name> is required — it names the log"
[ -n "$ROLE" ] || die "--role <name> is required — it selects the effort"
[ -n "$PROMPT_FILE" ] || die "--prompt-file <path> is required"
[ -r "$PROMPT_FILE" ] || die "cannot read the prompt file at $PROMPT_FILE"

# The binary, from the table. It is not on a non-interactive PATH — the login
# profile puts it there — so being able to run `opencode` in a terminal is not
# the same as this being able to, and the failure has to say which.
OC=$(node "$MODELS" which --runner opencode) || exit 2

# The model and the effort, from the table rather than a case statement in here.
# This is also where an effort the model does not accept is refused, which is
# the only check available: `opencode run --variant <nonsense>` runs a normal
# turn and reports nothing, so a typo would cost the reasoning the tier was
# chosen for and nothing would say so.
if [ -z "$MODEL" ] || [ -z "$EFFORT" ]; then
  IFS=$'\t' read -r T_MODEL T_SHOWN T_EFFORT < <(node "$MODELS" resolve --runner opencode "${TIER:-$ROLE}") || exit 2
  MODEL=${MODEL:-$T_MODEL}
  EFFORT=${EFFORT:-$T_EFFORT}
  SHOWN=${T_SHOWN:-$MODEL}
else
  SHOWN=$MODEL
fi
[ -n "$MODEL" ] || die "could not resolve a model for role $ROLE"

LOG_DIR=${CURSOR_ORCH_LOG_DIR:-.claude/orch/logs}
LOG="$LOG_DIR/$KEY.jsonl"

# Proved writable before anything is spawned, for the same reason run.sh does
# it: a billed run that finishes and then cannot be written is reported as a run
# that never started.
if ! mkdir -p "$(dirname "$LOG")" 2>/dev/null || ! : 2>/dev/null > "$LOG"; then
  die "cannot write the log at $LOG — fix that before spending a run on it"
fi

# Backgrounded and detached comes back as exit -1 whatever happened, so how the
# run ended goes on disk. Same file, same four fields, same reader.
STATUS_DIR=${CURSOR_ORCH_DIR:-.claude/orch}/runs
STATUS="$STATUS_DIR/$KEY.status"
OUTCOME=started
mkdir -p "$STATUS_DIR" 2>/dev/null || true
finish() {
  local code=$?
  printf 'exit %s\t%s\t%s\t%s\n' "$code" "$OUTCOME" "$KEY" "$LOG" > "$STATUS" 2>/dev/null || true
}
trap finish EXIT
printf 'exit -\trunning\t%s\t%s\n' "$KEY" "$LOG" > "$STATUS" 2>/dev/null || true

PROMPT=$(cat "$PROMPT_FILE")
# Same reason as run.sh: PATH inside the agent is the login profile's, so a
# pinned runtime has to be stated per command rather than exported once.
if [ -n "$NODE_BIN" ]; then
  PROMPT="Runtime, before anything else: bare \`node\` inside this agent is the login
profile's default, not the runtime this project pins. Every command you run that
depends on the project's runtime must begin with:

    export PATH=\"$NODE_BIN:\$PATH\";

Prefix it per command — an export in one shell call does not reach the next one.

$PROMPT"
fi

# A run that hangs is worse than one that fails, because nothing downstream has
# a reason to stop waiting: the status stays `running`, the orchestrator waits
# on a process exit that never comes, and the round stalls with no error
# anywhere.
#
# That is not hypothetical. The provider has been seen accepting a request and
# then returning nothing at all — no events, no error, empty stderr, nothing in
# opencode's own log — for a prompt that had answered in about a second minutes
# earlier. Two different models did it at once, so it was the service rather
# than the model or the effort.
#
# So every run is bounded. The default is generous enough for real work at max
# effort and short enough that a wedged round is noticed within the hour.
TIMEOUT=${OPENCODE_ORCH_TIMEOUT:-1800}
have_timeout=0
command -v timeout >/dev/null 2>&1 && have_timeout=1

launch() {   # $1 = log to write, $2 = prompt
  local log=$1 prompt=$2
  local -a a=(run --dir "$WS" -m "$MODEL" --variant "$EFFORT" --auto --format json)
  [ -n "$SESSION" ] && a+=(--session "$SESSION")
  local -a t=()
  [ "$have_timeout" = 1 ] && [ "$TIMEOUT" -gt 0 ] 2>/dev/null && t=(timeout --foreground "$TIMEOUT")
  if [ "$QUIET" = 1 ]; then
    "${t[@]}" "$OC" "${a[@]}" "$prompt" > "$log" 2>&1
  else
    # Drains to EOF rather than exiting on the last event, because this pipe is
    # shared with the tee writing the log and exiting early truncates it.
    #
    # The timeout wraps opencode and not the pipeline, so a kill still lets the
    # tee and the formatter finish what they already have — a timed-out run
    # keeps whatever it managed to say.
    "${t[@]}" "$OC" "${a[@]}" "$prompt" 2>&1 | tee "$log" | node "$STREAM" --key "$KEY" --runner opencode
  fi
  return "${PIPESTATUS[0]}"
}

launch "$LOG" "$PROMPT"
LAUNCH_RC=$?

# 124 is what `timeout` exits with when it had to kill the command.
if [ "$LAUNCH_RC" = 124 ]; then
  OUTCOME=timeout
  echo "✗ $KEY was still running after ${TIMEOUT}s and was stopped." >&2
  echo "  The log holds whatever it managed to say: $LOG" >&2
  if [ ! -s "$LOG" ]; then
    echo "  It wrote nothing at all, which is the provider accepting the request and" >&2
    echo "  never answering. Check that a trivial run works before spending the round:" >&2
    echo "    $OC run -m $MODEL --format json \"Reply with exactly: OK\"" >&2
  fi
  echo "  Raise the limit with OPENCODE_ORCH_TIMEOUT=<seconds> if the work is genuinely long." >&2
  exit 1
fi

# What the log can actually answer: did it error, did it say anything, and which
# session is it on. There is no model question to ask.
IFS=$'\t' read -r SESSION_ID HAS_ANSWER IS_ERROR TAIL < <(node "$HARVEST" "$LOG" --probe)

OUTCOME=ran

# A run that dies is not resumed automatically the way run.sh resumes one. On
# Cursor the chat exists before the run and survives it, so a resume is always
# possible; here the session only exists if the run got far enough to emit an
# event. Rather than guess, the session id is reported and `sendback` resumes it
# deliberately.
if [ "$IS_ERROR" = 1 ]; then
  OUTCOME=error
  echo "✗ $KEY reported an error. Stream at $LOG" >&2
  [ -n "$TAIL" ] && echo "  $TAIL" >&2
  [ -n "$SESSION_ID" ] && echo "  Resume it with: --session $SESSION_ID" >&2
  exit 1
fi
if [ "$HAS_ANSWER" != 1 ]; then
  OUTCOME=no-answer
  echo "✗ $KEY ended without answering. Stream at $LOG" >&2
  [ -n "$SESSION_ID" ] && echo "  Resume it with: --session $SESSION_ID" >&2
  exit 1
fi

OUTCOME=passed
echo "✓ $KEY finished on $SHOWN (effort: $EFFORT). Stream: $LOG"
echo "  session: ${SESSION_ID:-(none reported)}"
echo "  status: $STATUS"
echo "  the model that answered is not recorded by opencode, so this is what was"
echo "  asked for rather than what was verified."
node "$HARVEST" "$LOG" --brief --root "$WS" --model "$MODEL" --effort "$EFFORT"
