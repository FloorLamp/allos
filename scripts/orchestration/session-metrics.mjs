// Session metrics — the pipeline's trend pulse, read-only. catchup-digest.sh
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
// ci-watch lesson; or API trouble).

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
helpGuard(process.argv, import.meta.url);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure: everything below the fetch is computed from plain arrays. */
export function computeMetrics({ mergedPrs, openPrs, openIssues, now, days }) {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
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
    window: { since, days, now: now.toISOString() },
    examined: {
      closedPrsScanned: mergedPrs.length,
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
      selfFiledMarked: openIssues.filter((i) =>
        /found (while|by)/i.test(i.body ?? "")
      ).length,
    },
  };
}

export function renderMetrics(m) {
  const lines = [];
  const f1 = (n) => (n === null ? "n/a" : n.toFixed(1));
  lines.push(
    `# Session metrics — last ${m.window.days}d (${m.window.since} → ${m.window.now})`
  );
  lines.push("");
  lines.push("## What was examined ← denominators FIRST");
  lines.push(
    `- ${m.examined.closedPrsScanned} closed PRs scanned, ` +
      `${m.examined.openPrs} open PRs, ${m.examined.openIssues} open issues`
  );
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
  lines.push(
    `- self-filed (provenance-marked): ${m.queue.selfFiledMarked} — back of queue by rule`
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
  const get = (pathAndQuery) => {
    const all = [];
    for (let page = 1; page <= 10; page++) {
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
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  };

  const closedPrs = get("/pulls?state=closed&sort=updated&direction=desc");
  const openPrsRaw = get("/pulls?state=open");
  const openIssuesRaw = get("/issues?state=open");

  const metrics = computeMetrics({
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
        body: i.body ?? "",
        createdAt: i.created_at,
        labels: i.labels.map((l) => l.name),
      })),
    now: new Date(),
    days,
  });
  console.log(renderMetrics(metrics));
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) main();
