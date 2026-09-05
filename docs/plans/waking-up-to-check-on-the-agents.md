# Waking up to check on the agents

Between opening a round and the first run coming back there is nothing. The
orchestrator launches its backgrounded `Bash` calls and then stops, and the only
thing that can wake it is a process exit. A run that is wedged does not exit. A
run whose agent has decided the suite was already red before it started does not
exit either — it keeps going, quietly, for as long as its bound allows.

This adds one thing: **every 15 minutes, from the moment the orchestrator goes
quiet until its agents come back, it wakes up and looks at the logs.** Two
questions, both answerable from the log alone:

1. **Is the log still growing?** A growing log is what alive looks like. One
   that has not gained a byte in fifteen minutes is a run that has died, wedged,
   or is waiting on something nobody is going to give it.
2. **Do the agent's own messages say it is stuck?** A step that has found a
   pre-existing CI failure, or a bug it cannot handle, says so — in words, in
   its message stream — long before the run ends. Nothing reads that stream
   until `run record`, which is after the run is over.

Either one stops the orchestrator and puts it to the human. **Neither is fixed
automatically.** A wedged run and a red suite that was red before this step
started are both decisions, not repairs.

Everything here is in `claude-cursor/`. It touches one file of product code and
adds nothing to the record.

## What exists already, and why it is not this

- **`OPENCODE_ORCH_IDLE`** stops an opencode run whose log has been silent for
  900 seconds. It is a *bound*: it kills the run and records `timeout`. It does
  not exist on the Cursor launcher at all, it says nothing about what the agent
  was saying before it went quiet, and killing a run is the opposite of asking a
  person about it.
- **`$WATCH <key>`** follows one run, in one terminal, for a person to read. It
  is not something the orchestrator can be woken by, and it is per-step.
- **`run record`** reads the whole message stream — after the run has ended.
  Every signal this plan is about is already in the log an hour before then.
- **`slot status`** answers a different question: who holds the machine.

## The mechanism: one more backgrounded call

There is no timer in this arrangement and there should not be one. What the
skill already relies on is that **a backgrounded `Bash` call's exit wakes the
orchestrator** — that is how a finished run announces itself. A watchdog is the
same shape:

```bash
node $ORCH vitals --wait          # sleeps 15 minutes, looks, prints, exits
```

Launched backgrounded beside the round, it sleeps, does the check, writes the
report to stdout and exits. The exit is the wake-up. The orchestrator reads the
report the same way it reads a finished run's, acts on it, and — if anything is
still out — launches another one.

This is deliberately not a daemon and not a cron entry:

- **A daemon outlives the session.** A round that ended an hour ago would still
  have something on the machine looking at its logs. This dies when the session
  does, because it is a child of it.
- **Cron cannot wake this orchestrator.** It has no way to put a message into a
  conversation. Only a process exit does that.
- **Re-arming is the orchestrator's call, not the watchdog's.** A self-relaunching
  watchdog would detach and stop waking anyone. One shot, then the orchestrator
  decides whether there is still anything to watch.

`vitals` with no `--wait` does the same check immediately, which is what to run
when you want to look without waiting — and what the tests drive.

## What it checks

Only steps whose status is `open`. A step that has not been opened has no run,
and one already recorded is not being waited on.

### 1. The log should be growing

For each open step, the log is where its status file says it is, or
`.claude/orch/logs/<key>.jsonl` if there is no status file yet.

- **No log at all** — the launcher never got as far as creating it. The run
  never started. Alarm.
- **Nothing appended for ≥ the interval** — measured from the file's own mtime,
  so the very first look can answer it without needing a previous one to compare
  against. Alarm.
- **Growing** — say by how much, and go on to the messages.

The status file is consulted first, and it settles a case that would otherwise
read as a stall: a run that has *finished* has a log that correctly stops
growing. If the status says anything but `running`, the step is reported as
finished and waiting on `run record`, not as stalled. That is useful on its own —
a run that ended while the orchestrator was between wake-ups is exactly the thing
this arrives to notice.

### 2. The messages may say it is stuck

Only what the agent *said* is scanned — Cursor's `assistant` message content and
its `result`, opencode's `text` parts and `error` events. Not tool output: a
failing suite prints the word "failed" fifty times and none of those are the
agent telling anyone anything.

Two families, because they need different answers from the human:

| family | what it looks like | what it means |
|---|---|---|
| `ci` | "this fails on main too", "pre-existing failure", "the suite was already red", "unrelated to my change" | the step is being blamed for something it did not do |
| `stuck` | "I cannot fix this", "blocked on", "this needs a decision", "out of scope for this step" | the step has hit something outside what it was given |

An `error` event in the new slice counts as `stuck` on its own — opencode puts
provider and tool failures there and nothing else reads them mid-run.

The matched line is quoted in the report, clipped. The orchestrator does not need
to be told what the agent meant; it needs to be shown the sentence.

### Reading only what is new

Each check records, per key, the byte offset it read to. The next check reads
from there. Two reasons, and the second is the important one:

- A real run is 0.7–3.5 MB and twelve of them re-read every fifteen minutes is
  hundreds of megabytes of pointless work.
- **A phrase already reported must not be reported again.** Otherwise every
  subsequent look re-raises the same alarm, the orchestrator stops the round for
  it a second time, and the check becomes something to switch off.

The offsets live in `.claude/orch/vitals.json`. **They are not events.** The
record is what was decided; where a reader got to in a file is not a decision,
and appending to `events.jsonl` every fifteen minutes per open step would bury
the record under bookkeeping. Losing the file costs one duplicate report.

## What it prints, and what it exits

One block per open step, then a verdict. Quiet when everything is fine:

```
  S-1       alive     +412 KB since the last look, last write 40s ago
  S-2       ALARM     silent for 22m — nothing written to .claude/orch/logs/S-2.jsonl since
  S-3       ALARM     stuck: "I can't fix this without a decision on the schema"
  S-4       finished  passed — `run record S-4`

2 of 4 need a person.
```

Exit 0 when nothing needs anybody, 1 when something does. The exit code is what
makes this usable from a script; the report is what makes it usable from the
conversation.

On an alarm the report ends with the instruction that matters, because the wrong
reflex here is to fix it:

> **Stop and ask the human.** Do not send back and do not restart. Say which
> step, quote what it said, and let them decide.

## The skill text

Three edits to `claude-cursor/SKILL.md`:

- A short section under **6. Run**, after the one about opening the whole round:
  launch `vitals --wait` as one extra backgrounded call beside the round, and
  re-launch it whenever it comes back and anything is still open.
- The alarm rule itself: an alarm stops the orchestrator and goes to the user via
  `AskUserQuestion`. It is not a `sendback`, because both things it catches are
  outside what the agent that hit them can decide.
- A gotcha, beside the existing "a run's liveness is its log": the check is only
  as live as the last time it was re-armed, and a round with nothing watching it
  is a round nobody is looking at.

And one to `run open --all`, which is the moment it matters: it already prints
every launcher line for the round, so it prints the `vitals --wait` line under
them as one more backgrounded call in the same message. A watchdog that has to
be remembered is one that gets skipped on exactly the wide rounds that need it.

## The tests

In `test.mjs`, beside the existing orchestrate groups (the stub-`agent` pattern
from the `stages` group is what to copy). `orchestrate.mjs` carries an 85%
function-coverage floor, so every branch below is a case:

1. Nothing open → says so, exits 0, and `--wait` returns immediately rather than
   sleeping for fifteen minutes.
2. A log written a moment ago → `alive`, exit 0.
3. A log whose mtime is old → `ALARM`, `silent for`, exit 1.
4. No log at all → `ALARM`, never started.
5. A status file saying the run ended → `finished`, not a stall, exit 0.
6. An assistant message saying the suite was already red → `ALARM`, family `ci`,
   the sentence quoted.
7. An opencode `text` part saying it cannot fix something → `ALARM`, `stuck`.
8. A failing command's *output* containing the same words → no alarm. This is
   the false-positive case, and it is the one that decides whether the check
   survives contact with a real round.
9. The same alarming line, checked twice → raised once. Offsets advance.

## What this does not do

- **It does not kill anything.** `OPENCODE_ORCH_IDLE` is still the only thing
  that stops a run, and it stays as it is.
- **It does not judge the work.** A step writing nonsense fast looks alive here.
  `run record` and `guard` are where the work is judged.
- **It does not watch Claude Code subagent steps for silence.** They write no
  jsonl log; the Agent tool's own completion wakes the orchestrator instead. A
  step with no status file behind it is listed `skipped` rather than alarmed on.
