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
//   node scripts/orchestration/dispatch-brief.mjs done <branch> [--keep]
//   node scripts/orchestration/dispatch-brief.mjs resume <branch>
//   node scripts/orchestration/dispatch-brief.mjs adopt <branch> \
//     [--issues 123,456] [--task "one line"] [--e2e] [--port-base N]
//
// `new` prints a complete brief block (stdout) and appends a ledger entry.
// `list` shows active dispatches with ages, flagging anything past 3x the
//   median completed-dispatch duration (the runbook's stall threshold).
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
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

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
const rosterPath = path.join(STATE_DIR, ".roster");

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
- npm ci in the worktree if better-sqlite3 fails to load — the parent checkout drifts
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
${issueLines}
${MIGRATION_LINES}
- Immediately before opening the PR: git merge origin/main && npm run typecheck.
  A signature that widened while you worked is not a textual conflict.
- Gates: run bash scripts/orchestration/agent-gates.sh from the worktree root — it
  runs lint, typecheck, both test tiers, the e2e-hygiene scan when specs changed,
  phi-scan, and format LAST, in the mandated order. Report its output verbatim.
  Give that Bash call an explicit long timeout; if it cannot fit one tool call
  under contention, run the same gates individually in the same order.
- Run YOUR changed e2e specs at CI parity on your assigned port range:
  E2E_PORT=${portBase} ... --repeat-each=3 --retries=0. The variable is E2E_PORT, never PORT.
  Do NOT run the full suite — the orchestrator owns full-suite runs.
- Any e2e fixture whose feature groups by profile-LOCAL date/time MUST build instants
  via zonedWallTimeToUtc(getTimezone(profileId), day, "HH:MM") — never naive
  \`\${day}THH:MM\` strings — the seed pins a ROTATING per-run instance timezone
  (e2e/pinned-timezone.ts), so naive strings parse host-UTC (#1417)
- NO high-entropy random-looking string literals in tests/fixtures (synthetic tokens
  included) — use low-entropy words+digits values
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
  if (opts.e2e && active.filter((d) => d.e2e).length >= 2) {
    console.error(
      "REFUSED: two e2e-touching dispatches are already active (the runbook's cap). " +
        "Close one with `done <branch>` or drop --e2e if this work touches no spec."
    );
    process.exit(1);
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
      `. Close with: dispatch-brief.mjs done ${opts.branch}`
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

  if (!active.length) {
    console.log("No active dispatches.");
  } else {
    console.log(`Active dispatches (ledger: ${ledgerPath}):`);
    for (const d of active) {
      const age = Date.now() - Date.parse(d.at);
      const stalled = median !== null && age > 3 * median;
      console.log(
        `  ${d.branch}  age=${fmt(age)}  port=${d.portBase}` +
          `${d.e2e ? "  [e2e]" : ""}${d.issues?.length ? `  issues=${d.issues.join(",")}` : ""}` +
          (stalled
            ? "  << past 3x median — STALL until proven otherwise (check worktree + transcript bytes)"
            : "")
      );
    }
  }
  const note = discarded
    ? ` (${discarded} completion(s) under ${MIN_REAL_DISPATCH_MS / 60_000}m ignored as not-real-work)`
    : "";
  if (median !== null) {
    console.log(
      `Completed: ${durations.length}, median ${fmt(median)} (stall threshold ${fmt(3 * median)})${note}.`
    );
  } else {
    // Say WHY it is unavailable — "no completions yet" was reported even when
    // five existed and were all discarded, which reads as a broken ledger.
    console.log(
      `Stall threshold unavailable: ${durations.length} real completion(s), need ` +
        `${MIN_COMPLETIONS_FOR_MEDIAN}${note}. Ages above are informational only.`
    );
  }
}

// Locate a branch's worktree by asking git, not by guessing a path — two live
// clusters once built theirs OUTSIDE $SCRATCH and were invisible to every
// path-glob check. `git worktree list --porcelain` knows every worktree this
// repo has, wherever it is.
// "Has anybody touched this tree lately?" — the question the dirty check cannot
// ask. Ten minutes is chosen to be longer than a gate run's quiet stretch (a
// `next build` writes continuously; the pure tier does not) and far shorter than
// the stall threshold, so it separates "mid-task and quiet" from "gone".
//
// Walks the tree's own files, skipping node_modules and .git — those are hard
// links from the parent checkout and a shared .git is written by every OTHER
// worktree's commits, which would make every tree look permanently busy.
const RECENT_WRITE_MS = 10 * 60_000;

function worktreeIdleMs(dir) {
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

function worktreeForBranch(branch) {
  const out = git("worktree list --porcelain", { allowFail: true });
  if (!out) return null;
  let current = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && current) return current;
  }
  return null;
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
  // Prune BEFORE judging the local branch: the squash-merge deleted the remote
  // ref, and a stale remote-tracking ref would make "remote still exists" lie.
  git("fetch --prune origin", { allowFail: true });
  if (
    git(`show-ref --verify refs/heads/${branch}`, { allowFail: true }) !== null
  ) {
    const remoteGone =
      git(`show-ref --verify refs/remotes/origin/${branch}`, {
        allowFail: true,
      }) === null;
    if (remoteGone) {
      // -D, not -d: a squash-merged branch is never an ancestor of main, so -d
      // refuses even though the content landed. Remote-gone after prune IS the
      // merged-and-tidied shape (the #2621 rule).
      if (git(`branch -D ${branch}`, { allowFail: true }) !== null) {
        console.log(
          `deleted local branch ${branch} (remote gone — merged and tidied)`
        );
      }
    } else {
      console.log(
        `kept local branch ${branch} — its remote still exists (not merged?)`
      );
    }
  }
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
  if (path.resolve(wtPath) === repoRoot) {
    console.error(
      `${branch} is checked out in the MAIN CHECKOUT (${repoRoot}), where no agent works — nothing to adopt.`
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

const [cmd = "new", ...rest] = process.argv.slice(2);
try {
  if (cmd === "new") cmdNew(rest);
  else if (cmd === "list") cmdList();
  else if (cmd === "done") cmdDone(rest);
  else if (cmd === "resume") cmdResume(rest);
  else if (cmd === "adopt") cmdAdopt(rest);
  else {
    console.error(
      `unknown command: ${cmd} (expected new | list | done | resume | adopt)`
    );
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
