import { describe, it, expect } from "vitest";
import {
  buildAttention,
  groupAttention,
  SEVERITY_ORDER,
  type AttentionInput,
} from "../attention";
import type { UpcomingItem } from "../upcoming";

const TODAY = "2026-07-10";

// A minimal UpcomingItem factory for the tests.
function up(
  partial: Partial<UpcomingItem> & Pick<UpcomingItem, "key">
): UpcomingItem {
  return {
    domain: "dose",
    title: "Item",
    href: "/x",
    dueDate: null,
    ...partial,
  } as UpcomingItem;
}

function input(over: Partial<AttentionInput> = {}): AttentionInput {
  return {
    upcoming: [],
    flaggedBiomarkers: [],
    integrations: [],
    reviewCount: 0,
    today: TODAY,
    ...over,
  };
}

describe("buildAttention", () => {
  it("empty inputs → empty model (the 'all clear' state)", () => {
    expect(buildAttention(input())).toEqual([]);
  });

  it("maps an Upcoming band to a severity: overdue date → overdue, future within a week → soon", () => {
    const items = buildAttention(
      input({
        upcoming: [
          up({
            key: "appointment:1",
            domain: "appointment",
            dueDate: "2026-07-01",
          }), // past → overdue
          up({
            key: "appointment:2",
            domain: "appointment",
            dueDate: "2026-07-13",
          }), // +3d → soon
        ],
      })
    );
    const byKey = new Map(items.map((i) => [i.key, i]));
    expect(byKey.get("appointment:1")!.severity).toBe("overdue");
    expect(byKey.get("appointment:2")!.severity).toBe("soon");
  });

  it("a null-dated due dose bands as 'today' and carries its doseId + suppressible flag", () => {
    const [item] = buildAttention(
      input({ upcoming: [up({ key: "dose:12", domain: "dose", doseId: 12 })] })
    );
    expect(item.severity).toBe("today");
    expect(item.doseId).toBe(12);
    expect(item.suppressible).toBe(true);
  });

  it("newly-flagged out-of-range biomarker → 'today', non-optimal → 'soon'; neither is suppressible", () => {
    const items = buildAttention(
      input({
        flaggedBiomarkers: [
          { name: "LDL", value: "160 mg/dL", flag: "high" },
          { name: "Ferritin", value: "20", flag: "non-optimal-low" },
        ],
      })
    );
    const ldl = items.find((i) => i.title === "LDL")!;
    const fer = items.find((i) => i.title === "Ferritin")!;
    expect(ldl.severity).toBe("today");
    expect(ldl.suppressible).toBe(false);
    expect(ldl.key).toBe("biomarker-flag:ldl");
    expect(fer.severity).toBe("soon");
  });

  it("a failing integration → a 'today' reconnect item; review pairs → a single 'info' item", () => {
    const items = buildAttention(
      input({
        integrations: [{ provider: "Strava", detail: "401 Unauthorized" }],
        reviewCount: 3,
      })
    );
    const integ = items.find((i) => i.domain === "integration")!;
    const review = items.find((i) => i.domain === "review")!;
    expect(integ.severity).toBe("today");
    expect(integ.suppressible).toBe(false);
    expect(review.severity).toBe("info");
    expect(review.title).toContain("3 import items");
  });

  it("no review item when reviewCount is 0", () => {
    const items = buildAttention(input({ reviewCount: 0 }));
    expect(items.find((i) => i.domain === "review")).toBeUndefined();
  });

  it("orders by severity first, then by domain rank within a severity", () => {
    const items = buildAttention(
      input({
        // All resolve to 'today': a due dose (domain rank 0) and a high flag (rank 1),
        // plus an overdue appointment that must sort ABOVE both.
        upcoming: [
          up({ key: "dose:1", domain: "dose", doseId: 1 }),
          up({
            key: "appointment:9",
            domain: "appointment",
            dueDate: "2026-06-01",
          }),
        ],
        flaggedBiomarkers: [{ name: "LDL", value: null, flag: "high" }],
      })
    );
    // overdue appointment leads; then within 'today', dose (rank 0) before flag (rank 1).
    expect(items.map((i) => i.key)).toEqual([
      "appointment:9",
      "dose:1",
      "biomarker-flag:ldl",
    ]);
  });
});

describe("groupAttention", () => {
  it("buckets by severity in fixed order, dropping empty bands", () => {
    const items = buildAttention(
      input({
        upcoming: [
          up({
            key: "appointment:1",
            domain: "appointment",
            dueDate: "2026-06-01",
          }), // overdue
          up({ key: "dose:1", domain: "dose", doseId: 1 }), // today
        ],
        reviewCount: 1, // info
      })
    );
    const groups = groupAttention(items);
    expect(groups.map((g) => g.severity)).toEqual(["overdue", "today", "info"]);
    // fixed global order is respected (no 'soon' band present here)
    for (let i = 1; i < groups.length; i++) {
      expect(SEVERITY_ORDER.indexOf(groups[i].severity)).toBeGreaterThan(
        SEVERITY_ORDER.indexOf(groups[i - 1].severity)
      );
    }
  });
});
