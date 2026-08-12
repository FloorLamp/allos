// Dispatch-brief generator + dispatch ledger (plain Node, no deps).
//
// The orchestration runbook's dispatch template was pasted into agent briefs
// BY HAND, with the volatile values — node 24 path, canonical node_modules,
// E2E port range, migration slot — filled in from memory. Every documented
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
//     [--slot] [--e2e] [--port-base N]
//   node scripts/orchestration/dispatch-brief.mjs list
//   node scripts/orchestration/dispatch-brief.mjs done <branch>
//
// `new` prints a complete brief block (stdout) and appends a ledger entry.
// `list` shows active dispatches with ages, flagging anything past 3x the
//   median completed-dispatch duration (the runbook's stall threshold).
// `done` closes a dispatch, freeing its port range and slot reservation.
//
// Ledger location: $ALLOS_DISPATCH_LEDGER, else $SCRATCH/allos-dispatch-ledger.jsonl,
// else /tmp/allos-dispatch-ledger.jsonl. The ledger is orchestration state,
// never checked in.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const ledgerPath =
  process.env.ALLOS_DISPATCH_LEDGER ??
  (process.env.SCRATCH
    ? path.join(process.env.SCRATCH, "allos-dispatch-ledger.jsonl")
    : "/tmp/allos-dispatch-ledger.jsonl");

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
const rosterPath = path.join(
  process.env.SCRATCH ?? "/home/user/scratch",
  ".roster"
);

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

// Highest migration id on origin/main — the slot map's ground truth. Reading
// the REF (not the working tree) means a stale checkout can't hand out a slot
// main already owns; `git fetch origin main` first is still on the caller.
function maxMigrationOnMain() {
  // -r is required: without it, a path-filtered ls-tree lists the DIRECTORY
  // entry itself and the parse below sees zero migrations.
  const listing =
    git("ls-tree -r --name-only origin/main -- lib/migrations/versions", {
      allowFail: true,
    }) ||
    fs.readdirSync(path.join(repoRoot, "lib/migrations/versions")).join("\n");
  let max = 0;
  for (const name of listing.split("\n")) {
    const m = /^(?:lib\/migrations\/versions\/)?(\d{3})-/.exec(name.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  if (max === 0) {
    throw new Error(
      "could not read any migration ids from origin/main — refusing to hand out a slot. " +
        "Run `git fetch origin main` and retry."
    );
  }
  return max;
}

// Best-effort: remote claude/* branches this ledger has no record of. Another
// Claude session's branch once claimed a slot this orchestrator's map recorded
// as free — the ledger is authoritative only over dispatches it recorded.
function unknownRemoteBranches(active) {
  const out = git("ls-remote --heads origin", { allowFail: true });
  if (out === null) return null;
  const known = new Set(active.map((d) => d.branch));
  return out
    .split("\n")
    .map((line) => line.split("\t")[1])
    .filter((ref) => ref?.startsWith("refs/heads/claude/"))
    .map((ref) => ref.slice("refs/heads/".length))
    .filter((branch) => !known.has(branch));
}

// Port ranges: 200 apart so each worktree has headroom for its worker count,
// skipping 6000-6099 (Next refuses X11-reserved ports — an agent lost a round
// discovering port 6000 won't boot).
function allocatePortBase(active) {
  const taken = new Set(active.map((d) => d.portBase).filter(Boolean));
  for (let base = 5400; base < 9000; base += 200) {
    if (base >= 6000 && base < 6100) continue;
    if (!taken.has(base)) return base;
  }
  throw new Error(
    "no free E2E port range — close finished dispatches with `done <branch>`"
  );
}

// --- brief -----------------------------------------------------------------

function slotLine({ reserve, active, maxOnMain }) {
  if (!reserve) {
    return (
      "- Migration slot: you have NONE — if you conclude you need one, STOP and report\n" +
      "  rather than taking a number."
    );
  }
  const reserved = active.map((d) => d.slot).filter(Boolean);
  const slot = Math.max(maxOnMain, ...reserved, 0) + 1;
  let line =
    `- Migration slot: your slot is ${String(slot).padStart(3, "0")}; ` +
    `${String(maxOnMain).padStart(3, "0")} and ${String(maxOnMain - 1).padStart(3, "0")} are already on main.`;
  if (slot > maxOnMain + 1) {
    const holders = active
      .filter((d) => d.slot)
      .map((d) => `${String(d.slot).padStart(3, "0")} (${d.branch})`);
    line +=
      `\n  In-flight reservations ahead of you: ${holders.join(", ")}. Your slot is\n` +
      "  UNHONORABLE until they merge — build on the reserved number below yours and\n" +
      "  renumber when its fate is known. A gap fails EVERY DB test file at import\n" +
      "  (assertContiguousIds), so a wall of red on unrelated tests means the slot\n" +
      "  below you has not landed, not that your migration is broken.";
  }
  return { line, slot };
}

function buildBrief(opts) {
  const node24 = discoverNode24();
  const nm = canonicalNodeModules();
  const maxOnMain = maxMigrationOnMain();
  const rows = readLedger();
  const active = activeDispatches(rows);
  const portBase = opts.portBase ?? allocatePortBase(active);
  const slotInfo = slotLine({ reserve: opts.slot, active, maxOnMain });
  const slot = typeof slotInfo === "object" ? slotInfo.slot : null;
  const slotText = typeof slotInfo === "object" ? slotInfo.line : slotInfo;

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
  push NOW, even mid-task and even if gates have not run.
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
${slotText}
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
- Every scratch file you write gets a branch-unique name (pr-body-${opts.branch.split("/").pop()}.md,
  never pr-body.md) — $SCRATCH is shared by every concurrent agent.
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
  something failed — never report a green you did not see), surprises`;

  return { brief, portBase, slot, active };
}

// --- commands ---------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    issues: [],
    slot: false,
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
    else if (a === "--slot") opts.slot = true;
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
        ' [--task "..."] [--slot] [--e2e] [--port-base N]'
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

  const { brief, portBase, slot } = buildBrief(opts);
  const entry = {
    at: new Date().toISOString(),
    status: "active",
    branch: opts.branch,
    worktree: opts.worktree,
    issues: opts.issues,
    task: opts.task,
    slot,
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
      (slot ? `, slot ${slot}` : ", no slot") +
      `. Close with: dispatch-brief.mjs done ${opts.branch}`
  );

  const unknown = unknownRemoteBranches(activeDispatches(readLedger()));
  if (unknown === null) {
    console.error(
      "[ledger] could not list remote branches — check ls-remote by hand before trusting a slot."
    );
  } else if (unknown.length) {
    console.error(
      `[ledger] CAUTION: ${unknown.length} remote claude/* branch(es) this ledger never dispatched — ` +
        `they may hold unannounced migration slots:\n  ${unknown.join("\n  ")}`
    );
  }
}

function cmdList() {
  const rows = readLedger();
  const active = activeDispatches(rows);
  const durations = completedDurationsMs(rows).sort((a, b) => a - b);
  const median = durations.length
    ? durations[Math.floor(durations.length / 2)]
    : null;
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
        `  ${d.branch}  age=${fmt(age)}  port=${d.portBase}${d.slot ? `  slot=${d.slot}` : ""}` +
          `${d.e2e ? "  [e2e]" : ""}${d.issues?.length ? `  issues=${d.issues.join(",")}` : ""}` +
          (stalled
            ? "  << past 3x median — STALL until proven otherwise (check worktree + transcript bytes)"
            : "")
      );
    }
  }
  if (median !== null) {
    console.log(
      `Completed: ${durations.length}, median ${fmt(median)} (stall threshold ${fmt(3 * median)}).`
    );
  } else {
    console.log(
      "No completed dispatches yet — stall threshold unavailable until one closes."
    );
  }
}

function cmdDone(argv) {
  const branch = argv[0];
  if (!branch) {
    console.error("usage: dispatch-brief.mjs done <branch>");
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
  appendLedger({ at: new Date().toISOString(), status: "done", branch });
  rosterClose(branch);
  console.log(
    `closed ${branch} — freed port base ${entry.portBase}` +
      (entry.slot ? ` and slot reservation ${entry.slot}` : "")
  );
}

const [cmd = "new", ...rest] = process.argv.slice(2);
if (cmd === "new") cmdNew(rest);
else if (cmd === "list") cmdList();
else if (cmd === "done") cmdDone(rest);
else {
  console.error(`unknown command: ${cmd} (expected new | list | done)`);
  process.exit(2);
}
