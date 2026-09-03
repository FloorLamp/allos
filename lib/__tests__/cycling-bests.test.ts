// THE CROSS-RIDE COMPARISON (#3195) — the pure rule, and the sentences hanging
// off it. The DB tier (lib/__db_tests__/ride-bests.test.ts) owns the two
// properties that are about the READ: as-of rather than current-state, and never
// a stream parse.
//
// WHAT THIS FILE IS BUILT AROUND: "ever" must mean what it says. The failure this
// feature is most able to commit is a celebration that reads as a lifetime claim
// while resting on four rides (#2385), so the thin-history and empty cases are
// first-class cases here rather than an afterthought.

import { describe, expect, it } from "vitest";
import { comparableSplits, distanceSplits } from "../cycling-analytics";
import {
  bestRankMarker,
  comparedWindowText,
  rideBestHeadline,
  rideBests,
  rideBestStatementDetail,
  segmentPrStatement,
  type PriorRide,
} from "../cycling-bests";

const curve = (...watts: number[]) =>
  watts.map((value, index) => ({
    seconds: [5, 120, 2700][index]!,
    watts: value,
  }));
const splits = (...times: number[]) =>
  times.map((timeSec, index) => ({ index: index + 1, timeSec }));
const prior = (
  powerCurve: PriorRide["powerCurve"],
  splitTimesSec: number[] = []
): PriorRide => ({ powerCurve, splitTimesSec });

describe("rideBests", () => {
  // The issue's own acceptance case is the second row: the second ride beats only
  // the 2-minute duration, so exactly that duration is marked.
  it.each([
    ["a first place at every duration", curve(400, 300, 120), [1, 1, 1]],
    [
      "only the 2-minute duration a first",
      curve(300, 300, 90),
      [undefined, 1, 3],
    ],
    ["a tie sharing first place", curve(350, 250, 100), [1, 2, 1]],
    [
      "nothing inside the top three",
      curve(1, 1, 1),
      [undefined, undefined, undefined],
    ],
  ])("marks %s", (_label, ride, expected) => {
    const priors = [
      prior(curve(350, 250, 100)),
      prior(curve(340, 260, 95)),
      prior(curve(330, 240, 90)),
      prior(curve(320, 230, 85)),
    ];
    const bests = rideBests({ powerCurve: ride, splits: [] }, priors);
    expect(
      [5, 120, 2700].map(
        (seconds) =>
          bests.power.find((entry) => entry.seconds === seconds)?.rank
      )
    ).toEqual(expected);
  });

  it("ranks a split against the priors AND the ride's own other splits", () => {
    const bests = rideBests({ powerCurve: [], splits: splits(600, 590, 900) }, [
      prior([], [700, 800]),
    ]);
    // 590 is the fastest of all five efforts, 600 the second; 900 is fourth and
    // past the marker depth.
    expect(bests.splits).toEqual([
      { index: 1, rank: 2 },
      { index: 2, rank: 1 },
    ]);
  });

  // "EVER" IS "SINCE POWER DATA EXISTS", AND A RIDE WITH NO PRIORS SAYS SO. Every
  // row would otherwise rank first, which reads as an achievement and is only a
  // statement that nothing came before it.
  it.each([
    ["no priors at all", [] as PriorRide[], 1, 1],
    ["priors that recorded neither", [prior([], [])], 1, 1],
    // A GPS-only prior is part of the split population and NOT the power one — the
    // over-claim this feature exists not to make.
    ["a prior with splits but no watts", [prior([], [900])], 1, 2],
  ])("earns no markers with %s", (_label, priors, powerRides, splitRides) => {
    const bests = rideBests(
      { powerCurve: curve(400), splits: splits(600) },
      priors
    );
    expect(bests.power).toEqual([]);
    expect(bests.comparedPowerRides).toBe(powerRides);
    expect(bests.comparedSplitRides).toBe(splitRides);
  });

  it("counts the population per kind, never once for the ride", () => {
    const bests = rideBests({ powerCurve: curve(400), splits: splits(600) }, [
      prior(curve(300), [700]),
      prior(curve(310)),
      prior([], [800]),
    ]);
    expect(bests.comparedPowerRides).toBe(3);
    expect(bests.comparedSplitRides).toBe(3);
  });

  it("reports zero of a kind the ride never recorded", () => {
    const bests = rideBests({ powerCurve: [], splits: splits(600) }, [
      prior(curve(300), [700]),
    ]);
    expect(bests.comparedPowerRides).toBe(0);
    expect(bests.power).toEqual([]);
    expect(bests.comparedSplitRides).toBe(2);
  });
});

describe("the sentences", () => {
  it.each([
    [0, "power", null],
    [1, "power", "First ride with recorded power."],
    [2, "power", "Compared with 1 earlier ride with recorded power."],
    [4, "power", "Compared with 3 earlier rides with recorded power."],
    [1, "splits", "First ride with recorded splits."],
    [4, "splits", "Compared with 3 earlier rides with recorded splits."],
  ] as const)("states the window for %i %s rides", (count, noun, expected) => {
    expect(comparedWindowText(count, noun)).toBe(expected);
  });

  it("stops the markers at third", () => {
    expect([1, 2, 3].map((rank) => bestRankMarker(rank as 1 | 2 | 3))).toEqual([
      "Best",
      "2nd",
      "3rd",
    ]);
  });

  it("names the LONGEST power duration won, with the population it beat", () => {
    const ride = { powerCurve: curve(400, 300, 120), splits: splits(600) };
    const bests = rideBests(ride, [
      prior(curve(350, 250, 100), [700]),
      prior(curve(340, 260, 95), [800]),
    ]);
    const headline = rideBestHeadline(ride, bests)!;
    expect(headline).toEqual({
      kind: "power",
      seconds: 2700,
      watts: 120,
      comparedRides: 3,
    });
    expect(rideBestStatementDetail("45 min power", headline)).toBe(
      "Best 45 min power of 3 rides with recorded power"
    );
  });

  it("falls back to the fastest split when no power duration was won", () => {
    const ride = { powerCurve: curve(1, 1, 1), splits: splits(600) };
    const bests = rideBests(ride, [
      prior(curve(350, 250, 100), [700]),
      prior(curve(340, 260, 95), [800]),
    ]);
    expect(rideBestHeadline(ride, bests)).toEqual({
      kind: "split",
      index: 1,
      timeSec: 600,
      comparedRides: 3,
    });
  });

  // THE FIRST RIDE CELEBRATES NOTHING. `comparedRides === 1` is a ride with no
  // priors, where every row ranks first and "best" would only mean "only".
  it.each([
    ["the first ride with power", [] as PriorRide[]],
    ["a ride that won nothing", [prior(curve(900, 900, 900), [1])]],
  ])("earns no statement for %s", (_label, priors) => {
    const ride = { powerCurve: curve(400, 300, 120), splits: splits(600) };
    expect(rideBestHeadline(ride, rideBests(ride, priors))).toBeNull();
  });

  it.each([
    [[], null],
    [["Berry descent"], { value: "Berry descent", detail: "Segment PR" }],
    [
      ["Berry descent", "Sandy Hill"],
      { value: "2 segments", detail: "Segment PRs: Berry descent, Sandy Hill" },
    ],
  ] as const)("states %j as the segment line", (names, expected) => {
    expect(segmentPrStatement(names)).toEqual(expected);
  });
});

// THE SPLIT A RIDE ACTUALLY COVERED. A split is measured between two SAMPLES, so
// one that overshoots its boundary starts the next past it and leaves it short of
// the nominal interval — a per-split `distanceM >= intervalM` test then drops
// splits the ride plainly rode. The counts below are what that test kept.
describe("comparableSplits", () => {
  const constantSpeedRide = (
    speedMps: number,
    sampleSec: number,
    totalM: number
  ) => {
    const samples = Math.floor(totalM / (speedMps * sampleSec)) + 1;
    const time = Array.from({ length: samples }, (_, i) => i * sampleSec);
    return {
      time: { data: time },
      distance: { data: time.map((seconds) => seconds * speedMps) },
    };
  };

  it.each([
    // speed m/s, sample s, total m, full 5 km splits the ride contains
    [7, 1, 42000, 8],
    [8.3, 1, 60000, 12],
    [7, 5, 42000, 8],
    [5, 2, 20000, 4],
  ])(
    "keeps every full split at %i m/s and %i s sampling",
    (speedMps, sampleSec, totalM, expected) => {
      const all = distanceSplits(
        constantSpeedRide(speedMps, sampleSec, totalM),
        5000
      );
      const kept = comparableSplits(all, 5000);
      expect(kept).toHaveLength(expected);
      // And the run-out, when there is one, is not a candidate for "fastest 5 km".
      expect(all.length - kept.length).toBe(all.length > expected ? 1 : 0);
    }
  );
});
