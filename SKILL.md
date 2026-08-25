---
name: orchestrate-implementation
description: Run an implementation end to end. First read the plans and settle every undecided thing with the user in plain language; then send an agent into the codebase to refine each plan into something buildable; then hand out the work one round at a time, a chip per task. Inside a round it runs autonomously — checking returned work, sending back what is wrong, merging what is right — and no chip of the next round exists until the last one has landed and CI is green on it. Use when asked to orchestrate an implementation, work through a plan, grill a plan, settle open decisions before building, hand out tasks as chips, run work in parallel worktrees, coordinate agents, or drive a plan to done.
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
  refine/<plan>.json     what each refining agent found, in its own words
  briefs/<key>.md        exactly what each chip was told
  messages.jsonl         every word that passed between you and an agent
```

Two habits follow, and they are not optional:

- **Never summarise an agent's report into the record.** If a report is missing,
  ask the agent to write the file — do not reconstruct it from what it said in
  the chat. `refine done` refuses rather than letting you type it in.
- **Log every message, both directions, as it happens.** One line each. It is
  what tells you, after a compaction or a dead session, that an agent asked
  something three hours ago and is still sitting there.

```bash
node $DRV heard 2.1 --kind question --text "the settings file is not in my list"
node $DRV say   2.1 --kind reply    --text "my error, brief rewritten, re-read it"
node $DRV outstanding    # who is waiting on you, and since when
```

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
| 5 | Show the rounds, then put up the chips for **one round** | You have created them |

And then once more per round, for as many rounds as the work has — the next
round's chips do not exist until the last one has landed and been proved.

**Inside a round, it is not yours.** From the moment you create a round's chips
the orchestrator runs it: it takes back finished work, checks it, sends back what
is wrong, merges what is right, and drives the round to landed and CI-green. It
talks to the agents by message. You are not the messenger and you are not the
gate.

**Between rounds, it comes back to you** — with the previous round merged and
proved, and the next round's chips ready to create. That is the only handover,
and it costs you one sitting per round.

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

Write the record — that one is yours, it is what the user decided and you are
the one who heard it.

**Do not edit the plans yourself.** The settled-decisions table and the vague
sentences that need replacing are handed to the refining agent in the next act,
along with the codebase. It is the one that rewrites plans; you would be doing
its job with worse information and a dirtier context.

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

The brief hands the agent the settled decisions that bind this plan, tells it to
read the codebase and find what the work must build on, and tells it to rewrite
the plan so every decided thing is stated as decided — **including pasting in the
settled-decisions table**, which `render --plan` will print for you to include. It is bounded hard: it may
touch no file but that plan, it writes no product code, and —

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

If the file is not there, `refine done` refuses. Ask the agent to write it.
Do not type in what it told you — that is exactly how a file goes missing:

```
error: no report at .claude/orchestration/refine/docs-plans-2.1-flashcards.json
       and nothing on stdin.
       The agent was told to write its report to that path. Ask it to,
       rather than retyping what it told you — that is how files get dropped.
```

The shape it must write:

```bash
# .claude/orchestration/refine/docs-plans-2.1-flashcards.json
{"summary":"wrote the settled scheduler into the plan and named the queue it uses",
 "builtOn":[{"path":"packages/offline/src/outbox.ts","what":"the queue a phone already uses"}],
 "tasks":[{"key":"2.1","title":"the flashcard scheduler","needs":["0.14"],
           "owns":["apps/api/src/core/cards"],"verify":["pnpm -C apps/api test"]}],
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
  "needs":[],"owns":["packages/tuning","apps/api/src/core/sweeper"],
  "context":[{"path":"apps/api/src/core/worker","what":"the background queue a sweep runs on — use it, do not write another"}],
  "decisions":["One shelf of tuned numbers, versioned, shipped in both builds"],
  "verify":["pnpm -C apps/api test"]},
 {"key":"2.1","title":"the flashcard scheduler","plan":"docs/plans/2.1-flashcards.md",
  "needs":["0.14"],"owns":["apps/api/src/core/cards","packages/offline/src/cards"],
  "context":[{"path":"packages/tuning","what":"the shelf 0.14 built — put your constants there"}],
  "verify":["pnpm -C apps/api test","pnpm -C packages/offline test"]}]
J
```

**Ownership is not optional and it is the load-bearing rule: two tasks running at
the same time may never touch one file.** `owns` is how that is enforced. Get it
from the plans — a step that says what it owns and what it only uses has already
told you.

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

## 11. Create one round of chips, and only one

**Every chip of the current round, together — and not one chip of the next.**
Put the round on screen in one go so the user creates it in a single sitting.

**A round is finished when every task in it has landed *and* the main line has
been through CI.** Not when the last agent reports done, not when the last merge
goes in — when the whole of it has been proved together, on the main line, by a
run nobody had a hand in. Until that, no chip of the next round exists.

The driver refuses rather than trusting anyone to remember:

```
✗ C is in round 2, and an earlier round is not finished.
  No chip of this round exists yet, and none is created until:
    round 1: all landed, but CI has not been recorded green
```

Why it is worth the wait: every task in round two branches from a main line built
out of round one's merges. If those merges are wrong together — each fine alone,
broken in combination — then every chip you opened is building on a false floor,
and you find out at the end of round two instead of the start.

```bash
node $DRV brief 0.14        # the whole self-contained prompt
node $DRV chip 0.14 --id <task_id>
```

`brief` **writes the brief to a file** and prints the short message to give the
chip — a path, the check-in line, and whether it is on hold. That short message
is the chip's `prompt`; the brief itself is read from disk. Nothing the agent
needs is carried in a chat message, so nothing can be lost from one.

```bash
node $DRV brief 0.14
# wrote /path/to/project/.claude/orchestration/briefs/0.14.md
# Give the chip this, and nothing retyped from memory: …
```

The file lives in the **main checkout**, and the chip works in its own copy, so
the path it is given is absolute — the brief will not be inside its worktree.

The brief carries everything and leaves nothing to infer: the plan to read, the
decisions already settled, the code it must build on (read-only ones marked),
the only files it may change, the branch, the proof it must run, who to report
to, and the standing order to stop and ask rather than guess.

`brief --all` rewrites every one at once and names which changed — run it after
any correction to the record.

A held brief opens with `# ON HOLD — do not start yet`, names what it waits for,
and says that nothing at all begins until it is told
**"requirements are done, you may start"**.

**Every brief opens by telling the agent to check in** — one message, sent before
it reads anything, even when it is on hold. That message is the only way you
learn where to reach it, because its copy of the repository gets a random name
you cannot predict. Record each one as it arrives:

```bash
node $DRV agent 2.1 --name proj-b2      # the name the check-in came from
```

Reply to a held one straight away so it knows it was heard and must wait. A task
with no address cannot be released — `release` refuses and tells you so.

Keep the board in view; it shows who has checked in and who has not:

```bash
node $DRV board
```

## 12. Releasing a held chip — which should never happen

A round only opens once every round before it has landed, and a round never
contains a task that waits on another task in the same round. So **every chip you
create is ready to start, and none is ever on hold.**

If one is, something is wrong rather than merely slow — the task is in the wrong
round, or something was never recorded as landed. `chip` says so:

```
⚠ This should not have happened. A round only opens once every round before it has
  landed, so nothing in the round being created can still be waiting.
```

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

## 13. Take the work back

A chip reports two ways — a message so you hear it now, and a written line so it
survives the window being closed:

```bash
node $DRV done 2.1 <<'J'
{"commit":"9f3c1ae","verified":"apps/api 214 passed","notes":"the shelf ships empty"}
J
```

Then **you check it again. Its own word is not enough.**

```bash
node $DRV guard 2.1
```

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
which is not finished work either. Log the send-back:

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

## 14. Run it to the end without being driven

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

## 15. Close the round before opening the next

When the last task of a round has landed, the main line has changed in ways no
single task ever saw. Run CI on it and record what came back:

```bash
node $DRV wave                                   # what is left, and what is holding the next round
node $DRV ci --status green --ref gh-run-4471    # or red
```

`ci --status green` refuses while anything in the round is unlanded — a green run
that predates a merge does not cover it. `red` blocks the next round outright:
send the break back to whoever owns those files, exactly as you would a failed
check, and record green only when a fresh run says so.

If the project genuinely has no CI, say so once and say why — a missing run is a
decision, not an omission:

```bash
node $DRV ci --status skipped --why "no CI on this repo; ran the full suite by hand on main"
```

Then, and only then, put up the next round.

## 16. If the session running this ends, take it over

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
- **A round that has landed is not a round that is finished.** Every merge passed
  its own staging run, and the last merge changed a main line that none of the
  earlier ones were tested against. CI on the finished round is the only thing
  that has seen all of it at once.
- **The gate is at chip creation, not at release.** Once a chip exists somebody
  can click it, and then work is happening on a floor you have not proved. That
  is why the refusal is there and not one step later.
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
- **Refinement is the only place `owns` can honestly come from.** Worked out at
  a desk it is a guess; worked out against the real tree it is a fact. That
  matters because the whole parallel arrangement rests on it.
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
- **`chip` says "is in round N, and an earlier round is not finished"**: working
  as intended. `wave` names what is missing — usually a CI result nobody
  recorded.
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
  its brief. Do not paste the JSON in from the chat.
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
