// Tracker reconciliation — the WRITING half (#865), deliberately the narrowest
// tool in the set.
//
//   npx tsx scripts/orchestration/reconcile-apply.ts plan.json           # dry run
//   npx tsx scripts/orchestration/reconcile-apply.ts plan.json --apply   # writes
//   … --apply --notify 123,456    # 123/456 are IN FLIGHT: comment even if quiet
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
// and not that: exactly two writes exist, each with a payload constructed from
// one field — the body PATCH, and a comment POST that announces a body edit to
// an issue with READERS (a non-empty comment chain, or an in-flight issue
// named via --notify), because a body PATCH is silent — no notification, no
// timeline event — and the thread's readers would keep working from the
// pre-edit text (2026-08-30). Neither endpoint has a field an issue's status
// could ride in. `lib/__tests__/reconcile-tracker.test.ts` asserts all of that
// as a source scan, and the skill's `allowed-tools` grants no close-capable
// alternative.
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
// --notify 123,456: issues whose body edits get a comment even with an empty
// comment chain — the orchestrator passes its roster's IN-FLIGHT issues here,
// because a lane that already read the body works from the pre-edit text and
// only a comment reaches it (briefs require re-reading comments; a body PATCH
// is silent — no notification, no timeline event).
const argvRest = process.argv.slice(2);
const notify = new Set<string>();
const positional: string[] = [];
for (let i = 0; i < argvRest.length; i++) {
  const arg = argvRest[i];
  if (arg === "--notify") {
    for (const n of (argvRest[++i] ?? "").split(",")) {
      if (n.trim()) notify.add(n.trim());
    }
  } else if (!arg.startsWith("--")) {
    positional.push(arg);
  }
}
const [planFile] = positional;
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
function readIssue(issue: string): {
  body: string;
  open: boolean;
  comments: number;
} {
  const one = curlJson(["-X", "GET", ...authHeaders(), issueUrl(issue)]) as {
    body: string | null;
    state?: string;
    comments?: number;
  };
  return {
    body: one.body ?? "",
    open: one.state !== "closed",
    comments: one.comments ?? 0,
  };
}

/**
 * The body write. The payload is built here, from one field; the only other
 * non-GET in the file is the comment POST below, equally confined.
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

/**
 * The visibility write. A body PATCH is SILENT — no notification, no timeline
 * event — so an issue with readers (a comment chain, or an in-flight lane
 * named via --notify) also gets a comment saying what changed; without it the
 * thread's readers keep working from the pre-edit text. The comments endpoint
 * takes one field and has nowhere for an issue's status to ride, so this stays
 * inside the routine's no-close guarantee.
 */
function writeComment(issue: string, note: string): void {
  curlJson([
    "-X",
    "POST",
    ...authHeaders(),
    "--data-binary",
    JSON.stringify({ body: note }),
    `${issueUrl(issue)}/comments`,
  ]);
}

function reconciliationNote(
  entries: ReadonlyArray<{ patch: AnchoredPatch; outcome: { ok: boolean } }>
): string {
  const lines = entries
    .filter((e) => e.outcome.ok)
    .map(
      (e) =>
        `- ${e.patch.kind}: ${e.patch.anchor} → ${e.patch.replacement}` +
        (e.patch.reason ? ` (${e.patch.reason})` : "")
    );
  return [
    "Tracker reconciliation edited this issue's body just now:",
    "",
    ...lines,
    "",
    "The body above is current; earlier comments and any in-flight brief may " +
      "quote the pre-edit text.",
    "",
    "---",
    "_Generated by [Claude Code](https://claude.ai/code)_",
  ].join("\n");
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
  const { body: before, open, comments } = readIssue(issue);
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
  const hasReaders = comments > 0 || notify.has(issue);
  if (APPLY) {
    writeBody(issue, body);
    if (hasReaders) {
      writeComment(issue, reconciliationNote(entries));
      console.log(
        `#${issue}: commented (${notify.has(issue) ? "in flight" : `${comments} earlier comments`}) — the body edit alone would be silent`
      );
    }
  } else {
    console.log(
      `#${issue}: ${entries.length} patches, dry run (no --apply)` +
        (hasReaders ? " — would also comment: this thread has readers" : "")
    );
  }
}
console.log(
  `\napplied ${applied} · refused ${refused}${skipped > 0 ? ` · skipped ${skipped} (closed)` : ""}`
);
