#!/usr/bin/env bash
# Watch a run that is already going, from anywhere.
#
# The launcher shows a run in the pane that started it. This attaches to one
# after the fact — another pane, another session, a run somebody else started —
# by replaying its log from the top and then following it live. Same formatter,
# so a run looks the same however you came to be watching it.
#
# It stops when the run stops. `tail -f` has no stop condition of its own, so
# this used to follow a finished run forever: in a foreground call that meant
# burning the whole timeout on a run that had ended minutes earlier.
#
#   watch.sh 2.1              replay, then follow, then exit when it ends
#   watch.sh --window 2.1     the same, in its own terminal window
#   watch.sh --tail 2.1       skip the replay, only what happens next
#   watch.sh --keep 2.1       do not exit at the end; keep following
set -uo pipefail

SELF=$(cd "$(dirname "$0")" && pwd)
WINDOW=0 FROM=1 KEEP=0 TARGET= PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --window) WINDOW=1; shift ;;
    --tail)   FROM=0; shift ;;
    --keep)   KEEP=1; shift ;;
    --quiet-think|--full) PASS+=("$1"); shift ;;
    -*) echo "✗ unknown argument: $1" >&2; exit 2 ;;
    *) TARGET=$1; shift ;;
  esac
done
[ -n "$TARGET" ] || { echo "usage: watch.sh [--window] [--tail] [--keep] <key|log-path>" >&2; exit 2; }

LOG=$TARGET
case "$TARGET" in
  */*|*.jsonl) ;;
  *) LOG="${CURSOR_ORCH_LOG_DIR:-.claude/orchestration/cursor}/$TARGET.jsonl" ;;
esac

# A watcher started in the same breath as the run would otherwise lose the race
# with the first write.
for _ in $(seq 1 60); do [ -f "$LOG" ] && break; sleep 0.5; done
[ -f "$LOG" ] || { echo "✗ no log appeared at $LOG" >&2; exit 2; }

if [ "$WINDOW" = 1 ]; then
  TERM_BIN=$(command -v konsole || command -v gnome-terminal || command -v xfce4-terminal \
             || command -v x-terminal-emulator || command -v xterm) || true
  [ -n "${TERM_BIN:-}" ] || {
    echo "✗ no terminal emulator found — run without --window, or in your own pane:" >&2
    echo "    $0 $TARGET" >&2; exit 2; }
  # Deliberately detached: the window outlives this command, which is the point
  # of asking for one.
  setsid "$TERM_BIN" -e bash -c "'$0' ${PASS[*]:-} '$TARGET'; echo; echo '[run ended — press enter]'; read" \
    >/dev/null 2>&1 &
  echo "watching $TARGET in a $(basename "$TERM_BIN") window"
  exit 0
fi

# --exit-on-result is what ends the follow: the formatter stops after the result
# event (or a bare error tail), `tail` takes the SIGPIPE, and the pipeline ends.
# Only reading here, so nothing can be truncated by that.
STOP=(--exit-on-result)
[ "$KEEP" = 1 ] && STOP=()

if [ "$FROM" = 1 ]; then tail -n +1 -f "$LOG"; else tail -n 0 -f "$LOG"; fi \
  | node "$SELF/stream.mjs" --key "$(basename "$LOG" .jsonl)" "${PASS[@]:-}" "${STOP[@]:-}"
