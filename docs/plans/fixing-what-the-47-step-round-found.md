# Fixing what the 47-step round found

A round of twelve plans and 47 steps was driven through `claude-cursor` on
2026-09-03 and reported nine defects. All nine are real. Two of them destroy work
without saying anything, and those are the whole reason this plan is ordered the
way it is.

Everything here is in `claude-cursor/` — `orchestrate.mjs` (1,165 lines),
`scripts/models.mjs`, `scripts/run.sh`, `models.json`, `SKILL.md`. No build, no
dependencies. `test.mjs` already drives `orchestrate.mjs` end to end in four
groups (from line 2930), so every fix below has somewhere to be proved.

## Built, 2026-09-03

All ten are fixed and the suite covers each of them (705 checks, green). The
three Wave 0 decisions were taken as recommended: **D1(a)** the agent keys from
its own plan and `putStep` refuses a key another plan holds; **D2(a)** the
vocabulary is `claude-cursor/points.json`, extended by `CURSOR_ORCH_POINTS`;
**D3(a)** `step rm` and `step reset` cancel, never delete. Two things were added
that this plan did not name: `run open` and the ladder now share one canonical
model name, and a plan is found by either slash, because a record written on
Windows holds backslashes and every caller types the other one.

What is below is the plan as written, kept for the reasoning behind each change.

## The verdicts

| # | What was reported | Verdict | Where it lives |
|---|---|---|---|
| 1 | `refine done` silently destroys steps on a key collision | **real** | `orchestrate.mjs:200` `putStep`, `:49` `depOf` |
| 2 | Model verification rejects good work intermittently | **real** | `scripts/models.mjs:47` `verdict`, `run.sh:126` |
| 3 | `models sync` cannot parse the CLI, and crashes doing it | **real, two defects** | `models.mjs:57` `listModels`, `orchestrate.mjs:387` |
| 4 | Nothing catches synonyms in `serialises` | **real** | `orchestrate.mjs:78` `normPoint`, `:1013` doctor |
| 5 | `refine done` accepts `needs` that are not steps | **real** | `orchestrate.mjs:171` `stepProblems` |
| 6 | doctor blocks a greenfield build on directories the steps create | **real** | `orchestrate.mjs:966` |
| 7 | No way to remove a step or reset a round | **real** | `orchestrate.mjs:285` — `step` takes only `add` |
| 8 | Backgrounded runs always report exit code −1 | **real, not ours** | harness behaviour; `run.sh` gives it nothing else to read |
| 9 | Refining rewrites plans with no diff shown | **real** | `orchestrate.mjs:463` `refine done` |
| 10 | *(found while checking)* `CMDS.doctor` is defined twice | **real, dead code** | `orchestrate.mjs:871` overwritten by `:951` |

### Item 1 in detail, because it is the worst one

```js
function putStep(s, it) {
  const existing = depOf(s, it.key);        // key alone. No plan.
  ...
  if (existing) Object.assign(existing, it); else s.tasks.push(merged);
```

`depOf` matches on `key` and nothing else, and `Object.assign` overwrites
`title`, `owns`, `serialises`, `verify` **and `plan`** in place. Three plans each
emitting `S-1…S-5` end as five steps, not fifteen, and `refine done` prints
`✓ 5 step(s)` all three times because it counts what the report named, never what
the register gained. The brief template teaches the colliding shape itself
(`orchestrate.mjs:447`: `"key": "S-1"`).

### Item 2, and one correction to the report

The mechanism is confirmed: `verdict()` compares one string by exact equality,
and `run.sh:126` exits 1 on mismatch, so a run that did the work is thrown away
over its own display name.

The report says `models.json`'s note asserts the runtime always reports
`Cursor Grok 4.6 High`. The table in this repo says the opposite — rank 4 carries
`"shown": "Cursor Grok 4.6"`, and the note says that short name is the trap. So
the round ran against a differently-edited table (a synced copy, or one pointed
at by `CURSOR_ORCH_MODELS`). This does not weaken the finding: a runtime that
answers with either spelling breaks exact equality in one direction or the other,
whichever single string the table holds. The fix is to stop making one string the
identity.

### Item 6, and why item 10 matters

The live doctor (`:951`) treats a missing directory as a hard problem:

```js
const dir = path.dirname(path.resolve(CWD, o));
if (!fs.existsSync(dir)) probs.push(`owns "${o}", whose directory does not exist`);
```

The **dead** doctor at `:871` — shadowed since it was written — treated the same
condition as a warning, and only when neither the file nor its directory existed.
The gentler behaviour was written, then lost to a duplicate definition. That is
why 31 of 47 steps failed on a from-scratch build.

### Item 8 is the harness, and we still owe an answer

`bash run.sh … &` detaching and losing its status is not something this code can
change. What it can change: `run.sh` currently leaves nothing but a log to read.
A status file it writes on the way out turns "exit code unknown" into a fact on
disk.

---

## Wave 0 — decisions, before anything is built

Nothing below is filled in by judgement.

**D1. The key scheme.** Keys must be unique across plans. Two ways:

- **(a) The agent namespaces them** — the brief asks for `S-017.1`, `S-017.2`
  derived from the plan's own id, and `putStep` refuses a key already held by a
  different plan. *Recommended.* Keys stay short, readable and stable, and the
  refusal is a real gate rather than a convention.
- (b) The driver namespaces them — `refine done` rewrites `S-1` to
  `<plan-slug>/S-1` on record. Never collides, but every key in every brief,
  chat name, worktree and branch grows a slug, and keys the user types get long.

Either way `putStep` refuses cross-plan reuse. The question is only who writes
the prefix.

**D2. Where the canonical serialisation vocabulary lives.**

- **(a) A file beside `models.json`** — `points.json`, shipped with the common
  ones (migration head, lockfile, workspace list, schema registry, CI workflow,
  generated client), extended per project by `CURSOR_ORCH_POINTS`. *Recommended*
  — same shape as the ladder, same reasoning: it is data, not code.
- (b) Hardcoded in the brief text. Cheaper now, and wrong for the first project
  whose shared invariant is not on the list.

**D3. What `step rm` does to the record.**

- **(a) Cancel, never delete** — `step rm <key>` sets `status: cancelled`;
  `step reset <plan>` cancels every step of that plan that has not opened. The
  event log keeps everything, which is what it is for. *Recommended.*
- (b) Hard delete from `state.json`, with the event recording the removal.
  Leaves a cleaner board, and makes `events.jsonl` and `state.json` disagree
  about steps that once existed.

An open or landed step needs `--force` under either answer.

---

## Wave 1 — the silent loss (items 1, 5)

Nothing else starts until this lands.

**1.1 `putStep` refuses a stolen key.** In `stepProblems`, when `existing` is
present and `existing.plan` is set and `it.plan` is set and they differ, return
`key "S-1" already belongs to <plan>` instead of merging. Same gate for
`step add` and `refine done` — they share the function.

**1.2 `refine done` records all or nothing.** Validate every step in the report
first, then write. Today the loop calls `putStep` per step and reports the
failures afterwards, so a report with one bad step has already half-registered.

**1.3 `refine done` counts the register, not the report.** Print
`✓ 5 step(s) from <plan>: S-1 … (47 in the register)`. The count that would have
caught this round is the total, and it is one line.

**1.4 The brief stops teaching the bug.** `orchestrate.mjs:447`: the example key
becomes the namespaced form per D1, with one sentence saying keys are unique
across every plan in the round and a report reusing one is refused.

**1.5 `needs` is checked at record time.** In `refine done`, a `needs` entry must
name a step that exists already or a step named elsewhere in the same report.
Anything else is refused with the plan ids listed as the likely mistake — the
round produced 24 entries pointing at plan ids, so name that case explicitly.

**1.6 `load` reads the plan's `requires:` header** and stores it on the plan
record; `refine brief` prints it: *this plan requires 2.3 and 1.6 — steps of
those plans must land first; name their keys in `needs`.* Cross-plan ordering was
absent this round because nothing ever showed the agent the header.

*Proof:* three reports each naming `S-1`; the second is refused, the register
holds all steps from the first, and `board` shows both plans. A report whose
`needs` names a plan id is refused with a message naming that entry.

## Wave 2 — the synonyms (item 4)

Six spellings of the migration head across eleven steps is a merge that git
performs cleanly and gets wrong. This is the failure the whole `serialises`
mechanism exists to prevent.

**2.1 The vocabulary is handed to the agent.** `refine brief` prints the list
from D2 and says: use these exact words for anything on the list; invent a name
only for something genuinely not on it, and if you invent one, spell it the way
the plan spells it.

**2.2 doctor flags probable synonyms.** Compare every distinct point against
every other after normalising (lowercase, split on non-letters, drop `the`, `a`,
`head`, `list`, `registry` as bare words). Two points are *probably the same*
when one token set contains the other, or they share every token but one. Report
as a hard problem, not a warning, listing every step on each spelling:

```
✗ 2 serialisation point(s) look like the same thing spelled differently:
    "drizzle-migration-head" (S-017.1, S-021.2)  ≈  "drizzle-journal-head" (S-013.1)
    Pick one spelling and correct the others, or say why they are different things.
```

**2.3 The lone-point warning gets quieter.** It fired on 24 legitimate singletons
this round and buried the signal. Keep it, but print it only for points that have
a probable synonym elsewhere, or behind `doctor --all`.

*Proof:* a register with `drizzle-migration-head` and `drizzle-journal-head` on
two steps exits 1 and names both; one with `contracts-index` and `rate-limit`
does not.

## Wave 3 — model identity (items 2, 3)

One story: the display name is not an identity.

**3.1 `shown` becomes `accepts`.** Each ladder row carries a list of names the
runtime is known to answer with — rank 4 gets both `Cursor Grok 4.6` and
`Cursor Grok 4.6 High`. `verdict()` passes when `got` equals any entry exactly.
Prefix and substring matching stay forbidden, and the comment saying why stays.
`resolve` prints the first entry as the canonical one. Keep reading `shown` as a
one-element `accepts` so an old table still works.

**3.2 `verdict` says what to do when it fails.** Name the row, list its accepted
spellings, and point at `models sync`.

**3.3 `listModels` strips ANSI before matching** — `line.replace(/\x1b\[[0-9;]*m/g, '')`
before the regex — and when nothing matches, print the first five raw lines so
the next person can see what the CLI actually emitted.

**3.4 `sync` unions rather than replaces.** A live name not already in `accepts`
is added; nothing is dropped. That is what makes a table survive a runtime that
answers two ways, and it is why 3.1 has to land first.

**3.5 `CMDS.models` stops throwing a stack trace.** Wrap the `execFileSync` in
`orchestrate.mjs:387` in try/catch, write the child's stdout/stderr through, and
exit with the child's code.

**3.6 The note in `models.json` is rewritten** to say what is now true: rank 4 has
been seen answering with and without the effort word, both are accepted, prefix
matching is still forbidden.

*Proof:* `verify --want` passes for both rank-4 spellings and still fails for
`Cursor Grok 4.6 Fast` and for rank 5's name; `listModels` parses a fixture with
colour codes in it; `models sync` against a stub `agent` exits 2 with `✗` and no
stack trace.

## Wave 4 — the round is not editable (items 6, 7, 10)

**4.1 Delete the dead doctor** at `orchestrate.mjs:871`, keeping the two checks it
has that the live one lacks: plan drift against `p.sha`, and the `owns nothing`
warning.

**4.2 A missing directory is a warning when the step creates it.** It stays a
problem only when no ancestor of the path exists inside the repo at all — that
catches `pakcages/server/...` while letting a greenfield
`packages/server/src/features/base/x.ts` through with a note. Twenty `.gitkeep`
commits to get a green report is a doctor nobody will run.

**4.3 `step rm <key>` and `step reset <plan>`**, per D3, both refusing open or
landed steps without `--force`, both appending an event. `step rm` also drops the
key from every other step's `needs` and says which steps it changed.

*Proof:* a round of five steps, `step reset docs/plans/a.md` leaves the other
plan's steps untouched and `board` shows the rest cancelled; `step rm` on an open
step is refused; doctor is green on a step owning a file three directories deep
that do not exist yet, and red on one whose repo-root segment is a typo.

## Wave 5 — the papercuts (items 8, 9)

**5.1 `run.sh` writes a status file.** On every exit path,
`.claude/orch/runs/<key>.status` gets one line: `exit <code> <outcome> <log>`. A
backgrounded run that comes back as −1 is then readable as a fact, and `SKILL.md`
says to read that file rather than trusting a detached exit code.

**5.2 `refine done` prints a diffstat** for the plan it just refined — the plan is
tracked, so `git diff --stat -- <plan>` is the whole change — and the refine brief
gains one line: *repo-level checks may grep your prose; if you must write a
forbidden spelling, quote it as forbidden.* S-015 broke `check-seams.sh` this way.

*Proof:* `refine done` on a plan the stub agent rewrote prints `+126/−90`.

---

## What is deliberately not changed

- **Exact equality on model names.** 197 prefix pairs across the account's 214
  models is the reason. Wave 3 widens *what* is accepted, never *how* it matches.
- **Shared files still do not block a step from opening.** Two steps owning one
  file reconciling at the merge is the design, and this round produced no
  evidence against it — `ALL_SCHEMAS` claimed by eight steps is an argument for
  Wave 2, not against parallel opens.
- **The event log stays append-only.** D3(a) keeps it that way.

## Order, and why

Wave 1 and Wave 2 first: both produce damage nothing reports, and Wave 1's key
refusal is what makes any later count trustworthy. Wave 3 next, since a rejected
run costs a whole agent's work. Waves 4 and 5 are time, not correctness.

Waves 1, 2, 4 and 5 all touch `orchestrate.mjs`. Under this skill's own rule that
is one worktree at a time, in this order, on one branch. Wave 3 is the exception —
it is `models.mjs`, `models.json` and five lines of `orchestrate.mjs` — and can
run beside Wave 1 or 2 if it is worth a second agent.
