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
//     [--e2e] [--port-base N] [--candidate] [--priority P1] \
//     [--lane user-data] [--adopt-claim]
//   node scripts/orchestration/dispatch-brief.mjs list
//   node scripts/orchestration/dispatch-brief.mjs brief <branch>
//   node scripts/orchestration/dispatch-brief.mjs promote <branch>
//   node scripts/orchestration/dispatch-brief.mjs update <branch> \
//     [--priority P1] [--lane user-data]
//   node scripts/orchestration/dispatch-brief.mjs done <branch> [--keep]
//   node scripts/orchestration/dispatch-brief.mjs resume <branch>
//   node scripts/orchestration/dispatch-brief.mjs adopt <branch> \
//     [--issues 123,456] [--task "one line"] [--e2e] [--port-base N]
//   node scripts/orchestration/dispatch-brief.mjs claims <path>
//
// `new` prints a complete brief block (stdout) and appends a ledger entry. It
//   REFUSES an issue another lane already claimed with a `Dispatched:` comment,
//   and refuses just as firmly when those comments cannot be READ — an
//   unreachable claim is not an absent one (#5108). `--adopt-claim` is the
//   explicit override for a claim you have judged stale. `new` and `adopt`
//   also REFUSE a branch that already heads an open PR belonging to ANOTHER
//   orchestrator session, read off that PR's body footer (#5177), under the
//   same override — and say out loud when they could not ask.
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
// `claims` answers the one question a lane asks mid-run: is another active
//   dispatch already working in this path? A brief's list of live lanes is
//   written once and goes stale within minutes (#4473), so this reads the
//   ledger and each active worktree instead. Exit 1 claimed, 0 clear, 3 CANNOT
//   TELL — a worktree that is not on disk is never reported as clear.
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
// Ledger location: resolved by ledger.mjs, which also owns the replay.
//
// The ledger and the roster MUST default to the same directory, and that
// directory must be the durable one. `$SCRATCH` is UNSET in the live
// work container (measured), so a `/tmp` fallback here would have put
// the restart-proof ledger in the least durable place on the box — the one
// swept for stale `allos-db-shared-*` dirs — while the roster it must stay in
// sync with landed in /home/user/scratch. Two defaults that disagree is the
// same defect shape as the two boot-id paths this PR already removed, so both
// now read one constant.

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { helpGuard, isMain } from "./usage.mjs";
import { discoverNodeBin, resolveReadToken, resolveStateDir } from "./host.mjs";
import { bodySession, normaliseSession } from "./merge-gate-core.mjs";
import {
  activeDispatches,
  ledgerPath as resolveLedgerPath,
  readLedger,
} from "./ledger.mjs";
helpGuard(process.argv, import.meta.url);

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

// The one state directory both files live in — resolved by host.mjs, the
// SAME resolver the shell scripts call, so the ledger and the roster cannot
// disagree per host the way the two hand-copied defaults once did (#3710:
// the hard-coded /home/user/scratch simply does not exist on a macOS
// orchestrator, and dispatch failed at worktree setup).
const STATE_DIR = resolveStateDir();
fs.mkdirSync(STATE_DIR, { recursive: true });

const ledgerPath = resolveLedgerPath();

function appendLedger(entry) {
  fs.appendFileSync(ledgerPath, JSON.stringify(entry) + "\n");
}

const PRIORITIES = new Set(["P0", "P1", "P2", "P3", "parked", "unclassified"]);
const LANES = new Set([
  "user-data",
  "operator",
  "product",
  "presentation-guard",
  "unclassified",
]);

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

// The same fold, for ONE branch and ignoring `done` — resuming an agent needs
// the state a retired dispatch was left in, which is the only thing that made
// this a separate walk (#4460).
function latestDispatchState(rows, branch) {
  const kept = rows.filter((row) => row.status !== "done");
  return activeDispatches(kept).find((d) => d.branch === branch) ?? null;
}

export function resumeState(rows, branch) {
  const active = activeDispatches(rows);
  const prior = latestDispatchState(rows, branch);
  return {
    active,
    prior,
    candidate:
      Boolean(prior?.candidate) &&
      !active.some((dispatch) => dispatch.candidate),
  };
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

function git(args, { allowFail = false, cwd = repoRoot } = {}) {
  try {
    const options = {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "ignore"],
    };
    return (
      Array.isArray(args)
        ? execFileSync("git", args, options)
        : execSync(`git ${args}`, options)
    ).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

const MAIN_REF = "refs/remotes/origin/main";

export function branchGitArgs(branch) {
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/origin/${branch}`;
  return {
    localLog: ["log", "-1", "--format=%cI", localRef],
    remoteLog: ["log", "-1", "--format=%cI", remoteRef],
    remoteExists: ["show-ref", "--verify", remoteRef],
    localExists: ["show-ref", "--verify", localRef],
    deleteLocal: ["branch", "-D", branch],
    // The messages of the commits this branch has and origin/main does not,
    // newest first, for the `Claude-Session:` trailer (#5179). `--not
    // origin/main` is load-bearing, not tidiness: a squash merge onto main
    // carries the trailers of every commit it squashed, so a branch sitting AT
    // main's head reads as owned by whoever last landed, and a check that
    // refused there would refuse a fresh branch on most days.
    localOwn: ["log", "--format=%B", localRef, "--not", MAIN_REF],
    remoteOwn: ["log", "--format=%B", remoteRef, "--not", MAIN_REF],
    // Does the REMOTE have it, when this clone has no ref for it? Read-only —
    // it moves nothing in the shared .git every worktree here shares.
    onRemote: ["ls-remote", "origin", localRef],
  };
}

// --- discovery -------------------------------------------------------------

// The runbook's rule: DISCOVER the node bin dir, never paste one — a pinned
// patch version in the docs went stale within days, and a pinned /opt path
// blocked a macOS host outright (#3710). .nvmrc carries the canonical major;
// host.mjs checks the running process first, then installed version managers.
function nvmrcMajor() {
  return fs
    .readFileSync(path.join(repoRoot, ".nvmrc"), "utf8")
    .trim()
    .replace(/^v/, "")
    .split(".")[0];
}

function discoverNode24() {
  return discoverNodeBin(nvmrcMajor());
}

// THE DEPTH OF THIS CLONE IS A FACT ABOUT THE CONTAINER, NOT ABOUT THE REPO.
//
// This brief used to ASSERT it — "THIS CLONE IS SHALLOW, history begins two days
// ago … `git log --reverse` starts on 2026-08-29" — baked into the very rule
// that says a number in prose must come from a command you ran. The clone was
// unshallowed and the sentence went false, in the direction that STOPS work: on
// 2026-09-05 a lane needed `git show <sha>^:lib/travel-timezone.ts` to verify a
// two-merge chain, and the brief told it that was impossible in a container
// where it works. So it is discovered, like the node bin dir and the port range,
// and neither branch bakes a date.

/**
 * What a lane may conclude from how much history it can reach.
 *
 * @param {boolean} shallow `git rev-parse --is-shallow-repository`
 * @param {string|null} firstCommit the oldest REACHABLE commit, already formatted
 */
export function historyDepthLine(shallow, firstCommit) {
  const begins = firstCommit
    ? `history begins at ${firstCommit}`
    : "the oldest reachable commit could not be read";
  return shallow
    ? `THIS CLONE IS SHALLOW — \`git rev-parse --is-shallow-repository\` is true and ` +
        `${begins}, so anything older is UNREACHABLE and no command here can measure a span across it`
    : `This clone has FULL history — \`git rev-parse --is-shallow-repository\` is false and ` +
        `${begins}, so a claim about an older tree IS checkable here: check it rather than assuming you cannot`;
}

function historyDepth() {
  const shallow =
    git("rev-parse --is-shallow-repository", { allowFail: true }) === "true";
  // `git log --reverse -1` returns the NEWEST commit — the limit is applied
  // before the reversal — so the root is asked for as a root. In a shallow
  // clone the graft boundary is parentless and answers here too, which is
  // exactly the commit the shallow branch means by "history begins at".
  const root = git(["rev-list", "--max-parents=0", "HEAD"], {
    allowFail: true,
  })?.split("\n")[0];
  const first = root
    ? git(["log", "-1", "--format=%h (%ad) %s", "--date=short", root], {
        allowFail: true,
      })
    : null;
  return historyDepthLine(shallow, first);
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

// THE SAME SPLIT, FOR THE SAME REASON: a collision is a property of the BASE, so
// the check is a predicate over the active roster rather than a step inside the
// allocator. The reserved-band lesson above was learned and then only half
// applied — `--port-base` was routed past the 6000-6099 rule and fixed, while it
// stayed routed past the "is anyone else on this range" rule, which is the one an
// allocator existed to answer. On 2026-08-23 I passed `--port-base 7600` for a
// live e2e lane while a retired-but-unclosed dispatch still held 7600 in the
// ledger; nothing complained, and the two would have shared a range had the first
// lane's agent still been alive. A caller who supplies the answer never asks the
// question — so ask it of the answer.
// `ignoreBranch` is the dispatch being built, and it is not optional. `brief`
// REPRINTS a live dispatch with its own stored base, so without this a reprint
// collides with itself and refuses — which is what happened the first time this
// guard fired for real (2026-08-23, `brief intake-purposes-and-catalog`). A guard
// whose first genuine firing is a false positive against a legitimate operation is
// the shape that gets routed around within the hour, so the exclusion lives in the
// predicate rather than at one call site.
export function portBaseCollision(base, active, ignoreBranch) {
  const clash = active.find(
    (d) => d.portBase === base && d.branch !== ignoreBranch
  );
  return clash
    ? `port base ${base} is already held by the active dispatch ${clash.branch}`
    : null;
}

function allocatePortBase(active, opts = {}) {
  for (let base = 5400; base < 9000; base += 200) {
    if (RESERVED_PORT_REASON(base)) continue;
    if (!portBaseCollision(base, active, opts.branch)) return base;
  }
  throw new Error(
    "no free E2E port range — close finished dispatches with `done <branch>`"
  );
}

// Load caps (docs/orchestration/dispatch.md §Dispatch), as PREDICATES rather
// than inline counts, for the reason the port-collision rule moved out of the
// allocator's loop: a rule that lives at one call site is a rule the next
// call site skips. The two-agent E2E cap holds on EVERY host and refuses; the
// machine cap only WARNS — it is host-dependent and a P0 preempts (the same
// reason the sibling-start stagger warns).
export const E2E_LANE_CAP = 2;
export const MACHINE_CAP_WARN = 5;

export function e2eLaneRefusal(active, ignoreBranch) {
  const lanes = active.filter((d) => d.e2e && d.branch !== ignoreBranch);
  if (lanes.length < E2E_LANE_CAP) return null;
  return (
    `the E2E lane is full: ${lanes.map((d) => d.branch).join(", ")} already ` +
    `hold it (cap ${E2E_LANE_CAP} — dispatch.md §Dispatch, on every host). ` +
    "Close one with `done <branch>` or dispatch this cluster without --e2e."
  );
}

// --- brief -----------------------------------------------------------------

// Migrations are NAME-KEYED (the numbered era closed at 185 — see
// lib/migrations/runner.ts), so there is no slot to reserve and every brief
// carries the same convention block.
const MIGRATION_LINES = `- Migrations are NAME-KEYED — there is NO slot to reserve. If your work needs a
  schema change: create lib/migrations/versions/YYYYMMDD-<slug>.ts exporting
  { name: "YYYYMMDD-<slug>", up } (no id), append it LAST to the MIGRATIONS array
  in versions/index.ts, then run \`npm run gen:migration-manifest\` to add its
  sha256 to lib/migrations/manifest.json in the same change — never hand-type a
  hash. Never edit a shipped migration. If index.ts conflicts when you merge
  origin/main, keep BOTH sides (both import lines, both array entries — merge
  order is the order); if manifest.json conflicts, re-run the generator rather
  than resolving the hash lines by hand, and re-run the DB tier.`;

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
  const collision =
    opts.portBase && portBaseCollision(opts.portBase, active, opts.branch);
  if (collision) {
    throw new Error(
      `${collision}. Drop --port-base to let the allocator pick, or close that ` +
        `dispatch first with \`done ${active.find((d) => d.portBase === opts.portBase && d.branch !== opts.branch).branch}\`.`
    );
  }
  const portBase = opts.portBase ?? allocatePortBase(active, opts);

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
    : `- No node ${nvmrcMajor()} found (checked the running process, then nvm under $NVM_DIR,\n` +
      `  ~/.nvm, and /opt/nvm) — install the .nvmrc major with your version manager first\n` +
      `  (e.g. nvm install ${nvmrcMajor()}), then export PATH to its bin dir in EVERY shell\n` +
      `  (verify better-sqlite3 loads)`;

  const issueLines = opts.issues.length
    ? opts.issues
        .map(
          (n) =>
            `  GET /repos/FloorLamp/allos/issues/${n} and /repos/FloorLamp/allos/issues/${n}/comments`
        )
        .join("\n")
    : "  (no tracker issues — the task statement above is the whole spec)";

  const landingLines = opts.candidate
    ? `- LANDING STATE: CANDIDATE. This is the one branch allowed to consume final
  rebase, exact-head PR review, and the full CI matrix. Merge current main, push,
  open or refresh the READY PR, then obtain review against that exact remote head.
  A local pre-review is useful but does not replace the exact-head PR review.`
    : `- LANDING STATE: BANKED. Push durable branch checkpoints, but DO NOT open a
  PR. Run authored/edited specs and assigned local gates, then return the branch
  and head SHA. Before promotion and periodically while banked, run
  \`git fetch origin main && git log origin/main -- <your files>\`; if your subject
  landed or its premise changed, drop redundant work and report it. Non-authored
  blast-radius specs wait for CI after promotion reprints this brief.`;
  const blastRadiusInstruction = opts.candidate
    ? "Push, and read candidate CI."
    : "Defer them until promotion; the landing candidate's CI runs them.";

  const brief = `${opts.task ? `Task: ${opts.task}\n\n` : ""}\
- Worktree setup (the path is LITERAL, not \`$SCRATCH\` — that variable is unset in most lane shells and two lanes on 2026-09-02 built their tree under the harness scratchpad and had to \`git worktree move\` it, where a check-in scanning ${STATE_DIR} would have read them as absent): git fetch origin main && BASE_SHA=$(git rev-parse FETCH_HEAD) && git worktree add ${STATE_DIR}/${opts.worktree} -b ${opts.branch} "$BASE_SHA" && echo "PINNED_BASE_SHA=$BASE_SHA"
- Keep the printed PINNED_BASE_SHA in your handoff. For any history edit, reset or rewrite against the printed SHA, never against moving \`origin/main\`; sibling worktrees share its remote-tracking ref.
- cp -al ${nm.path}/. ${STATE_DIR}/${opts.worktree}/node_modules${nm.verified ? "" : "\n  (WARNING: better-sqlite3 not found in that tree — run npm ci there first)"}
${nodeLine}
${landingLines}
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
- ANY LIST OF OTHER LIVE LANES IN THIS BRIEF WENT STALE THE MOMENT IT WAS WRITTEN.
  Lanes run one to two hours and are dispatched throughout; one named above may have
  finished, and the one you are about to collide with may not have existed yet. So
  before you touch a file outside your stated scope, ASK — the roster is on disk:
      node scripts/orchestration/dispatch-brief.mjs claims <path>
  It names any other active dispatch holding that path, or says CLEAR. A worktree it
  cannot read is CANNOT TELL, not clear: take that to the orchestrator. #4473 was
  filed because a lane checked the three lanes its brief named, saw no conflict, and
  a fourth had been dispatched into that exact file since — it was stopped by
  happening to ask, which is not a control.
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
- A SPEC CENSUS IS KEYED ON A SIGNATURE, AND THE SIGNATURE IS THE PART YOU GET
  WRONG. If your change moves a rendered value, the specs that pin the old value are
  the census — and three habits make one read clean when it is not. (1) FILENAME IS
  NOT VIEWPORT. \`*.mobile.spec.ts\` is a naming convention; any spec can call
  \`setViewportSize\`, and on 2026-08-27 the real phone-rendering population was 126
  files where a lane had counted 64. (2) THE MATCHER IS NOT NEXT TO THE PROPERTY. A
  spec that reads \`borderTopWidth\` inside a \`page.evaluate\` and asserts
  \`toBeGreaterThan(0)\` on the returned local has the property and the matcher on
  different lines, in different expressions; a line-keyed grep cannot see it. Search
  for the PROPERTY and the MATCHER separately, then intersect by file. (3) THE
  LITERAL MAY BE LOOP-BOUND. \`for (const width of [390, 1280])\` never writes
  \`setViewportSize({ width: 390\`. Grep the bare number too. Measured on #3673: after
  a rebuilt census over 126 files and 234 executed tests, the lane reported
  trends-metric-pages.spec.ts as \"the only spec pinning the pre-sweep arrangement\";
  cycle.spec.ts — desktop-named, loop-bound 390, split assertion — went red in CI on
  the next push. (4) THE SELECTOR MAY BE BUILT BY A HELPER. A spec that calls
  \`dashboardCandidatePrefix(page, "labs.latest:")\` never writes
  \`data-candidate-id\` at all, so a grep for the ATTRIBUTE cannot see it however
  carefully you spell the attribute. Put the helper's NAME in the token set beside
  the markup it builds, and search for both. Measured on #3548: a census over the
  band's markers found 4 of the 6 specs addressing a row that changed band; the two
  it missed were the two that went red, and one of them was invisible to every
  attribute search because a function assembled the selector. Report a census as a
  TABLE of files with a per-file verdict, and state the search that produced it, so
  the hole is visible when it is there. Then INTERSECT the census with the rows that
  actually moved — the count that matters is not how many files mention the surface,
  it is how many address the thing you changed.
  (5) BUILD THE PIN SET FIRST AND UNSCOPED, AND NEVER SCOPE IT TO THE MARKER SWEEP'S
  HITS. An intersection narrowed to the files a marker sweep already matched can only
  ever CONFIRM that sweep's verdicts; it is structurally unable to contradict them, so
  it feels like corroboration while proving nothing. Build the geometry-pin (or
  whatever-you-moved) set independently — \`TAP_FLOOR_PX\`, the bare literal,
  \`boundingBox|getBoundingClientRect|toBeInViewport|elementFromPoint\` — over ALL of
  e2e/, THEN intersect with the moved subjects, and let the intersection overrule any
  per-file impression. AND A PER-FILE VERDICT ASSERTED WITHOUT OPENING THE FILE IS NOT
  A CENSUS RESULT — it is the guess the census existed to replace. Measured on #3954
  (2026-08-29): the lane's marker sweep listed quick-log-stability.mobile.spec.ts among
  its 15 hits, the lane wrote the verdict \"only button-height-floor asserts segment
  geometry; rest drive clicks\" without opening any of them, and \`TAP_FLOOR_PX\` was
  sitting on line 167 of that very file, which then went red in CI. The broad grep had
  been run FIRST, judged \"too broad\" at 40 files, and discarded in favour of the
  narrow one. Re-run properly it was 45 files and 15 after intersection, and it found a
  second real case — a genuine SegmentedControl in ride-detail addressed only by
  \`getByRole(\"group\", { name })\`, invisible to every marker search because the
  accessible name comes from an \`ariaLabel\` prop.
  (6) A PATH IS NOT ALWAYS SPELLED AS A PATH. A route written as a REGEX LITERAL —
  \`/\\/medications\\/dose-history/\` — contains backslashes between every segment, so a
  grep for \`/medications/dose-history\` cannot match it however exactly you spell the
  path. Same for a path split across a template literal or assembled from a base plus a
  suffix. When you DELETE a route, census it twice: once for the literal path, and once
  with a pattern tolerant of separators, e.g.
  \`(medications|nutrition|wellness)[\\\\/]+(dose|food|practice)-history\`. Measured
  2026-08-29 on #3958: the literal grep came back clean and the tolerant one found
  e2e/medications-followups.spec.ts driving the deleted route through a regex literal —
  a spec that walked the door, the kind filter, the rows and the footer link. Sweep the
  deleted TESTIDS and SYMBOLS as well as the path; a surviving marker is the same bug
  wearing a different name.

  (7) "DOES MY CHANGE ADD SOMETHING BAD" AND "DOES MY CHANGE BREAK HOW THIS SPEC FINDS
  ITS SUBJECT" ARE TWO CENSUSES, AND THE SECOND IS THE ONE LANES SKIP. The first is an
  ABSENCE question and your change passes it honestly while silently changing what a
  LOCATOR resolves to. Measured 2026-08-29 on #4045: a lane censused the specs its
  change touched, correctly judged that a new record-count span "adds no machine date",
  and shipped a CI red — because the count now concatenated onto the date inside one
  element, so \`textContent\` read "August 1715 records", the census's \`\d{1,2}\b\`
  had no word boundary, and the positive control that proves the route is not VACUOUSLY
  silent could no longer find a date at all. \`innerText\` matched fine and the header
  looked correct throughout.
  So run the second census as its own grep over the specs that address your surface:
  concatenation-sensitive matchers (\`toHaveText\`, \`toContainText\`, \`hasText\`,
  \`textContent\`, \`allTextContents\`) and structural selectors (\`nth\`, \`first()\`,
  \`>\`, \`~\`, \`childElementCount\`, range/offset reads). Adding a sibling span, moving
  a testid up or down a level, collapsing a column, reordering two children — none of
  those "add something bad", and all of them move what those matchers resolve to.
  AND WHEN A CENSUS SPEC GOES RED, ITS POSITIVE CONTROL FAILING IS THE INSTRUMENT
  WORKING. Fix the surface so the control can see it again; widening the census's own
  pattern to admit your new markup loosens the one thing watching for that class
  repo-wide, to make one branch green.

  (8) A RETIRED ELEMENT IS STILL REACHED BY ITS SHAPE. When you DELETE a component,
  the specs that drive it are not only the ones that name it. A spec can reach it
  structurally — \`getByTestId('protocol-heatmap').locator('details').locator('summary')\`
  — naming neither the component, nor its testid, nor any string it rendered, so a
  sweep for the component name AND a sweep for its visible label both come back clean
  and both are wrong. Measured 2026-09-02 on #4760, which retired a disclosure across
  18 mounts: the lane swept for \`VisualizationDetails\` and for the "…details" label,
  reported a clean census, and \`e2e/protocol-practice.spec.ts:298\` went red in CI on a
  chain that contains none of those tokens. Rebuilt properly the sweep was 31 files and
  13 after intersection, and it found the red plus eleven true negatives.
  So when you delete a component, census it a third way: for the TAGS and ROLES its
  markup contributed — \`locator('details')\`, \`locator('summary')\`, \`getByRole('listbox')\`
  — chained off ANY testid, and for the generic disclosure helpers
  (\`openDisclosure(page, …)\`) whose target is an argument rather than a literal. Then
  resolve each helper call site to the id it actually passes; a helper name in the
  grep is not a hit until you know what it opened.

- A GUARD THAT REMOVES A PROPERTY CANNOT ALSO PROVE THE PROPERTY SURVIVED. When your
  change takes something away — a frame, a gutter, a label, a permission, a field —
  the natural guard asserts ABSENCE: nothing still has it. That assertion passes on
  the tree you wanted AND on the tree where the thing vanished somewhere it was
  load-bearing, because both produce an empty result. One direction, two very
  different worlds, one green. So when you write a removal guard, write its CONVERSE
  in the same commit: the named surfaces that must STILL carry the property, asserted
  as a comparison between two real elements rather than against a constant. Measured
  on #3673: a sweep collected every element that still drew a card frame below \`sm\`
  and asserted the list was empty. It was — and the app's drug-interaction, allergy,
  pharmacogenomic and ototoxicity strip had gone flat with it, rendering identically
  to the ordinary medication list beneath it, with a MAJOR bleeding-risk warning as
  three sentences flush to the page gutter. The sweep could not have failed on that;
  it was structurally the wrong direction. Name the surfaces that must stay loud, keep
  the list SHORT and hand-written (an exhaustive scanner is the forbidden shape), and
  prove the converse assertion can fail before you trust it passing.
- COUNT HOW OFTEN YOUR FIXTURE REACHES THE STATE YOUR ASSERTION FORBIDS. This is the
  cheapest check in this brief and it catches the defect class the rest of these rules
  keep circling. A test's SUBJECT and its FIXTURE are usually chosen by the same person
  in the same motion, so the fixture inherits that person's belief about where the
  defect lives and then confirms it. Nobody asks the separate question -- can this
  fixture even produce the shape? Measured 2026-08-30 across one session: an empty-state
  test whose fixture made the absence true for the wrong reason; a retirement table
  querying its most permissive input; a census sweep whose pattern never matched
  anything; a completeness guard structurally blind to over-dropping; a tie-break case
  whose expected answer was also what declaration order alone produced; and a 5000-seed
  conservation fuzz that stayed GREEN with its guard deleted, because the generator had
  produced the shape that guard governs ZERO times. Every one was green, and green for a
  reason that had nothing to do with the code.
  So instrument once, in a throwaway file you delete: count the fixtures, seeds or rows
  that actually reach the forbidden state. A zero is your answer. This costs one run and
  it is what turns "my test passes" into "my test could have failed".
- DO NOT NAME A CAUSE YOU HAVE NOT LOOKED FOR. A failure signature -- \`sticky\` dying, a
  null bounding box, an element hidden, a count off by one -- has a small set of textbook
  causes, and your mind supplies one instantly and fluently. That fluency IS the trap:
  "this cause would explain the symptom" and "this cause exists in the code in front of
  me" are different claims, and only the first has been checked. The second is usually
  one grep away. Measured 2026-08-30, one lane, TWICE in a day: "the quick-entry mount
  receives no ledger prop, so nothing in this diff renders there" -- true premise, and
  the mount was three lines away in a file never opened; and "a keep-apart notice above
  the rows carried its own list inside a collapsed disclosure" -- where that component
  renders no list and has no disclosure at all. Both went into a PR body and a commit
  message before either was checked; both were disproven later by the author, by a
  single grep.
  So before a cause goes into a commit message, a comment, or a PR body, GREP FOR ITS
  MECHANISM. Say "a collapsed disclosure hid it" only after grepping that subtree for a
  disclosure. Say "nothing renders there" only after grepping for the mount. If the
  mechanism is not there you do not have a cause -- you have a symptom and a guess, and
  "I DON'T KNOW WHY" IS THE CORRECT THING TO WRITE. A wrong cause is worse than none: it
  is durable, it is trusted by the next reader, and it sends them somewhere the bug is
  not. This is the twin of the fixture rule above -- that one asks whether your test can
  REACH the state it forbids, this one asks whether your explanation EXISTS. Both are one
  cheap command.
- A CONTROL THAT RE-QUERIES INSTEAD OF RE-USING PROVES NOTHING ABOUT YOUR GUARD.
  When you forge the forbidden state to show an assertion can fail, the control must
  run through the SAME locator, selector or query object the assertion runs through
  -- not a fresh one you write to check your work. Measured 2026-08-31: a lane wrote
  the positive control this brief demands, forged a card into the page, and watched
  its detector return 1. The detector counted through a document-rooted query; the
  guard chained a CSS selector onto an already-scoped root, so it asked for a main
  element nested inside a main element. It matched nothing, ever. The control proved
  that A query can find a card. It never proved that THE GUARD can.
  This is worse than an assertion that simply cannot fail, because every visible
  signal is right: the control exists, it reds on demand, the reasoning is sound,
  and the guard is blind behind it. The lane found the same mismatch in a second
  guard once it knew the shape. THE TELL IS A CONTROL THAT RE-QUERIES RATHER THAN
  RE-USES: count through the guard's own object, mutate, count again through that
  same object, restore, count again.
  AND THIS APPLIES TO WHAT YOU ARE TOLD, not only to what you infer. A claim's
  SOURCE does not change whether it is checkable. Measured 2026-08-31: a lane
  re-derived every number in its own PR body against the pushed head -- catching a
  mutation anchor that prettier had rewrapped, and an issue comment that had
  appeared since its first read -- and then wrote "confirmed" over a one-line
  aside from the ORCHESTRATOR that was wrong, without running the one command
  that would have checked it. Authority is not evidence. When the coordinator,
  an issue body, a PR description or a reviewer hands you a checkable fact that
  your work will rest on, check it: they are working from summaries too, and a
  wrong fact travels further when it arrives from above.
- A NUMBER IN PROSE MUST COME FROM A COMMAND YOU RAN, AND THE COMMAND GOES BESIDE
  IT. A figure recalled from your own reasoning looks EXACTLY like one that came off
  a shell, and prose carries no test — so a specific number in a comment, a commit
  message or a PR body reads as though something checked it. Nothing did. Measured
  2026-08-31, two lanes, both already pushed: a comment read "deleted in #4515 after
  two years of rendering nowhere", and no command in that container could produce
  "two years". CHECK WHAT YOURS CAN REACH BEFORE YOU CLAIM EITHER WAY —
  ${historyDepth()}. And a spec comment AND a PR body both
  justified measuring painted pixels rather than boxes with "the nearest clipping
  ancestor is 147px narrower than the screen", a figure the lane could not reproduce
  in any configuration — the real values are 93 and 141, and 147 looks like a garbled
  141. Both were plausible, both were durable, and one was already load-bearing for a
  design argument. "Two years" is the worst shape of all, because it sounds like
  institutional memory rather than a measurement. A third shape is the SUMMARY
  over exact work: a census whose per-site verdicts were every one correct — each
  read line by line — sat under "92 hits, 60 mounts", which corresponded to no
  quantity in the tree at all. Not files, not mounts, not lines, not occurrences.
  The verdicts came from reading; the summary came from nowhere, and a reader
  trusts the summary precisely BECAUSE the detail beneath it is sound. So: print the command next to the
  figure, and if you cannot name one, WRITE NO NUMBER — a reader has no way to tell
  the two kinds apart, and the next lane will quote yours as established fact.
- MEASURE YOUR DIFF WITH THREE DOTS. \`git diff origin/main HEAD\` is UNSAFE in this
  container: every worktree shares one \`.git\`, so a SIBLING LANE's fetch moves
  \`refs/remotes/origin/main\` under you with no action of your own, and a two-dot diff
  silently starts reporting their merged work as yours. Use \`git diff origin/main...HEAD\`
  (three dots — the merge base), and the same for \`--stat\` and for any line-count you
  report. Measured 2026-08-28 on #3777: a lane's first production-line delta included a
  release-notes change it had never made, and it only caught it because the file was
  obviously not its own. A line count is exactly the kind of number that gets shrugged
  at, so it is exactly the kind that has to be measured right.
  AND IT IS THE QUICK CHECK THAT CATCHES YOU, NOT THE REPORTED NUMBER. You will be careful
  when you write the delta into your report. You will not be careful the four times you
  run one mid-task just to see where you stand — and those are two-dot by muscle memory.
  Measured 2026-08-29 on #3677: a lane reported +117 when the truth was +145, twice, from
  quick checks taken while origin/main moved under it. Both errors were in the FLATTERING
  direction, which is the half that matters: a number that says you are under budget is a
  number nobody goes back and re-derives. Use three dots every single time, including the
  ones you are not going to tell anyone about, or compute the base once
  (\`BASE=\$(git merge-base origin/main HEAD)\`) and diff against that.
- A SUBSTRING ASSERTION IS SATISFIABLE BY A NEIGHBOUR. \`toContainText("watch")\` on a card
  that also renders the user's note "Even brown, watch it." passes whether or not the
  thing you meant to assert is there — and keeps passing after the badge changes, because
  the note never does. When you assert on rendered text, ask what ELSE on that surface
  contains your string: prefer an exact match with a count
  (\`getByText("Watch", { exact: true })).toHaveCount(2)\`) over a substring, and scope to
  the element that owns the claim rather than to the page. Found 2026-08-28 in
  e2e/skin.spec.ts, where the assertion had already stopped testing the badge.
- AN ABSOLUTE CANNOT SEE A RELATIONSHIP. Before you write a geometric assertion, say
  out loud what the number is measured FROM — and check that it is the same thing a
  person looking at the screen perceives. Measured 2026-08-28 on #3673/#3920: the
  ruling's criterion was "every text run's left offset equals the page gutter", the
  guard measured text-to-VIEWPORT, and the defect was text-to-ITS-OWN-FILL. The broken
  dashboard satisfied the criterion exactly — the text really was at 16px — while every
  band's first character sat flush against the edge of the fill it was printed on,
  because the padding came off and the fill stayed inset. Both distances are honestly
  called "left offset"; only one is the thing that looked broken. The same trap waits in
  every height, gap and inset assertion: a control 44px tall inside a row that clips it,
  a gutter correct against the page and wrong against its container. Assert the
  RELATIONSHIP the ruling is about — element against the box it sits in — and keep the
  absolute too when both matter. A criterion that survives the defect it was written for
  is not a criterion.
- A SKIP IS A CLAIM ABOUT WHAT SOME OTHER CODE PATH ALREADY DID. Whenever you
  exclude something from a sweep, a rebuild or a retry because "that one was already
  handled", you are asserting that an earlier handler did the work this pass would
  have done. That assertion is about a DIFFERENT function than the one you are
  writing, so it is true of the handlers you had in mind and silently false of the
  ones you did not — and the failure is invisible, because a skip produces no output
  to be wrong. Before you write the skip, enumerate the handler CLASSES that reach it
  and say what each one actually did. Measured 2026-08-28 on #3933: a tap sweep
  excluded the tapped message because "its handler has just rebuilt it from the same
  state the sweep would read". True of handlers that re-render through a domain
  builder; false of every handler that ends in \`updateMessageKeyboard\`, which syncs
  the keyboard and never the body hash; and structurally false of the PROSE message
  class, where the handler and the sweep compute different things. The exclusion
  therefore skipped exactly the message whose staleness the feature existed to fix.
  Two measurements — the lane's own and an adversarial probe's — then agreed the
  exclusion saved nothing at all, so the fix was to DELETE it. That is the usual
  ending: an optimization defended by an assumption about a neighbour is usually
  buying less than the assumption costs, and the cheapest way to find out is to
  remove it and measure both sides before you write the justification.
- SHUT DOWN ANY DEV SERVER BEFORE YOU REPORT. If you ran \`npm run dev\` (or
  anything that leaves \`next-server\` alive), stop it and confirm it is gone
  before your final message. A clean \`git status\` does NOT mean the tree is
  free: the orchestrator's worktree cleanup refuses to delete a directory with
  live processes in it — correctly, because removing it out from under a running
  process has caused damage — so an orphaned server strands the whole worktree
  and its port until the container dies. Two lanes did this on 2026-08-22 and one
  tree could not be reclaimed at all, because killing the processes was outside
  the orchestrator's permissions.
- $SCRATCH may be UNSET in your shell. On THIS host it is ${STATE_DIR} — the same
  directory this script and scripts/orchestrator-checkin.sh resolve through
  scripts/orchestration/host.mjs. export SCRATCH=${STATE_DIR} in every shell rather
  than inferring it from another cluster's worktree, and do not write to /tmp instead.
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
  THAT NUMBER IS TIER-SPECIFIC AND ~140 IS AN E2E NUMBER. On \`test-db\` the useful
  window sits roughly 2500 lines above the tail, behind the coverage table, so ~140
  returns cleanup and coverage and nothing that says what failed — which reads as "the
  log has no failure in it" rather than as "wrong window". Measured twice on
  2026-08-28, once by an agent and once by the orchestrator. A tail large enough to
  reach it overflows the tool cap but is saved to a file the result names; slicing
  that file is the route. Better still, take the annotations first (next bullet).
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
- SMALLEST DIRECT FIX, AND COMPACT PROOFS. On 2026-08-26 the owner closed THREE PRs
  unmerged within fifteen minutes — "rebuild only the smallest direct behavior fixes;
  no AST/source scanners, occurrence allowlists, or ratchet machinery", "no parallel
  contract/helper surface", "compact table-driven/focused proofs" — and objected to
  335 added COMMENT lines inside +453 of production. So: fix the behaviour, prove it
  compactly, and do not build a surface that itself needs maintaining. If your diff
  starts growing a registry, a census, or a second helper layer, that is the signal you
  have left the fix and started building around it: STOP and put it in OPEN QUESTIONS
  with one sentence on what it would buy.
  TABLE-DRIVEN, NOT ONE \`it()\` PER CASE. This is the concrete form and it is measured:
  a lane landed four issues' worth of coverage as separate \`it()\` blocks with a prose
  header on each, and the owner rewrote it the same hour as \`it.each([...])\` tables —
  identical assertions, identical coverage, ~25% of the lines. When cases differ only in
  inputs and expected output, they are a TABLE; the prose that would have headed each one
  belongs in ONE comment above it, and only where it says something the code cannot.
  A COMMENT MUST CARRY REASONING THE CODE CANNOT. This repo rewards that and the briefs
  above ask for it — but the ratio is part of the judgement, and a diff whose production
  delta is three-quarters prose will be read as one that lost it.
- LINE BUDGET, OWNER RULING 2026-08-27. Fourteen merges added ~6,000 net lines and the
  owner called that too much growth. Two rules follow, and the first is absolute:
  DESIGN CONVERGENCE MUST BE PRODUCTION-NEGATIVE. If your change is convergence — moving
  call sites onto a shared owner, unifying two spellings of one thing — it must DELETE
  more production lines than it adds. Not net-neutral, negative. Convergence that grows
  production has not converged anything; it has added a third way of doing it.
  AND NOTHING IN THIS LIST MAY BE INTRODUCED, by convergence or by any other work:
  a SCANNER (source/AST reading), a REGISTRY, an ALLOWLIST, a VARIANT (a second shape of
  an existing component or helper, selected by a flag or a prop), or a COMPATIBILITY
  LAYER (a shim that lets old and new coexist). If the fix appears to need one, that is
  the signal to STOP and put it in OPEN QUESTIONS — building it is how the last three
  closed PRs got closed.
  FOR NON-CONVERGENCE WORK the bar is proportionality, not negativity: a behaviour fix
  may add production lines, and the number should be recognisable as the cost of THAT
  behaviour. Measured on the 2026-08-26/27 session: 75% of added lines were test and e2e
  code, so that is where the slack is. Compact the PROOFS first — tables over repeated
  \`it()\` blocks, one fixture reused over three near-copies, an assertion that names the
  property over five that enumerate it — before you consider dropping coverage. Do not
  buy a smaller diff by proving less; say in your report what the diff cost and why.
- SIMPLIFY, EXTRACT, UNIFY — OWNER RULING 2026-08-31, the line budget's positive half.
  Most work (product, design, refactoring) should leave the code SMALLER or straighter
  than it found it. Enforce invariants with TYPES, not guards: a wrong state the type
  system cannot represent needs no runtime check, no registry, and no test to police
  it — narrow the parameter, close the union, make the constructor the only door. The
  moment your approach is ADDING complexity (a new layer, a parallel concept, a guard
  where a type could be), STOP and re-ask: what is the REAL GOAL, and can it be reached
  with less code? If you proceed anyway, your report states that answer.
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
  AND A WIDE RESULT LOOKS LIKE A FINDING, which is why this one survives review.
  Measured 2026-08-31, twice in one session: a lane hunting stale references ran
  \`git grep -i "chips"\` over e2e/, got ~200 hits and learned NOTHING, because
  "chips" is ubiquitous AND CORRECT here — fact chips, filter chips, subject chips,
  range chips; the narrow \`git grep -niE "chart[- ]jump[- ]+chip"\` answered it in
  one line. The same hour, another lane checked its gate logs for a sibling's output
  with a \`gates3-*.log\` glob, got five foreign worktree names back, and had found
  nothing at all — those were five OTHER lanes' correctly-named logs, and its own two
  files were clean. Both wide results were alarming and both were empty. When a check
  comes back loud, RE-ASK IT NARROWLY before you believe it or act on it.
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
  * SPECS YOU AUTHORED OR EDITED: run locally, with repeat scrutiny, on your assigned port
    range: E2E_PORT=${portBase} ... --repeat-each=3 --retries=0. The variable is
    E2E_PORT, never PORT. This is usually one to three files and it is where you can
    actually introduce a flake, so the repeat is earned here.
    If tests in one changed file share a profile or other worker-scoped mutable
    state, ALSO run that whole file at E2E_PORT=${portBase} with
    --workers=1 --repeat-each=1 --retries=0. Repeat scrutiny and shared-fixture
    parity answer different questions (#3653); neither substitutes for the other.
  * EVERY OTHER SPEC — the blast radius, the geometry-asserting sweep, the specs that
    merely exercise code you changed: DO NOT RUN THEM LOCALLY. ${blastRadiusInstruction}
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

- A PR IS AN INSTRUMENT, AND FULL CI IS A SERIAL LANDING RESOURCE. Branch pushes
  are durable checkpoints; CI triggers only after a PR exists. Unless the
  orchestrator named this branch the NEXT LANDING CANDIDATE, push the branch but
  do not open its PR merely to obtain a full matrix that an earlier merge will
  invalidate. When promoted, merge current main, run the assigned local gates,
  open or refresh the PR once, and iterate against that exact-head CI.
  \`concurrency: cancel-in-progress\` makes a correction to THIS candidate cheap;
  it does not make simultaneous matrices on several soon-stale bases useful.
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
  AND IT BITES FROM THE OTHER DIRECTION TOO: BEING A MERGE BEHIND RE-PARTITIONS THE
  SHARDS JUST AS ADDING A FILE DOES. If main has gained a spec file since your merge
  base, your branch has one FEWER spec than main and every shard's file set differs
  from main's — so a spec you never touched runs beside neighbours it never sees on
  main, and a latent co-residency bug fires on your branch and nowhere else. Measured
  2026-08-29 on #3273: two mobile-geometry specs the lane did not author went red on
  CI, reproduced in NONE of four local configurations including a base-tree control,
  and both went green after merging main — 467 spec files against main's 468 was the
  whole story, confirmed with \`e2e-shard-plan.ts\` against a control checkout showing
  all twelve shards byte-identical afterwards. So when a red lands in a spec your diff
  does not touch, count the spec files on both sides BEFORE diagnosing the failure;
  and merge main before your final CI run, not only before your gates.
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
- AND IF YOU CONVERT A RENDER FROM A UTC-TRUNCATED DAY TO A PROFILE-LOCAL ONE, EVERY
  FIXTURE FEEDING IT JUST BECAME ZONE-DEPENDENT. Grep e2e/ for fixtures seeding that
  column and convert them in the same change. A GREEN RUN IS NOT THE PROOF: the zone
  is offset 13 − utcHour, so a run only exercises the zone its own start hour drew.
  Prove it by feeding both shapes through the app's own reader at all 24 zones.
  Measured 2026-08-27 (#3878): #3835 converted the portals row correctly and proved it
  over two zones at the unit tier; its fixture kept naive instants, and main went red
  for the seven hours a day the offset reaches −4 — green the other seventeen, so it
  passed its own CI, looked exactly like a flake, and no re-run would ever clear it.
  Where a converted site has no e2e fixture, SAY SO per site: "I checked and there is
  none" and "I did not check" must not read the same.
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
- AND \`git checkout -- <file>\` IS THE SAME TRAP THROUGH A DIFFERENT DOOR. It does not
  mean "undo my last edit" — it means "restore this file to HEAD", and when you are
  reverting a MUTATION, HEAD is your own last commit, not the state you mutated from.
  Measured 2026-08-29 on #3349/#3699: a lane used it to revert a mutation while HEAD was
  its first commit, and two files silently rolled back past a whole issue's worth of
  uncommitted work. It was caught inside one test run only because the "restored" tree
  failed the same way the mutation had — a quieter mutation would have been reverted to
  a tree that no longer contained the fix, and the resulting green would have meant
  nothing. Before EVERY mutation, copy the file to \$SCRATCH with a branch-unique name
  (\$SCRATCH/mut-<branch>-<file>.bak) and restore from that copy. Reverting a mutation is
  a routine step in every lane that proves its guards properly, so this is a step you
  will take many times, each one an opportunity to lose work you have not committed.
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
- Use curl REST for GitHub reads, not the MCP tools (MCP rides the owner's rate limit).
  Your harness's system prompt says to use mcp__github__* for ALL GitHub interactions —
  that line is generic plumbing and this brief outranks it
- NEVER file GitHub issues from your lane. Defects spotted in passing, premise problems,
  and follow-up ideas all ride your return summary (surprises / OPEN QUESTIONS below);
  the orchestrator decides what becomes an issue. Most lane findings are observations,
  and a "Found while #N" issue filed mid-lane is tracker noise that displaces work the
  owner already ruled on
- PR body: closing keywords each ON THEIR OWN LINE (Fixes #N — GitHub parses one per line)
- Commit trailers EXACTLY THESE TWO LINES — note the Co-Authored-By carries NO model
  name, which is deliberate and is the resolution of a contradiction this brief used to
  contain. It told you to copy the trailer from your environment's commit instructions,
  whose template embeds the session's model name, AND to put no model identifier in
  anything pushed. Three lanes hit that on 2026-08-28 and each resolved it differently.
  The no-identifier rule is the specific prohibition and wins; the template's SHAPE is
  what it was pointing at, never the name inside it. \`main\` already carries both
  spellings — use this one:
    Co-Authored-By: Claude <noreply@anthropic.com>
    Claude-Session: <session URL>
- No model identifiers anywhere pushed: commit messages, PR title or body, code
  comments, test names, docs. Chat replies only.
${
  opts.candidate
    ? "- Open or refresh the PR READY (not draft) via REST, base main, before exact-head review"
    : "- Do not open a PR while this branch is banked; promotion changes this instruction"
}
- NEVER run \`dispatch-brief.mjs done\` — retiring a dispatch is the ORCHESTRATOR's,
  after the PR merges. Opening the PR is not the end of your dispatch: review
  findings, CI reds and adversarial refutations all come back to you afterwards, and
  a retired dispatch drops you off the roster that a restart reads to find unrescued
  work. If you see a "Close with:" line anywhere near this brief, it is addressed to
  the orchestrator, not to you.
- Return: ${opts.candidate ? "PR number/URL" : "branch and exact head SHA"}, per-issue fix summary, VERBATIM gate results (say plainly if
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
    candidate: false,
    priority: "unclassified",
    lane: "unclassified",
    adoptClaim: false,
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
    else if (a === "--candidate") opts.candidate = true;
    else if (a === ADOPT_CLAIM) opts.adoptClaim = true;
    else if (a === "--priority") opts.priority = argv[++i];
    else if (a === "--lane") opts.lane = argv[++i];
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!PRIORITIES.has(opts.priority)) {
    throw new Error(
      `invalid priority ${opts.priority}; expected ${[...PRIORITIES].join(" | ")}`
    );
  }
  if (!LANES.has(opts.lane)) {
    throw new Error(
      `invalid lane ${opts.lane}; expected ${[...LANES].join(" | ")}`
    );
  }
  return opts;
}

function roleHandoff(entry) {
  return entry.candidate
    ? `ROLE UPDATE for ${entry.branch}: CANDIDATE. Rebase onto current main, push, open or refresh the READY PR, then obtain exact-remote-head review and full CI.`
    : `ROLE UPDATE for ${entry.branch}: BANKED. Push durable checkpoints only; do not open or refresh a PR, and defer non-authored blast-radius specs until promoted.`;
}

// A DISPATCH IS WRITTEN AGAINST A TRACKER READ THAT CAN BE HOURS OLD (#4451).
// The brief is generated from whatever the orchestrator last knew, and that
// read has no expiry: #4347 was closed at 03:09:32Z and dispatched at 09:43Z,
// and the lane spent half its dispatch discovering the diff was empty. The
// snapshot downstream can only ANNOTATE a stale row; this is the point that
// can refuse, so it asks GitHub once, here, before anything is written.
//
// Degrades: with no read token there is nothing to ask, so it warns and
// dispatches — a check that cannot run must not become a check that blocks.

/** Refusal text when any of these issue states is closed, else null. */
export function closedIssueRefusal(states) {
  const closed = states.filter((s) => s.state === "closed");
  if (!closed.length) return null;
  const named = closed
    .map(
      (s) => "#" + s.number + " closed " + (s.closedAt ?? "at an unknown time")
    )
    .join(", ");
  return (
    "REFUSED: " +
    named +
    ". A brief written against a stale tracker read sends a lane to an empty " +
    "diff (#4451). Re-read with issue-read.mjs, drop the closed number from " +
    "--issues, and dispatch the rest."
  );
}

/** Warning text when GitHub could not answer for some issues, else null. */
export function unreachableIssueWarning(states) {
  const missed = states.filter((s) => s.state === "unknown");
  if (!missed.length) return null;
  return (
    "*** GITHUB DID NOT ANSWER for " +
    missed.map((s) => "#" + s.number + ": " + s.error).join("; ") +
    " — dispatching anyway (#4460). A check that cannot run must not become " +
    "a check that BLOCKS; only a closed answer refuses. ***"
  );
}

/** Live {number, state, closedAt} per issue; null when no token can be found. */
function issueStates(
  numbers,
  repo = process.env.RECONCILE_REPO || "FloorLamp/allos"
) {
  const token = resolveReadToken();
  if (!token) return null;
  const headers = [
    "-H",
    "Authorization: Bearer " + token,
    "-H",
    "Accept: application/vnd.github+json",
  ];
  return numbers.map((number) => {
    const url = "https://api.github.com/repos/" + repo + "/issues/" + number;
    try {
      const issue = JSON.parse(
        execFileSync("curl", ["-sS", "--fail-with-body", ...headers, url], {
          encoding: "utf8",
          timeout: 30_000,
        })
      );
      return { number, state: issue.state, closedAt: issue.closed_at ?? null };
    } catch (err) {
      // A 404, a rate limit or a proxy blip is GitHub NOT ANSWERING, which is
      // the no-token case wearing a different error — same degradation. Quote
      // the BODY, never err.message: execFileSync puts the whole command in
      // it, Bearer token included, and that is what the crash path printed.
      const body = String(err.stdout ?? "").trim();
      return {
        number,
        state: "unknown",
        closedAt: null,
        error: /Not Found/.test(body)
          ? "no such issue (404) — mistyped --issues?"
          : body.slice(0, 200) || "curl exited " + err.status,
      };
    }
  });
}

// A CLAIM IS PUBLIC, AND NOTHING BETWEEN READING AN ISSUE AND WRITING A
// DISPATCH LOOKED AT IT (#5108).
//
// Twice in three hours on 2026-09-04 two orchestrators dispatched onto one
// bug. On #5091 the claim was posted at 15:18:42Z, printed by issue-read.mjs,
// and filtered out of a `sed` pipe; on #5125 no claim was written at all, so
// the other orchestrator read an unclaimed issue and behaved correctly. Being
// first is not the same as having claimed. A convention that cannot be held by
// remembering it has to be held here, at the point that can refuse.
//
// NOT A LOCK. This reads what is already public and refuses on it. It writes
// no claim, reserves nothing, and asks the other orchestrator for nothing
// beyond the convention already in use — a script that claimed on your behalf
// would claim for dry runs and abandoned drafts.
//
// AND IT REFUSES WHERE THE STALENESS CHECK ABOVE ONLY WARNS. #4460 ruled that
// a check that cannot run must not block, and that ruling still governs the
// OPEN/CLOSED read: its failure costs a lane an empty diff. This one's failure
// costs two lanes one bug, so an unreadable claim is CANNOT TELL, not CLEAR —
// the verdict `claims` gives an unreadable worktree (#4473). The override is
// the door out, and it is explicit.

/** The override: skip the claim check for a claim you have judged stale. */
const ADOPT_CLAIM = "--adopt-claim";

// Spelled `--adopt-claim`, not the issue's illustrative `--adopt`, because
// `dispatch-brief.mjs adopt <branch>` already means something else entirely —
// bring a RUNNING agent under the ledger. `new --adopt` would read as that.

// How the claim is actually written here, sampled from the tracker rather than
// from the issue's prose: "Dispatched: B, branch `live-practice-self-complete-5091`"
// and "Dispatched: branch `dispatch-claim-refusal-5108` (orchestrator A, …)".
// The opener is the stable part; markdown emphasis and quoting are not.
const CLAIM_OPENER = /^[*_>\s]*dispatched\s*:/i;

/** The claim's own first line, emphasis stripped, short enough to read. */
const claimQuote = (body) =>
  (body.split("\n").find((l) => l.trim()) ?? "")
    .replace(/\*\*|__/g, "")
    .trim()
    .slice(0, 160);

/**
 * Per-issue claim verdicts, with the reader injected so the refusal paths are
 * drivable without a network (the #4473 shape).
 *
 * WHOSE CLAIM IS IT: the discriminator is the BRANCH, never the author. Both
 * orchestrators post as the same account, so `user.login` cannot separate them
 * — but a claim names the branch it dispatched, and `new --branch X` is about
 * to create X. A claim naming X IS this dispatch's own claim, posted by the
 * convention that says claim before briefing; a claim naming anything else is
 * somebody else's lane. The one way this reads CLEAR wrongly is another
 * orchestrator writing your exact branch name into their claim, which would
 * make it the same lane anyway.
 *
 * @param {string[]} numbers issue numbers being dispatched
 * @param {string} branch the branch `new` is about to create
 * @param {(n: string) => { comments: { at: string, body: string }[] } | { unknown: string }} commentsFor
 */
export function issueClaims(numbers, branch, commentsFor) {
  return numbers.map((number) => {
    const got = commentsFor(number);
    if ("unknown" in got)
      return { number, verdict: "unknown", why: got.unknown };
    const held = got.comments.find(
      (c) => CLAIM_OPENER.test(c.body) && !c.body.includes(branch)
    );
    return held
      ? {
          number,
          verdict: "claimed",
          at: held.at,
          quote: claimQuote(held.body),
        }
      : { number, verdict: "clear" };
  });
}

/** Refusal text when another lane already holds one of these, else null. */
export function claimedIssueRefusal(rows) {
  const held = rows.filter((r) => r.verdict === "claimed");
  if (!held.length) return null;
  return (
    "REFUSED: " +
    held
      .map((r) => `#${r.number} was claimed ${r.at} — "${r.quote}"`)
      .join("; ") +
    ". One bug, one lane; the earlier claim holds. Re-read it WHOLE with " +
    "issue-read.mjs (no pipe — filtering the claim out of one is how #5091 " +
    `collided), drop it from --issues, and dispatch the rest. Use ${ADOPT_CLAIM} ` +
    "if you are taking over a claim that is genuinely stale."
  );
}

/** Refusal text when a claim could not be READ, else null. */
export function unreadableClaimRefusal(rows) {
  const blind = rows.filter((r) => r.verdict === "unknown");
  if (!blind.length) return null;
  return (
    "REFUSED: could not read the claims on " +
    blind.map((r) => `#${r.number}: ${r.why}`).join("; ") +
    ". AN UNREACHABLE CLAIM IS NOT AN ABSENT ONE — this is CANNOT TELL, not " +
    "CLEAR (#5108). Retry when GitHub answers, or read the issue yourself and " +
    `pass ${ADOPT_CLAIM} once you have seen that nobody holds it.`
  );
}

// THE SAME QUESTION, ABOUT A PR (#5177). The claim above guards an ISSUE; on
// 2026-09-04 the collision arrived through the other door — a fix round
// dispatched onto #5139's branch, which pushed three commits onto the other
// session's open PR. Every ledger check said CLEAR, correctly: the branch was
// never in this session's ledger, because it was never this session's lane.
//
// The discriminator here is not the branch (the branch is exactly what both
// sessions would name) and not the author (one account). It is the session
// footer in the PR's own body, which is the marker `merge-gate.mjs` reads for
// the same question at merge time — one reader, not a third convention.

/**
 * The open PR this branch heads whose body ATTRIBUTES it, or null. One
 * spelling, because two readers now ask it: the refusal below, and the caller
 * deciding whether the PR bodies answered at all (#5179).
 *
 * @param {{ head?: { ref?: string }, number?: number, body?: string }[]} prs
 * @param {string} branch
 */
function attributedPr(prs, branch) {
  const pr = (prs ?? []).find((p) => p?.head?.ref === branch);
  return pr && bodySession(pr.body) ? pr : null;
}

/**
 * Refusal when an OPEN PR already has this branch as its head and its body
 * names a session other than the one running. Null when it does not, and null
 * when there is nothing to compare against — those are WARNINGS the caller
 * prints, because unlike the issue claim this read happens on EVERY dispatch
 * and #4460 governs a check whose failure would cost every lane its start.
 *
 * @param {{ head?: { ref?: string }, number?: number, body?: string }[]} prs
 * @param {string} branch the branch about to be dispatched onto
 * @param {string|null} self the running session, normalised
 */
export function branchPrRefusal(prs, branch, self) {
  if (!self) return null;
  const pr = attributedPr(prs, branch);
  const theirs = pr && normaliseSession(bodySession(pr.body));
  if (!theirs || theirs === self) return null;
  return (
    `REFUSED: ${branch} is the head of open PR #${pr.number}, whose body names ` +
    `${theirs} — ANOTHER orchestrator session (this one is ${self}). Pushing ` +
    "onto it is two writers on one branch, and merging it takes that session's " +
    "control of its own landing slot (#5177). Dispatch onto a branch of your " +
    `own, or pass ${ADOPT_CLAIM} if the two sessions have actually agreed.`
  );
}

// THE SAME QUESTION AGAIN, FOR THE BRANCHES A PR CANNOT ANSWER FOR (#5179).
//
// `branchPrRefusal` above returns null whenever no OPEN PR has the branch as
// its head, and that is most of this repo's branches: banked work is
// branch-only by design, and #5220's census counted 70 remote branches with no
// open PR, only 14 of which introduce zero files against their merge base. A
// closed PR and a body that lost its footer land in the same silence. The commit trailer answers for all three,
// because every commit an agent pushes here carries `Claude-Session:`.
//
// TWO READERS, TWO POPULATIONS, AND THE REFUSAL SAYS WHICH ONE ANSWERED — a
// caller cannot act on "refused" without knowing whether the PR body or the
// commit decided, since only one of them has a PR to go and read.

/**
 * The session a commit message's `Claude-Session:` trailer names, or null.
 *
 * The trailer LINE AT COLUMN 0, never any session id in the prose: commit
 * messages here quote refusals and each other, and a commit that quotes
 * `session_x` — or quotes a whole trailer, indented, as a quotation is written
 * — is not a commit `session_x` wrote. `--format=%B` prints a message raw, so
 * a real trailer is always unindented and this costs nothing.
 *
 * The FIRST trailer wins, because the reader hands this the branch's own
 * commits NEWEST FIRST — so the first trailer in the text is the
 * most recent commit that signed one, and a `git merge origin/main` commit
 * (which signs nothing) falls through to the work underneath it instead of
 * reading as an unowned branch.
 *
 * @param {string|null|undefined} messages one or more commit messages, newest first
 */
export function trailerSession(messages) {
  const line = String(messages ?? "")
    .split("\n")
    .find((l) => /^Claude-Session:/i.test(l));
  return line ? normaliseSession(line) : null;
}

/**
 * Refusal when the trailer on the branch's own work names another session.
 * Null when it names this one, null when there is no trailer — an unmarked
 * commit is not attributable, which is the same answer `branchPrRefusal` gives
 * an unmarked PR body.
 *
 * Call this only where the PR read did NOT attribute the branch; its wording
 * says so, and that sentence is true of every case the caller reaches it in.
 *
 * @param {string|null} messages the branch's own commit messages, newest first
 * @param {string} branch the branch about to be dispatched onto
 * @param {string|null} self the running session, normalised
 */
export function branchTrailerRefusal(messages, branch, self) {
  if (!self) return null;
  const theirs = trailerSession(messages);
  if (!theirs || theirs === self) return null;
  return (
    `REFUSED: the newest commit ${branch} carries and origin/main does not has ` +
    `a Claude-Session: trailer naming ${theirs} — ANOTHER orchestrator session ` +
    `(this one is ${self}). The PR bodies did not answer for ${branch} (no open ` +
    "PR heads it, or the one that does carries no session footer), so the " +
    "COMMIT TRAILER did (#5179). " +
    "Pushing onto it is two writers on one branch. The alternative that works: " +
    "REVIEW it and COMMENT the finding on its issue or PR, and let the owning " +
    "session push the fix — that is what happened on #5139 after the fact. Or " +
    `dispatch onto a branch of your own, or pass ${ADOPT_CLAIM} if the two ` +
    "sessions have actually agreed."
  );
}

/**
 * The messages of the commits `branch` carries and origin/main does not, or a
 * stated reason there are none to read. Local ref first, then this clone's
 * remote-tracking ref, then the remote itself — because a branch another
 * session banked from another clone has no ref here at all, and "I have no ref
 * for it" must not read as "it has no trailer".
 *
 * @returns {{ messages: string, ref: string } | { absent: string } | { unknown: string }}
 */
function ownCommitsReader(branch) {
  const args = branchGitArgs(branch);
  let sawRef = false;
  for (const [exists, own, ref] of [
    [args.localExists, args.localOwn, `refs/heads/${branch}`],
    [args.remoteExists, args.remoteOwn, `origin/${branch}`],
  ]) {
    if (git(exists, { allowFail: true }) === null) continue;
    sawRef = true;
    const messages = git(own, { allowFail: true });
    if (messages === null)
      return {
        unknown: `${ref} exists but \`git log ${ref} --not origin/main\` failed`,
      };
    if (messages) return { messages, ref };
  }
  if (sawRef) return { absent: "every commit on it is already in origin/main" };
  const onRemote = git(args.onRemote, { allowFail: true });
  if (onRemote === null)
    return { unknown: `\`git ls-remote origin refs/heads/${branch}\` failed` };
  return onRemote
    ? {
        unknown:
          `origin has ${branch} but this clone has no ref for it — run ` +
          `\`git fetch origin ${branch}\` and dispatch again`,
      }
    : { absent: "it exists neither here nor on origin" };
}

/** Open PRs over the live API, or a stated reason they could not be read. */
function openPrsReader(repo = process.env.RECONCILE_REPO || "FloorLamp/allos") {
  const token = resolveReadToken();
  if (!token) return { unknown: "no read token in $GH_TOKEN or $GITHUB_TOKEN" };
  try {
    const raw = execFileSync(
      "curl",
      [
        "-sS",
        "--fail-with-body",
        "-H",
        "Authorization: Bearer " + token,
        "-H",
        "Accept: application/vnd.github+json",
        `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`,
      ],
      { encoding: "utf8", timeout: 30_000 }
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? { prs: parsed }
      : { unknown: String(parsed?.message ?? "the PR list was not a list") };
  } catch (err) {
    // The BODY, never err.message: execFileSync puts the Bearer token in it.
    const body = String(err.stdout ?? "").trim();
    return { unknown: body.slice(0, 200) || "curl exited " + err.status };
  }
}

/**
 * BOTH READERS, IN ORDER, AS ONE DECISION — pure, with the reads handed in, so
 * the ordering is drivable without a network or a git tree (the #4473 shape).
 * Both are thunks: the second reader only runs when the first did not answer,
 * and that laziness is the whole ordering — neither costs a call it need not.
 *
 * @param {string} branch
 * @param {string|null} self the running session, normalised
 * @param {{ readPrs: () => { prs: object[] } | { unknown: string },
 *           readOwnCommits: () => { messages: string, ref: string } | { absent: string } | { unknown: string } }} reads
 * @returns {{ refusal: string|null, notes: string[] }}
 */
export function branchOwnerVerdict(branch, self, reads) {
  const notes = [];
  if (!self)
    return {
      refusal: null,
      notes: [
        `[pr-owner] UNCHECKED: this host exposes no session id, so whether ${branch} ` +
          "belongs to another session was not asked (#5177).",
      ],
    };
  const prs = reads.readPrs();
  if ("unknown" in prs) {
    notes.push(
      `[pr-owner] CANNOT TELL: could not read the open PRs (${prs.unknown}) — ` +
        `whether ${branch} is another session's landing slot is UNANSWERED by the ` +
        "PR bodies (#5177). Asking the commit trailer instead (#5179)."
    );
  } else {
    const refusal = branchPrRefusal(prs.prs, branch, self);
    if (refusal) return { refusal, notes };
    // The PR body ANSWERED, and the answer was "this session's". Stop: the
    // body is the authority when it has one, and the trailer can legitimately
    // disagree — the #5139 incident left another session's commits on the head
    // of a PR whose owner is still its owner, and refusing that owner from
    // their own landing slot is the opposite of this guard's job.
    const pr = attributedPr(prs.prs, branch);
    if (pr)
      return {
        refusal: null,
        notes: [
          ...notes,
          `[pr-owner] ${branch} heads open PR #${pr.number}, whose body names this ` +
            "session (#5177).",
        ],
      };
    notes.push(
      `[pr-owner] ${branch} heads none of the ${prs.prs.length} open PRs with ` +
        "a session footer (#5177), so the PR bodies did not answer — asking the " +
        "commit trailer instead (#5179)."
    );
  }
  // THE FALLBACK, AND ITS FAILURES ARE WARNINGS RATHER THAN REFUSALS — the
  // posture `branchPrRefusal` set, and #4460 governs it: this read runs on
  // EVERY dispatch, so a git or network hiccup that refused would cost every
  // lane its start, while the other direction is bounded — `merge-gate.mjs`
  // asks ownership again, off the same marker, before anything lands. What a
  // warning may NOT do is read like a pass, so each one says what it examined.
  const own = reads.readOwnCommits();
  if ("unknown" in own)
    return {
      refusal: null,
      notes: [
        ...notes,
        `[branch-owner] CANNOT TELL: nothing to read for ${branch} (${own.unknown}), ` +
          "so whose branch it is went UNANSWERED (#5179).",
      ],
    };
  if ("absent" in own)
    return {
      refusal: null,
      notes: [
        ...notes,
        `[branch-owner] ${branch} carries no unlanded commit — ${own.absent} — so ` +
          "there is no trailer to own it (#5179).",
      ],
    };
  const refusal = branchTrailerRefusal(own.messages, branch, self);
  if (refusal) return { refusal, notes };
  return {
    refusal: null,
    notes: [
      ...notes,
      trailerSession(own.messages)
        ? `[branch-owner] ${own.ref}'s newest unlanded commit names this session (#5179).`
        : `[branch-owner] no commit on ${own.ref} outside origin/main carries a ` +
          "Claude-Session: trailer — nothing attributes it, so this dispatches as " +
          "it always did (#5179).",
    ],
  };
}

/**
 * The branch-ownership check as `new` and `adopt` run it. It prints what it
 * examined either way, so an answer it could not reach never passes for a
 * clean one, and it exits 1 on a positive finding.
 */
function refuseAnotherSessionsBranch(branch, adopted) {
  if (adopted) return;
  const { refusal, notes } = branchOwnerVerdict(
    branch,
    normaliseSession(process.env.CLAUDE_CODE_REMOTE_SESSION_ID),
    { readPrs: openPrsReader, readOwnCommits: () => ownCommitsReader(branch) }
  );
  for (const note of notes) console.error(note);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}

/** `commentsFor` over the live API. Every failure names itself; none is CLEAR. */
function issueCommentsReader(
  repo = process.env.RECONCILE_REPO || "FloorLamp/allos"
) {
  const token = resolveReadToken();
  return (number) => {
    if (!token)
      return { unknown: "no read token in $GH_TOKEN or $GITHUB_TOKEN" };
    const url =
      "https://api.github.com/repos/" +
      repo +
      "/issues/" +
      number +
      "/comments?per_page=100";
    let raw;
    try {
      raw = execFileSync(
        "curl",
        [
          "-sS",
          "--fail-with-body",
          "-H",
          "Authorization: Bearer " + token,
          "-H",
          "Accept: application/vnd.github+json",
          url,
        ],
        { encoding: "utf8", timeout: 30_000 }
      );
    } catch (err) {
      // Quote the BODY, never err.message: execFileSync puts the whole command
      // in it, Bearer token included (the lesson issueStates above carries).
      const body = String(err.stdout ?? "").trim();
      return { unknown: body.slice(0, 200) || "curl exited " + err.status };
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed))
        return {
          comments: parsed.map((c) => ({
            at: c.created_at,
            body: String(c.body ?? ""),
          })),
        };
    } catch {
      // fall through to the one honest answer: we did not get comments.
    }
    return { unknown: "unreadable reply: " + raw.trim().slice(0, 120) };
  };
}

function cmdNew(argv) {
  const opts = parseArgs(argv);
  if (!opts.branch) {
    console.error(
      "usage: dispatch-brief.mjs new --branch <branch> [--worktree wt-x] [--issues 1,2]" +
        ' [--task "..."] [--e2e] [--port-base N] [--candidate] [--priority P1] [--lane user-data]'
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
  const currentCandidate = active.find((d) => d.candidate);
  if (opts.candidate && currentCandidate) {
    console.error(
      `REFUSED: ${currentCandidate.branch} is already the landing candidate. ` +
        `Use \`promote ${opts.branch}\` after creating this dispatch banked; promotion records the displacement.`
    );
    process.exit(1);
  }
  const e2eFull = opts.e2e && e2eLaneRefusal(active, opts.branch);
  if (e2eFull) {
    console.error(`REFUSED: ${e2eFull}`);
    process.exit(1);
  }
  if (active.length >= MACHINE_CAP_WARN) {
    console.error(
      `*** MACHINE CAP: ${active.length} dispatches already active (measured cap ` +
        `${MACHINE_CAP_WARN} on the 4-core container — dispatch.md §Dispatch). ***\n` +
        "    Contention MISLEADS, not just slows: a starved gate tier fails in\n" +
        "    untouched code and reads as a regression. Not a refusal — a P0 preempts."
    );
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

  // Last check before anything is written: is this work still open?
  const states = opts.issues.length ? issueStates(opts.issues) : [];
  if (states === null) {
    console.error(
      "*** NO READ TOKEN: dispatching WITHOUT re-reading issue state (#4451). ***\n" +
        "    A brief is only as fresh as the tracker read behind it."
    );
  } else {
    const unreachable = unreachableIssueWarning(states);
    if (unreachable) console.error(unreachable);
    const stale = closedIssueRefusal(states);
    if (stale) {
      console.error(stale);
      process.exit(1);
    }
  }

  // And is it already someone else's? Still before anything is written.
  if (opts.adoptClaim) {
    console.error(
      `*** ${ADOPT_CLAIM}: claim check SKIPPED — you are asserting that any ` +
        `existing claim on ${opts.issues.join(", ") || "these issues"} is stale. ***`
    );
  } else if (opts.issues.length) {
    const claims = issueClaims(opts.issues, opts.branch, issueCommentsReader());
    const refusals = [
      claimedIssueRefusal(claims),
      unreadableClaimRefusal(claims),
    ].filter(Boolean);
    if (refusals.length) {
      for (const refusal of refusals) console.error(refusal);
      process.exit(1);
    }
  }
  refuseAnotherSessionsBranch(opts.branch, opts.adoptClaim);

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
    candidate: opts.candidate,
    priority: opts.priority,
    lane: opts.lane,
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
    // The empty board is where sessions have actually stalled (2026-08-30):
    // after a recovery, "the lanes are empty" got REPORTED instead of fixed.
    console.log(
      "No active dispatches — a DISPATCH ORDER, not calm. Unless a hold or an\n" +
        "owner wind-down governs, triage and refill now; 'the lanes are empty' is\n" +
        "only honest beside the list of why every remaining issue is blocked,\n" +
        "owner-gated, or dependency-bound."
    );
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
          `  [${d.candidate ? "candidate" : "banked"}]` +
          `  priority=${d.priority ?? "unclassified"}  lane=${d.lane ?? "unclassified"}` +
          `${d.e2e ? "  [e2e]" : ""}${d.issues?.length ? `  issues=${d.issues.join(",")}` : ""}` +
          flag
      );
    }
    if (active.length < 3) {
      // The other measured under-dispatch shape: a few merges land and the
      // session sits at one lane. Refill is the default, not a decision.
      // PER AXIS (owner, 2026-08-31): a live session read "both e2e slots
      // full" as "the queue is thin" while three non-e2e slots sat open — a
      // capacity limit substituted for a queue fact. Only the axis that is
      // full gets to say so, and "thin" is a claim that needs receipts.
      const e2eActive = active.filter((d) => d.e2e).length;
      console.log(
        `  ${active.length} lane(s) active (e2e ${e2eActive}/${E2E_LANE_CAP}, ` +
          `other ${active.length - e2eActive}) — UNDER-SATURATED. A full e2e lane\n` +
          "  is NOT a thin queue: the caps are separate axes (2 e2e, ~5 lanes, ~3\n" +
          "  unreviewed PRs). Before calling the queue thin: PAIR small issues into\n" +
          "  one cluster, source self-filed P3s (back of the queue is still IN the\n" +
          "  queue), do the standing work (reconcile, release notes) — or list why\n" +
          "  each remaining issue is blocked, owner-gated, or dependency-bound."
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
function worktreePathsByBranch(cwd = repoRoot) {
  const byBranch = new Map();
  const out = git("worktree list --porcelain", { allowFail: true, cwd });
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

// --- file claims ------------------------------------------------------------
//
// IS ANYONE ELSE IN THIS FILE? (#4473)
//
// A brief names the other live lanes in a sentence written ONCE, at dispatch,
// and lanes run for one to two hours — so every lane dispatched afterwards is
// invisible to the one already running. `history-clock-brand-4452` checked the
// three lanes its brief named before extending a brand into DayLedger.tsx, saw
// no conflict, and was wrong: `write-pipeline-3276` had been dispatched into
// that exact file in the meantime. It was stopped by ASKING the orchestrator,
// and a lane happening to ask is not a control.
//
// The roster was on disk the whole time. This asks it instead.
//
// AND A WORKTREE IT CANNOT READ IS `unknown`, NEVER `clear`. A container
// restart, a `done --keep` later cleaned up, a lane whose `git worktree add`
// was denied — the ledger still holds the dispatch and there is nothing on disk
// to inspect. Reported as clear that is a confident lie, which is the exact
// failure this command exists to remove; reported as "cannot tell" it sends the
// lane to ask, which is what it would have done anyway.
//
// AN ANSWER IS TRUE AT THE MOMENT IT RAN AND NO LONGER. This reads mutable
// state — dirty trees, unpushed commits, a roster other agents are appending
// to — so a lane that asks, thinks for twenty minutes and then edits is holding
// a stale answer for the SAME reason the sentence in its brief was stale. Ask
// again immediately before you write. Measured while this was being built: a
// worktree read as holding ONE uncommitted file was read again minutes later
// with a clean tree, because its lane had committed in between.
//
// AND `origin/main` IN A LANE'S WORKTREE CAN BE BEHIND, so the third walk can
// report a path as held when main has since absorbed that very change. That
// OVER-reports, which is the safe direction and not a bug to diagnose.
//
// THE UNIT IS THE FILE, DELIBERATELY. Two lanes editing different functions in
// one file are reported as a collision, because a merge conflict is a
// file-level fact and two lanes in one file should be sequenced whether or not
// their hunks have met yet. Reporting line ranges would be more machinery
// answering a question nobody asked.

/** Two repo-relative paths overlap when either contains the other. */
export const pathOverlaps = (a, b) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * Per-dispatch verdicts for one path. `changesFor` returns either the paths a
 * dispatch is holding or the reason it could not be asked.
 * @param {string} target repo-relative path
 * @param {{ branch: string }[]} dispatches
 * @param {(d: { branch: string }) => { paths: string[] } | { unknown: string }} changesFor
 */
export function fileClaims(target, dispatches, changesFor) {
  return dispatches.map((d) => {
    const found = changesFor(d);
    if ("unknown" in found)
      return { branch: d.branch, verdict: "unknown", why: found.unknown };
    const hit = found.paths.find((p) => pathOverlaps(p, target));
    return {
      branch: d.branch,
      verdict: hit ? "claimed" : "clear",
      why: hit ?? null,
    };
  });
}

/** One answer for the caller: a claim outranks an unknown, and both outrank clear. */
export const claimsVerdict = (rows) =>
  rows.some((r) => r.verdict === "claimed")
    ? "claimed"
    : rows.some((r) => r.verdict === "unknown")
      ? "unknown"
      : "clear";

/** Exit status per verdict — 2 stays the usage error every command here uses. */
const CLAIMS_EXIT = { claimed: 1, unknown: 3, clear: 0 };

// What a dispatch is HOLDING: everything in its worktree that is not in main —
// uncommitted, committed-unpushed, and pushed-but-unlanded alike. The narrower
// "uncommitted or unpushed" reading would call a lane's pushed branch clear, and
// a pushed branch collides at merge exactly like a dirty tree does.
function worktreeChanges(dir) {
  if (!dir) return { unknown: "no worktree for this branch" };
  if (!fs.existsSync(dir))
    return { unknown: `worktree gone from disk (${dir})` };
  // Three commands that each return PLAIN PATHS. `git status --porcelain` would
  // answer the first two at once, and its two-column prefix is a trap here:
  // `git()` above trims its output, so the leading space of an unstaged " M"
  // disappears and every fixed-width slice is off by one on the first entry only
  // — a parse that looks right and drops the file you asked about.
  const opts = { cwd: dir, allowFail: true };
  const out = [
    git(["diff", "--name-only", "-z", "HEAD"], opts), // tracked, staged or not
    git(["ls-files", "-z", "--others", "--exclude-standard"], opts), // untracked
    git(["diff", "--name-only", "-z", "origin/main...HEAD"], opts), // unlanded
  ];
  if (out.some((o) => o === null))
    return { unknown: `git could not read ${dir}` };
  return { paths: out.flatMap((o) => o.split("\0").filter(Boolean)) };
}

function cmdClaims(argv) {
  const [arg] = argv;
  if (!arg) {
    console.error("usage: dispatch-brief.mjs claims <path>");
    process.exit(2);
  }
  // Asked of the repository you are standing in, so a lane can pass a path
  // relative to its own worktree — every worktree shares one `.git`, so the
  // roster it sees is the same one from anywhere in the tree.
  const cwd = process.cwd();
  const root = git(["rev-parse", "--show-toplevel"], { cwd, allowFail: true });
  if (!root) {
    console.error(
      "dispatch-brief.mjs claims: run it from inside the repository."
    );
    process.exit(2);
  }
  const target = path.relative(root, path.resolve(cwd, arg));
  if (!target || target.startsWith("..")) {
    console.error(`dispatch-brief.mjs claims: ${arg} is outside ${root}.`);
    process.exit(2);
  }
  // A DETACHED worktree gets the literal "HEAD" here, which matches no branch,
  // so nothing is excluded and the caller's own dispatch comes back as `unknown`
  // (git lists no worktree for its branch). That is the ALARM direction, not the
  // false-clear one, and no lane runs detached — so this is left alone on
  // purpose. Do not "fix" it by dropping the filter or by matching on worktree
  // path: both trade an alarm nobody sees for a CLEAR that would be wrong, which
  // is the one answer this command must never give.
  const self = git(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    allowFail: true,
  });
  const worktrees = worktreePathsByBranch(cwd);
  const others = activeDispatches(readLedger()).filter(
    (d) => d.branch !== self
  );
  const rows = fileClaims(target, others, (d) =>
    worktreeChanges(worktrees.get(d.branch) ?? null)
  );
  const verdict = claimsVerdict(rows);

  const claimed = rows.filter((r) => r.verdict === "claimed");
  const unknown = rows.filter((r) => r.verdict === "unknown");
  if (claimed.length) {
    console.log(`CLAIMED  ${target}`);
    for (const r of claimed)
      console.log(`  ${r.branch}  holds ${r.why} (not in main)`);
  }
  if (unknown.length) {
    console.log(
      `CANNOT TELL  ${target} — these dispatches could not be read, which is NOT clear:`
    );
    for (const r of unknown) console.log(`  ${r.branch}  ${r.why}`);
    console.log("  Ask the orchestrator before touching it.");
  }
  if (verdict === "clear") {
    console.log(
      `CLEAR  ${target} — ${rows.length} other active dispatch(es), all readable.`
    );
  }
  process.exit(CLAIMS_EXIT[verdict]);
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
  const args = branchGitArgs(branch);
  const local = git(args.localLog, {
    allowFail: true,
  });
  if (local) return commitIdleMs(local);
  const remote = git(args.remoteLog, {
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
// "denied-and-idle" agent of 2026-08-10 had its
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
    const args = branchGitArgs(branch);
    const remoteAlive = git(args.remoteExists, { allowFail: true }) !== null;
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
  const args = branchGitArgs(branch);
  if (git(args.localExists, { allowFail: true }) !== null) {
    if (git(args.deleteLocal, { allowFail: true }) !== null) {
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
    candidate: Boolean(entry.candidate),
    priority: entry.priority ?? "unclassified",
    lane: entry.lane ?? "unclassified",
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
  const { active, prior, candidate } = resumeState(rows, branch);
  if (active.some((d) => d.branch === branch)) {
    console.error(`${branch} is already active — nothing to resume.`);
    process.exit(1);
  }
  if (!prior) {
    console.error(
      `no prior dispatch for ${branch} in the ledger — use \`new --branch ${branch}\`.`
    );
    process.exit(1);
  }
  const e2eFullOnResume = prior.e2e && e2eLaneRefusal(active, prior.branch);
  if (e2eFullOnResume) {
    console.error(`REFUSED: cannot resume — ${e2eFullOnResume}`);
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
    candidate,
    priority: prior.priority ?? "unclassified",
    lane: prior.lane ?? "unclassified",
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
  console.log(roleHandoff(entry));
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
      'usage: dispatch-brief.mjs adopt <branch> [--issues 1,2] [--task "..."] [--e2e] [--port-base N] [--candidate] [--priority P1] [--lane user-data]'
    );
    process.exit(2);
  }
  const opts = parseArgs(argv.filter((a) => a !== branch));
  const active = activeDispatches(readLedger());
  if (active.some((d) => d.branch === branch)) {
    console.error(`${branch} is already active — nothing to adopt.`);
    process.exit(1);
  }
  const currentCandidate = active.find((d) => d.candidate);
  if (opts.candidate && currentCandidate) {
    console.error(
      `REFUSED: ${currentCandidate.branch} is already the landing candidate. Adopt banked, then use \`promote ${branch}\`.`
    );
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
  refuseAnotherSessionsBranch(branch, opts.adoptClaim);
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
  const e2eFullOnAdopt = opts.e2e && e2eLaneRefusal(active, branch);
  if (e2eFullOnAdopt) {
    console.error(`REFUSED: cannot adopt as e2e-touching — ${e2eFullOnAdopt}`);
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
    candidate: opts.candidate,
    priority: opts.priority,
    lane: opts.lane,
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

function cmdPromote(argv) {
  const branch = argv[0];
  if (!branch) {
    console.error("usage: dispatch-brief.mjs promote <branch>");
    process.exit(2);
  }
  const active = activeDispatches(readLedger());
  const target = active.find((d) => d.branch === branch);
  if (!target) {
    console.error(
      `no active dispatch for ${branch}; create or adopt it first.`
    );
    process.exit(1);
  }
  const previous = active.find((d) => d.candidate && d.branch !== branch);
  const at = new Date().toISOString();
  appendLedger({
    at,
    status: "promotion",
    target: branch,
    displaced: previous?.branch ?? null,
  });
  const refreshed = activeDispatches(readLedger());
  const promoted = refreshed.find((entry) => entry.branch === branch);
  const displaced = previous
    ? refreshed.find((entry) => entry.branch === previous.branch)
    : null;
  console.log(
    `promoted ${branch} to landing candidate` +
      (previous ? `; displaced ${previous.branch} to banked` : "") +
      ". Deliver every ROLE UPDATE below to its running agent."
  );
  if (promoted) console.log(roleHandoff(promoted));
  if (displaced) console.log(roleHandoff(displaced));
}

function cmdUpdate(argv) {
  const branch = argv[0];
  if (!branch) {
    console.error(
      "usage: dispatch-brief.mjs update <branch> [--priority P1] [--lane user-data]"
    );
    process.exit(2);
  }
  const flagArgs = argv.slice(1);
  if (!flagArgs.includes("--priority") && !flagArgs.includes("--lane")) {
    console.error("update requires --priority, --lane, or both.");
    process.exit(2);
  }
  const opts = parseArgs(flagArgs);
  const active = activeDispatches(readLedger());
  const entry = active.find((dispatch) => dispatch.branch === branch);
  if (!entry) {
    console.error(`no active dispatch for ${branch}.`);
    process.exit(1);
  }
  const update = {
    at: new Date().toISOString(),
    status: "update",
    branch,
    ...(flagArgs.includes("--priority") ? { priority: opts.priority } : {}),
    ...(flagArgs.includes("--lane") ? { lane: opts.lane } : {}),
  };
  appendLedger(update);
  const refreshed = activeDispatches(readLedger()).find(
    (dispatch) => dispatch.branch === branch
  );
  console.log(
    `updated ${branch}: priority=${refreshed.priority} lane=${refreshed.lane} ` +
      `(append-only ledger); deliver this allocation change to the running agent.`
  );
}

function main(argv) {
  const [cmd = "new", ...rest] = argv;
  try {
    if (cmd === "new") cmdNew(rest);
    else if (cmd === "list") cmdList();
    else if (cmd === "brief") cmdBrief(rest);
    else if (cmd === "promote") cmdPromote(rest);
    else if (cmd === "update") cmdUpdate(rest);
    else if (cmd === "done") cmdDone(rest);
    else if (cmd === "resume") cmdResume(rest);
    else if (cmd === "adopt") cmdAdopt(rest);
    else if (cmd === "claims") cmdClaims(rest);
    else {
      console.error(
        `unknown command: ${cmd} (expected new | list | brief | promote | update | done | resume | adopt | claims)`
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
if (isMain(process.argv, import.meta.url)) main(process.argv.slice(2));
