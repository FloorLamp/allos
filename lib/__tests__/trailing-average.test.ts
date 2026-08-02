import { describe, expect, it } from "vitest";
import { trailingAverage } from "@/lib/trailing-average";
import { summarizeStepsToday, STEPS_TRAILING_DAYS } from "@/lib/steps-today";
import { bodyMetricPeriodStats } from "@/lib/trends-body-metrics";

// Pure tier: the ONE trailing-average computation (#1909) and the two surfaces that
// used to carry their own. Three groups:
//   1. the option matrix — basis × today-inclusion × gaps;
//   2. the #221 pin — both surfaces' rendered numbers ARE this helper's output;
//   3. the partial-today regression — the defect the issue was filed for.

const TODAY = "2026-07-23";

// A value-per-day series over `dates`, ascending.
function series(
  entries: [string, number][]
): { date: string; value: number }[] {
  return entries.map(([date, value]) => ({ date, value }));
}

// N consecutive days ending on `end` (inclusive), each carrying `value`.
function daily(
  end: string,
  count: number,
  value: (dayIndex: number) => number
): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    out.push({ date: d.toISOString().slice(0, 10), value: value(i) });
  }
  return out;
}

describe("trailingAverage — the declared option surface (#1909)", () => {
  // Seven consecutive complete days (17th–22nd is six; the 16th makes seven) plus a
  // today reading that is deliberately far from the rest.
  const CONSECUTIVE = series([
    ["2026-07-15", 1000],
    ["2026-07-16", 2000],
    ["2026-07-17", 3000],
    ["2026-07-18", 4000],
    ["2026-07-19", 5000],
    ["2026-07-20", 6000],
    ["2026-07-21", 7000],
    ["2026-07-22", 8000],
    [TODAY, 100],
  ]);

  it("excludes today by DEFAULT, on either basis", () => {
    const calendar = trailingAverage(CONSECUTIVE, TODAY, {
      days: 7,
      basis: "calendar",
    });
    const dataBearing = trailingAverage(CONSECUTIVE, TODAY, {
      days: 7,
      basis: "data-bearing",
    });
    // Both land on the 16th–22nd: seven complete days, today's 100 nowhere in them.
    expect(calendar.from).toBe("2026-07-16");
    expect(calendar.to).toBe("2026-07-22");
    expect(calendar.average).toBe(5000);
    expect(dataBearing.from).toBe("2026-07-16");
    expect(dataBearing.to).toBe("2026-07-22");
    expect(dataBearing.average).toBe(5000);
  });

  it("includes today only when asked, and then the window slides forward a day", () => {
    const calendar = trailingAverage(CONSECUTIVE, TODAY, {
      days: 7,
      basis: "calendar",
      includeToday: true,
    });
    // The 17th–23rd: seven days ending TODAY, so the oldest day drops out.
    expect(calendar.from).toBe("2026-07-17");
    expect(calendar.to).toBe(TODAY);
    expect(calendar.count).toBe(7);
    expect(calendar.average).toBe(
      (3000 + 4000 + 5000 + 6000 + 7000 + 8000 + 100) / 7
    );

    const dataBearing = trailingAverage(CONSECUTIVE, TODAY, {
      days: 7,
      basis: "data-bearing",
      includeToday: true,
    });
    expect(dataBearing.points.map((p) => p.date)).toEqual(
      calendar.points.map((p) => p.date)
    );
  });

  // ── Gaps: the whole reason the two bases are not interchangeable ────────────
  const GAPPY = series([
    ["2026-07-04", 10],
    ["2026-07-05", 20],
    ["2026-07-06", 30],
    ["2026-07-20", 40],
    ["2026-07-22", 50],
  ]);

  it("data-bearing reaches BACK across a gap to keep the sample size", () => {
    const w = trailingAverage(GAPPY, TODAY, { days: 4, basis: "data-bearing" });
    // Four readings, however far back they sit: the 6th, 20th and 22nd plus the 5th.
    expect(w.count).toBe(4);
    expect(w.from).toBe("2026-07-05");
    expect(w.to).toBe("2026-07-22");
    expect(w.average).toBe((20 + 30 + 40 + 50) / 4);
  });

  it("calendar SHRINKS the sample across the same gap", () => {
    const w = trailingAverage(GAPPY, TODAY, { days: 4, basis: "calendar" });
    // The 19th–22nd holds only two readings; the mean is over those two.
    expect(w.count).toBe(2);
    expect(w.from).toBe("2026-07-20");
    expect(w.to).toBe("2026-07-22");
    expect(w.average).toBe(45);
  });

  it("reports an empty sample rather than a zero average", () => {
    expect(trailingAverage([], TODAY, { days: 7, basis: "calendar" })).toEqual({
      points: [],
      count: 0,
      from: null,
      to: null,
      average: null,
    });
    // A calendar window whose span holds nothing, though the series has history.
    const OLD_ONLY = GAPPY.filter((p) => p.date < "2026-07-10");
    const stale = trailingAverage(OLD_ONLY, TODAY, {
      days: 7,
      basis: "calendar",
    });
    expect(stale.count).toBe(0);
    expect(stale.average).toBeNull();
    // …where the data-bearing basis still answers, from further back.
    expect(
      trailingAverage(OLD_ONLY, TODAY, { days: 2, basis: "data-bearing" })
        .average
    ).toBe(25);
  });

  it("never counts a future-dated reading in a TRAILING window", () => {
    const withFuture = [...CONSECUTIVE, { date: "2026-08-01", value: 99999 }];
    const w = trailingAverage(withFuture, TODAY, {
      days: 7,
      basis: "data-bearing",
      includeToday: true,
    });
    expect(w.to).toBe(TODAY);
    expect(w.points.some((p) => p.date > TODAY)).toBe(false);
  });

  it("returns the sample ascending regardless of the input's order", () => {
    const shuffled = [...GAPPY].reverse();
    expect(
      trailingAverage(shuffled, TODAY, { days: 4, basis: "data-bearing" })
        .points
    ).toEqual(
      trailingAverage(GAPPY, TODAY, { days: 4, basis: "data-bearing" }).points
    );
  });

  it("keeps the average UNROUNDED — rounding is each surface's business", () => {
    const w = trailingAverage(
      series([
        ["2026-07-20", 1],
        ["2026-07-21", 1],
        ["2026-07-22", 2],
      ]),
      TODAY,
      { days: 7, basis: "calendar" }
    );
    expect(w.average).toBeCloseTo(4 / 3, 12);
  });
});

// ── The #221 pin ────────────────────────────────────────────────────────────────
// Both surfaces' numbers must BE the helper's output. A future third caller that
// grows its own average shows up here as a disagreement, not as a support ticket.
describe("both '7-day average' surfaces delegate to the one helper (#221/#1909)", () => {
  const POINTS = series([
    ["2026-07-14", 6200],
    ["2026-07-16", 7000],
    ["2026-07-17", 8100],
    ["2026-07-19", 9400],
    ["2026-07-20", 6600],
    ["2026-07-21", 10200],
    ["2026-07-22", 7700],
    [TODAY, 3100],
  ]);

  it("the dashboard card's average IS the data-bearing window, today excluded", () => {
    const helper = trailingAverage(POINTS, TODAY, {
      days: STEPS_TRAILING_DAYS,
      basis: "data-bearing",
    });
    const summary = summarizeStepsToday(POINTS, TODAY)!;
    expect(summary.average7).toBe(Math.round(helper.average!));
    // …and the delta the arrow renders is measured against exactly that baseline.
    expect(summary.deltaPct).toBe(
      Math.round(((3100 - summary.average7!) / summary.average7!) * 100)
    );
    expect(summary.direction).toBe("down");
  });

  it("the detail card's average IS the calendar window, today excluded", () => {
    const stats = bodyMetricPeriodStats(POINTS, TODAY, 0);
    const sevenDay = stats.find((s) => s.windows.includes(7))!;
    const helper = trailingAverage(POINTS, TODAY, {
      days: 7,
      basis: "calendar",
    });
    expect(sevenDay.avg).toBe(Number(helper.average!.toFixed(0)));
    expect(sevenDay.count).toBe(helper.count);
    expect(sevenDay.from).toBe(helper.from);
    expect(sevenDay.to).toBe(helper.to);
  });

  it("the two surfaces still differ — by the DECLARED basis, not by accident", () => {
    const summary = summarizeStepsToday(POINTS, TODAY)!;
    const sevenDay = bodyMetricPeriodStats(POINTS, TODAY, 0).find((s) =>
      s.windows.includes(7)
    )!;
    // The card reaches back to the 14th for a seventh reading; the calendar window
    // stops on the 16th and averages six. Different questions, different numbers —
    // which is why the two labels can no longer both read "7-day average".
    expect(summary.average7).not.toBe(sevenDay.avg);
    expect(sevenDay.count).toBe(6);
  });
});

// ── The partial-today regression ────────────────────────────────────────────────
describe("a half-finished today does not move the averages (#1909 defect 1)", () => {
  // Twelve complete days at a steady 10,000 steps, then today at 4,000 — the 2pm
  // state of an ordinary day. Before the fix the 7d average read 9,142 at 2pm and
  // 10,000 again at midnight, having moved only because the clock did.
  const COMPLETE = daily("2026-07-22", 12, () => 10000);
  const WITH_PARTIAL_TODAY = [...COMPLETE, { date: TODAY, value: 4000 }];

  it("the detail page's 7d average is identical with and without today's partial", () => {
    const before = bodyMetricPeriodStats(COMPLETE, TODAY, 0);
    const after = bodyMetricPeriodStats(WITH_PARTIAL_TODAY, TODAY, 0);
    const avg = (stats: typeof before) =>
      stats.find((s) => s.windows.includes(7))!.avg;
    expect(avg(after)).toBe(10000);
    expect(avg(after)).toBe(avg(before));
  });

  it("holds for the wider windows too, and for the range and change", () => {
    const stats = bodyMetricPeriodStats(WITH_PARTIAL_TODAY, TODAY, 0);
    // Twelve complete days: the 7d window holds seven of them, 30d and 90d all
    // twelve — so the collapse leaves two cards, and neither moves for today.
    expect(stats.map((s) => s.count)).toEqual([7, 12]);
    for (const s of stats) {
      expect(s.avg).toBe(10000);
      expect(s.min).toBe(10000);
      expect(s.max).toBe(10000);
      expect(s.delta).toBe(0);
      // The window stops at yesterday, so today is not in the count or the span.
      expect(s.to).toBe("2026-07-22");
    }
  });

  it("still shows today's reading as Latest — recency is today's job", () => {
    const stats = bodyMetricPeriodStats(WITH_PARTIAL_TODAY, TODAY, 0);
    expect(stats.map((s) => s.latest)).toEqual(stats.map(() => 4000));
  });

  it("summarises nothing until a day is complete", () => {
    // A first-ever reading, logged today: there is no complete day to average, and
    // the card says so instead of averaging a day that is still running.
    const stats = bodyMetricPeriodStats(
      [{ date: TODAY, value: 4000 }],
      TODAY,
      0
    );
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ count: 0, avg: null, latest: null });
  });
});
