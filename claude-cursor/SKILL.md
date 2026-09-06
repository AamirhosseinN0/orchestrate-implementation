---
name: claude-cursor
description: Run an implementation end to end — ask whether to build on Cursor, on Claude or on DeepSeek first, load the plans, map which of them touch which files so the round can be made wide before anything runs, judge how hard each step is and pick a model or an effort for it, refine away the ambiguity, check that nothing collides, then run every step that can run at once. Every step that can run is launched in the same round on its own agent; only a dependency that is not yet on the main line or a serialisation point that open work is already moving holds one back. A dependency counts the moment it has merged, not once its suite is green. Two steps owning the same file run together and reconcile at the merge, because each builds in its own worktree. Agents execute on the Cursor CLI (`agent`), on Claude Code (`claude`) with Sonnet on the lower tiers and Opus on the upper ones, each at the reasoning effort its tier chose, or on DeepSeek V4 Flash through opencode; a step can also run as a Claude Code subagent. Whichever builds it, an agent that hits a problem it does not fix writes it to docs/temp_bugs/ before it finishes. Use when asked to orchestrate a plan, run an implementation, hand the building work to Cursor, Claude or DeepSeek agents, choose which model, effort or CLI builds a round, run steps in parallel, drive work in parallel worktrees, pick models per step, or take a written plan through to merged code.
allowed-tools: Agent, Bash, Read, Write, Edit, Grep, Glob, AskUserQuestion, TodoWrite
---

# The stages

```
runner  →  load  →  map  →  assess  →  refine  →  check  →  run
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
Only two things hold a step back: a dependency that is not yet on the main
line, and a serialisation point that open work is already moving.**

**On the main line means merged, not proven.** A dependency counts from the
moment `join` puts it on the main checkout's `HEAD` — not from `land`, which is
the bookkeeping that follows a green suite. `run open` cuts a worktree from that
`HEAD`, so a dependent opened after the join holds byte-identical code to one
opened after the landing; what landing adds is proof, and the dependent consumes
the code, not the proof. Waiting for it anyway put the whole slot queue on every
hop of the chain.

Not caution about the runner, not tidiness, not "let me see how the first one
goes", not the size of the round. If `check` names five steps, five agents start
now — five separate backgrounded `Bash` calls, in one message.

**Open them with one command, not five.** `run open --all` opens every step
`check` named, in one call, and prints every launcher line together:

```bash
node $ORCH run open --all
```

This matters more than it looks. Opening a round used to take one `run open` per
step, each its own round trip, each printing one launcher line to be collected by
hand — and a round opened that way is a round that drifts into being opened one
step at a time, which is the same round run end to end. The set `--all` opens is
`check`'s, checked against itself as well as against what is out, so opening all
of it at once is exactly as safe as opening the first one.

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
turned 130 minutes of work into a 17-minute span.

The chip stage on that same build ran one at a time, because its steps were a
near-total dependency chain — S-001 → S-002 → S-006 → S-007 → S-008 → S-009 →
S-010. That was read at the time as required rather than wasted. It was not.
A seven-deep chain out of ten plans is not what the requirements demanded; it is
what happens when ordering is recorded between whole plans instead of between
the pieces of work that actually depend on each other, and when every hop waits
for a suite the next hop does not consume. `map` addresses the first and
joining-is-enough addresses the second.

Up to twelve agents in flight is verified clean; the ceiling is memory, not the
API. Heavy checks inside those agents go through `slot`, so twelve suites queue
instead of colliding.

## The rule: every question goes to the user in plain words

Four moments here stop and ask — which runner builds the round, what a refining
agent could not settle from the code, an alarm only a human can call, and a step
that ended its run with a question. All four go through `AskUserQuestion`, and
all four are written the same way.

**The user is deciding, not reviewing code.** A question they have to decode is
a question they answer badly, and a badly answered question gets built.

- **One decision per question.** If it needs "and", it is two questions.
- **Under 28 words, ending in a question mark.**
- **No step keys, no paths, no command names, no backticks.** `S-4` and
  `orchestrate.mjs` are how you found the decision, not what the decision is.
  Say "the step that builds the sign-up form", not `S-4`.
- **Name a thing by what it does, not what it is called.** Not "two steps
  contend on the migration head" — "two pieces of work both want to change the
  shape of the stored data, and only one can go first".
- **Code only when the answer is the code**: a line the user has to run
  themselves, or a message an agent printed that they need to read exactly as it
  was written. Never a snippet as background.

Every option carries three things:

```
label     under 6 words, plain
✓ gain    what you get. Concrete, not "better".
✕ cost    what it costs. Never "slightly slower" — say what breaks, who
          notices, and when.
```

**Exactly one option is marked `(Recommended)`, and it is listed first.** The
recommendation follows from what is already on the board — say which, when that
is not obvious. **A cost of "none" means the option is not real**: cut it, or
find the true cost. In `AskUserQuestion` the gain and the cost are the option's
`description`, as `✓ <gain> ✕ <cost>`.

## 0. Ask which runner, before anything else

Steps run on one of three CLIs, and the choice is made once for the whole round
— after that it is automated, so there is no later moment to ask.

**Put this to the user before `load`:**

> **Which should build this round — Cursor, Claude, or DeepSeek?**
>
> · **Cursor (Recommended)**
>   ✓ Five models, weakest to strongest, so an easy step is not paid for at a
>     hard step's price — and every run is checked against the model that
>     actually answered it.
>   ✕ Each step costs more and takes longer, and on a wide round that is the
>     whole round's bill.
> · **Claude**
>   ✓ Sonnet takes the ordinary steps and Opus the hard ones, each thinking as
>     hard as its rung asks, and every run is checked against the model that
>     answered.
>   ✕ The two hardest rungs are the priciest work here, so a wide round that
>     lands on them is the largest bill of the three.
> · **DeepSeek**
>   ✓ Cheaper and faster, and one dial sets how hard it thinks.
>   ✕ Nothing records which model answered, so a quiet drop to a weaker one
>     builds the entire round before anybody could notice.

Recommend Cursor unless the user has already said that cost or speed is the
constraint. The ladder is the reason: it is what lets an easy step be cheap
without leaving a hard one underpowered. Claude is the same argument with two
models instead of five and a reasoning dial on top; reach for it when the round
is small enough that Opus on its hard steps is worth paying for.

Then set it:

```bash
node $ORCH runner use cursor      # or: claude, opencode
node $ORCH runner                 # what this round is on, and what that means
```

`runner use` refuses a runner whose binary it cannot find, and says so before a
round is built on it rather than once per step inside a backgrounded run.

### Cursor

```bash
agent status                    # not logged in → stop, ask the user to run `agent login`
node $ORCH models                # the ladder this account can actually run
```

If the ladder has drifted from what the account can actually run:

```bash
node $ORCH models sync
```

### Claude, through Claude Code

```bash
node $ORCH runner use claude
node claude-cursor/scripts/models.mjs efforts --runner claude
```

Two models across the five tiers, and the tier chooses the effort as well:

| tier | model | effort | for |
|---|---|---|---|
| `composer` | Sonnet 5 | `medium` | mechanical work, no judgement |
| `low` | Sonnet 5 | `medium` | verification, and light or well-specified work |
| `medium` | Sonnet 5 | `high` | the default — ordinary feature work |
| `high` | Opus 5 | `medium` | genuinely hard work |
| `xhigh` | Opus 5 | `xhigh` | the top of the ladder only |

**The effort column is not sorted, and that is the point.** The model changes
under it: Sonnet climbs to `high` at the default tier, and the rung above hands
over to Opus at `medium` rather than pushing Sonnet harder. Going from `medium`
to `high` turns the effort down and the model up — a stronger model taking its
time, instead of a weaker one straining.

`composer` and `low` are the same model at the same effort. That collapse is
real — moving a step between them changes nothing — and `assess` prints it
rather than leaving it to be discovered.

Two things this runner has that DeepSeek does not:

- **The run is checked afterwards.** Claude Code names the model that answered
  in its own opening event, in the same place Cursor does, so a silent downgrade
  is caught rather than merely unlikely. That is the whole of what DeepSeek
  cannot do.
- **The effort is checked against a fixed vocabulary**, not against a cache that
  may never have been written. A ladder naming an effort outside it is refused
  before the round rather than billed for.

`--session-id` means the conversation exists before the run does, so a run cut
off mid-stream is resumed automatically on the same conversation — the same
recovery Cursor gets, which opencode cannot have.

Its binary is not on a non-interactive `PATH` either, so `runner use` looks for
it and refuses before a round is built on it.

### DeepSeek, through opencode

```bash
node $ORCH runner use opencode
node claude-cursor/scripts/models.mjs efforts --runner opencode
```

One model — **DeepSeek V4 Flash** (`opencode-go/deepseek-v4-flash`) — so a tier
does not choose a model, it chooses the effort:

| tier | effort | for |
|---|---|---|
| `composer` | `low` | mechanical work, no judgement |
| `low` | `low` | verification, and light or well-specified work |
| `medium` | `low` | the default — ordinary feature work |
| `high` | `high` | genuinely hard work |
| `xhigh` | `max` | the top of the ladder only |

`composer`, `low` and `medium` are all the same effort. That collapse is real —
moving a step between them changes nothing — and `assess` prints it rather than
leaving it to be discovered.

Where the collapse falls follows the ladder's centre of gravity rather than its
midpoint. Three efforts cannot hold five tiers evenly, so the default maps to
the model's ordinary effort and the two rungs above it are the ones that buy
something: `high` reaches, `xhigh` is the top. `medium` used to map to `high`,
which meant every default step on this runner reached — which is the thing
`high` exists to be the exception for.

Two things are worth knowing before choosing this runner:

- **Nothing says which model answered.** opencode's JSON names the model
  nowhere, so a run is recorded as what was *asked for* and carries
  `modelVerified: false`. With one model there is nothing to confuse it with,
  but a silent downgrade would still not be caught. Cursor's runs are checked;
  these are not.
- **An effort the model does not accept is thrown away in silence.**
  `opencode run --variant nonsense` runs a normal turn and reports nothing. So
  the effort is checked against opencode's own registry *before* the run, and a
  ladder naming an effort that model does not list is refused rather than billed
  for. The accepted set is read from the registry at run time, not fixed here —
  only `max`, `high` and `minimal` have been confirmed from opencode's own help
  text, so do not hard-code a vocabulary against this paragraph.

- **A run that never answers is stopped — but a long one is not.** The provider
  has been seen accepting a request and returning nothing at all — no events, no
  error, empty stderr, nothing in opencode's own log — for a prompt that had
  answered in about a second minutes earlier, on two models at once. Unbounded,
  that leaves the status on `running` and stalls the round with no error
  anywhere, which is worse than failing.

  **The bound is silence, not duration.** A wall-clock cap cannot tell a wedged
  provider from a step that is simply long, and guessing cost two runs: a
  30-minute default killed an `xhigh` step that had done all its work and had
  not yet committed, and raising it to 90 minutes killed another the same way.
  A run is stopped when its log has not grown for `OPENCODE_ORCH_IDLE` seconds
  (default 900). `OPENCODE_ORCH_TIMEOUT` remains as an outer wall-clock backstop,
  now 6 hours — reaching it means something is looping, not that the work was
  big. Either at `0` switches that bound off. A run stopped by either is recorded
  as `timeout`, and the message says which bound it was and what to do about it.

  Neither is a reason to start the step again. The worktree still holds the work:
  `sendback <key>`.

`opencode` is not on a non-interactive `PATH` — the login profile puts it there
— so the launcher resolves it rather than assuming. Being able to run it in a
terminal is not the same as this being able to.

**Before committing a round to this runner, check the provider answers at all:**

```bash
~/.opencode/bin/opencode run -m opencode-go/deepseek-v4-flash --format json "Reply with exactly: OK"
```

A second or two and three JSON events is healthy. Silence is the failure above,
and it is worth finding before twelve agents are launched into it.

### What is the same either way

The worktree, the branch, the brief, `guard`, `join`, `land`, the slot, and the
record's shape. A step does not know which runner it is on, and neither does
anything downstream of `run record`.

So does this, which every brief carries whichever runner is building it:

> **A problem an agent did not deal with goes in `docs/temp_bugs/<key>.md`.**
> Something already broken before it arrived, something outside what it owns,
> something it worked around — written down before it finishes, one file per
> step so twelve agents writing at once never meet. `guard` counts that file as
> owned, so reporting a problem can never be the thing that fails a step.

Read that directory when the round is done. It is the only place a bug an agent
saw and could not fix survives the log it was found in — and a log is 3 MB that
nobody opens.

### What differs

| | Cursor | Claude Code | opencode |
|---|---|---|---|
| the conversation's address | a chat, minted before the run | a session id, minted before the run | a session, read out of the run's own log |
| resuming it | `agent --resume <uuid>` | `claude --resume <id>` | `opencode run -s <id>` |
| the model that answered | checked against the ladder | checked against the ladder | not recorded anywhere |
| a run cut off mid-stream | resumed once, automatically | resumed once, automatically | reported, and resumed by hand |
| tokens and cost | not in the log | in the final `result` | in every `step_finish` |
| what it wrote | from its `tool_call` events | from the tool blocks in its messages, without line counts | from its tool parts |

`run open` prints the right launcher line for whichever is chosen, and
`sendback` prints the right resume line. Neither is something to remember.

## 1. Load the plans

```bash
node $ORCH load docs/plans/
```

It prints every plan and how long it is. **Read every one of them in full before
going further.** Nothing downstream can recover a plan you skimmed.

## 2. Map — how wide this round can get, while you can still change it

```bash
node $ORCH map
```

**The width of a round is decided here, before any agent runs.** A plan becomes
at most two steps and usually one, so ten plans is a round of ten or twelve
steps, not thirty; and `step link` turns a plan-level `requires:` into a
dependency between every pair of steps. A plan that is one coherent slice of
files costs nothing under either rule. A plan holding four disjoint file sets
pays under both, and no refining agent will rescue it — split it here.

`map` reads the paths out of the plans' own prose and prints:

- **Seams** — a path three or more plans reach for. Every one is a fan-in, and a
  fan-in is the deepest part of any graph.
- **Plans whose file sets touch nothing else** — the ones that can already run
  beside each other. This is the number that says how wide the round can get.
- **The ordering already declared**, and which plans declare none.
- **Shared ground more than one plan moves** — these go one at a time.

It is a reading of the prose, not a gate; nothing is held back on it. Once steps
exist it measures the same thing from `owns` instead, which is the real answer.

### What to do with what it says

**Lift every seam into its own plan that lands first.** A file touched by three
plans is either a contract or a queue. Written as its own small plan — one step,
strongest tier, minutes of work — it lands once and everything else fans off it.
Left where it is, three steps own it, each reconciles against the other two at
the merge, and anything ordered after them waits for all three. `points.json`
already names the usual ones: route table, schema registry, public exports, env
schema, generated client.

**Then split what is left into slices whose file sets do not intersect.** One
slice is one plan, and this is where the width of a round comes from. Do not
leave it to the refining agents: each is asked for one step unless its plan is
genuinely two pieces of work, so a slice you leave joined here stays joined. A
round of 36 plans that came back as 36 single steps is a queue whatever the
scheduler does with it — and the answer to that is more plans, not more parts
carved out of each one.

**Write the ordering as `requires:`, one line per real dependency.** This is the
step that keeps the requirement intact: "first this part of the user API, then
that part" stops being the order of paragraphs inside one document and becomes a
header `load` reads, the cycle check verifies, and `doctor` confirms points at
real steps. More auditable than prose order, not less.

**Name the slices so their keys cannot collide.** Keys come from the plan's own
filename and a trailing letter is read: `2.1a-contracts.md` gives `S-2.1a`,
`2.1b-read.md` gives `S-2.1b`. Distinct first tokens are the whole of what keeps
twelve plans' keys apart.

**Give every slice enough of the why to stand alone.** This is the guard on the
whole scheme. A thin plan is faster to build and easier to get wrong, because
its agent sees a smaller piece of the intent. Keep the requirement narrative in
one place every slice points at, and open each slice with what it is part of and
what it is not allowed to decide. The round got wider, so each brief carries
more context, not less.

## 3. Assess — how hard each step is, and what runs it

The ladder, weakest to strongest:

| tier | model | for |
|---|---|---|
| `composer` | Composer 2.5 | mechanical work, no judgement — a lockfile bump, a rename |
| `low` | Cursor Grok 4.6 Low | verification, and light work — a check, a small well-specified change in one or two files |
| `medium` | Cursor Grok 4.6 Medium | **the default** — ordinary feature work against a clear plan |
| `high` | Cursor Grok 4.6 High | genuinely hard: subtle logic, a design call the plan left open, refining |
| `xhigh` | Cursor Grok 4.6 Extra High | **the top of the ladder, and it should look like it** — security, concurrency, wide blast radius |

**`medium` is where a step starts, and anything above it is a claim you have to
make.** The tier is not a wish for a good result — every rung produces one — it
is an estimate of how much thinking the work actually needs. A round where most
rows read `high` is not a careful round, it is an unassessed one: `high` stops
meaning "this one is hard" the moment it is what everything gets, and `xhigh`
stops meaning anything at all. Going *down* needs no defence. Verification, a
check, a change the plan already spelled out — `low` does those, and choosing it
is not a risk taken, it is the tier being read correctly.

Read the plans, then propose one row per step — the problem in a few words, the
tier, and why. Note where these land: most rows are `medium`, `low` is used
freely, and the one `xhigh` earns its place in a sentence:

```bash
node $ORCH assess propose <<'J'
[{"key":"S-1","problem":"contracts package + type provider","tier":"low","why":"mechanical, schema-shaped, the plan names every type"},
 {"key":"S-2","problem":"auth middleware, session + CSRF","tier":"xhigh","why":"security-sensitive, wide blast radius"},
 {"key":"S-3","problem":"bump lockfile, regenerate docs","tier":"composer","why":"no judgement needed"},
 {"key":"S-4","problem":"invite flow: form, endpoint, email","tier":"medium","why":"ordinary feature work against a clear plan"},
 {"key":"S-5","problem":"reconcile the two clock sources on replay","tier":"high","why":"ordering is subtle and the plan leaves the tie-break open"}]
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

### Then let position argue too

Difficulty is not the only thing that decides which model a step wants. Where it
sits does as well, and the two come apart:

```bash
node $ORCH assess critical            # what position argues for
node $ORCH assess critical --apply    # take it
```

A step with twenty steps behind it has its latency multiplied by all of them,
and a wrong answer on it costs a re-run of everything it unblocks. A leaf costs
only itself. So this suggests a notch up where the downstream cost is heavy, and
a notch down on a leaf that nothing waits on. It counts the whole chain behind a
step, not just its direct dependents — the first link of a seven-deep chain
unblocks one step and gates six.

It comes out roughly cost-neutral and puts the strongest model where a mistake
is most expensive. It only ever suggests: nothing is written without `--apply`,
and a row the user set is left alone.

This is another reason the default sits at `medium`: a notch is only worth
something if there is room on both sides of it. From `medium`, a hub goes to
`high` and a leaf to `low`, and both moves say something. From `high` — where
the default used to sit — every hub landed on `xhigh` on position alone, which
spent the top of the ladder on where a step sat rather than on what it was.

## 4. Refine — one agent per plan, all at once

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

**A refining agent may edit its own plan and no other.** One rewrote nine plans
in a single run and registered steps off text that was then reverted — the
register described a round that no longer existed anywhere. `refine done` now
diffs the working tree and refuses the whole report if any *other* loaded plan
changed, naming them and printing the `git checkout --` line. If the edits were
meant, `refine done <plan> --allow-plan-edits` records it anyway. A report is
also refused if it keys steps into another plan's numbering: `S-1.2.x` belongs
to the plan whose id is `1.2`, whether or not that plan has reported yet.

**The report may not write the tool's own bookkeeping.** `status`, `runs`,
`branch`, `worktree`, `joinedAt` and the rest are refused with the field named.
A report carrying `"status": "cancelled"` used to merge straight in and leave the
step off the board while the command printed a tick; one carrying
`"status": "landed"` would have claimed a proof that never ran.

**`owns` comes out short far more often than long**, and always in the same
places — the shared registry a step adds one line to, the journal its own
migration writes, the fixture its own proof command regenerates. None of those
is in the plan; they are in the repository's habits. The brief now walks the
agent through all four kinds explicitly. When one is still missed, the answer is
not to re-refine the plan:

```bash
node $ORCH step own S-1 src/capabilities.ts test/access/seed.test.ts
```

`guard` prints that line itself, for the strays no other step owns — see
[When a run finishes](#when-a-run-finishes).

**`builtOn` is the reading the agent did, and it goes to whoever builds the
step.** It used to go nowhere: the field was asked for in the report and appeared
nowhere else in the tool, so every building agent opened with its plan, its own
file list, and nothing at all about the repository it was building into — and
spent its first hour re-deriving the map its own refining agent had drawn an hour
earlier. `refine done` now records it on every step of that plan as `context`,
and the brief prints it under **What is already there**, marking each entry the
step does not own as read-only. A step that named its own `context` keeps it, and
a later report naming none leaves what a step already had alone rather than
blanking it.

Paths there are repository-relative and are judged like `owns` is — the building
agent opens them from its own worktree, so an absolute path or a sentence is
refused and the whole report with it. A step with nothing recorded gets a brief
that says so, rather than a section that quietly vanishes: an absent one reads as
"there is nothing already there", which is never true and is the reading that
gets a second copy of an existing helper written.

**`provides` and `uses` are what decide build order**, and they are the only
fields that can say it. `provides` is what a step makes reachable from outside
itself — an exported type or function, a table, a config key, the handler behind
a route. `uses` is what it consumes that it does not create. Both are
**identifiers**: the thing you would type in an import. `ExamAttempt`, not "the
exam attempt type" and not `src/exam.ts`. A path or a sentence in either field is
refused, because both look filled in and match nothing, and a `uses` that can
never match records no edge at all. Name a route by its handler or its route
constant rather than its URL — a URL is indistinguishable from a path here.

They are compared case-sensitively. `ExamAttempt` and `examAttempt` are two
different exports in every language this runs against, and folding them together
would invent an edge as readily as catch one.

`doctor` names any symbol a step uses that no step in the round provides. That
is fine when the repository already exports it, and is the step about to open
against nothing when it is not — only the round can say which, so it names them
and leaves the judgement.

A plan that names `requires:` in its front matter has that read at `load` — from
`---` lines or from a ```yaml fence, both are read — and put in front of the
refining agent along with whatever keys are already recorded for those plans.

Refining runs all at once, so those keys usually do not exist yet and no report
can name them. Once every report is in, turn the headers into dependencies:

```bash
node $ORCH step link          # --dry-run first if you want to see it
```

Plan B requires plan A, so every step of B needs every step of A. It is
idempotent, it refuses a `requires:` chain that loops, and it says which plans
it could not link because they have no steps yet. Without it an integration
plan opens in the same round as the five plans it integrates.

That cross-product is the safe default and stays the default. It is also the
coarsest thing here: with two steps each it records four edges where typically
one is real, and the three spurious ones hold work that never conflicted.

```bash
node $ORCH step link --only-shared --dry-run
```

records the edge only where the two steps actually meet, and says what made each
edge real. Two steps meet in a way that decides build order when **one consumes
a symbol the other creates** — `provides` against `uses` — or when they **move
the same serialisation point**. Thin plans make the difference moot, which is
the better fix; this is for the round you have rather than the round you wish
you had authored.

**A file both steps write is not an ordering, and does not become an edge.** It
used to. That was this command working against the scheduler it feeds: a `needs`
edge is a gate — `frontier` drops any candidate with one unmet — while `blocks`
and `willMerge` exist precisely to say a shared file is a merge to sequence and
not a gate. So the command recommended for widening a narrow round was
hand-serialising the one thing the engine had been rebuilt to run in parallel.
Those pairs are now listed as pairs that will reconcile, and they run together.

**The symbol test also sees the edge nothing else here can.** B imports
`ExamAttempt` from a module A creates; the two share no file and name no point,
so under the old file test that edge was recorded nowhere and B opened against
code that did not exist yet. That is the failure this exists to stop.

**What it still cannot see is a dependency nobody named**: B reads at runtime
what A writes, and no symbol, file or point says so. So a requirement that comes
out with no edges at all is not quietly dropped — it is named, and it fails the
command, and nothing is written. Half a graph is worse than none, because the
half that landed is the harder half to see.

Keys come from the plan's own name: `S-013-capabilities.md` gives `S-013.1`,
`2.1-flashcards.md` gives `S-2.1.1`. Name plans so that first token is distinct
and the keys cannot collide.

`refine done` prints any question the agent could not settle from the code. **Put
those to the user before building** — in [the shape every question
takes](#the-rule-every-question-goes-to-the-user-in-plain-words). The agent
wrote them in the code's words, naming symbols and files; the user is choosing
between real things and should never have to read either. `refine check` exits 1
while one is open.

## 5. Check — what can open together

```bash
node $ORCH check
```

It prints three things: the set that can open right now, the steps held back and
exactly what they would collide with, and the steps still waiting on work to
land.

It holds a step back only for a serialisation point that open work is already
moving, or a dependency that is not yet on the main line. Steps that share a
file are listed separately, as merges to sequence rather than collisions to
prevent.

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

It also names every path three or more steps own. Each of those is a seam: all
three reconcile against each other at the merge, and anything ordered after them
waits for all three. A step that owns the seam alone and lands first removes the
whole fan-in — which is what `map` was asking for before the plans were refined.

A directory a step is about to create is a note, not a fault: on a build from
nothing that is most of the round. What still fails is a first segment that does
not exist beside something almost exactly like it — a typo, not a plan.

### A point may name the instance it moves

Two steps that both say `migration head` are held apart, full stop — and in a
monorepo with a migration directory per package they may be moving genuinely
separate heads. One shared word serialised eleven steps that never touched.

So a name may say which instance it moves, after a colon:

```
migration head: orders          lockfile: apps/web
```

Two scoped names with the same class and different instances are different
things, and run at the same time. **Only write one where you can point at two
separate files.** If they are really one shared thing, a scoped name switches off
the only gate that catches a clean merge producing a wrong tree.

A scoped name against a *bare* one is still one thing, and `doctor` still fails
it: a step that says plain `migration head` may well mean all of them. Add the
scheme to the project's own list through `CURSOR_ORCH_POINTS` so it is a decision
rather than a spelling drift.

It also warns when a brief is older than the step it describes, because the agent
holding it will not know. What the brief was written from is one list, asked by
all three places that need it — the two that write a brief, and this check. A
field added to the brief and to two of them calls every brief stale; one added
to the writers alone leaves a changed brief reading as current.

`doctor --all` adds the quieter notes: every serialisation point only one step
names, whether or not anything looks like it.

Run it here, not earlier. With nothing open it says so rather than passing, and a
tick over nothing checked is how a green report starts meaning nothing.

## 6. Run

```bash
node $ORCH run open --all
```

That makes a worktree and branch for every step that can go, mints each a fresh
chat, writes each a brief, and prints one launcher line per step — the whole
round, in one command. It also writes them to `.claude/orch/launch/<time>.txt`.

Then launch each of them as its own **backgrounded** `Bash` call:

```bash
$RUN --role chip --tier medium --key S-1 --workspace <worktree> \
     --chat <uuid> --prompt-file .claude/orch/briefs/S-1.md
```

`run open <key>` opens exactly one, for the rare case where you mean to.

### Open everything `check` names, in the same round

This is **the rule** at the top of this document, and it is the single biggest
thing you can get wrong. One `run open --all`, then one backgrounded `Bash` call
per launcher line — separate calls in one message, not a loop that waits on each
in turn. That is what makes them concurrent and what wakes you as each finishes.

If you do open one at a time, `run open` tells you when you have stopped short:
it names how many more `check` would still allow, and the command that takes
them all.

### When the round is narrow, find out why before running it

`check` prints the shape of the whole graph, not just its first row:

```
The shape of it: 18 live step(s) in 9 wave(s) — 3 → 2 → 2 → 2 → 2 → 2 → 2 → 2 → 1
```

A profile like that is a queue with a plan attached, and it is nearly always one
of three things, all fixable in seconds and none visible from the frontier
alone:

- **`step link` without `--only-shared`.** The default is the cross-product:
  plan B comes after plan A, so *every* step of B is given a need on *every*
  step of A. With two steps each that is four edges where typically one is real,
  and the three spurious ones hold work that never conflicted.
  `step link --only-shared --dry-run` shows the same round with only the edges
  that order the work — one step uses a symbol another provides, or the two move
  one serialisation point. A file both write is not an edge.
- **The round is narrow and every plan came back as one step.** Most plans
  *should* be one step; that is the default and on its own it is not the fault.
  What it usually means is that the plan set is too coarse — 36 single-step
  plans is 36 waves however clean the graph is, and no linking flag reaches it.
  `check` says how many live steps are in how many waves. Fix it in `map` by
  writing more and smaller plans, not by sending the refiners back to carve the
  ones you have: a plan cut where it has no seam is two agents contending over
  one piece of work.
- **`serialises` used too readily.** A point is a gate: every step naming it runs
  alone against every other step naming it. Four points shared across a plan's
  steps is a plan that runs one step at a time whatever else is true.
  `doctor` names every point gating three or more steps, with the count.
  A point is only for what git merges *cleanly and wrongly* — a lockfile, a
  migration head, a closed list a test asserts on. A file two steps both edit is
  not one: that is `owns`, and they reconcile at the merge instead of queueing.

**Do not judge a backgrounded run by its exit code.** A detached process comes
back as `-1  [process exited while detached; exit code unknown]` whether it
passed, was rejected for its model, or died mid-stream. Every run writes how it
ended to `.claude/orch/runs/<key>.status` instead:

```
exit 0	passed	S-1	.claude/orch/logs/S-1.jsonl
exit 1	wrong-model	S-2	.claude/orch/logs/S-2.jsonl
```

Then `run record <key> --log <log>`, which reads that status file itself and
holds the log's account against it.

**A run is only recorded as `passed` when three separate witnesses agree**: the
log, the launcher's status line, and the branch. Any one of them dissenting is
enough, and `run record` exits non-zero and says which:

- The **status file** says the process was killed or exited non-zero. A run
  stopped at a bound still holds every event it emitted, and a `step_finish`
  among them reads as a finished run — which is how one step stopped mid-gate
  with everything uncommitted was recorded `passed, 19m, 6 files changed`.
- The **branch has no commit on it.** Whatever the run did is not on the branch,
  so `join` would merge nothing and `guard` would pass on an empty diff.
- The **worktree still has uncommitted tracked changes.** The run stopped before
  it committed.

None of those is a reason to start again. The worktree still holds the work and
the agent still holds the context — `sendback <key> --why "<what to finish>"`.

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

### While the round is out, look in every 15 minutes

Once the round is launched you stop, and the only thing that can wake you is a
process exit. A wedged run never exits. Neither does one whose agent decided
forty minutes ago that the suite was already red before it started and has been
saying so ever since. So one more backgrounded call goes out beside the round:

```bash
node $ORCH vitals --wait
```

It sleeps fifteen minutes, looks at every open run's log, prints what it found
and exits — **and that exit is what wakes you**, the same mechanism a finished
run uses. Launch it in the same message as the round, as one more backgrounded
`Bash` call. Each time it comes back, act on it and, if anything is still open,
launch another. `vitals` on its own looks now instead of waiting.

Two things, both read out of the log:

- **The log should be growing.** A growing log is what alive looks like. One
  that has not gained a byte in fifteen minutes is a run that has died, wedged,
  or is waiting on something nobody is going to give it.
- **The agent's own messages may say it is stuck** — a failure it has decided is
  pre-existing or unrelated to its change, or a bug it says it cannot fix. Only
  what the agent *said* is scanned, never tool output, so a suite printing
  "failed" fifty times is not an alarm and one sentence about it is.

```
  S-1       alive     +412 KB since the last look, last write 40s ago
  S-2       ALARM     silent for 22m — nothing written to .claude/orch/logs/S-2.jsonl since
  S-3       ALARM     ci: "npm test is red but it fails on main too, unrelated to my change"
  S-4       finished  passed — `run record S-4`
```

**An alarm stops you, and the human decides.** Do not send it back and do not
restart it. Both of these are outside what the agent that hit them can settle: a
run that has gone silent has no one to ask, and a suite that was red before the
step started is not that step's to fix. Put it to the user with
`AskUserQuestion` — name the step by what it builds, quote what it said exactly
as it said it, and give what you would do as the recommended option with its
cost beside it.

A line that has already been raised is not raised again: each look reads only
what was appended since the last one. `--every <minutes>` changes the interval,
and it is the silence threshold too.

### When a run finishes

Its process exit wakes you.

```bash
node $ORCH run record S-1 --log .claude/orch/logs/S-1.jsonl
node $ORCH guard S-1
node $ORCH join S-1                          # merges it into the main line
node $ORCH check                             # the merge alone usually widens what can open
node $ORCH slot run ci -- <your test command>   # on the JOINED tree, beside the new round
node $ORCH land S-1 --sha <sha>
```

**`check` goes before the suite, not after it.** The merge is on `HEAD` the
moment `join` returns, so whatever only needed S-1 can be cut from it now — and
then the suite runs beside that work instead of in front of it. `join` says how
many steps it just freed.

### When several finish at once, join them as a batch

Twelve branches finishing together used to mean twelve full suite runs in series
through the slot, and the graph advanced at the rate of one of them.

```bash
node $ORCH join --batch S-1 S-2 S-3
node $ORCH slot run ci -- <your test command>       # once, over all three
node $ORCH land --batch S-1 S-2 S-3 --sha <sha>
```

Each branch merges in turn. One that conflicts is rolled back on its own and the
rest of the batch stands, so a single bad branch does not cost the others their
merge. Then one suite over the combined tree — which is the tree that will
actually exist, and strictly better coverage than three pairwise trees nobody
ever assembles.

**What it costs is attribution.** A red batch does not say which branch did it.
The order is recorded, and the red path is to reset to the base it prints and
re-join in halves. You pay that only when something is genuinely broken.

`run record` reads the log rather than asking what happened: what files were
written and by how much, which commands failed and what they printed, how much
transport trouble the run hit, and whether it answered at all. It then holds that
account against the launcher's status file and against the branch — see
[three witnesses](#6-run) — and exits non-zero if any of them dissents.

**Do not summarise a run into the record yourself.** That is the failure this
replaces. On the real build, 36 MB across 27 runs became 5,670 characters of
typed prose and a five-line ledger.

A file the step wrote but does not own is reported here, before `guard` runs, and
`guard` then separates the two things that used to come out as one sentence:

- **A file another live step owns is a breach.** Two agents wrote it and one of
  them should not have. `sendback`.
- **A file nobody owns is almost always a short `owns` list**, not a trespass —
  the step's own plan or its own proof command required it. `guard` prints the
  `step own` line for exactly those paths. Read the diff, then widen the step
  and guard again. Sending correct work back because the list was short costs a
  whole run and teaches the agent nothing.

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
textual merge produces. **Batching that suite is fine; skipping it is not.** It
is the only check that catches the failure mode this whole arrangement produces.

**When the joined tree goes red, the fix goes forward — it is not a reset.**
Because dependents open off a merge rather than off a landing, worktrees may
already be cut from the `HEAD` that carries it, and `git reset --hard` would
strand them. `sendback` names those worktrees when there are any, and says so.
Land the correction as a new commit on the step's branch and re-join.

Then loop: record, guard, join, `check`, open everything it names, verify, land.
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
node $ORCH step rm S-2.1.1 S-2.1.2      # cancel, and sever the edges into them
node $ORCH step reset 2.1               # every live step of one plan
```

Both refuse a step that has already gone out unless you say `--force`, because a
worktree and a branch outlive the record; when you do force one, they print the
`git worktree remove` line, which nothing here runs for you.

**Cancelling has to take the edges into a step out of its dependents' `needs`** —
a cancelled step never reaches the main line, so anything waiting on it would
wait for ever. Those edges are **severed, not dropped**: the record keeps them,
`doctor` lists them, and **recording that key again puts them back**.

That is not bookkeeping. Cancelling eight steps once stripped `needs` from every
survivor; re-refining brought the same keys back with nothing pointing at them,
and four steps were one `run open` away from building against a tree that held
none of the work they were written on top of. `step link` already refuses to
record half a graph for the same reason — `step rm` was doing it quietly.

If the cancelled work comes back under a *different* key, nothing can restore
the edge for you. `doctor` keeps naming the severed edge until you do:

```bash
node $ORCH step add < json     # the dependent, with the needs it should now have
```

Reach for `reset` when a plan is re-refined after its steps turn out wrong. The
alternative — editing `state.json` and appending to `events.jsonl` by hand — is
writing directly to the record this owns, and it is how a register ends up
disagreeing with itself.

## Running a step as a subagent instead

`runner use claude` is the ordinary way to build on Claude — one process per
step, launched and harvested like any other. A step can also run as a subagent
of this session: spawn it with the Agent tool and hand it
`.claude/orch/briefs/<key>.md`. That is worth doing only when the step needs
something this session has and a fresh process does not, because nothing
harvests a subagent's log — you write the record yourself:

```bash
node $ORCH run record S-1 --json /tmp/S-1-record.json
```

The record is the same shape either way — `{outcome, seconds, files, commands,
answer}` — so everything downstream is unchanged.

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

## What not to trade away for speed

Every one of these was earned from a specific failure, and each is load-bearing
for exactly the kind of round that gets wider.

- **Do not raise the two-steps-per-plan cap, and do not read it as a target.**
  It is the guard against an agent carving one plan into six to look thorough
  and losing the intent across the seams. Width comes from writing four plans,
  not from a refiner splitting one four ways. `map` is how you decide where to
  split; a person owns that call. The cap was 3 for a while, with a brief that
  asked for one step per disjoint file set — and since almost any plan's paths
  can be dealt into three piles, almost every plan was: eight plans came back as
  twenty-two steps, each part paying a worktree, a merge and a run for a gate
  that still passed or failed whole. `refine done` refuses a report above two,
  and refuses one at two whose parts write the same files and wait on nothing.
- **Do not skip the suite on the joined tree.** Batch it, run it beside the next
  round, but run it.
- **Do not put two step keys on one agent.** It reads like a saving and it is the
  opposite: two steps in one agent run one after the other, two agents run at
  once. It also breaks the chat address, the unit of merge and the run record,
  and none of the three complains.
- **Do not narrow `owns` to make a step look independent.** Two steps owning one
  file is not a reason to wait — they reconcile at the merge — so a narrow list
  buys nothing and pays for itself as a `guard` failure on work that was right.
  `step own` widens one without re-refining its plan.
- **Do not reach for `serialises` to be careful.** It is the one thing that
  really does serialise a round: every step naming a point runs alone against
  every other step naming it. Four points spread across a plan's steps is a plan
  that runs one step at a time whatever else is true. A point is only for what
  git merges *cleanly and wrongly*. `doctor` prices every one that gates three or
  more steps.
- **Do not let a thin slice ship a thin brief.** The cost of a wider round is
  that each agent sees less of the whole. Spend some of what you save on
  context. `builtOn` is where that spend goes: it is the only part of the brief
  that says what already exists, and a brief whose **What is already there** says
  nothing was recorded is one an agent will fill in by guessing.
- **Do not skip `doctor` because the round got wide.** A wide round is where two
  spellings of one serialisation point cost the most.

## Gotchas

- **A dependency is met at `join`, not at `land`.** The merge is on the main
  checkout's `HEAD` by then and worktrees are cut from that `HEAD`, so the code
  is already there; landing only records that a suite proved it. The consequence
  is the forward-commit rule above. `CURSOR_ORCH_OPEN_AT=land` restores the old
  behaviour if you want the proof before the next hop.
- **Landing stays in order even though opening does not.** `land` still refuses
  while anything under a step is merely merged, because landing is the record of
  proof and a step cannot claim a suite covered work that never went through one.
- **A run's liveness is its log, not `ps`.** The process does not show up under
  `agent`. A growing log is what alive looks like; the elapsed stamp on each
  streamed line says the same thing without asking. `vitals` is that question
  asked of the whole round at once — but only when something is armed to ask it.
  A round with no `vitals --wait` out is a round nobody is looking at, and the
  failures it catches are exactly the ones that never wake you by themselves.
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
- **A launcher line is good once, on Claude.** The session id `run open` mints
  is claimed by the first run, and a second run on the same line is refused —
  `Session ID … is already in use`. That is the right answer to re-running a
  finished step by hand: what you want there is `sendback`, which resumes the
  conversation instead of trying to start it twice.
- **A chat is never shared between steps.** `run open` mints one per step.
  Reusing an address is the same defect as stacking two steps into one agent, and
  it arrives quietly.
- **Expect ~5 KB of jsonl for a trivial run and 0.7–3.5 MB for real work.** A
  ten-plan act is roughly 15 MB, and nothing prunes `.claude/orch/logs/`.
- **Worktrees are named after the project**, beside it. A bare `wt-<key>` in the
  parent directory collides with every other project doing the same thing.
- **A run is not finished until it has committed.** `run record` checks the
  branch, not just the log: no commit on it, or tracked changes still sitting in
  the worktree, and the run is not recorded as passing however well its log
  reads. Neither is a reason to restart it — `sendback`.
- **Agents copy the commit idiom they see in `git log`.** The merges this tool
  writes are the loudest thing there, so a subject that is only a bookkeeping
  word and a key gets copied onto their own commits, where it describes nothing.
  The brief says not to, the merge message is now shaped like a merge, and
  `run record` names any commit that slipped through with the `--amend` line.
- **Cancelling severs an edge; it does not forget it.** `step rm` has to take a
  cancelled step out of its dependents' `needs`, and recording that key again
  puts the edge back. `doctor` names any still lying severed.
- **`step own` exists so a short `owns` list is not a re-refine.** The registry
  a step adds one line to and the fixture its proof command regenerates are not
  in any plan; widening the step is the fix, not sending the work back.
