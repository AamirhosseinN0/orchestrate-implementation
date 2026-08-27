---
name: orchestrate-implementation
description: Run an implementation end to end. First read the plans and settle every undecided thing with the user in plain language; then send an agent into the codebase to refine each plan into something buildable; then open every chip that can run without interfering — same file or same serialisation point means one waits — widening the set as work lands. It runs autonomously between handovers: checking returned work, merging what is right, recording CI checkpoints, and queueing all heavy checks through one shared machine slot so parallel agents cannot crash the box. Use when asked to orchestrate an implementation, work through a plan, grill a plan, settle open decisions before building, hand out tasks as chips, run work in parallel worktrees, coordinate agents, or drive a plan to done.
---

Two acts, in order, and the second must not start before the first has finished.

1. **The grill** — find every thing the plans leave undecided and settle it with
   the user. Nothing is filled in by judgement.
2. **Driving it out** — turn the settled plans into tasks, hand each out as a
   chip working in its own copy of the repository, hold back the ones that must
   wait, and check and merge each piece as it comes back.

**No room for guess**, in both acts. If it is undecided, it is a question. If a
task's requirements are not there, it waits — it does not start the part that
looks independent.

## The orchestrator does not build

**It never refines a plan and it never writes product code.** Not one line, not
one paragraph, however small the job looks. Refining goes to an agent in the
chat; building goes out as a chip. The orchestrator reads, asks, dispatches,
judges, verifies and merges — nothing else.

This is not tidiness. A context stuffed with half-written code and plan prose is
a context that has already made up its mind: it judges its own work kindly, it
stops seeing what it just wrote, and it loses the thread of who is waiting on
what. Judgement and verification are the whole job, and they are the first
things to go.

| Work | Who does it |
|---|---|
| Reading the plans, finding the gaps, asking the user | The orchestrator |
| Rewriting a plan so it can be built from | An agent, one per plan |
| Writing any product code at all | A chip, in its own copy of the repository |
| Running the checks, judging the result, merging | The orchestrator |

Running a test suite is verification, not building — that stays. Fixing what the
suite caught is building, and goes back to whoever wrote it.

## Nothing an agent is told lives only in your context

You will be compacted. It happens silently, and what it takes is detail — a file
dropped from a list, a condition dropped from a decision. An agent then builds
against something you no longer have, and neither of you can see the gap.

So **nothing is retyped from memory.** Every brief is written to a file and the
agent is given the path. Every refining agent writes its own report to a file
and you read that file. Your context carries the pointer, never the payload.

```
.claude/orchestration/
  register.json          every decision, gap and task
  events.jsonl           the record — one line per change, appended, never rewritten
  backups/               the last 30 states of the register, kept on every write
  refine/<plan>.json     what each refining agent found, in its own words
  preflight/<key>.json   what each pre-flight agent found, in its own words
  briefs/<key>.md        exactly what each chip was told
  messages.jsonl         every word that passed between you and an agent
  bin/with-ci-slot       the wrapper the heavy checks are run through
  slots/                 the shared machine slot, while somebody holds it
  archive/tasks-NN.json  finished detail moved off landed and cancelled tasks
```

Each of those is written by the tool, not by you. One is worth watching: on a
real 56-task run every folder above was on disk **except `refine/`, which did
not exist at all.** Nine plans were marked refined and not one agent report had
been read from a file. See the note on `refine done` below — that is what the
absence means.

**The record is `events.jsonl`, and the register is derived from it.** Every
change appends one line naming what actually changed and which command did it,
so the state is rebuildable from disk alone:

```bash
node $DRV verify     # replay the record, prove it still equals the register
node $DRV rebuild    # total recovery: rewrite the register from the record
node $DRV rebuild --to 460      # wind both back to that point in the record
node $DRV events --task 2.1     # what happened to this task, and what did it
```

`verify` exits 1 on drift and names the fields. Two causes need opposite fixes
and nothing can tell them apart for you: `rebuild` if the register was edited or
damaged, `log reseed --why "..."` if the record lost its tail. Run `verify` when
you come back to a run; the digest reports drift too.

`rebuild --to <seq>` cuts the record to that point as well, so the two stay in
step and `verify` is green straight after. What it cut is kept whole beside it as
`events.jsonl.before-rewind-<stamp>` — the events past that point exist only
there, so do not sweep that file until you are sure you meant the rewind.

The record refuses to be silently wrong. A crash mid-write leaves a torn last
line, which is dropped and reported, and trimmed before the next append. A bad
line *anywhere else* is corruption and `rebuild` refuses rather than replaying a
log with a hole in it. A missing `events.jsonl` is not treated as an empty one
either: `rebuild` will not empty a full register on the strength of a record
that is not there.

`events --task <key>` is worth trusting now. Every event records the subcommand
that made it — `chip 0.12.C`, `preflight done 0.12.C`, `owed assign o23` — so
the filter finds the ones that touched a task, and each line says which command
did it. It did not before: most events carried no command at all, and this line
promised something the record could not answer. `--grep`, `--since` and `--n`
narrow it the same way.

The backups are a second net — thirty states, a no-op write burning no slot.
They are the *only* net if the register is not in the project's history, and
nothing here puts it there or keeps it out. Decide which, once, at the start:

```bash
grep -q '^.claude/orchestration/' .gitignore || echo '.claude/orchestration/' >> .gitignore
```

Ignoring it is the usual choice — it is one run's working state, not the
project. Say so to the user rather than assuming it, because if it is ignored
and the backups are swept, the run is gone.

Every driver command locks the register first, and the lock asks the operating
system whether its holder is alive, so a slow command is never mistaken for a
dead one. `rebuild`, `verify` and `log reseed` take that lock too.

A long run makes the register large — most of it finished detail on tasks nobody
will read again. `archive` moves that out, and the record still holds it, so
`verify` stays clean:

```bash
node $DRV archive --dry-run    # what it would move, and how much
node $DRV archive
```

Two habits follow, and they are not optional:

- **Never retype data you have already extracted — pass the file.** Compaction
  loses detail by forgetting; retyping loses it by fabrication, and the second
  needs no compaction at all. Seven lists typed "from memory" minutes after
  extracting them: five wrong. Whenever a command prints a ready-made line —
  `preflight done` does, `resume` does — use it as printed.
- **A check whose inputs you produced is not a check.** Comparing a file you
  generated from the register against the register matches trivially, and three
  agents saying the data is wrong outrank your own green. Before trusting a
  check, ask what would have to be true for it to pass while being wrong; if the
  answer is "nothing changes", it is not a check.
- **Never summarise an agent's report into the record.** If a report is missing,
  ask the agent to write the file — do not reconstruct it from what it said in
  the chat. `refine done` will not stop you: with no file at the path it falls
  back to reading stdin, prints `⚠ took the report from stdin`, and records
  whatever you typed. That is the one place in this whole arrangement where the
  payload goes through your context, and it is not a rare escape — on the real
  56-task run it was every single refinement, all nine of them. Treat the
  warning as a defect in the run, not a note.
- **A failure is a record, not a remark.** A sendback, a guard trespass, a red
  run, a blocked message, a self-reported partial — each opens a defect with an
  id, the task, and the evidence, recorded automatically where it happens. It
  stays on `outstanding` until `defect fixed <id>`.

```bash
node $DRV defect list                       # what is open
node $DRV defect add --task 2.1 --kind bug --what "..." --evidence "..."
node $DRV defect fixed d01
```

  This matters because rejecting work used to make it *invisible*: only a reply
  clears an agent's pending question now, and a sendback no longer counts as one.

- **Log every message, both directions, as it happens.** One line each. It is
  what tells you, after a compaction or a dead session, that an agent asked
  something three hours ago and is still sitting there.

```bash
node $DRV heard 2.1 --kind question --text "the settings file is not in my list"
node $DRV say   2.1 --kind reply    --text "my error, brief rewritten, re-read it"
node $DRV outstanding    # who is waiting on you, and since when
```

- **And do not rely on having remembered.** Logging by hand only works if you
  remember, and a compaction is exactly the event that makes you forget. You do
  not have to: Claude Code writes every turn to a transcript on disk, inbound
  peer messages included, with sender and timestamp. `ingest` reads those and
  rebuilds the ledger — retroactively, including messages you can no longer see.

```bash
node $DRV ingest        # both directions, deduplicated, safe to re-run
node $DRV outstanding   # questions you never answered may have just surfaced
```

  Run it whenever you come back to a run, and after any gap. Three things to
  know. The transcript format belongs to Claude Code and changes between
  versions, so `ingest` **refuses loudly** rather than reporting a quiet zero if
  it can no longer read them — if that happens, fall back to `say`/`heard` and
  say so. Transcripts are kept about 30 days, so a very old run is not
  recoverable this way. And a recovered message carries **no kind** — the
  transcript never recorded one — so `outstanding` does not ask for one: it
  reports anyone who spoke last and has had nothing back. Both halves of that
  are read off the ledger rather than guessed at, so it cannot invent a question
  nobody asked.

  If a run was ingested by an older copy of this tool, its messages may still
  carry the wrapper Claude Code puts around them, and were cut short by it.
  `ingest --reclean` derives them again from the transcripts.

- **Put the run back in front of yourself after a compaction.** `digest` is the
  whole state in a few hundred words — who you are, what is open and at which
  address, who is waiting on you, what is owed, how far the main line has drifted
  from its last CI checkpoint. On a 51-task run it is about 1.3 KB against a
  1.1 MB register.

```bash
node $DRV digest
node $DRV hook-install   # run it automatically on every compact, resume and restart
```

  `hook-install` adds one `SessionStart` hook to the project's `.claude/settings.json`,
  preserving whatever is already there. After that the digest is injected for you
  at exactly the moment your context was truncated — which is the moment you need
  it and the moment you are least able to ask for it.

- **When you correct a record, the briefs are now wrong.** `board` tells you
  which; `brief --all` rewrites them and names what changed, so you know which
  agents to send back to their brief.

One driver does the bookkeeping, so nothing found in hour one is lost in hour six:

```bash
node ~/.claude/skills/orchestrate-implementation/driver.mjs
```

Set `DRV=~/.claude/skills/orchestrate-implementation/driver.mjs` and run every
command from the project root. State lives in
`.claude/orchestration/register.json`.

## What happens, and where it stops for the user

**First move: ask which plans.** If paths came with the invocation
(`/orchestrate-implementation docs/plans/2.1.md`), use those and do not ask
again. If a directory or glob came, expand it, show what matched, and confirm
that is the set. Only ask from scratch when nothing was given.

There are **five** places it stops and waits for a real answer. They are all in
the first half, and they all end at the same moment — when the chips are on
screen:

| # | It stops to | It has finished when |
|---|---|---|
| 1 | Confirm which plans | You name them, or agree to what matched |
| 2 | Ask the questions, a few at a time, as many rounds as it takes | Every undecided thing in the work has your answer |
| 3 | Show the small ones as one list | You say they are fine, or correct them |
| 4 | Ask again, if refining the plans against real code turned up something nobody had decided | Those are answered too |
| 5 | Show the frontier, then put up every chip that can open without interference | You have created them |

And then again each time the frontier widens — a landing frees its dependents
and everything its files were blocking, so new chips become possible as work
lands, not on a round schedule.

**While chips are open, it is not yours.** The orchestrator takes back finished
work, checks it, sends back what is wrong, merges what is right, and records CI
checkpoints as layers complete. It talks to the agents by message. You are not
the messenger and you are not the gate.

**When the frontier widens, it comes back to you** — with the newly-possible
tasks pre-flighted against the real code, their briefs doctored, and their chips
ready to create. That is the only handover.

It comes back to you only when it genuinely cannot proceed — a plan that
contradicts itself, work that keeps failing its own checks, something nobody
owns. It reports as it goes; it does not ask permission to continue.

---

# Act one — the grill

## 1. Ask which plans

Never guess the paths — unless they were given with the invocation, in which
case use them. Accept files, a directory, or a glob:

```bash
node $DRV load docs/plans/
```

Then **read every one in full**. The scanner below is a net for what you missed,
not a substitute for reading.

## 2. Find what is undecided

```bash
node $DRV scan       # sentences that dodge a decision
node $DRV silence    # whole questions the plan never raises at all
```

`scan` prints suspects with a line, a quote, and a density band per plan:

```
docs/plans/1.6-notes-and-cards.md     0 in   555 lines    0.0/100  settled
docs/plans/2.1-flashcards.md          9 in    23 lines   39.1/100  barely specified
```

Spend the session where the fog is. Then judge every suspect by reading its
paragraph — the scanner is deliberately over-eager:

```bash
node $DRV set g15 status=gap scope=in title="which method decides when a card comes back"
node $DRV set g17 status=dropped
```

`scope=in` means part of the work being built now — it gets its own question.
`scope=out` is real but not this build. `dropped` is a false alarm.

`silence` names categories the plan never mentions — failure, limits, who is
allowed, running twice, existing data, proof, undoing, growth. Add the ones you
confirm:

```bash
echo '[{"plan":"docs/plans/2.1-flashcards.md","title":"what happens to a card the student never answers","marker":"silence","scope":"in"}]' | node $DRV add
```

## 3. Research before asking

Never offer a choice between things nobody checked. For every in-scope gap:
**WebSearch** the contenders, **search GitHub** for real implementations
(licence, ports in each language this project needs, still maintained), and
**read this project's own code** for what is already built and what a choice
would reach back into.

```bash
echo '[{"name":"FSRS (open-spaced-repetition)","url":"https://github.com/open-spaced-repetition","note":"MIT; ports in Python, TypeScript, Rust; defaults work with no fitting"}]' | node $DRV research g15
```

## 4. Ask, in plain words

```bash
cat <<'J' | node $DRV question g15
{"text": "How should the app work out when a card comes back?",
 "options": [
   {"label": "A memory model, settings copied",
    "gain": "Each card carries how hard it is and how long the memory holds, so its day fits that student.",
    "cost": "Three numbers per card instead of one, and every date must record which settings made it.",
    "recommended": true},
   {"label": "The classic multiply-the-gap rule",
    "gain": "One number per card, about thirty lines to write, and thirty years of use behind it.",
    "cost": "A card you keep failing sinks to the smallest gap and stays stuck there for ever.",
    "recommended": false}]}
J
```

It refuses anything that breaks the rules: no file names or paths, no jargon, no
word over 13 letters, under 28 words, ends in a question mark; two to four
answers; exactly one recommended and it goes first; every answer carries both an
upside and a cost, each under 26 words; labels under 6 words. The vocabulary to
reach for instead is in [reference/plain-words.md](reference/plain-words.md).

**Then ask it with `AskUserQuestion`** — up to 4 per round, grouped by theme, the
ones that unlock other decisions first. `label` → the option's label with
` (Recommended)` on the first; `description` → `✓ <gain> ✕ <cost>`.

```bash
cat <<'J' | node $DRV answer g15
{"choice": "A memory model with published settings, copied and pinned",
 "note": "the chance of recalling a card now is worked out on demand and never stored",
 "rejected": [{"what": "Boxes on a shelf", "why": "cannot say how likely a student is to remember a card right now"}],
 "carries": ["The version of the settings is pinned in writing and recorded with every date produced."],
 "reaches_back": "the offline half runs the same arithmetic, so this lands in code already shipped"}
J
```

Small in-scope things get a suggested answer, `status=batched`, and go to the
user as one list via `node $DRV batch`.

## 5. Close the grill

```bash
node $DRV status     # item-by-item account of what is still open
node $DRV check      # exits 1 while anything is unjudged or unanswered
node $DRV render --title "the flashcard grill" --name flashcards
node $DRV render --plan docs/plans/2.1-flashcards.md
```

`check` asks whether the work was done, not whether a word says so. It exits 1
on an unjudged candidate, a gap with no scope, an in-scope gap unanswered — and
on two states that used to walk straight past it: a register nothing was ever
scanned against, and a gap marked answered with no answer recorded under it.
Neither of those is a formality; an empty gap list satisfied every other
condition, and `render` then died on the very register `check` had blessed.

Write the record — that one is yours, it is what the user decided and you are
the one who heard it.

**Do not edit the plans yourself.** `render --plan` prints the settled-decisions
table for a plan and `render` names the plans that gained one, but the rewriting
goes to the refining agent in the next act, along with the codebase. It is the
one that rewrites plans; you would be doing its job with worse information and a
dirtier context.

**Act one and a half does not begin until `check` passes.**

---

# Act one and a half — refinement

The grill settles *what*. It does not make a plan buildable: nothing yet says
which modules this work sits on, which files it touches, or what would prove it
works. That is this act, and it is where the plan stops being prose.

## 6. Refine each plan against the code that exists

One agent per plan, run in parallel — they only ever write to their own plan
file, so they cannot collide. Use the **Agent** tool with `model: "opus"`, and
pass the generated brief as the prompt:

```bash
node $DRV refine list              # which plans still need it
node $DRV refine brief docs/plans/2.1-flashcards.md
```

The brief hands the agent the settled decisions that bind this plan — each one
written out in the brief itself, with its conditions — tells it to read the
codebase and find what the work must build on, and tells it to rewrite the plan
so every decided thing is stated as decided. It does not mention the
settled-decisions table and it does not name `render --plan`; the agent works
from the decisions in its brief. If you want the table in the plan file as well,
that is the line `render` prints for you when it writes the record. It is
bounded hard: it may touch no file but that plan, it writes no product code, and —

**it may decide nothing.** If it finds something the plan needs that nobody has
settled — a number, a method, a rule that only became visible against the real
code — it reports it and does not choose. That is the whole arrangement.

**The agent writes its report to a file** — the brief names the exact path — and
you read that file. It never passes through your context, so it cannot lose a
line on the way:

```bash
node $DRV refine done docs/plans/2.1-flashcards.md
# read the agent's own report: .claude/orchestration/refine/docs-plans-2.1-flashcards.json
```

If the file is not there **and nothing is piped in**, `refine done` stops:

```
error: no report at .claude/orchestration/refine/docs-plans-2.1-flashcards.json
       and nothing on stdin.
       The agent was told to write its report to that path. Ask it to,
       rather than retyping what it told you — that is how files get dropped.
```

**But pipe JSON in and it takes it.** It prints a warning and records it:

```
⚠ took the report from stdin, not from the agent's own file.
  It passed through your context to get here, so check nothing was lost.
```

That hatch is open on purpose and it is the sharp edge of this act. A report
that arrives that way came through your context, which is the one thing that
gets compacted, so what is now on record is what you could still remember — not
what the agent found. Do not use it. If the file is missing, the agent has not
finished; ask it to write the file to the path in its brief.

The shape it must write — `serialises` included, because `graph`, `chip` and
pre-flight all read it and a task with an empty one is a task claiming it moves
no migration chain, no lockfile and no closed list:

```bash
# .claude/orchestration/refine/docs-plans-2.1-flashcards.json
{"summary":"wrote the settled scheduler into the plan and named the queue it uses",
 "builtOn":[{"path":"packages/offline/src/outbox.ts","what":"the queue a phone already uses"}],
 "tasks":[{"key":"2.1","title":"the flashcard scheduler","needs":["0.14"],
           "owns":["apps/api/src/core/cards"],"serialises":["alembic-head"],
           "verify":["pnpm -C apps/api test"]}],
 "newGaps":[{"title":"how long a phone keeps changes it could not send","why":"nothing says what happens after a week offline"}]}
```

The tasks it proposes become the task records Act two hands out — `owns`,
`needs` and `verify` come from here, worked out against real code rather than
guessed at a desk.

## 7. If refinement reopened anything, go back and ask

A `newGap` is not a footnote. It lands in the register as an unanswered gap and
**the grill reopens**:

```
⚠ 1 NEW undecided thing(s) found against the real code.
These are gaps, not decisions. The grill reopens — ask the user before any chip exists:
```

Gather the new gaps from every refinement, research them, and put them to the
user the same way as act one — plain question, real costs, recommended first.
Then answer them and re-run the gate:

```bash
node $DRV refine check
```

It exits 1 while any plan is unrefined, any reopened gap is unanswered, or no
tasks were produced. **Nothing is handed out until it passes.**

---

# Act two — driving it out

## 8. Say who you are

Chips must know where to report. `ListAgents` never lists you, so your own name
is the one in the registry that it does not show:

```bash
node $DRV whoami                    # lists the sessions in this directory
node $DRV iam proj-a1             # record it — every brief will carry it
```

## 9. Check over the tasks refinement produced

**Refinement already wrote these** — `refine done` recorded each plan's proposed
tasks, with `owns`, `needs` and `verify` worked out against real code. Your job
here is to read them, not to invent them:

```bash
node $DRV list --status gap >/dev/null; node $DRV board
```

Fix or fill anything thin with the same command that created them — `task add`
updates a task that already exists, so you can correct one field without
rewriting the record:

```bash
cat <<'J' | node $DRV task add
[{"key":"0.14","title":"the sweeper and the shelf of tuned numbers","plan":"docs/plans/0.14-the-sweeper.md",
  "needs":[],"owns":["packages/tuning","apps/api/src/core/sweeper"],"serialises":[],
  "context":[{"path":"apps/api/src/core/worker","what":"the background queue a sweep runs on — use it, do not write another"}],
  "decisions":["One shelf of tuned numbers, versioned, shipped in both builds"],
  "verify":["pnpm -C apps/api test"]},
 {"key":"2.1","title":"the flashcard scheduler","plan":"docs/plans/2.1-flashcards.md",
  "needs":["0.14"],"owns":["apps/api/src/core/cards","packages/offline/src/cards"],
  "serialises":["alembic-head"],
  "context":[{"path":"packages/tuning","what":"the shelf 0.14 built — put your constants there"}],
  "verify":["pnpm -C apps/api test","pnpm -C packages/offline test"]}]
J
```

The fields it reads are `title`, `plan`, `needs`, `owns`, `serialises`,
`context`, `verify`, `decisions`, `notes` and `branch`. Anything else is named
back to you as ignored rather than saved.

**A new task may not claim a path a live task already owns.** `task add` refuses
the whole batch and saves nothing, naming which task holds it. That is the one
failure this arrangement exists to prevent, and this is the cheapest moment to
fix it. An existing pair is not re-judged — a register that already has one has
to stay usable — so `doctor` is what reports those.

**Ownership is not optional, and a shared file is only the easy case.** Two
tasks running at the same time may never touch one file — `owns` is how that is
enforced. But almost every collision that reaches CI is two tasks touching
*different* files that share one invariant: a migration chain with one head, a
lockfile, a closed list some test asserts exact equality over, a dict entry and
an import that must land together. `serialises` names those points, and `graph`
refuses a round where two tasks move the same one, exactly as it refuses a
shared file. Get both from the plans and from pre-flight — a step that says what
it owns has already told you the files; only reading the tests tells you the
invariants.

## 10. Show the work in the chat, and let it refuse

```bash
node $DRV graph
```

This prints the rounds — what runs side by side and what waits — and **exits 1**
rather than let a broken plan out of the door. It stops three things:

- two tasks in one round that would change the same file;
- a task told to build on something another task is rewriting **in the same
  round** — it would be reading somebody mid-edit;
- a task told to build on something it is not allowed to change (a note, not a
  failure — read-only is usually right).

Paste the output into the chat. That is the shared picture of what can be
launched in parallel and what each thing is waiting for. Fix the plan until it
is green. **Do not create a single chip while `graph` exits 1.**

**Read what its green actually says.** It ends by naming how many pairs of tasks
it judged, and how many it skipped because one side had already landed:

```
✓ 8 pair(s) of tasks that could still collide were checked for shared files
and shared serialisation points; 74 pair(s) were skipped because one side has
already landed.
Nothing among them clashes, so every round above can run side by side.
That is not a statement about the run as a whole — a landed task is not re-judged.
```

Skipped pairs that did overlap are listed above that as history, under "Already
merged, so not a gate". Both halves matter: late in a run the judged number gets
small and the skipped number gets large, and a green over eight pairs is not the
same claim as a green over eighty-two. Merged work is not a contender, which is
why it is skipped — but it means the same register says "nothing clashes" today
and would have said "these two collide" yesterday.

## 11. Pre-flight the round before opening it

Refinement wrote each task's `owns` by reading. Nobody has tested it against the
code — and an untested owns list fails in one direction only: too narrow, one
stop-and-ask round-trip per missing file, each one your record's fault.

So before a task's chip opens, one **read-only** agent goes in with a single
job: find what the record missed. `frontier` names the tasks about to open;
those are the ones to pre-flight.

```bash
node $DRV preflight brief 2.1      # the prompt; the agent writes its report to a file
node $DRV preflight done 2.1       # read the report; it may reshape the record
node $DRV preflight check          # exits 1 while the round is not clean
```

The agent reports three things, each with file:line evidence: files the work
needs that `owns` omits (marked load-bearing or not), serialisation points the
work moves, and whether each verify command can actually run here. It fixes
nothing — a pre-flight agent that decides something has broken the arrangement
exactly as a refining agent would.

`preflight done` prints the ready-made `task add` line for any load-bearing gap
— **use it as printed, do not retype the paths** — and then `graph` again,
because a widened owns can create a collision that was not there before.
`preflight check` gates the round the way `graph` does: nothing opens while a
task is unflown or a load-bearing gap sits outside its owns.

Two things that line assumes, which cost a real collision before they were enforced:

- **The line is an *update*, and an update widens ownership.** `task add` checks a
  widened `owns` against every other open task and refuses the batch, exactly as it does
  for a new one. It judges only the paths the update *adds*, so narrowing is always free
  and a register that already holds a collision stays usable. To hand a file from one
  task to another, narrow one and widen the other **in the same batch** — that is read as
  a hand-over and allowed; done as two commands the first one is refused.
- **`graph` alone will not catch it.** Different rounds may legitimately share a file, so
  a widened `owns` that collides across rounds is green in `graph` and red only in
  `doctor`. Run `doctor` after a pre-flight widens anything, not just `graph`.

And what the agent writes matters: `path` in a pre-flight report must be a **bare
repository-relative path**, because it goes straight into `owns`. The generated brief now
says so, and `preflight done` refuses a report whose paths are prose rather than merging
it. Prose in `owns` is not a harmless typo — it matches itself, so `preflight check` goes
green on it and it stops being visible.

## 12. Open every chip that cannot interfere

The unit of dispatch is not the round — it is **interference**. A task may open
the moment two things are true: everything it builds on has **landed**, and
nothing it owns — file or serialisation point — is in the hands of a task that
is currently open. Round membership is irrelevant: a task three layers deep
opens the instant its actual dependencies land, and a task in the "current"
round waits if its files are in flight.

```bash
node $DRV bundle suggest     # first: is this too many chips?
node $DRV frontier
```

**One chip per step is usually the wrong grain.** A chip pays a large fixed cost
before it writes a line — its own brief, and the whole plan behind it. Six
sibling steps from one plan each pay it for the same plan. Measured on a real
54-task run: ~33k tokens of reading per chip, and a full megabyte across the run
was siblings re-reading text a sibling had already read.

`bundle suggest` finds steps that should travel together — same plan, no
interference with open work, and closed under their own dependencies. A
dependency *between* two of them is not an obstacle: inside one agent it is
simply the order to do them in, and it removes a merge, a CI run and a handover.

```bash
node $DRV bundle 0.12.C 0.12.D 0.12.G --into 0.12.C
```

The absorbed tasks are marked cancelled and recorded as absorbed — never
deleted — and the combined brief opens by listing every step it now covers, in
order. Bundle what genuinely belongs together; two steps sharing only a plan are
still two jobs, and an incoherent brief costs more than the reading it saves.

prints exactly that: what can open right now (most-unblocking first), what is
buildable but held back and by whom, on which file or point, and what is still
waiting for work to land. Run it after every landing — a landing frees both its
dependents *and* every task its files were blocking.

Record each chip as you create it. **`--id` is required the first time**, and it
is the whole gate:

```bash
node $DRV chip 2.1 --id task_def456
node $DRV chip 2.1 --id task_def456 --worktree ../wt-2.1 --branch step/2.1
```

`--id` is the id the tool that created the chip gave back — it is how the record
points from a key to the thing actually doing the work. Without it the command
refuses and nothing is written:

```
error: chip 2.1 --id <task_id> — the chip id is how the record points at the running
       agent. Take it from the tool that created the chip. Add --worktree <path> too if
       the copy it works in is not the branch's own worktree.
```

That refusal is not paperwork. Every interference check below runs **only on a
task's first chip** — the run where `--id` is being set. Call `chip` without it
and the command stops before the checks; call it a second time on a task that
already has an id and the checks are skipped, because the chip already exists.
So the one call that decides whether this work may open is the one that carries
`--id`, and there is exactly one of them per task.

`--worktree` is where its copy of the repository actually sits — pass it when
that is not the branch's own worktree, or `guard` will not find it later.
`--branch` sets the branch the work lands on; it is honoured, so a name you pass
here is the name `guard` and `release` will look for.

On that first chip, `chip` enforces the same two rules `frontier` does and
refuses otherwise:

```
✗ D would interfere with work that is open right now:
    B  ↔  src/shared.py
  Two of them changing one thing is the one failure this arrangement cannot
  survive. It opens the moment B lands — `frontier` will say.
```

The needs-landed half is not bureaucracy: a chip copies the repository when it
is opened, so opening it before its requirements land hands its agent a copy
that is stale by exactly what it waited for. Nothing is created "on hold" —
a chip either can start now, or it does not exist yet.

`brief` **writes the brief to a file** and prints the short message to give the
chip — a path, the check-in line. That short message is the chip's `prompt`;
the brief itself is read from disk, from the main checkout, by absolute path.

`brief --all` rewrites every live brief at once and names which changed — run it
after any correction to the record.

**Then `doctor`, before any chip exists.** A brief is handed to somebody who
will believe it, so everything it cites that can be checked mechanically, is:

```bash
node $DRV doctor
```

Every cited path must exist, every verify command's binary must resolve, no
brief may be stale. It exits 1 otherwise. And never put a number in a brief that
the run itself can change — a test count, a baseline. Write where to look it up
instead.

**Every brief opens by telling the agent to check in** — one message, sent
before it reads anything. That message is the only way you learn where to reach
it. Record each one as it arrives:

```bash
node $DRV agent 2.1 --name proj-b2      # the name the check-in came from
```

Keep the board in view; it shows who has checked in and who has not:

```bash
node $DRV board
```

## 13. Releasing a held chip — which should never happen

`chip` refuses to open a task whose requirements have not landed, so **every
chip you create is ready to start, and none is ever on hold.**

If one is on hold anyway, something is wrong rather than merely slow — usually a
dependency that finished but was never recorded with `landed`. `chip` says so
when it happens.

Fix the split; do not release your way around it. The machinery below stays for
that case and for a run that predates this rule, and it refuses while any
requirement has not landed:

```bash
node $DRV release 2.1
```

It refuses while any requirement has not landed. When it does release, it prints
the message to send — via `SendMessage` to the chip's session name — including a
check the chip must run before writing a line:

```bash
git merge-base --is-ancestor 9f3c1ae HEAD && echo "0.14 is in" || echo "0.14 is MISSING"
```

That check matters because **a chip makes its own copy of the repository the
moment it is opened**, which for a held chip is long before its requirements
landed. A stale copy is the most expensive way this goes wrong.

## 14. Take the work back

A chip reports two ways — a message so you hear it now, and a written line so it
survives the window being closed:

```bash
node $DRV done 2.1 <<'J'
{"commit":"9f3c1ae","verified":"apps/api 214 passed","outcome":"passed","notes":"the shelf ships empty"}
J
```

`verified` is required — a report with no proof in it is refused. `outcome` is
`passed`, `partial` or `failed`, and defaults to `passed` if it is left out;
either of the other two opens a defect against the task on the spot, so the
half-passing run cannot be rounded up. `commit` and `notes` are optional.

`done` is refused on a task that has landed and on one that was never handed
out. Both used to go through: a report on landed work rewound it, and a report
on a task with no chip behind it was taken as if there were work under it.

Then **you check it again. Its own word is not enough.**

```bash
node $DRV guard 2.1
node $DRV guard 2.1 --base trunk    # only if the base is not the repo's own default
```

`guard` asks the repository what its integration branch is called rather than
assuming `main`, so it works in a repo whose default is `trunk`, `master` or
anything else. Pass `--base` when you want a different one. It compares without
rename detection, so a file *moved out* of a path the task does not own still
shows up as the deletion it is.

It diffs the branch itself and marks every file — you are not comparing lists by
eye, which is where attention goes at task forty of fifty:

```
2.1 changed 2 file(s) on step/2.1:
  ✓ src/cards/a.py
  ✗ src/other/b.py

✗ 1 file(s) outside what it was allowed to touch:
    src/other/b.py
  Send it back. Do not fix it here — you would be writing code, and you would be
  writing it in the one place that has to stay able to judge it.
```

It exits 1 on a trespass, and also on a branch that changed nothing at all —
which is not finished work either.

**Not every check needs the machine.** A linter reading files can run beside
anything; a suite that takes a database or a build that eats the disk cannot. The
brief now splits its checks in two — the cheap ones run immediately, only the
heavy ones queue — and narrows a whole-tree check to the paths the task actually
owns, which is the same idea as a path filter on a CI job. On the run that
prompted this, 38 of 131 queued checks were the same whole-repo lint, waiting
behind database suites for no reason.

Installing packages counts as heavy, whatever it looks like. `pnpm install`,
`pip install`, `poetry lock` and their kin saturate the network, rewrite a shared
store and churn gigabytes of disk. They used to read as cheap, and every agent
was told to run one bare and at the same time.

**The machine is still a serialisation point for the heavy half.** With six or seven chips open, six
or seven full suites can start at once — and that is a memory panic, not a
speed-up. So the run's heavy checks share one slot: a claim taken atomically
(two agents seeing "free" at the same instant cannot both win), freed by the
holder's process exiting rather than by anyone remembering, polled every ~10
seconds by whoever is waiting.

**A holder that is alive is never taken from.** The waiter asks the operating
system whether the holder's process is still there, and if it is, it keeps
waiting however long the run takes — a suite that legitimately runs past any
limit is still running, and starting a second one beside it is the crash this
whole thing exists to stop. The 30-minute limit applies only where liveness
cannot be established: a claim from another machine, or one taken by hand, which
records no process to ask about.

Every brief wires this in: a wrapper script is generated into
`.claude/orchestration/bin/with-ci-slot`, and **the heavy half** of that brief's
checks is printed through it. The cheap half is printed bare, to run straight
away — that is the point of the split, and a linter behind a database suite is
the waste it was there to remove. Your own round-closing CI run and any
full-suite check you run while judging returned work go through the same
wrapper:

```bash
.claude/orchestration/bin/with-ci-slot pnpm -C apps/api test
node $DRV slot status          # who holds it, since when
```

Never free a slot with a run inside it: `slot free` refuses a live `slot run`
claim without `--force`, because emptying it under a live run causes the exact
crash the slot exists to stop. A claim taken by hand with `slot take` is
different — the process that took it exited on purpose, so nothing is inside it
and `slot free ci` frees it plainly, no flag.

One sharp edge is left, and it is worth knowing rather than being surprised by.
Taking a stale claim away is two steps — judge it stale, then carry it off by
renaming the whole claim aside. A claim created in the sub-millisecond gap
between those two is carried off with it. It is recognised and put straight back,
but putting it back is itself two calls, so for that instant the slot is not
held by the run that owns it. Nothing here can close that gap; what it means in
practice is that a "slot freed itself" you cannot account for is possible, and
worth a `slot status` rather than a shrug.

Log the send-back:

```bash
node $DRV say 2.1 --kind sendback --text "src/other/b.py is not yours — back out that change"
```

Then join it up and run **everything**, in a staging copy, so the main line is
never broken:

```bash
git worktree add .claude/worktrees/joined -b joined main     # once, at the start
git -C .claude/worktrees/joined merge --no-ff -m "join 2.1" step/2.1
# run the whole suite here, not just this task's checks
git merge --ff-only joined                                   # only when green
node $DRV landed 2.1 --sha $(git rev-parse --short main)
```

`landed` names which held tasks that frees. Release them and go round again.

If the joined run fails, or the merge conflicts, it goes **back to whoever wrote
it** — they know what the code meant. Recover with
`git -C .claude/worktrees/joined merge --abort`; the main line is untouched.

## 15. Run it to the end without being driven

Once the chips exist the user is out of it. The loop is yours, and it is only
ever these four moves:

1. **A check-in arrives** → record the address with `agent`, log it with
   `heard`. If it is held, reply that it waits and name what it waits for.
2. **A report arrives** → `heard` it, then `guard`, join, run everything, `landed`.
   If it is wrong, send it back to that agent with what failed and `say` what you
   sent — never fix it yourself.
3. **Something lands** → `landed` names who that frees. Release each of them,
   send the message, and `say` that you sent it.
4. **Nothing is happening** → `outstanding` first, then `board`. The first says
   who is waiting on *you*; the second says where the work is.

Log both directions every time. It costs one line and it is the only thing that
survives you being compacted mid-round — task states tell you where the work is,
never what you promised somebody.

Two situations the loop must survive without you inventing policy on the spot:

- **An agent dies holding finished work.** Verify it and land it yourself — that
  is checking, not building, and it is exactly the same `guard`/join/CI path as
  a living agent's report. An agent that dies holding *unfinished* work is
  different: re-chip the task with a fresh brief that says what exists in the
  dead agent's worktree, and let the new agent decide what survives. Never
  finish another's half-built work in your own hands.
- **An agent's address changes.** Session names churn — an agent restarting gets
  a new one, and it may notice before you do. When a message arrives from a new
  name claiming a known task, re-record it (`agent <key> --name <new>`) and
  carry on; `resume` is for *your* death, not theirs.

Reports and check-ins arrive as messages and wake you, so the usual case needs
no polling. But an agent that dies, stalls, or forgets to report will never wake
you — so when you are waiting on work and the board is not moving, check it
yourself rather than sitting idle. If the user started you under `/loop`, use
the wake-up to do exactly that: run `board`, act on anything sitting, and go
back to sleep.

**Do not ask permission to continue.** Report what you did and carry on. Come
back to the user only for something you cannot decide: a plan that contradicts
itself, a task that keeps failing its own checks, work that needs a file nobody
owns. Those are the same holds Act one made — a question, not a guess.

You are finished when every task is `landed` and `board` says so.

## 16. CI checkpoints — prove the main line as it moves

The frontier means the main line moves continuously instead of in round-sized
steps, so CI becomes a **checkpoint** rather than a gate: record one whenever a
dependency layer has fully landed, and at every natural pause. `frontier` keeps
the drift visible and gets loud past five unproven landings:

```
⚠ 6 landing(s) since the last CI checkpoint. That is a lot of unproven main line
```

Why the checkpoint is not ceremony: **CI is the only check in this whole
arrangement that varies the environment.** A different machine, a different
checkout path, a clean database, a cold cache. Local green, staging green, and
every agent's own suite all share one environment, and a bug that depends on it
— a path parsed from where the repo happens to sit, a test passing on a garbage
value it never actually checks — is structurally invisible to all of them at
once.

```bash
node $DRV wave                                   # the dependency layer in flight
node $DRV ci --status green --ref gh-run-4471
node $DRV ci --status red --why "two migration heads on the joined tree"
node $DRV ci --status skipped --why "the runner is down until Monday"
node $DRV ci list                                # every checkpoint, oldest first
```

`red` and `skipped` both need `--why` and hard-fail without it. What broke is
the whole point of recording a red, and a missing run is a decision rather than
an omission.

`ci` records against a fully-landed layer (it refuses to certify one still in
flight), a landing invalidates any CI result that predates it, and `red` means
what it always meant: send the break back to whoever owns those files before
anything else opens on top of it.

A checkpoint also must not close over work that only a window makes possible.
When an agent offers something outside its scope, record it the moment it is
offered, because free-text notes die with contexts:

```bash
node $DRV owed add --what "backfill the two rows 1.10a offered" \
  --why "0.14c's tree lacks the table" --window "before 1.10c merges" --load-bearing
node $DRV owed assign o01 --to 1.10c    # and put it in that task's brief
```

`ci` lists every open owed item as it records — assign each to a task that can
still do it, or mark it done. A window that closes on an unassigned item closes
for good.

An assignment is not the end of it, because the task it names will finish. When
that happens the item is still owed and has nobody left to do it, so `landed`
says so on the spot, `owed list` marks it **SHUT**, `doctor` fails on it and it
stays on `outstanding` until you reassign it to work that is still open or
settle it. Landing does not settle it for you — that would make the loss
automatic, which is the thing this list exists to prevent. Absorbing a task into
a bundle moves its owed items and open defects to the host for the same reason.

## 17. If the session running this ends, take it over

Sessions die. When one does, fifty agents are messaging an address nobody reads,
and none of them will work that out on their own.

```bash
node $DRV whoami                  # your new name
node $DRV resume --name proj-z9
node $DRV brief --all             # every brief names the old address
node $DRV outstanding             # what was left mid-air
```

`resume` prints the re-announcement to send to every agent still working, and
lists them. Send it to each — they cannot discover this themselves. Then work
`outstanding` down: a question asked of a session that no longer exists has no
answer coming, and the agent is still waiting.

---

## Gotchas

- **A chip makes its own copy when it is opened, not when it is released.** A
  held chip opened on day one and released on day three is three days stale.
  This is why every release message carries a base check.
- **The slot frees itself; hands off.** The wrapper ties freeing to the process
  exiting, so a crashed suite still releases it. The failure mode left is a
  human or an agent "helpfully" emptying a live claim — which starts the second
  suite mid-first-suite and causes the crash everyone was queueing to avoid.
  `slot free` refusing without `--force` is load-bearing, and it is that narrow
  case it is load-bearing for: a `slot run` claim with a command inside it. A
  claim taken by hand is freed plainly, because there is no run under it to
  crash — reaching for `--force` out of habit is how you learn to reach for it
  when it matters.
- **An agent waiting on the slot looks exactly like an agent working.** The
  wrapper says so on stderr and `slot status` names the holder and the wait —
  check it before diagnosing a "stuck" chip.
- **A round that has landed is not a round that is finished.** Every merge passed
  its own staging run, and the last merge changed a main line that none of the
  earlier ones were tested against. CI on the finished round is the only thing
  that has seen all of it at once.
- **Interference includes what an open task might still do.** A task counts as
  in-flight until it *lands* — not until it reports. Reported-but-unmerged work
  still collides, because its files are not yet where a new copy would get them.
- **The gate is at chip creation, not at release.** Once a chip exists somebody
  can click it, and then work is happening on a floor you have not proved. That
  is why the refusal is there and not one step later.
- **A derived ledger beats a remembered one.** `say`/`heard` are still worth
  running as things happen — they carry your own wording and a kind — but they
  are no longer the only record. `ingest` can rebuild both directions from disk,
  so a round where you forgot to log is recoverable rather than lost.
- **Task states say where the work is; they never say what you promised.** That
  the board shows `2.1 ready` tells you nothing about the question its agent
  asked you an hour ago. Only the ledger does, and only if you wrote to it.
- **An agent asks once.** It is following a brief that told it to stop and ask
  rather than guess, so it stops and waits — indefinitely, quietly, looking
  exactly like an agent that is working. `outstanding` is how you find it.
- **A chip reads the plan from the main checkout, not from its own copy.** Its
  copy was taken before refinement rewrote the plan, so the version sitting in
  its worktree is the old one. The brief gives an absolute path for exactly this
  reason. Commit refined plans anyway — a plan and the code built from it belong
  in one history.
- **Compaction takes detail, not headlines.** You will not notice it. What goes
  is a file dropped from a list or a condition dropped from a decision — and the
  agent then builds against something you no longer hold. This is not
  hypothetical: it has happened, twice in one round, and both times it was the
  agent's ask-don't-guess rule that caught it rather than anything on this side.
  Keep the payload in files and carry only pointers.
- **A corrected record does not correct a brief already handed out.** The agent
  is still holding the old one. `board` flags it; `brief --all` rewrites it; and
  you still have to tell that agent to re-read it, because it will not know.
- **An agent that had to ask you for a missing file has found a bug in your
  record, not in itself.** Fix the record and rewrite the brief — do not just
  answer the question in the chat, or the next agent to read that brief hits the
  same hole.
- **The rule breaks on small jobs, never big ones.** Nobody is tempted to build a
  subsystem in the orchestrator. They are tempted by the one-line fix, the typo
  in a plan, the import that is obviously missing. Each one is cheap and each
  one costs the same thing: a context that has started producing instead of
  judging. Send it back — it is one message and the author already has the file
  open.
- **"The chip is stuck, I'll just finish it" is the worst case**, because it
  looks like rescuing the schedule. A stuck chip is a question — what is it
  missing? — and answering that is your job. Finishing its work is not, and the
  next thing you do is verify the code you just wrote.
- **`board` will tell you when you have slipped.** It flags any change in the
  main checkout that sits on a file some task owns. Nothing legitimate of yours
  ever lands there — the decisions record is yours, the code never is.
- **A refining agent that decides something has broken the arrangement.** It is
  there to make the plan buildable, not to fill its holes. A `newGap` coming
  back is the step working, not failing — it means the code showed you something
  the plans could not.
- **Refinement writes `owns`; pre-flight is what makes it honest.** Worked out at
  a desk it is a guess, and an untested guess fails narrow — ten stop-and-ask
  round-trips across one build, every one predictable. The whole parallel
  arrangement rests on `owns` being true, so it gets tested before anyone
  builds on it.
- **The collisions that reach CI share an invariant, not a file.** Three
  migration files, three heads, zero overlap, red. A dict entry in one file and
  its import in another, asserted together by a test neither task owns. A
  lockfile any new package rewrites. `graph` green on files proves nothing about
  these — that is what `serialises` is for, and pre-flight is where the unknown
  ones surface.
- **A chip's copy of the repository gets a random name**, so you cannot work out
  its address in advance. The check-in message is the only reliable way to get
  it — which is why every brief demands one before the agent does anything else,
  hold or no hold.
- **`ListAgents` never shows you.** That is how you find your own name — it is
  the one in `~/.claude/sessions/*.json` for this directory that the listing
  does not have. A worktree session's name carries a two-character suffix; read
  it, do not assume it is the worktree name.
- **A merge conflict means the ownership rule was already broken.** Two tasks
  from the same base changed one file. Do not resolve it — the split was wrong.
  `git merge --abort` and send it back.
- **Different rounds may share a file; the same round may not.** A later task
  branches from a main that already has the earlier one, so it is a sequential
  edit, not a clash. The check only fires within a round, and that is correct.
- **A task's requirements may be sitting uncommitted in another copy.** `git log`
  on the main line shows nothing. Check `git -C <worktree> status --porcelain`
  before believing a precondition is met — and never read a *decision* off a
  working tree, because a change appearing there is somebody mid-edit.
- **The scanner over-fires on purpose.** Three hits on one line are one gap. In a
  real run 24 suspects came to 5 real decisions.
- **`silence` finds the expensive ones.** A scanner cannot see an absence. Run
  both passes, always.
- **"May" means "is permitted to"** in spec prose far more often than "might" —
  the scanner no longer flags it and neither should you.
- **Do not put the plan's own words in a question.** The quote is evidence for
  you; the user gets the decision in their language.

## Troubleshooting

- **`error: no register at ...`**: wrong directory. Run from the project root or
  pass `--register <path>`. A chip reporting in from its own copy needs the
  absolute path — its brief already has it.
- **`preflight check` says "never pre-flighted"**: the round is about to open on
  an owns list nobody tested. One read-only agent per task; their reports are
  files, like everything else.
- **`doctor` says "verify command's binary is not on PATH"**: the brief promises
  a proof this machine cannot run. Fix the verify entry or the environment —
  never hand it out as-is, because the agent will report the command "failing"
  and somebody will debug a phantom.
- **`task add` says "ignored: status, chip"**: working as intended — live state
  is not writable from a bulk edit. `set`, `chip`, `done` and `landed` own those.
- **`chip` says "would interfere with work that is open right now"**: working as
  intended — `frontier` says when it opens. Do not shrink the task's owns to
  dodge the refusal; the overlap is real.
- **`slot run` says "still held after 90 min"**: the holder's process is alive,
  so the slot is never taken from it — that is deliberate, not a bug, and it is
  what stops a second suite starting beside a slow one. `slot status` names the
  holder; talk to that agent, and only once you know its run is gone,
  `slot free ci --force`.
- **`chip` says "--id <task_id>"**: it is the first chip for that task and the
  id is required. Every interference check runs on that call, so passing it is
  what arms them — `chip <key>` alone is not a smaller version of the same
  command, it is nothing happening.
- **`task add` says "claims <path>, which is already owned"**: nothing was
  saved, including the other items in the batch. Two live tasks may not own one
  path. Narrow one, or make one wait and split the file — do not widen the other.
- **`done` says "it has never been handed out"**: the task has no chip, so there
  is no work behind the report. Create the chip first, with `--id`.
- **`error: unknown flag --xyz`**: a misspelled flag is refused now rather than
  ignored, which is what let a whole command run on quietly without it. If the
  value itself starts with `--`, write it as `--text="--like this"`.
- **`ci --status green` says "has not all landed yet"**: the run you are pointing
  at predates a merge still to come, so it does not cover the round. Land the
  rest, then run CI again.
- **`guard` says "changed nothing at all against main"**: the agent reported
  finished but its branch is empty. Either it committed to the wrong branch or it
  never committed. Ask which — do not go looking in its worktree yourself.
- **`guard` says "cannot find a copy of the repository on branch X"**: the
  worktree was never recorded. `chip <key> --worktree <path>` fixes it.
- **`refine done` says "no report at … and nothing on stdin"**: the agent has not
  written its file yet, or wrote it elsewhere. Ask it to write it to the path in
  its brief. Do not paste the JSON in from the chat — it will take it, and print
  `⚠ took the report from stdin`. That warning is the report having come through
  the one thing that gets compacted.
- **`board` warns "the record changed after these briefs were written"**: run
  `brief --all`, then message each named agent to re-read its brief.
- **`refine check` says "no tasks proposed"**: the refining agents returned
  summaries but no `tasks` array. Without it there is nothing to hand out — send
  them back with the shape spelled out.
- **`graph` exits 1 with "would both change the same files"**: split the work, or
  make one wait for the other. Do not proceed.
- **`✗ cannot release X — still waiting for Y (not landed)`**: Y reported but was
  never checked and merged. `board` shows what is sitting on your check.
- **`error: X is "ready" — it cannot land before it reports finished`**: nothing
  lands on its own word alone; the report comes first, then your check.
- **`CONFLICT (content): Merge conflict in <file>`** while joining: see the
  gotcha above — abort, send back, fix the split.
- **`task "X" declares no files it owns`**: ownership is the rule that makes
  parallel work safe, so it is refused rather than defaulted.
- **The working directory resets between commands** in some harnesses. Put
  `cd <project-root> &&` in front of each call.
