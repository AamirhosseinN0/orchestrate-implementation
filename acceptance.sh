#!/usr/bin/env bash
#
# NOTE: needs a real recorded run at ./replay/.claude/orchestration/ — copy one
# from a project that has used this skill. Without it every case skips.
# Independent acceptance harness for the bug-hunt fixes.
#
# Written against the AUDIT, not against the fixes — every case here is a bug
# that was reproduced on the unfixed driver (commit 7b8b050). Run it with the
# path to a driver:
#
#     bash acceptance.sh /path/to/driver.mjs
#
# Each case prints PASS (the bug is gone), FAIL (still there), or SKIP.
# Exit 0 only when nothing failed.

DRV="${1:?usage: acceptance.sh /path/to/driver.mjs}"
DRV="$(cd "$(dirname "$DRV")" && pwd)/$(basename "$DRV")"
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORPUS="$BASE/replay"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/accept.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0; SKIP=0
declare -a FAILED

ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED+=("$1"); printf '  \033[31mFAIL\033[0m  %s\n     → %s\n' "$1" "$2"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[33mSKIP\033[0m  %s (%s)\n' "$1" "$2"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

corpus() {
  local d="$WORK/c$RANDOM$RANDOM"
  cp -r "$CORPUS" "$d" && chmod -R u+w "$d" && echo "$d"
}
fresh() {
  local d="$WORK/f$RANDOM$RANDOM"; mkdir -p "$d/docs/plans"
  printf '# a plan\n\nSomething is TBD here.\n' > "$d/docs/plans/p1.md"
  ( cd "$d" && node "$DRV" load docs/plans/p1.md >/dev/null 2>&1 )
  echo "$d"
}
# how big the real corpus actually is, so nothing is hardcoded to a stale number
REF=$(corpus)
REF_TASKS=$(cd "$REF" && node -e 'const r=require("./.claude/orchestration/register.json");console.log((r.tasks||[]).length)')
REF_BYTES=$(cd "$REF" && wc -c < .claude/orchestration/register.json)
printf 'corpus: %s tasks, %s-byte register, %s events\n' \
  "$REF_TASKS" "$REF_BYTES" "$(wc -l < "$REF/.claude/orchestration/events.jsonl")"

# ─────────────────────────────────────────────────────────── wave 1: parser

head_ "Wave 1 — the argument parser"

d=$(corpus)
K=$(cd "$d" && node -e 'const r=require("./.claude/orchestration/register.json");console.log(r.tasks[0].key)')
out=$(cd "$d" && node "$DRV" heard "$K" --kind note --text "--force was what I ran" 2>&1)
got=$(cd "$d" && tail -1 .claude/orchestration/messages.jsonl \
      | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).text)}catch{console.log("<unparseable>")}})')
[ "$got" = "--force was what I ran" ] \
  && ok "a --text value beginning with -- is kept verbatim" \
  || bad "a --text value beginning with -- is kept verbatim" "stored: $got"

out=$(cd "$d" && node "$DRV" heard "$K" --kind note --text 2>&1); c=$?
[ $c -ne 0 ] && ok "a bare --text is refused, not recorded as true" \
             || bad "a bare --text is refused, not recorded as true" "exit $c: $out"

out=$(cd "$d" && node "$DRV" defect add --task "$K" --kind bug --what w --evidence="--force" 2>&1)
got=$(cd "$d" && node -e 'const r=require("./.claude/orchestration/register.json");console.log(r.defects[r.defects.length-1].evidence)')
[ "$got" = "--force" ] && ok "--evidence=--value survives instead of becoming empty" \
                       || bad "--evidence=--value survives instead of becoming empty" "stored: '$got'"

out=$(cd "$d" && node "$DRV" defect list --alll 2>&1); c=$?
[ $c -ne 0 ] && ok "a misspelled flag is reported, not ignored" \
             || bad "a misspelled flag is reported, not ignored" "exit $c"

out=$(cd "$d" && node "$DRV" board --register 2>&1); c=$?
case "$out" in
  *"    at "*) bad "--register with no value gives an error, not a stack trace" "stack trace" ;;
  *) [ $c -ne 0 ] && ok "--register with no value gives an error, not a stack trace" \
                  || bad "--register with no value gives an error, not a stack trace" "exit 0" ;;
esac

allbad=1
for v in bogus 0 -5 999999; do
  out=$(cd "$d" && node "$DRV" rebuild --to "$v" 2>&1); c=$?
  [ $c -eq 0 ] && allbad=0
done
[ $allbad -eq 1 ] && ok "rebuild --to refuses every out-of-range value" \
                  || bad "rebuild --to refuses every out-of-range value" "one of bogus/0/-5/999999 exited 0"

# ──────────────────────────────────────────────────────────── wave 2: record

head_ "Wave 2 — the record"

d=$(corpus)
( cd "$d" && rm -f .claude/orchestration/events.jsonl && node "$DRV" iam zed >/dev/null 2>&1 )
( cd "$d" && node "$DRV" rebuild >/dev/null 2>&1 )
after=$(cd "$d" && wc -c < .claude/orchestration/register.json)
tasks=$(cd "$d" && node -e 'try{const r=require("./.claude/orchestration/register.json");console.log((r.tasks||[]).length)}catch{console.log(0)}')
if [ "$tasks" -ge "$REF_TASKS" ] && [ "$after" -gt $((REF_BYTES / 2)) ]; then
  ok "losing events.jsonl no longer lets rebuild destroy the register"
else
  bad "losing events.jsonl no longer lets rebuild destroy the register" \
      "register $REF_BYTES → $after bytes, tasks $REF_TASKS → $tasks"
fi

d=$(corpus)
mkdir -p "$d/.claude/orchestration/register.json.lock"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.ppid,host:require("os").hostname(),since:new Date().toISOString()}))' \
  "$d/.claude/orchestration/register.json.lock/holder.json"
out=$(cd "$d" && timeout 25 node "$DRV" rebuild 2>&1); c=$?
[ $c -ne 0 ] && ok "rebuild respects a lock held by a live process" \
             || bad "rebuild respects a lock held by a live process" "wrote anyway (exit 0)"
rm -rf "$d/.claude/orchestration/register.json.lock"

d=$(corpus)
HALF=$(( $(wc -l < "$d/.claude/orchestration/events.jsonl") * 3 / 4 ))
( cd "$d" && node "$DRV" rebuild --to "$HALF" >/dev/null 2>&1 )
out=$(cd "$d" && node "$DRV" verify 2>&1); c=$?
[ $c -eq 0 ] && ok "a partial rebuild does not leave the record and register drifted" \
             || bad "a partial rebuild does not leave the record and register drifted" \
                    "verify exit $c — $(echo "$out"|head -1)"

d=$(corpus)
( cd "$d" && node "$DRV" --register "$d/.claude/orchestration/register.json" iam probe-name >/dev/null 2>&1 )
out=$(cd "$d" && node "$DRV" events --n 1 2>&1 | sed -n 1p)
case "$out" in
  *iam*) ok "the record names the command even when --register comes first" ;;
  *)     bad "the record names the command even when --register comes first" "shows: $(echo "$out"|cut -c1-64)" ;;
esac

d=$(corpus)
rm -f "$d/.claude/orchestration/events.jsonl"; mkdir -p "$d/.claude/orchestration/events.jsonl"
out=$(cd "$d" && node "$DRV" verify 2>&1)
case "$out" in
  *"    at "*) bad "a directory-shaped events.jsonl gives an error, not a stack trace" "stack trace" ;;
  *)          ok "a directory-shaped events.jsonl gives an error, not a stack trace" ;;
esac

# ────────────────────────────────────────────────────── wave 3: dispatch/guard

head_ "Wave 3 — dispatch, ownership and the guard"

d=$(fresh)
cat > "$d/t.json" <<'J'
[{"key":"P","title":"first","plan":"docs/plans/p1.md","owns":["src/shared.py"],"needs":[]},
 {"key":"Q","title":"second","plan":"docs/plans/p1.md","owns":["src/shared.py"],"needs":[]}]
J
addout=$(cd "$d" && node "$DRV" task add < t.json 2>&1); addc=$?
if [ $addc -ne 0 ]; then
  ok "task add refuses a second task claiming a path already owned"
else
  bad "task add refuses a second task claiming a path already owned" "accepted both"
fi

# the chip-level gate, through a serialisation point task add does not police
d2=$(fresh)
cat > "$d2/t3.json" <<'J'
[{"key":"R","title":"third","plan":"docs/plans/p1.md","owns":["src/r.py"],"needs":[],"serialises":["the migration head"]},
 {"key":"S","title":"fourth","plan":"docs/plans/p1.md","owns":["src/s.py"],"needs":[],"serialises":["The Migration Head "]}]
J
( cd "$d2" && node "$DRV" task add < t3.json >/dev/null 2>&1 )
( cd "$d2" && node "$DRV" chip R --id cr >/dev/null 2>&1 )
out=$(cd "$d2" && node "$DRV" chip S --id cs 2>&1); c=$?
[ $c -ne 0 ] && ok "a second chip sharing a serialisation point is refused (spelling and all)" \
             || bad "a second chip sharing a serialisation point is refused (spelling and all)" "both opened"

# guard: a rename out of an unowned path, on a repo whose default branch is not main
g="$WORK/g$RANDOM"; mkdir -p "$g/src" "$g/other"
( cd "$g" && git init -q . && git config user.email t@t && git config user.name t
  echo mine > src/mine.ts; echo SECRET > other/config.ts; echo x > README.md
  git add -A && git commit -qm init && git branch -M trunk
  git checkout -qb feat && git mv other/config.ts src/config.ts
  echo changed > src/mine.ts && git add -A && git commit -qm sneak && git checkout -q trunk )
mkdir -p "$g/.claude/orchestration"
node -e '
const fs=require("fs");
fs.writeFileSync(process.argv[1],JSON.stringify({version:1,created:new Date().toISOString(),
plans:[],gaps:[],orchestrator:"t",notes:[],tasks:[{key:"1.1",title:"only src",plan:"p.md",
needs:[],owns:["src"],serialises:[],context:[],verify:[],decisions:[],status:"dispatched",
branch:"feat",worktree:process.argv[2],chip:"c1",agent:"a1",reports:[]}]},null,2)+"\n")' \
  "$g/.claude/orchestration/register.json" "$g"
( cd "$g" && node "$DRV" log reseed --why fixture >/dev/null 2>&1 )
out=$(cd "$g" && node "$DRV" guard 1.1 --base trunk 2>&1); c=$?
if [ $c -ne 0 ] && echo "$out" | grep -q "other/config.ts"; then
  ok "guard catches a file renamed out of a path the task does not own"
else
  bad "guard catches a file renamed out of a path the task does not own" "exit $c, no mention of other/config.ts"
fi

# and it finds the base itself, without --base
out=$(cd "$g" && node "$DRV" guard 1.1 2>&1); c=$?
echo "$out" | grep -q "other/config.ts" \
  && ok "guard derives the base branch instead of assuming main" \
  || bad "guard derives the base branch instead of assuming main" "$(echo "$out"|head -1|cut -c1-70)"

# guard: shell injection through the branch name
rm -f /tmp/claude-1000/PWNED_ACCEPT
i="$WORK/i$RANDOM"; mkdir -p "$i/.claude/orchestration"
( cd "$i" && git init -q . && git config user.email t@t && git config user.name t
  echo a > a && git add -A && git commit -qm i && git branch -M main )
node -e '
const fs=require("fs");
fs.writeFileSync(process.argv[1],JSON.stringify({version:1,created:new Date().toISOString(),
plans:[],gaps:[],orchestrator:"t",notes:[],tasks:[{key:"1.1",title:"x",plan:"p.md",needs:[],
owns:["a"],serialises:[],context:[],verify:[],decisions:[],status:"dispatched",
branch:"main; touch /tmp/claude-1000/PWNED_ACCEPT",worktree:process.argv[2],chip:"c1",agent:"a1",reports:[]}]},null,2)+"\n")' \
  "$i/.claude/orchestration/register.json" "$i"
( cd "$i" && node "$DRV" log reseed --why fixture >/dev/null 2>&1 )
( cd "$i" && node "$DRV" guard 1.1 --base main >/dev/null 2>&1 )
[ -e /tmp/claude-1000/PWNED_ACCEPT ] \
  && bad "a branch name cannot run a shell command" "the injected command executed" \
  || ok "a branch name cannot run a shell command"
rm -f /tmp/claude-1000/PWNED_ACCEPT

d=$(corpus)
L=$(cd "$d" && node -e 'const r=require("./.claude/orchestration/register.json");const t=r.tasks.find(x=>x.status==="landed");console.log(t?t.key:"")')
if [ -n "$L" ]; then
  out=$(cd "$d" && echo '{"verified":"nothing","outcome":"failed"}' | node "$DRV" done "$L" 2>&1); c=$?
  st=$(cd "$d" && node -e 'const r=require("./.claude/orchestration/register.json");console.log(r.tasks.find(x=>x.key===process.argv[1]).status)' "$L")
  { [ $c -ne 0 ] && [ "$st" = "landed" ]; } \
    && ok "done on a landed task is refused and does not un-land it" \
    || bad "done on a landed task is refused and does not un-land it" "exit $c, status now $st"
else
  skip "done on a landed task is refused" "no landed task in the corpus"
fi

P=$(cd "$d" && node -e 'const r=require("./.claude/orchestration/register.json");const t=r.tasks.find(x=>x.status==="planned"&&!x.chip);console.log(t?t.key:"")')
if [ -n "$P" ]; then
  out=$(cd "$d" && echo '{"verified":"v","outcome":"passed"}' | node "$DRV" done "$P" 2>&1); c=$?
  [ $c -ne 0 ] && ok "done on a task that was never handed out is refused" \
               || bad "done on a task that was never handed out is refused" "accepted"
else
  skip "done on a never-dispatched task is refused" "no planned task"
fi

d=$(corpus)
out=$(cd "$d" && node "$DRV" graph 2>&1)
case "$out" in
  *"Nothing clashes. Every round above can run side by side."*)
    bad "graph no longer claims an all-clear it did not check" "still prints the absolute wording" ;;
  *) ok "graph no longer claims an all-clear it did not check" ;;
esac

d=$(corpus)
sug=$(cd "$d" && node "$DRV" bundle suggest 2>&1 | grep -oE 'bundle [0-9A-Za-z.\-]+( [0-9A-Za-z.\-]+)* --into [0-9A-Za-z.\-]+' | head -1)
if [ -n "$sug" ]; then
  before=$(cd "$d" && node "$DRV" graph >/dev/null 2>&1; echo $?)
  bout=$(cd "$d" && node "$DRV" $sug 2>&1); bc=$?
  out=$(cd "$d" && node "$DRV" graph 2>&1); c=$?
  cancelled=$(cd "$d" && node -e 'const r=require("./.claude/orchestration/register.json");console.log(r.tasks.filter(t=>t.status==="cancelled").length)')
  if [ "$bc" -ne 0 ]; then
    bad "the bundle command that suggest prints actually runs" "exit $bc: $(echo "$bout"|head -1)"
  elif [ "$cancelled" -eq 0 ]; then
    bad "the bundle command that suggest prints absorbs its members" "nothing was cancelled"
  elif echo "$out" | grep -q "Cannot be ordered" || { [ "$before" -eq 0 ] && [ "$c" -ne 0 ]; }; then
    bad "bundling does not wedge the graph" "graph went $before → $c"
  else
    ok "bundling repoints dependents and leaves the graph orderable"
  fi
else
  skip "bundling leaves the graph orderable" "nothing suggested"
fi

# found while reconciling the prose: the gates sat behind `if (!t.chip)`, so a
# second chip call ran none of them — and what a task owns can widen after its
# first chip. Reachable via `chip <key> --id <new_id>` on an already-chipped task.
d3=$(fresh)
cat > "$d3/t4.json" <<'J'
[{"key":"A","title":"a","plan":"docs/plans/p1.md","owns":["src/a.py"],"needs":[],"serialises":["the migration head"]},
 {"key":"B","title":"b","plan":"docs/plans/p1.md","owns":["src/b.py"],"needs":[],"serialises":["the migration head"]}]
J
( cd "$d3" && node "$DRV" task add < t4.json >/dev/null 2>&1 )
( cd "$d3" && node "$DRV" chip A --id c1 >/dev/null 2>&1 )
node -e '
const fs=require("fs"),p=process.argv[1]+"/.claude/orchestration/register.json";
const r=JSON.parse(fs.readFileSync(p));const b=r.tasks.find(t=>t.key==="B");
b.chip="stale"; b.status="planned"; fs.writeFileSync(p,JSON.stringify(r,null,2)+"\n");' "$d3"
( cd "$d3" && node "$DRV" log reseed --why fixture >/dev/null 2>&1 )
out=$(cd "$d3" && node "$DRV" chip B --id c3 2>&1); c=$?
[ $c -ne 0 ] && ok "re-pointing an existing chip is gated too, not waved through" \
             || bad "re-pointing an existing chip is gated too, not waved through" "B opened alongside A"

# landed counted itself twice: t.status is set to landed before the count is taken
d4=$(fresh)
echo '[{"key":"A","title":"a","plan":"docs/plans/p1.md","owns":["src/a.py"],"needs":[]}]' \
  | ( cd "$d4" && node "$DRV" task add >/dev/null 2>&1 )
( cd "$d4" && node "$DRV" chip A --id c1 >/dev/null 2>&1 )
echo '{"verified":"ran true","outcome":"passed"}' | ( cd "$d4" && node "$DRV" done A >/dev/null 2>&1 )
out=$(cd "$d4" && node "$DRV" landed A --sha abc 2>&1 | awk '/landing\(s\) now sit/')
[ -z "$out" ] && ok "landed counts one landing as one, not two" \
              || bad "landed counts one landing as one, not two" "$out"

# board ran the address straight into the title on every row of a real run
d5=$(corpus)
collide=$(cd "$d5" && node "$DRV" board 2>&1 | node -e '
let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
  const rows=s.split("\n").filter(l=>/^\S+\s+[●○◐?]/.test(l));
  const hdr=s.split("\n").find(l=>l.startsWith("key"));
  if(!hdr||!rows.length){console.log("no-rows");return}
  const at=hdr.indexOf("title");
  const bad=rows.filter(l=>l.length>at && l[at-1]!==" ").length;
  console.log(bad?("collide:"+bad):"clear");});')
case "$collide" in
  clear) ok "board keeps the address out of the title column" ;;
  no-rows) skip "board column alignment" "no rows to measure" ;;
  *) bad "board keeps the address out of the title column" "${collide#collide:} row(s) run together" ;;
esac

# ─────────────────────────────────────────────────── wave 4: grill and ledger

head_ "Wave 4 — the grill and the ledger"

d="$WORK/s$RANDOM"; mkdir -p "$d/docs"
cat > "$d/docs/plan.md" <<'M'
# The plan

## Unresolved questions

The retry limit is TBD.
Timeouts should probably be configurable.

## Unanswered so far

The page size is a threshold somebody must pick.

## Open items

We might revisit this later.
M
( cd "$d" && node "$DRV" load docs/plan.md >/dev/null 2>&1 )
out=$(cd "$d" && node "$DRV" scan 2>&1)
n=$(echo "$out" | grep -cE '^\s*g[0-9]+')
[ "$n" -ge 3 ] \
  && ok "a section headed Unresolved or Unanswered is still scanned ($n gaps)" \
  || bad "a section headed Unresolved or Unanswered is still scanned" "only $n gap(s) found"

d="$WORK/l$RANDOM"; mkdir -p "$d/docs"
printf '# a plan\n\n## What is open\n\nThe retry limit is TBD.\nThe page size is a threshold somebody must pick.\n' > "$d/docs/plan.md"
( cd "$d" && node "$DRV" load docs/plan.md >/dev/null 2>&1 && node "$DRV" scan >/dev/null 2>&1 )
G=$(cd "$d" && node -e 'try{const r=require("./.claude/orchestration/register.json");const g=(r.gaps||[])[0];console.log(g?g.id:"")}catch{console.log("")}')
if [ -n "$G" ]; then
  out=$(cd "$d" && echo '{"text":"Should the normal form of the answer be stored, or recomputed each time?","options":[{"label":"Work it out each time","gain":"never stale","cost":"slower","recommended":true},{"label":"Store it","gain":"fast to read","cost":"more to keep right"}]}' | node "$DRV" question "$G" 2>&1); c=$?
  [ $c -eq 0 ] && ok "an ordinary English word like \"normal\" passes the plain-words lint" \
               || bad "an ordinary English word like \"normal\" passes the plain-words lint" "$(echo "$out"|head -2|tr '\n' ' ')"
  # and real jargon is still caught
  out=$(cd "$d" && echo '{"text":"Should the schema be denormalised for the endpoint?","options":[{"label":"Yes","gain":"fast","cost":"more to keep right","recommended":true},{"label":"No","gain":"simple","cost":"slower"}]}' | node "$DRV" question "$G" 2>&1); c=$?
  [ $c -ne 0 ] && ok "real jargon is still caught and named" \
               || bad "real jargon is still caught and named" "\"schema\" and \"endpoint\" passed"
else
  skip "plain-words lint cases" "no gap produced"
fi

d=$(fresh)
out=$(cd "$d" && node "$DRV" check 2>&1); c=$?
[ $c -ne 0 ] && ok "check refuses a register where nothing was ever scanned" \
             || bad "check refuses a register where nothing was ever scanned" "exit 0"

if grep -q "function cmdInbox" "$DRV"; then
  bad "the dead message subsystem is gone from the source" "cmdInbox is still defined"
else
  ok "the dead message subsystem is gone from the source"
fi

d=$(corpus)
K=$(cd "$d" && node -e 'const r=require("./.claude/orchestration/register.json");const t=r.tasks.find(x=>!["landed","cancelled"].includes(x.status));console.log(t?t.key:r.tasks[0].key)')
LONG=$(node -e 'console.log("I finished the work. "+"and then a further consideration that runs on and on ".repeat(80)+"but do not merge until the migration lands.")')
( cd "$d" && node "$DRV" heard "$K" --kind report --text "$LONG" >/dev/null 2>&1 )
# The property that matters is that UNBOUNDED agent text cannot bloat the digest.
# Some lines are long by the driver's own fixed wording ("reassign it (`owed
# assign …`) or settle it (…)"); those are bounded and are not the bug.
( cd "$d" && node "$DRV" digest > "$d/dg.txt" 2>&1 )
verdict=$(node -e '
const fs=require("fs");
const t=fs.readFileSync(process.argv[1],"utf8");
const tailLeaked = t.includes("but do not merge until the migration lands");
const agentLines = t.split("\n").filter(l=>l.includes("finished the work"));
const worst = agentLines.reduce((m,l)=>Math.max(m,l.length),0);
if (tailLeaked) console.log("FAIL:the 4000-char message reached the digest whole");
else if (worst > 200) console.log("FAIL:an agent line ran to "+worst+" chars");
else if (t.length > 20000) console.log("FAIL:the digest is "+t.length+" bytes");
else console.log("OK:"+t.length+" bytes, agent line clipped to "+worst);
' "$d/dg.txt")
case "$verdict" in
  OK:*)  ok "digest clips agent text rather than letting it bloat the list (${verdict#OK:})" ;;
  *)     bad "digest clips agent text rather than letting it bloat the list" "${verdict#FAIL:}" ;;
esac

# a release must not clear an unanswered question — only a reply does
d=$(corpus)
K=$(cd "$d" && node -e 'const r=require("./.claude/orchestration/register.json");const t=r.tasks.find(x=>!["landed","cancelled"].includes(x.status));console.log(t?t.key:"")')
if [ -n "$K" ]; then
  ( cd "$d" && node "$DRV" heard "$K" --kind question --text "which settings file did you mean" >/dev/null 2>&1 )
  ( cd "$d" && node "$DRV" say "$K" --kind release --text "released, rebase now" >/dev/null 2>&1 )
  out=$(cd "$d" && node "$DRV" outstanding 2>&1)
  echo "$out" | grep -q "asked you something" \
    && ok "a release does not clear an unanswered question" \
    || bad "a release does not clear an unanswered question" "the question vanished from outstanding"
else
  skip "a release does not clear an unanswered question" "no open task"
fi

# ────────────────────────────────────────────────────────────── wave 5: slot

head_ "Wave 5 — the shared machine slot"

d=$(corpus)
( cd "$d" && node "$DRV" slot take ci --task probe >/dev/null 2>&1 )
out=$(cd "$d" && timeout 20 node "$DRV" slot run ci --timeout 1 -- /bin/echo BARGED 2>&1)
echo "$out" | grep -q BARGED \
  && bad "a slot taken by hand actually holds against slot run" "the second command barged in" \
  || ok "a slot taken by hand actually holds against slot run"
( cd "$d" && node "$DRV" slot free ci --force >/dev/null 2>&1 )

d=$(corpus)
out=$(cd "$d" && timeout 30 node "$DRV" slot run ci -- FOO=1 /bin/echo hi 2>&1); c=$?
echo "$out" | grep -q '^hi$' \
  && ok "slot run handles a command with a leading VAR=value" \
  || bad "slot run handles a command with a leading VAR=value" "exit $c: $(echo "$out"|grep -i 'not found'|head -1)"

d=$(corpus)
: > "$d/serial.log"
( cd "$d" && timeout 60 node "$DRV" slot run ci -- /bin/bash -c 'echo START >> serial.log; sleep 3; echo END >> serial.log' >/dev/null 2>&1 ) &
sleep 1
( cd "$d" && timeout 60 node "$DRV" slot run ci -- /bin/bash -c 'echo START >> serial.log; sleep 1; echo END >> serial.log' >/dev/null 2>&1 ) &
wait
seq=$(tr '\n' ' ' < "$d/serial.log")
[ "$seq" = "START END START END " ] \
  && ok "two concurrent slot runs serialise" \
  || bad "two concurrent slot runs serialise" "interleaved: $seq"

# installs are heavy, so they go through the slot rather than all at once
d=$(corpus)
out=$(cd "$d" && node -e '
const src=require("fs").readFileSync(process.argv[1],"utf8");
const m=src.match(/const INSTALL = [^\n]*\n/);
console.log(m?"has-install-rule":"no-install-rule");' "$DRV")
[ "$out" = "has-install-rule" ] \
  && ok "installs are classified as heavy work" \
  || bad "installs are classified as heavy work" "no INSTALL rule in the driver"

# ────────────────────────────────────────────────────────────── global gates

head_ "Standing gates"

repo="$(dirname "$DRV")"
out=$(cd "$repo" && node test.mjs 2>&1)
echo "$out" | tail -1 | grep -q "all green" \
  && ok "the driver's own suite: $(echo "$out"|tail -1)" \
  || bad "the driver's own suite is green" "$(echo "$out"|tail -3|tr '\n' ' ')"

d=$(corpus)
out=$(cd "$d" && node "$DRV" verify 2>&1); c=$?
[ $c -eq 0 ] && ok "verify is green on the untouched recorded run — $(echo "$out"|head -1|cut -c1-58)" \
             || bad "verify is green on the untouched recorded run" "$(echo "$out"|head -2|tr '\n' ' ')"

# ───────────────────────────────────────────────────────────────── summary

printf '\n────────────────────────────────────────────────────────\n'
printf '%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '\nstill broken:\n'
  for f in "${FAILED[@]}"; do printf '  · %s\n' "$f"; done
  exit 1
fi
exit 0
