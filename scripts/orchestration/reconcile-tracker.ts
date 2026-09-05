// Tracker reconciliation — the ENTRYPOINT (#865). Read-only, always.
//
//   npx tsx scripts/orchestration/reconcile-tracker.ts            # report to stdout
//   npx tsx scripts/orchestration/reconcile-tracker.ts --json ev.json --out report.md
//   npx tsx scripts/orchestration/reconcile-tracker.ts --issue 2603,2589
//
// Everything impure lives here and nowhere else: the GitHub reads, the git
// file list, the clock. The decisions are in `reconcile-tracker-core.ts`,
// which takes both worlds as plain data. The watermark lives in the tracker
// itself — the body of the issue titled `WATERMARK_ISSUE_TITLE` — because
// container state dies with the container and a lost watermark silently
// reshapes the window. This run only READS it; `reconcile-watermark.ts`
// (a confined writer) advances it after the report has been read.
//
// THIS PROCESS CANNOT WRITE TO GITHUB. Not "does not" — cannot: the only HTTP
// helper it has issues GET, and there is no code path that sets an issue's
// state, labels, or body. That is asserted by a source scan in
// `lib/__tests__/reconcile-tracker.test.ts`, because "the prompt says not to"
// is the same theatre as a UI-only gate over a Server Action.
//
// curl, not `fetch`: node's fetch ignores HTTPS_PROXY and 401s through the
// agent proxy where the identical token succeeds via curl (the same finding
// `scripts/orchestration/ci-watch.mjs` records).
import "../load-env";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { buildRepoIndex } from "./reconcile-repo-index";
import {
  extractWatermark,
  gatherEvidence,
  renderReport,
  resolveRunConfig,
  type ReconcileWatermark,
  type RunConfig,
  type TrackerIssue,
  type TrackerPr,
} from "./reconcile-tracker-core";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
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
interface GhPr {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
}

/** The ONLY network primitive in this file, and it is a GET. */
function ghGet(config: RunConfig, url: string): unknown {
  const args = ["-sS", "--fail-with-body", "-X", "GET"];
  if (config.token) args.push("-H", `Authorization: Bearer ${config.token}`);
  args.push("-H", "Accept: application/vnd.github+json", url);
  const out = execFileSync("curl", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

const PAGE_CAP = 10;

/**
 * Pages a collection, and says whether it stopped because the collection ran
 * out or because it hit `PAGE_CAP`. The second answer used to be thrown away,
 * and a thrown-away truncation is the worst shape a denominator can take: the
 * report printed `merged PRs examined: 969` — a number high enough to read as
 * proof the run resolved things — when the fetch had clipped 1000 of this
 * repo's 2544 closed PRs and the rest were never looked at.
 */
function ghGetAll(
  config: RunConfig,
  pathAndQuery: string
): { items: unknown[]; truncated: boolean } {
  const out: unknown[] = [];
  for (let page = 1; page <= PAGE_CAP; page++) {
    const sep = pathAndQuery.includes("?") ? "&" : "?";
    const url = `https://api.github.com/repos/${config.repo}${pathAndQuery}${sep}per_page=100&page=${page}`;
    const batch = ghGet(config, url);
    if (!Array.isArray(batch) || batch.length === 0)
      return { items: out, truncated: false };
    out.push(...batch);
    if (batch.length < 100) return { items: out, truncated: false };
  }
  // Every page came back full, so page PAGE_CAP + 1 would have had rows too.
  return { items: out, truncated: true };
}

function main(): void {
  const config = resolveRunConfig(process.env, process.argv.slice(2));
  if (config.stamp) {
    // Refused loudly rather than ignored: a silently dropped --stamp would
    // leave its caller believing the window advanced.
    console.error(
      "reconcile-tracker: --stamp has moved. The watermark lives in the\n" +
        "tracker (the issue titled per WATERMARK_ISSUE_TITLE) and only the\n" +
        "confined writer advances it, after the report has been read:\n" +
        "  npx tsx scripts/orchestration/reconcile-watermark.ts stamp \\\n" +
        "    --evidence <evidence.json> --apply"
    );
    process.exit(2);
  }
  if (!config.token) {
    // Read-only fallback for hosts that authenticate through gh instead of
    // exporting a variable (#3710): `gh auth token` via host.mjs. This adds
    // no write capability — the token feeds the same GET-only curl helper,
    // and the write tools still require the variables by name.
    config.token = resolveReadToken(process.env);
  }
  if (!config.token) {
    // An unauthenticated read is rate-limited into partial pages, and a partial
    // page is a report that finds nothing for the wrong reason — exactly the
    // deceptive success the core's header names. Refuse instead.
    console.error(
      "reconcile-tracker: no GH_TOKEN/GITHUB_TOKEN and no authenticated gh " +
        "(`gh auth token`). An unauthenticated sweep would silently truncate " +
        "and report a clean tracker. Refusing."
    );
    process.exit(2);
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const issuePages = ghGetAll(config, "/issues?state=open");
  if (issuePages.truncated) {
    // Same refusal as the missing token above, for the same reason: a swept
    // subset that reads as the whole tracker is a clean report earned by not
    // looking. The PR half survives truncation because the report SAYS it was
    // truncated; the issue half has no such line, so it refuses instead.
    console.error(
      "reconcile-tracker: the open-issue fetch hit its page cap. Every issue " +
        "past it would be silently unswept. Refusing."
    );
    process.exit(2);
  }
  const rawIssues = issuePages.items as GhIssue[];
  const openIssues = rawIssues.filter((i) => !i.pull_request);
  const wanted = new Set(config.only);
  const allIssues: TrackerIssue[] = openIssues.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    state: "open" as const,
    labels: i.labels.map((l) => l.name),
  }));

  // The carrier issue is machine state, never a sweep subject; its stamp is
  // the window's lower bound unless --since overrides it.
  const { carrier, issues: sweepable } = extractWatermark(allIssues);
  const previous = config.since ?? carrier.lastRunAt;
  const watermark: ReconcileWatermark = { previous, current: now };
  const issues = sweepable.filter(
    (i) => wanted.size === 0 || wanted.has(i.number)
  );

  const prPages = ghGetAll(
    config,
    "/pulls?state=closed&sort=updated&direction=desc"
  );
  const mergedPrs: TrackerPr[] = (prPages.items as GhPr[])
    .filter((p) => p.merged_at !== null)
    .filter((p) => (previous ? p.merged_at! > previous : true))
    .map((p) => ({
      number: p.number,
      title: p.title,
      body: p.body ?? "",
      mergedAt: p.merged_at!,
    }));

  // Resolve every cross-referenced number, including the closed ones that are
  // by definition absent from the open list — a dependency that still reads as
  // future almost always points at something that already merged.
  const states = new Map<number, "open" | "closed">(
    openIssues.map((i) => [i.number, "open" as const])
  );
  const referenced = new Set<number>();
  for (const issue of issues) {
    for (const m of issue.body.matchAll(/#(\d+)/g))
      referenced.add(Number(m[1]));
  }
  for (const number of referenced) {
    if (states.has(number)) continue;
    try {
      const one = ghGet(
        config,
        `https://api.github.com/repos/${config.repo}/issues/${number}`
      ) as GhIssue;
      states.set(number, one.state === "closed" ? "closed" : "open");
    } catch {
      // Unknown stays unknown — the core reports it as unverifiable rather
      // than guessing a state.
    }
  }

  const evidence = gatherEvidence(
    { issues, mergedPrs, issueStates: states, prsTruncated: prPages.truncated },
    buildRepoIndex(process.cwd()),
    watermark
  );

  const report = renderReport(evidence);
  if (config.out) fs.writeFileSync(config.out, report);
  else process.stdout.write(report);
  if (config.json) {
    fs.writeFileSync(config.json, JSON.stringify(evidence, null, 2) + "\n");
  }
}

main();
