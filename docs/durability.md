# Durability: keeping the orchestration run across compactions and dead sessions

A design note. Problem: the orchestrator gets context-compacted a lot and loses
the thread of the run — the tasks, the errors and bugs reported between
sessions, and the full brief that configures each chip. This note lays out what
the codebase already does, how other projects solve the same problem, and where
the real gaps are.

## What is already in place

`driver.mjs` already implements most of the conventional answer. Map of the
current mechanism:

| Concern | What `driver.mjs` does | Where |
|---|---|---|
| Context gets compacted | `hook-install` injects `digest` on `compact\|resume\|startup` via a Claude Code SessionStart hook | `cmdHookInstall`, `cmdDigest` |
| Full chip brief must not be lost | Every brief is written to a **file** (`briefs/<key>.md`), never held in context | `cmdBrief` → `fs.writeFileSync(briefPath(key))` |
| Tasks / status / decisions | `register.json` is the current state; 30 atomic backups kept on every write that changes it | `writeReg` |
| Messages between orchestrator and chips | Append-only `messages.jsonl` ledger; `ingest` rebuilds it from Claude's on-disk transcripts | `ledgerPath`/`cmdIngest` |
| Session dies mid-run | `resume` re-announces to live chips and rewrites briefs with a new address | `cmdResume` |
| Concurrent writers | Directory lock, atomic rename (`tmp` → `REG_PATH`); a lock is taken over only once its holder is shown to be gone | `acquireLock`/`lockIsDead`/`writeReg` |

(Function names rather than line numbers: the file moves, and a stale number
sends the reader to the wrong place with no sign that it has.)

So the design intent — durable artifacts (briefs are files), durable message
log (`messages.jsonl`), state snapshot with backups (`register.json` +
`backups/`), recovery after death (`resume`), compaction rehydration (`digest`
hook) — is already the right skeleton. This note is about the one structural
weakness in that skeleton and how to close it.

## What other projects do

Surveyed patterns, grouped by mechanism:

### 1. State snapshots + backups (what we do now)
- **LangGraph checkpointers**: current graph state snapshotted, keyed by
  `thread_id`, restored on resume. Two storage abstractions — a `checkpoints`
  table (one row per step) and a `writes` table (per-node deltas) — so even a
  node that finished *inside* an un-committed step is already durable. Production
  uses Postgres/SQLite; in-memory dies on restart.
  https://docs.langchain.com/oss/python/langgraph/checkpointers
- **Akka PersistentActor / actor-ts DurableStateActor**: persist only state
  *changes* to an append-only journal; recover by replay. Optional **snapshots**
  avoid replaying the whole life — load latest snapshot, then replay events after it.
  https://getakka.net/articles/persistence/architecture.html

### 2. Append-only event log + replay (the biggest gap here)
- **Event sourcing (Fowler)**: the log is the *truth*; current state is a
  **derived projection**. Replay re-derives everything. Corrections are
  *appended* as new events, never rewriting history.
- **"The Log Is the Truth" (agentpatterns.ai)**: for agents specifically —
  agents **emit JSON intentions, never write files**; a deterministic
  orchestrator validates and applies them. Replaying the log must reproduce the
  filesystem — that is how correctness is *verified*. A **materialized view**
  rebuilt from the log is fed to agents *instead of growing conversation
  history* — directly attacking context degradation.
  https://learn.agentpatterns.ai/observability/the-log-is-the-truth/
- **Proven at scale**: LMAX (millions of ops/s, replay from snapshot), Akka
  Persistence, Vercel Workflows (every step/input/output/error in a log that is
  the SOT; replays to restore state).
  https://vercel.com/i/event-sourcing

### 3. Durable task + outbox / mailbox for orchestrator ↔ worker
- **Google a2a protocol**: the primitive is a **stateful Task**
  (submitted → working → input-required → completed/failed) with a distinct ID,
  an **immutable terminal state** — follow-ups are *new* tasks under the same
  `contextId` — and **durable Artifacts**: reports/files are the output, not chat
  text. A client can re-attach to an in-flight task (`SubscribeToTask`), and
  dedupes on a deterministic `messageId`.
  https://agent2agent.info/docs/topics/life-of-a-task/
- **Transactional Outbox**: write the state row *and* the integration event in
  the same transaction so they cannot diverge (the dual-write trap).
  https://microservices.io/patterns/data/transactional-outbox.html
- **Akka AtLeastOnceDeliveryActor**: point-to-point at-least-once delivery that
  survives sender *and* receiver crashes.

### 4. Durable execution engines (the heavyweight version of what we do by hand)
- Conductor's a2a integration does our exact job with a crash-safe `FORK_JOIN`
  multi-agent orchestration where each in-flight agent call resumes from
  persisted state. Temporal/Cadence/Conductor are the productized form of the
  register+resume mechanism `driver.mjs` builds by hand.

## Resolved — what was actually built

The gap below was closed on 26 August 2026, and by a different route than this
note proposed. Rather than rewriting all 23 mutation sites to emit semantic
events (and baking each one's ambient state so replay could not re-derive it
differently), the event is **derived from the state change itself**: `commit()`
diffs the register before and after, and appends the resulting path-assignments.

That is strictly better here for three reasons. A diff taken after the fact *is*
the resolved outcome, so the whole class of ambient-resolution bugs — a wave
index recomputed from the graph, a status derived from every dependency, an id
allocated from the current maximum — cannot occur. It is one change rather than
23, so no site can be forgotten. And the ops are assignments, so replaying an
event twice is a no-op by construction.

Measured on the real 1.1 MB register: 82–160 bytes per event, 6,000–12,000x
smaller than the post-image alternative this note's §1 implies.

Snapshots were **not** built. Replay of a few thousand events is 30–60 ms, well
under the node startup this tool already pays; and a `_seq` field in the register
would defeat the no-op guard in `writeReg`, burning a backup slot on every write.
The 30-deep backup ring is kept as a second net against a bug in replay itself.

Also fixed on the way, both found by adversarial review of the above:
`brief --all` stamped every task on every run, so twenty tasks burned twenty of
the thirty backup slots — and it is the command `resume` recommends, so the
documented recovery destroyed the only history. And the register lock was stolen
from any command still running after fifteen seconds; it now asks the operating
system whether the holder is alive.

Three more things had to change before the record could be relied on, and they
are worth naming because each was a way the two halves could quietly disagree.
`rebuild --to <seq>` rewound the register and left the record where it was, so
the two were permanently out of step from that moment on; it now cuts the record
to the same point and keeps what it cut in an `events.jsonl.before-rewind-<stamp>`
file. A missing `events.jsonl` was replayed as an empty one, so losing the record
let `rebuild` empty a full register. And `rebuild`, `verify` and `log reseed`
wrote without holding the lock, onto the same temporary file a locked writer was
using — so a chip's concurrent `done` was overwritten with no word said. All
three now take the lock, and `writeReg` takes it as a backstop if anything
reaches it without one.

The events themselves also record which subcommand produced them, which is what
makes replay auditable rather than merely correct: `events --task <key>` can now
say what happened to one task and what did it.

## The original gap and the fix as first proposed

**Gap:** `register.json` is one mutable row with backups as its only history. It
is also usually kept out of the project's history — nothing creates that rule, it
is a choice each run makes — so the 30-backup ring is the entire safety net. If
the register is corrupted or the ring is swept, the run's task state is gone.
`messages.jsonl` is already append-only and durable; task-state mutations are not.

**Fix (the proven, highest-leverage one):** split "current state" from "the
record."

- Make an **append-only event log** the source of truth. Every mutation appends
  an event: `task-status-changed`, `decision-made`, `brief-written@sha`,
  `gap-found`, `owed`, `landed` … one line per fact, never rewritten.
- Make `register.json` a **derived projection** rebuilt by replaying the log.
  After a compaction or a dead session, a fresh session reconstructs the true
  register from disk regardless of what was in context.
- Use the existing `backups/` ring (or an explicit snapshot file) as **snapshots**
  to bound replay cost — load latest snapshot, replay only the tail (Akka's
  exact shape). A no-op write need not create a snapshot (already the behavior).

This converts durability from *reactive* (re-inject the digest; depends on the
hook) into *structural* (the full true run is rebuildable from disk, no hook and
no context needed).

## Other small gaps worth closing

- **Brief-change detection by the chip.** `board`/`staleBriefs` already tell the
  orchestrator a brief is stale, but the chip has to be *told*. Put the brief's
  write-sha into the chip's mandatory check-in so a changed brief is detected by
  the chip itself, not hoped-for (a2a's resubscribe loop).
- **At-least-once with dedupe.** `ingest` already dedupes on `uuid`. Extend the
  same idempotency to an event log (a2a: deterministic `messageId`, effectively-
  once delivery). Recovery itself has since been widened twice: a second shape
  of message wrapper is now unpicked, and turns taken from a subdirectory of the
  project are no longer discarded — on one real transcript set that moved the
  recovered count from 311 messages to 632. A message the transcript itself cut
  short is marked as cut rather than passed off as whole, and `ingest --reclean`
  re-derives entries an older copy of the tool recovered badly.
- **Terminal tasks are immutable.** Your `owed`/hotfix model already treats a
  defect as a new task, never a rewrite of history — keep that; it matches a2a
  and event-sourcing.

## Proven-at-scale ranking

1. **Event sourcing + snapshot/replay-tail** (LMAX, Akka.Persistence, Vercel
   Workflows, Netflix) — the most battle-tested answer to "state must survive a
   crash and be reconstructable."
2. **Durable execution engines** (Conductor / Temporal / Cadence) — the product
   category for "workflow survives process death"; heavy, but they validate the
   register+resume design.
3. **a2a** — the standardized articulation of "durable artifacts + stateful
   tasks + durable message threads"; validates the artifact-file and message-log
   choices already in the codebase.
4. **Transactional outbox** — the small correctness firewall for the state +
   message dual-write.

## Bottom line

The mechanism is not missing — the compact-resilience design is sound and the
a2a/event-sourcing literature independently confirms the artifact-file and
message-log choices. The single most valuable upgrade is the split: append-only
**event log** as truth, `register.json` as a replay-derived **projection**, and
the existing backup ring as **snapshots** to cap replay cost.
