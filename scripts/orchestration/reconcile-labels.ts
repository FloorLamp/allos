// Tracker reconciliation — the LABEL half (#865), one of the toolchain's
// confined writers (the full roster is pinned in reconcile-tracker.test.ts).
//
//   npx tsx scripts/orchestration/reconcile-labels.ts             # dry run + the domain worksheet
//   npx tsx scripts/orchestration/reconcile-labels.ts --apply      # writes
//   npx tsx scripts/orchestration/reconcile-labels.ts --plan p.json [--apply]
//
// THREE OPS, AND THE LINE BETWEEN THEM IS WHO DECIDED.
//
//   1. REMOVE a retired label (`RETIRED_LABELS`). A fact about the taxonomy —
//      the label no longer exists, so it routes nothing. Automatic.
//   2. RESET a priority slot to the priority the issue's OWN BODY states
//      ("Priority dropped P2 → P3"). Also a fact: the owner already ruled in
//      prose and the label did not follow. Automatic, and it refuses the moment
//      prose and labels genuinely contest each other (`parked`, two slots).
//   3. ADD a domain label — from a PLAN FILE, never inferred here. `scoreDomains`
//      ranks what an issue's citations point at, this script prints that
//      worksheet, and the agent half reads it and writes the plan. That is the
//      same division as the rest of the routine: the deterministic half gathers
//      evidence, the judging half judges, and an issue whose evidence is split
//      goes to the human instead.
//
// An add may only FILL a gap — an issue with no domain label at all. It can
// never re-classify an issue that already has one, because that is an argument
// about where work belongs and this routine does not have those.
//
// WHY THIS IS STILL NOT A CLOSE-CAPABLE TOOL. Every write goes through GitHub's
// per-issue LABELS endpoints: DELETE /issues/{n}/labels/{name} takes no body at
// all, and POST /issues/{n}/labels takes a payload built from exactly one
// field, `labels`. Neither has a field an issue's `state` could ride in. That is
// the same structural guarantee as `reconcile-apply.ts`'s one-field payload,
// and `lib/__tests__/reconcile-tracker.test.ts` asserts both as a source scan.
//
// The issue is RE-READ immediately before each write, for the reason the
// applier re-reads bodies: the evidence may be hours old, the tracker moves
// hourly, and a label already fixed by hand must refuse rather than have this
// run write over somebody's newer decision.
//
// curl, not `fetch`: node's fetch ignores HTTPS_PROXY and 401s through the
// agent proxy where the identical token succeeds via curl (the same finding
// `scripts/orchestration/ci-watch.mjs` records).
import "../load-env";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  DOMAIN_LABELS,
  decideDomainAdd,
  decideLabelRemoval,
  decidePriorityLabel,
  planLabelRemovals,
  resolveRunConfig,
  scoreDomains,
  type LabelRemoval,
  type RepoIndex,
  type TrackerIssue,
} from "./reconcile-tracker-core";
import { helpGuard } from "./usage.mjs";
helpGuard(process.argv, import.meta.url);

interface GhLabel {
  name: string;
}
interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: GhLabel[];
  pull_request?: unknown;
}

/** One agent-decided domain assignment, read from the plan file. */
interface DomainAdd {
  label: string;
  reason: string;
}

const config = resolveRunConfig(process.env, process.argv.slice(2));
const APPLY = process.argv.includes("--apply");
const planAt = process.argv.indexOf("--plan");
const PLAN_FILE = planAt === -1 ? null : (process.argv[planAt + 1] ?? null);

if (!config.token) {
  console.error("reconcile-labels: no GH_TOKEN/GITHUB_TOKEN. Refusing.");
  process.exit(2);
}

function authHeaders(): string[] {
  return [
    "-H",
    `Authorization: Bearer ${config.token}`,
    "-H",
    "Accept: application/vnd.github+json",
  ];
}

function curlJson(args: readonly string[]): unknown {
  return JSON.parse(
    execFileSync("curl", ["-sS", "--fail-with-body", ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
  );
}

function issueUrl(issue: number): string {
  return `https://api.github.com/repos/${config.repo}/issues/${issue}`;
}

function toTrackerIssue(raw: GhIssue): TrackerIssue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    labels: raw.labels.map((l) => l.name),
  };
}

function readIssue(issue: number): TrackerIssue {
  return toTrackerIssue(
    curlJson(["-X", "GET", ...authHeaders(), issueUrl(issue)]) as GhIssue
  );
}

function readOpenIssues(): TrackerIssue[] {
  const out: GhIssue[] = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/repos/${config.repo}/issues?state=open&per_page=100&page=${page}`;
    const batch = curlJson(["-X", "GET", ...authHeaders(), url]);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...(batch as GhIssue[]));
    if (batch.length < 100) break;
  }
  return out.filter((i) => !i.pull_request).map(toTrackerIssue);
}

/** The repository as data, for the domain worksheet's citation resolution. */
function buildRepoIndex(root: string): RepoIndex {
  const files = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { commit, files, read: () => null };
}

/** Removal. Names the label in the PATH and sends no body whatsoever. */
function removeLabel(issue: number, label: string): void {
  execFileSync(
    "curl",
    [
      "-sS",
      "--fail-with-body",
      "-X",
      "DELETE",
      ...authHeaders(),
      `${issueUrl(issue)}/labels/${encodeURIComponent(label)}`,
    ],
    { encoding: "utf8" }
  );
}

/** Addition. The payload is built here, from one field, and only this one. */
function addLabels(issue: number, labels: readonly string[]): void {
  curlJson([
    "-X",
    "POST",
    ...authHeaders(),
    "--data-binary",
    JSON.stringify({ labels }),
    `${issueUrl(issue)}/labels`,
  ]);
}

const wanted = new Set(config.only);
const snapshot = readOpenIssues().filter(
  (i) => wanted.size === 0 || wanted.has(i.number)
);

let wrote = 0;
let refused = 0;
const ok = (line: string): void => {
  wrote++;
  console.log(line);
};
const no = (line: string): void => {
  refused++;
  console.log(line);
};

// ── 1. Retired labels ───────────────────────────────────────────────────────
for (const removal of planLabelRemovals(snapshot) as LabelRemoval[]) {
  const current = readIssue(removal.issue);
  const decision = decideLabelRemoval(current, removal.label);
  if (!decision.ok) {
    no(
      `#${removal.issue} −${removal.label}: REFUSED (${decision.refusal}) — ${decision.detail}`
    );
    continue;
  }
  if (APPLY) removeLabel(removal.issue, removal.label);
  ok(`#${removal.issue} −${removal.label}: ok — ${removal.reason}`);
}

// ── 2. Priority slots the body itself already ruled on ──────────────────────
for (const issue of snapshot) {
  const decision = decidePriorityLabel(issue);
  if (!decision.ok) continue;
  const current = readIssue(issue.number);
  const fresh = decidePriorityLabel(current);
  if (!fresh.ok) {
    no(`#${issue.number} priority: REFUSED (${fresh.refusal})`);
    continue;
  }
  if (APPLY) {
    if (fresh.from !== null) removeLabel(issue.number, fresh.from);
    addLabels(issue.number, [fresh.to]);
  }
  ok(
    `#${issue.number} priority: ok — body states ${fresh.to}, label ${
      fresh.from === null ? "was absent" : `read ${fresh.from}`
    }`
  );
}

// ── 3. Domain labels, from the agent's plan only ────────────────────────────
if (PLAN_FILE !== null) {
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8")) as Record<
    string,
    DomainAdd[]
  >;
  for (const [key, adds] of Object.entries(plan)) {
    const number = Number(key);
    // What THIS RUN has already decided to give this issue. A plan file may list
    // two domains for one issue, and both the re-read below (under --apply) and
    // this list (under a dry run) have to see the first one before judging the
    // second — otherwise the second passes the gap check the first just closed
    // and the issue ends up double-classified with nothing logged (#3122).
    const addedHere: string[] = [];
    for (const add of adds) {
      // RE-READ IMMEDIATELY BEFORE EACH WRITE, which is what the retired-label
      // and priority paths in this file already do and what its header promises.
      // The evidence may be hours old, the tracker moves hourly, and a label
      // fixed by hand between two writes of the same run must refuse rather than
      // be written over.
      const current = readIssue(number);
      const decision = decideDomainAdd(current, add.label, addedHere);
      if (!decision.ok) {
        no(
          `#${number} +${add.label}: REFUSED (${decision.refusal}) — ${decision.detail}`
        );
        continue;
      }
      if (APPLY) addLabels(number, [add.label]);
      addedHere.push(add.label);
      ok(`#${number} +${add.label}: ok — ${add.reason}`);
    }
  }
}

// ── The worksheet: what still needs a human, and the evidence for it ─────────
const index = buildRepoIndex(process.cwd());
const stranded = snapshot.filter(
  (i) => !i.labels.some((l) => (DOMAIN_LABELS as readonly string[]).includes(l))
);
if (stranded.length > 0) {
  console.log(`\n── no domain label (${stranded.length}) ──`);
  for (const issue of stranded) {
    const scores = scoreDomains(issue, index);
    const top = scores
      .slice(0, 3)
      .map((s) => `${s.domain}×${s.hits}`)
      .join(", ");
    console.log(
      `#${issue.number} — citations point at: ${top || "nothing tracked"}`
    );
  }
  console.log(
    "Judge these from the evidence; plan the clear ones, ask about the split ones."
  );
}

console.log(
  `\n${APPLY ? "wrote" : "would write"} ${wrote} · refused ${refused}` +
    (APPLY ? "" : " (dry run, no --apply)")
);
