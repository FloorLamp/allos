import { describe, it, expect } from "vitest";
import {
  coachingDedupeKey,
  digestDedupeKey,
  upcomingToFinding,
  recommendationToFinding,
  trendItemToFinding,
  bandForFinding,
  groupFindings,
  activeByKey,
  type Finding,
} from "../findings";
import type { UpcomingItem } from "../upcoming";
import type { Recommendation } from "../coaching";
import type { TrendItem } from "../trends-digest";
import type { SuppressionRecord } from "../upcoming-suppress";

const TODAY = "2026-07-08";

describe("dedupe-key builders", () => {
  it("namespaces coaching keys by rec id", () => {
    expect(coachingDedupeKey("rest-sleep")).toBe("coaching:rest-sleep");
  });

  it("keys digest chips by series + direction (a reversal is a new key)", () => {
    expect(digestDedupeKey({ key: "bio:LDL", direction: "up" })).toBe(
      "digest:bio:LDL:up"
    );
    expect(digestDedupeKey({ key: "bio:LDL", direction: "down" })).toBe(
      "digest:bio:LDL:down"
    );
  });
});

describe("upcomingToFinding", () => {
  it("renames key→dedupeKey / href→actionHref and carries banding fields", () => {
    const item: UpcomingItem = {
      key: "dose:12",
      domain: "dose",
      title: "Magnesium",
      detail: "400 mg",
      href: "/medicine",
      dueDate: null,
      band: "today",
      dueText: "Today",
    };
    const f = upcomingToFinding(item);
    expect(f).toMatchObject({
      domain: "dose",
      dedupeKey: "dose:12",
      title: "Magnesium",
      detail: "400 mg",
      actionHref: "/medicine",
      dueDate: null,
      band: "today",
      dueText: "Today",
    });
  });

  it("normalizes an undefined detail to null", () => {
    const item: UpcomingItem = {
      key: "goal:3",
      domain: "goal",
      title: "Run a 10k",
      href: "/goals",
      dueDate: "2026-08-01",
    };
    expect(upcomingToFinding(item).detail).toBeNull();
  });
});

describe("recommendationToFinding", () => {
  it("maps the rec into the coaching namespace, folding target into evidence", () => {
    const rec: Recommendation = {
      id: "strength-Bench Press",
      kind: "strength",
      title: "Train Bench Press",
      detail: "Add a rep toward 8.",
      tone: "action",
      actionHref: "/training",
      actionLabel: "View details",
      target: "62.5 kg × 5",
    };
    expect(recommendationToFinding(rec)).toEqual({
      domain: "coaching",
      dedupeKey: "coaching:strength-Bench Press",
      title: "Train Bench Press",
      detail: "Add a rep toward 8.",
      tone: "action",
      actionHref: "/training",
      actionLabel: "View details",
      evidence: "62.5 kg × 5",
    });
  });

  it("uses a null evidence when the rec has no target", () => {
    const rec: Recommendation = {
      id: "rest-sleep",
      kind: "rest",
      title: "Rest today",
      detail: "You slept poorly.",
      tone: "caution",
    };
    const f = recommendationToFinding(rec);
    expect(f.evidence).toBeNull();
    expect(f.dedupeKey).toBe("coaching:rest-sleep");
  });
});

describe("trendItemToFinding", () => {
  const base: Omit<TrendItem, "rangeShift" | "lastStatus"> = {
    key: "bio:LDL",
    label: "LDL",
    direction: "up",
    first: 100,
    last: 140,
    absChange: 40,
    pctChange: 0.4,
    days: 90,
    count: 5,
    magnitude: 1000.4,
    text: "LDL ↑ 40% over 90d — into high range",
  };

  it("marks an out-of-range move as caution", () => {
    const f = trendItemToFinding({
      ...base,
      rangeShift: "out-of-range",
      lastStatus: "above",
    });
    expect(f).toMatchObject({
      domain: "digest",
      dedupeKey: "digest:bio:LDL:up",
      title: "LDL",
      tone: "caution",
    });
  });

  it("marks a return into range as positive, a plain move as neutral", () => {
    expect(
      trendItemToFinding({
        ...base,
        rangeShift: "into-range",
        lastStatus: "in",
      }).tone
    ).toBe("positive");
    expect(
      trendItemToFinding({ ...base, rangeShift: null, lastStatus: "unknown" })
        .tone
    ).toBe("neutral");
  });
});

describe("bandForFinding / groupFindings", () => {
  const finding = (
    over: Partial<Finding> & { dedupeKey: string }
  ): Finding => ({
    domain: "goal",
    title: over.dedupeKey,
    ...over,
  });

  it("bands by due date, honoring an explicit band override", () => {
    expect(
      bandForFinding(finding({ dedupeKey: "a", dueDate: TODAY }), TODAY)
    ).toBe("today");
    expect(
      bandForFinding(finding({ dedupeKey: "b", dueDate: "2026-07-01" }), TODAY)
    ).toBe("overdue");
    expect(
      bandForFinding(
        finding({ dedupeKey: "c", dueDate: "2099-01-01", band: "week" }),
        TODAY
      )
    ).toBe("week");
  });

  it("buckets into fixed band order and sorts within a band", () => {
    const groups = groupFindings(
      [
        finding({ dedupeKey: "later:1", dueDate: "2099-01-01" }),
        finding({ dedupeKey: "od:1", dueDate: "2026-07-01" }),
        finding({ dedupeKey: "today:b", dueDate: TODAY, domain: "refill" }),
        finding({ dedupeKey: "today:a", dueDate: TODAY, domain: "dose" }),
      ],
      TODAY
    );
    expect(groups.map((g) => g.band)).toEqual(["overdue", "today", "later"]);
    // Same due date → domain then dedupeKey ordering (dose < refill).
    expect(groups[1].items.map((f) => f.dedupeKey)).toEqual([
      "today:a",
      "today:b",
    ]);
  });
});

describe("activeByKey", () => {
  const map = new Map<string, SuppressionRecord>([
    ["coaching:a", { snooze_until: "2026-07-15", dismissed_at: null }], // active snooze
    ["coaching:b", { snooze_until: "2026-07-01", dismissed_at: null }], // expired snooze
    ["coaching:c", { snooze_until: null, dismissed_at: "2026-01-01" }], // dismissed
  ]);
  const recs = ["a", "b", "c", "d"];

  it("drops keys with an active snooze or a dismissal, keeps the rest", () => {
    const kept = activeByKey(recs, (id) => coachingDedupeKey(id), map, TODAY);
    // b's snooze has expired (reappears); d was never suppressed.
    expect(kept).toEqual(["b", "d"]);
  });
});
