# orchestrate-implementation

A [Claude Code](https://claude.com/claude-code) skill that takes an
implementation plan from *undecided* to *built*.

A plan that says **"use a well-known, already-tested method"** has not decided
anything. It has moved the decision to whoever builds it — and the next person
will decide it differently. This skill finds every sentence like that, goes and
finds out what the real choices are, and puts each one to you as a plain
question with the true cost of each answer attached. Then it hands the settled
work out to parallel agents and drives it to done.

**No room for guess.** If it is undecided, it becomes a question. If a task's
requirements are not there, it waits — it does not start the part that looks
independent.

---

## Prerequisites

- **Claude Code** — the skill runs inside it.
- **Node 18+** and **git**. The driver has no dependencies.
- On Windows, use **WSL** or **Git Bash**: the paths and `~` expansion in this
  README are POSIX-style.

## Install

```bash
git clone https://github.com/AamirhosseinN0/orchestrate-implementation.git \
  ~/.claude/skills/orchestrate-implementation
```

That is it — Claude Code discovers it. Check the install:

```bash
node ~/.claude/skills/orchestrate-implementation/driver.mjs   # prints the command list
```

To update an existing install, pull — the clone command above only works once
per machine, because the directory is already there:

```bash
git -C ~/.claude/skills/orchestrate-implementation pull
```

To install by hand instead, copy `SKILL.md`, `driver.mjs` and `reference/` into
`~/.claude/skills/orchestrate-implementation/`.

## Use

```
/orchestrate-implementation docs/plans/
```

Point it at one plan file, several, a directory, or a glob. If you give it
nothing it asks. The plans are *your* project's plan files, wherever you point
it — not files that ship with the skill.

---

## The orchestrator does not build

It never refines a plan and it never writes product code. Refining goes to an
agent; building goes out as a chip. The orchestrator reads, asks, dispatches,
judges, verifies and merges — nothing else.

That is not tidiness. A context stuffed with half-written code and plan prose
has already made up its mind: it judges its own work kindly, stops seeing what
it just wrote, and loses the thread of who is waiting on what. Judgement and
verification are the whole job, and they are the first things to go.

| Work | Who does it |
|---|---|
| Reading the plans, finding the gaps, asking you | The orchestrator |
| Rewriting a plan so it can be built from | An agent, one per plan |
| Writing any product code at all | A chip, in its own copy of the repository |
| Running the checks, judging, merging | The orchestrator |

The rule breaks on small jobs, never big ones — the one-line fix, the obviously
missing import. So it is checked, not just asked for:

```
⚠ the main checkout has changes on files that belong to a task:
    apps/api/src/core/cards/scheduler.py  → belongs to 2.1
  You build nothing here. If this is yours, undo it and let 2.1 do it in its own copy.
```

## Nothing an agent is told lives only in a context

Contexts get compacted, silently, and what goes is detail — a file dropped from
a list, a condition dropped from a decision. The agent then builds against
something the orchestrator no longer holds, and neither can see the gap.

So nothing is retyped from memory. Every brief is written to a file and the
agent is given the path. Every refining agent writes its own report to a file,
and the orchestrator reads that file. The context carries the pointer, never the
payload.

```
.claude/orchestration/
  register.json          every decision, gap and task
  refine/<plan>.json     what each refining agent found, in its own words
  briefs/<key>.md        exactly what each chip was told
  messages.jsonl         every word that passed between the two
```

Task states say where the work is. They never say what was promised — that the
board shows a task running tells you nothing about the question its agent asked
an hour ago and is still waiting on. So both directions are logged, and one
command reads it back:

```
These are waiting on you. Deal with each one — none of them will ask twice.

  2.1       asked you something and has had no answer
             “the settings file is not in my list but the plan says I must add a key to it”
             since 2026-08-25 08:35:39
```

An agent asks once. It was told to stop and ask rather than guess, so it stops
and waits — quietly, looking exactly like an agent that is working.

And when the session running everything ends, the run is recoverable rather than
lost: a new one takes it over, rewrites every brief with its own address, and is
handed the re-announcement to send to each agent still working.

Recording a report the agent did not write is refused outright:

```
error: no report at .claude/orchestration/refine/docs-plans-2.1.json and nothing on stdin.
       The agent was told to write its report to that path. Ask it to,
       rather than retyping what it told you — that is how files get dropped.
```

And a record corrected after its brief went out does not silently disagree with
what the agent is holding:

```
⚠ the record changed after these briefs were written — the agent holding one is
  working from something you have since corrected:
    2.1  .claude/orchestration/briefs/2.1.md
  Rewrite with `brief --all`, then tell each affected agent to re-read its brief.
```

## Act one — the grill

It reads every plan in full, then runs two passes that fail in different ways.

**Sentences that dodge a decision**, with a density band per file so you know
where the fog actually is:

```
docs/plans/1.6-notes-and-cards.md     0 in   555 lines    0.0/100  settled
docs/plans/0.14-the-sweeper.md       14 in   615 lines    2.3/100  mostly settled
docs/plans/2.1-flashcards.md          9 in    23 lines   39.1/100  barely specified
```

**Questions a plan never raises at all** — a word scanner cannot see an absence,
and in practice absences are the expensive ones:

```
docs/plans/2.1-flashcards.md
  ✗ never says what happens when it fails      [failure]
  ✗ never says who is allowed to do it         [permission]
  ✗ never says what happens to what already exists
  ✗ never says how it is undone or deleted     [undo]
```

Then it researches real options — the web, GitHub, and your own codebase — and
asks you in plain language:

```
How should the app work out when a card comes back?
  • A memory model, settings copied  (Recommended)
      ✓ Each card carries how hard it is and how long the memory holds,
        so its day fits that student.
      ✕ Three numbers per card instead of one, and every date must record
        which settings made it.
  • The classic multiply-the-gap rule
      ✓ One number per card, about thirty lines to write.
      ✕ A card you keep failing sinks to the smallest gap and stays stuck
        there for ever.
```

**The plain-language rules are enforced, not suggested.** A question that names
a file, uses jargon, runs long, or offers an answer with no stated cost is
refused before you ever see it:

```
✗ question names a file or path — say what it does instead
✗ question uses "algorithm" — plainer word needed
✗ the recommended answer must be listed first
✗ answer 1 has no cost
```

Answers are written into a decisions record — what was chosen, why, what was
turned down and why, what conditions the choice carries, what it reaches back
into — and a settled-decisions table is pasted into each plan, so the vague
sentence stops being what a builder reads.

## Act one and a half — refinement

Settling *what* does not make a plan buildable. Nothing yet says which modules
the work sits on, which files it touches, or what would prove it works.

So one agent per plan goes into the actual codebase, finds what already exists
that the work must build on, and rewrites the plan so every settled decision is
stated as a decision. It is bounded hard: it may touch no file but its own plan,
it writes no product code, and **it may decide nothing.**

If it finds something the plan needs that nobody settled — a number, a method, a
rule that only became visible against real code — it reports it and does not
choose. The grill reopens:

```
⚠ 1 NEW undecided thing(s) found against the real code.
These are gaps, not decisions. The grill reopens — ask the user before any chip exists:
```

What comes back is what Act two hands out. `owns`, `needs` and `verify` are
worked out against the real tree rather than guessed at a desk — which matters,
because the whole parallel arrangement rests on `owns` being true.

## Act two — driving it out

The settled plans become tasks. Each declares what it needs, **what files it
owns**, what it must build on, and what counts as proof.

**Two tasks running at the same time may never touch one file — and a shared
file is only the easy case.** Almost every collision that reaches CI is two
tasks touching *different* files that share one invariant: a migration chain
with one head, a lockfile, a closed list some test asserts exact equality over.
Tasks name those points under `serialises`, and the graph refuses both kinds of
clash the same way:

```
⚠ 2.1 and 2.5 would both change the same files: .../cards ↔ .../cards/shared.py
  Split the work, or make one wait for the other. They cannot run together.

⚠ 2.1 is told to build on `packages/tuning`, which 2.5 is rewriting in the
  same round. It would be reading somebody mid-edit. Make 2.1 wait for 2.5.

⚠ 0.14b and 1.8b both move the same serialisation point: alembic-head
  No file overlaps, and it will still land red — the point is single-file in effect.
```

And because a refined `owns` list is still an untested one — it fails narrow,
one stop-and-ask round-trip per missing file — each round is **pre-flighted**
before it opens: one read-only agent per task reads the plan and the code and
reports every file the record missed, with the file:line that proves it. A
`doctor` pass then checks everything the briefs cite that can be checked
mechanically: every path exists, every verify command's binary resolves, no
brief is stale. Neither agent fixes anything; both write files, not chat.

The work goes out by **interference, not by round**: a task opens the moment
everything it builds on has landed and nothing it owns — file or serialisation
point — is in the hands of a task currently open. `frontier` prints what can
open right now and exactly why the rest cannot; every landing widens it.

```
✗ D would interfere with work that is open right now:
    B  ↔  src/shared.py
  It opens the moment B lands — `frontier` will say.
```

The refusal is at chip creation, because once a chip exists somebody can click
it. And nothing opens before its requirements land — a chip copies the
repository when it is opened, so an early chip is stale by exactly what it
waited for.

**The machine itself is a serialisation point.** Seven open chips means seven
full test suites can start at once — a memory panic, not a speed-up. So heavy
checks share one slot: taken atomically (two agents seeing "free" at the same
instant cannot both win), freed by the holder's process exiting rather than by
anyone remembering, stolen if the holder dies or overstays, polled every ~10
seconds by whoever is waiting. A generated wrapper makes it one word long:

```bash
.claude/orchestration/bin/with-ci-slot pnpm -C apps/api test
```

CI on the moving main line becomes a checkpoint the frontier keeps visible —
it gets loud past five unproven landings — and stays the only check in the
arrangement that varies the environment.

```
key           state      waits for     address           title
0.14          ● landed   —             proj-a1         the sweeper and the shelf
2.1           ▶ ready    —             proj-b2         the flashcard scheduler

round 2 of 6: 1/2 landed — next round is not created yet
```

Each brief is self-contained: the plan to read, the decisions already settled,
the code it must build on (read-only ones marked), the only files it may change,
its branch, the proof it must run, and who to report to.

Nothing lands on an agent's own word. The branch is diffed and every file marked
against what that task was allowed to touch — checked, not eyeballed:

```
2.1 changed 2 file(s) on step/2.1:
  ✓ src/cards/a.py
  ✗ src/other/b.py
✗ 1 file(s) outside what it was allowed to touch
```

Only then is it joined in a staging copy, run in full, and merged.

### Two traps this handles

- **A chip makes its own copy of the repository when it is opened, not when it
  is released.** A blocked chip created on day one and released on day three is
  three days stale. Every release message carries a check the agent must run
  before writing a line.
- **A chip's copy gets a random name**, so its address cannot be worked out in
  advance. Every brief opens by demanding a check-in message — even from an
  agent on hold, because one that never checks in can never be released.

---

## What is in here

| file | what it is |
|---|---|
| `SKILL.md` | the workflow — the three acts, what the agent reads and follows |
| `driver.mjs` | the bookkeeping: scanning, the question linter, the task graph, the board |
| `reference/plain-words.md` | the vocabulary to reach for instead of jargon |

The driver does the parts a model does badly — remembering every gap it found,
refusing to call a session finished while one is unanswered, and holding each
question to the plain-words rules. It decides nothing.

```
node driver.mjs            # every command
```

## What a run leaves behind

```
.claude/orchestration/
  register.json          every decision, gap and task
  backups/               the last 30 states of it, kept on every write
  refine/<plan>.json     what each refining agent found
  preflight/<key>.json   what each pre-flight agent found
  briefs/<key>.md        exactly what each chip was told
  messages.jsonl         every word that passed between the two
```

Work that is only possible in a window between two pieces gets a first-class
record (`owed`) — a round refuses to close silently on top of one.

## Licence

None yet — all rights reserved until one is added.
