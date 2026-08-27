# Closing the instruction gaps

A plan to fix eight defects found by running the skill, not by reading it. Every one was
re-tested against `driver.mjs` at `cfe3c2c` before it was written down here, and the
verdicts below say what the test did, not what the report claimed.

The common thread is stated plainly, because it decides the shape of the work: **the
skill's strongest instructions are safe only under assumptions it never states.** "Use
the printed line, do not retype the paths." "Run `brief --all` after any correction."
"The check-in message is the only reliable way to get the address." Each is correct in
the case it was written for, and each has a narrow neighbouring case where following it
faithfully does damage. In every instance the damage was caught by something else —
`doctor`, an agent's own diff, a second look — rather than by the instruction.

So this is not eight unrelated bugs. It is one habit: an instruction that is confident
where the code is conditional. Six of the eight fixes are in the code; all eight need a
sentence in `SKILL.md` that the code can no longer contradict.

## Status — all eight built, on `fix/instruction-gaps`

Every wave below is implemented and verified. The suite is **342 checks, all green** (273
before; 69 added). The coverage floor passes. Each new check was watched failing against
the driver as it stood at `cfe3c2c`: **47 of the 69 go red there**, which is what makes
them guards rather than decoration — the other 22 are anchors that must pass in both.

Wave 0 was settled before building: **D1** add `question` to the outbound kinds *and* wire
it into `outstanding`; **D4** keep `covers` and add `newly`. D2, D3 and D5 went with the
recommendations as written.

One correction to what this plan first assumed: `plan mv` came out closer to sixty lines
as predicted, but `load` also gained an automatic repoint for the one unambiguous case
(old path gone, content byte-identical), because that is the case the workflow actually
produces and making the operator remember a second command for it would have left the
same trap one step further along.

## Is it feasible

Yes, and it is smaller than the last round.

- **One file, no dependencies.** Everything but the documentation is `driver.mjs`, 3,966
  lines of plain Node ESM. No build, no framework.
- **The pieces already exist.** Fix 8 needs `git worktree list` parsing and a read of
  `~/.claude/sessions/*.json`; the driver already does both, at `worktreeFor()`
  (`driver.mjs:3063`) and `cmdWhoami()` (`driver.mjs:1771`). They have never been used
  together. Fix 1 needs a collision check that already exists twenty lines above the
  branch that skips it.
- **There is a live regression suite.** `node test.mjs` is 273 checks, all green at
  `cfe3c2c`. That is the floor every wave here has to clear.
- **The fixes are small.** Six are under twenty lines. The largest, `plan mv`, is around
  sixty because it has to migrate three back-references, not one.

### The structural caveat, again

Every fix touches `driver.mjs`. Under the skill's own rule — same file means one waits —
these cannot be parallel chips. **Sequential waves on one branch.** If you want agents on
it, hand out one wave at a time and merge before the next. Do not try to widen `owns` to
make them run together; that is precisely defect 1.

---

## The verdicts

Seven confirmed as reported. One is real but narrower than reported, and one confirmed
defect is worse than reported. Both corrections are below, because a plan built on the
original wording would fix the wrong half.

| # | Claim | Verdict |
|---|---|---|
| 1 | `task add` skips the ownership check on update | **Confirmed** |
| 2 | `preflight done` merges prose into `owns` | **Confirmed, and worse** |
| 3 | No way to amend an owed item | **Confirmed** |
| 4 | `say` and `heard` take different kinds | **Confirmed** |
| 5 | `load` appends when a plan is renamed | **Confirmed** |
| 6 | Checkpoints refile against wave 0 | **Confirmed** |
| 7 | `brief --all` moves the register under a running agent | **Real, narrower** |
| 8 | The check-in message cannot identify the builder | **Confirmed** |

**Where 2 is worse than reported.** The report says `preflight check` "reds on all of
them, they can never match `owns`". It reds only *before* the printed line is run. After
the prose is injected, the prose sits in `owns` and matches itself exactly, so
`preflight check` goes **green** — and `doctor` never mentions `owns` entries that are
not paths at all. The pollution does not stay loud; it goes quiet. That is the reason
this is Wave 1 and not Wave 3.

**Where 7 is narrower than reported.** `brief --all` does rewrite briefs for `running`
tasks — it skips only `landed` and `cancelled` (`driver.mjs:2083`). But an unchanged
brief writes nothing and does not commit (`driver.mjs:2044-2049`), so it does **not**
churn the register under agents whose own fields did not move; a run against an untouched
running task left `briefSha` and `briefAt` byte-identical. It also already prints
`changed: <key> → any chip already holding it is out of date`. The real gap is that
`SKILL.md:714` says "run it after any correction to the record" with no word about
timing, and nothing tells the *agent* its brief moved. So this is a documentation fix
with a small driver improvement, not the reverse.

---

## Wave 0 — decisions, before anything is built

Five places where the fix depends on an intent the code cannot tell me. Each has a
recommendation. None should be settled by judgement mid-build.

**D1. Should `say --kind question` exist?**
`OUT_KINDS` and `IN_KINDS` (`driver.mjs:3494-3495`) are disjoint on `question`. The
asymmetry may be deliberate: an inbound question puts *you* in debt, and `outstanding`
tracks that, whereas nothing tracks a chip owing *you* an answer.
*Recommend: add it.* An orchestrator asking a chip something is a real event that
currently has to be logged as `note` and so disappears from `outstanding`. Add
`question` to `OUT_KINDS` and have it mark the chip as owing a reply, cleared by any
inbound `report`, `reply` or `blocked`. Keep the vocabularies otherwise different —
`say --kind blocked` and `heard --kind hold` should stay impossible — and make both
error messages print *both* lists so the difference is legible at the point of failure.

**D2. What should `preflight done` do with a `path` that is prose?**
*Recommend: refuse the whole report, and name the offending entries.* This matches what
the command already does for every other malformation ("send it back rather than fixing
it here"). Accepting-and-quarantining would leave a half-usable pre-flight, and a
half-usable pre-flight is what `preflight check` then goes green on.

**D3. May `owed edit` amend a settled item?**
*Recommend: yes, with the same amendment trail as an open one.* The complaint is being
forced into supersede-and-close; refusing on `done` reintroduces it for the case where
you learn a settled claim was wrong. Guard it with the trail, not with a refusal.

**D4. Should a checkpoint's `covers` change meaning?**
A CI run on merged main genuinely does re-test everything landed before it, so `covers`
is not false — it is uninformative, and repeated four times it reads as a distortion.
*Recommend: leave `covers` alone and add `newly`* — the landed tasks in that wave not
already covered by a green checkpoint. Print `newly` first. Changing `covers` would make
every existing checkpoint on every register retroactively mean something else.

**D5. Should `agent` refuse a name that is not in the task's worktree, or warn?**
*Recommend: refuse, with `--force` and the candidate list printed.* Recording the wrong
address is silent until a release goes nowhere, and the failure surfaces long after the
cause. But the lookup depends on `~/.claude/sessions` and on the worktree being
registered, so there has to be a way past it when the lookup itself is what is broken.

---

## Wave 1 — the two that damage the record silently

Defects 1 and 2. These are one wave because they compose: the line defect 2 prints is an
*update*, and the update path is exactly what defect 1 does not check. Fixing either
alone leaves the pair live.

### 1.1 Re-check ownership on the update path

`driver.mjs:1401` — `if (at >= 0) continue;` skips the collision check for every update.
Confirmed live: with `0.12.I` open and owning `.github/workflows/ci.yml`, an update
giving `0.12.F` the same path was accepted with `updated 0.12.F: owns` and exit 0.
`graph` then reported `✓ Nothing among them clashes` once they were in different rounds —
which is correct and documented behaviour (`SKILL.md:1118-1120`), not a second bug. Only
`doctor` caught it, exit 1.

Check **only the paths an update adds**, never the ones it already had. That keeps a
register with a pre-existing collision usable — the reason the check was skipped in the
first place — while refusing the new claim, which is the thing worth refusing.

There is a subtlety that has to be got right, and it is the reason this is not a
three-line change. The batch-internal check compares against `plans[m].it.owns`, the
*new* owns, while the against-register check reads `tasks(r)`, the *old* owns. So
narrowing `0.12.I` and widening `0.12.F` in one batch — the correct way to hand a file
over — would be refused against `0.12.I`'s stale entry. Compute effective ownership
first:

```js
// what each open task will own once this batch applies
const after = new Map();
for (const t of tasks(r)) if (contender(t)) after.set(t.key, [...(t.owns || [])]);
for (const { it } of plans) if (it.owns !== undefined) after.set(it.key, [...it.owns]);
```

Then, for a create, check every path; for an update, check `it.owns.filter(o => !had.has(o))`
where `had` is the task's current `owns`. Both against `after`, skipping the task's own
key. Lift the existing clash loop into a helper so the two callers cannot drift.

An update that only narrows or reorders must stay silent, and an update that does not
mention `owns` at all must not be treated as an ownership change.

### 1.2 `preflight done` must require paths to be paths

`driver.mjs:2167` validates `typeof m.path === 'string' && m.path.trim()` and nothing
else. Confirmed live: a report whose `missing[].path` values were
`apps/api/Dockerfile:7 — ENV PATH="…" must be set` and `the verify list itself` was
accepted, and both went verbatim into the printed `task add` line under the heading
"do not retype it".

Note for the record: a prior session logged that "`preflight done` does validate path
format". It does not. It validates that the field is a non-empty string.

Add a shape check, and reject the report naming each bad entry. Reject an entry that
carries a `:NN` line suffix (`owns` is whole files), that contains an em-dash or
double-dash clause, that contains quote, `$` or `=` characters, or that reads as a
sentence rather than a path. A path that exists on disk should pass regardless — that is
the one unambiguous signal available, and it costs a `statSync`.

**Then fix the cause, not just the symptom.** The brief template
(`cmdPreflightBrief`, `driver.mjs:2115`) never says what `path` is. Add one line to the
generated brief: `path` is a bare repository-relative file path — no line numbers, no
prose, no explanation; the explanation goes in `why`. Seventeen of nineteen entries came
back as prose because nothing ever asked for anything else.

### 1.3 `doctor` should notice non-paths in `owns`

Cheap, and it is the backstop that would have caught this. Confirmed live: with three
prose strings sitting in `0.12.F`'s `owns`, `doctor` reported only the unrelated
`ci.yml` collision and said nothing about them. Report any `owns` entry that fails the
same shape check, and any that does not exist on disk and has no plausible parent
directory.

### Tests for Wave 1

- Update adding an owned path is refused; the message names both tasks.
- Update narrowing, reordering, or not mentioning `owns` is accepted silently.
- Narrow-and-widen in one batch is accepted — the hand-over case.
- A pre-existing collision does not block an unrelated update to either task.
- `preflight done` refuses a prose `path` and names it; a real path still passes.
- A `path` that exists on disk passes even if oddly shaped.
- The generated pre-flight brief contains the bare-path instruction.
- `doctor` reports a non-path in `owns`.

---

## Wave 2 — correcting a claim that turned out wrong

Defects 3 and 5. One wave because they are the same shape: the register recorded
something, it turned out to be wrong, and there is no way to say so.

### 2.1 `owed edit`

`cmdOwed` (`driver.mjs:2480-2524`) dispatches `add|assign|done|list` and nothing else.
Confirmed live: `owed edit`, `owed set` and the generic `set` on an owed id are all
rejected. Only `assign` changes anything, and only `to`.

Add `owed edit <id> [--what …] [--why …] [--window …] [--load-bearing|--not-load-bearing]`,
requiring `--why-changed "…"`.

The requirement is the point. The objection to supersede-and-close was that a churned
record is one nobody trusts — so an amendment must be *visible as an amendment*, not a
silent overwrite that leaves the record looking pristine. Push the prior values onto an
`amendments` array with the reason and a timestamp, and have `owed list` print
`(amended 2×)` beside the item. Three corrections then read as one item that was hard to
pin down, which is true, instead of four items that appeared and vanished, which is not.

Demanding a reason for a correction is what this codebase already does everywhere else:
`--status skipped` needs `--why`, `--status red` needs `--why`.

### 2.2 Repointing a renamed plan

`cmdLoad` matches by path (`driver.mjs:656`) and appends when it does not match.
Confirmed live: renaming `plans/a.md` to `plans/a-DONE.md` and re-running `load` gave two
entries for one file. `load` is the only writer to `reg.plans` anywhere in the driver, so
there is no way to undo it.

The sharpest part is that `scan`'s own error message says *"Re-run `load` with its new
path"* — and doing that is what produces the duplicate. The instruction causes the state
it is diagnosing. This project's settled rule is that a plan is renamed when every piece
lands, so the workflow guarantees the paths go stale, and `scan` then refuses outright.

Add `plan mv <old> <new>` and `plan rm <path>` under the existing `SUB_COMMANDS`
mechanism. `plan mv` must migrate all three back-references — the `plans[]` entry,
`gaps[].plan`, and `tasks[].plan` — or the rename orphans the gaps instead of the plan.
`plan rm` should refuse while anything still references the path, unless forced.

Then make `load` handle the unambiguous case itself: if a registered path is gone from
disk and an incoming file has an identical sha, that is a rename — repoint it and say so
rather than appending. And rewrite `scan`'s error to point at `plan mv`.

### Tests for Wave 2

- `owed edit` changes a field and records the prior value; `owed list` shows the count.
- `owed edit` without `--why-changed` is refused.
- `owed edit` works on a settled item (per D3) and stamps it.
- `plan mv` repoints the entry and migrates gaps and tasks; `scan` then runs.
- `plan rm` refuses while a gap or task references the plan.
- `load` on a renamed file with identical content repoints instead of appending.
- `scan`'s error names `plan mv`.

---

## Wave 3 — what a checkpoint actually proves

Defect 6. `waves()` (`driver.mjs:1332`) recomputes membership from `needs` alone on every
call, so a task added mid-run with no `needs` joins wave 0 retroactively. `cmdCi:2855`
then sets `covers` to every landed task in the wave.

Confirmed live, and it compounds: three tasks landed and were recorded as `c01`. Adding
`sweep-f` mid-run put it in round 1; when it landed, `c02` reported
`covers 0.10a 0.11a sweep-a sweep-f`. Adding `sweep-g` gave `c03` covering all five, and
printed `Round 2 may now be opened` at the end of what was a single late fix. Four
checkpoints, each claiming a whole round.

Per D4, keep `covers` and add `newly`:

```js
const proven = new Set(checkpoints(r).filter(c => c.status === 'green')
                                     .flatMap(c => c.covers || []));
const newly = covers.filter(k => !proven.has(k));
```

Print `newly` first and the rest as `(N already proven by c01, c02)`. Show both in
`ci list`. `unprovenLanded` keeps reading `covers`, so nothing about which work counts as
proven changes.

Then warn at the point the distortion is created. When `task add` creates a task with no
`needs` and wave 0 already contains landed work, say so:

> `sweep-f` has no `needs`, so it joins round 1 — which already has landed work. Its
> checkpoint will re-cover it. Give it `needs` naming the last landed task if it should
> be a round of its own.

That is a warning, not a refusal. Adding work to an open round is legitimate; being
unable to tell afterwards is not.

### Tests for Wave 3

- A checkpoint after a late wave-0 task reports `newly` as that task alone.
- `covers` is unchanged, and `unprovenLanded` still agrees with it.
- `ci list` shows both.
- `task add` warns on a no-`needs` task joining a wave with landed work, and stays exit 0.
- No warning when the wave has nothing landed yet.

---

## Wave 4 — addressing, and briefs that move

Defects 4, 7 and 8. All three are the message layer, and all three are mostly `SKILL.md`.

### 4.1 The two kind vocabularies

Per D1: add `question` to `OUT_KINDS`; make both error messages print both lists; wire
`say --kind question` into `outstanding` as a debt the chip owes you.

Confirmed live: `heard --kind question` succeeds, `say --kind question` exits 2 with
`kind must be one of: release, reply, sendback, note, hold, announce`. `SKILL.md` never
lists either vocabulary — it shows `heard --kind question` and `say --kind reply` two
lines apart at `SKILL.md:170-171`, from which symmetry is the only reasonable inference.
Document both lists, and say which direction each belongs to.

### 4.2 `brief --all` and snapshots

Per the correction above, the driver behaves better than reported and the instruction is
what needs work. `SKILL.md:714` currently reads:

> `brief --all` rewrites every live brief at once and names which changed — run it after
> any correction to the record.

Add the condition it assumes: a rewrite moves `briefSha` and `briefAt` under any agent
currently holding that brief, so an agent taking a register snapshot cannot reproduce its
own copy afterwards. A snapshot has to be the last thing before its commit. That was
learned once, the hard way, by an agent that diagnosed its orchestrator; it belongs in
the skill and not in one agent's note.

Two small driver changes to match. When a rewritten task has an address recorded, name
it, so the line says who to message rather than that somebody should be messaged. And add
`brief --all --dry-run`, so "what would this disturb" is answerable without disturbing it.

### 4.3 The check-in address

`SKILL.md:1108` states:

> The check-in message is the only reliable way to get it

The brief dictates the exact sentence — `> {key} checking in. I am up and I have read my
brief.` (`driver.mjs:1882`) — with no unique token in it. Two senders produce byte-
identical messages, and here every chip produced two: the builder, and a Claude-Mem
observer echoing it verbatim. At the message layer they are indistinguishable, and
`cmdAgent` (`driver.mjs:2972`) records whatever `--name` it is given with no validation
at all. A defect was opened on the first occurrence before the cause was understood.

The reliable discriminator is which session is in the task's worktree — and both halves
of that lookup are already in this file. `worktreeFor()` (`driver.mjs:3063`) maps a
branch to a worktree through `git worktree list --porcelain`. `cmdWhoami()`
(`driver.mjs:1771`) reads `~/.claude/sessions/*.json`, whose records carry `name`,
`sessionId` and `cwd`. They have never been called together.

Have `agent` do it: resolve the worktree, find the sessions whose `cwd` is inside it, and
check the given name against them. Per D5, refuse when it is not among them, print the
candidates, and accept `--force`. When the lookup cannot run — no git, no session
registry, no worktree recorded — say so and accept the name, because an unavailable check
must not become a blocked run.

Then correct the sentence in `SKILL.md`: the check-in tells you an address is live; the
worktree tells you whose. Say that an echoed check-in is a thing that happens, so the
next person does not spend a defect finding out.

### Tests for Wave 4

- `say --kind question` is accepted and shows in `outstanding`; an inbound reply clears it.
- `say --kind blocked` and `heard --kind hold` stay refused, and both errors print both lists.
- `brief --all` names the agent address on a changed running task.
- `brief --all --dry-run` writes nothing and changes no `briefSha`.
- `agent` refuses a name absent from the worktree's sessions and lists the candidates.
- `agent --force` accepts it.
- `agent` accepts without complaint when the lookup cannot run.

---

## Order, and why

1. **Wave 1** first: it is the only pair that corrupts the record while looking clean,
   and the corruption goes quiet once injected rather than staying loud.
2. **Wave 2** next: it is self-contained, and `plan mv` unblocks running `render` and
   `scan` again, which is currently avoided rather than fixed.
3. **Wave 3**: reporting only. Nothing depends on it, and nothing it touches is load-bearing.
4. **Wave 4** last: two of its three parts are documentation, and the third depends on
   nothing above it.

`node test.mjs` must be 273 green before Wave 1 starts and green at every wave boundary.
Each wave adds its own checks; a check nobody has watched fail is not a check, so write
each one against the current driver and see it red before fixing.

## What this plan does not cover

- **Whether `graph` should look across rounds.** It should not. Different rounds branch
  from a main that already has the earlier work, so a shared file is a sequential edit —
  `SKILL.md:1118-1120` says so deliberately. Defect 1 is the update path in `task add`,
  not `graph`'s scope, and widening `graph` would make every legitimate hand-over red.
- **The `covers` semantics of existing checkpoints.** Per D4 they keep their meaning.
- **Anything about the observer echoing check-ins.** That is the observing tool's
  behaviour, not this skill's. What is in scope is that this skill claims a discriminator
  it does not have, and has a better one already sitting unused in its own source.
