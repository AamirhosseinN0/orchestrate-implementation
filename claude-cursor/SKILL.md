---
name: claude-cursor
description: Run an implementation end to end in five stages — load the plans, judge how hard each step is and pick a model for it, refine away the ambiguity, check that nothing collides, then run every step that can run at once. Every step that can run is launched in the same round on its own agent; only an unlanded dependency or a serialisation point that open work is already moving holds one back. Two steps owning the same file run together and reconcile at the merge, because each builds in its own worktree. Agents execute on the Cursor CLI (`agent`) or as Claude Code subagents. Use when asked to orchestrate a plan, run an implementation, hand the building work to Cursor agents, run steps in parallel, drive work in parallel worktrees, pick models per step, or take a written plan through to merged code.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, AskUserQuestion, TodoWrite
---

# Five stages

```
load  →  assess  →  refine  →  check  →  run
```

Everything is one command. Run them all from the project root.

```bash
ORCH=~/.claude/skills/claude-cursor/orchestrate.mjs
RUN=~/.claude/skills/claude-cursor/scripts/run.sh
WATCH=~/.claude/skills/claude-cursor/scripts/watch.sh
```

State lives in `.claude/orch/`. `events.jsonl` is the record and `state.json` is
a projection of it, so nothing is lost if a session ends mid-build.

**This is self-contained.** It does not read any other skill.

## The rule: run everything that can run at once

**Every step that can run must be launched in the same round, on its own agent.
Only two things hold a step back: a dependency that has not landed, and a
serialisation point that open work is already moving.**

Not caution about the runner, not tidiness, not "let me see how the first one
goes", not the size of the round. If `check` names five steps, five agents start
now — five separate backgrounded `Bash` calls, in one message.

**Two steps owning the same file is not a reason to wait.** Each builds in its
own worktree, on its own copy of the repository, so two agents writing one file
never meet. What they both changed is reconciled once, at the merge, by whichever
branch goes second — and that costs far less than making one of them sit through
the other's whole run and landing. `check` names the pairs that will need it and
`join` says when the moment comes.

**A shared serialisation point is different in kind, and does hold a step back.**
A lockfile, a migration head, a closed list a test asserts on: git merges these
cleanly and produces something wrong. There is no conflict to see and no diff to
read, and the fix is not a code change — a lockfile is regenerated, not merged.
Those go one at a time.

`check` computes both, and the set it prints is already safe to open all at once
because it checks the candidates against each other as well as against what is
out.

The evidence for the rule is the refining stage: ten agents launched together
turned 130 minutes of work into a 17-minute span. (The chip stage on that same
build ran one at a time, but its steps were a near-total dependency chain —
S-001 → S-002 → S-006 → S-007 → S-008 → S-009 → S-010 — so most of that was
required, not wasted. The rule matters for graphs that are wider than that one.)

Up to twelve agents in flight is verified clean; the ceiling is memory, not the
API. Heavy checks inside those agents go through `slot`, so twelve suites queue
instead of colliding.

## Before anything

```bash
agent status                    # not logged in → stop, ask the user to run `agent login`
node $ORCH models                # the ladder this account can actually run
```

If the ladder has drifted from what the account can actually run:

```bash
node $ORCH models sync
```

## 1. Load the plans

```bash
node $ORCH load docs/plans/
```

It prints every plan and how long it is. **Read every one of them in full before
going further.** Nothing downstream can recover a plan you skimmed.

## 2. Assess — how hard each step is, and what runs it

The ladder, weakest to strongest:

| tier | model | for |
|---|---|---|
| `composer` | Composer 2.5 | mechanical work, no judgement — a lockfile bump, a rename |
| `low` | Cursor Grok 4.6 Low | small, well-specified, one or two files |
| `medium` | Cursor Grok 4.6 Medium | ordinary feature work against a clear plan |
| `high` | Cursor Grok 4.6 High | the default — refining, and most steps |
| `xhigh` | Cursor Grok 4.6 Extra High | security, concurrency, wide blast radius, anything subtle |

Read the plans, then propose one row per step — the problem in a few words, the
tier, and why:

```bash
node $ORCH assess propose <<'J'
[{"key":"S-1","problem":"contracts package + type provider","tier":"medium","why":"mechanical, schema-shaped"},
 {"key":"S-2","problem":"auth middleware, session + CSRF","tier":"xhigh","why":"security-sensitive, wide blast radius"},
 {"key":"S-3","problem":"bump lockfile, regenerate docs","tier":"composer","why":"no judgement needed"}]
J
node $ORCH assess
```

**Show that table to the user and let them change it before anything runs.** They
may accept it or move any row:

```bash
node $ORCH assess set S-2=high S-3=low
```

A row the user set is marked `*` and is never quietly re-proposed over. `assess
check` exits 1 while any step has no model.

Assess runs on the steps, so on a first pass it comes after refining. On a
re-run — a plan changed, the user wants it cheaper — run it any time.

## 3. Refine — one agent per plan, all at once

```bash
node $ORCH refine brief docs/plans/2.1.md > /tmp/refine-2.1.txt
$RUN --role refine --key refine-2.1 --workspace . --prompt-file /tmp/refine-2.1.txt
node $ORCH refine done docs/plans/2.1.md
```

**Launch the whole set in one round**, one backgrounded `Bash` call each. They
only ever touch their own plan, so they cannot collide, and twelve in flight is
verified clean. On a real build ten refining agents finished 130 minutes of work
in a 17-minute span. Starting them one at a time spends that for nothing.

A refining agent writes its report to a file. `refine done` reads that file — not
the agent's reply — because a reply goes through a context that gets compacted.
It validates the report **whole and records it whole**: an `owns` entry that is
prose rather than a path, ownership of part of a file, a `needs` naming something
that is not a step, or a key another plan already holds, and nothing from that
report is written at all.

**Keys are unique across every plan in the round.** Twelve plans refined at once
each reached for `S-1`, and a register that merged them on key alone lost eight
steps without a word. The brief tells each agent to key from its own plan —
`S-2.1.1`, `S-2.1.2` — and a report that reuses another plan's key is refused.
`refine done` prints the register's total beside the report's count, which is the
number that would have shown the loss.

It also prints what the refining agent did to the plan, as a diffstat. Refining
rewrites its plan in place, and a rewrite that breaks a repo-level lint is
otherwise invisible.

A plan that names `requires:` in its front matter has that read at `load` and put
in front of the refining agent, along with the keys already recorded for those
plans, so cross-plan ordering reaches `needs` instead of being derived by hand
afterwards.

`refine done` prints any question the agent could not settle from the code. **Put
those to the user before building.** `refine check` exits 1 while one is open.

## 4. Check — what can open together

```bash
node $ORCH check
```

It prints three things: the set that can open right now, the steps held back and
exactly what they would collide with, and the steps still waiting on work to
land.

It holds a step back only for a serialisation point that open work is already
moving, or a dependency that has not landed. Steps that share a file are listed
separately, as merges to sequence rather than collisions to prevent.

Then sweep everything the steps cite, immediately before opening them:

```bash
node $ORCH doctor
```

It checks that each step's plan still exists, its dependencies are real steps,
every `owns` entry is a path `guard` could match against a diff, every proof
starts with something runnable, and every step has a model. It fails on the
things nothing else sees: two open steps claiming one path or holding one
serialisation point, and **two spellings of one serialisation point** — six names
for one migration head across eleven steps is a round where `check` opens two
migration-writing steps together and git merges them cleanly and wrongly. A pair
that differs by only one word is said out loud without failing.

A directory a step is about to create is a note, not a fault: on a build from
nothing that is most of the round. What still fails is a first segment that does
not exist beside something almost exactly like it — a typo, not a plan.

It also warns when a brief is older than the step it describes, because the agent
holding it will not know. `doctor --all` adds the quieter notes: every
serialisation point only one step names, whether or not anything looks like it.

Run it here, not earlier. With nothing open it says so rather than passing, and a
tick over nothing checked is how a green report starts meaning nothing.

## 5. Run

```bash
node $ORCH run open S-1
```

That makes the worktree and branch, mints a fresh chat, writes the brief, and
prints the exact launcher line. Then launch it as a **backgrounded** `Bash` call:

```bash
$RUN --role chip --tier medium --key S-1 --workspace <worktree> \
     --chat <uuid> --prompt-file .claude/orch/briefs/S-1.md
```

### Open everything `check` names, in the same round

This is **the rule** at the top of this document, and it is the single biggest
thing you can get wrong. `run open` each step, then launch each as its own
backgrounded `Bash` call — separate calls in one message, not a loop that waits
on each in turn. That is what makes them concurrent and what wakes you as each
finishes.

`run open` tells you when you have stopped short: it names how many more `check`
would still allow and refuses to let that pass unnoticed.

**Do not judge a backgrounded run by its exit code.** A detached process comes
back as `-1  [process exited while detached; exit code unknown]` whether it
passed, was rejected for its model, or died mid-stream. Every run writes how it
ended to `.claude/orch/runs/<key>.status` instead:

```
exit 0	passed	S-1	.claude/orch/logs/S-1.jsonl
exit 1	wrong-model	S-2	.claude/orch/logs/S-2.jsonl
```

Read that, then `run record <key> --log <log>`, which harvests the log whatever
the status says.

### One step per agent, and never two

**Never give one agent two step keys.** It reads like a saving and it is the most
expensive mistake here, because four things are keyed to one step per agent and
none of them complains when it breaks:

- **The chat uuid is one step's address.** Two keys on one chat and a send-back
  for S-1 arrives at an agent midway through S-2.
- **The branch is the unit of merge.** `guard` passes or fails the pair; one step
  failing takes a finished one down with it.
- **A run record belongs to one step.** Two steps in one run file one report.
- **It converts parallel work into serial work.** Two steps in one agent run one
  after the other; two agents run at the same time.

If two steps genuinely are the same edit, that is one step — say so in the
register, not in the prompt.

### When a run finishes

Its process exit wakes you.

```bash
node $ORCH run record S-1 --log .claude/orch/logs/S-1.jsonl
node $ORCH guard S-1
node $ORCH join S-1                          # merges it into the main line
node $ORCH slot run ci -- <your test command>   # on the JOINED tree
node $ORCH land S-1 --sha <sha>
node $ORCH check                             # a landing usually widens what can open
```

`run record` reads the log rather than asking what happened: what files were
written and by how much, which commands failed and what they printed, how much
transport trouble the run hit, and whether it answered at all. A file the step
wrote but does not own is reported here, before `guard` runs.

**Do not summarise a run into the record yourself.** That is the failure this
replaces. On the real build, 36 MB across 27 runs became 5,670 characters of
typed prose and a five-line ledger.

### When a join conflicts, or the joined tree goes red

Both are the same event: the step's branch and the main line disagree. `join`
rolls the merge back so the main line is untouched, names the files and which
landed step is the other side, and stops.

**Send it back to the agent that wrote it.** It is still on its chat, and it
knows why it made those changes:

```bash
node $ORCH sendback S-1 --why conflict          # composed from the conflict itself
node $ORCH sendback S-1 --why "joined tree red: docs.test.ts route set mismatch"
```

That writes the prompt and prints the `agent --resume` line. Do not open a new
agent for this. A fresh one has to reconstruct two agents' intent from the
outside, which is strictly harder than what either of them was doing.

A clean merge is not a working one. The suite on the *joined* tree is the check
that matters: on the real build a step passed its own suite 22 out of 22 and went
red once merged, on a route-set assertion — exactly the kind of breakage a clean
textual merge produces.

Then loop: record, guard, join, verify, land, `check`, open everything it names.
Keep going until the board is empty.

### Heavy checks go through one slot

Twelve agents each deciding to run the suite at the same moment is how a box goes
down. Anything heavy — a full test run, a build, an install — goes through the
shared slot, which lets exactly one through at a time and queues the rest:

```bash
node $ORCH slot run ci -- npm test
```

It passes the command's own exit code straight back, so it drops into a brief
where a plain command would go. `slot status` shows who holds it and what has
happened; a claim whose process is gone is evicted automatically, and freeing one
that is still alive needs `--force` because doing it under a live run causes the
exact crash the slot prevents.

### A step that must stop and ask

A run is one-shot; nothing can answer it mid-flight. A step that cannot proceed
ends its run with the question as its final answer. Put it to the user, then
resume the same chat with the reply:

```bash
agent -p --force --trust --resume "$CID" "the answer is X — carry on"
```

Same mechanism as a send-back.

## Taking a step back out

A round is editable. Cancelling is not deleting — `events.jsonl` is the record,
and a step that once existed is not the same fact as one that never did:

```bash
node $ORCH step rm S-2.1.1 S-2.1.2      # cancel, and drop them from what needed them
node $ORCH step reset 2.1               # every live step of one plan
```

Both refuse a step that has already gone out unless you say `--force`, because a
worktree and a branch outlive the record; when you do force one, they print the
`git worktree remove` line, which nothing here runs for you.

Reach for `reset` when a plan is re-refined after its steps turn out wrong. The
alternative — editing `state.json` and appending to `events.jsonl` by hand — is
writing directly to the record this owns, and it is how a register ends up
disagreeing with itself.

## Running on Claude Code instead

Any step can run as a Claude Code subagent instead of on Cursor. Spawn it with
the Agent tool, hand it `.claude/orch/briefs/<key>.md`, and record the result:

```bash
node $ORCH run record S-1 --json /tmp/S-1-record.json
```

The record is the same shape either way — `{outcome, seconds, files, commands,
answer}` — so everything downstream is unchanged. Cursor runs fill it from the
log automatically; a Claude Code step needs the JSON written for it.

## Watching a run

Streaming is on by default: a readable account goes to stdout while the untouched
jsonl lands in the log. Backgrounded, that account is what shows in the task pane,
so a round is visible instead of silent for minutes.

```bash
$WATCH S-1              # attach to one already going: replay, then follow
$WATCH --tail S-1       # only what happens next
$WATCH --window S-1     # in its own terminal window
```

It stops when the run stops. `--quiet-think` drops the thinking summaries;
`--full` stops clipping command output. The same formatter replays a saved log
with the timings it actually ran at.

## Gotchas

- **A run's liveness is its log, not `ps`.** The process does not show up under
  `agent`. A growing log is what alive looks like; the elapsed stamp on each
  streamed line says the same thing without asking.
- **`PATH` inside an agent is rebuilt from the login profile.** What the launcher
  exports does not order it, so bare `node` is whatever that profile defaults to.
  If the project pins a runtime, pass `--node-bin <dir>` and the launcher puts
  the instruction in the prompt, per command. Every other environment variable
  propagates untouched.
- **The fast tier is always refused.** It bills at roughly double for speed this
  work does not need. So is a model that comes back as anything other than the
  exact name its tier reports — rank 4 answers to `Cursor Grok 4.6` with no
  effort word in it, and that is a prefix of four other rows.
- **An override may not switch the check off.** `--model` works, but only with
  `--model-shown` naming what it should report. An unverified run is worse than a
  wrong one, because nothing tells you.
- **A run that dies is resumed once, automatically**, on the same chat, with the
  worktree's state in the prompt. If it dies again, or there is no chat to resume
  on, it fails and says what it stopped on. Pass `--no-retry` to turn that off.
- **Every run needs `run_in_background: true`.** These take minutes, well past
  the foreground `Bash` timeout, and backgrounding is what makes the round
  parallel.
- **A chat is never shared between steps.** `run open` mints one per step.
  Reusing an address is the same defect as stacking two steps into one agent, and
  it arrives quietly.
- **Expect ~5 KB of jsonl for a trivial run and 0.7–3.5 MB for real work.** A
  ten-plan act is roughly 15 MB, and nothing prunes `.claude/orch/logs/`.
- **Worktrees are named after the project**, beside it. A bare `wt-<key>` in the
  parent directory collides with every other project doing the same thing.
