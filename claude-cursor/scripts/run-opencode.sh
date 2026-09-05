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
if [ -z "$MODEL" ] || [ -z "$EFFORT" ]; then
  IFS=$'\t' read -r T_MODEL T_SHOWN T_EFFORT < <(node "$MODELS" resolve --runner opencode "${TIER:-$ROLE}") || exit 2
  if [ -z "$MODEL" ]; then
    MODEL=$T_MODEL
    SHOWN=$T_SHOWN
  else
    # An explicit --model overrides the table's, so what is reported and what
    # is checked below both have to be the model that will actually run —
    # not the tier's default, which `resolve` printed for a model nobody asked
    # for here.
    SHOWN=$MODEL
  fi
  EFFORT=${EFFORT:-$T_EFFORT}
else
  SHOWN=$MODEL
fi
[ -n "$MODEL" ] || die "could not resolve a model for role $ROLE"

# The one check available: `opencode run --variant <nonsense>` runs a normal
# turn and reports nothing, so a typo would cost the reasoning the tier was
# chosen for and nothing would say so. This used to run only when the table
# picked BOTH the model and the effort — pass `--model` and `--effort`
# together (both are documented, accepted flags) and it was skipped entirely,
# which is exactly backwards: an explicit pair is at least as likely to carry
# a typo as one the table resolved. It now runs unconditionally, against
# whichever model will actually run.
node "$MODELS" effort-check --runner opencode --model "$MODEL" --effort "$EFFORT" || exit 2

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
KILLED_FILE=
finish() {
  local code=$?
  printf 'exit %s\t%s\t%s\t%s\n' "$code" "$OUTCOME" "$KEY" "$LOG" > "$STATUS" 2>/dev/null || true
  [ -n "$KILLED_FILE" ] && rm -f "$KILLED_FILE" 2>/dev/null
  return 0
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
# So every run is bounded — but bounded on the RIGHT thing. A wall-clock cap
# cannot tell a wedged provider from a step that is simply long, and the cost of
# guessing was paid twice: the 30-minute default killed an xhigh step that had
# done all its work and had not yet committed, and raising it to 90 minutes
# killed another one the same way. Meanwhile a genuinely wedged run — the case
# the bound exists for — writes nothing at all, and says so within seconds.
#
# The bound is therefore SILENCE, not duration. If the log has not grown for
# OPENCODE_ORCH_IDLE seconds the run is wedged and is stopped; as long as events
# keep arriving it is working and is left alone. OPENCODE_ORCH_TIMEOUT stays as
# an outer wall-clock backstop, now generous enough that reaching it means
# something is wrong rather than that the work was big. Either at 0 switches
# that bound off.
IDLE=${OPENCODE_ORCH_IDLE:-900}
TIMEOUT=${OPENCODE_ORCH_TIMEOUT:-21600}

# Bytes on disk, however the platform spells it. `wc -c` is the one form present
# everywhere `bash` is; `stat` differs between GNU and BSD and is not worth the
# case statement. BSD's `wc` pads with spaces, so the value is stripped.
#
# An unreadable log has to come back as 0 and not as empty: an empty string
# never equals the previous reading, so the watcher below would see the log
# "growing" on every poll and the idle bound would never fire again — the one
# failure mode that looks exactly like the bug this replaced.
#
# What it measures is the file, not the stream. A provider that emits an event
# every few minutes could in principle sit in a pipe buffer between polls; at
# the default fifteen-minute window there is no such gap that is not already
# the silence this is looking for.
log_size() {
  # The redirection is inside the braces so a missing file is the SHELL's error
  # to swallow, not `wc`'s: `wc -c < missing 2>/dev/null` still prints "No such
  # file", because the redirect fails before wc runs — and the watcher below
  # would print that on every poll for the whole run.
  local n; n=$( { wc -c < "$1"; } 2>/dev/null ); n=${n//[^0-9]/}
  printf '%s' "${n:-0}"
}

# Why the run was stopped, written by the watcher for the parent to read back.
# A variable cannot cross the fork. Declared empty beside the EXIT trap above so
# that trap can remove it on every path out, including the early ones.
KILLED_FILE=$(mktemp "${TMPDIR:-/tmp}/opencode-killed.XXXXXX" 2>/dev/null) || KILLED_FILE="/tmp/opencode-killed.$$"
: > "$KILLED_FILE"

launch() {   # $1 = log to write, $2 = prompt
  local log=$1 prompt=$2
  local -a a=(run --dir "$WS" -m "$MODEL" --variant "$EFFORT" --auto --format json)
  # opencode's own resume flag is `-s <sessionID>` (see the plan this was built
  # from) — not `--session`, which is only this launcher's own flag name for
  # the same value. Unconfirmed against a live binary; nothing in this
  # environment has opencode installed to check it against.
  [ -n "$SESSION" ] && a+=(-s "$SESSION")

  if [ "$TIMEOUT" -le 0 ] 2>/dev/null && [ "$IDLE" -le 0 ] 2>/dev/null; then
    if [ "$QUIET" = 1 ]; then
      "$OC" "${a[@]}" "$prompt" > "$log" 2>&1
    else
      "$OC" "${a[@]}" "$prompt" 2>&1 | tee "$log" | node "$STREAM" --key "$KEY" --runner opencode
    fi
    return "${PIPESTATUS[0]}"
  fi

  # Bounded. opencode is started as our own background job (not the first stage
  # of a pipeline — killing the PID `$!` gives for the LAST stage of a pipeline
  # does not stop the first one) so its PID is ours to watch, and its output is
  # read back through a FIFO once it is running.
  #
  # This used to be the fallback for machines with no `timeout` binary, with
  # `timeout --foreground` taking the ordinary path. It is now the only path,
  # because the bound is no longer a duration `timeout` could enforce: the
  # watcher has to look at the log to tell a wedged run from a long one, and
  # `timeout` cannot.
  #
  # Two things here earned their comment by failing first, measured rather
  # than assumed:
  #
  #   · A first attempt piped straight from a `coproc`'s read-end fd instead
  #     of a FIFO. Killing the coproc's child did NOT unblock a `cat` reading
  #     that fd — it stayed blocked until the child would have exited on its
  #     own, which is not a bound at all, just a slower way to not have one.
  #     A FIFO does not have that problem: every writer closing is what gives
  #     its reader EOF, and killing the writer closes it.
  #   · Killing only `$oc_pid` was not enough either, once `$OC` is itself a
  #     wrapper that runs the real work as its own child (true of the test
  #     stub, and not something to assume is never true of a real install):
  #     the wrapper dies, its child is orphaned still holding the FIFO open,
  #     and the read side hangs exactly as before. `set -m` gives the
  #     backgrounded job its own process group, and `kill -TERM -"$oc_pid"`
  #     (the leading `-` means the group, not just the leader) takes the
  #     whole thing down together — which is what real `timeout` was already
  #     doing, confirmed by running it against this same wrapper stub.
  local rc
  local fifo; fifo=$(mktemp -u "${TMPDIR:-/tmp}/opencode-fifo.XXXXXX") || fifo="/tmp/opencode-fifo.$$"
  mkfifo "$fifo" 2>/dev/null || { echo "✗ could not create a FIFO for the bounded run at $fifo" >&2; return 2; }
  local had_m=1; case $- in *m*) : ;; *) had_m=0 ;; esac
  set -m
  "$OC" "${a[@]}" "$prompt" > "$fifo" 2>&1 &
  local oc_pid=$!
  # One watcher, both bounds. It polls rather than sleeping the whole limit,
  # because the idle bound is a question about the log that has to be asked
  # repeatedly. The interval comes off the SMALLER of the two live bounds — a
  # poll derived from the idle window alone would overshoot a short wall-clock
  # backstop by its whole first sleep, which is a bound that does not bound.
  # A tenth of that, floored at a second so it cannot spin, capped at fifteen so
  # a six-hour backstop does not wake every half hour for nothing.
  local tightest=$IDLE
  { [ "$tightest" -le 0 ] 2>/dev/null || { [ "$TIMEOUT" -gt 0 ] 2>/dev/null && [ "$TIMEOUT" -lt "$tightest" ]; }; } && tightest=$TIMEOUT
  local poll=$(( tightest / 10 )); [ "$poll" -lt 1 ] && poll=1; [ "$poll" -gt 15 ] && poll=15
  (
    elapsed=0; quiet=0; last=$(log_size "$log")
    while kill -0 "$oc_pid" 2>/dev/null; do
      sleep "$poll"
      elapsed=$(( elapsed + poll ))
      now=$(log_size "$log")
      if [ "$now" != "$last" ]; then quiet=0; last=$now; else quiet=$(( quiet + poll )); fi
      if [ "$IDLE" -gt 0 ] 2>/dev/null && [ "$quiet" -ge "$IDLE" ]; then
        echo "idle" > "$KILLED_FILE"; kill -TERM -"$oc_pid" 2>/dev/null; exit 0
      fi
      if [ "$TIMEOUT" -gt 0 ] 2>/dev/null && [ "$elapsed" -ge "$TIMEOUT" ]; then
        echo "wall" > "$KILLED_FILE"; kill -TERM -"$oc_pid" 2>/dev/null; exit 0
      fi
    done
  ) &
  local watcher=$!
  if [ "$QUIET" = 1 ]; then
    cat < "$fifo" > "$log"
  else
    cat < "$fifo" | tee "$log" | node "$STREAM" --key "$KEY" --runner opencode
  fi
  wait "$oc_pid" 2>/dev/null
  rc=$?
  [ "$had_m" = 1 ] || set +m
  kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
  rm -f "$fifo"
  # Killed by the watcher, not by itself. 124 is what `timeout` uses and what
  # every reader of this script's exit code already understands.
  [ -s "$KILLED_FILE" ] && rc=124
  [ "$rc" -ge 128 ] && rc=124
  return "$rc"
}

launch "$LOG" "$PROMPT"
LAUNCH_RC=$?

# 124: the watcher had to stop it. Which bound it hit changes what to do next,
# so the two are not reported as one thing.
if [ "$LAUNCH_RC" = 124 ]; then
  OUTCOME=timeout
  WHY=$(cat "$KILLED_FILE" 2>/dev/null)
  if [ "$WHY" = idle ]; then
    echo "✗ $KEY wrote nothing for ${IDLE}s and was stopped." >&2
    echo "  Not a long run — a silent one. The log holds whatever it managed to say: $LOG" >&2
    if [ ! -s "$LOG" ]; then
      echo "  It wrote nothing at all, which is the provider accepting the request and" >&2
      echo "  never answering. Check that a trivial run works before spending the round:" >&2
      echo "    $OC run -m $MODEL --format json \"Reply with exactly: OK\"" >&2
    else
      echo "  It was working and then stopped emitting. Resume it rather than starting" >&2
      echo "  again — its worktree still holds the work." >&2
    fi
    echo "  OPENCODE_ORCH_IDLE=<seconds> changes how long silence is allowed (0 = never stop)." >&2
  else
    echo "✗ $KEY was still running after ${TIMEOUT}s and was stopped." >&2
    echo "  It was still emitting events, so this is the outer backstop rather than a" >&2
    echo "  wedged provider: the work is genuinely that long, or it is looping." >&2
    echo "  The log holds whatever it managed to say: $LOG" >&2
    echo "  OPENCODE_ORCH_TIMEOUT=<seconds> raises the backstop (0 = no wall-clock bound)." >&2
  fi
  echo "  Whatever it had done is uncommitted in $WS — resume, do not restart." >&2
  rm -f "$KILLED_FILE"
  exit 1
fi
rm -f "$KILLED_FILE"

# What the log can actually answer: did it error, did it say anything, and which
# session is it on. There is no model question to ask.
#
# Captured rather than fed straight into `read` via process substitution, so
# the harvester's own exit code is not thrown away: 2 means it could not even
# be run (bad args, an unreadable log), which is a different failure than the
# run itself having died or errored, and deserves its own message rather than
# reading as "ended without answering".
PROBE_OUT=$(node "$HARVEST" "$LOG" --probe)
HARVEST_RC=$?
if [ "$HARVEST_RC" = 2 ]; then
  OUTCOME=error
  echo "✗ could not harvest $LOG" >&2
  [ -n "$PROBE_OUT" ] && echo "  $PROBE_OUT" >&2
  exit 1
fi
IFS=$'\t' read -r SESSION_ID HAS_ANSWER IS_ERROR TAIL <<< "$PROBE_OUT"
# `-` is the harvester's sentinel for "no session id was ever reported" — not
# empty. A field left genuinely empty would be a leading empty field ahead of
# HAS_ANSWER/IS_ERROR/TAIL in tab-separated output, and `read` under
# `IFS=$'\t'` collapses a leading tab the same way it collapses a leading
# space: the empty field vanishes and every value after it shifts left by
# one — HAS_ANSWER would silently take on the error flag's value, IS_ERROR
# would take on the tail text, and an actually-errored run would read as
# `IS_ERROR=<some text>`, never `1`, so the error branch below would never
# fire. That is a failed run reported as passed.
[ "$SESSION_ID" = '-' ] && SESSION_ID=

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
