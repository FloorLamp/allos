import { describe, expect, it } from "vitest";
import {
  LONG_RANGE_MIN_DAYS,
  MONTH_GRAIN_MIN_DAYS,
  aggregateLongRange,
  longRangeBucketLabel,
  longRangeCaption,
  longRangeGrain,
} from "../long-range-series";
import { shiftDateStr } from "../date";

// #1938: the long-range chart aggregation — the pure decision + computation every
// line chart shares, so a year of daily readings plots as weekly means with a
// spread band instead of the #1932 point-per-day scribble.

// A dense daily series: `days` consecutive readings ending at `end`.
function daily(
  end: string,
  days: number,
  value: (i: number) => number = (i) => 50 + (i % 7)
): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push({ date: shiftDateStr(end, -i), value: value(days - 1 - i) });
  }
  return out;
}

describe("longRangeGrain", () => {
  it("plots raw at or under the threshold, weeks past it, months past ~2 years", () => {
    expect(longRangeGrain(7)).toBeNull();
    expect(longRangeGrain(90)).toBeNull();
    expect(longRangeGrain(LONG_RANGE_MIN_DAYS)).toBeNull();
    expect(longRangeGrain(LONG_RANGE_MIN_DAYS + 1)).toBe("week");
    expect(longRangeGrain(365)).toBe("week");
    expect(longRangeGrain(MONTH_GRAIN_MIN_DAYS)).toBe("week");
    expect(longRangeGrain(MONTH_GRAIN_MIN_DAYS + 1)).toBe("month");
    expect(longRangeGrain(365 * 5)).toBe("month");
  });
});

describe("aggregateLongRange", () => {
  it("returns null for a series every pre-#1938 quick range produces", () => {
    // 90 daily points — dense, but the span is short: already legible.
    expect(aggregateLongRange(daily("2026-07-08", 90))).toBeNull();
    expect(aggregateLongRange([])).toBeNull();
    expect(aggregateLongRange([{ date: "2026-07-08", value: 71 }])).toBeNull();
  });

  it("buckets a year of daily readings into calendar weeks with mean and spread", () => {
    // Constant weekly pattern 50..56 → every FULL week has the same mean/spread.
    const agg = aggregateLongRange(daily("2026-07-08", 365));
    expect(agg).not.toBeNull();
    expect(agg!.grain).toBe("week");
    // 365 consecutive days span 53 or 54 calendar weeks.
    expect(agg!.points.length).toBeGreaterThanOrEqual(53);
    expect(agg!.points.length).toBeLessThanOrEqual(54);
    // Buckets are chronological and start on the week boundary (Sunday default).
    const dates = agg!.points.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
    for (const d of dates) {
      expect(new Date(d + "T00:00:00Z").getUTCDay()).toBe(0);
    }
    // A full interior week: seven readings, mean 53, band 50–56.
    const full = agg!.points.find((p) => p.count === 7)!;
    expect(full.value).toBe(53);
    expect(full.lo).toBe(50);
    expect(full.hi).toBe(56);
    // Every reading lands in exactly one bucket.
    expect(agg!.points.reduce((n, p) => n + p.count, 0)).toBe(365);
  });

  it("honors a non-default week start", () => {
    const agg = aggregateLongRange(daily("2026-07-08", 365), 1);
    for (const p of agg!.points) {
      expect(new Date(p.date + "T00:00:00Z").getUTCDay()).toBe(1); // Monday
    }
  });

  it("steps to month buckets past two years, correctly across a leap year", () => {
    // Three years of daily readings ending mid-2026 — the span covers
    // 2024-02-29, which must land in the 2024-02 bucket and give February 2024
    // its 29th reading.
    const agg = aggregateLongRange(daily("2026-07-08", 365 * 3));
    expect(agg!.grain).toBe("month");
    const feb2024 = agg!.points.find((p) => p.date === "2024-02-01")!;
    expect(feb2024.count).toBe(29);
    const feb2025 = agg!.points.find((p) => p.date === "2025-02-01")!;
    expect(feb2025.count).toBe(28);
    // Month buckets all sit on the first of their month.
    for (const p of agg!.points) {
      expect(p.date.slice(8)).toBe("01");
    }
    expect(agg!.points.reduce((n, p) => n + p.count, 0)).toBe(365 * 3);
  });

  it("leaves a sparse long series raw — weekly weigh-ins are already legible", () => {
    // One reading a week for a year: 52 points in ~52 occupied buckets.
    const weekly: { date: string; value: number }[] = [];
    for (let i = 0; i < 52; i++) {
      weekly.push({
        date: shiftDateStr("2026-07-08", -7 * i),
        value: 80 - i * 0.1,
      });
    }
    weekly.reverse();
    expect(aggregateLongRange(weekly)).toBeNull();
  });

  it("judges density on OCCUPIED buckets, so a gapped dense series still aggregates", () => {
    // Six months of daily readings, a five-month gap, six more months: the span
    // is ~17 months but only ~52 weeks hold data — at ~7 readings each.
    const series = [...daily("2025-07-01", 180), ...daily("2026-07-08", 180)];
    const agg = aggregateLongRange(series);
    expect(agg).not.toBeNull();
    expect(agg!.grain).toBe("week");
    // No bucket is minted for the empty gap weeks.
    const inGap = agg!.points.filter(
      (p) => p.date > "2025-07-05" && p.date < "2026-01-01"
    );
    expect(inGap).toHaveLength(0);
  });

  it("drops null gap markers before bucketing and never averages them", () => {
    const withNulls: { date: string; value: number | null }[] = [];
    for (const p of daily("2026-07-08", 365, () => 60)) {
      withNulls.push(p);
      withNulls.push({ date: p.date, value: null });
    }
    const agg = aggregateLongRange(withNulls);
    expect(agg).not.toBeNull();
    for (const p of agg!.points) {
      expect(p.value).toBe(60);
      expect(p.lo).toBe(60);
      expect(p.hi).toBe(60);
    }
    expect(agg!.points.reduce((n, p) => n + p.count, 0)).toBe(365);
  });

  it("collapses a single-reading bucket's band to the point itself", () => {
    // Dense overall (two readings/day for most days) with one lone-day bucket at
    // the far end keeps aggregation on while producing a count-1 bucket.
    const series = [
      { date: "2025-07-06", value: 42 }, // its own week, alone
      ...daily("2026-07-08", 180, () => 60),
      ...daily("2026-07-08", 180, () => 62),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const agg = aggregateLongRange(series)!;
    const lone = agg.points.find((p) => p.count === 1)!;
    expect(lone.value).toBe(42);
    expect(lone.lo).toBe(42);
    expect(lone.hi).toBe(42);
  });
});

describe("captions and tooltip labels", () => {
  it("names the grain and the band in one shared string per grain", () => {
    expect(longRangeCaption("week")).toContain("Weekly averages");
    expect(longRangeCaption("week")).toContain("low–high");
    expect(longRangeCaption("month")).toContain("Monthly averages");
  });

  it("labels a week bucket by its start and a month bucket by its month", () => {
    expect(longRangeBucketLabel("week", "2026-06-28", "Sunday, June 28")).toBe(
      "Week of Sunday, June 28"
    );
    expect(longRangeBucketLabel("month", "2024-02-01", "unused")).toBe(
      "February 2024"
    );
  });
});
