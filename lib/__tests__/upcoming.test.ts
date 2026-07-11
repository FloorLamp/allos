import { describe, it, expect } from "vitest";
import {
  bandForDays,
  daysUntilDue,
  bandForItem,
  upcomingDueText,
  groupUpcoming,
  snoozeUntil,
  BAND_ORDER,
  type UpcomingItem,
} from "../upcoming";

const TODAY = "2026-07-08";

// Minimal item factory — only the fields a test cares about, defaults for the rest.
function item(over: Partial<UpcomingItem> & { key: string }): UpcomingItem {
  return {
    domain: "goal",
    title: over.title ?? over.key,
    href: "/x",
    dueDate: null,
    ...over,
  };
}

describe("bandForDays", () => {
  it("splits overdue / today / this-week / later at the boundaries", () => {
    expect(bandForDays(-1)).toBe("overdue");
    expect(bandForDays(-100)).toBe("overdue");
    expect(bandForDays(0)).toBe("today");
    expect(bandForDays(1)).toBe("week");
    expect(bandForDays(7)).toBe("week"); // inclusive upper edge of "this week"
    expect(bandForDays(8)).toBe("later");
    expect(bandForDays(365)).toBe("later");
  });
});

describe("daysUntilDue", () => {
  it("treats a null due date as today (0)", () => {
    expect(daysUntilDue(null, TODAY)).toBe(0);
  });
  it("is negative for past dates, positive for future", () => {
    expect(daysUntilDue("2026-07-07", TODAY)).toBe(-1);
    expect(daysUntilDue("2026-07-08", TODAY)).toBe(0);
    expect(daysUntilDue("2026-07-15", TODAY)).toBe(7);
    expect(daysUntilDue("2026-08-07", TODAY)).toBe(30);
  });
  it("returns 0 for an unparseable date rather than throwing", () => {
    expect(daysUntilDue("not-a-date", TODAY)).toBe(0);
  });
});

describe("bandForItem", () => {
  it("derives the band from the due date when there is no override", () => {
    expect(bandForItem(item({ key: "a", dueDate: "2026-07-01" }), TODAY)).toBe(
      "overdue"
    );
    expect(bandForItem(item({ key: "b", dueDate: "2026-07-15" }), TODAY)).toBe(
      "week"
    );
  });
  it("honors an explicit band override (status-driven signals)", () => {
    // A future-dated item forced into overdue by its status override.
    expect(
      bandForItem(
        item({ key: "c", dueDate: "2026-09-01", band: "overdue" }),
        TODAY
      )
    ).toBe("overdue");
    expect(bandForItem(item({ key: "d", band: "week" }), TODAY)).toBe("week");
  });
});

describe("upcomingDueText", () => {
  it("uses an explicit dueText override when present", () => {
    expect(upcomingDueText(item({ key: "a", dueText: "Overdue" }), TODAY)).toBe(
      "Overdue"
    );
  });
  it("labels a null due date as Today", () => {
    expect(upcomingDueText(item({ key: "b", dueDate: null }), TODAY)).toBe(
      "Today"
    );
  });
  it("computes a countdown label from the due date", () => {
    expect(
      upcomingDueText(item({ key: "c", dueDate: "2026-07-08" }), TODAY)
    ).toBe("today");
    expect(
      upcomingDueText(item({ key: "d", dueDate: "2026-07-09" }), TODAY)
    ).toBe("tomorrow");
    expect(
      upcomingDueText(item({ key: "e", dueDate: "2026-07-15" }), TODAY)
    ).toBe("7 days left");
    expect(
      upcomingDueText(item({ key: "f", dueDate: "2026-07-01" }), TODAY)
    ).toBe("7 days overdue");
  });
});

describe("groupUpcoming", () => {
  it("returns no groups for an empty item list (empty state)", () => {
    expect(groupUpcoming([], TODAY)).toEqual([]);
  });

  it("buckets items into the four bands in fixed order, dropping empties", () => {
    const items = [
      item({ key: "goal-later", dueDate: "2026-08-01" }), // later
      item({ key: "dose-today", domain: "dose", dueDate: null }), // today
      item({ key: "bio-overdue", domain: "biomarker", dueDate: "2026-06-01" }), // overdue
      item({ key: "goal-week", dueDate: "2026-07-12" }), // week
    ];
    const groups = groupUpcoming(items, TODAY);
    expect(groups.map((g) => g.band)).toEqual([
      "overdue",
      "today",
      "week",
      "later",
    ]);
    // Every declared band appears exactly once and in canonical order.
    expect(groups.map((g) => g.band)).toEqual(
      BAND_ORDER.filter((b) => groups.some((g) => g.band === b))
    );
  });

  it("drops bands with no items", () => {
    const groups = groupUpcoming(
      [item({ key: "only-today", dueDate: null })],
      TODAY
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].band).toBe("today");
    expect(groups[0].label).toBe("Today");
  });

  it("sorts within a band by due date, then domain, then title", () => {
    const items = [
      item({
        key: "b2",
        domain: "biomarker",
        dueDate: "2026-06-10",
        title: "B",
      }),
      item({
        key: "b1",
        domain: "biomarker",
        dueDate: "2026-06-01",
        title: "A",
      }),
      // Same date as b1 but a later-ordered domain (goal > biomarker) → after b1.
      item({ key: "g1", domain: "goal", dueDate: "2026-06-01", title: "Z" }),
    ];
    const overdue = groupUpcoming(items, TODAY).find(
      (g) => g.band === "overdue"
    )!;
    expect(overdue.items.map((i) => i.key)).toEqual(["b1", "g1", "b2"]);
  });

  it("clusters status-override items (null date) with same-day work in their band", () => {
    const items = [
      item({
        key: "imm",
        domain: "immunization",
        band: "overdue",
        dueText: "Overdue",
      }),
      item({ key: "bio", domain: "biomarker", dueDate: "2026-06-01" }),
    ];
    const overdue = groupUpcoming(items, TODAY).find(
      (g) => g.band === "overdue"
    )!;
    expect(overdue.items).toHaveLength(2);
    // Null-dated override sorts as TODAY, so the real overdue date comes first.
    expect(overdue.items.map((i) => i.key)).toEqual(["bio", "imm"]);
  });

  it("bands appointments by their calendar date", () => {
    const items = [
      item({ key: "appt-today", domain: "appointment", dueDate: TODAY }),
      item({ key: "appt-week", domain: "appointment", dueDate: "2026-07-10" }),
      item({ key: "appt-past", domain: "appointment", dueDate: "2026-07-01" }),
      item({ key: "appt-later", domain: "appointment", dueDate: "2026-09-01" }),
    ];
    const groups = groupUpcoming(items, TODAY);
    const band = (b: string) => groups.find((g) => g.band === b);
    expect(band("overdue")!.items.map((i) => i.key)).toEqual(["appt-past"]);
    expect(band("today")!.items.map((i) => i.key)).toEqual(["appt-today"]);
    expect(band("week")!.items.map((i) => i.key)).toEqual(["appt-week"]);
    expect(band("later")!.items.map((i) => i.key)).toEqual(["appt-later"]);
  });

  it("orders same-day doses by their sortHint (bucket → priority → name), not alphabetically (issue #297)", () => {
    // All doses land in Today (null due date) and share the `dose` domain, so
    // before #297 they fell straight through to the alphabetical title tiebreak,
    // interleaving morning and bedtime. The sortHint now clusters them by bucket.
    const items = [
      // sortHints mirror doseSortKey: "<bucketRank><priorityRank>~<name>".
      item({
        key: "dose:mel",
        domain: "dose",
        title: "Melatonin",
        sortHint: "32~Melatonin", // Before sleep
      }),
      item({
        key: "dose:asp",
        domain: "dose",
        title: "Aspirin",
        sortHint: "00~Aspirin", // Morning, mandatory
      }),
      item({
        key: "dose:zinc",
        domain: "dose",
        title: "Zinc",
        sortHint: "02~Zinc", // Morning, low
      }),
    ];
    const today = groupUpcoming(items, TODAY).find((g) => g.band === "today")!;
    // Morning (Aspirin, then Zinc) before the bedtime Melatonin — NOT A→M→Z.
    expect(today.items.map((i) => i.title)).toEqual([
      "Aspirin",
      "Zinc",
      "Melatonin",
    ]);
  });

  it("orders an appointment ahead of an immunization sharing the effective date", () => {
    // Both land in Today (the appointment via a null-ish today date, the
    // immunization via its band override), so the DOMAIN_ORDER tiebreak (appointment
    // before immunization) decides.
    const items = [
      item({
        key: "imm",
        domain: "immunization",
        band: "today",
        dueText: "Due",
      }),
      item({ key: "appt", domain: "appointment", dueDate: TODAY }),
    ];
    const today = groupUpcoming(items, TODAY).find((g) => g.band === "today")!;
    expect(today.items.map((i) => i.key)).toEqual(["appt", "imm"]);
  });
});

describe("snoozeUntil", () => {
  it("shifts today by the requested whole days", () => {
    expect(snoozeUntil(TODAY, 1)).toBe("2026-07-09");
    expect(snoozeUntil(TODAY, 7)).toBe("2026-07-15");
  });

  it("floors fractional days", () => {
    expect(snoozeUntil(TODAY, 7.9)).toBe("2026-07-15");
  });

  it("clamps to the 3650-day (10y) maximum", () => {
    // The max lands exactly 3650 days out; anything larger clamps to the same date.
    const atMax = snoozeUntil(TODAY, 3650);
    expect(snoozeUntil(TODAY, 3651)).toBe(atMax);
    expect(snoozeUntil(TODAY, 1_000_000)).toBe(atMax);
  });

  it("returns null for days below the 1-day minimum", () => {
    expect(snoozeUntil(TODAY, 0)).toBeNull();
    expect(snoozeUntil(TODAY, 0.5)).toBeNull();
    expect(snoozeUntil(TODAY, -3)).toBeNull();
  });

  it("returns null for non-finite requests (tampered forms → NaN/Infinity)", () => {
    expect(snoozeUntil(TODAY, NaN)).toBeNull();
    expect(snoozeUntil(TODAY, Infinity)).toBeNull();
  });
});
