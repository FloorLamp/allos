// Tracker reconciliation — the WRITING half (#865), deliberately the narrowest
// tool in the set.
//
//   npx tsx scripts/orchestration/reconcile-apply.ts plan.json           # dry run
//   npx tsx scripts/orchestration/reconcile-apply.ts plan.json --apply   # writes
//   … --apply --notify 123,456    # 123/456 are IN FLIGHT: comment even if quiet
//   … --outcome out.json          # how many landed, for the run summary line
//   … --evidence ev.json          # also close the gather's stale P3s (#5671)
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
// and not that: the body PATCH (through `issue-body-write.ts`, which saves the
// current body first and builds its payload from one field, #5673), and a
// comment POST that announces a body edit to an issue with READERS (a
// non-empty comment chain, or an in-flight issue named via --notify), because
// a body PATCH is silent — no notification, no timeline event — and the
// thread's readers would keep working from the pre-edit text (2026-08-30).
// Neither payload has a field an issue's status could ride in.
//
// THE ONE CLOSE (#5671, owner ruling 2026-09-09: P3 is a 30-day queue, not a
// backlog). Given `--evidence`, the gather's `staleP3` findings are closed
// `not_planned` with one fixed comment. The close PATCH's payload is a literal
// (state closed, reason not planned) with no field a plan or an evidence file
// can steer, and the issue is re-read and re-judged with the core's own rule
// immediately before it. `lib/__tests__/reconcile-tracker.test.ts`
// asserts all of that as a source scan, and the skill's `allowed-tools` grants
// no other close-capable script.
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
import { writeIssueBody } from "./issue-body-write";
import { buildRepoIndex } from "./reconcile-repo-index";
import { applyPatchPlan, type AnchoredPatch } from "./reconcile-patch";
import {
  decideStaleP3,
  referencedByOpenPrs,
  resolveRunConfig,
  STALE_P3_CLOSE_COMMENT,
  symbolExists,
  type OpenPr,
  type ReconcileEvidence,
  type SweptIssue,
} from "./reconcile-tracker-core";
import { helpGuard } from "./usage.mjs";
import { laneIssues, readLedger } from "./ledger.mjs";
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
// --outcome <file>: this run's applied/refused/skipped counts as JSON. The run
// summary line (#865) needs "drift patched", and that number exists only here —
// the gather proposes candidates and cannot know which of them landed. Written
// rather than retyped from stdout, because a hand-copied count in a durable
// record is a count nobody can check.
let outcomeFile: string | null = null;
// --evidence <file>: the gather's evidence, for its `staleP3` findings.
let evidenceFile: string | null = null;
for (let i = 0; i < argvRest.length; i++) {
  const arg = argvRest[i];
  if (arg === "--notify") {
    for (const n of (argvRest[++i] ?? "").split(",")) {
      if (n.trim()) notify.add(n.trim());
    }
  } else if (arg === "--outcome") {
    outcomeFile = argvRest[++i] ?? null;
  } else if (arg === "--evidence") {
    evidenceFile = argvRest[++i] ?? null;
  } else if (!arg.startsWith("--")) {
    positional.push(arg);
  }
}
const [planFile] = positional;
const APPLY = process.argv.includes("--apply");

if (!planFile && !evidenceFile) {
  console.error(
    "usage: reconcile-apply.ts [<plan.json>] [--evidence ev.json] [--apply]"
  );
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
function readIssue(issue: string): { issue: SweptIssue; comments: number } {
  const one = curlJson(["-X", "GET", ...authHeaders(), issueUrl(issue)]) as {
    number: number;
    title: string;
    body: string | null;
    state?: string;
    comments?: number;
    labels: { name: string }[];
    created_at: string;
    assignees: { login: string }[];
  };
  return {
    issue: {
      number: one.number,
      title: one.title,
      body: one.body ?? "",
      state: one.state === "closed" ? "closed" : "open",
      labels: one.labels.map((l) => l.name),
      createdAt: one.created_at,
      assignees: one.assignees.map((a) => a.login),
    },
    comments: one.comments ?? 0,
  };
}

/**
 * Every open PR, or nothing — the same page-cap refusal the gatherer makes,
 * because a PR behind the cap could be the one holding a stale P3 open.
 */
const PAGE_CAP = 10;

function readOpenPrs(): OpenPr[] {
  const out: OpenPr[] = [];
  for (let page = 1; page <= PAGE_CAP; page++) {
    const batch = curlJson([
      "-X",
      "GET",
      ...authHeaders(),
      `https://api.github.com/repos/${config.repo}/pulls?state=open&per_page=100&page=${page}`,
    ]) as { number: number; title: string; body: string | null }[];
    for (const p of batch) {
      out.push({ number: p.number, title: p.title, body: p.body ?? "" });
    }
    if (batch.length < 100) return out;
  }
  console.error(
    "reconcile-apply: the open-PR fetch hit its page cap. A PR past it could " +
      "be the one holding a stale P3 open. Refusing."
  );
  process.exit(2);
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

/**
 * The close (#5671). A literal payload: no plan, evidence file or argument
 * reaches it, so the only state this file can ever set is `closed`, and the
 * only reason `not_planned`.
 */
function closeIssue(issue: string): void {
  curlJson([
    "-X",
    "PATCH",
    ...authHeaders(),
    "--data-binary",
    JSON.stringify({ state: "closed", state_reason: "not_planned" }),
    issueUrl(issue),
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

const plan = planFile
  ? (JSON.parse(fs.readFileSync(planFile, "utf8")) as Record<
      string,
      AnchoredPatch[]
    >)
  : {};

// Built once and lazily read, so a plan with no symbol-refresh in it pays for a
// `git ls-files` and nothing more.
const index = buildRepoIndex(process.cwd());
const resolveSymbol = (symbol: string): boolean => symbolExists(index, symbol);

let applied = 0;
let refused = 0;
let skipped = 0;
for (const [issue, patches] of Object.entries(plan)) {
  const { issue: current, comments } = readIssue(issue);
  const before = current.body;
  if (current.state !== "open") {
    skipped += patches.length;
    console.log(
      `#${issue}: SKIPPED (closed since the evidence was gathered) — ${patches.length} patches`
    );
    continue;
  }
  const { body, entries } = applyPatchPlan(before, patches, { resolveSymbol });
  for (const entry of entries) {
    if (entry.outcome.ok) {
      if (APPLY) applied++;
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
    writeIssueBody({ repo: config.repo, token: config.token, issue, body });
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
// The stale-P3 close. The gather decided from its snapshot; the tracker has
// moved since, so each issue is re-read and the SAME rule re-run over the fresh
// labels, assignees and state, today's ledger and today's open PRs. A refusal
// here is the rule saying the issue no longer qualifies, and it stays open.
let closed = 0;
let kept = 0;
if (evidenceFile) {
  const evidence = JSON.parse(
    fs.readFileSync(evidenceFile, "utf8")
  ) as ReconcileEvidence;
  const ctx = {
    claimedIssues: new Set(laneIssues(readLedger()).keys()),
    openPrIssues: referencedByOpenPrs(
      evidence.staleP3.length > 0 ? readOpenPrs() : []
    ),
    now: new Date().toISOString(),
  };
  for (const found of evidence.staleP3) {
    const issue = String(found.issue);
    const fresh = decideStaleP3(readIssue(issue).issue, ctx);
    if (fresh === null) {
      kept++;
      console.log(
        `#${issue} stale-p3: REFUSED (no longer qualifies) — kept open`
      );
      continue;
    }
    closed++;
    if (APPLY) {
      writeComment(issue, STALE_P3_CLOSE_COMMENT);
      closeIssue(issue);
    }
    console.log(
      `#${issue} stale-p3: ${APPLY ? "closed" : "would close"} not_planned — ${fresh.detail}`
    );
  }
}
console.log(
  `\napplied ${applied} · refused ${refused}${skipped > 0 ? ` · skipped ${skipped} (closed)` : ""}` +
    (evidenceFile
      ? ` · stale P3 ${APPLY ? "closed" : "would close"} ${closed}, kept ${kept}`
      : "")
);
if (outcomeFile) {
  // `applied` is 0 on a dry run and says so, so a summary built from a dry-run
  // outcome counts every candidate as still-unapplied rather than as patched.
  fs.writeFileSync(
    outcomeFile,
    JSON.stringify({ applied, refused, skipped, wrote: APPLY }, null, 2) + "\n"
  );
}
