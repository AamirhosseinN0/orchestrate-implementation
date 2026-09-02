# Fix plan — claude-cursor

Every claim in `FINDINGS.md` was re-probed on this machine on 2026-09-02 against
cursor-agent `2026.08.31-4057e58`. Four hold, one is inverted, one did not
reproduce, and two problems the report missed are worse than most of what it found.
The plan below fixes what is real and adds the model split that was asked for.

---

## Part 1 — What the probes actually said

| # | Claim | Verdict |
|---|---|---|
| 1 | Cursor rebuilds `PATH`, discarding the caller's ordering | **Real** |
| 1a | …so bare `node` is Cursor's bundled runtime | **Inverted — see below** |
| 2 | Every other env var propagates | **Real** |
| 3 | No documented way to read the agent's answer | **Real, and worse than stated** |
| 4 | `create-chat` output is not reliably a bare uuid | **Did not reproduce** |
| 5 | Log size and concurrency undocumented | **Real as a gap; numbers now measured** |
| 6 | Launcher reads the model from line 1 only | **Real** |
| **N1** | The pinned-model guard is skipped for any non-pinned model | **New — and the Composer change walks straight into it** |
| **N2** | `cursor-run.sh` has no test coverage at all | **New** |

### 1 — the mechanism is real, the conclusion is backwards

The discriminating probe: the launcher exported `v24.19.0` **first** in `PATH`, and
the caller confirmed it (`node -v` → `v24.19.0`) immediately before launch.
The agent's own shell saw:

```
WHICH=[/home/aamirhosseinn0/.nvm/versions/node/v24.20.0/bin/node]
VER=[v24.20.0]
```

So the caller's ordering is indeed discarded — that half of the report is correct,
and it is confirmed in the bundle, where the shell tool runs
`builtin export PATH="/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"` and then
replays a snapshot of the login shell.

But the runtime that wins is **not** Cursor's bundled `v24.5.0`. It is the
**login profile's default** — `.bashrc:119-121` sources `nvm.sh`, `~/.nvm/alias/default`
is `24.20.0`, and nvm's prepend lands ahead of the cursor-agent directory. Three
separate probes agree, including one with every nvm entry stripped from the caller's
`PATH`; the bundled `v24.5.0` never won once.

The report's worked example — the wrong runtime copied into `dist/safheh-proof`,
the `>=24.20.0` floor failing — **cannot happen on this machine as configured**.
The bundled node sits behind nvm in every observed ordering.

What is genuinely broken is smaller and more durable: **the launcher cannot pin the
agent's runtime at all.** The agent gets whatever the login profile hands it, so the
runtime is a property of the operator's dotfiles, not of the orchestration. Change
`nvm alias default`, run on a box without nvm, and the answer silently changes —
`/usr/bin/node` here is `v22.22.1`, which *would* fail a 24.20 floor. That is worth
fixing, and the report's proposed fix is the right shape for the wrong reason.

The proposed fix was verified working in-agent:
`export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"` inside the agent's own
command resolves as intended.

### 2 — real, as stated

`PROBE_VAR=[reached-the-agent]` and `OSV_DB_DIR=[/home/…/.cache/osv-db]` both arrived
intact. `PATH` is the sole exception. Worth writing down so nobody builds a
plumbing layer for a problem that does not exist.

### 3 — real, and there is a failure mode the report did not hit

`SKILL.md` documents `"type":"result"` for liveness and never says how to get text out.
Confirmed. But a run can also fail with **no result line at all**: the loop-detector
killed one probe and the log simply ends with a bare, non-JSON line —

```
NonRetriableError: Agent Looping Detected …
```

A parser that only looks for `type=="result"` reports *nothing* for that run and the
operator is left staring at a silent failure. The shipped parser must therefore also
surface a non-JSON tail, and must be able to dump `shellToolCall` stdout — which was
the only way the probe's own output was recovered.

### 4 — did not reproduce

```
$ agent create-chat 2>&1 | cat -A
78ebef49-44a5-4b5c-816f-afa07ff9613f$
```

A bare uuid, nothing on stderr, no trailing newline. The report's `| tail -1` was
guarding against something not present today — plausibly a transient update banner.
The hardening is still worth two lines, but as insurance, not as a fix. Note `tail -1`
only helps if a banner comes *first*; a uuid-shape extraction is correct either way.

### 5 — real gap, now with numbers

`SKILL.md` states no ceiling and no disk expectation. **12 concurrent runs completed
12/12 clean in 39 s** on 16 cores — above the 10 the report verified, with no
throttling or refusal. Trivial runs are ~5.5 KB of jsonl; the report's 690 KB–2.1 MB
for real refining work is consistent and unchallenged. The binding constraint is
memory, not the API: this box has **7 GB** and each agent is a full Node process.

### 6 — real

`sed -n '1p'` reads only the first line. The init event was line 1 in all five runs,
so this has never fired wrongly — but matching the first line that *has* a `model`
field is strictly safer at no cost.

### N1 — the guard the Composer change would disable

`cursor-run.sh:55` gates the identity check on `[ "$MODEL" = "$PINNED_MODEL" ]`.
Any other model is verified against `*Fast*` and nothing else. Proven:

```
$ cursor-run.sh --key composer --model composer-2.5 …
model: Composer 2.5
✓ composer finished.          # exit 0, identity never checked
```

Pointing pre-flight at `composer-2.5` under today's launcher means pre-flight runs
**with the effort-drop guard switched off** — the exact failure the pin exists to
catch. Per-role pinning is therefore not a convenience; it is what keeps the
guarantee intact once there is more than one model.

### N2 — no tests

`grep -c cursor test.mjs` → `0`. The launcher's five guards are load-bearing and
nothing in CI touches them.

---

## Part 2 — The model split

| Role | Model id | Init event must read |
|---|---|---|
| Chips (the coder) | `cursor-grok-4.6-xhigh` | `Cursor Grok 4.6 Extra High` |
| Pre-flight | `composer-2.5` | `Composer 2.5` |
| Refining agents | `cursor-grok-4.6-xhigh` | `Cursor Grok 4.6 Extra High` |

Both ids confirmed present in `agent --list-models` on this account, and both shown
names confirmed from a real init event. The coder is unchanged, as asked.

**Refining agents are left on Grok 4.6 Extra High** — they were not mentioned, and
they read the codebase and rewrite plans, which is the coder's kind of work rather
than pre-flight's. Say so if that should change; it is one table row.

`composer-2.5` carries **no effort suffix**, so the "effort suffix was dropped"
wording must become role-aware. The `-fast` refusal stays global — `composer-2.5-fast`
exists and must be refused like the rest.

---

## Part 3 — Work items

Interfaces are fixed here, verbatim, so that every item below can be built at the
same time without waiting to see another item's code.

### W1 — per-role pins in `cursor-run.sh`

Add `--role {refine|preflight|chip}`, required. A table maps role → (model id,
expected shown name). Verification becomes **unconditional**: the shown name is
compared against the role's expected name on every run, never skipped.

- `--model` and `CURSOR_ORCH_MODEL` stay as an escape hatch, but an override must
  supply `CURSOR_ORCH_MODEL_SHOWN` (or `--model-shown`) or the run is refused.
  Closing N1 means no path reaches `agent` with verification off.
- `-fast` refusal unchanged, still applied to both the flag and the env var.
- Mismatch message drops "the effort suffix was dropped" in favour of
  `asked for <id> (role <role>) but ran on "<shown>"`, correct for a suffix-less id.

### W2 — make the runtime deterministic

The fix cannot live in the launcher's own shell — correct in the report — so the
launcher **writes it into the prompt** instead of asking every brief author to
remember it.

- New `--node-bin <dir>` (and `CURSOR_ORCH_NODE_BIN`). When set, the launcher
  prepends one line to the prompt it sends: a standing instruction that every
  command depending on the project's runtime must begin
  `export PATH="<dir>:$PATH";`, because bare `node` inside the agent is the login
  profile's default and not the launcher's.
- When unset, nothing is injected — projects that do not pin a runtime pay nothing.
- `SKILL.md` gains a gotcha stating the mechanism as probed: **`PATH` inside an agent
  is rebuilt from the login profile; the launcher's exports do not order it. Every
  other environment variable propagates untouched.** Both halves, together, so the
  next reader does not over-engineer #2.
- The chip preamble in §3 gains a fourth numbered point carrying the same rule, since
  the preamble is the one text every chip reads.

### W3 — `scripts/cursor-result.sh <log-path-or-key>`

Ship the parser instead of having every caller rewrite it.

- Default: print each `type=="result"` `result` string.
- `--tool-output`: dump every `shellToolCall` stdout/stderr/exitCode. This is the
  mode that recovers a run whose final message never arrived.
- `--last`: the final result string only.
- If there is no result line, print the log's last non-JSON line to stderr and exit 1.
  Silent success on a dead run is the bug being fixed.
- Exit 1 when the run's result carries `is_error`.
- Resolves a bare key against `${CURSOR_ORCH_LOG_DIR:-.claude/orchestration/cursor}/<key>.jsonl`.

### W4 — `scripts/cursor-chat.sh`

Prints a chat uuid or fails loudly.

```sh
CID=$(agent create-chat 2>/dev/null | tr -d '\r' \
      | grep -Eoi '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1)
[ -n "$CID" ] || { echo "✗ create-chat produced no uuid" >&2; exit 1; }
```

Shape extraction, not `tail -1` — it survives a banner on either side. `SKILL.md` §3
calls this instead of `agent create-chat` directly.

### W5 — first line that *has* a model, and a visible error tail

- `SHOWN=$(grep -m1 -o '"model":"[^"]*"' "$LOG" | head -1 | cut -d'"' -f4)`.
- On failure, quote the log's last line in the error rather than only naming the file,
  so a `NonRetriableError` tail is readable without opening anything.

Same file as W1 and W5 — **one chip owns `cursor-run.sh`**.

### W6 — write the operating envelope down, and push parallelism up

- Gotcha: expect **~5 KB for a trivial run, 0.7–2 MB for real refining work**; a
  ten-plan act is roughly 15 MB of jsonl, and the directory is never pruned.
- Gotcha: **12 concurrent runs verified clean** (16 cores, 39 s, 12/12); no
  server-side throttling seen. Memory is the ceiling to watch, not the API — each
  agent is a full Node process and this box has 7 GB.
- §1 and §3 change from "launched as background so they run together" to an explicit
  instruction: **launch the entire eligible set in one round, up to 12 in flight**,
  and widen as work lands rather than pacing them out. The parent's interference rule
  is what limits the set — same file or same serialisation point means one waits —
  never caution about the runner itself.

### W7 — tests

`test.mjs` gains a `cursor-run.sh` block driven by a **stub `agent`** on `PATH` that
emits canned jsonl. Hermetic, no network, no login, CI-safe. Cases:

1. `-fast` refused via `--model`, and via `CURSOR_ORCH_MODEL`.
2. Each role launches with its own model id.
3. Shown name mismatching the role's expected name → exit 1.
4. Override without `CURSOR_ORCH_MODEL_SHOWN` → refused **(this is N1's regression test)**.
5. Init event not on line 1 → still read correctly (W5).
6. Log with no init event → exit 1.
7. Log ending in a non-JSON error line → exit 1, tail quoted.
8. `cursor-result.sh`: normal result, `--tool-output`, no-result-line, `is_error`.
9. `cursor-chat.sh`: bare uuid; uuid after a banner; no uuid → exit 1.

---

## Part 4 — How to run it, in parallel

Five chips, all in the first wave. They are disjoint by file, which is the parent's
own condition for running together — no item below waits on another.

| Chip | Owns | Items |
|---|---|---|
| A | `claude-cursor/scripts/cursor-run.sh` | W1, W2 (launcher half), W5 |
| B | `claude-cursor/scripts/cursor-result.sh` *(new)* | W3 |
| C | `claude-cursor/scripts/cursor-chat.sh` *(new)* | W4 |
| D | `claude-cursor/SKILL.md` | W2 (docs + preamble), W6 |
| E | `test.mjs` | W7 |

E normally waits on A–C. It does not here: Part 3 fixes every flag, exit code and
message shape that E asserts against, so E is written to the contract, not to the
code. If A ships something the contract does not describe, A is wrong.

Chips run on `cursor-grok-4.6-xhigh`; pre-flight on `composer-2.5` — which is itself
the first live exercise of the new split, since pre-flight for this very plan runs
under the model being introduced. Pre-flight must run **after** A lands, or with an
explicit `--model-shown`, or it trips the guard it is meant to validate.

Gate order is the parent's, unchanged: `graph` green → `preflight check` → `doctor` →
chips.

## Part 5 — Done means

1. `node test.mjs` green, including the nine new cases.
2. `--role preflight` runs `composer-2.5` **and refuses** a log whose init reads
   anything but `Composer 2.5` — N1 closed, checked by forcing a mismatch.
3. `--role chip` still refuses anything but `Cursor Grok 4.6 Extra High`.
4. `cursor-result.sh` exits 1 and prints the error tail on the saved
   `NonRetriableError` log kept as a fixture.
5. A real end-to-end act: refine → pre-flight (Composer 2.5) → chips (Grok 4.6 xhigh),
   with the pre-flight before/after `git status` diff empty, exactly as §2 requires.

## Left alone deliberately

- **The pre-flight before/after diff, the read-back model check, "liveness is the log
  not `ps`", `--trust`/`--force` on every run, `driver.mjs resume` finding nothing,
  the three-point chip preamble.** The report defends these and the probes agree.
  W2 adds a fourth preamble point; it does not touch the three that are there.
- **Finding 4's premise.** The uuid hardening ships because it is two lines, not
  because a break was observed. Recorded as insurance so nobody later "confirms" a
  bug that was never reproduced.
