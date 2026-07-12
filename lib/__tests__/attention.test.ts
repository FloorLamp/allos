import { describe, it, expect } from "vitest";
import {
  ATTENTION_GROUP_CAP,
  attentionCountLabel,
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

  it("EXCLUDES later-band items — far-future dates and explicit 'later' overrides never reach the hero (issue #283)", () => {
    const items = buildAttention(
      input({
        upcoming: [
          // +45 days → 'later' by date → dropped.
          up({
            key: "appointment:3",
            domain: "appointment",
            dueDate: "2026-08-24",
          }),
          // Explicit 'later' band (a quiet Scheduled preventive item) → dropped.
          up({
            key: "visit:adult_physical",
            domain: "visit",
            band: "later",
            dueText: "Scheduled",
          }),
          // Boundary: +7 days is still the 'week' band → kept as 'soon'.
          up({
            key: "appointment:4",
            domain: "appointment",
            dueDate: "2026-07-17",
          }),
        ],
      })
    );
    expect(items.map((i) => i.key)).toEqual(["appointment:4"]);
    expect(items[0].severity).toBe("soon");
  });

  it("a null-dated due dose bands as 'today' and carries its doseId + suppressible flag", () => {
    const [item] = buildAttention(
      input({ upcoming: [up({ key: "dose:12", domain: "dose", doseId: 12 })] })
    );
    expect(item.severity).toBe("today");
    expect(item.doseId).toBe(12);
    expect(item.suppressible).toBe(true);
  });

  it("newly-flagged out-of-range biomarker → 'today', non-optimal → 'soon'; both dismissible via the findings bus (issue #283)", () => {
    const items = buildAttention(
      input({
        flaggedBiomarkers: [
          {
            name: "LDL Cholesterol",
            canonicalName: "LDL Cholesterol",
            value: "160 mg/dL",
            flag: "high",
          },
          {
            name: "Ferritin",
            canonicalName: "Ferritin",
            value: "20",
            flag: "non-optimal-low",
          },
        ],
      })
    );
    const ldl = items.find((i) => i.title === "LDL Cholesterol")!;
    const fer = items.find((i) => i.title === "Ferritin")!;
    expect(ldl.severity).toBe("today");
    expect(ldl.suppressible).toBe(true);
    expect(ldl.key).toBe("biomarker-flag:ldl cholesterol");
    expect(fer.severity).toBe("soon");
    expect(fer.suppressible).toBe(true);
  });

  it("a canonicalized flag deep-links to its series by canonical name; an uncanonicalized one falls back to /biomarkers (issue #283)", () => {
    const items = buildAttention(
      input({
        flaggedBiomarkers: [
          // The read already prefers the canonical name (COALESCE), so `name` IS
          // the canonical string when canonicalName is set — even when the raw
          // stored name differed (e.g. "LDL-C" snapped to "LDL Cholesterol").
          {
            name: "LDL Cholesterol",
            canonicalName: "LDL Cholesterol",
            value: "160 mg/dL",
            flag: "high",
          },
          {
            name: "Mystery Analyte",
            canonicalName: null,
            value: "5",
            flag: "abnormal",
          },
        ],
      })
    );
    const ldl = items.find((i) => i.title === "LDL Cholesterol")!;
    const mystery = items.find((i) => i.title === "Mystery Analyte")!;
    // The view page treats ?name= as the CANONICAL name, so only a canonicalized
    // reading gets the deep link.
    expect(ldl.href).toBe("/biomarkers/view?name=LDL%20Cholesterol");
    expect(mystery.href).toBe("/biomarkers");
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

  it("orders same-severity doses by their sortHint (bucket → priority → name), not alphabetically (issue #297)", () => {
    // Three due doses all band as 'today' and share the 'dose' domain rank, so
    // the sortHint (carried through from the Upcoming item) is what breaks the
    // tie — bucket-then-priority, never plain A→Z.
    const items = buildAttention(
      input({
        upcoming: [
          up({
            key: "dose:1",
            domain: "dose",
            title: "Melatonin",
            doseId: 1,
            sortHint: "32~Melatonin", // Before sleep
          }),
          up({
            key: "dose:2",
            domain: "dose",
            title: "Aspirin",
            doseId: 2,
            sortHint: "00~Aspirin", // Morning, mandatory
          }),
          up({
            key: "dose:3",
            domain: "dose",
            title: "Zinc",
            doseId: 3,
            sortHint: "02~Zinc", // Morning, low
          }),
        ],
      })
    );
    expect(items.map((i) => i.title)).toEqual(["Aspirin", "Zinc", "Melatonin"]);
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
    // No group is anywhere near the cap here — nothing overflows.
    expect(groups.every((g) => g.overflow === 0)).toBe(true);
  });

  it("caps each severity group and reports the rest as overflow (issue #283)", () => {
    // Twelve overdue appointments, deterministic titles. With a cap of 8 the
    // group keeps the first 8 (already severity/domain/title-ordered) and
    // reports 4 as overflow for the hero's "+N more" link.
    const items = buildAttention(
      input({
        upcoming: Array.from({ length: 12 }, (_, i) =>
          up({
            key: `appointment:${i}`,
            domain: "appointment",
            title: `Visit ${String(i).padStart(2, "0")}`,
            dueDate: "2026-07-01",
          })
        ),
      })
    );
    expect(items).toHaveLength(12); // the model (and the count badge) keeps all
    const [group] = groupAttention(items);
    expect(group.severity).toBe("overdue");
    expect(group.items).toHaveLength(ATTENTION_GROUP_CAP);
    expect(group.overflow).toBe(12 - ATTENTION_GROUP_CAP);
    // The kept rows are the FIRST of the ordered list, not an arbitrary slice.
    expect(group.items[0].title).toBe("Visit 00");
    expect(group.items[ATTENTION_GROUP_CAP - 1].title).toBe(
      `Visit ${String(ATTENTION_GROUP_CAP - 1).padStart(2, "0")}`
    );
    // An explicit cap wins over the default.
    const [tight] = groupAttention(items, 2);
    expect(tight.items).toHaveLength(2);
    expect(tight.overflow).toBe(10);
  });
});

// Issue #512 — the honest per-band count label so the card reconciles with the
// Upcoming page instead of showing a bare capped count.
describe("attentionCountLabel", () => {
  it("shows the plain count when nothing overflows", () => {
    expect(attentionCountLabel(5, 0)).toBe("5");
    expect(attentionCountLabel(0, 0)).toBe("0");
  });

  it("shows 'shown of total' when the cap truncated the band", () => {
    // The reported case: 8 shown of 11 true → "8 of 11", not a bare "8".
    expect(attentionCountLabel(8, 3)).toBe("8 of 11");
    expect(attentionCountLabel(2, 10)).toBe("2 of 12");
  });
});
