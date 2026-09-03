# Running steps on DeepSeek, through opencode

`claude-cursor` runs every step on the Cursor CLI. This adds a second runner —
opencode, on `opencode-go/deepseek-v4-flash` — and asks which one to use when the
skill starts.

Everything here is in `claude-cursor/`. No build, no dependencies. `test.mjs`
drives `orchestrate.mjs` end to end and already has a stub-`agent` pattern to
copy for a stub `opencode` (from line 2987, and again at the `widening the round`
group).

## What was checked, 2026-09-03

opencode **1.18.27**, installed at `/home/centralserver/.opencode/bin/opencode`,
authenticated against the `opencode-go` provider with an API key in
`~/.local/share/opencode/auth.json`. Config at `~/.config/opencode/opencode.jsonc`
is empty apart from its `$schema`. Session state is SQLite at
`~/.local/share/opencode/opencode.db`.

Three DeepSeek models are on the account:

```
opencode-go/deepseek-v4-flash
opencode-go/deepseek-v4-flash-vision-exp
opencode-go/deepseek-v4-pro
```

**"DeepSeek V4 Flash·max" is a model plus a variant, not a model.** `opencode
run` takes `--variant` — "provider-specific reasoning effort, e.g., high, max,
minimal" — so the thing asked for is:

```bash
opencode run -m opencode-go/deepseek-v4-flash --variant max --format json …
```

That maps onto the existing ladder cleanly: a tier already means "a model", and
it now means "a model and a variant".

### The interface, verified by running it

| what the runner needs | Cursor (`agent`) | opencode (`opencode run`) |
|---|---|---|
| unattended | `-p --force --trust` | `--auto` |
| working directory | `--workspace` | `--dir` |
| model | `--model` | `-m provider/model` |
| effort | part of the model name | `--variant` |
| machine-readable log | jsonl on stdout | `--format json` |
| resume a conversation | `--resume <chat-uuid>` | `-s <sessionID>` |
| where the id comes from | minted first by `cursor-chat.sh` | **falls out of the run's own log** |

A real run was made against `deepseek-v4-flash --variant max`. It emits one JSON
object per line:

```json
{"type":"step_start",  "timestamp":…, "sessionID":"ses_f97ef8e28ffe…", "part":{…}}
{"type":"text",        "timestamp":…, "sessionID":"ses_f97ef8e28ffe…", "part":{"text":"OK", "time":{"start":…,"end":…}}}
{"type":"step_finish", "timestamp":…, "sessionID":"ses_f97ef8e28ffe…", "part":{"reason":"stop","tokens":{"total":8424,"input":6603,"output":29,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0.001484344}}
```

Two things follow that make this **simpler** than the Cursor path:

- **`sessionID` is on every event**, so there is no chat to mint before the run.
  `cursor-chat.sh` exists because Cursor needs an address before it has a
  conversation; opencode hands the address back in the log. `run open` does not
  need to call anything for opencode, and `sendback` reads the id out of the
  record.
- **`step_finish` carries `tokens` and `cost`**, which Cursor's log does not. The
  record can hold what a step actually cost.

An unknown model fails loudly and usefully:

```json
{"type":"error","timestamp":…,"sessionID":"ses_…","error":{"name":"UnknownError","data":{"message":"Unexpected server error…","ref":"err_5ee95cd6"}}}
```

## The three problems

### 1. Nothing in the log says which model ran

This is the important one, and it is a real loss.

The Cursor path treats model verification as load-bearing. `models.json` says so
in its own words: *"asking for a model is not the same as getting it, and effort
suffixes have been dropped silently"*. `run.sh` reads the model out of the
agent's opening event and `run record` files the run as `wrong-model` when it
does not match, because two finished runs were once discarded for exactly that.

**opencode's JSON stream carries no model field at all.** Not in `step_start`,
not in `step_finish`. There is nothing to compare against.

### 2. An invalid `--variant` is accepted silently

```bash
opencode run -m opencode-go/deepseek-v4-flash --variant bogus-xyz --format json "hi"
```

returns a normal answer and a normal `step_finish`. No error, no warning, no
field naming the variant that was used. So a typo in `max` costs the reasoning
effort the tier was chosen for, and **nothing anywhere would say so** — which is
the precise failure the Cursor ladder was built to prevent.

Together, 1 and 2 mean: on the opencode path, *what you asked for is all you
know*. That is a genuine drop in what the record can prove, and it is a decision
for the user rather than something to paper over. See **Decisions** below.

### 3. `opencode` is not on the non-interactive PATH

`bash -lc 'opencode --version'` fails. It is on the interactive PATH only, added
by `~/.bashrc`:

```
export PATH=/home/centralserver/.opencode/bin:$PATH
```

The skill's own gotcha already covers this shape of problem — *"`PATH` inside an
agent is rebuilt from the login profile"* — and the launcher must therefore
resolve the binary rather than assume it. Same class as `--node-bin`.

## Settled, 2026-09-03

- **One model, and only one.** `opencode-go/deepseek-v4-flash`. Not
  `-vision-exp`, not `-pro`. A tier therefore means an *effort*, nothing else.
- **D1(a).** The record says what was asked for and marks it `modelVerified:
  false`. With one model there is nothing to confuse it with, so the Cursor
  path's model-comparison machinery is not ported at all — the orchestrator
  knowing which runner the round is on is the whole of it.
- **D2 — the ladder is effort only.** `deepseek-v4-flash` accepts exactly
  `low`, `high`, `max` (below). High is right for most work; easy steps drop
  lower; only the hardest go to `max`. Cursor's rows are not compared against
  these — the two ladders are separate things that share a tier vocabulary.
- **D3(a).** The runner is chosen once, before `load`, and the round is
  automated from there.

### The efforts are knowable, and a wrong one is catchable

`~/.cache/opencode/models.json` is opencode's own registry, and it states the
effort vocabulary per model:

```json
"reasoning_options": [ { "type": "effort", "values": ["low", "high", "max"] } ]
```

Effort names vary sharply by model — `grok-4.6` takes `low, medium, high,
xhigh`, `gpt-5.6-luna` takes `none … max`, and many models take none at all.
`minimal`, the example in `opencode run --help`, is **not** valid for
`deepseek-v4-flash`, which is why the probe's bogus variant was accepted in
silence.

So problem 2 is largely answered: **the launcher validates the effort against
this registry before spending anything.** What cannot be checked is what
answered; what can be checked is that what was asked for is a thing this model
accepts. That guard is cheap and belongs in `S-1`.

The mapping, five tiers onto three efforts:

| tier | effort | why |
|---|---|---|
| `composer` | `low` | mechanical, no judgement |
| `low` | `low` | small and well specified |
| `medium` | `high` | ordinary feature work |
| `high` | `high` | the default |
| `xhigh` | `max` | security, concurrency, wide blast radius |

`composer` and `low` are one effort, and so are `medium` and `high`. That is a
real collapse and it should be visible in the table rather than implied, so
`assess` shows the effort beside the tier on this runner.

## The decisions as they were put (kept for the reasoning)

**D1 — What does the record say about a DeepSeek run's model?** *(the one that
matters)*

- **(a) Record it as requested, and mark it unverified. (Recommended.)**
  `run record` files `model: "opencode-go/deepseek-v4-flash"`, `variant: "max"`,
  `modelVerified: false`. `doctor` and `board` show unverified runs as such.
  ✓ gain — the round runs, and the record never claims to know something it
  cannot.
  ✕ cost — a step silently served by a weaker model or a dropped variant is
  recorded as if it ran on what was asked for. Nothing catches it. On the Cursor
  path that was caught twice in one round.
- **(b) Ask the model to name itself in the brief, and check the answer.**
  ✓ gain — some signal where there is none now.
  ✕ cost — a model's claim about itself is not evidence; it is the same class of
  answer the Cursor path already refuses to trust, and it would read as a
  verification while proving nothing. Worse than (a), because it looks green.
- **(c) Keep DeepSeek off the tiers that matter.** Allow it only for `composer`
  and `low` — mechanical work where a silent downgrade costs little.
  ✓ gain — the unverifiable runner is confined to steps where being wrong is
  cheap.
  ✕ cost — most of the round still runs on Cursor, so most of the speed and cost
  saving is not realised. It answers the risk by not taking it.

**D2 — How do five tiers map onto three DeepSeek models?**

The ladder is `composer → low → medium → high → xhigh`. DeepSeek offers `flash`,
`flash-vision-exp` (experimental, vision), and `pro`, each with variants.

- **(a) Two models, variants carry the effort. (Recommended.)**
  `composer`/`low`/`medium` → `deepseek-v4-flash` at `minimal`/`high`/`max`;
  `high`/`xhigh` → `deepseek-v4-pro` at `high`/`max`.
  ✓ gain — the tier keeps meaning "how much thinking this step gets", which is
  what every `assess` row was written against.
  ✕ cost — the variant names are guesses beyond `max`, `high` and `minimal`,
  which are the three the help text names. Any other spelling is silently
  ignored (problem 2), so the ladder must be built only from those three.
- **(b) `deepseek-v4-flash` for everything, variant only.**
  ✓ gain — one model, so one thing to be wrong about; matches what was asked for
  literally.
  ✕ cost — `xhigh` exists for security, concurrency and wide blast radius. Giving
  that work a flash model because it is the same row as a rename is the decision
  the ladder was built to stop.
- `deepseek-v4-flash-vision-exp` is left out of the ladder either way: nothing
  here sends images, and `-exp` is not what `xhigh` steps should ride on.

**D3 — Is the runner chosen per round, or per step?**

- **(a) Per round, asked once at the start. (Recommended.)** Matches what was
  asked for, and keeps one round's records comparable.
  ✓ gain — one question, one answer, and `board` reads consistently.
  ✕ cost — a round cannot put its one `xhigh` security step on Cursor and the
  other nine on DeepSeek, which is the cheapest sensible split.
- **(b) Per step, defaulting to the round's answer.** `assess set S-2=high` gains
  a sibling `assess runner S-2=cursor`.
  ✓ gain — the split above becomes possible, and D1(c) stops being a separate
  decision because it falls out of this one.
  ✕ cost — a second dimension in the `assess` table and in every brief, and two
  runners in flight in one round means two log formats to harvest in one loop.

## The work

Ordered so that the shared file lands before anything that reads it.

### S-1 — the ladder learns about runners *(the seam; lands first)*

`claude-cursor/models.json`, `claude-cursor/scripts/models.mjs`.

`models.json` is a Cursor ladder with `{rank, tier, id, accepts}` rows. It grows
a runner dimension:

```jsonc
{
  "runners": {
    "cursor":   { "bin": "agent",    "ladder": [ …the five rows as they are now… ] },
    "opencode": { "bin": "opencode", "resolve": "PATH,~/.opencode/bin",
                  "verifiable": false,
                  "ladder": [ {"rank":1,"tier":"composer","id":"opencode-go/deepseek-v4-flash","variant":"minimal"}, … ] }
  }
}
```

`accepts` stays on the Cursor rows only, and `verifiable: false` is what carries
problem 1 into the code rather than into a comment. `models.mjs` takes a runner
argument everywhere it takes a tier today, and `models sync` keeps reading
`agent --list-models` for Cursor while reading `opencode models <provider>` for
opencode.

**Proof:** `node scripts/models.mjs resolve --runner opencode xhigh` prints the
model and variant; the existing Cursor resolutions are unchanged.

### S-2 — the opencode launcher

New file `claude-cursor/scripts/run-opencode.sh`, beside `run.sh`.

Same contract as `run.sh` so `run open` can print either line: takes `--role`,
`--tier`, `--key`, `--workspace`, `--prompt-file`, optional `--session`. It
resolves the binary (problem 3) by trying `PATH` then `~/.opencode/bin/opencode`,
and fails with a sentence rather than `command not found`. It writes the raw
jsonl to `.claude/orch/logs/<key>.jsonl` and the same
`.claude/orch/runs/<key>.status` line the Cursor launcher writes, because
`run record` reads that and not the exit code.

Maps to: `--dir <workspace>`, `-m <id>`, `--variant <variant>`, `--auto`,
`--format json`, and `-s <session>` when resuming.

**Proof:** a stub `opencode` on `PATH` in the test sandbox, as the stub `agent`
is done today.

### S-3 — harvesting an opencode run

New file `claude-cursor/scripts/harvest-opencode.mjs`.

`harvest.mjs` parses Cursor's events into `{outcome, seconds, files, commands,
answer}`. This produces the same shape from opencode's, so everything downstream
is unchanged — the record shape is already the contract that lets a Claude Code
step be recorded with `--json`.

- `outcome` — `passed` unless an `{"type":"error"}` event is present.
- `seconds` — last `timestamp` minus first.
- `answer` — the concatenated `text` parts.
- `sessionID` — off any event; this is what `sendback` resumes on.
- `tokens` and `cost` — from `step_finish`, new fields the Cursor path has no
  values for.
- `files` and `commands` — from the tool events. **A real coding run has to be
  captured to see those**; the probe was a one-line reply and showed only
  `step_start`, `text`, `step_finish`. This is the one thing in this plan that
  cannot be written without looking at a real run first.

**Proof:** a recorded opencode run in `fixtures/`, harvested, asserted field by
field — the way `fixtures/recorded-run` already backs the Cursor harvester.

### S-4 — streaming, so a backgrounded run is not silent

`claude-cursor/scripts/stream.mjs`, `claude-cursor/scripts/watch.sh`.

`stream.mjs` formats Cursor's events into a readable account. It gains an
opencode branch keyed off the event shape (`type` + `part.type` rather than
Cursor's). `--thinking` is available on `opencode run` and belongs behind the
existing `--quiet-think` flag.

**Proof:** replaying the S-3 fixture through the formatter prints a readable
account and stops when the run stops.

### S-5 — choosing the runner, and telling the agent

`claude-cursor/orchestrate.mjs`.

- A `runner` on the round (D3a) or on the step (D3b), recorded in state and shown
  by `board` and `assess`.
- `run open` prints the launcher line for the chosen runner, and skips minting a
  chat for opencode because the session does not exist until the run does.
- `sendback` emits `-s <sessionID>` instead of `--resume <uuid>`.
- `run record` routes to the right harvester by runner.
- `doctor` fails a round whose runner is not resolvable, and says so once rather
  than per step.
- Under D1(a): `board` marks unverified runs, so "this round ran unverified" is
  visible without reading the records.

**Proof:** the `five stages, in order` group runs a second time against a stub
`opencode`, asserting the same lifecycle.

### S-6 — asking, and writing it down

`claude-cursor/SKILL.md`, and the question itself.

The skill asks once, at the start, before `load`:

> **Which runner should this round use?**
> · **Cursor** — the model that actually ran is checked against what was asked
>   for. Slower and dearer.
> · **DeepSeek (opencode)** — cheaper and faster. Nothing can confirm which model
>   answered, so a silent downgrade would not be caught.

Per `reference/plain-words.md`: one decision, under 28 words, and every answer
carries its real cost. SKILL.md gains a `## Runners` section and the two
verification facts move into `## Gotchas`, where the `PATH` gotcha already lives.

**Proof:** SKILL.md names both runners and states the verification difference.

## What this must not do

- **Not one launcher with a runner `if`.** `run.sh` is 8 KB of Cursor-specific
  retry, model-checking and status handling. A second runner belongs beside it,
  sharing only the `.status` contract.
- **Not a silent fallback to Cursor** when opencode is missing. That spends money
  on a different ladder than the one the user chose. Fail and say so.
- **Not `--auto` without saying so in the brief.** It auto-approves every
  permission that is not explicitly denied, which is the right setting for an
  unattended worktree run and the wrong one to leave undocumented.
- **Not a claim that the model was verified.** Whatever D1 decides, the record
  must not carry a `model` field that reads the same as a Cursor one when nothing
  checked it.

## Open, and needing a real run

- The tool-event shape for `files` and `commands` (S-3). One real coding run
  against a scratch repo settles it.
- Which variant names `opencode-go` honours beyond `max`, `high`, `minimal`.
  Since a wrong one is silently ignored, the ladder should only use names the
  help text states until something can confirm more.
