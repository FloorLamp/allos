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

set -uo pipefail

STATE_DIR=${SCRATCH:-/home/user/scratch}
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
#    digest means (an empty roster after a reclaim is news, not calm).
bash "$REPO_DIR/scripts/orchestrator-checkin.sh"

echo
echo "=== CATCH-UP DIGEST  window ${SINCE} .. ${NOW} ==="

fetch() {
  # curl that degrades to an empty JSON array so one blocked read does not
  # kill the digest; the section prints a warning instead of vanishing.
  curl -sSf "$1" 2>/dev/null || { echo "  (fetch failed: $1)" >&2; echo "[]"; }
}

# 2. Merged PRs since the anchor. Closed pulls sorted by updated desc: any PR
#    with merged_at >= SINCE also has updated_at >= SINCE, so paging can stop
#    at the first page whose oldest updated_at predates the window.
echo
echo "--- merged PRs since ${SINCE} ---"
page=1
while :; do
  batch=$(fetch "$API/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=$page")
  out=$(SINCE="$SINCE" node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const prs=JSON.parse(d), since=process.env.SINCE;
      for(const p of prs)
        if(p.merged_at && p.merged_at>=since)
          console.log(`  ${p.merged_at}  #${p.number}  ${p.title}`);
      const done = prs.length<100 || prs.some(p=>p.updated_at<since);
      process.exit(done?10:0);
    });' <<<"$batch") && more=1 || more=0
  [ -n "$out" ] && echo "$out"
  [ "$more" = 0 ] && break
  page=$((page+1))
  [ "$page" -gt 5 ] && { echo "  (stopped at 5 pages — window is implausibly wide)"; break; }
done

# 3. Open PRs: the in-flight and parked review surface.
echo
echo "--- open PRs ---"
fetch "$API/pulls?state=open&per_page=50" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const prs=JSON.parse(d);
    if(!prs.length) console.log("  (none)");
    for(const p of prs){
      const labels=p.labels.map(l=>l.name).join(",");
      console.log(`  #${p.number}${p.draft?" [draft]":""}  (${p.head.ref})  ${p.title}${labels?"  ["+labels+"]":""}`);
    }
  });'

# 4. Open issues, bucketed the way triage reads them: P0/P1 preempt, P2 bugs
#    before P2 features, needs-human and parked are gates rather than queue.
#    Priority comes from the priority-slot label (label hygiene guarantees
#    exactly one; a violation prints under "unlabeled" for repair on the spot).
echo
echo "--- issue queue ---"
TMP=$(mktemp -d "$STATE_DIR/catchup-pages.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
for pg in 1 2 3; do
  fetch "$API/issues?state=open&per_page=100&page=$pg" > "$TMP/issues.$pg"
done
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
    const rest=issues.filter(i=>prio(i)==="P2"&&!has(i,"bug")&&!has(i,"needs-human")&&!has(i,"parked"));
    console.log(`\n  P2 rest (${rest.length}) — newest first, triage reads these WHOLE before dispatch`);
    for(const i of rest.slice(0,20)) console.log(line(i));
    if(rest.length>20) console.log(`  ... and ${rest.length-20} more (P3 tier not listed — filler when P2 is fenced)`);
  }' "$TMP"/issues.*

# 5. Incidents filed inside the window — the fires half of the pulse. Headings
#    carry dates inconsistently, so filter where a date exists and always show
#    the last three as a floor.
echo
echo "--- incident headings (docs/orchestration-incidents.md) ---"
SINCE_DAY=${SINCE%%T*}
grep '^## ' "$REPO_DIR/docs/orchestration-incidents.md" | SINCE_DAY="$SINCE_DAY" node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const lines=d.trim().split("\n"), since=process.env.SINCE_DAY;
    const dated=lines.filter(l=>{const m=l.match(/\d{4}-\d{2}-\d{2}/);return m&&m[0]>=since;});
    const show=dated.length?dated:lines.slice(-3);
    if(!dated.length) console.log(`  (none dated >= ${since}; last three for context)`);
    for(const l of show) console.log("  "+l.replace(/^## /,""));
  });'

# 6. Advance the anchor only on a full, non-peek run: a --peek or --since read
#    must not move what "since last catch-up" means for the next one.
echo
if [ "$PEEK" = 1 ]; then
  echo "anchor untouched ($(cat "$ANCHOR_FILE" 2>/dev/null || echo unset)) — peek/--since run"
else
  echo "$NOW" > "$ANCHOR_FILE"
  echo "anchor advanced: next catch-up reports from $NOW"
fi
echo "raw notes: $LOG"
echo
echo "Digest is data, not the pulse. Still yours: group the merges, call the"
echo "fires, order the queue within tiers, and post the pulse."
