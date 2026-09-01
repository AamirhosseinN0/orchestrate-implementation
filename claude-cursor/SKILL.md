---
name: claude-cursor
description: Run an implementation end to end exactly as orchestrate-implementation does, but with every agent executed on the Cursor CLI (`agent`) instead of inside Claude Code — the refining agents, the pre-flight agents, and the chips that write the code. Use when asked to orchestrate a plan through Cursor, run the implementation on Cursor, hand the building work to Cursor agents, drive chips with cursor-agent, or orchestrate with Grok/Composer/Codex as the builders.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, AskUserQuestion, TodoWrite
---

# The same orchestration, built by Cursor

**Read `~/.claude/skills/orchestrate-implementation/SKILL.md` now. It is the
procedure.** The grill, the register, `graph`, `doctor`, `guard`, the CI slot,
joining and landing — all of it is unchanged and none of it is repeated here.

This file replaces **one layer**: where an agent is spawned. Wherever the parent
says *use the Agent tool* or *create a chip*, do what is written below instead.
`driver.mjs` is not modified and needs no modification.

Run every command from the project root — the driver and this skill both resolve
paths against the working directory.

```bash
DRV=~/.claude/skills/orchestrate-implementation/driver.mjs
RUN=~/.claude/skills/claude-cursor/scripts/cursor-run.sh
```

## 0. Before anything: the binary and the model

```bash
agent status            # not logged in → stop and ask the user to run `agent login`
agent --list-models     # the authority for THIS account
```

**Every agent runs on `cursor-grok-4.6-xhigh`** — Grok 4.6 at Extra High
thinking, standard speed. Refining agents, pre-flight agents and chips alike.
Highest reasoning; **never the `-fast` tier**, which bills at roughly double for
speed this work does not need. The launcher pins it, so pass no `--model` at all.

That is one line to change if it ever needs changing: `PINNED_MODEL` in
`scripts/cursor-run.sh`. Confirm the name still exists in `--list-models`
first — a name that no longer exists refuses and prints the whole list, so the
check is cheap.

**Asking for it is not getting it.** Effort suffixes have historically been
dropped silently. The launcher reads the `model` back from the agent's own
opening event and refuses the run unless it is exactly
`Cursor Grok 4.6 Extra High` — anything reading `Fast`, or any lower effort,
stops the run rather than quietly costing double or thinking less. If you call
`agent` by hand instead, check that line yourself.

## 1. Refining agents — parent §6

```bash
node $DRV refine brief docs/plans/2.1.md > /tmp/refine-2.1.txt
$RUN --key refine-2.1 --workspace . --prompt-file /tmp/refine-2.1.txt
node $DRV refine done docs/plans/2.1.md
```

Runs in the main checkout: a refining agent must write its plan file and its
report. One per plan, launched as **background** `Bash` calls so they run
together — they only ever touch their own plan, so they cannot collide.

That brief says nothing about `SendMessage`, so it ports with **no preamble**.

## 2. Pre-flight agents — parent §11

```bash
node $DRV preflight brief 2.1 > /tmp/pf-2.1.txt
git status --porcelain -- ':!.claude' > /tmp/pf-before.txt      # ← before
$RUN --key preflight-2.1 --workspace . --prompt-file /tmp/pf-2.1.txt
git status --porcelain -- ':!.claude' > /tmp/pf-after.txt
diff /tmp/pf-before.txt /tmp/pf-after.txt                       # must be empty
node $DRV preflight done 2.1
```

**That diff is not optional.** A pre-flight agent reports and fixes nothing, but
it runs under `--force` and nothing stops it. It has to: `preflight done` has no
stdin hatch, the report must be on disk, and Cursor's read-only `--mode ask`
cannot write one. So read-only is held by the contract in the brief and by this
check, not by the harness.

**Take the before/after, not a bare `git status`.** The refining agents rewrote
their plan files and those are still uncommitted, so a bare status is dirty
before pre-flight starts and blames it for the previous act's work. The pathspec
excludes `.claude`, where the report legitimately lands.

Anything in that diff is the arrangement already broken — send it back, do not
tidy it up yourself.

## 3. Chips — parent §12

You create the worktree, so the branch name is known before anything starts:

```bash
KEY=2.1; BR=step/$KEY; WT=$(realpath ../wt-$KEY)
git worktree add "$WT" -b "$BR"
CID=$(agent create-chat)                      # prints a bare uuid — this is the address
node $DRV chip  "$KEY" --id "$CID" --worktree "$WT" --branch "$BR"
node $DRV agent "$KEY" --name "$CID" --force  # --force: Cursor sessions are not in ~/.claude/sessions
node $DRV brief "$KEY"                        # prints the brief's absolute path
```

`agent --force` will say `⚠ forced: <uuid> is not a session in <worktree> (no
session is in it)` and then take the name. That is expected every time — it is
looking for a Claude session and there will never be one. It is not a warning
about your chip.

Then write the preamble below plus that path to a file and launch it in the
**background**, one `Bash` call per chip:

```bash
$RUN --key "$KEY" --workspace "$WT" --chat "$CID" --prompt-file /tmp/chip-$KEY.txt
```

Gate order is the parent's, unchanged: `graph` green → `preflight check` →
`doctor` → chips.

### The chip preamble

The brief is written for a Claude Code session. Three lines put that right; the
brief file itself is never edited.

```
You are a Cursor CLI subprocess, not a Claude Code session.

1. Ignore the check-in step — you have no SendMessage. Starting IS your
   check-in. This chat is your address and you will be resumed on it.
2. You are already in your own worktree on the correct branch, so the
   `git checkout -b` line is a no-op. Never touch the main checkout.
3. At the end, still run the `driver.mjs ... done` command exactly as the
   brief writes it — that is the report that survives. Print the message it
   asks you to send as your final output instead of sending it.

Read your brief at <absolute path> and do the work.
```

## 4. The loop — parent §15

Two substitutions; the four moves are otherwise the same.

- **A chip's process exit is its report.** It wakes you. Read
  `.claude/orchestration/cursor/<key>.jsonl`, then `board`, `guard`, join, `landed`.
  The agent has already run `done` itself, so the record does not depend on
  anything passing through your context.
- **A send-back is a resume**, and then logged as the parent requires:

```bash
agent -p --force --trust --resume "$CID" "src/other/b.py is not yours — back out that change"
node $DRV say 2.1 --kind sendback --text "..."
```

There is no check-in message and no held chip, so the observer-echo problem the
parent warns about cannot happen here: the address is the uuid you created.

## Gotchas

- **Launch every run with `run_in_background: true`.** These take minutes, not
  seconds — well past the foreground `Bash` timeout. Backgrounding is also what
  makes the round parallel, and what wakes you when a chip is done.
- **A run's liveness is its log, not `ps`.** The process does not show up under
  `agent`, so a grep for it says "dead" about a run that is working. `"type":"result"`
  in `.claude/orchestration/cursor/<key>.jsonl` is what finished looks like; a
  file still growing is what alive looks like.
- **`--trust` on every run.** Every new worktree is a directory Cursor has not
  seen, and without it a headless run stops dead asking to be trusted.
- **Without `--force` it proposes, writes nothing, and still exits 0.** A whole
  round can look green and leave every worktree untouched. The launcher always
  passes it; if you call `agent` by hand, pass it too.
- **`permissionMode` reads `"default"` even under `--force`.** It is not a
  write-access indicator. Confirm writes by artifact — the file, or `git diff`.
- **Omitting `--resume` silently opens a new chat**, losing the address for that
  task. Always pass `--chat`.
- **Effort is a suffix on the model id**, not a flag — which is why the pinned
  name ends `-xhigh`. `--effort` does not exist and will error. `-fast` is a
  separate speed tier stacked on top of effort, so `-xhigh-fast` is the same
  thinking at double the price: omitting `-fast` is how you opt out, and the
  launcher refuses it either way.
- **`driver.mjs resume` finds nothing for Cursor chips.** It reconstructs
  messages by scanning Claude Code transcripts. The register, `events.jsonl` and
  `board` are unaffected — recover from those.
- **A chip that dies leaves a live chat.** `agent -p --resume "$CID" "status?"`
  asks it what it got done before you decide to re-chip, which the parent's
  dead-agent rule needs an answer to.
