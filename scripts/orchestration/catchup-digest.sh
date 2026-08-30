#!/usr/bin/env bash
# Catch-up digest for an orchestration check-in (see docs/orchestration.md).
#
# Not the flight recorder — that is scripts/orchestrator-checkin.sh, which
# this runs FIRST, unchanged (and which keeps its name: CI skip-set regexes
# and tests assert it literally). The recorder answers "did the world end
# while I was gone"; this script answers the owner's question, "catch me up":
# what merged
# since the last catch-up, what is still open, what caught fire, and what the
# queue looks like — the data half of the status pulse lifecycle.md requires.
# Judgment (grouping, fires-vs-noise, the priority ordering within a tier)
# stays with the orchestrator; this script only makes the gathering cheap and
# repeatable, so a catch-up never again starts from an empty scratch dir and
# an hour of hand-paged curls.
#
# The window anchor is disk state ($SCRATCH/.last_catchup), same doctrine as
# the recorder: a container reclaim wipes the orchestrator's memory of when it
# last reported, so the anchor must not live there. First run after a wipe
# falls back to 24h. Reads are unauthenticated REST per
# docs/orchestration/environment.md §GitHub access — no token needed, and the
# search endpoint is never used.
#
# Usage:
#   bash scripts/orchestration/catchup-digest.sh              # digest, then advance the anchor
#   bash scripts/orchestration/catchup-digest.sh --peek       # digest, leave the anchor alone
#   bash scripts/orchestration/catchup-digest.sh --since ISO  # explicit window (implies --peek)
#
# Output also lands in $SCRATCH/catchup-<ts>.log — the raw notes that survive
# the session.

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then # the header IS the usage (usage.mjs is the JS twin)
  sed -n '2,${/^#/!q;s/^#[[:space:]]\{0,1\}//p;}' "$0"
  exit 0
fi

set -uo pipefail

# Same resolver as orchestrator-checkin.sh and dispatch-brief.mjs (#3710).
STATE_DIR=${SCRATCH:-$(node "$(dirname "$0")/host.mjs" state-dir 2>/dev/null || echo /home/user/scratch)}
ANCHOR_FILE="$STATE_DIR/.last_catchup"
REPO_DIR=$(git rev-parse --show-toplevel 2>/dev/null || echo /home/user/allos)
API="https://api.github.com/repos/FloorLamp/allos"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

SINCE=""
PEEK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --peek) PEEK=1 ;;
    --since) shift; SINCE="${1:-}"; PEEK=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$SINCE" ]; then
  SINCE=$(cat "$ANCHOR_FILE" 2>/dev/null || true)
fi
if [ -z "$SINCE" ] || ! date -u -d "$SINCE" >/dev/null 2>&1; then
  [ -n "$SINCE" ] && echo "anchor file unreadable ('$SINCE') — falling back to 24h" >&2
  SINCE=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)
fi

mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/catchup-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee "$LOG") 2>&1

# 1. Flight recorder first, always. Restart state governs what the rest of the
#    digest means (an empty roster after a reclaim is news, not calm). The one
#    exception: the recorder's own catch-up gate invoking THIS script sets the
#    flag below, because the recorder just ran — without it the two recurse.
if [ "${CATCHUP_SKIP_RECORDER:-0}" != "1" ]; then
  bash "$REPO_DIR/scripts/orchestrator-checkin.sh"
fi

echo
echo "=== CATCH-UP DIGEST  window ${SINCE} .. ${NOW} ==="

# A FAILED READ MUST NOT CONSUME THE WINDOW. Degrading to `[]` is right — one
# blocked read should not kill the digest — but an empty section and a section
# that is genuinely empty look identical, and step 6 used to advance the anchor
# either way. A run with no network then reported "nothing merged", moved the
# anchor past the merges it never saw, and they were unreportable forever: the
# next catch-up starts after them. That is the permissive-default failure this
# repo keeps meeting, aimed at the one piece of state the digest owns.
#
# The marker is a FILE, not a variable, because every caller runs `fetch` inside
# `$( )` — a subshell, whose increment to a counter is discarded on return.
FAIL_MARK="$STATE_DIR/.catchup-fetch-failed.$$"
rm -f "$FAIL_MARK"

fetch() {
  # curl that degrades to an empty JSON array so one blocked read does not
  # kill the digest; the section prints a warning instead of vanishing, and the
  # marker keeps the anchor where it is.
  curl -sSf "$1" 2>/dev/null || {
    echo "  (fetch failed: $1)" >&2
    : > "$FAIL_MARK"
    echo "[]"
  }
}

# 2. Merged PRs since the anchor. Closed pulls sorted by updated desc: any PR
#    with merged_at >= SINCE also has updated_at >= SINCE, so paging can stop
#    at the first page whose oldest updated_at predates the window.
MERGED_RAW=$(mktemp "${STATE_DIR}/catchup-merged.XXXXXX")
page=1
while :; do
  batch=$(fetch "$API/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=$page")
  out=$(SINCE="$SINCE" node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const prs=JSON.parse(d), since=process.env.SINCE;
      for(const p of prs)
        if(p.merged_at && p.merged_at>=since)
          console.log(`${p.merged_at}\t${p.number}\t${p.title}`);
      const done = prs.length<100 || prs.some(p=>p.updated_at<since);
      process.exit(done?10:0);
    });' <<<"$batch") && more=1 || more=0
  [ -n "$out" ] && printf '%s\n' "$out" >> "$MERGED_RAW"
  [ "$more" = 0 ] && break
  page=$((page+1))
  [ "$page" -gt 5 ] && { echo "  (stopped at 5 pages — window is implausibly wide)"; break; }
done

# WHICH merges were PROCESS and which were PRODUCT is a question git can answer
# for free, and the API cannot answer cheaply: classifying by files means one
# `/pulls/N/files` call per PR, and unauthenticated REST allows 60 calls an
# HOUR. A busy day merges 30+. So the split reads the squash commits on
# origin/main — subject carries `(#N)`, `--name-only` carries the paths — and
# costs no rate limit at all.
#
# The owner asked for this split by name: a catch-up is not a flat list, it is
# "what shipped for users" and "what changed about how we work", and the second
# is the half that decides whether tonight's lesson survives the container.
PROC_PATHS='^(docs/orchestration|scripts/orchestration/|scripts/orchestrator-checkin\.sh|\.claude/|AGENTS\.md|CLAUDE\.md|docs/internals/e2e|\.github/workflows/)'
git -C "$REPO_DIR" log --since="$SINCE" --format=$'\x01%s' --name-only origin/main 2>/dev/null \
  > "${MERGED_RAW}.commits" || : > "${MERGED_RAW}.commits"

echo
MERGED_RAW="$MERGED_RAW" PROC_PATHS="$PROC_PATHS" SINCE="$SINCE" node -e '
  const fs=require("fs");
  const raw=fs.readFileSync(process.env.MERGED_RAW,"utf8").trim();
  const rows=raw?raw.split("\n").map(l=>l.split("\t")):[];
  const commits=fs.readFileSync(process.env.MERGED_RAW+".commits","utf8")
    .split("\x01").slice(1);
  const re=new RegExp(process.env.PROC_PATHS);
  const processPRs=new Set();
  for(const c of commits){
    const [subject,...files]=c.split("\n");
    const m=subject.match(/\(#(\d+)\)\s*$/);
    if(m && files.some(f=>f && re.test(f))) processPRs.add(m[1]);
  }
  const proc=rows.filter(r=>processPRs.has(r[1]));
  const prod=rows.filter(r=>!processPRs.has(r[1]));
  console.log(`--- merged since ${process.env.SINCE} — ${rows.length} PR(s) ---`);
  console.log(`\n  PRODUCT (${prod.length}) — what a user of the app got`);
  if(!prod.length) console.log("  (none)");
  for(const r of prod) console.log(`  ${r[0]}  #${r[1]}  ${r[2]}`);
  console.log(`\n  PROCESS (${proc.length}) — how the work is done: doctrine, tooling, CI, briefs`);
  if(!proc.length) console.log("  (none — a day that learned nothing it wrote down)");
  for(const r of proc) console.log(`  ${r[0]}  #${r[1]}  ${r[2]}`);
  if(!commits.length && rows.length)
    console.log("\n  (the PROCESS split is empty because origin/main carried no commits in\n   this window — fetch origin before trusting it)");
'

# 3. Open PRs: the in-flight and parked review surface.
echo
echo "--- open PRs ---"
OPEN_PRS=$(mktemp "${STATE_DIR}/catchup-openprs.XXXXXX")
fetch "$API/pulls?state=open&per_page=50" > "$OPEN_PRS"
node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const prs=JSON.parse(d);
    if(!prs.length) console.log("  (none)");
    for(const p of prs){
      const labels=p.labels.map(l=>l.name).join(",");
      console.log(`  #${p.number}${p.draft?" [draft]":""}  (${p.head.ref})  ${p.title}${labels?"  ["+labels+"]":""}`);
    }
  });' < "$OPEN_PRS"

# 3b. FIRES AND SETBACKS — the section a catch-up is actually read for.
#
# Everything here is a MECHANICAL candidate, never a verdict: the digest can
# see that main went red, that a merge was reverted, that a PR has not moved in
# hours. Whether any of it is a fire is the orchestrator's call, and calling a
# quiet night quiet is part of the job. What the script owes is that a fire
# cannot be MISSED because nobody thought to look — the flat list this replaced
# reported 33 merges and said nothing about the two that were rolled back.
echo
echo "--- fires and setbacks (candidates — you decide which are real) ---"
reverts=$(git -C "$REPO_DIR" log --since="$SINCE" --format='  reverted: %s' \
  --grep='^Revert' origin/main 2>/dev/null)
[ -n "$reverts" ] && echo "$reverts"
fetch "$API/actions/runs?branch=main&per_page=30" | SINCE="$SINCE" node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    let runs=[];try{runs=(JSON.parse(d).workflow_runs)||[];}catch{}
    const bad=runs.filter(r=>r.created_at>=process.env.SINCE&&r.conclusion==="failure");
    for(const r of bad)
      console.log(`  main RED: ${r.name} @ ${r.head_sha.slice(0,9)}  ${r.html_url}`);
  });'
NOW="$NOW" node -e '
  const fs=require("fs");
  const prs=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const now=Date.parse(process.env.NOW);
  for(const p of prs){
    if(p.draft||p.labels.some(l=>l.name==="parked")) continue;
    const h=(now-Date.parse(p.updated_at))/3.6e6;
    if(h>=3) console.log(`  STALLED ${h.toFixed(1)}h: #${p.number} ${p.title.slice(0,60)}`);
  }' "$OPEN_PRS"
echo "  (a restart is a setback too — the recorder above says whether one happened)"

# 4. Open issues, bucketed the way triage reads them: P0/P1 preempt, P2 bugs
#    before P2 features, needs-human and parked are gates rather than queue.
#    Priority comes from the priority-slot label (label hygiene guarantees
#    exactly one; a violation prints under "unlabeled" for repair on the spot).
echo
echo "--- issue queue ---"
TMP=$(mktemp -d "$STATE_DIR/catchup-pages.XXXXXX")
trap 'rm -rf "$TMP" "$FAIL_MARK"' EXIT
for pg in 1 2 3; do
  fetch "$API/issues?state=open&per_page=100&page=$pg" > "$TMP/issues.$pg"
done
HOLDS_FILE="${STATE_DIR}/.holds" \
LEDGER_FILE="${ALLOS_DISPATCH_LEDGER:-${STATE_DIR}/allos-dispatch-ledger.jsonl}" \
node -e '
  const fs=require("fs");
  {
    const issues=process.argv.slice(1)
      .map(f=>JSON.parse(fs.readFileSync(f,"utf8")))
      .flat().filter(i=>!i.pull_request);
    const has=(i,n)=>i.labels.some(l=>l.name===n);
    const prio=i=>["P0","P1","P2","P3"].find(p=>has(i,p))||"unlabeled";
    const line=i=>`  #${i.number}  [${i.labels.map(l=>l.name).join(",")}]  ${i.title}`;
    const buckets={
      "P0":i=>prio(i)==="P0",
      "P1":i=>prio(i)==="P1",
      "P2 bugs":i=>prio(i)==="P2"&&has(i,"bug"),
      "needs-human (gate, not queue)":i=>has(i,"needs-human"),
      "no priority slot (repair on the spot)":i=>prio(i)==="unlabeled"&&!has(i,"parked"),
    };
    const parked=issues.filter(i=>has(i,"parked")).length;
    const counts=["P0","P1","P2","P3"].map(p=>`${p}:${issues.filter(i=>prio(i)===p).length}`).join("  ");
    console.log(`  open:${issues.length}  ${counts}  parked:${parked}`);
    for(const [name,test] of Object.entries(buckets)){
      const hit=issues.filter(test);
      console.log(`\n  ${name} (${hit.length})`);
      for(const i of hit) console.log(line(i));
    }
    // THE NEXT 15, IN DISPATCH ORDER — the question a catch-up is asked to
    // answer last: what would I pick up now. A bucket dump is not that answer;
    // it makes the reader re-derive the ordering every time, and it lists work
    // that CANNOT be picked up — an issue an agent is mid-flight on, or one the
    // owner has claimed. Both exclusions read from disk state, the same
    // doctrine as the anchor: the ledger and the holds file outlive the
    // orchestrator that wrote them.
    const held=new Set(), heldLabels=new Set(), inflight=new Set();
    try{
      const holds=fs.readFileSync(process.env.HOLDS_FILE,"utf8");
      // A HOLD NAMES ISSUES, AND A HOLD IS WRITTEN IN PROSE — "Issues 2870 and
      // 3009 belong to the owner" — so bare numbers count. But the same prose
      // carries DATES, and `2026-08-16` yields "2026", which is a plausible
      // issue number in this repo: a naive scan silently hides whatever issue
      // shares a number with the year the hold was written. A digit run
      // followed by `-DD` is a date, never an issue.
      for(const m of holds.matchAll(/#?(\d{3,5})(?![-\d])/g)) held.add(Number(m[1]));
      // A hold can also be a whole DOMAIN — "hold all training work for the
      // owner" is how this session started, and it is not expressible as a list
      // of issue numbers because the next filed one joins it automatically.
      for(const m of holds.matchAll(/\blabel:([a-z0-9-]+)/g)) heldLabels.add(m[1]);
    }catch{}
    try{
      const live=new Map();
      for(const l of fs.readFileSync(process.env.LEDGER_FILE,"utf8").trim().split("\n")){
        let e;try{e=JSON.parse(l);}catch{continue;}
        if(!e.branch) continue;
        live.set(e.branch, e);            // last line per branch wins
      }
      for(const e of live.values())
        if(e.status==="active") for(const n of e.issues||[]) inflight.add(Number(n));
    }catch{}
    const rank=i=>{
      const p=prio(i);
      if(p==="P0") return 0;
      if(p==="P1") return 1;
      if(p==="P2") return has(i,"bug")?2:3;
      return has(i,"bug")?4:5;
    };
    const pickable=issues
      .filter(i=>!has(i,"needs-human")&&!has(i,"parked")&&prio(i)!=="unlabeled")
      .filter(i=>!held.has(i.number)&&!inflight.has(i.number))
      .filter(i=>!i.labels.some(l=>heldLabels.has(l.name)))
      .sort((a,b)=>rank(a)-rank(b)||b.number-a.number);
    console.log(`\n  NEXT UP (${Math.min(15,pickable.length)} of ${pickable.length} pickable) — dispatch order: P0, P1, P2 bugs, P2 rest, P3`);
    for(const i of pickable.slice(0,15)) console.log(line(i));
    const why=[];
    if(inflight.size) why.push(`${inflight.size} in flight`);
    if(held.size) why.push(`${held.size} owner-held`);
    if(heldLabels.size) why.push(`held domains: ${[...heldLabels].join(", ")}`);
    if(why.length) console.log(`  (excluded: ${why.join(", ")}, plus needs-human and parked)`);
  }' "$TMP"/issues.*

# 5. Advance the anchor only on a full, non-peek run: a --peek or --since read
#    must not move what "since last catch-up" means for the next one.
echo
if [ "$PEEK" = 1 ]; then
  echo "anchor untouched ($(cat "$ANCHOR_FILE" 2>/dev/null || echo unset)) — peek/--since run"
elif [ -e "$FAIL_MARK" ]; then
  echo "anchor NOT advanced — at least one read failed, so this digest is"
  echo "  INCOMPLETE and an empty section above may mean 'could not read' rather"
  echo "  than 'nothing happened'. The window is preserved; re-run when the reads"
  echo "  succeed. Current anchor: $(cat "$ANCHOR_FILE" 2>/dev/null || echo unset)"
else
  echo "$NOW" > "$ANCHOR_FILE"
  echo "anchor advanced: next catch-up reports from $NOW"
fi
rm -f "$FAIL_MARK"
echo "raw notes: $LOG"
echo
echo "Digest is data, not the pulse. Still yours: group the merges, call the"
echo "fires, order the queue within tiers, and post the pulse."
