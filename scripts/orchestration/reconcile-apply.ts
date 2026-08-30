// Tracker reconciliation — the WRITING half (#865), deliberately the narrowest
// tool in the set.
//
//   npx tsx scripts/orchestration/reconcile-apply.ts plan.json           # dry run
//   npx tsx scripts/orchestration/reconcile-apply.ts plan.json --apply   # writes
//
// A plan file is `{ "<issue>": [ { kind, anchor, replacement, reason }, … ] }`,
// with each entry an `AnchoredPatch`. For every issue it re-reads the CURRENT
// body, runs the plan through `applyPatchPlan`, and reports each patch's
// outcome. A refused patch is printed and skipped; a refusal never stops the
// rest.
//
// WHY THIS EXISTS RATHER THAN A GENERAL ISSUE-EDIT TOOL. Every general tool
// that can set an issue's body can also set its state, and #865's first
// guardrail is that the routine never closes an issue. Granting the run a
// close-capable tool and instructing it not to close things is the same
// theatre as gating a Server Action in the UI only. So the run is granted THIS
// and not that: the request payload is constructed from exactly one field,
// `body`, and there is no branch anywhere in this file that can add a second.
// `lib/__tests__/reconcile-tracker.test.ts` asserts that as a source scan, and
// the skill's `allowed-tools` grants no close-capable alternative.
//
// The re-read before each patch is not politeness, it is the anchor contract: the
// evidence may be hours old, the tracker moves hourly, and a drifted anchor
// must refuse rather than land on whatever now occupies that text.
//
// THE CHECKOUT IS RE-READ FOR THE SAME REASON (#3619). A `symbol-refresh` claims
// a rename — `a` is now called `b` — and that is a claim about main, not about
// the body. It is checked here, at apply time, against the working tree this
// process is standing in, with the SAME `symbolExists` the scan half used. So a
// plan whose replacement was itself renamed (or mistyped) between the gather and
// the apply refuses rather than writing a name nobody can find.
import "../load-env";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { buildRepoIndex } from "./reconcile-repo-index";
import { applyPatchPlan, type AnchoredPatch } from "./reconcile-patch";
import { resolveRunConfig, symbolExists } from "./reconcile-tracker-core";
import { helpGuard } from "./usage.mjs";
helpGuard(process.argv, import.meta.url);

const config = resolveRunConfig(process.env, process.argv.slice(2));
const [planFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const APPLY = process.argv.includes("--apply");

if (!planFile) {
  console.error("usage: reconcile-apply.ts <plan.json> [--apply]");
  process.exit(2);
}
if (!config.token) {
  console.error("reconcile-apply: no GH_TOKEN/GITHUB_TOKEN. Refusing.");
  process.exit(2);
}

function curlJson(args: readonly string[]): unknown {
  return JSON.parse(
    execFileSync("curl", ["-sS", "--fail-with-body", ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
  );
}

function issueUrl(issue: string): string {
  return `https://api.github.com/repos/${config.repo}/issues/${issue}`;
}

function authHeaders(): string[] {
  return [
    "-H",
    `Authorization: Bearer ${config.token}`,
    "-H",
    "Accept: application/vnd.github+json",
  ];
}

/**
 * The current body, and whether the issue is still open.
 *
 * State is read in the SAME request as the body for the same reason the body is
 * re-read at all: the evidence is hours old and the tracker moves hourly. An
 * issue can close between the gather and the apply — #2622 merged three minutes
 * after one run's snapshot and closed two issues the plan still carried — and
 * editing a closed issue's body is a write nobody asked for, onto a record
 * somebody has already finished reading.
 */
function readIssue(issue: string): { body: string; open: boolean } {
  const one = curlJson(["-X", "GET", ...authHeaders(), issueUrl(issue)]) as {
    body: string | null;
    state?: string;
  };
  return { body: one.body ?? "", open: one.state !== "closed" };
}

/**
 * The one write. The payload is built here, from one field, and this is the
 * only `execFileSync` in the file that is not a GET.
 */
function writeBody(issue: string, body: string): void {
  curlJson([
    "-X",
    "PATCH",
    ...authHeaders(),
    "--data-binary",
    JSON.stringify({ body }),
    issueUrl(issue),
  ]);
}

const plan = JSON.parse(fs.readFileSync(planFile, "utf8")) as Record<
  string,
  AnchoredPatch[]
>;

// Built once and lazily read, so a plan with no symbol-refresh in it pays for a
// `git ls-files` and nothing more.
const index = buildRepoIndex(process.cwd());
const resolveSymbol = (symbol: string): boolean => symbolExists(index, symbol);

let applied = 0;
let refused = 0;
let skipped = 0;
for (const [issue, patches] of Object.entries(plan)) {
  const { body: before, open } = readIssue(issue);
  if (!open) {
    skipped += patches.length;
    console.log(
      `#${issue}: SKIPPED (closed since the evidence was gathered) — ${patches.length} patches`
    );
    continue;
  }
  const { body, entries } = applyPatchPlan(before, patches, { resolveSymbol });
  for (const entry of entries) {
    if (entry.outcome.ok) {
      applied++;
      console.log(`#${issue} ${entry.patch.kind}: ok — ${entry.patch.reason}`);
    } else {
      refused++;
      console.log(
        `#${issue} ${entry.patch.kind}: REFUSED (${entry.outcome.refusal}) — ${entry.outcome.detail}`
      );
    }
  }
  if (body === before) continue;
  if (APPLY) writeBody(issue, body);
  else
    console.log(`#${issue}: ${entries.length} patches, dry run (no --apply)`);
}
console.log(
  `\napplied ${applied} · refused ${refused}${skipped > 0 ? ` · skipped ${skipped} (closed)` : ""}`
);
