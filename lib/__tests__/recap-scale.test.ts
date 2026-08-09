// The recap scale axis (#2178): the registry, the calendar period arithmetic, and —
// the part users feel — the REPLACE-NEVER-STACK precedence rule.
//
// The rule under test, stated once:
//
//   At a recap slot, a scale is APPLICABLE when it is at or above the profile's chosen
//   cadence, its calendar period has closed, and this slot is the FIRST one on or after
//   the day it closed. Exactly one recap is sent: the applicable scale with the LONGEST
//   period. The scales it outranks are marked spent for their own period without
//   sending.
//
// The collision this exists to prevent has a name: the quarter-end Sunday. On the first
// recap slot on or after Jan 1 / Apr 1 / Jul 1 / Oct 1, a weekly profile has a week, a
// month AND a quarter closed at once, and must receive ONE message.

import { describe, it, expect } from "vitest";
import {
  RECAP_SCALES,
  firstWeekdayOnOrAfter,
  monthStartOf,
  parseRecapScale,
  planRecapSend,
  quarterStartOf,
  recapScaleEntry,
  recapScaleRank,
  recapScalesAtOrAbove,
  type RecapScale,
} from "@/lib/recap-scale";
import { periodFor, resolveWeekPeriod } from "@/lib/recap";

const SUNDAY = 0;

// A slot context with every knob at its default: a weekly profile, a Sunday slot, no
// markers, rolling weeks. Each test overrides only what it is about.
function slot(over: Partial<Parameters<typeof planRecapSend>[0]> = {}) {
  return planRecapSend({
    floor: "week",
    today: "2026-04-12", // an ordinary Sunday, mid-month, mid-quarter
    weekday: SUNDAY,
    sentPeriodEnd: {},
    resolveWeek: resolveWeekPeriod,
    ...over,
  });
}

describe("the scale registry (#2178)", () => {
  it("declares each scale once, with strictly increasing precedence", () => {
    const scales = RECAP_SCALES.map((e) => e.scale);
    expect(new Set(scales).size).toBe(scales.length);
    const ranks = RECAP_SCALES.map((e) => e.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("gives every scale a noun, an adjective, a label and a blurb", () => {
    for (const e of RECAP_SCALES) {
      expect(e.noun.trim(), e.scale).not.toBe("");
      expect(e.adjective.trim(), e.scale).not.toBe("");
      expect(e.label.trim(), e.scale).not.toBe("");
      expect(e.blurb.trim().length, e.scale).toBeGreaterThan(20);
      expect(e.approxDays, e.scale).toBeGreaterThan(0);
    }
  });

  it("deliberately excludes `year`: the annual retrospective is not a cadence tier", () => {
    // #2179's owner ruling: a profile whose only review arrives every twelve months has
    // no review, and a year does not fit in a message. If `year` ever appears here it
    // is a product decision, not a refactor.
    expect(RECAP_SCALES.map((e) => e.scale)).toEqual([
      "week",
      "month",
      "quarter",
    ]);
  });

  it("reads an unknown stored cadence as `week` rather than silencing the review", () => {
    // The safe direction: an unparseable setting must never move someone to a quieter
    // cadence they did not choose.
    expect(parseRecapScale("month")).toBe("month");
    expect(parseRecapScale("quarter")).toBe("quarter");
    expect(parseRecapScale(null)).toBe("week");
    expect(parseRecapScale(undefined)).toBe("week");
    expect(parseRecapScale("")).toBe("week");
    expect(parseRecapScale("year")).toBe("week");
  });

  it("scopes the eligible set by the cadence floor", () => {
    expect(recapScalesAtOrAbove("week")).toEqual(["week", "month", "quarter"]);
    expect(recapScalesAtOrAbove("month")).toEqual(["month", "quarter"]);
    expect(recapScalesAtOrAbove("quarter")).toEqual(["quarter"]);
  });
});

describe("calendar period arithmetic (#2178)", () => {
  it("anchors months and quarters on the calendar, never on week_mode", () => {
    expect(monthStartOf("2026-04-12")).toBe("2026-04-01");
    expect(quarterStartOf("2026-04-12")).toBe("2026-04-01");
    expect(quarterStartOf("2026-06-30")).toBe("2026-04-01");
    expect(quarterStartOf("2026-12-31")).toBe("2026-10-01");
    expect(quarterStartOf("2026-01-01")).toBe("2026-01-01");
  });

  it("names the last CLOSED month, with its prior month as the comparison", () => {
    const p = periodFor("month", "2026-04-12", "rolling", 0, true);
    expect(p).toMatchObject({
      scale: "month",
      start: "2026-03-01",
      end: "2026-03-31",
      prevStart: "2026-02-01",
      prevEnd: "2026-02-28",
      inProgress: false,
    });
  });

  it("gets February right in a leap year", () => {
    const p = periodFor("month", "2028-03-15", "rolling", 0, true);
    expect(p.start).toBe("2028-02-01");
    expect(p.end).toBe("2028-02-29");
    expect(p.prevEnd).toBe("2028-01-31");
  });

  it("crosses the year boundary in both directions", () => {
    const jan = periodFor("month", "2026-01-20", "rolling", 0, true);
    expect(jan.start).toBe("2025-12-01");
    expect(jan.end).toBe("2025-12-31");
    expect(jan.prevStart).toBe("2025-11-01");

    const q = periodFor("quarter", "2026-01-20", "rolling", 0, true);
    expect(q.start).toBe("2025-10-01");
    expect(q.end).toBe("2025-12-31");
    expect(q.prevStart).toBe("2025-07-01");
    expect(q.prevEnd).toBe("2025-09-30");
  });

  it("gives the card the IN-PROGRESS period through today", () => {
    const p = periodFor("month", "2026-04-12", "rolling", 0, false);
    expect(p).toMatchObject({
      start: "2026-04-01",
      end: "2026-04-12",
      prevStart: "2026-03-01",
      prevEnd: "2026-03-31",
      inProgress: true,
    });
  });

  it("keeps the week scale on the profile's own week definition (#223/#1021)", () => {
    // The week period is still resolveRecapWindow's, byte for byte — the scale axis
    // delegates to it rather than re-deriving a week.
    expect(periodFor("week", "2026-04-12", "rolling", 0, true)).toMatchObject({
      ...resolveWeekPeriod("2026-04-12", "rolling", 0, true),
      scale: "week",
    });
    expect(periodFor("week", "2026-04-12", "calendar", 1, true)).toMatchObject({
      ...resolveWeekPeriod("2026-04-12", "calendar", 1, true),
      scale: "week",
    });
  });

  it("finds the first configured weekday on or after a date, inclusively", () => {
    expect(firstWeekdayOnOrAfter("2026-04-05", SUNDAY)).toBe("2026-04-05");
    expect(firstWeekdayOnOrAfter("2026-04-01", SUNDAY)).toBe("2026-04-05");
    expect(firstWeekdayOnOrAfter("2026-04-01", 3)).toBe("2026-04-01"); // Wed
  });
});

describe("replace, never stack: the precedence rule (#2178)", () => {
  it("sends only the week on an ordinary slot", () => {
    const plan = slot();
    expect(plan.send?.scale).toBe("week");
    expect(plan.spend.map((c) => c.scale)).toEqual(["week"]);
    expect(plan.superseded).toEqual([]);
  });

  it("THE QUARTER-END SUNDAY: three periods close, ONE recap goes out", () => {
    // 2026-04-01 is a Wednesday, so the first Sunday on or after it is 2026-04-05. On
    // that one slot the week, March, and Q1 have all closed. Without the rule this is
    // three messages in one morning — the pile-up the clause exists to prevent.
    const plan = slot({ today: "2026-04-05" });

    expect(plan.send?.scale).toBe("quarter");
    expect(plan.send?.period).toMatchObject({
      start: "2026-01-01",
      end: "2026-03-31",
    });
    // ONE send.
    expect([plan.send].filter(Boolean)).toHaveLength(1);
    // ...and the two it outranked are reported, longest first.
    expect(plan.superseded).toEqual(["month", "week"]);
    // ...and every applicable scale is SPENT for its own period, so none of them
    // re-delivers the same days at the next slot.
    expect(
      Object.fromEntries(plan.spend.map((c) => [c.scale, c.period.end]))
    ).toEqual({
      week: expect.any(String),
      month: "2026-03-31",
      quarter: "2026-03-31",
    });
  });

  it("a month boundary that is not a quarter boundary sends the month", () => {
    // May 1 2026 is a Friday; the first Sunday on or after it is May 3.
    const plan = slot({ today: "2026-05-03" });
    expect(plan.send?.scale).toBe("month");
    expect(plan.send?.period).toMatchObject({
      start: "2026-04-01",
      end: "2026-04-30",
    });
    expect(plan.superseded).toEqual(["week"]);
  });

  it("never sends twice for the same period", () => {
    const first = slot({ today: "2026-04-05" });
    const markers = Object.fromEntries(
      first.spend.map((c) => [c.scale, c.period.end])
    ) as Partial<Record<RecapScale, string>>;
    // The very next tick in the same slot (a retry an hour later) plans nothing.
    const second = slot({ today: "2026-04-05", sentPeriodEnd: markers });
    expect(second.send).toBeNull();
    expect(second.spend).toEqual([]);
  });

  it("does not deliver a stale period at a later slot", () => {
    // A week after the arrival Sunday, March is long spent even with NO marker at all —
    // the first-arrival clause, not the marker, is what bounds it. This is what stops a
    // deploy or a re-enable delivering last quarter's news out of nowhere.
    const plan = slot({ today: "2026-04-12", sentPeriodEnd: {} });
    expect(plan.send?.scale).toBe("week");
    expect(plan.spend.map((c) => c.scale)).toEqual(["week"]);
  });

  it("a monthly profile hears nothing on an ordinary week boundary", () => {
    // The floor is what makes a longer cadence a contact REDUCTION: the week is below
    // it, so its slot passes in silence.
    expect(slot({ floor: "month" }).send).toBeNull();
    expect(slot({ floor: "quarter" }).send).toBeNull();
  });

  it("a monthly profile still gets the quarter when the quarter closes", () => {
    const plan = slot({ floor: "month", today: "2026-04-05" });
    expect(plan.send?.scale).toBe("quarter");
    expect(plan.superseded).toEqual(["month"]);
    expect(plan.spend.map((c) => c.scale)).toEqual(["month", "quarter"]);
  });

  it("a quarterly profile hears only from the quarter", () => {
    expect(slot({ floor: "quarter", today: "2026-05-03" }).send).toBeNull();
    const q = slot({ floor: "quarter", today: "2026-04-05" });
    expect(q.send?.scale).toBe("quarter");
    expect(q.superseded).toEqual([]);
    expect(q.spend.map((c) => c.scale)).toEqual(["quarter"]);
  });

  it("counts sends over a year and never exceeds the slots the user consented to", () => {
    // The reach guarantee, exercised rather than asserted in prose: over a full year of
    // Sunday slots, a weekly profile receives exactly one recap per slot — the monthly
    // and quarterly recaps REPLACE weekly ones instead of adding to them.
    const counts: Record<string, number> = { week: 0, month: 0, quarter: 0 };
    let sent = 0;
    let markers: Partial<Record<RecapScale, string>> = {};
    let day = "2026-01-04"; // the first Sunday of 2026
    let slots = 0;
    while (day < "2027-01-03") {
      const plan = planRecapSend({
        floor: "week",
        today: day,
        weekday: SUNDAY,
        sentPeriodEnd: markers,
        resolveWeek: resolveWeekPeriod,
      });
      slots++;
      if (plan.send) {
        sent++;
        counts[plan.send.scale]++;
        markers = {
          ...markers,
          ...Object.fromEntries(plan.spend.map((c) => [c.scale, c.period.end])),
        };
      }
      const d = new Date(`${day}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 7);
      day = d.toISOString().slice(0, 10);
    }
    expect(slots).toBe(52);
    expect(sent).toBe(52); // never more than one per slot, and never a silent one
    expect(counts.quarter).toBe(4);
    expect(counts.month).toBe(8); // twelve months, four of them absorbed by a quarter
    expect(counts.week).toBe(40);
    expect(counts.week + counts.month + counts.quarter).toBe(slots);
  });

  it("a longer cadence sends strictly fewer times over the same year", () => {
    const run = (floor: RecapScale) => {
      let markers: Partial<Record<RecapScale, string>> = {};
      let day = "2026-01-04";
      let sent = 0;
      while (day < "2027-01-03") {
        const plan = planRecapSend({
          floor,
          today: day,
          weekday: SUNDAY,
          sentPeriodEnd: markers,
          resolveWeek: resolveWeekPeriod,
        });
        if (plan.send) {
          sent++;
          markers = {
            ...markers,
            ...Object.fromEntries(
              plan.spend.map((c) => [c.scale, c.period.end])
            ),
          };
        }
        const d = new Date(`${day}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 7);
        day = d.toISOString().slice(0, 10);
      }
      return sent;
    };
    const week = run("week");
    const month = run("month");
    const quarter = run("quarter");
    expect(week).toBeGreaterThan(month);
    expect(month).toBeGreaterThan(quarter);
    expect(quarter).toBe(4);
  });

  it("keeps the winner total: the longest applicable period always wins", () => {
    // A property rather than an example — with ranks strictly increasing, the reduce
    // has exactly one maximum, so no tie-break rule can ever be needed.
    for (const today of ["2026-04-05", "2026-05-03", "2026-04-12"]) {
      const plan = slot({ today });
      if (!plan.send) continue;
      const best = Math.max(...plan.spend.map((c) => recapScaleRank(c.scale)));
      expect(recapScaleRank(plan.send.scale)).toBe(best);
      expect(recapScaleEntry(plan.send.scale).scale).toBe(plan.send.scale);
    }
  });
});
