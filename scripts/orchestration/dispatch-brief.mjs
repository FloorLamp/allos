// Dispatch-brief generator + dispatch ledger (plain Node, no deps).
//
// The orchestration runbook's dispatch template was pasted into agent briefs
// BY HAND, with the volatile values — node 24 path, canonical node_modules,
// E2E port range, and (in the numbered-migration era) the slot — filled in
// from memory. Every documented
// drift incident in that template's history is a hand-fill error: `PORT=`
// where the harness reads `E2E_PORT` (two agents sharing ports and
// manufacturing flakes), a pinned node patch version that went stale within
// days, two agents both writing `165-*.ts` because one brief never mentioned
// slots. This script computes those values instead of remembering them, and
// records every dispatch in a JSONL ledger so coordination state survives the
// orchestrator session that created it (container restarts are the dominant
// failure mode — docs/orchestration.md).
//
// Usage:
//   node scripts/orchestration/dispatch-brief.mjs new --branch <branch> \
//     [--worktree wt-<name>] [--issues 123,456] [--task "one line"] \
//     [--e2e] [--port-base N]
//   node scripts/orchestration/dispatch-brief.mjs list
//   node scripts/orchestration/dispatch-brief.mjs brief <branch>
//   node scripts/orchestration/dispatch-brief.mjs done <branch> [--keep]
//   node scripts/orchestration/dispatch-brief.mjs resume <branch>
//   node scripts/orchestration/dispatch-brief.mjs adopt <branch> \
//     [--issues 123,456] [--task "one line"] [--e2e] [--port-base N]
//
// `new` prints a complete brief block (stdout) and appends a ledger entry.
// `list` shows active dispatches with ages, flagging anything that has not
//   MOVED in 3x the median completed-dispatch duration (the runbook's stall
//   threshold, applied to idleness rather than to age — see cmdList).
// `brief` REPRINTS a live dispatch's brief and writes nothing. The ledger keeps
//   parameters, not brief text, and `new` prints the text exactly once; an
//   orchestrator that lost it (restart, compaction, a truncated tail) used to
//   re-run `new`, which forked the ledger AND the roster for one live agent
//   (2026-08-15). `new` now refuses an active branch and points here.
// `done` closes a dispatch, frees its port range, and CLEANS UP: removes the
//   worktree (located by BRANCH via `git worktree list`, wherever it was
//   built), prunes stale remote refs, and deletes the local branch once its
//   remote is gone (merged-and-tidied). A DIRTY worktree refuses the whole
//   command — rescue first, or pass --keep to close the ledger entry only.
// `resume` re-opens a closed dispatch: same failure mode as closing one and
//   then messaging the agent back to life — the agent was live but invisible
//   to the roster, so the restart drill would never have rescued it.
// `adopt` brings a dispatch that SKIPPED this script — an Agent-tool run —
//   under the ledger and roster. Split-brain dispatch (2026-08-13): the tool
//   path writes no roster entry, so the check-in screamed RESCUE NOW at a
//   live agent's tree, and the roster — the only state that outlives the
//   orchestrator — was incomplete by construction. One path, not two.
//
// Migration slots are RETIRED: migrations are name-keyed (lib/migrations/
// runner.ts), so the brief carries a fixed convention block instead of a
// computed reservation.
//
// Ledger location: $ALLOS_DISPATCH_LEDGER, else $SCRATCH/allos-dispatch-ledger.jsonl,
// else <STATE_DIR>/allos-dispatch-ledger.jsonl. The ledger is orchestration
// state, never checked in.
//
// The ledger and the roster MUST default to the same directory, and that
// directory must be the durable one. `$SCRATCH` is UNSET in the live
// orchestration container (measured), so a `/tmp` fallback here would have put
// the restart-proof ledger in the least durable place on the box — the one
// swept for stale `allos-db-shared-*` dirs — while the roster it must stay in
// sync with landed in /home/user/scratch. Two defaults that disagree is the
// same defect shape as the two boot-id paths this PR already removed, so both
// now read one constant.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

/**
 * The MAIN checkout, asked of git rather than inferred from this file's location.
 *
 * `repoRoot` above answers "where does this copy of the script live", which stops
 * being the same question the moment the script runs from anywhere but the main
 * checkout. `--git-common-dir` resolves to the main checkout's `.git` from every
 * linked worktree, so its parent is the main checkout wherever the caller sits.
 * Falls back to `repoRoot` outside a git tree, where nothing else is meaningful.
 */
function mainCheckout() {
  const common = git("rev-parse --path-format=absolute --git-common-dir", {
    allowFail: true,
  });
  return common ? path.resolve(path.dirname(common)) : repoRoot;
}

// The one state directory both files live in. Matches
// scripts/orchestrator-checkin.sh's `STATE_DIR=${SCRATCH:-/home/user/scratch}`
// exactly — if you change one, change the other.
const STATE_DIR = process.env.SCRATCH ?? "/home/user/scratch";

const ledgerPath =
  process.env.ALLOS_DISPATCH_LEDGER ??
  path.join(STATE_DIR, "allos-dispatch-ledger.jsonl");

function readLedger() {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendLedger(entry) {
  fs.appendFileSync(ledgerPath, JSON.stringify(entry) + "\n");
}

// $SCRATCH/.roster is what scripts/orchestrator-checkin.sh reads to tell a
// LIVE agent's dirty worktree (expected) from an abandoned one (rescue NOW).
// The ledger is history and measurement; the roster is the live view — both
// are written here so they cannot fork. Live entries are lines beginning
// "Cluster" whose THIRD field is the branch (the check-in script's contract).
//
// THE ROSTER FOLLOWS THE LEDGER. `ALLOS_DISPATCH_LEDGER` redirects the ledger,
// but the roster used to be pinned to STATE_DIR regardless — so anything that
// redirected one wrote the other into LIVE coordination state. Testing the
// arrival warning above did exactly that: three fake dispatches landed in the
// real `.roster`, and the next check-in reported eight clusters for five agents.
// That is the 2026-08-15 roster-fork incident again, arriving through the test
// harness instead of through a re-run of `new`.
//
// The header above already says the two must not fork. An override that moves
// one and not the other is a fork by construction, so the roster now derives
// from wherever the ledger actually lives.
const rosterPath = path.join(path.dirname(ledgerPath), ".roster");

function rosterAdd(entry) {
  if (!fs.existsSync(path.dirname(rosterPath))) return false;
  fs.appendFileSync(
    rosterPath,
    `Cluster ${entry.worktree} ${entry.branch} issues=${entry.issues.join(",") || "-"} port=${entry.portBase}\n`
  );
  return true;
}

function rosterClose(branch) {
  if (!fs.existsSync(rosterPath)) return;
  const kept = fs
    .readFileSync(rosterPath, "utf8")
    .split("\n")
    .filter(
      (line) =>
        !(line.startsWith("Cluster ") && line.split(/\s+/)[2] === branch)
    );
  kept.push(`(done: ${branch} ${new Date().toISOString()})`);
  fs.writeFileSync(rosterPath, kept.filter(Boolean).join("\n") + "\n");
}

// Fold the append-only ledger into current state: a `done` row closes the
// matching active dispatch.
function activeDispatches(rows) {
  const byBranch = new Map();
  for (const row of rows) {
    if (row.status === "active") byBranch.set(row.branch, row);
    if (row.status === "done" && byBranch.has(row.branch)) {
      byBranch.get(row.branch).doneAt = row.at;
      byBranch.delete(row.branch);
    }
  }
  return [...byBranch.values()];
}

function completedDurationsMs(rows) {
  const started = new Map();
  const durations = [];
  for (const row of rows) {
    if (row.status === "active") started.set(row.branch, row.at);
    if (row.status === "done" && started.has(row.branch)) {
      durations.push(Date.parse(row.at) - Date.parse(started.get(row.branch)));
      started.delete(row.branch);
    }
  }
  return durations;
}

function git(args, { allowFail = false } = {}) {
  try {
    return execSync(`git ${args}`, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

// --- discovery -------------------------------------------------------------

// The runbook's rule: DISCOVER the node 24 bin dir, never paste one — a pinned
// patch version in the docs went stale within days.
function discoverNode24() {
  const nvmDir = "/opt/nvm/versions/node";
  if (fs.existsSync(nvmDir)) {
    const v24 = fs
      .readdirSync(nvmDir)
      .filter((v) => v.startsWith("v24."))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .pop();
    if (v24) return path.join(nvmDir, v24, "bin");
  }
  if (process.version.startsWith("v24.")) return path.dirname(process.execPath);
  return null;
}

function canonicalNodeModules() {
  const nm = path.join(repoRoot, "node_modules");
  const ok = fs.existsSync(path.join(nm, "better-sqlite3"));
  return { path: nm, verified: ok };
}

// Port ranges: 200 apart so each worktree has headroom for its worker count,
// skipping 6000-6099 (Next refuses X11-reserved ports — an agent lost a round
// discovering port 6000 won't boot).
//
// The skip lives in a PREDICATE, not only in the allocator's loop, because the
// allocator is not the only way a port base is chosen: `--port-base` hands one
// in directly, and it used to be taken on trust. It was mine that proved it —
// I passed `--port-base 6000` by hand for one cluster and the guard three lines
// above did nothing, because a caller who supplies the answer never asks the
// question. The agent lost its worker-slot-0 runs to `Bad port: "6000" is
// reserved for x11` and re-ran on 6001, which is the SECOND round lost to a
// fact the script already knew.
const RESERVED_PORT_REASON = (base) =>
  base >= 6000 && base < 6100
    ? `port base ${base} is inside 6000-6099, which Next refuses ("Bad port: reserved for x11")`
    : null;

function allocatePortBase(active) {
  const taken = new Set(active.map((d) => d.portBase).filter(Boolean));
  for (let base = 5400; base < 9000; base += 200) {
    if (RESERVED_PORT_REASON(base)) continue;
    if (!taken.has(base)) return base;
  }
  throw new Error(
    "no free E2E port range — close finished dispatches with `done <branch>`"
  );
}

// --- brief -----------------------------------------------------------------

// Migrations are NAME-KEYED (the numbered era closed at 185 — see
// lib/migrations/runner.ts), so there is no slot to reserve and every brief
// carries the same convention block.
const MIGRATION_LINES = `- Migrations are NAME-KEYED — there is NO slot to reserve. If your work needs a
  schema change: create lib/migrations/versions/YYYYMMDD-<slug>.ts exporting
  { name: "YYYYMMDD-<slug>", up } (no id), append it LAST to the MIGRATIONS array
  in versions/index.ts, and add its sha256 to lib/migrations/manifest.json in the
  same change. Never edit a shipped migration. If index.ts conflicts when you
  merge origin/main, keep BOTH sides (both import lines, both array entries —
  merge order is the order) and re-run the DB tier.`;

function buildBrief(opts) {
  const node24 = discoverNode24();
  const nm = canonicalNodeModules();
  const rows = readLedger();
  const active = activeDispatches(rows);
  // A hand-supplied base is checked against the same rule the allocator obeys —
  // refuse rather than warn, because a brief that has already been pasted into an
  // agent is not going to be re-read.
  const reserved = opts.portBase && RESERVED_PORT_REASON(opts.portBase);
  if (reserved) {
    throw new Error(
      `${reserved}. Drop --port-base to let the allocator pick, or choose one outside that band.`
    );
  }
  const portBase = opts.portBase ?? allocatePortBase(active);

  // A WORKTREE PATH BELONGS TO ONE DISPATCH, FOREVER — retired ones included.
  // Reusing a retired dispatch's path couples two lanes to one directory, and the
  // coupling only reveals itself at RETIREMENT: the first lane's PR merges, its
  // tree is removed, and the removal lands on whoever is standing there now. That
  // happened on 2026-08-19 — #3172's brief reused #3163's `wt-e2e-leak`, and the
  // tree went out from under a live gate run, taking an uncommitted fix with it.
  // Refused rather than warned, for the reason the port check gives: a brief that
  // has already been pasted into an agent is not going to be re-read.
  const priorWorktree = readLedger().find(
    (r) => r.worktree === opts.worktree && r.branch !== opts.branch
  );
  if (priorWorktree) {
    throw new Error(
      `worktree ${opts.worktree} already belongs to dispatch ${priorWorktree.branch} (active or retired). ` +
        `A path is never reused — pick a branch-specific one.`
    );
  }

  const nodeLine = node24
    ? `- export PATH=${node24}:$PATH in EVERY shell (verify better-sqlite3 loads)`
    : "- No node 24 found under /opt/nvm/versions/node — install it first:\n" +
      "  export NVM_DIR=/opt/nvm && . /opt/nvm/nvm.sh && nvm install 24 (~30s),\n" +
      "  then export PATH to its bin dir in EVERY shell (verify better-sqlite3 loads)";

  const issueLines = opts.issues.length
    ? opts.issues
        .map(
          (n) =>
            `  GET /repos/FloorLamp/allos/issues/${n} and /repos/FloorLamp/allos/issues/${n}/comments`
        )
        .join("\n")
    : "  (no tracker issues — the task statement above is the whole spec)";

  const brief = `${opts.task ? `Task: ${opts.task}\n\n` : ""}\
- Worktree setup: git fetch origin main && git worktree add $SCRATCH/${opts.worktree} -b ${opts.branch} origin/main
- cp -al ${nm.path}/. $SCRATCH/${opts.worktree}/node_modules${nm.verified ? "" : "\n  (WARNING: better-sqlite3 not found in that tree — run npm ci there first)"}
${nodeLine}
- npm ci in the worktree if better-sqlite3 fails to load — the parent checkout drifts.
  AND IF TYPECHECK FAILS NAMING A PACKAGE YOU DID NOT ADD, that is the same drift
  wearing a different error. Your node_modules is HARD-LINKED from the parent tree,
  which was built at some earlier main; a dependency that landed after it is simply
  absent, and the failure points at the import rather than at the cause. Measured
  2026-08-22: a lane lost time to \`@testing-library/react\` missing because #3511
  had added it hours after the parent tree was built. npm ci in the worktree.
- FIRST ACTION is the worktree + node_modules link, BEFORE reading any source. If it
  fails you must know before spending context.
- If a tool call is DENIED by the permission system, or fails for an environment
  reason you cannot fix in ONE retry, STOP AND REPORT IMMEDIATELY — quote what was
  refused, verbatim. Do not sit on it.
- Your branch must EXIST ON THE REMOTE at your latest commit, at all times.
  Committing is not enough — your worktree is NOT backed up and container restarts
  are frequent. This is a HARD GATE, not restart advice: if you have touched more
  than ~10 files, or worked more than ~45 minutes, since your last PUSH, commit and
  push NOW, even mid-task and even if gates have not run. If a push fails with
  "stale info" or a missing upstream, the branch was squash-merged and deleted on
  the remote: git fetch --prune origin, then push again — deterministic, not a
  conflict.
- If the work turns out materially bigger than this brief implies, SAY SO and push a
  checkpoint before continuing — do not silently absorb a 15-file footprint that was
  briefed as a one-line registry edit.
- Foreground ALL gates; never run_in_background for builds/tests; every wait is one
  blocking Bash call, chunked under the 10-minute tool cap. Pass an EXPLICIT
  \`timeout\` (e.g. 600000) to every gate invocation — foreground Bash caps at ~2
  minutes by default whatever the tool's stated maximum, so a slow tier reports as
  a failure it did not have.
- FETCH AND READ ALL ISSUE BODIES AND ALL ISSUE COMMENTS FIRST — a comment overrides
  the body when they conflict. Trust symbol names over line numbers.
- A PR's REVIEWS AND ITS COMMENTS ARE TWO DIFFERENT ENDPOINTS, and a review you were
  told to read may be in either. \`/pulls/<n>/reviews\` returns only what was
  submitted through the review API; anything posted as ordinary prose on the PR is an
  ISSUE COMMENT and appears solely in \`/issues/<n>/comments\`. Read BOTH, always, and
  reconcile them by timestamp. This is not hypothetical: a fix round on #2981 was
  briefed to read \`/pulls/2981/reviews\`, which returned ONE of its two blocking
  reviews — the earlier one, carrying findings D1 through D8, was an issue comment and
  would have been invisible. If the count you get back is smaller than the brief
  implies, you are on the wrong endpoint; say so rather than working from half a spec.
- PREMISE-AUDIT AGAINST main BEFORE WRITING ANYTHING. An issue describes the tree it
  was FILED against; the brief was written from the issue. Grep for the modules and
  symbols it says are missing and confirm they still are. If the work is already done
  or partly done, SAY SO FIRST and build the remainder — do not re-implement it, and
  do not assume the brief checked. #2657 was briefed as untouched when its fold and
  month rollup had shipped hours earlier in #2685; the agent found it, and only
  because it looked.
- WHEN YOU INTRODUCE A BOUNDARY, EVERY EXISTING FIXTURE HAS A POSITION RELATIVE TO
  IT. Before you add a threshold, a floor, or a new state, find the fixtures that
  already sit near it and work out which side each one lands on. A fixture that
  silently crosses your new boundary STOPS TESTING WHAT IT CLAIMS while still going
  green, so nothing turns red and nobody finds out. #3226 added a 365-day dormancy
  floor and found a shipped dashboard-vitals-recency fixture sitting at 1600 days —
  left alone it would have been swallowed by the new state and the #2303 age-label
  guarantee it existed for would have gone untested. This is not \"audit your
  neighbours\"; it is one checkable question you can only ask while the boundary is
  fresh in your hand.
- A CENSUS MEANT TO BE EXHAUSTIVE MUST PASS ripgrep's \`--binary\` (\`-a\`). Several
  source files carry a deliberate NUL as a composite-key separator, so rg calls them
  BINARY and skips them: a plain \`rg <pattern>\` reports a clean sweep it never took.
  They are listed in lib/__tests__/nul-byte-census.test.ts (#3206).
- PREFER \`git grep\` TO \`rg\` FOR A CENSUS IN YOUR WORKTREE. \`rg\` HANGS here, and
  \`--glob '!node_modules'\` does NOT save it: your node_modules is a \`cp -al\` hardlink
  copy, which ripgrep's gitignore handling does not skip the way it would a normal
  ignored directory. \`git grep\` is fast, and it scans exactly the TRACKED set — which
  is the set a census should be making a claim about anyway, so this is a correctness
  win and not only a speed one. Measured 2026-08-22 on #3457, where a lane lost a
  census run to it. The \`-a\` rule above still applies when you do reach for rg.
- $SCRATCH may be UNSET in your shell. It is /home/user/scratch — the same directory
  this script and scripts/orchestrator-checkin.sh both fall back to. Do not infer it
  from another cluster's worktree, and do not write to /tmp instead.
- NAME EVERY LOG FILE AFTER YOUR BRANCH: \`$SCRATCH/gates-<branch>.log\`, never a bare
  \`gates.log\`, \`e2e.log\` or \`db.log\`. Sibling agents share one scratchpad, and they
  all reach for the same obvious names, so a generic filename is a COLLISION and the
  collision is SILENT. Measured on this box: one \`e2e.log\` held output from two
  different clusters, and a \`gates.log\` held a third's — one agent's run was
  NUL-padded and carried another worktree's path and test counts.
  This is the worst shape a wrong number can take, because the usual defence does not
  work: you ran the gate, you redirected it yourself, and you grepped the file you
  named — and the count you read belongs to somebody else's tree. Nothing inside the
  agent can tell. If a log you wrote contains a worktree path that is not yours, or
  NUL bytes, DISCARD IT and re-run into a branch-named file; do not reconcile it, and
  do not quote gates out of it.
  CHECK IT WITH \`grep -aPc '\\x00' <log>\`, and with nothing else. Every obvious
  spelling is broken and broken QUIETLY: bash cannot put a NUL in an argument, so
  \`grep -c $'\\x00'\` and \`rg -l $'\\0'\` collapse to an EMPTY pattern that matches
  every line and every file — a clean log reads as riddled, a riddled tree reads as
  clean. Without \`-a\`, grep and rg both call the file binary and skip it, reporting
  a sweep they never took. Two agents have hit this; lib/__tests__/nul-byte-census.test.ts
  carries the receipt (#3206).
- CI ARTIFACTS ARE UNREACHABLE from this container: \`*.blob.core.windows.net\` returns
  403 CONNECT through the agent proxy, so a playwright-report zip or an
  error-context.md from a real CI run CANNOT be downloaded. If a brief (mine included)
  tells you to fetch an artifact, that instruction is wrong — say so and reproduce
  locally instead.
- JOB LOGS ARE THE SAME STORY, and this line used to claim otherwise. \`GET
  /actions/jobs/<id>/logs\` 302s to that same blob host, so the REST route DIES — two
  agents burned a cycle on it before it was corrected. The ONE route that works is
  \`mcp__github__get_job_logs\` with \`return_content: true\`, and that is the justified
  exception to "use curl REST, not the MCP tools". Note its tail lands in the runner's
  post-job cleanup, so ask for enough \`tail_lines\` (~140) to reach the test summary.
- BUT REACH FOR THE ANNOTATIONS FIRST — plain REST, no MCP, and it gives you the
  FAILING TEST AND ITS ASSERTION directly:
      GET /repos/FloorLamp/allos/commits/<sha>/check-runs
      then follow each failed run's \`output.annotations_url\`
  Use this before a log tail. On 2026-08-19 \`get_job_logs\` returned the SAME capped
  window no matter what \`tail_lines\` was set to, several times, and the annotations
  endpoint answered every one of those questions in a single call.
- DIAGNOSING A CI-ONLY FAILURE: it may be TIMING rather than co-residency. A tap that
  lands pre-hydration is swallowed with no error — Playwright's actionability checks
  pass, because the element is fine — and the next assertion fails as "element(s) not
  found". Reproduce it by making the box slow, not by changing neighbours: a CDP
  \`Emulation.setCPUThrottlingRate\` spanning the suspect navigation. Run it FIVE times
  and ALWAYS against a base-tree control — the verdict is the comparison, and one run
  proves nothing in either direction. Recipe and the #2742 receipt are in
  docs/internals/e2e-hygiene.md.
${issueLines}
${MIGRATION_LINES}
- Immediately before opening the PR: git merge origin/main && npm run typecheck.
  A signature that widened while you worked is not a textual conflict.
- RUN THE AFFECTED SPECS, NOT THE CHANGED ONES. They are different sets and the
  difference is where CI catches you. When a change makes a previously
  UNCONDITIONAL element CONDITIONAL — a field moving behind a disclosure, a row
  behind a fold — EVERY spec that addresses that element is affected whether or not
  you edited it, and \`e2e-changed\` cannot see them because it selects on files
  edited. #3216 ran its 25 changed spec files green (267 tests) while three affected
  specs it had never touched were red. The sweep that works: enumerate the moved
  markers FROM THE COMPONENTS — testids AND accessible labels, since a spec using
  getByLabel names no testid — then grep the whole tree. Over-matching costs a
  minute; missing costs a CI round. Recipe in docs/internals/e2e-hygiene.md.
  A MARKER SWEEP IS NECESSARY AND NOT SUFFICIENT. Both of these were measured on
  2026-08-20 by lanes that ran a thorough marker sweep and still shipped a red:
    * A SPEC CAN ADDRESS YOUR ELEMENT WITHOUT NAMING A MARKER. nav-pending.spec.ts
      locates a row as \`aside nav a[href="/timeline"]\` — no testid, no accessible
      label, nothing a marker grep can match. Collapsing a nav group removed it from
      the DOM and the failure read as a PendingNavLink regression. So ALSO grep for
      the raw shapes: href values, role+attribute selectors, \`locator("...")\` CSS.
    * A SPEC CAN BREAK WITHOUT ADDRESSING YOUR ELEMENT AT ALL. timeline-chrome
      asserts GEOMETRY — a pinned element's y within a band — and names no nav
      marker whatsoever, so no sweep over markers of any kind reaches it. THE RULE:
      a spec that measures position, size or overflow is affected by ANY change to
      shared chrome, layout or stacking. If your diff touches a shell, a nav, a
      wrapper element, or anything portalled, enumerate the geometry-asserting specs
      SEPARATELY — grep for boundingBox, toBeInViewport, elementFromPoint, scroll
      offsets and pixel comparisons — and run them whether or not they mention you.
- VERIFY STATE AT REPORT TIME, BY ASKING RATHER THAN REMEMBERING. A command's output
  is a claim about the moment it ran, and your gates take 20-40 minutes while this
  repo merges roughly every 20. \`git merge-base --is-ancestor origin/main HEAD\`
  (exit 0) ASKS; the output of \`git merge\` REMEMBERS. Same split for CI status,
  branch/remote agreement, and "the tree was clean when I started". The trap is not
  carelessness — the remembered answer was GENUINELY TRUE, so nothing feels wrong
  while you report it.
  AND THE ANSWER MUST MEAN WHAT YOU THINK: \`--is-ancestor\` asks "do these share
  history", which after a SQUASH merge is NOT "is my work in main" — post-merge, ask
  about CONTENT. Same command, opposite verdicts, both correct.
  AND A CONTENT CHECK CAN LIE IN THE REASSURING DIRECTION. A single-line \`grep\` for a
  sentence reads a WRAPPED one as absent, and it fails toward "missing" — which is the
  direction that prompts you to go and add something already there. Measured
  2026-08-20: a lane reported a doc line missing, went to fix it, and found its
  \`grep -c\` had only failed on a line break. A verification that manufactures work is
  worse than none, because the work looks justified. Grep for a distinctive FRAGMENT
  that cannot wrap, or use \`rg -U\`, and when a content check says something is
  missing, OPEN THE FILE before believing it.
- A GUARD'S PATTERN COMES FROM HOW THE REPO WRITES THE CONSTRUCT, NOT FROM HOW THE
  ISSUE DESCRIBES IT. An issue names the defect in the shape its author had in mind.
  If you encode THAT shape, your guard is green against a tree that never used it, and
  blind to the spelling everyone actually reaches for. Measured 2026-08-20 on #3325: a
  census was written to catch \`LOWER(symptom)\` because the issue said \`LOWER()\`, while
  this repo overwhelmingly writes \`= ? COLLATE NOCASE\` — the collation attached to the
  COMPARISON, not adjacent to the column. The scanner would have shipped green and
  unable to see the most likely way anyone would introduce the bug, which is worse than
  no guard: it turns "nobody has done this" into "nobody can do this", and only the
  first is true.
  So before you encode a pattern, GREP FOR HOW THE CONSTRUCT IS ACTUALLY SPELLED here
  and enumerate the variants. It is the same order of operations as the premise audit —
  read what is there before encoding what you expect — and the same cost of skipping it.
  THEN PROVE THE GUARD CAN SEE: run it over sources authored to BREAK it, in the
  lib/__tests__/nul-byte-census.test.ts tradition. A green sweep over a COMPLYING tree
  says nothing about what the sweep can see. And assert the guard's SILENCE on the
  benign neighbours too — #3325's census had to stay quiet on five shipped
  \`ORDER BY … COLLATE NOCASE\` sorts, because sorting is not matching and a guard that
  cried wolf on them would have been deleted within a week, taking the real guard with it.
- A CONTENT CHECK MUST STATE ITS SCOPE, OR IT REPORTS ON A SCOPE IT NEVER HAD. The
  brief already says a grep can fail toward "missing" and manufacture work. It fails
  the OTHER way just as easily, and that way is louder: measured 2026-08-20, a lane
  swept the whole tree for a retracted sentence, got "STILL PRESENT (bad)" from three
  files it had never touched, and was one step from "fixing" unrelated code. Scoped to
  the seven files it actually changed, there was exactly one hit — inside a docstring
  that QUOTES the retracted rule in order to argue against it, which is correct and
  must stay.
  So: scope every content check to the files you changed, and expect a deliberate
  quotation of the thing you removed. Both directions of this failure are the same
  bug — a check whose scope is wider or narrower than the question being asked.
  AND NEVER TRUST A BARE \`grep -c\`. A count is a claim stripped of its context, and
  two more ways it lies were measured on #3391 within one verification pass:
  a CASE mismatch (the phrase was there in screaming caps; the grep was lowercase, so
  it reported "missing" — the reassuring-to-fix direction again), and a count of 1 that
  was a DIFFERENT, pre-existing, unrelated assertion, which read as "you did not remove
  the thing you said you removed". Both would have sent a lane to re-edit a correct
  merged file. Use \`-i\` when case is not part of the claim, print the MATCHES with
  context (\`-n\`, \`-B\`/\`-A\`) rather than the count, and open the file before believing a
  zero. A wrong verification is more expensive than none, because the work it invents
  looks justified.
  AND THE THIRD DIRECTION IS THE BEST DISGUISED: a check can fail toward A PLAUSIBLE
  CORRECTION OF WORK THAT WAS ALREADY RIGHT. "Missing, go add it" and "still present,
  go remove it" both feel like DISCOVERIES; this one feels like DILIGENCE. Measured
  2026-08-20 on #3404: a lane had a count right, re-censused with a file-level grep,
  made it wrong, and was about to ship the wrong number into a doc whose entire value
  is being checkable — because the file it added matched only on a MENTION of the
  symbol inside a comment.
  THE DEFENCE IS NOT SKEPTICISM ABOUT THE NUMBER. It is asking WHAT THE CHECK IS
  MATCHING ON: a filename grep for a symbol matches comments (over-matches) and misses
  anything that hand-rolls the thing instead of importing it (under-matches), so it is
  wrong in both directions at once. Match on the IMPORT, or on whatever actually
  constitutes membership. That same question then found a whole component nobody's
  census had ever seen (#3405).
- VERIFY A SQUASH MERGE BY CONTENT, NOT ANCESTRY — the concrete form of the line
  above, because two lanes reached for it independently on the same night and both
  were right to. Your branch collapses into ONE commit on main, so \`--is-ancestor\`
  says NO and that NO is CORRECT. Do not "fix" it. Ask instead whether the CONTENT
  landed: the symbols you added, the deletions you made, and above all the REVERTS —
  #2774 checked that a \`touch-manipulation\` class it had deliberately reverted was
  still absent THROUGH the merge, which is a thing ancestry could never have told it.
- A SIGNAL MUST BE DISTINGUISHABLE FROM ITS OWN TEST FIXTURE. When you add
  instrumentation that announces a rare event, the test you write to exercise it
  forges that event ON PURPOSE — and if the forged occurrence prints the same thing
  the real one does, YOUR ONE REAL SIGNAL ARRIVES PRE-BURIED in the output of the
  test that proves the signal works. Measured 2026-08-20 on #3368: a lost-submit
  rescue was made to log when it fires, and its regression test forges a lost click on
  THE VERY CONTROL AND ROUTE the original sighting came from, so three deliberate hits
  per run sat in the grep output looking exactly like the thing the grep is for.
  THE FIX IS NOT TO SUPPRESS THE TEST'S COPY — a log line that never executes in CI is
  untested code that breaks on the day it matters, and the forged lines double as
  proof the announcement machinery still works. MARK IT INSTEAD: have the page or the
  fixture declare that this occurrence is forged, and print the two cases as different
  sentences ("FORGED BY A SPEC on purpose" vs "NOT forged — this is real"). Verify by
  running the affected specs and counting: the number of marked lines must equal the
  number of forgeries, and nothing else may print.
  AND WHEN A HYGIENE GATE BLOCKS THE OBVIOUS ROUTE, THAT IS USUALLY THE GATE BEING
  RIGHT. That lane tried \`test.info()\` to name the spec, which needs
  \`@playwright/test\` in helpers.ts — forbidden by lib/__tests__/e2e-hygiene.test.ts —
  and importing the extended \`test\` from ./fixtures would have been a cycle. It did
  NOT add an allow-list entry. Widening a hygiene guard to buy a diagnostic nicety is
  the wrong trade, and the design the guard forced (the page declares its own forgery)
  is better than the one it blocked.
- LET INSTRUMENTATION SURVIVE ITS OWN USEFULNESS. A click log or a touch log that
  pins nothing and backs no assertion looks exactly deletable, and a reviewer WILL
  reach for it — write the comment above it addressed to that reviewer specifically.
  Keeping it is what makes the NEXT red self-describing instead of a bare "element
  not found". In the #2774 investigation every one of four eliminated hypotheses came
  from making the test say MORE on failure, not less, and the final rewrite could
  drop an assertion only because the instrumentation licensing that drop was already
  paid for. Scaffolding that earned a diagnosis is not scaffolding any more.
- Never typecheck with bare npx tsc --noEmit. npm run typecheck runs next typegen
  first, and a fresh worktree has no .next/types, so bare tsc reports three
  TS2578 "Unused '@ts-expect-error'" in lib/__tests__/revalidate-route.test.ts.
  That is a GUARD firing exactly as its comment there says it will, not a
  regression on your branch — two agents have now hunted it.
- Gates: run bash scripts/orchestration/agent-gates.sh from the worktree root — it
  runs lint, typecheck, the pure tests, the DB tier when your diff touches anything
  it imports, the e2e-hygiene scan when specs changed, phi-scan, and format LAST, in
  the mandated order. A gate that prints SKIPPED names its reason — that is the
  script scoping itself to your diff, not a gate you missed. Report its output verbatim.
  Give that Bash call an explicit long timeout; if it cannot fit one tool call
  under contention, run the same gates individually in the same order.
- WHEN A CONTROL RUN IS SAMPLING A RACE, DO NOT RUN IT MORE TIMES — REMOVE THE RACE
  AND MEASURE THE QUANTITY UNDERNEATH. Repeats can only ever make a verdict PROBABLE,
  and on an intermittent failure a green control proves nothing at all: it has just
  not rolled again. Measured 2026-08-20 on #3384, where a lane was told to run repeats
  at two commits to decide whether a neighbouring PR had caused a 5px overflow. It did
  something better — it waited for the content the spec was racing, then read
  scrollWidth/clientWidth directly at both commits: 363/358 either side, IDENTICAL.
  One run each, and it exonerated a commit the lane had every incentive to blame.
  The general form: a flaky comparison is usually a measurement taken at an unstable
  moment. Find what makes the moment unstable, wait for it, and the comparison becomes
  a single reading instead of a sample. Run the repeats too if you like — but say
  plainly which of the two carried your verdict.
- A FAILURE IN CODE YOU DID NOT TOUCH IS CONTENTION UNTIL PROVEN OTHERWISE. Up to
  five agents share four cores here, and measured load has reached 22 — a starved
  tier fails in specs nobody edited and reads exactly like a regression. Before
  reporting one, RE-RUN THAT FILE ALONE, and if it still fails build an
  origin/main control worktree and show it failing there too. Report the
  comparison, not the first red. Two agents were saved from a false regression
  report this way on 2026-08-15 only because they thought of it themselves.
- A RACE THAT RESOLVES TOWARD THE EMPTY DOM FAILS TOWARD GREEN. Measured 2026-08-20
  on #3384, and it is the purest form of the trap this whole brief circles. A spec
  measured a dialog body's width WITHOUT FIRST WAITING FOR ANYTHING INSIDE IT. The
  region renders a loading paragraph while its real content arrives — and a paragraph
  fits any width. So the check passed by looking at a PLACEHOLDER instead of the form
  it names, sailed through twelve shards on its own PR and twelve more on the next
  one, and reported success without ever having examined the thing it claimed to
  examine. It only ever failed when CI happened to be past the mount.
  THE TELL, and it is worth learning as a signature: WHETHER you see the failure was a
  race, but HOW BIG it was never varied. A stable wrong value with an unstable
  occurrence means something real is being measured SOMETIMES — not that the value is
  noise. Do not dismiss it as flake, and do not conclude the failure is deterministic
  either (that was my own error on the same issue, corrected within the hour).
  SO: before you measure a container, WAIT FOR THE CONTENT YOU MEAN TO MEASURE — a
  specific child, not the container's own visibility. Any assertion about size,
  overflow, position or count on a region that loads asynchronously is making a claim
  about whatever happened to be there, and empty is the state that flatters you.
- A GENEROUS CEILING IS HONEST ON A *PRESENCE* ASSERTION AND DANGEROUS ON AN
  *ABSENCE* ONE. This is the rule to reach for before arguing about timeouts at all.
  Waiting longer cannot make a row that was never created appear — so if the write is
  genuinely broken, a presence assertion still fails and the budget cost you nothing.
  Waiting longer CAN let a bug's window close under an absence assertion, which then
  passes against the very bug it exists to catch: that is why #3287's dedicated spec
  asserts NOTHING after its discard, and why a retrying toHaveCount(0) is the shape to
  distrust. A slow write and a swallowed pre-hydration tap read IDENTICALLY as
  "element(s) not found"; the discriminator is whether a bigger ceiling rescues it, and
  the answer only means something on a presence. Measured both ways in the tree:
  activity-equipment.spec.ts (hydratedClick 0/5 -> 0/5, ceiling 0/5 -> 4/5, so latency)
  and imaging.spec.ts (the opposite verdict, so latency DISPROVEN). If you add a
  ceiling, NAME it as a constant and put the measurement in the comment — the number
  alone is indistinguishable from a guess.
  AND THE DERIVATION IS NOT BOOKKEEPING; IT IS HOW YOU FIND OUT THE CONSTANT IS WRONG.
  Measured on #3391: a lane was asked to state what a ceiling's headroom was FOR, went
  to write that sentence, and discovered while writing it that the bound was checked
  against the wrong quantity and could never fire at all — a defect no amount of
  staring at the number would have surfaced, because the number was irrelevant. Having
  to say out loud what a bound is bounding is the check. Demand the stated unit even
  when the constant looks obviously right.
- E2E SPLITS IN TWO, AND ONLY ONE HALF RUNS ON THIS BOX.
  * SPECS YOU AUTHORED OR EDITED: run locally, at CI parity, on your assigned port
    range: E2E_PORT=${portBase} ... --repeat-each=3 --retries=0. The variable is
    E2E_PORT, never PORT. This is usually one to three files and it is where you can
    actually introduce a flake, so the repeat is earned here.
  * EVERY OTHER SPEC — the blast radius, the geometry-asserting sweep, the specs that
    merely exercise code you changed: DO NOT RUN THEM LOCALLY. Push, and read CI.
  Do NOT run the full suite locally — the orchestrator owns full-suite runs.

  WHY, IN NUMBERS, because this reverses what lanes did until 2026-08-21: CI runs ALL
  438 spec files across TWELVE parallel shards in 4-5 MINUTES of wall clock. A lane
  running ~20 named files in a batch takes 2.5-4 minutes PER BATCH and needs about
  nine of them to cover a blast radius — call it 30 minutes, for a fraction of the
  coverage, on four cores it is sharing with every sibling lane. CI is both faster
  and more complete, and it costs this box nothing.

  AND \`--repeat-each=3\` BUYS ALMOST NOTHING ON THE BLAST RADIUS, which is the part
  that makes this a correctness argument and not only a speed one. The failures a
  repeat would catch in a spec you did NOT author are co-residency effects — a spec
  behaving differently because of WHO IT RAN BESIDE. Those depend on shard
  composition, and an ORDINARY local run does not reproduce it. So repeating a
  blast-radius spec locally re-rolls a die that is not the die CI throws.
  Repeat what you wrote; let CI run what you did not.

  BUT THE SHARD *IS* REPRODUCIBLE WHEN YOU NEED IT, and an earlier version of this
  brief said flatly that it was not. That was wrong and it cost a diagnosis:
  \`scripts/e2e-shard-plan.ts <n> 12\` is deterministic, but it is balanced from
  RECORDED DURATIONS, so it must be recomputed AT THE HEAD THAT RAN — not on main,
  and not at your current head if the failure was two pushes ago. Running it on main
  points at the wrong neighbours: in the #3400 diagnosis main's shard 11 was the
  37-file set that PASSED, while both failing runs held a 38-file set. The job log
  lists what actually ran, so use it as ground truth and use the recomputed plan to
  confirm you matched it. This is for DIAGNOSING a specific red, not for routine
  verification — the policy above is unchanged.

- THE PR IS AN INSTRUMENT, NOT A FINISH LINE. CI triggers on \`pull_request\` only —
  never on a branch push — so until the PR exists you have no CI, and the policy
  above cannot work. Open it as soon as lint, typecheck and the pure tier are clean,
  then iterate against CI. \`concurrency: cancel-in-progress\` is keyed per ref, so a
  second push CANCELS your own earlier run rather than queueing behind it or behind
  a sibling; pushing again is cheap and is the intended loop.
  A red on your own PR before review is not a broken window. A red you LEAVE is.
  Read every CI red and say what it was — yours, contention, or a re-partition.
- \`e2e (N)\` IS NOT \`--shard=N/12\`, and reaching for the obvious spelling gives you a
  FALSE GREEN off the wrong 113 tests. CI builds each shard from a DURATION-BALANCED
  plan (scripts/e2e-shard-plan.ts over e2e/spec-durations.json); Playwright's own
  count-based \`--shard\` is only the fallback that script emits when the manifest is
  MISSING, so the two partitions genuinely differ. Measured 2026-08-20 on PR #3357:
  the two specs failing in \`e2e (1)\` land in Playwright's shard 12, and shard 12 was
  GREEN in that same CI run — so \`--shard=1/12\` would have "reproduced" the failure
  by running neither of them. Reproduce a named CI shard with the plan, exactly as
  the script's own header shows:
      mapfile -t ARGS < <(npx tsx scripts/e2e-shard-plan.ts 1 12)
      npx playwright test "\${ARGS[@]}"
  And when you argue "my diff did not move shard composition", CHECK it rather than
  asserting it: diff the plan output between your branch and origin/main. Composition
  moves when a .spec.ts file is ADDED or REMOVED, or when e2e/spec-durations.json
  changes — editing an existing spec does not move it.
  AND IF YOU DID ADD A SPEC FILE, YOU RE-PARTITIONED ALL TWELVE SHARDS. Measured
  2026-08-20 on #3388: adding ONE spec changed shard 1 by 24 specs in and 23 out. A
  spec you never touched stayed in shard 1 but ran beside an entirely different
  NEIGHBOUR SET — and then failed, on a route the diff does not render on. You changed
  its COMPANY, not its behaviour.
  So a red in a spec you did not touch, on a PR that adds a spec file, is a THIRD
  possibility beside "mine" and "contention": a latent co-residency bug your
  re-partition exposed.
  AND THE RE-PARTITION IS NOT THE FAILURE — IT ONLY CHANGES THE DICE. Same PR, same
  commit, same partition: a plain re-run went GREEN. So adding a spec permanently
  changes WHO a spec's neighbours are, and whether the latent bug then fires is a
  FURTHER ROLL. The consequence is the one that catches people: a lane that adds a
  spec, reds once, and re-runs to green HAS NOT DISPROVED ANYTHING — it has only
  declined to roll again. Report the re-partition you caused either way; a green
  re-run is not a clean bill for the spec whose company you changed. Diff the plan (\`tsx scripts/e2e-shard-plan.ts N 12\`) between
  your branch and a control to see whose neighbours you changed, and say so.
  DO NOT respond by refusing to add spec files. The partition's fragility is the bug;
  a suite that cannot grow without hiding failures is measuring less every time.
- DO NOT OPT A FIXTURE OUT OF THE E2E TIMEZONE PIN without reading
  e2e/fixture-timezones.ts, and if you do, your \`why\` must still be TRUE.
  e2e/pinned-timezone.ts pins local time to 13:mm ON PURPOSE — that is also
  DEFAULT_INTAKE_REMINDER_MINUTES.Midday, so a profile following it sits at the
  centre of a meal window at every UTC start hour. A profile pinned to UTC instead
  has a local minute-of-day equal to the run's REAL UTC start hour, so anything
  carrying meal-window timing goes dark once the last window closes. #3260 was a
  main-red from exactly this: green 21 hours a day, red the other 3, for weeks —
  and the opt-out survived because its stated reason had gone false and nothing
  checks that a \`why\` still describes its seed.
- Any e2e fixture whose feature groups by profile-LOCAL date/time MUST build instants
  via zonedWallTimeToUtc(getTimezone(profileId), day, "HH:MM") — never naive
  \`\${day}THH:MM\` strings — the seed pins a ROTATING per-run instance timezone
  (e2e/pinned-timezone.ts), so naive strings parse host-UTC (#1417)
- NO high-entropy random-looking string literals in tests/fixtures (synthetic tokens
  included) — use low-entropy words+digits values
- AN ARTIFACT THAT SATISFIES AN ACCEPTANCE CRITERION MUST BE COMMITTED, NOT LEFT IN
  $SCRATCH. Measured 2026-08-20 on #3320: a previous lane's census script — the thing
  an AC named in the words "the query exists and is recorded" — survived only as a
  file in the shared scratchpad, one container restart from gone, while its PR was
  already merged. Scratch is for LOGS and WORKING FILES. If a deliverable is a script,
  a query, a probe or a measurement someone is meant to re-run, it belongs in the tree
  with a way to invoke it. Ask of every AC: does satisfying this leave something behind,
  and is that something in git?
- Every scratch file you write goes in $SCRATCH ITSELF, never inside your worktree,
  and gets a branch-unique name ($SCRATCH/pr-body-${opts.branch.split("/").pop()}.md,
  never pr-body.md) — $SCRATCH is shared by every concurrent agent, and an untracked
  file left in the worktree reads to the check-in as unrescued work. Every finished
  cluster used to trip "DIRTY AND NO AGENT: RESCUE NOW" over a PR body already
  published on GitHub, which is the ignorable-alarm failure the flight recorder
  exists to avoid. The branch-unique rule covers every LOG and temp file too
  ($SCRATCH/gates-${opts.branch.split("/").pop()}.log, never gates.log): the logs are
  what collide in practice — two clusters appending to one gates.log interleaved their
  vitest output, and each read the other's failures as its own.
- NEVER \`git stash\` — NOT \`push\`, NOT \`pop\`, NOT \`-u\`. THE STASH STACK IS SHARED
  ACROSS EVERY WORKTREE, because they share one .git. A \`pop\` in YOUR tree takes
  whatever is on top of the stack — which may be another agent's, or the
  orchestrator's — dumps it into YOUR working copy, and CONSUMES the entry.
  Measured 2026-08-20 on #3220: a lane stashed to diff a shard plan, popped, and
  received five files it had never touched, including a DELETION. Nothing was lost
  only because the lane noticed, restored its tree from HEAD, and re-created the
  stash by hand with a patch copy — and because its own work was already committed.
  WORSE, THE ENTRY IT NEARLY DESTROYED WAS A REVERT OF A MERGED FIX. Silently applied,
  it would have re-broken a shipped safety fix and deleted that fix's test file, in a
  tree whose owner had no reason to look.
  AND IT APPLIED CLEANLY — no conflict, nothing to notice. That is the part that
  defeats "I would spot it": a stash from another lane's base lands silently, and the
  only signal is a diffstat you had no reason to read. If you ever DO meet an
  unexpected stash entry, read its diffstat before trusting it; a clean apply is not
  evidence it belongs to you.
  If you need a clean tree: COMMIT (your work must be pushed anyway — see the hard
  gate above), or copy files to $SCRATCH with branch-unique names, or use a second
  worktree. All three are safe; the stash is the only one that reaches across lanes.
- NEVER \`pkill -f <pattern>\` — not vitest, not next, not playwright, not your own
  harness name. Sibling clusters run the same binaries in this container, so a pattern
  kill takes their runs down with yours and they have no way to tell that from a real
  failure. Kill only an explicit PID you captured yourself.
- node_modules in your worktree is a hardlink COPY (cp -al), never a symlink: a symlink
  satisfies vitest but makes \`next build\` die with "TurbopackInternalError: Symlink
  [project]/node_modules is invalid, it points out of the filesystem root", so an e2e
  run fails in global-setup before a single spec starts. Hardlinks share inodes with the
  canonical tree, so never write INTO node_modules — recreate node_modules/.cache after
  the copy.
- Use the GitHub token by its NAME — $GH_TOKEN (fallback $GITHUB_TOKEN) — in every curl;
  never "search the environment for credentials"
- Use curl REST for GitHub reads, not the MCP tools (MCP rides the owner's rate limit)
- PR body: closing keywords each ON THEIR OWN LINE (Fixes #N — GitHub parses one per line)
- Commit trailers EXACTLY (copy the Co-Authored-By line from your own environment's
  commit instructions — the model name varies by session; do not hardcode one here):
    Co-Authored-By: Claude <model> <noreply@anthropic.com>
    Claude-Session: <session URL>
- No model identifiers in commits/PR/code
- Open the PR READY (not draft) via REST, base main
- NEVER run \`dispatch-brief.mjs done\` — retiring a dispatch is the ORCHESTRATOR's,
  after the PR merges. Opening the PR is not the end of your dispatch: review
  findings, CI reds and adversarial refutations all come back to you afterwards, and
  a retired dispatch drops you off the roster that a restart reads to find unrescued
  work. If you see a "Close with:" line anywhere near this brief, it is addressed to
  the orchestrator, not to you.
- Return: PR number/URL, per-issue fix summary, VERBATIM gate results (say plainly if
  something failed — never report a green you did not see), surprises, and OPEN
  QUESTIONS as their own labelled list — every decision you made provisionally and
  every one you could not make, stated as questions. A question buried mid-prose is
  a question nobody answers; the orchestrator turns this list into \`needs-human\`
  labels with the owner assigned.`;

  return { brief, portBase, active };
}

// --- commands ---------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    issues: [],
    e2e: false,
    portBase: null,
    task: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--branch") opts.branch = argv[++i];
    else if (a === "--worktree") opts.worktree = argv[++i];
    else if (a === "--issues")
      opts.issues = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--task") opts.task = argv[++i];
    else if (a === "--slot")
      throw new Error(
        "--slot is retired: migrations are name-keyed (no reservation needed) — the brief already carries the convention"
      );
    else if (a === "--e2e") opts.e2e = true;
    else if (a === "--port-base") opts.portBase = Number(argv[++i]);
    else throw new Error(`unknown flag: ${a}`);
  }
  return opts;
}

function cmdNew(argv) {
  const opts = parseArgs(argv);
  if (!opts.branch) {
    console.error(
      "usage: dispatch-brief.mjs new --branch <branch> [--worktree wt-x] [--issues 1,2]" +
        ' [--task "..."] [--e2e] [--port-base N]'
    );
    process.exit(2);
  }
  opts.worktree ??= `wt-${opts.branch.split("/").pop()}`;

  const rows = readLedger();
  const active = activeDispatches(rows);
  // An already-active branch must not be re-dispatched. Re-running `new` to get
  // the brief text back (the transcript is gone, the ledger stores metadata) used
  // to append a SECOND ledger row and a second roster cluster for one live agent
  // — a roster that double-counts is a roster that lies about what to rescue, and
  // it is read after a restart when nothing else survives. Reprinting is what the
  // caller actually wanted, so `brief` does that and this refuses (2026-08-15).
  if (active.some((d) => d.branch === opts.branch)) {
    console.error(
      `REFUSED: ${opts.branch} is already an active dispatch — re-running \`new\` would ` +
        "duplicate its ledger row and its roster cluster. To reprint the brief for a live " +
        `agent, use \`dispatch-brief.mjs brief ${opts.branch}\`; to retire it, \`done ${opts.branch}\`.`
    );
    process.exit(1);
  }
  if (opts.e2e && active.filter((d) => d.e2e).length >= 2) {
    console.error(
      "REFUSED: two e2e-touching dispatches are already active (the runbook's cap). " +
        "Close one with `done <branch>` or drop --e2e if this work touches no spec."
    );
    process.exit(1);
  }

  // ARRIVAL CLUSTERING. The concurrency cap counts agents RUNNING, which is a
  // machine-load limit. It says nothing about the other queue — PRs waiting on
  // the orchestrator's review — and that one is where a session actually jams,
  // because review is serial and cannot be parallelised the way dispatch can.
  //
  // Dispatching several at once reliably lands them together, and the ledger is
  // what proves it rather than intuition: measured over the first ten completed
  // dispatches, seven finished inside an 85±5 minute band (42/73/79/85/86/86/
  // 88/89/106/122). Durations here are PREDICTABLE, so simultaneous starts are
  // simultaneous arrivals, and three at once is three full diffs plus any
  // mandatory falsifiers landing in one window.
  //
  // A warning, not a refusal: a P0 preempts everything and must not be argued
  // with by a script. It fires only when a sibling actually started inside the
  // window, so it stays rare enough to keep meaning something.
  const STAGGER_MIN = 25;
  const recent = active
    .map((d) => ({
      branch: d.branch,
      ageMin: (Date.now() - Date.parse(d.at)) / 60000,
    }))
    .filter((d) => d.ageMin < STAGGER_MIN)
    .sort((a, b) => a.ageMin - b.ageMin);
  if (recent.length) {
    const durations = completedDurationsMs(rows).sort((a, b) => a - b);
    const median = durations.length
      ? durations[Math.floor(durations.length / 2)] / 60000
      : null;
    console.error(
      `\n*** ARRIVAL CLUSTERING: ${recent.length} dispatch(es) started within ${STAGGER_MIN}m ***`
    );
    for (const d of recent) {
      console.error(
        `      ${d.branch} started ${d.ageMin.toFixed(0)}m ago` +
          (median ? ` — due in ~${(median - d.ageMin).toFixed(0)}m` : "")
      );
    }
    console.error(
      median
        ? `      this one is due in ~${median.toFixed(0)}m, so expect ${recent.length + 1} PRs in one review window.`
        : "      expect their PRs to land in one review window."
    );
    console.error(
      "      Not a refusal — a P0 preempts. Otherwise consider waiting: the cap that\n" +
        "      binds first is REVIEW depth, not agent count (docs/orchestration/dispatch.md).\n"
    );
  }

  const { brief, portBase } = buildBrief(opts);
  const entry = {
    at: new Date().toISOString(),
    status: "active",
    branch: opts.branch,
    worktree: opts.worktree,
    issues: opts.issues,
    task: opts.task,
    portBase,
    e2e: opts.e2e,
  };
  appendLedger(entry);
  const rostered = rosterAdd(entry);
  if (!rostered) {
    console.error(
      `[ledger] WARNING: could not write ${rosterPath} — orchestrator-checkin.sh will not know this agent is live.`
    );
  }

  console.log(brief);
  console.error(
    `\n[ledger] recorded in ${ledgerPath} — port base ${portBase}` +
      `\n[ledger] ORCHESTRATOR ONLY, after the PR merges — not part of the brief above:` +
      `\n[ledger]   dispatch-brief.mjs done ${opts.branch}`
  );
}

function cmdList() {
  const rows = readLedger();
  const active = activeDispatches(rows);
  // A stall threshold derived from a degenerate sample is a FALSE ALARM
  // GENERATOR, which is worse than no threshold — the whole point of the
  // check-in tooling is that its alarms are worth reading.
  //
  // Observed live: backfilling three in-flight clusters into a fresh ledger
  // (dispatch, then `done`, then re-dispatch with the right worktree names)
  // left five "completed" entries lasting about a minute each. Median 1m,
  // threshold 3m, and both real clusters — 23 minutes into work that routinely
  // runs an hour — were immediately branded STALL. Every row shouting is how
  // the previous restart detector failed.
  //
  // Two guards, because the sample can be degenerate in two different ways:
  // too FEW completions to be a distribution at all, and completions too SHORT
  // to be real dispatches (a backfill, an aborted probe, a `done` typo). A
  // dispatch that finished in under MIN_REAL_DISPATCH_MS did not do a cluster's
  // work, so it says nothing about how long a cluster takes.
  const MIN_COMPLETIONS_FOR_MEDIAN = 3;
  const MIN_REAL_DISPATCH_MS = 5 * 60_000;
  const allDurations = completedDurationsMs(rows).sort((a, b) => a - b);
  const durations = allDurations.filter((d) => d >= MIN_REAL_DISPATCH_MS);
  const median =
    durations.length >= MIN_COMPLETIONS_FOR_MEDIAN
      ? durations[Math.floor(durations.length / 2)]
      : null;
  const discarded = allDurations.length - durations.length;
  const fmt = (ms) =>
    `${Math.floor(ms / 3_600_000)}h${String(Math.floor(ms / 60_000) % 60).padStart(2, "0")}m`;

  // THE THRESHOLD IS UNCHANGED; WHAT IT MEASURES IS NOT. 3x the median and the
  // under-5m filter are both sound (#2988 says so explicitly) — the defect was
  // comparing them against a dispatch's AGE. Applied to idleness instead, the
  // same number can only ever fire LATER than it did, because idle <= age always:
  // this change removes alarms and adds none, which is the property that makes it
  // safe to land under live agents.
  //
  // A dedicated idle constant was the tempting alternative and it is wrong at
  // both ends. RECENT_WRITE_MS (10m) is calibrated for a REFUSAL at the moment of
  // destruction, where the cost of waiting is nothing; as a warning threshold it
  // would fire on any agent whose gate run writes its log to $SCRATCH — which the
  // brief mandates — and go quiet for twenty minutes. Any other number would be
  // invented. 3x median is the one the ledger measures.
  const threshold = median === null ? null : 3 * median;
  if (!active.length) {
    console.log("No active dispatches.");
  } else {
    console.log(`Active dispatches (ledger: ${ledgerPath}):`);
    const worktrees = worktreePathsByBranch();
    for (const d of active) {
      const age = Date.now() - Date.parse(d.at);
      const wt = worktrees.get(d.branch);
      const idle = idleMsFrom({
        worktreeIdleMs: wt ? worktreeIdleMs(wt) : null,
        branchIdleMs: branchIdleMs(d.branch),
      });
      const verdict = stallVerdict({
        ageMs: age,
        idleMs: idle,
        thresholdMs: threshold,
      });
      const flag =
        verdict.kind === "stalled"
          ? `  << nothing has moved in ${fmt(idle)} (past 3x median) — STALL until` +
            " proven otherwise (check worktree + transcript bytes)"
          : verdict.kind === "no-trace"
            ? "  << NO WORKTREE AND NO BRANCH after " +
              `${fmt(age)} — the agent never started (a DENIED tool call looks` +
              " exactly like this) or its dispatch is stale: `done` it"
            : "";
      console.log(
        `  ${d.branch}  age=${fmt(age)}  idle=${idle === null ? "(no trace)" : fmt(idle)}` +
          `  port=${d.portBase}` +
          `${d.e2e ? "  [e2e]" : ""}${d.issues?.length ? `  issues=${d.issues.join(",")}` : ""}` +
          flag
      );
    }
  }
  // WORKTREES NOBODY CLAIMS — the blind spot that made the idle number LIE.
  //
  // Idle is "newest of branch tip, worktree write", and both are read from the
  // objects the LEDGER names. A lane that finishes its first issue and starts the
  // second on a NEW branch in a NEW worktree freezes both of those at the instant it
  // moved, so a highly productive agent reads as totally still. Measured live
  // 2026-08-20: the #3270/#3271 lane showed idle=2h10m and "silent on two requests"
  // while it had a 21-file PR open the whole time, on agent/3271-combobox-portal in
  // wt-combobox-portal. The stall rule was not wrong; its INPUTS were bound to the
  // wrong objects, which is the harder failure to see because the number looks fine.
  //
  // So print every $SCRATCH worktree no ACTIVE dispatch claims. It costs one line
  // when the board is clean, and it answers both directions at once: a lane that
  // moved (branch present, work recent) and a genuinely orphaned tree left by a dead
  // agent (the "DIRTY AND NO AGENT" case the check-in exists for). Do NOT infer a
  // stall from a frozen ledger branch without reading this list first.
  const claimed = new Set(active.map((d) => d.branch));
  const stray = [...worktreePathsByBranch()]
    .filter(
      ([branch, dir]) => !claimed.has(branch) && dir.startsWith(STATE_DIR)
    )
    .map(([branch, dir]) => ({ branch, dir, idle: worktreeIdleMs(dir) }));
  if (stray.length) {
    console.log("Worktrees no active dispatch claims:");
    for (const s of stray) {
      console.log(
        `  ${s.dir}  branch=${s.branch}  idle=${s.idle === null ? "(no trace)" : fmt(s.idle)}` +
          "  << a lane that MOVED here reads as stalled above; check this before" +
          " calling a stall"
      );
    }
  }

  const note = discarded
    ? ` (${discarded} completion(s) under ${MIN_REAL_DISPATCH_MS / 60_000}m ignored as not-real-work)`
    : "";
  if (threshold !== null) {
    console.log(
      `Completed: ${durations.length}, median ${fmt(median)} — a dispatch is flagged ` +
        `after ${fmt(threshold)} with NOTHING MOVING (newest of: branch tip, worktree ` +
        `write), not after ${fmt(threshold)} of age${note}.`
    );
  } else {
    // Say WHY it is unavailable — "no completions yet" was reported even when
    // five existed and were all discarded, which reads as a broken ledger.
    console.log(
      `Stall threshold unavailable: ${durations.length} real completion(s), need ` +
        `${MIN_COMPLETIONS_FOR_MEDIAN}${note}. Ages and idles above are ` +
        "informational; a no-trace dispatch is still flagged."
    );
  }
}

// "Has anybody touched this tree lately?" — the question the dirty check cannot
// ask. Ten minutes is chosen to be longer than a gate run's quiet stretch (a
// `next build` writes continuously; the pure tier does not) and far shorter than
// the stall threshold, so it separates "mid-task and quiet" from "gone".
//
// Walks the tree's own files, skipping node_modules and .git — those are hard
// links from the parent checkout and a shared .git is written by every OTHER
// worktree's commits, which would make every tree look permanently busy.
const RECENT_WRITE_MS = 10 * 60_000;

// Pids whose CURRENT WORKING DIRECTORY is inside `dir`. Occupancy, asked directly
// rather than inferred from file mtimes — see the retirement guard for why the
// proxy is not enough on its own. /proc is Linux-only; on anything else this
// returns nothing and the mtime check carries the load alone, which is the same
// safety this had before.
export function processesIn(dir) {
  const target = path.resolve(dir);
  let pids;
  try {
    pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  const self = String(process.pid);
  return pids.filter((pid) => {
    if (pid === self) return false;
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      return cwd === target || cwd.startsWith(target + path.sep);
    } catch {
      return false; // vanished, or not ours to read
    }
  });
}

export function worktreeIdleMs(dir) {
  let newest = 0;
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(d, e.name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        continue;
      }
      if (e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  return newest === 0 ? null : Date.now() - newest;
}

// Locate a branch's worktree by asking git, not by guessing a path — two live
// clusters once built theirs OUTSIDE $SCRATCH and were invisible to every
// path-glob check. `git worktree list --porcelain` knows every worktree this
// repo has, wherever it is.
//
// Read ONCE into a map: `list` wants this for every active dispatch, and asking
// git per branch would re-parse the same output five times a check-in.
function worktreePathsByBranch() {
  const byBranch = new Map();
  const out = git("worktree list --porcelain", { allowFail: true });
  if (!out) return byBranch;
  let current = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && current) {
      byBranch.set(line.slice("branch refs/heads/".length), current);
    }
  }
  return byBranch;
}

function worktreeForBranch(branch) {
  return worktreePathsByBranch().get(branch) ?? null;
}

// --- progress ---------------------------------------------------------------
//
// THE STALL DETECTOR ASKS THE QUESTION AGE WAS STANDING IN FOR (#2988).
//
// `list` flagged a dispatch on ELAPSED TIME SINCE ITS LEDGER ENTRY, which cannot
// tell "one agent wedged for five hours" from "four agents in sequence on one
// branch across two restarts and three review rounds" — the normal life of any
// PR that gets blocked and fixed, i.e. most of the hard ones. On 2026-08-16 it
// branded the two hardest dispatches in the session STALL twice in one session
// while their agents were demonstrably working: at 06:39Z the same two trees had
// 18 and 170 files written in the preceding fifteen minutes. That is the
// ignorable-alarm failure the check-in tooling exists to avoid — an alarm that
// fires when nothing is wrong teaches its reader to skim it, and the one time it
// is right it gets skimmed too.
//
// THE SIGNAL WAS ALREADY IN THIS FILE. `worktreeIdleMs` above was written for
// `done`, which refuses to remove a tree written in the last ten minutes because
// "a clean tree means everything is pushed, not that nobody is here". So one
// command in this file already knew how to tell a live agent from a dead one and
// the other did not: `done` would refuse to touch a tree written nine minutes ago
// while `list` called the same dispatch stalled. The fix is to stop asking two
// different questions about one fact.
//
// This is #2984's move exactly. The rescue alarm stopped guessing which NAMES a
// read-only lane might be spelled with and asked what the name stood for — "was
// anything authored here?". Same shape: stop timing the dispatch and ask what the
// clock stood for — "has anything moved here?".
//
// SO NO RE-STAMPING. The alternative was to have a dispatch that changes hands
// re-stamp its ledger entry, and it is worse in three ways. It is bookkeeping
// nobody performs at the one moment it matters (an agent has just died). It
// cannot be verified — a missed re-stamp is indistinguishable from a real stall,
// which is the drift #2984 removed. And it would corrode the very threshold it
// feeds: `completedDurationsMs` measures a dispatch from its LAST `active` row,
// so re-stamping shortens every completed duration, shrinks the median, and
// lowers 3x it — the false alarms would arrive SOONER. Progress detection needs
// no bookkeeping and cannot drift.

/**
 * Idle milliseconds implied by a git committer timestamp (`%cI`).
 *
 * Separated from the `git log` call so the arithmetic is testable without a
 * fixture repo. Anything git could not answer — a branch with no ref, an empty
 * string, an unparseable date — is `null`, meaning "no signal", never `0`.
 */
export function commitIdleMs(isoCommitterDate, now = Date.now()) {
  if (!isoCommitterDate) return null;
  const at = Date.parse(isoCommitterDate);
  if (Number.isNaN(at)) return null;
  return Math.max(0, now - at);
}

/**
 * How long ago this branch's tip was written.
 *
 * The LOCAL ref first, and the remote-tracking ref only as a fallback. #2988
 * proposed the remote ref, but `list` does not fetch, so `refs/remotes/origin/*`
 * is only as fresh as the last `fetch` anyone happened to run — and the brief
 * lets an agent go ~45 minutes or ~10 files between pushes by design, so a remote
 * ref would manufacture idleness on an agent committing steadily. Every worktree
 * shares this checkout's `.git`, so an agent's commit is visible in
 * `refs/heads/<branch>` the instant it lands, with no network.
 */
function branchIdleMs(branch) {
  const local = git(`log -1 --format=%cI refs/heads/${branch}`, {
    allowFail: true,
  });
  if (local) return commitIdleMs(local);
  const remote = git(`log -1 --format=%cI refs/remotes/origin/${branch}`, {
    allowFail: true,
  });
  return commitIdleMs(remote);
}

/**
 * The most recent movement across every signal that has one.
 *
 * EITHER witness silences the warning, because either one is proof the dispatch
 * is alive: a fresh commit without recent writes is an agent that just banked and
 * is reading; fresh writes without a commit is an agent mid-edit. Requiring both
 * would reintroduce a false alarm on each.
 */
export function idleMsFrom({ worktreeIdleMs: wt, branchIdleMs: br }) {
  const seen = [wt, br].filter((n) => typeof n === "number");
  return seen.length ? Math.min(...seen) : null;
}

// A dispatch with NO worktree and NO branch has left no trace at all, and that is
// the shape of the one stall this runbook has actually measured: the 12.9-hour
// "denied-and-idle" agent of 2026-08-10 (docs/orchestration-incidents.md) had its
// first `git worktree add` refused by the permission system, correctly did not
// retry, and sat — four tool calls, no worktree, thirteen hours, "visible from
// minute five, if anyone had looked".
//
// So the progress signals #2988 proposes are BOTH absent in the only real stall
// on record, and shipping them alone would trade a noisy detector for a blind
// one. Absence of a trace is itself the alarm.
//
// Age is what qualifies it — the one job age is honest for. The brief makes the
// worktree the FIRST action, before reading any source, so fifteen minutes is
// several times a slow `cp -al` under contention and still catches the failure
// inside one check-in.
export const NO_TRACE_GRACE_MS = 15 * 60_000;

/**
 * What `list` should say about one dispatch.
 *
 * Pure: it takes the measurements, not the disk. `thresholdMs` is null when the
 * ledger has too few real completions to have a median.
 *
 * @returns {{ kind: "moving" | "stalled" | "starting" | "no-trace", alarm: boolean }}
 */
export function stallVerdict({ ageMs, idleMs, thresholdMs }) {
  if (idleMs === null) {
    return ageMs >= NO_TRACE_GRACE_MS
      ? { kind: "no-trace", alarm: true }
      : { kind: "starting", alarm: false };
  }
  if (thresholdMs !== null && idleMs > thresholdMs) {
    return { kind: "stalled", alarm: true };
  }
  return { kind: "moving", alarm: false };
}

// Whether a lane may be RETIRED yet (#3212).
//
// Retiring closes the ledger entry and the roster row, which between them are the
// whole board — so retiring a lane whose PR is still open does not merely tidy
// up, it deletes the orchestrator's only record that the PR exists. On
// 2026-08-19 exactly that happened: agent/3180-3206-test-hygiene was retired
// while PR #3212 was open and green, and it sat unmerged for an hour until a
// disk sweep noticed its abandoned worktree.
//
// The fact this reads is a REMOTE REF SURVIVING A PRUNE. Squash-merging deletes
// the remote head branch, so a remote that is still there after `fetch --prune`
// means the work has not landed. It is the same fact the retirement path already
// computed to decide whether to delete the LOCAL branch — but it computed it
// after the worktree was gone, and only printed "(not merged?)" as prose. A
// warning after the last moment it could have helped is the shape every other
// guard in this file refuses.
//
// `keep` short-circuits: --keep closes the ledger entry and touches nothing else,
// which is the right command for a genuinely abandoned branch.
export function retireVerdict({ remoteAlive, keep }) {
  if (keep) return { ok: true, reason: "keep" };
  if (remoteAlive) return { ok: false, reason: "unmerged" };
  return { ok: true, reason: "merged-and-tidied" };
}

function cmdDone(argv) {
  const branch = argv.find((a) => !a.startsWith("--"));
  const keep = argv.includes("--keep");
  if (!branch) {
    console.error("usage: dispatch-brief.mjs done <branch> [--keep]");
    process.exit(2);
  }
  const active = activeDispatches(readLedger());
  const entry = active.find((d) => d.branch === branch);
  if (!entry) {
    console.error(
      `no active dispatch for ${branch}. Active: ${active.map((d) => d.branch).join(", ") || "(none)"}`
    );
    process.exit(1);
  }

  // Cleanup preflight BEFORE closing anything: a dirty worktree refuses the
  // whole command, so `done` can never half-run and leave unrescued work with
  // no roster entry pointing at it. --keep opts out of cleanup entirely.
  const wtPath = keep ? null : worktreeForBranch(branch);
  if (wtPath) {
    const dirty = execSync(
      `git -C ${JSON.stringify(wtPath)} status --porcelain`,
      {
        encoding: "utf8",
        timeout: 20_000,
      }
    ).trim();
    if (dirty) {
      console.error(
        `REFUSED: ${wtPath} is DIRTY (${dirty.split("\n").length} entries) and nobody would be
coming back for it after done. Rescue first (commit as explicitly-labelled WIP,
push), or pass --keep to close the ledger entry without touching the tree.`
      );
      process.exit(1);
    }

    // A CLEAN TREE DOES NOT MEAN THE AGENT IS FINISHED. It means everything is
    // pushed — which is exactly what a diligent agent's tree looks like in the
    // middle of its work, right after a checkpoint push.
    //
    // I closed a cluster on that inference. Its PR was green, its tree was clean,
    // its dispatch had tripped the stall threshold, and its report had not
    // arrived — so I ran `done`, which since #2649 REMOVES the worktree. The
    // agent was still running: it was isolating a suspected regression, and the
    // tree went out from under it mid-experiment. Nothing was lost, because
    // everything was pushed; what was destroyed was work-in-progress state and
    // about twenty minutes. Then I did it a second time to the fresh worktree it
    // made to recover.
    //
    // The dirty check above cannot catch this — it fires on the OPPOSITE
    // condition. So ask the question the dirty check does not: has anything in
    // this tree been WRITTEN recently? A build directory, a test-results dump, a
    // scratch file. Recent writes mean somebody is still working here, whatever
    // the ledger's age column says about a stall.
    //
    // Refuse rather than warn, for the same reason the port guard refuses: a
    // warning arrives after the only moment it could have helped. `--keep` still
    // closes the ledger entry without touching the tree, which is the right
    // command when an agent is genuinely finished but you want its worktree.
    // AND ASK THE DIRECT QUESTION TOO: is a PROCESS standing in this directory?
    // The write-recency check above is a proxy, and on 2026-08-19 it would have
    // passed in the exact case that bit — an agent mid-gate-run, git state clean,
    // branch already merged. Nothing about the tree looked live, because this
    // brief tells agents to write their logs to $SCRATCH rather than into the
    // worktree, so a long test tier can run for minutes touching nothing here.
    // A process whose cwd is inside the tree is not a proxy for occupancy; it is
    // occupancy.
    const occupants = processesIn(wtPath);
    if (occupants.length) {
      console.error(
        `REFUSED: ${occupants.length} process(es) are running inside ${wtPath} (pids ${occupants.join(", ")}).
A clean tree and a merged branch do not mean nobody is here — a gate run writes
its log to $SCRATCH and can touch nothing in the tree for minutes. Removing it
now takes the directory out from under that run (this has happened). Wait for the
agent's report, or pass --keep to close the ledger entry and leave the tree alone.`
      );
      process.exit(1);
    }

    const idleMs = worktreeIdleMs(wtPath);
    if (idleMs !== null && idleMs < RECENT_WRITE_MS) {
      console.error(
        `REFUSED: ${wtPath} was written ${Math.round(idleMs / 1000)}s ago, so an agent is
probably still working in it — a clean tree means "everything is pushed", not
"nobody is here". Removing it now takes the tree out from under a running agent
mid-experiment (this has happened). Wait for the agent's report, or pass --keep
to close the ledger entry and leave the tree alone.`
      );
      process.exit(1);
    }
  }

  // AND ASK WHETHER THE WORK ACTUALLY LANDED. The two guards above ask who is
  // standing in the tree; neither asks whether there is anything left to do.
  //
  // On 2026-08-19 a lane was retired while its PR was still OPEN and green.
  // Retiring closes the ledger entry and the roster row, which between them are
  // the whole board — so the PR simply stopped existing as far as the
  // orchestrator was concerned, and sat unmerged for an hour until a disk sweep
  // happened to notice its worktree. Nothing was lost, but nothing would have
  // found it either.
  //
  // The signal is already computed below, where it prints "its remote still
  // exists (not merged?)" AFTER the worktree has been removed — a warning that
  // arrives after the only moment it could have helped, which is the shape this
  // file's other guards exist to refuse. Squash-merging deletes the remote head
  // branch, so a remote ref that SURVIVES a prune means the work has not landed.
  // Hoisted here, and refusing.
  {
    if (!keep) git("fetch --prune origin", { allowFail: true });
    const remoteAlive =
      git(`show-ref --verify refs/remotes/origin/${branch}`, {
        allowFail: true,
      }) !== null;
    if (!retireVerdict({ remoteAlive, keep }).ok) {
      console.error(
        `REFUSED: origin/${branch} still exists after a prune, so its work has NOT
been merged — a squash-merge deletes the remote branch. Retiring now closes the
ledger entry and the roster row, which are the whole board: the PR would stop
being tracked while it is still open (this has happened — #3212 sat green and
unmerged for an hour).
Merge the PR first, then retire. If the branch is genuinely ABANDONED, pass
--keep to close the ledger entry and leave the branch and tree alone.`
      );
      process.exit(1);
    }
  }

  appendLedger({ at: new Date().toISOString(), status: "done", branch });
  rosterClose(branch);
  console.log(`closed ${branch} — freed port base ${entry.portBase}`);
  if (keep) {
    console.log("(--keep: worktree and local branch left as-is)");
    return;
  }

  if (wtPath) {
    if (
      git(`worktree remove ${JSON.stringify(wtPath)}`, { allowFail: true }) !==
      null
    ) {
      console.log(`removed worktree ${wtPath}`);
    } else {
      console.log(`could not remove worktree ${wtPath} — remove by hand`);
    }
  }
  // The guard above already pruned and established that the remote ref is gone,
  // which IS the merged-and-tidied shape (the #2621 rule), so the local branch
  // is safe to drop. -D, not -d: a squash-merged branch is never an ancestor of
  // main, so -d refuses even though the content landed.
  if (
    git(`show-ref --verify refs/heads/${branch}`, { allowFail: true }) !== null
  ) {
    if (git(`branch -D ${branch}`, { allowFail: true }) !== null) {
      console.log(
        `deleted local branch ${branch} (remote gone — merged and tidied)`
      );
    }
  }
}

// Reprint a live dispatch's brief, writing nothing.
//
// The ledger stores a dispatch's PARAMETERS, not its brief text, and the brief
// is only ever printed once — at `new`. An orchestrator that loses the text
// (restart, compaction, a tail that cut it off) has no way back to it, and the
// obvious move, re-running `new`, silently forked the ledger and the roster.
// Rebuilding from the recorded parameters is exact: `buildBrief` is a pure
// function of them, so this prints the same bytes the agent was given.
function cmdBrief(argv) {
  const branch = argv[0];
  if (!branch) {
    console.error("usage: dispatch-brief.mjs brief <branch>");
    process.exit(2);
  }
  const entry = activeDispatches(readLedger()).find((d) => d.branch === branch);
  if (!entry) {
    console.error(
      `no ACTIVE dispatch for ${branch}. \`list\` shows what is live; a retired ` +
        "dispatch has no brief to reprint."
    );
    process.exit(1);
  }
  const { brief } = buildBrief({
    branch: entry.branch,
    worktree: entry.worktree,
    issues: entry.issues,
    task: entry.task,
    e2e: entry.e2e,
    portBase: entry.portBase,
  });
  console.log(brief);
}

function cmdResume(argv) {
  const branch = argv[0];
  if (!branch) {
    console.error("usage: dispatch-brief.mjs resume <branch>");
    process.exit(2);
  }
  const rows = readLedger();
  const active = activeDispatches(rows);
  if (active.some((d) => d.branch === branch)) {
    console.error(`${branch} is already active — nothing to resume.`);
    process.exit(1);
  }
  const prior = [...rows]
    .reverse()
    .find((r) => r.branch === branch && r.status === "active");
  if (!prior) {
    console.error(
      `no prior dispatch for ${branch} in the ledger — use \`new --branch ${branch}\`.`
    );
    process.exit(1);
  }
  if (prior.e2e && active.filter((d) => d.e2e).length >= 2) {
    console.error(
      "REFUSED: resuming this e2e-touching dispatch would exceed the 2-agent e2e cap. " +
        "Close one with `done <branch>` first."
    );
    process.exit(1);
  }
  // Reuse the prior port range when it is still free — the agent's environment
  // still says E2E_PORT=<old base>; only reallocate on a genuine collision.
  const taken = new Set(active.map((d) => d.portBase).filter(Boolean));
  const portBase = taken.has(prior.portBase)
    ? allocatePortBase(active)
    : prior.portBase;
  // The resumed agent's first push often follows a squash-merge of its old PR;
  // prune now so the whole shared .git sees current refs (worktrees share one).
  git("fetch --prune origin", { allowFail: true });

  const entry = {
    at: new Date().toISOString(),
    status: "active",
    resumed: true,
    branch,
    worktree: prior.worktree,
    issues: prior.issues ?? [],
    task: prior.task ?? null,
    portBase,
    e2e: Boolean(prior.e2e),
  };
  appendLedger(entry);
  const rostered = rosterAdd(entry);
  console.log(
    `resumed ${branch} — port base ${portBase}` +
      (portBase !== prior.portBase
        ? ` (prior ${prior.portBase} was taken — TELL THE AGENT its E2E_PORT changed)`
        : "") +
      (rostered
        ? ""
        : `\nWARNING: could not write ${rosterPath} — the check-in script will not see this agent as live.`)
  );
}

// A dispatch that never went through `new` — an Agent-tool run — is live but
// invisible: no ledger entry, no roster line, so the check-in reads its dirty
// worktree as abandoned and the restart drill would never rescue it. `adopt`
// closes that hole after the fact; the rule (docs/orchestration.md, pipeline
// step 3) is to not open it — generate every brief through `new`.
function cmdAdopt(argv) {
  const branch = argv.find((a) => !a.startsWith("--"));
  if (!branch) {
    console.error(
      'usage: dispatch-brief.mjs adopt <branch> [--issues 1,2] [--task "..."] [--e2e] [--port-base N]'
    );
    process.exit(2);
  }
  const opts = parseArgs(argv.filter((a) => a !== branch));
  const active = activeDispatches(readLedger());
  if (active.some((d) => d.branch === branch)) {
    console.error(`${branch} is already active — nothing to adopt.`);
    process.exit(1);
  }
  // Adopt an agent that EXISTS: the worktree is the evidence. With no worktree
  // there is nothing running to adopt — that dispatch wants `new`.
  const wtPath = worktreeForBranch(branch);
  if (!wtPath) {
    console.error(
      `no worktree has ${branch} checked out — nothing running to adopt. Dispatch with \`new --branch ${branch}\` instead.`
    );
    process.exit(1);
  }
  // `git worktree list` includes the main checkout, and the orchestrator's own
  // branch lives there — adopting it would roster the orchestrator as an agent.
  //
  // ASK GIT WHICH CHECKOUT IS THE MAIN ONE, never `repoRoot`. `repoRoot` is derived
  // from this FILE's path, so it answers "where does this copy of the script live",
  // which is only the same question when the script is run from the main checkout.
  // Run a copy from anywhere else — a worktree, a review checkout — and the guard
  // compares the main checkout against that copy's directory, matches nothing, and
  // adopts the orchestrator. Measured, not theorised: running this from a review
  // worktree rostered `/home/user/allos` twice before the guard was re-pointed.
  // `--git-common-dir` is the main checkout's `.git` from ANY linked worktree, so
  // its parent is the answer wherever the script sits.
  if (path.resolve(wtPath) === mainCheckout()) {
    console.error(
      `${branch} is checked out in the MAIN CHECKOUT (${mainCheckout()}), where no agent works — nothing to adopt.`
    );
    process.exit(1);
  }
  if (opts.e2e && active.filter((d) => d.e2e).length >= 2) {
    console.error(
      "REFUSED: adopting this as e2e-touching would exceed the 2-agent e2e cap. " +
        "Close one with `done <branch>` first, or drop --e2e if it touches no spec."
    );
    process.exit(1);
  }
  const reserved = opts.portBase && RESERVED_PORT_REASON(opts.portBase);
  if (reserved) {
    console.error(`${reserved}. Drop --port-base to let the allocator pick.`);
    process.exit(1);
  }
  const taken = new Set(active.map((d) => d.portBase).filter(Boolean));
  if (opts.portBase && taken.has(opts.portBase)) {
    console.error(
      `port base ${opts.portBase} is already allocated to an active dispatch — drop --port-base to let the allocator pick.`
    );
    process.exit(1);
  }
  const portBase = opts.portBase ?? allocatePortBase(active);

  const entry = {
    at: new Date().toISOString(),
    status: "active",
    adopted: true,
    branch,
    worktree: path.basename(wtPath),
    issues: opts.issues,
    task: opts.task,
    portBase,
    e2e: opts.e2e,
  };
  appendLedger(entry);
  const rostered = rosterAdd(entry);
  console.log(
    `adopted ${branch} (worktree ${wtPath}) — port base ${portBase}.\n` +
      `The agent was never TOLD a port: if it runs e2e, message it E2E_PORT=${portBase} now.` +
      (rostered
        ? ""
        : `\nWARNING: could not write ${rosterPath} — the check-in script still will not see this agent as live.`)
  );
}

function main(argv) {
  const [cmd = "new", ...rest] = argv;
  try {
    if (cmd === "new") cmdNew(rest);
    else if (cmd === "list") cmdList();
    else if (cmd === "brief") cmdBrief(rest);
    else if (cmd === "done") cmdDone(rest);
    else if (cmd === "resume") cmdResume(rest);
    else if (cmd === "adopt") cmdAdopt(rest);
    else {
      console.error(
        `unknown command: ${cmd} (expected new | list | brief | done | resume | adopt)`
      );
      process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Run as a script, importable as a module — the same shape seed-next-build.mjs
// uses so its exit codes can be asserted. Without this guard, importing the file
// to test one pure function would RUN `new` (the default command) against the
// live ledger and the live roster, which is the 2026-08-15 roster-fork incident
// arriving through the test harness.
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2));
}
