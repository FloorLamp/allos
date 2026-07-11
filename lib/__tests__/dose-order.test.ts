import { describe, it, expect } from "vitest";
import {
  compareDoseDay,
  doseSortKey,
  compareSortHint,
  type DoseDayEntry,
} from "../dose-order";
import { timeBucket, TIME_BUCKETS } from "../supplement-schedule";

// A dose-day fixture that mixes buckets, priorities, stacks and names so every
// tier of the comparator is exercised. Deliberately shuffled so an alphabetical
// (title-only) sort would give the WRONG answer — the #297 bug.
const FIXTURE: DoseDayEntry[] = [
  { timeOfDay: "bedtime", priority: "low", stack: null, name: "Melatonin" },
  { timeOfDay: "morning", priority: "low", stack: null, name: "Zinc" },
  { timeOfDay: "morning", priority: "mandatory", stack: null, name: "Aspirin" },
  {
    timeOfDay: "with dinner",
    priority: "high",
    stack: null,
    name: "Magnesium",
  },
  {
    timeOfDay: "morning",
    priority: "high",
    stack: "D3 + K2",
    name: "Vitamin K2",
  },
  {
    timeOfDay: "morning",
    priority: "high",
    stack: "D3 + K2",
    name: "Vitamin D3",
  },
  { timeOfDay: "morning", priority: "high", stack: null, name: "Fish Oil" },
];

describe("doseSortKey / compareDoseDay", () => {
  it("orders bucket → priority → stack → name (not alphabetical)", () => {
    const ordered = [...FIXTURE].sort(compareDoseDay).map((e) => e.name);
    expect(ordered).toEqual([
      // Morning bucket, mandatory first
      "Aspirin",
      // Morning, high: stacked members cluster (stack < unstacked "~"), and
      // within the stack the names sort (D3 before K2).
      "Vitamin D3",
      "Vitamin K2",
      "Fish Oil",
      // Morning, low
      "Zinc",
      // Evening ("with dinner") bucket
      "Magnesium",
      // Bedtime ("Before sleep") bucket
      "Melatonin",
    ]);
  });

  it("groups every dose under its time bucket before any name tiebreak", () => {
    const ordered = [...FIXTURE].sort(compareDoseDay);
    const bucketSeq = ordered.map((e) =>
      TIME_BUCKETS.indexOf(timeBucket(e.timeOfDay))
    );
    // Bucket ranks are non-decreasing across the whole sorted list — i.e. no
    // bedtime dose ever appears before a morning one (the reported bug).
    for (let i = 1; i < bucketSeq.length; i++) {
      expect(bucketSeq[i]).toBeGreaterThanOrEqual(bucketSeq[i - 1]);
    }
  });

  it("sort key is a stable string usable as a lexical tiebreak", () => {
    const a: DoseDayEntry = {
      timeOfDay: "morning",
      priority: "high",
      stack: null,
      name: "Fish Oil",
    };
    const b: DoseDayEntry = {
      timeOfDay: "bedtime",
      priority: "mandatory",
      stack: null,
      name: "Aspirin",
    };
    // Morning sorts before bedtime even though bedtime's priority/name are lower.
    expect(compareSortHint(doseSortKey(a), doseSortKey(b))).toBeLessThan(0);
  });

  it("compareSortHint treats undefined/empty as a tie (non-dose domains unaffected)", () => {
    expect(compareSortHint(undefined, undefined)).toBe(0);
    expect(compareSortHint("", "")).toBe(0);
    // A dose key always sorts against an empty hint deterministically.
    expect(compareSortHint("00stack", "")).toBeGreaterThan(0);
  });
});

// The #297 acceptance: /medicine's due-today section and the Upcoming/attention
// surfaces must order the SAME dose day identically. Here we reproduce each
// surface's own sorting path over one fixture and assert the flattened order
// matches — the one-question-one-computation guarantee.
describe("dose-day order is identical on both surfaces", () => {
  // /medicine: group by bucket, sort each bucket with the shared comparator, then
  // concatenate buckets in TIME_BUCKETS order (how the page renders its sections).
  function medicineOrder(entries: DoseDayEntry[]): string[] {
    const byBucket = new Map<string, DoseDayEntry[]>();
    for (const e of entries) {
      const b = timeBucket(e.timeOfDay);
      (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(e);
    }
    const out: string[] = [];
    for (const bucket of TIME_BUCKETS) {
      const arr = byBucket.get(bucket);
      if (!arr) continue;
      arr.sort(compareDoseDay);
      out.push(...arr.map((e) => e.name));
    }
    return out;
  }

  // Upcoming/attention: a FLAT list carrying doseSortKey as its sortHint, sorted
  // by the sortHint tiebreak then title (mirrors groupUpcoming/buildAttention).
  function upcomingOrder(entries: DoseDayEntry[]): string[] {
    return entries
      .map((e) => ({ sortHint: doseSortKey(e), title: e.name }))
      .sort(
        (a, b) =>
          compareSortHint(a.sortHint, b.sortHint) ||
          a.title.localeCompare(b.title)
      )
      .map((x) => x.title);
  }

  it("same fixture, same order", () => {
    expect(upcomingOrder(FIXTURE)).toEqual(medicineOrder(FIXTURE));
  });
});
