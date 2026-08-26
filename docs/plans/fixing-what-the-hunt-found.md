# Fixing what the bug hunt found

A plan to close the 116 findings from the audit of 2026-08-26, ordered so that each
wave can be proved before the next one exists.

## Is it feasible

Yes. Four things make it so:

- **One file, no dependencies.** `driver.mjs` is 3,284 lines of plain Node ESM. There is
  no build, no framework, no upgrade path to negotiate.
- **The fixes are small.** Most are between one and fifteen lines, local to a single
  function. The largest single change (the argument parser) is under sixty.
- **There is a real regression corpus.** The recorded LMS_v2 run — 387 events, 434
  messages, 55 tasks — is the strongest asset here. `verify` passing on a frozen copy of
  it is a real check, not a synthetic one.
- **The defects cluster.** 116 findings collapse to roughly 45 distinct changes, because
  many are the same root cause seen from different commands.

### The one structural caveat

**This work cannot be parallelised the way the skill itself dispatches work.** 3,284 of
the 5,205 tracked lines are in `driver.mjs`, and the fixes touch every region of it.
Under the skill's own rule — same file means one waits — almost every task interferes
with almost every other.

So this plan is **sequential waves on one branch**, not parallel chips in worktrees. Do
not try to run these as concurrent chips; the merge cost would exceed the fix cost. If
you want agents on it, hand out one wave at a time and merge before the next.

### What is not a defect, and needs your decision first

Six of the findings are places where the code and the documentation disagree, and the
code's behaviour is deliberate — there is a comment explaining why. Those are not bugs to
fix but decisions to settle. They are Wave 0, and nothing else should start until they
are answered, because several Wave 2 changes depend on the answers.

---

## Wave 0 — decisions, before anything is built

Each of these has a recommendation. None should be filled in by judgement.

**D1. `chip` and the interference gate.**
`openTasks()` counts a task as open only if `t.chip` is set, and `cmdChip` only sets it
when `--id` is passed — which nothing in `SKILL.md` or `README.md` ever does. Options:
make `--id` required, or stop keying "open" off the chip id.
*Recommend both:* key `openTasks` off status (`!['planned','landed','cancelled']`), so
the gate is correct regardless, **and** make `--id` required on a first chip so the
record still says which chip is which. Belt and braces, because this is the one failure
the whole arrangement exists to prevent.

**D2. The `refine done` stdin escape hatch.**
`SKILL.md:100` states as a guarantee that it "refuses rather than letting you type it
in". `driver.mjs:910` deliberately keeps a stdin fallback, commented "Older flow, and the
escape hatch". Both cannot stand.
*Recommend closing the hatch:* the frozen run shows all nine refine reports went through
stdin and `refine/` was never written, so the hatch is not a rarely-used escape — it is
the path. Keep a `--from <path>` for a report written somewhere unusual; drop stdin.

**D3. The dead message subsystem.**
`cmdInbox`, `cmdReply`, `cmdAck`, `cmdPost`, `cmdReadMsg` and everything under
`msgDir()` are unreachable — about 110 lines. Wire them up, or delete them?
*Recommend deleting.* The ledger (`messages.jsonl` + `append`/`ledger`) is the live path
and does the same job. Two message stores is how the wrong one gets read.

**D4. Stealing a slot from a live holder.**
The code steals any holder past 30 minutes, alive or not. `SKILL.md:963` tells the model
the opposite. A test suite that legitimately runs 40 minutes gets its slot taken.
*Recommend: never steal from a process we can prove is alive.* Keep a time limit only
for a holder whose liveness cannot be established (different host, no pid).

**D5. `graph` and pairs where one has landed.**
It skips them deliberately — comment: "a task that has landed is merged work, not a
contender". The effect is that its all-clear is history-dependent while its wording is
absolute.
*Recommend: keep the skip for the gating decision, but stop printing the unconditional
"Nothing clashes. Every round above can run side by side."* Say what was actually
checked, and list landed-pair overlaps as history.

**D6. Ownership exclusivity.**
Nothing prevents two tasks declaring the same owned path; your run has 52 such paths.
Hard error at `task add`, or a warning?
*Recommend: hard error for a newly added task, and a `doctor` report for the 52 already
on record* — erroring on existing state would make the current register unusable.

---

## Wave 1 — the argument parser

**Must land alone.** Every command reads its flags through this, so it is the one true
serialisation point in the plan.

### 1.1 Rewrite flag parsing — `driver.mjs:3118–3130`

Current rule: `--k` takes the next argument as its value unless the name is in
`BOOL_FLAGS` (only `stdout`, `all`, `load-bearing`) or the next argument starts with
`--`. Three consequences, all reproduced:

- A value that begins with `--` is dropped and the flag silently becomes `true`.
- `--flag=value` is parsed as a flag literally named `flag=value` and silently ignored.
- Every other boolean flag (`--dry-run`, `--reclean`, `--force`, `--not-blocking`,
  `--stale`, `--check`) can swallow the next positional argument.

Replace with: support `--k=v` explicitly; declare the full boolean set; and for a
value-taking flag, consume the next argument **whatever it starts with** unless it is
exactly `--`. Report an unknown flag rather than ignoring it.

### 1.2 One typed accessor for every text flag

Add `strFlag(name, {required, cmd})` that dies with a usable message when the value is
missing or not a string. Route through it:

| Site | Finding |
|---|---|
| `cmdHeard` — `driver.mjs:2888` | stores the agent's words as `true` |
| `cmdDefect` — `driver.mjs:1963` | `--evidence` silently coerced to `""` |
| `cmdLogReseed` — `driver.mjs:294` | records `"why": true` |
| `cmdCi` — `--why`, `--ref` | same class |
| `cmdSay` — `driver.mjs:2873` | already correct; use it as the model |

### 1.3 Numeric flags — `driver.mjs:253`

`rebuild --to` accepts a bare flag, `0`, `-5` and `bogus`, and each silently replaces the
register with `{}` at exit 0. Validate as a positive integer within the log's range.

### 1.4 `--register` — `driver.mjs:3129`

With no value it crashes with a raw Node stack trace and exit 1; every other bad input
gives `error: …` and exit 2. With `--register=<path>` it is ignored entirely and the
command runs against the current directory's register, reporting another project's state
at exit 0.

**Prove Wave 1:** `node test.mjs` green; `verify` green on a frozen copy of the real run;
and a new table-driven test over every flag in the driver asserting that a value
beginning with `--`, a `--k=v` form, and a missing value each behave correctly.

---

## Wave 2 — the record

`driver.mjs:136–310`. Independent of Wave 3 and 4; do it first because it is what makes
the rest recoverable if a later wave goes wrong.

### 2.1 An empty log must not produce an unrecoverable register — `driver.mjs:241`

`commit` appends only `diffOps(before, r)` even when `readEvents()` came back empty, so a
non-empty register ends up sitting on a one-line log. `rebuild` then replays that one
line and writes it over the register.

Measured on the frozen run: **635,468 bytes → 28 bytes, 55 tasks → 0**, with the message
"The previous file was kept in backups/ — nothing was thrown away."

Fix: when the log is empty and the register is not, seed the whole state exactly as
`cmdLogReseed` does — same `{p:[],v:cur}` op, plus a `reseed` marker saying the log was
found missing. `commit` already has both facts it needs.

### 2.2 `rebuild`, `verify` and `log reseed` must take the lock — `driver.mjs:247, 271, 293`

They call `writeReg()` directly, bypassing `acquireLock()`, and write the same
`register.json.tmp` a locked writer uses. A chip's `done`/`landed`/`say` landing during a
rebuild is dropped from the register with no trace; `verify` then offers two remedies and
`log reseed` — the wrong one — permanently discards the chip's work.

Fix: route all three through `readReg()`/lock acquisition. `verify` is read-only in
effect but must still take the lock to get a consistent pair of reads.

### 2.3 `rebuild --to` must not leave the run drifted — `driver.mjs:254`

Even a valid `--to 300` writes a truncated register and leaves `events.jsonl` at full
length, so every later `verify` reports drift (38 places on the frozen run).

Fix: either refuse `--to` unless `--and-truncate-log` is given, or truncate the log to
the same seq and say so. Do not leave the two out of step silently.

### 2.4 The record must name the command — `driver.mjs:16, 285`

`CMDLINE` is the raw argv, so any invocation carrying `--register <abs path>` first fills
the whole 46-character display with the path. **363 of the 387 events in the real run
show no command at all**, which makes `events --task <k>` — sold in `SKILL.md:68` as
"what happened to this task, and what did it" — useless on real data.

Fix: record the resolved subcommand (and subcommand word, e.g. `refine done`) alongside
the argv. Forward-only; the existing 387 events keep their raw `cmd`.

### 2.5 Two crashes in the reader — `driver.mjs:184, 191`

An events file that is unreadable or directory-shaped crashes every command with a raw
stack trace. A final line missing its trailing newline gets concatenated onto by the next
append, and both events are then dropped forever as a "torn tail" while `verify` goes
green on the loss.

**Prove Wave 2:** a test that deletes the log, writes, rebuilds and asserts the register
is unchanged; a test that holds the lock and asserts `rebuild` waits; and `verify` still
green on the real corpus.

---

## Wave 3 — dispatch, ownership and the guard

`driver.mjs:994–1330` and `2325–2545`. The largest wave, and the one that closes the
Tier-1 findings.

### 3.1 The interference gate — `driver.mjs:1204, 2350`  *(needs D1)*

Reproduced: two tasks both owning `src/shared.py`, chipped without `--id`, both go
`ready` with no complaint. Chipped **with** `--id`, the second is correctly refused.

Change `openTasks()` to key off status, and make `--id` required on a first chip. Then
audit the three call sites that depend on it — `cmdFrontier`, `cmdChip`'s own clash
check, and `cmdPreflightCheck`.

### 3.2 `guard` — `driver.mjs:2449–2490`

Four separate defects in one function:

- **Renames walk past it.** `git diff --name-only` prints only a rename's destination, so
  `git mv unowned.ts owned.ts` reports "safe to join up" at exit 0. Add `--no-renames`.
- **Shell injection.** `base` and `t.branch` are interpolated unquoted into `execSync`,
  and `t.branch` comes from agent-authored `task add` JSON. Reproduced by creating a file
  from a branch name. Use `execFileSync('git', [...])`. `cmdDoctor:1856` already does
  this correctly and is the model to copy.
- **`main` is hardcoded** as the base; any repo with a different default branch dies.
  Derive from `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `main`.
- **Non-ASCII filenames** come back quoted by `core.quotePath` and are recorded as a
  blocking trespass defect. Pass `-z`, or set `core.quotePath=false`.

### 3.3 `done` needs a status precondition — `driver.mjs:2413`

The only lifecycle command with no guard. Reproduced: `done` on a landed task set it back
to `reported` while keeping its `landedAt`; `done` on a never-dispatched task with no
chip was accepted. `chip`, `landed` and `release` all guard correctly — copy their shape.

### 3.4 Ownership exclusivity — `driver.mjs:1040`  *(needs D6)*

`taskProblems` rejects an empty `owns` with the words "two tasks may not touch one file",
then never looks at another task. Add the cross-task check for new tasks, and a `doctor`
section listing existing violations — 52 paths on the current register, one of them owned
by seven tasks.

### 3.5 `graph`'s wording — `driver.mjs:1136, 1204`  *(needs D5)*

Stop printing an unconditional all-clear for a conditional check. Report landed-pair
overlaps as history.

### 3.6 Serialisation points — `driver.mjs:1200`

Free-text compared with exact equality; it has never fired on a real run, and your own
pre-flight found a `docker-compose.yml` collision it reported clean. Normalise before
comparing, and have `doctor` warn on a point only one task ever names.

### 3.7 `bundle` — `driver.mjs:1294–1299`

Absorbed members are cancelled but no *other* task's `needs` is repointed, so dependents
are held forever and `graph` exits 1 permanently — while `SKILL.md:491` forbids creating
any chip while it does. On the real register, running the command `bundle suggest` itself
prints strands 11 tasks. Also: bundling twice into one host throws an uncaught
`SyntaxError`, and a bundle drops the absorbed member's unresolved load-bearing pre-flight
gaps, flipping `preflight check` from red to green.

### 3.8 Smaller ones in the same region

`landed` lands a task whose own requirement has not landed (`2491`); `agent` crashes with
an unrelated message when `needs` names an unknown key (`2368`); `chip --branch` is
silently ignored (`2350`); `owed assign --to` accepts a landed or cancelled task (`2016`).

**Prove Wave 3:** the two-tasks-one-file case must be refused with and without `--id`; a
real git fixture where a rename out of an unowned path fails the guard; a branch name
containing `;` must not execute anything; `done` on a landed task must be refused; and
`bundle` on a copy of the real register must leave `graph` at exit 0.

---

## Wave 4 — the grill, and the message ledger

`driver.mjs:338–760` and `2560–3050`. Independent of Wave 3 in behaviour, but the same
file, so it follows rather than runs beside it.

### 4.1 `SETTLED_HEADING` word boundaries — `driver.mjs:352`

`resolved` is inside *un*resolved and `answered` is inside *un*answered, so a section
headed "Unresolved questions" turns suppression **on** and every gap in it is dropped.
The sections most likely to hold undecided things are the ones skipped, and `check` then
goes green. Anchor the alternatives on word boundaries with a negative lookbehind for
`un-`.

### 4.2 The plain-words linter rejects plain English — `driver.mjs:559`

`JARGON` is matched as bare substrings, so `form`, `format`, `normal`, `information`,
`performance`, `platform` and `rapid` are all refused, and the message does not say which
word it objected to. Match on word boundaries and name the offending word.

### 4.3 `check` passes vacuously — `driver.mjs:671`

It reads only status strings, so an empty gap list satisfies it and
`set <id> status=answered` walks past it with no answer recorded. `render` then dies with
a raw `TypeError` on the register `check` just blessed. Require a recorded answer, and
refuse when nothing was ever scanned.

### 4.4 `silence` and unterminated fences — `driver.mjs:353, 389`

Category words matched as substrings ("deliberate" reads as *rate*, "download" as *load*)
make it miss 11 of 14 real silences. An odd number of code fences makes every remaining
line count as fenced and never scanned.

### 4.5 `ingest` loses real messages — `driver.mjs:2723, 2763, 2766, 2770`

Four separate losses, all measured against your transcripts:

- **The second wrapper shape is dropped.** `harvest` requires `from-name="…"`; Claude Code
  also emits `from="local_…" name="…" encoded="1"`, which is the shape used when the peer
  channel is gone and the transcript is the only copy. Cost: 3 full task reports, ~14.6 KB.
- **Subdirectory cwd is dropped.** `j.cwd !== CWD` is an exact match, so a turn taken from
  `apps/api` is thrown away. Cost: 13 outbound releases, all absent from the ledger. The
  count is tallied into `seen.wrongCwd` and never printed. Match on prefix, and print it.
- **Attribution by longest key, not by position.** 22 real messages are filed under a task
  they merely mention. The length sort was added so `1.9` would not swallow `1.9a`, but
  the word-boundary regex already prevents that. Prefer the earliest match by position.
- **Truncation at 4,000 characters is unmarked.** 33 of 311 real messages end mid-sentence
  and read as complete. Add an ellipsis and a `truncated` flag with the original length.

### 4.6 `waitingOn` — `driver.mjs:2987`

A logged `release` clears an unanswered question, which is the same hole the sendback fix
closed — and `heard` prints the opposite guarantee to the operator. Also, a `blocked`
message is reported with the wording "asked you something".

### 4.7 Delete the dead subsystem — `driver.mjs:2566–2690`  *(needs D3)*

### 4.8 `digest` still emits raw multi-line text — `driver.mjs:2934`

The "clip the detail line" fix landed in `outstanding` only. `digest` is what the
SessionStart hook feeds a freshly compacted context, so it is the one that matters most.

**Prove Wave 4:** a plan fixture with "Unresolved"/"Unanswered" headings must report its
gaps; a lint fixture using the word "normal" must pass; `ingest` against the real
transcripts must recover the 3 wrapper-shape reports and the 13 cwd-dropped releases, and
must be idempotent when run twice.

---

## Wave 5 — the shared machine slot

`driver.mjs:1387–1425` and `2042–2145`. Small and self-contained.

### 5.1 `slot take` gives no exclusion — `driver.mjs:2050, 2098`  *(needs D4)*

It writes its own pid and exits, so every later waiter sees `ESRCH` and takes over
immediately. Reproduced end to end. Either record no pid for a manual take (so only the
time limit applies) or mark the entry `manual: true` and have `slotIsStale` skip the
liveness check for it. Its success message should also stop teaching `--force`, which
`SKILL.md:848` calls load-bearing.

### 5.2 `slot run` breaks env-prefixed commands — `driver.mjs:2126`

Every token is single-quoted, so a leading `VAR=value` becomes a quoted command name and
bash returns 127. The register holds 40 verify lines in that shape and **5 briefs on disk
still carry them**. Pass the command through without per-token quoting, or detect and
preserve leading assignments.

### 5.3 Three compounding faults in stealing — `driver.mjs:2061, 2112, 2122`

`slotIsStale` checks elapsed time before liveness; the takeover has a race between
`slotIsStale()` and `rmSync()`; and `free()` deletes by path with no ownership check, so
an evicted process removes its successor's claim. Check liveness first, steal by atomic
rename, and write an ownership token that `free()` verifies.

### 5.4 `needsSlot` — `driver.mjs:1409`

`pnpm install` and `env CI=1 pnpm install --frozen-lockfile` classify as light, so every
agent is told to run them bare and in parallel.

**Prove Wave 5:** two concurrent `slot run` calls must serialise; `slot run ci -- FOO=1
echo hi` must print `hi`; a taken slot must not be stolen by the next waiter.

---

## Wave 6 — `SKILL.md` and the docs

Nothing here changes behaviour, and it must come last so it describes what the code now
does rather than what it was meant to do.

- Reconcile every guarantee touched by Waves 1–5. The specific ones the audit found
  false: the `refine done` refusal (`:100`), the slot's live-holder rule (`:963`), and
  "which command did it" (`:62`, `:68`).
- Add `--id` to every documented `chip` invocation (D1).
- Document `serialises` in the `task add` JSON shape — it is required by `graph`, `chip`
  and pre-flight and appears in none of the documented shapes.
- Fix the `ci --status red` example: `--why` is required for `red`, and the example
  attaches it only to `skipped`.
- Resolve the two places `SKILL.md` contradicts itself: whether every verify command goes
  through the slot wrapper (`:688`), and the `slot run` troubleshooting entry's cause.
- Either create the gitignore rule for the register or stop stating it as established
  fact (`:81`).

---

## Wave 7 — tests that would have caught these

**Larger than the fix work.** Budget for it accordingly: roughly 600–900 new lines
against maybe 400–600 changed in the driver.

The current suite is 56 checks, all green, and the audit's mutation pass showed it does
not protect the things that matter:

- `collides` can be replaced with `return false` and the suite stays 56/56 green.
- Four independent mutants that disable brief staleness detection all survive.
- None of `chip`'s three refusal guards is exercised; all can be deleted green.
- `landed`'s refusal to land an unreported task can be deleted green.
- `"none of them covers anything"` is an `.every()` over an empty filter — it cannot fail.
- The suite never asserts how many checks ran, so a block that stops executing still
  prints "all green".
- 26 of the driver's 49 commands are never invoked, including `guard`, `slot`,
  `preflight`, `wave` and the entire grill phase.

Three rules for this wave:

1. **Every fix ships with a test that fails against the pre-fix code.** Prove it by
   reverting the fix in a scratch copy and watching the new test go red. A test that
   passes both ways is not a test.
2. **Assert the count.** `56 checks, all green` must become an assertion, not a print.
3. **Add the real corpus as a fixture.** A trimmed copy of the recorded run, with
   `verify` green over it as a standing check. It is the only test input in the project
   that nobody generated to satisfy the check it feeds.

Then re-run the mutation pass and record which mutants now die. That number, not the
check count, is what says the suite works.

---

## Order, and how to know each wave is done

| Wave | Region | Depends on | Gate |
|---|---|---|---|
| 0 | decisions | — | all six answered in writing |
| 1 | parser, `3118–3130` | D-none | flag table test; `verify` green on corpus |
| 2 | record, `136–310` | 1 | delete-log-then-rebuild test; lock-contention test |
| 3 | dispatch, `994–1330`, `2325–2545` | 1, D1, D5, D6 | two-tasks-one-file refused; rename fails guard |
| 4 | grill + ledger, `338–760`, `2560–3050` | 1, D3 | Unresolved-heading fixture; ingest recovers 16 lost messages |
| 5 | slot, `2042–2145` | 1, D4 | two concurrent runs serialise; env-prefixed command runs |
| 6 | `SKILL.md` | 1–5 | every changed guarantee re-read against the code |
| 7 | `test.mjs` | 1–5 | mutation pass: named mutants die |

**After every wave, both of these must hold:**

```
node test.mjs                                   # green
cd <frozen copy of the real run> && node driver.mjs verify   # green, 387 events
```

The second is the one that matters. It is the only check in this project whose input
nobody produced in order to pass it.
