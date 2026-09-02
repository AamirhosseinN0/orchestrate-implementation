# FINDINGS — what broke, on a real run

From orchestrating Safheh's M0 (`docs/backend_plans/steps` S-001..S-010) on 2026-09-02:
ten refining agents, one pre-flight, one chip. Everything below was **verified by probe on
this machine**, not inferred. Ordered by what costs the most.

---

## 1. Cursor rebuilds `PATH`, so `node` is its own bundled runtime — not yours

**This is the one that silently corrupts artifacts.** `SKILL.md` says nothing about it.

Cursor ships its own Node and **reconstructs `PATH` from its own environment**, discarding
the caller's ordering. Exporting a different Node ahead of it before calling `cursor-run.sh`
does not survive.

Probed, twice:

```
# launcher exported PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"
command -v node  ->  ~/.local/share/cursor-agent/versions/2026.08.31-4057e58/node
node -v          ->  v24.5.0          # nvm's v24.20.0 is installed and shadowed
```

Why it matters beyond a version mismatch: this project's proof does
`cp "$(command -v node)" dist/safheh-proof` to build a single-executable binary. The agent
would have **injected the wrong runtime into the shipped artifact** — and the gate's own
floor check (`>=24.20.0`) would have failed, so the run reads as broken for the wrong reason.

**The fix cannot live in `cursor-run.sh`** — the override happens inside the agent's own
shell, after launch. It has to be an instruction the agent reads. Verified working:

```
# inside the agent's own command, this wins:
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"; command -v node
  ->  ~/.nvm/versions/node/v24.20.0/bin/node
  ->  v24.20.0     FLOOR-PASS
```

**What SKILL.md should gain:** a gotcha saying bare `node` inside an agent is Cursor's own,
that it must be prefixed per command, and that any project pinning a runtime version has to
carry that line in every brief. Ideally the chip preamble in §3 gains it as a fourth numbered
point, since the preamble is the one thing every chip reads.

## 2. Every other environment variable *does* propagate — say so

The counterpart to #1, and worth stating so nobody over-engineers a fix for a problem that
does not exist. Probed in the same run:

```
PROBE_VAR=[reached-the-agent]  OSV_DB_DIR=[/home/…/.cache/osv-db]  PATH_HEAD=[/home/…/.local/bin]
```

`PATH` is the sole exception. Normal exports reach the agent untouched.

## 3. No documented way to read the agent's answer

`SKILL.md` says `"type":"result"` in the jsonl is what finished looks like — true, and useful
for liveness. But nothing says how to get the agent's **text** out, and every run needs it
(a probe's output, a chip's final message, a dead agent's last words). Each caller ends up
hand-writing the same parser:

```bash
node -e 'const fs=require("fs");
 for (const l of fs.readFileSync(process.argv[1],"utf8").trim().split("\n")) {
   try { const j=JSON.parse(l); if (j.type==="result" && j.result) console.log(j.result); } catch {}
 }' .claude/orchestration/cursor/<key>.jsonl
```

**Suggest:** ship it as `scripts/cursor-result.sh <key>`, beside `cursor-run.sh`.

## 4. `agent create-chat` output is not reliably a bare uuid

§3 says it "prints a bare uuid — this is the address" and shows `CID=$(agent create-chat)`.
On this machine it needed `| tail -1` to be safe. A stray banner line silently becomes part
of the chat id, and the failure surfaces much later as `--resume` opening a new chat — which
§Gotchas already names as the expensive one.

**Suggest:** `CID=$(agent create-chat 2>/dev/null | tail -1)`, plus a uuid-shape assertion
before it is used.

## 5. Log size and concurrency are undocumented

Ten refining agents in parallel produced **690 KB – 2.1 MB of jsonl each**, ~14 MB for one
act. Nothing failed, but nothing in `SKILL.md` warns about disk, and there is no stated ceiling
on how many `$RUN` calls should be in flight. Ten was fine here; whether forty is, nobody knows.

**Suggest:** one line on expected log size, and either a tested concurrency ceiling or an
explicit "no known limit, ten verified".

## 6. `cursor-run.sh` reads the model from line 1 only

```sh
SHOWN=$(sed -n '1p' "$LOG" | sed -n 's/.*"model":"\([^"]*\)".*/\1/p')
```

Correct on every run observed. But if a warning or a non-init event ever lands first, the
launcher reports `no init event — the run never started` for a run that started fine. Matching
the first line that *has* a `model` field would be strictly safer at no cost.

---

## What was accurate and load-bearing — do not weaken these

- **The pre-flight before/after `git status` diff (§2).** A pre-flight runs under `--force`
  and the contract is the only thing holding it read-only. On this run the diff came back
  empty and that was the only proof available. The warning about the refining agents' own
  uncommitted plan files being mistaken for pre-flight writes is exactly right — a bare
  `git status` *was* dirty before pre-flight started.
- **The model pin and the read-back check.** `PINNED_MODEL` verified against the agent's own
  init event caught nothing wrong on this run, but it is the only thing that would.
  `cursor-grok-4.6-xhigh` → `Cursor Grok 4.6 Extra High` confirmed on all thirteen runs.
- **"A run's liveness is its log, not `ps`" (§Gotchas).** Used it. One agent's log sat
  unchanged for 39 seconds mid-run and looked dead; it was a long thinking block.
- **`--trust` and `--force` on every run.** Both needed exactly as described.
- **`driver.mjs resume` finds nothing for Cursor chips.** Accurate; recover from `board`
  and `events.jsonl`.
- **The chip preamble ported verbatim.** The three numbered points were sufficient — the
  agent did not try to `SendMessage`, did not touch the main checkout, and ran its own
  `done` command.
