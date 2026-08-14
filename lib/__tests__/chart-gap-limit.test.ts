import { describe, expect, it } from "vitest";
import {
  BIO_GAP_LIMIT_DAYS,
  METRIC_CONTINUITY_DAYS,
  METRIC_GAP,
  METRIC_GAP_LIMIT_DAYS,
  gapBreaksPastLimit,
  gapBridgesNulls,
  gapFillValue,
  gapLimitDaysForSeriesKey,
  overLimitHoles,
  trailingOutageCaption,
  unloggedGapLabel,
} from "../trend-sparkline";

// THE GAP LIMIT (issue #2653, states 2, 3 and 4).
//
// One declaration answers two renders that were both silent about the same fact:
// a bridge-declared series drawing a confident stroke across a four-day outage,
// and a trailing hole that the chart drew correctly and never named.
//
// The two things that could make this fix a lie in its own right, and are pinned
// below: LABELLING A HOLE THAT ISN'T ONE (the axis opening before the first
// reading is not a silence), and SILENTLY CHANGING A DECLARED POLICY (only a
// series that opted into "bridge-with-limit" may have its stroke cut).

/** A densified day series: `values[i]` is the value on day `start + i`. */
function days(start: string, values: (number | null)[]) {
  let t = Date.parse(`${start}T00:00:00Z`);
  return values.map((value) => {
    const date = new Date(t).toISOString().slice(0, 10);
    t += 86400000;
    return { date, value };
  });
}

describe("the registry is complete and consistent with its siblings", () => {
  it("declares a limit for exactly the metrics that declare a gap policy", () => {
    expect(Object.keys(METRIC_GAP_LIMIT_DAYS).sort()).toEqual(
      Object.keys(METRIC_GAP).sort()
    );
  });

  it("declares a limit for exactly the metrics that declare a continuity span", () => {
    expect(Object.keys(METRIC_GAP_LIMIT_DAYS).sort()).toEqual(
      Object.keys(METRIC_CONTINUITY_DAYS).sort()
    );
  });

  it("never lets a hole outlast the span the stroke may fairly cross", () => {
    // The invariant that keeps the two registries related instead of merely
    // coexisting: a hole longer than the continuity span is one the stroke should
    // never have crossed, so it must ALWAYS be named.
    for (const [id, limit] of Object.entries(METRIC_GAP_LIMIT_DAYS)) {
      expect(
        limit,
        `${id}: a gap limit above its continuity span would leave holes the ` +
          `stroke may not fairly cross going unnamed`
      ).toBeLessThanOrEqual(METRIC_CONTINUITY_DAYS[id]);
    }
    expect(BIO_GAP_LIMIT_DAYS).toBeLessThanOrEqual(540);
  });

  it("every limit is a positive whole number of days", () => {
    for (const [id, limit] of Object.entries(METRIC_GAP_LIMIT_DAYS)) {
      expect(Number.isInteger(limit), `${id}`).toBe(true);
      expect(limit, `${id}`).toBeGreaterThan(0);
    }
  });

  it("answers by series key, and says nothing for a grain it cannot name", () => {
    expect(gapLimitDaysForSeriesKey("metric:mood")).toBe(
      METRIC_GAP_LIMIT_DAYS.mood
    );
    expect(gapLimitDaysForSeriesKey("bio:LDL Cholesterol")).toBe(
      BIO_GAP_LIMIT_DAYS
    );
    expect(gapLimitDaysForSeriesKey("metric:not-a-metric")).toBeNull();
    expect(gapLimitDaysForSeriesKey("ride:1234")).toBeNull();
  });
});

describe("bridge-with-limit is opt-in and changes nothing else", () => {
  it("only the daily check-ins opted in", () => {
    const optedIn = Object.entries(METRIC_GAP)
      .filter(([, gap]) => gap === "bridge-with-limit")
      .map(([id]) => id)
      .sort();
    expect(optedIn).toEqual(["calm", "energy", "mood"]);
  });

  it("a plain bridge still never breaks, however long the hole", () => {
    // Owner call 2: a declared policy is never silently changed. Weight declares
    // a limit — its long holes get NAMED — but its stroke keeps crossing them.
    expect(gapBreaksPastLimit(METRIC_GAP.weight)).toBe(false);
    expect(gapBridgesNulls(METRIC_GAP.weight)).toBe(true);
  });

  it("an opted-in series still bridges its SHORT holes", () => {
    // The limit cuts the long runs out of the plotted series; what survives is
    // drawn bridged, which is why this stays true.
    expect(gapBridgesNulls("bridge-with-limit")).toBe(true);
    expect(gapBreaksPastLimit("bridge-with-limit")).toBe(true);
  });

  it("densifies the same way a plain bridge does", () => {
    // A missing check-in day is "not logged", never a zero — the new policy must
    // not have quietly acquired a different fill.
    expect(gapFillValue("bridge-with-limit")).toBe(gapFillValue("bridge"));
  });
});

describe("overLimitHoles", () => {
  it("finds an interior run longer than the limit", () => {
    // Two readings with four unlogged days between them.
    const series = days("2026-08-01", [3, null, null, null, null, 4]);
    expect(overLimitHoles(series, 2)).toEqual([
      {
        from: "2026-08-02",
        to: "2026-08-05",
        days: 4,
        trailing: false,
      },
    ]);
  });

  it("leaves a run AT the limit alone", () => {
    // The limit is the longest run that may pass unremarked, so it is a strict
    // `>`. Two unlogged days on a check-in series is a skipped weekend.
    const series = days("2026-08-01", [3, null, null, 4]);
    expect(overLimitHoles(series, 2)).toEqual([]);
  });

  it("never calls the run before the first reading a hole", () => {
    // The window opened before the series did. That is an axis fact, not a
    // silence, and labelling it would put a gap caption on the left edge of every
    // chart whose range predates its data.
    const series = days("2026-08-01", [null, null, null, null, 5, 6]);
    expect(overLimitHoles(series, 2)).toEqual([]);
  });

  it("marks a run that reaches the window's end as trailing", () => {
    const series = days("2026-08-01", [3, 4, null, null, null, null]);
    expect(overLimitHoles(series, 2)).toEqual([
      {
        from: "2026-08-03",
        to: "2026-08-06",
        days: 4,
        trailing: true,
      },
    ]);
  });

  it("reports an interior hole and a live one separately", () => {
    const series = days("2026-08-01", [
      3,
      null,
      null,
      null,
      4,
      null,
      null,
      null,
    ]);
    const holes = overLimitHoles(series, 2);
    expect(holes.map((h) => h.trailing)).toEqual([false, true]);
    expect(holes.map((h) => h.days)).toEqual([3, 3]);
  });

  it("says nothing when the series declares no limit", () => {
    const series = days("2026-08-01", [3, null, null, null, null, 4]);
    expect(overLimitHoles(series, null)).toEqual([]);
  });

  it("finds no hole in a series with no holes", () => {
    expect(overLimitHoles(days("2026-08-01", [1, 2, 3]), 2)).toEqual([]);
  });

  it("finds no hole in a series with no readings at all", () => {
    expect(overLimitHoles(days("2026-08-01", [null, null, null]), 0)).toEqual(
      []
    );
  });
});

describe("the words a hole gets", () => {
  it("states the count and the plainest word for what did not happen", () => {
    expect(unloggedGapLabel(4)).toBe("4 days unlogged");
    expect(unloggedGapLabel(1)).toBe("1 day unlogged");
  });

  it("says when the silence started, and claims nothing beyond that", () => {
    expect(trailingOutageCaption("Aug 8")).toBe("No data since Aug 8");
  });

  it("spends no words on policy, apology or advice", () => {
    // The caption is user-facing copy in a health app: plain and short. This is a
    // real failure mode for an honesty state — the sentence explaining a
    // degenerate chart grows into a paragraph that makes the chart look MORE
    // considered than the confident line it replaced.
    for (const copy of [unloggedGapLabel(4), trailingOutageCaption("Aug 8")]) {
      expect(copy.length).toBeLessThanOrEqual(24);
      expect(copy).not.toMatch(
        /insufficient|unavailable|unfortunately|please|note that|cannot|in order to/i
      );
    }
  });
});
