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
  isolatedReadings,
  overLimitHoles,
  trailingOutageCaption,
  unloggedGapLabel,
} from "../trend-sparkline";
import { DENSE_SERIES_POINTS } from "../../components/chart-scaffold";

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
    expect(gapLimitDaysForSeriesKey("result:LDL Cholesterol")).toBe(
      BIO_GAP_LIMIT_DAYS
    );
    expect(gapLimitDaysForSeriesKey("metric:not-a-metric")).toBeNull();
    expect(gapLimitDaysForSeriesKey("ride:1234")).toBeNull();
  });
});

describe("the session-logged tier (#2871)", () => {
  // A metric that accrues from LOGGED SESSIONS is not a device going quiet.
  // The stream tier's 2 days answers "the watch stopped reporting"; asked of
  // outdoor time it answers a different question, and answers it wrongly — an
  // ordinary logging rhythm shattered a 77-day window into eleven grey bands.
  //
  // Owner amendment on #2830 (2026-08-14): a session tier is sanctioned for
  // exactly this, and for nothing wider.

  it("sun sits above the stream, and still inside its continuity span", () => {
    expect(METRIC_GAP_LIMIT_DAYS.sun).toBeGreaterThan(
      METRIC_GAP_LIMIT_DAYS.steps
    );
    // The invariant, restated at the metric that moved: a hole longer than the
    // span the stroke may fairly cross must always be named.
    expect(METRIC_GAP_LIMIT_DAYS.sun).toBeLessThanOrEqual(
      METRIC_CONTINUITY_DAYS.sun
    );
  });

  it("every device-reported metric keeps the stream limit", () => {
    // The half of #2830's ruling that still stands, pinned so the tier cannot
    // widen by accident: a worn or connected device that goes quiet for three
    // days is still three quiet days worth naming.
    const stream = METRIC_GAP_LIMIT_DAYS.steps;
    for (const id of [
      "steps",
      "hr",
      "hrv",
      "resting_hr",
      "hydration",
      "skin-temp",
      "peak-flow",
    ]) {
      expect(METRIC_GAP_LIMIT_DAYS[id], id).toBe(stream);
    }
  });

  it("stops minting a hole every third day on an ordinary rhythm", () => {
    // Eleven weeks, sessions on two days of each — the shape behind the reported
    // screenshot. On the stream limit every one of those ordinary weekday
    // stretches was an outage; on sun's own limit none of them is.
    const rhythm = Array.from({ length: 77 }, (_, i) =>
      i % 7 < 2 ? 45 : null
    );
    const series = days("2026-05-31", rhythm);
    const limit = gapLimitDaysForSeriesKey("metric:sun");
    expect(overLimitHoles(series, 2).length).toBe(11);
    expect(overLimitHoles(series, limit)).toEqual([]);
  });

  it("still names a silence that is long for a session-logged series", () => {
    // Not "never speaks": a fortnight with no outdoor session at all is a real
    // silence, and the band and its count still say so.
    const series = days("2026-05-31", [
      45,
      ...Array.from({ length: 14 }, () => null),
      50,
    ]);
    const holes = overLimitHoles(
      series,
      gapLimitDaysForSeriesKey("metric:sun")
    );
    expect(holes.map((h) => h.days)).toEqual([14]);
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

// ── A READING WITH NO STROKE NEIGHBOUR (#4924) ──────────────────────────────
//
// The predicate that stops a CLUTTER threshold deciding for a reading whose mark
// is its only representation. Its inputs are the render topology the card just
// built — the runs, or the bridging policy — so the answer cannot disagree with
// what was drawn.
describe("isolatedReadings", () => {
  const V = (values: (number | null)[]) => values;

  it.each([
    // [what, values, bridged, runs, isolated indices]
    [
      "an unbridged series: every reading with neither neighbour, ends included",
      V([1, null, null, 4, null, null, 7]),
      false,
      undefined,
      [0, 3, 6],
    ],
    [
      "an unbridged series: calendar-adjacent readings join",
      V([1, 2, null, null, 5, 6]),
      false,
      undefined,
      [],
    ],
    [
      "an unbridged series: one neighbour on either side is enough",
      V([null, 2, 3, null]),
      false,
      undefined,
      [],
    ],
    [
      "a bridged series joins everything, however far apart",
      V([1, null, null, null, null, 6]),
      true,
      undefined,
      [],
    ],
    [
      "a bridged series of exactly one reading",
      V([null, null, 3, null]),
      true,
      undefined,
      [2],
    ],
    [
      "a cut series: the run holding one reading",
      V([1, 2, null, null, null, 6, null, null, null, 10]),
      true,
      [
        [0, 4],
        [5, 8],
        [9, 9],
      ],
      [5, 9],
    ],
    [
      "a cut series: a run with two readings draws its own segment",
      V([1, 2, null, null, 5, 6]),
      true,
      [
        [0, 3],
        [4, 5],
      ],
      [],
    ],
    ["nothing at all", V([null, null]), false, undefined, []],
  ])("%s", (_what, values, bridged, runs, expected) => {
    expect(
      [...isolatedReadings(values, { bridged, runs })].sort((a, b) => a - b)
    ).toEqual(expected);
  });

  it("the August reading the card used to draw as nothing", () => {
    // The reported shape, at the size that produced it: a densely-logged June, an
    // over-limit hole, ONE August reading, and a live outage to today. Thirty-six
    // real readings is above DENSE_SERIES_POINTS, which is exactly why the dot
    // layer had turned itself off over this reading's head.
    const june = Array.from({ length: 36 }, (_, i) => 400 + i);
    const values = [
      ...june,
      ...Array(20).fill(null),
      920,
      ...Array(20).fill(null),
    ];
    expect(june.length).toBeGreaterThan(DENSE_SERIES_POINTS);
    expect([...isolatedReadings(values, { bridged: false })]).toEqual([56]);
  });
});
