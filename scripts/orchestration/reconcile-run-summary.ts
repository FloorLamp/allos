// Reconcile run summary — the confined writer that records THAT A RUN HAPPENED
// (#865, ruling 2026-09-05 11:50 UTC).
//
//   npx tsx scripts/orchestration/reconcile-run-summary.ts \
//     --evidence /tmp/reconcile-evidence.json                    # dry run: print
//   … --outcome /tmp/reconcile-apply.json                        # + patches landed
//   … --apply                                                    # post the comment
//
// WHY IT EXISTS. The cron for this routine stays unwired until "the report has
// been boring three runs running", and until now nothing anywhere recorded that
// a run happened at all: no report is committed, and with no watermark stamped
// there is no history either. The condition was therefore unblockable by
// construction. One line per run, appended to #865, is the durable home; three
// consecutive boring ones are what the lane that eventually wires the cron
// cites. The line itself is rendered by `renderRunSummaryLine` in the core, so
// the counts come from the same `ReconcileEvidence` the report was rendered
// from and cannot drift from it.
//
// Confinement (pinned by a source scan in lib/__tests__/reconcile-tracker.test.ts):
// ONE write verb, a POST whose payload is built from exactly one field
// (`body`), aimed at a URL built from the pinned constant `RUN_SUMMARY_ISSUE`.
// There is no other issue this process can reach and no field an issue's state,
// labels or title could ride in — the same structural guarantee the watermark
// writer and the body applier hold, for the same reason: "the prompt says not
// to" is the theatre this routine's first guardrail exists to avoid.
//
// GATING. Dry run by DEFAULT; `--apply` is the only path that writes, and it
// takes the write credential by name (GH_TOKEN/GITHUB_TOKEN) — the `gh auth`
// fallback is a READ credential (environment.md §GitHub access). With no token
// at all the process prints the line and posts nothing.
//
// NEVER TWICE FOR ONE RUN. Before posting it pages #865's comments and refuses
// if one already opens with this run's own stamp. A run is identified by the
// GATHER's timestamp (`watermark.current`), which is fixed at gather time and
// carried in the evidence file, so re-running this script on the same evidence
// is idempotent however many times it happens.
//
// curl, not `fetch`, for the reason `reconcile-tracker.ts` records.
//
// Exit codes: 0 posted (or dry run printed) · 1 refused (already posted, bad
// evidence) · 2 cannot run (no token, API trouble).

import "../load-env";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  DEFAULT_REPO,
  RUN_SUMMARY_ISSUE,
  RUN_SUMMARY_MARKER,
  renderRunSummaryLine,
  runSummaryComment,
  summarizeRun,
  type ReconcileEvidence,
} from "./reconcile-tracker-core";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
helpGuard(process.argv, import.meta.url);

const repo = process.env.RECONCILE_REPO || DEFAULT_REPO;
/** The ONLY issue URL in this file, and it is built from the pinned constant. */
const COMMENTS_URL = `https://api.github.com/repos/${repo}/issues/${RUN_SUMMARY_ISSUE}/comments`;

function curl(args: readonly string[]): { status: number; body: string } {
  const out = execFileSync("curl", ["-sS", "-w", "\n%{http_code}", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const cut = out.lastIndexOf("\n");
  return { status: Number(out.slice(cut + 1)), body: out.slice(0, cut) };
}

function authHeaders(token: string): string[] {
  return [
    "-H",
    `Authorization: Bearer ${token}`,
    "-H",
    "Accept: application/vnd.github+json",
  ];
}

interface GhComment {
  id: number;
  body: string | null;
}

/** Every comment on the one issue. Paged, and a page cap it cannot silently pass. */
function readComments(token: string): GhComment[] {
  const out: GhComment[] = [];
  for (let page = 1; page <= 20; page++) {
    const { status, body } = curl([
      ...authHeaders(token),
      `${COMMENTS_URL}?per_page=100&page=${page}`,
    ]);
    if (status < 200 || status >= 300) {
      console.error(`GET ${COMMENTS_URL} page ${page} -> ${status}`);
      process.exit(2);
    }
    const batch = JSON.parse(body) as GhComment[];
    if (!Array.isArray(batch) || batch.length === 0) return out;
    out.push(...batch);
    if (batch.length < 100) return out;
  }
  // A duplicate check that quietly stopped short would let a second line land.
  console.error(
    `reconcile-run-summary: #${RUN_SUMMARY_ISSUE} has more comments than this ` +
      "reader pages. A duplicate could be behind the cap. Refusing."
  );
  process.exit(2);
}

/**
 * Has THIS run already been recorded? Keyed on the gather's own stamp, which is
 * fixed at gather time — not on the rendered line, which would let a rerun with
 * a different `--outcome` post a second line for one run.
 */
function alreadyPosted(comments: readonly GhComment[], ranAt: string): boolean {
  const opener = `${RUN_SUMMARY_MARKER} ${ranAt}`;
  return comments.some((c) => (c.body ?? "").includes(opener));
}

function flagValue(args: readonly string[], flag: string): string | null {
  const at = args.indexOf(flag);
  return at === -1 ? null : (args[at + 1] ?? null);
}

function readJson(file: string, what: string): unknown {
  if (!fs.existsSync(file)) {
    console.error(`${what} needs a readable file (got ${file})`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    console.error(`${what} is not readable JSON: ${file}`);
    process.exit(1);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  const evidenceFile = flagValue(args, "--evidence");
  if (!evidenceFile) {
    console.error(
      "usage: reconcile-run-summary.ts --evidence <gather's json> " +
        "[--outcome <applier's json>] [--apply]"
    );
    process.exit(1);
  }
  const evidence = readJson(evidenceFile, "--evidence") as ReconcileEvidence;
  if (!evidence?.watermark?.current || !evidence.sweptCommit) {
    console.error(
      `--evidence ${evidenceFile} carries no run stamp or no swept commit — ` +
        "re-run the gather with --json and use that file."
    );
    process.exit(1);
  }

  // No --outcome means no applier ran, which is a real and common shape: a
  // report-only run patched nothing. Zero is then the truth, not a default.
  const outcomeFile = flagValue(args, "--outcome");
  const patched = outcomeFile
    ? ((readJson(outcomeFile, "--outcome") as { applied?: number }).applied ?? 0)
    : 0;

  let summary;
  try {
    summary = summarizeRun(evidence, patched);
  } catch (error) {
    console.error(`reconcile-run-summary: ${(error as Error).message}`);
    process.exit(1);
  }
  const line = renderRunSummaryLine(summary);

  if (!apply) {
    console.log(line);
    // A dry run may still check for a duplicate, and a read credential is
    // enough for that. Without one it prints the line and says what it could
    // not check, rather than implying the post would be the first.
    const readToken = resolveReadToken(process.env);
    if (!readToken) {
      console.log(
        `\ndry run — would comment on #${RUN_SUMMARY_ISSUE}. No token, so ` +
          "nothing was read and nothing was written; the duplicate check did not run."
      );
      return;
    }
    const duplicate = alreadyPosted(readComments(readToken), summary.ranAt);
    console.log(
      duplicate
        ? `\ndry run — this run (${summary.ranAt}) is ALREADY on #${RUN_SUMMARY_ISSUE}; --apply would refuse`
        : `\ndry run — would comment on #${RUN_SUMMARY_ISSUE}. Re-run with --apply to post.`
    );
    return;
  }

  // Writes ride the named variables only — resolveReadToken's gh fallback is a
  // READ credential (environment.md §GitHub access).
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
  if (!token) {
    console.error(
      "--apply needs GH_TOKEN or GITHUB_TOKEN — the gh-auth fallback is for reads."
    );
    process.exit(2);
  }

  if (alreadyPosted(readComments(token), summary.ranAt)) {
    console.error(
      `refusing: #${RUN_SUMMARY_ISSUE} already carries a summary for ${summary.ranAt}. ` +
        "One line per run; re-gather for a new one."
    );
    process.exit(1);
  }

  const { status, body: reply } = curl([
    ...authHeaders(token),
    "-X",
    "POST",
    "--data-binary",
    JSON.stringify({ body: runSummaryComment(summary) }),
    COMMENTS_URL,
  ]);
  if (status !== 201) {
    console.error(`POST comment on #${RUN_SUMMARY_ISSUE} -> ${status}`);
    process.exit(2);
  }

  // No write believed until re-read (§GitHub access), and the re-read is the
  // same duplicate query — so it verifies the line landed AND that exactly one
  // of them did.
  const landed = readComments(token).filter((c) =>
    (c.body ?? "").includes(`${RUN_SUMMARY_MARKER} ${summary.ranAt}`)
  );
  if (landed.length !== 1) {
    console.error(
      `verify FAILED: re-read #${RUN_SUMMARY_ISSUE} and found ${landed.length} ` +
        `summaries for ${summary.ranAt}, expected exactly 1`
    );
    process.exit(1);
  }
  console.log(
    `posted #${(JSON.parse(reply) as { id: number }).id} on #${RUN_SUMMARY_ISSUE} (verified)\n${line}`
  );
}

main();
