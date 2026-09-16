// Dispatch-brief generator and shared dispatch ledger.
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
// new/adopt record ownership; brief reprints a live dispatch without writing.
// list reports active work; claims checks live worktree paths (0 clear, 1 claimed,
// 3 unreadable, 4 starting). promote selects the sole landing candidate; done
// retires one (--keep preserves its worktree) and resume reopens a closed one.
// Coordination state is resolved by ledger.mjs.

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { helpGuard, isMain } from "./usage.mjs";
import {
  discoverNodeBin,
  nvmrcMajorAt,
  resolveReadToken,
  resolveStateDir,
} from "./host.mjs";
import {
  bodySession,
  COMMIT_TRAILER_BRIEF,
  normaliseSession,
} from "./merge-gate-core.mjs";
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
 * The MAIN checkout, asked of git rather than inferred from this file's location:
 * `repoRoot` answers "where does this copy live", a different question from any
 * worktree. `--git-common-dir` resolves to the main checkout's `.git` from every
 * linked worktree, so its parent is the answer wherever the caller sits; outside
 * a git tree, `repoRoot` is the only meaningful fallback.
 */
function mainCheckout() {
  const common = git("rev-parse --path-format=absolute --git-common-dir", {
    allowFail: true,
  });
  return common ? path.resolve(path.dirname(common)) : repoRoot;
}

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
    localOwn: ["log", "--format=%B", localRef, "--not", MAIN_REF],
    remoteOwn: ["log", "--format=%B", remoteRef, "--not", MAIN_REF],
    // Does the REMOTE have it, when this clone has no ref for it? Read-only —
    // it moves nothing in the shared .git every worktree here shares.
    onRemote: ["ls-remote", "origin", localRef],
  };
}

// --- discovery -------------------------------------------------------------

/**
 * Which `.nvmrc` a dispatch's node major comes from. A lane branches from
 * `origin/main`, so that tree's pin governs it, not this checkout's, which may
 * be behind main or hold a lane's own edit (#5906). The working tree is the
 * named FALLBACK; neither read is UNREAD, never a guess. host.mjs reads and
 * parses both (#5940); this says only which one the brief may quote.
 *
 * @param {string|null} atMain the major at origin/main, null if unreadable
 * @param {string|null} working the major here, null if unreadable
 * @returns {{ major: string, at: string } | { unread: string }}
 */
export function nodePin(atMain, working) {
  if (atMain) return { major: atMain, at: "origin/main" };
  if (working)
    return {
      major: working,
      at: "this checkout's working tree — origin/main's could not be read",
    };
  return {
    unread: "neither origin/main's .nvmrc nor this checkout's could be read",
  };
}

const nvmrcPin = () => nodePin(nvmrcMajorAt(MAIN_REF), nvmrcMajorAt());

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
    ? `This clone is SHALLOW; ${begins}. Deepen with \`git fetch --deepen=200 origin main\`\n` +
        `  — BOUNDED, since policy can refuse \`--unshallow\` — before merging origin/main or\n` +
        `  checking older claims: without the merge base, git reports unrelated histories`
    : `This clone has FULL history; ${begins}. Older history IS checkable here`;
}

function historyDepth() {
  const shallow =
    git("rev-parse --is-shallow-repository", { allowFail: true }) === "true";
  // `git log --reverse -1` returns the NEWEST commit (the limit applies before
  // the reversal), so the root is asked for as a root. A shallow clone's graft
  // boundary is parentless and answers here too — exactly what "history begins
  // at" means there.
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

const RESERVED_PORT_REASON = (base) =>
  base >= 6000 && base < 6100
    ? `port base ${base} is inside 6000-6099, which Next refuses ("Bad port: reserved for x11")`
    : null;

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
// than inline counts, for the reason the port-collision rule left the
// allocator's loop: a rule at one call site is a rule the next one skips. The
// two-agent E2E cap holds on EVERY host and refuses; the machine cap only WARNS,
// being host-dependent, and a P0 preempts it.
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
  const pin = nvmrcPin();
  const nodeBin = "unread" in pin ? null : discoverNodeBin(pin.major);
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

  const priorWorktree = readLedger().find(
    (r) => r.worktree === opts.worktree && r.branch !== opts.branch
  );
  if (priorWorktree) {
    throw new Error(
      `worktree ${opts.worktree} already belongs to dispatch ${priorWorktree.branch} (active or retired). ` +
        `A path is never reused — pick a branch-specific one.`
    );
  }

  const nodeLine =
    "unread" in pin
      ? `- Node major UNREAD (${pin.unread}) — resolve it with\n` +
        `  \`node scripts/orchestration/host.mjs node-bin origin/main\`, then export PATH\n` +
        `  to that bin dir in EVERY shell`
      : nodeBin
        ? `- export PATH=${nodeBin}:$PATH in EVERY shell (node ${pin.major}, .nvmrc @ ${pin.at};\n` +
          `  verify better-sqlite3 loads)`
        : `- No node ${pin.major} found (.nvmrc @ ${pin.at}; checked the running process, then\n` +
          `  nvm under $NVM_DIR, ~/.nvm, and /opt/nvm) — install it with your version manager\n` +
          `  (e.g. nvm install ${pin.major}), then export PATH to its bin dir in EVERY shell`;

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
  const brief = `${opts.task ? `Task: ${opts.task}\n\n` : ""}\
## Setup

- Create the worktree before editing:
  git fetch origin main && BASE_SHA=$(git rev-parse FETCH_HEAD) && git worktree add ${STATE_DIR}/${opts.worktree} -b ${opts.branch} "$BASE_SHA" && echo "PINNED_BASE_SHA=$BASE_SHA"
- Keep PINNED_BASE_SHA in the handoff; reset or rewrite against the printed SHA.
- cp -al ${nm.path}/. ${STATE_DIR}/${opts.worktree}/node_modules${nm.verified ? "" : "\n  (better-sqlite3 was not found there; install dependencies before proceeding)"}
${nodeLine}
- Verify better-sqlite3 loads. Run npm ci in the worktree if dependencies are
  missing or incompatible. node_modules is a hardlink copy, never a symlink;
  recreate its writable cache locally. Never hardlink .next.
- export SCRATCH=${STATE_DIR}; use worktree-unique names for scratch files/logs.
- ${historyDepth()}.

## Task and scope

- Read AGENTS.md and applicable nested instructions, docs/change-policy.md,
  and only the matching guides in docs/development.md.
- Read each issue body and all comments; reconcile later owner decisions before
  implementing. Confirm the problem still exists on current main.
${issueLines}
- Implement the smallest complete fix. Reuse the existing owner; do not add
  speculative abstractions or duplicate tests. CSS edits do not automatically
  require new tests or changed assertions. Stop when the task and checks pass.
- Before editing outside the assigned scope, check current claims:
  node scripts/orchestration/dispatch-brief.mjs claims <path>
  CLEAR permits work; claimed or unreadable paths go to the orchestrator;
  STARTING requires a later check. Do not rely on an old roster.
- Report material scope growth before continuing. Push a checkpoint first.
- Use synthetic fixtures and low-entropy tokens. Never access production data.
${MIGRATION_LINES}

## Verification

- Follow docs/development.md for focused checks while developing. The assigned
  final local gates run from the worktree root:
  bash scripts/orchestration/run-gates-recorded.sh ${opts.branch}
- If the harness detaches it, collect with:
  bash scripts/orchestration/run-gates-recorded.sh ${opts.branch} --wait
  Read the exit code and output. Never wait on a process-name match or a PASS
  string: either can outlive a failed run. REPLAY means no gate ran: anything
  since is ungated.
- Use npm run typecheck, which generates Next types first.
- For UI changes, identify affected consumers and specs by markers, roles,
  routes, helper calls, and layout relationships. Do not rewrite assertions
  just to make the new implementation pass.
- E2E: read docs/internals/e2e-hygiene.md when editing specs and
  docs/orchestration/e2e-ci.md for CI/reproduction. Run authored/edited specs
  once locally with E2E_PORT=${portBase} and --retries=0. For shared mutable
  fixtures, run the whole file with --workers=1. Only the orchestrator runs
  full local suites; other affected specs run in candidate CI.
  ${opts.candidate ? "Push, and read candidate CI." : "Defer them until promotion; the landing candidate's CI runs them."}
- A passing rerun does not explain a failure. Diagnose the mechanism and compare
  with the base when necessary. Report failures and skips honestly.
- Capture a file's working contents before a diagnostic mutation and restore
  that copy afterwards, preserving uncommitted changes. Rebuild restored code
  before trusting the control; do not restore old mtimes.

## Delivery

${landingLines}
- Push durable checkpoints at least every 45 minutes or roughly 10 changed files,
  even before final gates. Keep acceptance-criterion artifacts in git.
- Immediately before candidate review, merge current main and run assigned
  gates. Only the landing candidate consumes final PR review and full CI.
- Follow docs/orchestration/environment.md for GitHub access. Read PR reviews,
  issue comments, and inline review comments when addressing feedback.
- Use named credentials ($GH_TOKEN, falling back to $GITHUB_TOKEN); do not search
  the environment for secrets. Use the host's supported permission/escalation
  flow when blocked and report unresolved failures promptly.
- Do not file issues, merge, or retire the dispatch. The orchestrator owns those
  actions. Keep unexpected findings in the handoff.
- Never use the shared git stash or kill processes by name. Stop only PIDs you
  captured yourself, including servers you started, before handing off.
- PR body: one closing keyword per issue per line; describe the final change and
  checks. Explain each new abstraction/test file and production/test line deltas.
${COMMIT_TRAILER_BRIEF}
${opts.candidate ? "- Open or refresh the PR READY (not draft) via REST, base main." : "- Do not open a PR while this branch is banked; promotion changes this instruction."}
- Return ${opts.candidate ? "PR number/URL" : "branch and exact head SHA"}, PINNED_BASE_SHA,
  per-issue outcome, actual gate results, remaining failures, and scope decisions.
  State unresolved owner questions separately. Do not run dispatch-brief.mjs done.
`;

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
 * drivable without a network.
 *
 * WHOSE CLAIM IS IT: the discriminator is the BRANCH, never the author — both
 * orchestrators post as one account. A claim naming the branch `new` is about to
 * create is this dispatch's own; any other branch is another lane. This reads
 * CLEAR wrongly only if someone claimed your exact branch name, which would make
 * it the same lane anyway.
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
    "issue-read.mjs without filtering its comments; drop the claimed issue " +
    `from --issues and dispatch the rest. Use ${ADOPT_CLAIM} ` +
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
 * Refusal when an OPEN PR already heads this branch and its body names another
 * session. Null otherwise, and null with nothing to compare against — those are
 * WARNINGS the caller prints, since this read happens on EVERY dispatch and a
 * failing check must not cost every lane its start (#4460).
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

/**
 * The session a commit message's `Claude-Session:` trailer names, or null.
 *
 * The trailer LINE AT COLUMN 0, never a session id in the prose: commits here
 * quote refusals and each other, and a quoted trailer (indented, as quotation is
 * written) is not one that session wrote. `--format=%B` prints raw, so a real
 * trailer is unindented. The FIRST trailer wins because the reader hands this the
 * branch's commits NEWEST FIRST, so a `git merge origin/main` commit, signing
 * nothing, falls through to the work under it rather than reading as unowned.
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
 * Refusal when the trailer on the branch's own work names another session. Null
 * when it names this one or there is no trailer — an unmarked commit is not
 * attributable, the answer `branchPrRefusal` gives an unmarked PR body.
 *
 * Call this only where the PR bodies did not attribute the branch, and do not
 * say WHY: no open PR, no session footer, and an unreadable PR list are three
 * different worlds, and a refusal naming an unestablished cause sends its reader
 * hunting a PR that may not exist. It points at the `[pr-owner]` line above.
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
    `(this one is ${self}). No PR body attributed ${branch} — the [pr-owner] ` +
    "line above says what was read — so the COMMIT TRAILER did (#5179). " +
    "Pushing onto it is two writers on one branch. The alternative that works: " +
    "REVIEW it and COMMENT the finding on its issue or PR, and let the owning " +
    "session push the fix. Or " +
    `dispatch onto a branch of your own, or pass ${ADOPT_CLAIM} if the two ` +
    "sessions have actually agreed."
  );
}

/**
 * The messages of the commits `branch` carries and origin/main does not, or a
 * stated reason there are none to read. Local ref, then remote-tracking ref,
 * then the remote itself: a branch banked from another clone has no ref here,
 * and "no ref for it" must not read as "it has no trailer".
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
 * They are thunks: the second runs only when the first did not answer, and that
 * laziness IS the ordering.
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
  // A threshold from a degenerate sample is a FALSE ALARM GENERATOR, worse than
  // no threshold: a backfill of five minute-long "completions" once branded
  // both live clusters STALL 23 minutes into hour-long work. Two guards, for the
  // two ways the sample degenerates — too FEW completions to be a distribution,
  // and completions too SHORT to be dispatches (a backfill, an aborted probe, a
  // `done` typo), which say nothing about how long a cluster takes.
  const MIN_COMPLETIONS_FOR_MEDIAN = 3;
  const MIN_REAL_DISPATCH_MS = 5 * 60_000;
  const allDurations = completedDurationsMs(rows).sort((a, b) => a - b);
  const durations = allDurations.filter((d) => d >= MIN_REAL_DISPATCH_MS);
  const median =
    durations.length >= MIN_COMPLETIONS_FOR_MEDIAN
      ? durations[Math.floor(durations.length / 2)]
      : null;
  const discarded = allDurations.length - durations.length;

  const threshold = median === null ? null : 3 * median;
  if (!active.length) {
    console.log(
      "No active dispatches. Read the Ladder's owner-recorded scope and terminal\n" +
        "condition; the ledger cannot supply either. Refill unmet bounded outcomes,\n" +
        "or eligible continuous in-scope work. Bounded means all outcomes accepted;\n" +
        "continuous exhaustion accounts for every in-scope remainder. If a hold or\n" +
        "unclear scope leaves no authorized work, report a blocked handoff."
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
      const e2eActive = active.filter((d) => d.e2e).length;
      console.log(
        `  ${active.length} lane(s) active (e2e ${e2eActive}/${E2E_LANE_CAP}, ` +
          `other ${active.length - e2eActive}) — UNDER-SATURATED. A full e2e lane\n` +
          "  is NOT a thin queue: the caps are separate axes (2 e2e, ~5 lanes, ~3\n" +
          "  unreviewed PRs). Inside the Ladder's recorded scope, PAIR small issues,\n" +
          "  source eligible self-filed P3s, or do standing work. Otherwise report\n" +
          "  bounded completion or the in-scope blockers; do not widen the cycle."
      );
    }
  }
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

// "Has anybody touched this tree lately?" — what the dirty check cannot ask.
// Ten minutes is longer than a gate run's quiet stretch and far shorter than the
// stall threshold, separating "mid-task and quiet" from "gone". Skips
// node_modules and .git: hard links, and a shared .git every other worktree
// commits into, would make every tree look busy.
/** Elapsed milliseconds as `4h00m`, shared by `list` and `claims`. */
const fmt = (ms) =>
  `${Math.floor(ms / 3_600_000)}h${String(Math.floor(ms / 60_000) % 60).padStart(2, "0")}m`;

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

/** Two repo-relative paths overlap when either contains the other. */
export const pathOverlaps = (a, b) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * Per-dispatch verdicts for one path. `changesFor` returns the paths a dispatch
 * is holding, or why it could not be asked. Starting and unreadable are distinct.
 * `wide` says why a path set is broader than the dispatch's own work, so a claim
 * from it is not reported as certain.
 * @param {string} target repo-relative path
 * @param {{ branch: string }[]} dispatches
 * @param {(d: { branch: string }) => { paths: string[], wide?: string | null } | { unknown: string } | { starting: string }} changesFor
 */
export function fileClaims(target, dispatches, changesFor) {
  return dispatches.map((d) => {
    const found = changesFor(d);
    if ("unknown" in found)
      return { branch: d.branch, verdict: "unknown", why: found.unknown };
    if ("starting" in found)
      return { branch: d.branch, verdict: "starting", why: found.starting };
    const hit = found.paths.find((p) => pathOverlaps(p, target));
    return {
      branch: d.branch,
      verdict: hit ? "claimed" : "clear",
      why: hit ?? null,
      // Only a CLAIM can be wrong for being wide: a wider set matching nothing
      // is a stronger clear.
      wide: hit ? (found.wide ?? null) : null,
    };
  });
}

/**
 * One answer for the caller, loudest first: a named claim outranks an unreadable
 * dispatch, which outranks one that has not built its worktree yet, which
 * outranks clear.
 */
export const claimsVerdict = (rows) =>
  ["claimed", "unknown", "starting"].find((v) =>
    rows.some((r) => r.verdict === v)
  ) ?? "clear";

/** Exit status per verdict — 2 stays the usage error every command here uses. */
const CLAIMS_EXIT = { claimed: 1, unknown: 3, starting: 4, clear: 0 };

// What a dispatch is HOLDING: everything in its worktree that is not in main —
// uncommitted, committed-unpushed, and pushed-but-unlanded alike. The narrower
// "uncommitted or unpushed" reading would call a lane's pushed branch clear, and
// a pushed branch collides at merge exactly like a dirty tree does.
function worktreeChanges(dir) {
  if (!fs.existsSync(dir))
    return { unknown: `worktree gone from disk (${dir})` };
  // Three reads that each return PLAIN PATHS. `git status --porcelain` would
  // answer the first two at once, and its two-column prefix is a trap: trimmed
  // output loses the leading space of an unstaged " M", so every fixed-width
  // slice is off by one on the first entry — a parse that drops the file asked about.
  // UNLANDED, without assuming a merge base: `origin/main...HEAD` needs one, and
  // a shallow clone past a branch's base has none, so every lane answered CANNOT
  // TELL in a fresh container (#5928). Naming the base is that same diff; without
  // one, two-dot is WIDER, carrying main's changes — the safe direction, since a
  // listed path costs a question and a dropped one costs a collision.
  const opts = { cwd: dir, allowFail: true };
  const base = git(["merge-base", MAIN_REF, "HEAD"], opts);
  const cmds = [
    ["diff", "--name-only", "-z", "HEAD"], // tracked, staged or not
    ["ls-files", "-z", "--others", "--exclude-standard"], // untracked
    ["diff", "--name-only", "-z", base ?? MAIN_REF, "HEAD"], // unlanded
  ];
  const out = cmds.map((c) => git(c, opts));
  // WHICH read failed: naming only the directory sent readers to inspect
  // perfectly healthy worktrees (#5928).
  const failed = cmds[out.findIndex((o) => o === null)];
  if (failed)
    return { unknown: `\`git ${failed.join(" ")}\` failed in ${dir}` };
  return {
    paths: out.flatMap((o) => o.split("\0").filter(Boolean)),
    wide: base
      ? null
      : "no merge base here, so this also carries what main changed; " +
        "`git fetch --deepen=200 origin main` narrows it",
  };
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
  // A DETACHED worktree gets the literal "HEAD", which matches no branch, so the
  // caller's own dispatch comes back as `unknown`. That is the ALARM direction,
  // and no lane runs detached, so it is left alone on purpose: dropping the
  // filter or matching on worktree path would trade an alarm nobody sees for a
  // CLEAR that is wrong — the one answer this command must never give.
  const self = git(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    allowFail: true,
  });
  const worktrees = worktreePathsByBranch(cwd);
  const others = activeDispatches(readLedger()).filter(
    (d) => d.branch !== self
  );
  const now = Date.now();
  const rows = fileClaims(target, others, (d) => {
    const dir = worktrees.get(d.branch);
    if (dir) return worktreeChanges(dir);
    const mins = Math.max(0, Math.round((now - Date.parse(d.at)) / 60_000));
    const on = d.issues?.length ? ` on #${d.issues.join(", #")}` : "";
    return now - Date.parse(d.at) < NO_TRACE_GRACE_MS
      ? {
          starting: `dispatched ${mins}m ago${on}; its worktree does not exist yet`,
        }
      : {
          unknown: `no worktree ${fmt(now - Date.parse(d.at))} after dispatch${on} — it may never have started`,
        };
  });
  const verdict = claimsVerdict(rows);

  const claimed = rows.filter((r) => r.verdict === "claimed");
  const unknown = rows.filter((r) => r.verdict === "unknown");
  const starting = rows.filter((r) => r.verdict === "starting");
  if (claimed.length) {
    console.log(`CLAIMED  ${target}`);
    for (const r of claimed)
      console.log(
        r.wide
          ? `  ${r.branch}  differs from origin/main at ${r.why} — ${r.wide}`
          : `  ${r.branch}  holds ${r.why} (not in main)`
      );
  }
  if (unknown.length) {
    console.log(
      `CANNOT TELL  ${target} — these dispatches could not be read, which is NOT clear:`
    );
    for (const r of unknown) console.log(`  ${r.branch}  ${r.why}`);
    console.log("  Ask the orchestrator before touching it.");
  }
  if (starting.length) {
    console.log(
      `STARTING  ${target} — these dispatches are still setting up, so they are NOT YET readable:`
    );
    for (const r of starting) console.log(`  ${r.branch}  ${r.why}`);
    // Deliberately NOT "ask the orchestrator": this one answers itself, and
    // sending it upward is what taught lanes to ignore the answer that matters.
    console.log(
      `  ASK AGAIN in a few minutes — a worktree appears within ${NO_TRACE_GRACE_MS / 60_000} minutes of dispatch` +
        " or this becomes CANNOT TELL on its own. Escalate then, not now."
    );
  }
  if (verdict === "clear") {
    console.log(
      `CLEAR  ${target} — ${rows.length} other active dispatch(es), all readable.`
    );
  }
  process.exit(CLAIMS_EXIT[verdict]);
}

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

/** Prefer the local tip: list does not fetch, and worktrees share local refs. */
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
mid-experiment. Wait for the agent's report, or pass --keep
to close the ledger entry and leave the tree alone.`
      );
      process.exit(1);
    }
  }

  {
    if (!keep) git("fetch --prune origin", { allowFail: true });
    const args = branchGitArgs(branch);
    const remoteAlive = git(args.remoteExists, { allowFail: true }) !== null;
    if (!retireVerdict({ remoteAlive, keep }).ok) {
      console.error(
        `REFUSED: origin/${branch} still exists after a prune, so its work has NOT
been merged — a squash-merge deletes the remote branch. Retiring now closes the
ledger entry and the roster row, which are the whole board: the PR would stop
being tracked while it is still open.
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
  const args = branchGitArgs(branch);
  if (git(args.localExists, { allowFail: true }) !== null) {
    if (git(args.deleteLocal, { allowFail: true }) !== null) {
      console.log(
        `deleted local branch ${branch} (remote gone — merged and tidied)`
      );
    }
  }
}

// Reprint a live dispatch's brief, writing nothing. The ledger stores a
// dispatch's PARAMETERS, not its text, and `new` prints the brief once; an
// orchestrator that lost it (restart, compaction, a cut-off tail) used to re-run
// `new`, which forked the ledger and the roster. `buildBrief` is a pure function
// of those parameters, so this prints the same bytes the agent was given.
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

if (isMain(process.argv, import.meta.url)) main(process.argv.slice(2));
