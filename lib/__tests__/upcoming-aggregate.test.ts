// The Upcoming page's display aggregation (issue #1504) — the pure half.
//
// These pin the CONTRACT, not the copy: which classes fold, which never do, that a
// fold is band-local, that folding never touches identity, and that the count is
// visible in both states (the always-present contract ported from #1413-B).

import { describe, it, expect } from "vitest";
import {
  AGGREGATE_MIN_ROWS,
  MED_SAFETY_ROLLUP_DOMAINS,
  aggregateKindForDomain,
  aggregateLabel,
  bandShowsDoseProgress,
  doseAggregateLabel,
  foldClassOf,
  isSafetyPinnedItem,
  medSafetyAggregateLabel,
  planBandRender,
  sumDoseProgress,
  type BandNode,
} from "../upcoming-aggregate";
import {
  UPCOMING_DOMAINS,
  groupUpcoming,
  type UpcomingDomain,
  type UpcomingItem,
} from "../upcoming";

const TODAY = "2026-03-10";

function item(
  key: string,
  domain: UpcomingDomain,
  extra: Partial<UpcomingItem> = {}
): UpcomingItem {
  return {
    key,
    domain,
    title: key,
    href: "/upcoming",
    dueDate: null,
    ...extra,
  };
}

const dose = (n: number, extra: Partial<UpcomingItem> = {}) =>
  item(`dose:${n}`, "dose", { doseId: n, ...extra });

function nodeKinds(nodes: BandNode<UpcomingItem>[]): string[] {
  return nodes.map((n) =>
    n.node === "item" ? n.item.key : `aggregate:${n.kind}(${n.items.length})`
  );
}

describe("what folds", () => {
  it("folds the scheduled-dose domain and the interaction+pgx pair, nothing else", () => {
    const folding = UPCOMING_DOMAINS.filter(
      (d) => aggregateKindForDomain(d) != null
    );
    // The EXACT rollup scope (#1504). A newly added domain lands in this census the
    // moment it gets a rank, so it must choose a side rather than drift in.
    expect(folding.sort()).toEqual(["dose", "interaction", "pgx"]);
    expect([...MED_SAFETY_ROLLUP_DOMAINS].sort()).toEqual([
      "interaction",
      "pgx",
    ]);
  });

  it("keeps the deliberately-unfolded care domains individual", () => {
    // allergy-med is ranked ABOVE interactions on purpose (#1029); the rest are
    // singular findings whose per-item salience is the point.
    for (const domain of [
      "allergy-med",
      "illness-care",
      "condition-review",
      "contrast",
      "dental-safety",
      "ototoxic",
      "uv-exposure",
      "mental-health",
      "prn-max",
    ] as UpcomingDomain[]) {
      expect(aggregateKindForDomain(domain)).toBeNull();
    }
  });

  it("never folds the `available` disclosure's items (#1505 — no double-fold)", () => {
    expect(aggregateKindForDomain("available")).toBeNull();
  });
});

describe("safety exclusions (pinned)", () => {
  it("never folds a safety-ungated dose and renders it first", () => {
    // A missed-dose ESCALATION is the safety-ungated dose: the dismissal bus may
    // never hide it, and neither may the aggregate.
    const escalation = dose(1, { suppressionPolicy: "safety-ungated" });
    expect(isSafetyPinnedItem(escalation)).toBe(true);
    expect(foldClassOf(escalation)).toBeNull();

    const nodes = planBandRender([
      dose(2),
      escalation,
      dose(3),
      dose(4),
      item("refill:1", "refill"),
    ]);
    expect(nodeKinds(nodes)).toEqual([
      "dose:1",
      "aggregate:dose(3)",
      "refill:1",
    ]);
    // Outside AND above: the escalation is not among the folded items.
    const agg = nodes.find((n) => n.node === "aggregate");
    expect(agg?.node === "aggregate" && agg.items.map((i) => i.key)).toEqual([
      "dose:2",
      "dose:3",
      "dose:4",
    ]);
  });

  it("never folds a prn-max row and renders it above the dose aggregate", () => {
    const prn = item("prn-max:7", "prn-max");
    expect(isSafetyPinnedItem(prn)).toBe(true);
    const nodes = planBandRender([dose(1), dose(2), dose(3), prn]);
    expect(nodeKinds(nodes)).toEqual(["prn-max:7", "aggregate:dose(3)"]);
  });

  it("never folds a safety-ungated med-safety note", () => {
    const pinned = item("interaction:a-b", "interaction", {
      suppressionPolicy: "safety-ungated",
    });
    const nodes = planBandRender([
      pinned,
      item("interaction:c-d", "interaction"),
      item("pgx:e", "pgx"),
      item("pgx:f", "pgx"),
    ]);
    expect(nodeKinds(nodes)).toEqual([
      "interaction:a-b",
      "aggregate:med-safety(3)",
    ]);
  });

  it("still folds a care-persistent item of a folding domain", () => {
    // carePersistent is "resists an indefinite dismiss", not "must occupy a row";
    // the compaction carve-out is the safety-ungated tier, exactly as the hero's is
    // (#1413-B). Pinned here so weakening or widening the threshold is a decision.
    const persistent = item("interaction:a-b", "interaction", {
      carePersistent: true,
    });
    expect(isSafetyPinnedItem(persistent)).toBe(false);
    const nodes = planBandRender([
      persistent,
      item("interaction:c-d", "interaction"),
      item("pgx:e", "pgx"),
    ]);
    expect(nodeKinds(nodes)).toEqual(["aggregate:med-safety(3)"]);
  });
});

describe("the fold threshold", () => {
  it("leaves a short run of rows alone", () => {
    const short = Array.from({ length: AGGREGATE_MIN_ROWS - 1 }, (_, i) =>
      dose(i + 1)
    );
    expect(nodeKinds(planBandRender(short))).toEqual(short.map((d) => d.key));
  });

  it("folds once the run reaches the threshold", () => {
    const run = Array.from({ length: AGGREGATE_MIN_ROWS }, (_, i) =>
      dose(i + 1)
    );
    expect(nodeKinds(planBandRender(run))).toEqual([
      `aggregate:dose(${AGGREGATE_MIN_ROWS})`,
    ]);
  });

  it("folds each class independently", () => {
    const nodes = planBandRender([
      dose(1),
      dose(2),
      item("interaction:a-b", "interaction"),
      item("interaction:c-d", "interaction"),
      item("pgx:e", "pgx"),
    ]);
    // Two doses stay individual; three med-safety notes fold.
    expect(nodeKinds(nodes)).toEqual([
      "dose:1",
      "dose:2",
      "aggregate:med-safety(3)",
    ]);
  });
});

describe("placement and ordering", () => {
  it("puts each aggregate where its first row was and leaves everything else in place", () => {
    const nodes = planBandRender([
      dose(1),
      dose(2),
      dose(3),
      item("refill:1", "refill"),
      item("illness-care:fever", "illness-care"),
      item("allergy-med:1-2", "allergy-med"),
      item("interaction:a-b", "interaction"),
      item("interaction:c-d", "interaction"),
      item("pgx:e", "pgx"),
      item("appointment:9", "appointment"),
    ]);
    expect(nodeKinds(nodes)).toEqual([
      "aggregate:dose(3)",
      "refill:1",
      "illness-care:fever",
      // #1029: allergy-med keeps its rank ABOVE the med-safety rollup, unfolded.
      "allergy-med:1-2",
      "aggregate:med-safety(3)",
      "appointment:9",
    ]);
  });

  it("never re-sorts: the folded items keep the band's own order", () => {
    const items = [dose(3), dose(1), dose(2)];
    const nodes = planBandRender(items);
    const agg = nodes[0];
    expect(agg.node === "aggregate" && agg.items.map((i) => i.key)).toEqual([
      "dose:3",
      "dose:1",
      "dose:2",
    ]);
  });
});

describe("band scoping", () => {
  it("gives each band its own aggregate — an overdue dose is never folded in with today's", () => {
    const overdue = [1, 2, 3].map((n) =>
      dose(n, { dueDate: "2026-03-01", doseId: n })
    );
    const todays = [4, 5, 6].map((n) => dose(n));
    const bands = groupUpcoming([...overdue, ...todays], TODAY);
    expect(bands.map((b) => b.band)).toEqual(["overdue", "today"]);
    for (const band of bands) {
      const nodes = planBandRender(band.items);
      expect(nodeKinds(nodes)).toEqual(["aggregate:dose(3)"]);
    }
    // Different bands, different item sets — the bands already encode that an
    // overdue dose is more urgent than a not-yet-due one.
    const overdueNode = planBandRender(bands[0].items)[0];
    const todayNode = planBandRender(bands[1].items)[0];
    expect(
      overdueNode.node === "aggregate" && overdueNode.items.map((i) => i.key)
    ).toEqual(["dose:1", "dose:2", "dose:3"]);
    expect(
      todayNode.node === "aggregate" && todayNode.items.map((i) => i.key)
    ).toEqual(["dose:4", "dose:5", "dose:6"]);
  });
});

describe("rendering aggregates, identity does not (#1496)", () => {
  it("hands back the SAME item objects, keys and write targets untouched", () => {
    const a = dose(1, { writeTarget: "item" });
    const b = dose(2);
    const c = dose(3, { suppressible: false });
    const nodes = planBandRender([a, b, c]);
    const agg = nodes[0];
    expect(agg.node).toBe("aggregate");
    if (agg.node !== "aggregate") return;
    // Reference equality: nothing is rebuilt, re-keyed, or stripped on the way in,
    // so every folded row keeps its dedupeKey, its snooze/dismiss and its
    // WriteTarget (a dose confirmed on another member's row still writes to them).
    expect(agg.items[0]).toBe(a);
    expect(agg.items[1]).toBe(b);
    expect(agg.items[2]).toBe(c);
    expect(agg.items.map((i) => i.key)).toEqual(["dose:1", "dose:2", "dose:3"]);
    expect(agg.items[0].writeTarget).toBe("item");
  });

  it("folds no item out of existence: every input row appears exactly once", () => {
    const items = [
      dose(1),
      dose(2),
      dose(3),
      item("prn-max:7", "prn-max"),
      item("interaction:a-b", "interaction"),
      item("interaction:c-d", "interaction"),
      item("pgx:e", "pgx"),
      item("screening:colon", "screening"),
    ];
    const seen: string[] = [];
    for (const node of planBandRender(items)) {
      if (node.node === "item") seen.push(node.item.key);
      else seen.push(...node.items.map((i) => i.key));
    }
    expect(seen.sort()).toEqual(items.map((i) => i.key).sort());
  });
});

describe("the always-present contract (#449 / #1413-B)", () => {
  it("always states the count, in both states", () => {
    // Collapsed or expanded, the summary is the same string — presence and the
    // count never depend on the disclosure being open.
    expect(doseAggregateLabel(12)).toContain("12");
    expect(doseAggregateLabel(12, { scheduled: 21, taken: 9 })).toContain("12");
    expect(medSafetyAggregateLabel(6)).toContain("6");
    expect(aggregateLabel("dose", 4, null)).toContain("4");
    expect(aggregateLabel("med-safety", 4, null)).toContain("4");
  });

  it("prints the taken fraction when the day's progress is known", () => {
    expect(doseAggregateLabel(12, { scheduled: 21, taken: 9 })).toBe(
      "12 doses left · 9 of 21 taken"
    );
    // No denominator ⇒ no fraction, never a "0 of 0".
    expect(doseAggregateLabel(12, { scheduled: 0, taken: 0 })).toBe("12 doses");
    expect(doseAggregateLabel(1)).toBe("1 dose");
  });

  it("names the med-safety rollup by what it spans", () => {
    expect(medSafetyAggregateLabel(6)).toBe("6 medication-safety notes");
    expect(medSafetyAggregateLabel(1)).toBe("1 medication-safety note");
  });

  it("offers the progress fraction only on the Today band", () => {
    expect(bandShowsDoseProgress("today")).toBe(true);
    for (const kind of ["overdue", "week", "later", "flagged", "review"]) {
      expect(bandShowsDoseProgress(kind)).toBe(false);
    }
  });
});

describe("dose progress", () => {
  it("sums the members in view", () => {
    expect(
      sumDoseProgress([
        { scheduled: 8, taken: 5 },
        { scheduled: 6, taken: 4 },
      ])
    ).toEqual({ scheduled: 14, taken: 9 });
    expect(sumDoseProgress([])).toEqual({ scheduled: 0, taken: 0 });
  });
});
