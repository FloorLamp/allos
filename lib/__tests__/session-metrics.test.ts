import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeMetrics,
  renderMetrics,
} from "../../scripts/orchestration/session-metrics.mjs";

// The trend pulse's arithmetic, over fixtures. The point of the script is
// that caps and cadences get argued from measurement; a pulse that
// miscounts argues the wrong rule with full confidence, so the counting is
// what gets pinned — plus the report's one structural rule, denominators
// first, and that the script holds no write verb at all.

const NOW = new Date("2026-08-30T12:00:00Z");

const pr = (
  number: number,
  mergedAt: string,
  title = `change ${number}`,
  createdAt = "2026-08-23T12:00:00Z"
) => ({ number, title, createdAt, mergedAt });

const issue = (
  number: number,
  labels: string[],
  over: Partial<{ createdAt: string }> = {}
) => ({
  number,
  labels,
  createdAt: over.createdAt ?? "2026-08-20T00:00:00Z",
});

function metrics(over: Partial<Parameters<typeof computeMetrics>[0]> = {}) {
  return computeMetrics({
    mergedPrs: [],
    openPrs: [],
    openIssues: [],
    now: NOW,
    days: 7,
    ...over,
  });
}

describe("computeMetrics", () => {
  it("counts only merges INSIDE the window, and flags reverts", () => {
    const m = metrics({
      mergedPrs: [
        pr(1, "2026-08-29T00:00:00Z"),
        pr(2, "2026-08-28T00:00:00Z", "Revert “change 1”"),
        pr(3, "2026-08-01T00:00:00Z"), // outside the 7d window
      ],
    });
    expect(m.throughput.merged).toBe(2);
    expect(m.throughput.reverts).toEqual([2]);
    expect(m.examined.closedPrsScanned).toBe(3);
  });

  it("shapes the queue by the one priority slot each issue carries", () => {
    const m = metrics({
      openIssues: [
        issue(1, ["P1", "db"]),
        issue(2, ["P3", "ui"]),
        issue(3, ["parked", "design"]),
        issue(4, ["ui"]), // no slot at all — hygiene drift, counted apart
      ],
    });
    expect(m.queue.byPriority).toEqual({
      P0: 0,
      P1: 1,
      P2: 0,
      P3: 1,
      parked: 1,
    });
    expect(m.queue.unslotted).toBe(1);
  });

  it("ages the needs-human queue — the metric is the OLDEST, not the count", () => {
    const m = metrics({
      openIssues: [
        issue(1, ["needs-human", "P2", "db"], {
          createdAt: "2026-08-16T12:00:00Z",
        }),
        issue(2, ["needs-human", "P3", "ui"], {
          createdAt: "2026-08-29T12:00:00Z",
        }),
      ],
    });
    expect(m.queue.needsHuman).toBe(2);
    expect(m.queue.oldestNeedsHumanDays).toBe(14);
  });

  it("marks draft PRs as drift, and publishes no phrase count (#4460)", () => {
    // `selfFiledMarked` counted /found (while|by)/i over the body: 3 right in
    // 8 against the only ground truth there was. A number nobody should act
    // on is noise on the pulse, so the pulse no longer carries it.
    const m = metrics({
      openIssues: [issue(1, ["P3", "ui"]), issue(2, ["P2", "db"])],
      openPrs: [
        { number: 40, draft: false },
        { number: 41, draft: true },
      ],
    });
    expect(m.reviewQueue.drafts).toEqual([41]);
    expect(m.queue).not.toHaveProperty("selfFiledMarked");
    expect(renderMetrics(m)).not.toContain("found while/by");
  });

  it("renders an empty window as zeros over stated denominators, never n/a-quiet", () => {
    const text = renderMetrics(metrics());
    expect(text.indexOf("What was examined")).toBeLessThan(
      text.indexOf("Throughput")
    );
    expect(text).toContain("0 closed PRs scanned, 0 open PRs, 0 open issues");
    expect(text).toContain("0 merged (0.0/day)");
  });
});

describe("session-metrics.mjs is read-only", () => {
  it("holds no write verb — the pulse can never become a hand", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts/orchestration/session-metrics.mjs"),
      "utf8"
    );
    expect(source).not.toMatch(/"(?:PATCH|POST|PUT|DELETE)"/);
    expect(source).not.toContain('"-X"');
  });
});
