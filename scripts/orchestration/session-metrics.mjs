// Session metrics — the pipeline's trend pulse, read-only. pm-digest.sh
// answers "what happened since I last looked" (events, anchored); this
// answers "how is the pipeline trending" (rates, fixed window): merge
// throughput, review-queue depth, queue shape by priority, needs-human aging,
// and the drift signals the runbook forbids (draft PRs, revert merges).
// Numbers first, rules later — a cap or cadence argued from measurement beats
// one argued from memory, which is how the machine cap (#2964) and the
// stagger window were set.
//
// Usage:
//   node scripts/orchestration/session-metrics.mjs [--days 7] [--repo owner/name]
//
// Denominators print FIRST (the reconcile report's rule): "0 merges over 0
// PRs examined" is a broken read, not a quiet week, and the clean-looking one
// is the one nobody investigates. Exit 0 with the report; 2 when it cannot
// read (no token — an unauthenticated read truncates and lies quiet, the
// ci-watch lesson; or API trouble), and 2 again when a fetch stopped at its page
// cap in a place no line could rescue: an unwindowed denominator, or a --days
// window reaching past what was actually fetched (#5310).

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
helpGuard(process.argv, import.meta.url);

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_CAP = 10;

/**
 * @typedef {{ number: number, title: string, createdAt: string, mergedAt: string }} MergedPr
 * @typedef {{ number: number, draft: boolean }} OpenPr
 * @typedef {{ number: number, createdAt: string, labels: readonly string[] }} OpenIssue
 * `prsTruncated` and `prsCoverageSince` are REQUIRED, not optional, for the
 * reason the sibling gatherer records at length (#5311/#2275): an omitted flag
 * reads exactly like nobody having looked, and this is the one field where that
 * confusion IS the defect.
 * @typedef {{ mergedPrs: readonly MergedPr[], openPrs: readonly OpenPr[],
 *   openIssues: readonly OpenIssue[], now: Date, days: number,
 *   prsTruncated: boolean, prsCoverageSince: string | null }} MetricsInput
 */

/**
 * Pure: everything below the fetch is computed from plain arrays.
 * @param {MetricsInput} input
 */
export function computeMetrics({
  mergedPrs,
  openPrs,
  openIssues,
  now,
  days,
  prsTruncated,
  prsCoverageSince,
}) {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  // The window asks about time the fetch never reached: the pager stopped at its
  // cap and `since` is older than the oldest activity it saw. A truncated list
  // still yields a readable report — the count below says it is a floor — but a
  // window nobody covered yields a throughput number with no finding in it to be
  // right or wrong about, so the script refuses on this rather than printing.
  const uncovered =
    prsTruncated && prsCoverageSince !== null && since < prsCoverageSince;
  const merged = mergedPrs.filter((p) => p.mergedAt >= since);
  const reverts = merged.filter((p) => /^revert\b/i.test(p.title));
  const hoursToMerge = merged
    .map((p) => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3_600_000)
    .sort((a, b) => a - b);

  const slots = ["P0", "P1", "P2", "P3", "parked"];
  const byPriority = Object.fromEntries(slots.map((s) => [s, 0]));
  let unslotted = 0;
  for (const issue of openIssues) {
    const slot = slots.find((s) => issue.labels.includes(s));
    if (slot) byPriority[slot]++;
    else unslotted++;
  }

  const needsHuman = openIssues.filter((i) => i.labels.includes("needs-human"));
  const oldestNeedsHumanDays = needsHuman.length
    ? Math.max(
        ...needsHuman.map(
          (i) => (now.getTime() - Date.parse(i.createdAt)) / DAY_MS
        )
      )
    : null;

  return {
    window: { since, days, now: now.toISOString(), uncovered },
    examined: {
      // NAMED FOR WHAT IT COUNTS. This printed as "closed PRs scanned" while
      // holding the MERGED subset of what was fetched, so one line carried two
      // denominator errors: a cap standing in for the repo, and a label
      // standing in for a different population than the number.
      mergedPrsExamined: mergedPrs.length,
      truncated: prsTruncated,
      coverageSince: prsCoverageSince,
      openPrs: openPrs.length,
      openIssues: openIssues.length,
    },
    throughput: {
      merged: merged.length,
      perDay: merged.length / days,
      medianHoursToMerge: hoursToMerge.length
        ? hoursToMerge[Math.floor(hoursToMerge.length / 2)]
        : null,
      reverts: reverts.map((p) => p.number),
    },
    reviewQueue: {
      openPrs: openPrs.length,
      // Drafts are a drift signal, not a state: PRs open READY
      // (environment.md §GitHub access).
      drafts: openPrs.filter((p) => p.draft).map((p) => p.number),
    },
    queue: {
      byPriority,
      unslotted,
      needsHuman: needsHuman.length,
      oldestNeedsHumanDays,
    },
  };
}

/** @param {ReturnType<typeof computeMetrics>} m */
export function renderMetrics(m) {
  const lines = [];
  /** @param {number | null} n */
  const f1 = (n) => (n === null ? "n/a" : n.toFixed(1));
  lines.push(
    `# Session metrics — last ${m.window.days}d (${m.window.since} → ${m.window.now})`
  );
  lines.push("");
  lines.push("## What was examined ← denominators FIRST");
  lines.push(
    `- ${m.examined.mergedPrsExamined} merged PRs examined, ` +
      `${m.examined.openPrs} open PRs, ${m.examined.openIssues} open issues`
  );
  if (m.examined.truncated) {
    lines.push(
      `- **TRUNCATED**: the closed-PR fetch stopped at its ${PAGE_CAP}-page cap, so that count is a` +
        ` FLOOR, not a total. Nothing untouched since ${m.examined.coverageSince} was fetched at all` +
        ` — and the list is ordered by ACTIVITY, so that boundary is not a merge date: a PR merged` +
        ` long before it can sit inside the set on one late comment, and a PR merged after it can` +
        ` sit outside on none. Coverage is therefore not even monotonic in the window length.`
    );
  }
  lines.push("");
  lines.push("## Throughput");
  lines.push(
    `- ${m.throughput.merged} merged (${f1(m.throughput.perDay)}/day), ` +
      `median open→merge ${f1(m.throughput.medianHoursToMerge)}h`
  );
  lines.push(
    m.throughput.reverts.length
      ? `- reverts: ${m.throughput.reverts.map((n) => `#${n}`).join(", ")} — read each; a revert is a review escape`
      : "- reverts: none"
  );
  lines.push("");
  lines.push("## Review queue");
  lines.push(
    `- ${m.reviewQueue.openPrs} open PRs` +
      (m.reviewQueue.drafts.length
        ? ` — DRAFTS (PRs open READY): ${m.reviewQueue.drafts.map((n) => `#${n}`).join(", ")}`
        : "; no drafts")
  );
  lines.push("");
  lines.push("## Queue shape");
  const slots = Object.entries(m.queue.byPriority)
    .map(([s, n]) => `${s}:${n}`)
    .join(" ");
  lines.push(`- ${slots} unslotted:${m.queue.unslotted}`);
  lines.push(
    `- needs-human: ${m.queue.needsHuman} open` +
      (m.queue.oldestNeedsHumanDays !== null
        ? `, oldest ${f1(m.queue.oldestNeedsHumanDays)}d — aging here is an owner bottleneck, not agent work`
        : "")
  );
  return lines.join("\n");
}

function main() {
  const token = resolveReadToken();
  if (!token) {
    console.error(
      "no GH_TOKEN/GITHUB_TOKEN and no authenticated gh — an unauthenticated " +
        "read truncates silently, and a truncated pulse lies in the quiet direction."
    );
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };
  const days = Number(flag("--days", "7"));
  const repo = flag("--repo", "FloorLamp/allos");

  // curl, not fetch: node's fetch ignores HTTPS_PROXY (ci-watch.mjs says why).
  //
  // AND IT SAYS WHICH OF THE TWO REASONS IT STOPPED FOR. That answer used to be
  // computed and dropped on the very next line — `if (batch.length < 100) break`
  // IS the exhaustion signal — so a clipped sweep and an exhausted one rendered
  // the same denominator. This report printed "969 closed PRs scanned" under a
  // heading that says denominators FIRST, having fetched 1000 of the repo's 2545
  // closed PRs. Same defect and same fix as the sibling gatherer's `ghGetAll`
  // (#5311); the shape is mirrored rather than shared because that one is a `.ts`
  // module with a curl of its own, and a helper spanning both would be a third
  // way of doing it.
  const get = (pathAndQuery) => {
    const all = [];
    for (let page = 1; page <= PAGE_CAP; page++) {
      const sep = pathAndQuery.includes("?") ? "&" : "?";
      const out = execFileSync(
        "curl",
        [
          "-sS",
          "--fail-with-body",
          "-H",
          `Authorization: Bearer ${token}`,
          "-H",
          "Accept: application/vnd.github+json",
          `https://api.github.com/repos/${repo}${pathAndQuery}${sep}per_page=100&page=${page}`,
        ],
        { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }
      );
      const batch = JSON.parse(out);
      if (!Array.isArray(batch) || batch.length === 0)
        return { items: all, truncated: false };
      all.push(...batch);
      if (batch.length < 100) return { items: all, truncated: false };
    }
    // Every page came back full, so page PAGE_CAP + 1 would have had rows too.
    return { items: all, truncated: true };
  };

  const closed = get("/pulls?state=closed&sort=updated&direction=desc");
  const openPrsPage = get("/pulls?state=open");
  const openIssuesPage = get("/issues?state=open");

  // A truncated TOTAL has no line that could rescue it. The closed-PR fetch is
  // WINDOWED, so it survives truncation by saying so and naming its boundary;
  // these two are printed as bare denominators with no window to bound them, and
  // a clipped denominator is a wrong number that reads exactly like a right one.
  // Refuse instead — the same split the sibling gatherer makes (#5311).
  for (const [what, page] of [
    ["open-PR", openPrsPage],
    ["open-issue", openIssuesPage],
  ]) {
    if (page.truncated) {
      console.error(
        `session-metrics: the ${what} fetch hit its ${PAGE_CAP}-page cap. It is printed ` +
          "as a denominator with no window to bound it, so every row past the cap " +
          "would be silently missing from a number that reads as a total. Refusing."
      );
      process.exit(2);
    }
  }

  const closedPrs = closed.items;
  const openPrsRaw = openPrsPage.items;
  const openIssuesRaw = openIssuesPage.items;

  const metrics = computeMetrics({
    prsTruncated: closed.truncated,
    // The oldest ACTIVITY in the fetched set. Ordered by `updated`, so this is
    // the true lower edge of what the fetch reached, and it is deliberately not
    // a merge date — see the note the renderer prints beside it.
    prsCoverageSince: closedPrs.at(-1)?.updated_at ?? null,
    mergedPrs: closedPrs
      .filter((p) => p.merged_at)
      .map((p) => ({
        number: p.number,
        title: p.title,
        createdAt: p.created_at,
        mergedAt: p.merged_at,
      })),
    openPrs: openPrsRaw.map((p) => ({ number: p.number, draft: p.draft })),
    openIssues: openIssuesRaw
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        createdAt: i.created_at,
        labels: i.labels.map((l) => l.name),
      })),
    now: new Date(),
    days,
  });
  if (metrics.window.uncovered) {
    console.error(
      `session-metrics: --days ${days} reaches back to ${metrics.window.since}, and the ` +
        `closed-PR fetch hit its ${PAGE_CAP}-page cap at ${metrics.examined.coverageSince}. ` +
        "Throughput over the uncovered part would be an undercount that reads exactly " +
        "like a quiet fortnight. Refusing; ask for a shorter window."
    );
    process.exit(2);
  }
  console.log(renderMetrics(metrics));
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) main();
