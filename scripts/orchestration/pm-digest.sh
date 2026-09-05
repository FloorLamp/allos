#!/usr/bin/env bash
# PM digest — the owner's catch-up, run by the project manager (see
# .claude/skills/pm/SKILL.md §The digest). Three questions, in this order:
#   1. What shipped for people — the largest user-facing features and epics.
#   2. What went wrong and what changed about how we work because of it.
#   3. How far we got — the progress numbers and what is in flight.
#
# It is DATA, not the report: the PM groups the merges into epics, calls which
# reds were incidents, and writes the paragraph. What the script owes is that a
# feature, an incident or a ruling cannot be missed because nobody looked.
#
# The window anchor is disk state ($SCRATCH/.last_pm_digest) — the PM's own
# container, never an orchestrator's; a --peek or --since run leaves it alone, and a
# run with a failed read never advances it. Reads are unauthenticated REST per
# docs/orchestration/environment.md §GitHub access plus git on origin/main.
#
# Usage:
#   bash scripts/orchestration/pm-digest.sh              # since the last digest, then advance the anchor
#   bash scripts/orchestration/pm-digest.sh --peek       # same window, anchor untouched
#   bash scripts/orchestration/pm-digest.sh --since ISO  # explicit window start (implies --peek)
#   bash scripts/orchestration/pm-digest.sh --days N     # last N days (implies --peek)
#
# Output also lands in $SCRATCH/pm-digest-<ts>.log.

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then # the header IS the usage (usage.mjs is the JS twin)
  sed -n '2,${/^#/!q;s/^#[[:space:]]\{0,1\}//p;}' "$0"
  exit 0
fi

set -uo pipefail

STATE_DIR=${SCRATCH:-$(node "$(dirname "$0")/host.mjs" state-dir 2>/dev/null || echo /home/user/scratch)}
ANCHOR_FILE="$STATE_DIR/.last_pm_digest"
REPO_DIR=$(git rev-parse --show-toplevel 2>/dev/null || echo /home/user/allos)
API="https://api.github.com/repos/FloorLamp/allos"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

SINCE=""
PEEK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --peek) PEEK=1 ;;
    --since) shift; SINCE="${1:-}"; PEEK=1 ;;
    --days) shift; SINCE=$(date -u -d "${1:-1} days ago" +%Y-%m-%dT%H:%M:%SZ); PEEK=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -z "$SINCE" ] && SINCE=$(cat "$ANCHOR_FILE" 2>/dev/null || true)
if [ -z "$SINCE" ] || ! date -u -d "$SINCE" >/dev/null 2>&1; then
  [ -n "$SINCE" ] && echo "anchor unreadable ('$SINCE') — falling back to 7 days" >&2
  SINCE=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
fi
SINCE_DAY=${SINCE:0:10}

mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/pm-digest-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee "$LOG") 2>&1
TMP=$(mktemp -d "$STATE_DIR/pm-digest.XXXXXX")
FAIL_MARK="$TMP/fetch-failed"
trap 'rm -rf "$TMP"' EXIT

# A failed read must not consume the window (an empty section and a section
# that could not be read look identical). The marker is a file because every
# caller runs fetch inside a subshell.
fetch() {
  curl -sSf "$1" 2>/dev/null || { echo "  (fetch failed: $1)" >&2; : > "$FAIL_MARK"; echo "[]"; }
}

git -C "$REPO_DIR" fetch -q origin main 2>/dev/null || echo "  (git fetch failed — commit data may be stale)" >&2

echo "=== PM DIGEST  window ${SINCE} .. ${NOW} ==="

# Squash commits on main in the window, with their paths and line counts. The
# process/product split reads paths (free) rather than /pulls/N/files (60 calls
# an hour unauthenticated). Production size excludes tests, docs and tooling so
# "largest" means largest for a person using the app.
PROC_PATHS='^(docs/orchestration|scripts/orchestration/|scripts/orchestrator-checkin\.sh|\.claude/|AGENTS\.md|CLAUDE\.md|docs/internals/e2e|\.github/workflows/)'
git -C "$REPO_DIR" log --since="$SINCE" --format=$'\x01%H\t%ci\t%s\t%b\x02' --numstat origin/main \
  > "$TMP/commits" 2>/dev/null || : > "$TMP/commits"
fetch "$API/issues?state=closed&since=$SINCE&per_page=100" > "$TMP/closed.json"
fetch "$API/issues?state=all&since=$SINCE&per_page=100&sort=created&direction=desc" > "$TMP/recent.json"
for pg in 1 2 3; do fetch "$API/issues?state=open&per_page=100&page=$pg" > "$TMP/open.$pg"; done
fetch "$API/pulls?state=open&per_page=50" > "$TMP/openprs.json"
fetch "$API/actions/runs?branch=main&per_page=50" > "$TMP/runs.json"
fetch "$API/issues/comments?since=$SINCE&per_page=100" > "$TMP/comments.json"
git -C "$REPO_DIR" show origin/main:lib/release-notes.json > "$TMP/notes.json" 2>/dev/null || echo '{"days":[]}' > "$TMP/notes.json"
git -C "$REPO_DIR" ls-remote --heads origin 2>/dev/null > "$TMP/heads" || : > "$TMP/heads"

TMP="$TMP" SINCE="$SINCE" SINCE_DAY="$SINCE_DAY" NOW="$NOW" PROC_PATHS="$PROC_PATHS" node -e '
  const fs=require("fs"), T=process.env.TMP, SINCE=process.env.SINCE, DAY=process.env.SINCE_DAY;
  const J=f=>{try{const v=JSON.parse(fs.readFileSync(`${T}/${f}`,"utf8"));return v;}catch{return [];}};
  const proc=new RegExp(process.env.PROC_PATHS);
  const nonProd=/^(e2e\/|.*__tests__\/|.*\.(test|spec)\.[cm]?[jt]sx?$|docs\/|scripts\/|\.claude\/|\.github\/|lib\/release-notes\.json$|.*\.md$)/;
  // ---- commits → merges with size, closed issues, process flag
  const merges=[];
  for(const rec of fs.readFileSync(`${T}/commits`,"utf8").split("\x01").slice(1)){
    const [head,rest]=rec.split("\x02");
    const [sha,date,subject,...bodyParts]=head.split("\t");
    const body=bodyParts.join("\t");
    const files=[], stat={prod:0,all:0};
    for(const l of (rest||"").split("\n")){
      const m=l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/); if(!m) continue;
      const n=(m[1]==="-"?0:+m[1])+(m[2]==="-"?0:+m[2]);
      files.push(m[3]); stat.all+=n; if(!nonProd.test(m[3])) stat.prod+=n;
    }
    const pr=(subject.match(/\(#(\d+)\)\s*$/)||[])[1];
    const issues=[...(subject+"\n"+body).matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map(m=>+m[1]);
    merges.push({sha:sha.slice(0,9),date:date.slice(0,16),subject:subject.replace(/\s*\(#\d+\)\s*$/,""),pr,issues,files,stat,process:files.some(f=>proc.test(f))});
  }
  const product=merges.filter(m=>!m.process), process_=merges.filter(m=>m.process);
  const closed=J("closed.json").filter(i=>!i.pull_request&&i.closed_at>=SINCE);
  const byNum=new Map(closed.map(i=>[i.number,i]));
  const lab=i=>i.labels.map(l=>l.name);
  const prio=i=>["P0","P1","P2","P3"].find(p=>lab(i).includes(p))||"—";
  const DOMAINS=["nutrition","intake","dashboard","training","notifications","integrations","wearable","medical-passport","biomarkers","body-metrics","wellness","goals","insights","mobile","infra","ci","db","docs","design","dependencies","findings","e2e"];
  const domainOf=i=>lab(i).find(l=>DOMAINS.includes(l))||"other";

  // ================= 1. SHIPPED FOR PEOPLE
  console.log("\n--- 1. SHIPPED FOR PEOPLE ---");
  const notes=(J("notes.json").days||[]).filter(d=>d.date>=DAY);
  const entries=notes.flatMap(d=>d.entries.map(e=>({...e,date:d.date})));
  console.log(`\n  Release notes in window (${entries.length} entr${entries.length===1?"y":"ies"}, curated):`);
  if(!entries.length) console.log("  (none written yet — the day batch may be owed; see release-notes-gather.mjs --check)");
  const cats=new Map(); for(const e of entries){ if(!cats.has(e.category)) cats.set(e.category,[]); cats.get(e.category).push(e); }
  for(const [c,es] of [...cats.entries()].sort((a,b)=>b[1].length-a[1].length)){
    console.log(`  ${c} (${es.length})`); for(const e of es) console.log(`    ${e.kind.padEnd(7)} ${e.title}  (#${e.pr})`);
  }
  console.log(`\n  Largest product merges by production lines (${product.length} product / ${process_.length} process in window):`);
  const top=[...product].sort((a,b)=>b.stat.prod-a.stat.prod).slice(0,10);
  if(!top.length) console.log("  (none)");
  for(const m of top){
    const iss=m.issues.map(n=>{const i=byNum.get(n);return i?`#${n} ${prio(i)}`:`#${n}`;}).join(", ");
    console.log(`  ${String(m.stat.prod).padStart(5)} lines  ${m.date}  ${m.subject}${m.pr?`  (#${m.pr})`:""}${iss?`\n            closes ${iss}`:""}`);
  }
  console.log(`\n  Epics — issues closed in window, by domain (${closed.length} closed):`);
  const groups=new Map(); for(const i of closed){const d=domainOf(i); if(!groups.has(d)) groups.set(d,[]); groups.get(d).push(i);}
  for(const [d,is] of [...groups.entries()].sort((a,b)=>b[1].length-a[1].length)){
    const heads=is.filter(i=>["P0","P1","P2"].includes(prio(i))).sort((a,b)=>prio(a).localeCompare(prio(b))).slice(0,3);
    console.log(`  ${d} (${is.length})`);
    for(const i of heads) console.log(`    ${prio(i)} #${i.number} ${i.title.slice(0,90)}`);
  }

  // ================= 2. INCIDENTS THAT CHANGED THE WORKFLOW
  console.log("\n--- 2. INCIDENTS AND WHAT CHANGED BECAUSE OF THEM ---");
  const runs=(J("runs.json").workflow_runs||[]).filter(r=>r.created_at>=SINCE&&r.conclusion==="failure");
  const bySha=new Map(merges.map(m=>[m.sha,m]));
  console.log(`\n  main went red ${runs.length} time(s):`);
  for(const r of runs){ const m=bySha.get(r.head_sha.slice(0,9)); console.log(`  ${r.created_at.slice(0,16)}  ${r.name} @ ${r.head_sha.slice(0,9)}${m?`  after "${m.subject.slice(0,60)}"`:""}\n            ${r.html_url}`); }
  const reverts=merges.filter(m=>/^Revert\b/.test(m.subject));
  if(reverts.length){ console.log(`\n  Reverts (${reverts.length}):`); for(const m of reverts) console.log(`  ${m.date}  ${m.subject}`); }
  console.log(`\n  Workflow changes merged (${process_.length}) — doctrine, tooling, CI, briefs:`);
  if(!process_.length) console.log("  (none — a window that learned nothing it wrote down)");
  for(const m of process_) console.log(`  ${m.date}  ${m.subject}${m.pr?`  (#${m.pr})`:""}`);
  const comments=J("comments.json");
  const ruled=new Map();
  for(const c of comments){ const m=(c.body||"").match(/\*\*Owner (ruling|amendment)[^*]*\*\*/); if(m){const n=+c.issue_url.split("/").pop(); ruled.set(n,(ruled.get(n)||"")+m[1][0]);} }
  for(const i of [...J("recent.json"),...closed]){ if(i.pull_request) continue; const ms=[...(i.body||"").matchAll(/\*\*(?:Owner ruling|Owner amendment|Ruling) \((\d{4}-\d{2}-\d{2})/g)]; if(ms.some(x=>x[1]>=DAY)) ruled.set(i.number,(ruled.get(i.number)||"")+"b"); }
  console.log(`\n  Owner rulings recorded in window: ${ruled.size} issue(s)${ruled.size?": "+[...ruled.keys()].sort((a,b)=>a-b).map(n=>"#"+n).join(" "):""}`);
  const openAll=[1,2,3].flatMap(p=>J(`open.${p}`)).filter(i=>!i.pull_request);
  const nh=openAll.filter(i=>lab(i).includes("needs-human"));
  console.log(`  needs-human open now: ${nh.length}${nh.length?"  "+nh.map(i=>"#"+i.number).join(" "):""}`);

  // ================= 3. PROGRESS
  console.log("\n--- 3. PROGRESS ---");
  const opened=J("recent.json").filter(i=>!i.pull_request&&i.created_at>=SINCE);
  const closedBy=p=>closed.filter(i=>prio(i)===p).length;
  console.log(`\n  merges ${merges.length} (product ${product.length}, process ${process_.length}) · issues closed ${closed.length} (P0 ${closedBy("P0")} · P1 ${closedBy("P1")} · P2 ${closedBy("P2")} · P3 ${closedBy("P3")}) · opened ${opened.length} · net ${opened.length-closed.length>=0?"+":""}${opened.length-closed.length}`);
  const openP=p=>openAll.filter(i=>prio(i)===p);
  console.log(`  open now ${openAll.length}: P0 ${openP("P0").length} · P1 ${openP("P1").length} · P2 ${openP("P2").length} · P3 ${openP("P3").length} · parked ${openAll.filter(i=>lab(i).includes("parked")).length}`);
  for(const i of [...openP("P0"),...openP("P1")]) console.log(`    ${prio(i)} #${i.number} ${i.title.slice(0,90)}`);
  const prs=J("openprs.json");
  console.log(`\n  Open PRs (${prs.length}):`);
  for(const p of prs) console.log(`  #${p.number}${p.draft?" [draft]":""}  ${p.head.ref}  ${p.title.slice(0,70)}  (${((Date.parse(process.env.NOW)-Date.parse(p.updated_at))/3.6e6).toFixed(1)}h since update)`);
  const heads=fs.readFileSync(`${T}/heads`,"utf8").split("\n").map(l=>l.split("\t")[1]||"").map(r=>r.replace("refs/heads/","")).filter(b=>b&&!/^(main|dependabot|claude\/|codex\/)/.test(b));
  const lanes=heads.filter(b=>/\d{4}/.test(b));
  console.log(`\n  Lane branches on origin (${lanes.length}) — in flight or banked:`);
  console.log("  "+(lanes.join("  ")||"(none)"));
  console.log("\n  Priority state: the Ladder issue #4769 (rungs, slices, landing order).");
'

# Is main green right now? One function decides for both surfaces (the merge
# gate's own), so the digest cannot disagree with the gate.
echo
echo "--- main detector (e2e-main) ---"
MAIN_CHECKS=$(fetch "$API/commits/main/check-runs?per_page=100")
CORE="$REPO_DIR/scripts/orchestration/merge-gate-core.mjs" node --input-type=module -e '
  const { baseDetectorNotice } = await import(process.env.CORE);
  let d="";
  process.stdin.on("data", (c) => (d += c)).on("end", () => {
    let parsed; try { parsed = JSON.parse(d); } catch { parsed = []; }
    if (Array.isArray(parsed)) { console.log("  (check runs for main unreadable — see the fetch warning above)"); return; }
    console.log("  " + baseDetectorNotice(parsed.check_runs ?? [], "main"));
  });' <<<"$MAIN_CHECKS"

echo
if [ "$PEEK" = 1 ]; then
  echo "anchor untouched ($(cat "$ANCHOR_FILE" 2>/dev/null || echo unset)) — peek/--since/--days run"
elif [ -e "$FAIL_MARK" ]; then
  echo "anchor NOT advanced — at least one read failed, so this digest is INCOMPLETE;"
  echo "  an empty section may mean 'could not read'. Re-run when the reads succeed."
  echo "  Current anchor: $(cat "$ANCHOR_FILE" 2>/dev/null || echo unset)"
else
  echo "$NOW" > "$ANCHOR_FILE"
  echo "anchor advanced: next digest reports from $NOW"
fi
echo "raw notes: $LOG"
echo
echo "Digest is data, not the report. Still the PM's: name the epics, call the"
echo "incidents, and write the three paragraphs for the owner."
