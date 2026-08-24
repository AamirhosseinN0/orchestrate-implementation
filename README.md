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

## Install

```bash
git clone https://github.com/AamirhosseinN0/orchestrate-implementation.git \
  ~/.claude/skills/orchestrate-implementation
```

That is it — Claude Code discovers it, and `git pull` in that directory updates
it. To install by hand instead, copy `SKILL.md`, `driver.mjs` and `reference/`
into `~/.claude/skills/orchestrate-implementation/`.

Needs **Node 18+** and **git**. The driver has no dependencies.

## Use

```
/orchestrate-implementation docs/plans/
```

Point it at one plan file, several, a directory, or a glob. If you give it
nothing it asks.

---

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

## Act two — driving it out

The settled plans become tasks. Each declares what it needs, **what files it
owns**, what it must build on, and what counts as proof.

**Two tasks running at the same time may never touch one file.** That is the
load-bearing rule, and it is checked rather than hoped for. The task graph
prints what runs side by side — and refuses to let a broken plan out of the
door:

```
⚠ 2.1 and 2.5 would both change the same files: .../cards ↔ .../cards/shared.py
  Split the work, or make one wait for the other. They cannot run together.

⚠ 2.1 is told to build on `packages/tuning`, which 2.5 is rewriting in the
  same round. It would be reading somebody mid-edit. Make 2.1 wait for 2.5.
```

Every task then goes up as a chip at once — blocked ones included, created on
hold. **Once you have created them, the rest is not yours.** The orchestrator
releases each blocked agent by message when its requirements land, takes back
finished work, checks it, sends back what is wrong, merges what is right, and
moves on to whatever that frees.

```
key           state      waits for     address           title
0.14          ● landed   —             proj-a1         the sweeper and the shelf
2.1           ▶ ready    —             proj-b2         the flashcard scheduler
2.9           ⏸ held     2.1,2.5       proj-c3         the knowledge bar
```

Each brief is self-contained: the plan to read, the decisions already settled,
the code it must build on (read-only ones marked), the only files it may change,
its branch, the proof it must run, and who to report to.

Nothing lands on an agent's own word. Work is checked against what it was
allowed to touch, joined in a staging copy, run in full, and only then does the
main line move.

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
| `SKILL.md` | the workflow — what the agent reads and follows |
| `driver.mjs` | the bookkeeping: scanning, the question linter, the task graph, the board |
| `reference/plain-words.md` | the vocabulary to reach for instead of jargon |

The driver does the parts a model does badly — remembering every gap it found,
refusing to call a session finished while one is unanswered, and holding each
question to the plain-words rules. It decides nothing.

```
node driver.mjs            # every command
```

## Licence

None yet — all rights reserved until one is added.
