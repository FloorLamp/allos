// THE COMPARISON ACROSS RIDES (#3195). Allos computed every ride's power curve
// and distance splits and compared them with nothing: the number rendered, the
// comparison did not, and a ride that set a lifetime best looked identical to any
// other ride.
//
// This is the one pure rule that turns a ride's own numbers plus its predecessors'
// cached summaries into a rank per row. No DB, no clock, no formatting — the query
// layer supplies the priors and the surfaces state the verdict.
//
// THREE THINGS THIS MODULE IS BUILT NOT TO GET WRONG:
//
// 1. "EVER" MEANS WHAT IT SAYS. The comparison can only see rides that recorded
//    streams, which on a real profile is a recent slice of a much longer history
//    (the owner's 2015-era rides carry estimated power and no streams at all). So
//    this module never emits the word: it returns the size of the population it
//    actually ranked within, per kind, and every surface states that number.
//    #2385 calls the alternative a DECEPTIVE SUCCESS — a celebration that reads as
//    a lifetime claim while resting on four rides — and it is the failure mode this
//    feature is most able to commit.
//
// 2. AS OF THAT RIDE, NOT AS OF NOW. `priors` is the caller's promise that it
//    holds the rides BEFORE this one and no others. A medal is a fact about what a
//    ride earned on the day, so an old ride's page must keep saying what it earned
//    after a later ride beats it. Ranking against current state instead would make
//    every historical page silently rewrite itself, and nothing would go red.
//
// 3. THE PRIORS ARE CACHED SUMMARIES, NEVER STREAMS. The shape of `PriorRide` is
//    exactly what `stream_summary_json` already stores (lib/cycling-stream-summary.ts),
//    and it is deliberately too narrow to hold a stream — a read path that wanted
//    to parse one could not hand the result to this function.
//
// TIES SHARE A RANK. `rank = 1 + (how many are strictly better)`, so equalling the
// best ever ranks first, and two efforts that tie print the same marker. The
// alternative needs a tie-break, and the only ones available here (declaration
// order, ride id) are arbitrary — a rule whose expected answer is also what
// ordering alone produces is a rule no test can really check.

import type { SessionDistanceSplit } from "./cycling-analytics";

// How deep the markers go. Strava shows three; past third place a row is just a
// row, and a table of medals says nothing.
export const BEST_RANK_DEPTH = 3;

export type BestRank = 1 | 2 | 3;

// One earlier ride's contribution, read from its cached summary. Both fields are
// candidate POOLS rather than single values: a ride offers its per-duration power
// maximum (already reduced at ingest) and every full-interval split it recorded.
export interface PriorRide {
  powerCurve: readonly { seconds: number; watts: number }[];
  splitTimesSec: readonly number[];
}

export interface RideBests {
  // The population each kind was ranked within, INCLUDING this ride. 1 means this
  // is the first ride with data of that kind and nothing was compared; 0 means the
  // ride has none of it.
  //
  // COUNTED PER KIND, not once for the ride. A profile can hold rides with GPS and
  // no power meter, and folding them into one number would let the power table say
  // "compared with 7 earlier rides with recorded power" when three of the seven
  // recorded no watts at all — the exact over-claim this feature exists not to make.
  comparedPowerRides: number;
  comparedSplitRides: number;
  // Rank per power-curve duration, only where one was earned.
  power: { seconds: number; rank: BestRank }[];
  // Rank per rendered split row, keyed by the split's own `index`.
  splits: { index: number; rank: BestRank }[];
}

// `rank = 1 + strictly better`, capped at the marker depth. `better` is passed in
// rather than a sort direction so watts (higher wins) and seconds (lower wins)
// share one rule instead of two near-copies that can drift apart.
function rankAmong(
  value: number,
  pool: readonly number[],
  better: (a: number, b: number) => boolean
): BestRank | null {
  let ahead = 0;
  for (const other of pool) {
    if (better(other, value)) ahead++;
    if (ahead >= BEST_RANK_DEPTH) return null;
  }
  return (ahead + 1) as BestRank;
}

const higher = (a: number, b: number) => a > b;
const faster = (a: number, b: number) => a < b;

/**
 * Rank this ride's own rows against the rides that came before it.
 *
 * `powerCurve` and `splits` are the ride's freshly computed rows — the detail read
 * already holds them, computed from this ONE ride's streams, which is bounded by
 * construction. Only the priors come from cached summaries.
 *
 * A ride with no comparable data of a kind simply earns no ranks of that kind: a
 * ride with GPS but no power meter ranks its splits and nothing else, and a ride
 * with neither returns empty. There is no "is this a meter ride" flag to set or
 * forget — an estimated-power ride summarises to an empty curve and cannot enter.
 */
export function rideBests(
  ride: {
    powerCurve: readonly { seconds: number; watts: number }[];
    splits: readonly SessionDistanceSplit[];
  },
  priors: readonly PriorRide[]
): RideBests {
  // The population of each kind is the rides that could actually have competed in
  // it. A prior that recorded no watts is not part of "rides with recorded power",
  // and counting it would inflate the number every surface prints.
  const powerPriors = priors.filter((prior) => prior.powerCurve.length > 0);
  const splitPriors = priors.filter((prior) => prior.splitTimesSec.length > 0);

  // NO PRIORS OF A KIND, NO MARKERS OF THAT KIND — the AC's "first ride with
  // power" case, decided here rather than left to each surface to remember. With
  // an empty pool every row ranks first, and a table of first places reads as an
  // achievement when it only says that nothing came before it.
  const power =
    powerPriors.length === 0
      ? []
      : ride.powerCurve.flatMap(({ seconds, watts }) => {
          const rank = rankAmong(
            watts,
            powerPriors.flatMap((prior) =>
              prior.powerCurve
                .filter((point) => point.seconds === seconds)
                .map((point) => point.watts)
            ),
            higher
          );
          return rank == null ? [] : [{ seconds, rank }];
        });

  // A split competes with the OTHER splits of its own ride too. Ten 5 km splits in
  // one ride are ten efforts, so the ride that holds the two fastest ever prints
  // "Best" and "2nd" rather than "Best" twice.
  const priorSplitTimes = splitPriors.flatMap((prior) => [
    ...prior.splitTimesSec,
  ]);
  const splits =
    splitPriors.length === 0
      ? []
      : ride.splits.flatMap((split, index) => {
          const rank = rankAmong(
            split.timeSec,
            [
              ...priorSplitTimes,
              ...ride.splits
                .filter((_, other) => other !== index)
                .map((other) => other.timeSec),
            ],
            faster
          );
          return rank == null ? [] : [{ index: split.index, rank }];
        });

  return {
    comparedPowerRides:
      powerPriors.length + (ride.powerCurve.length > 0 ? 1 : 0),
    comparedSplitRides: splitPriors.length + (ride.splits.length > 0 ? 1 : 0),
    power,
    splits,
  };
}

// ── FIXED TEMPLATE TEXT ────────────────────────────────────────────────────────
//
// Per the legible-rules doctrine: one sentence per rule, assembled from the ranked
// facts, never learned or generated. Every one of them states the population, so
// none of them can be read as a lifetime claim the data cannot support.

export function bestRankMarker(rank: BestRank): string {
  return rank === 1 ? "Best" : rank === 2 ? "2nd" : "3rd";
}

/**
 * What a table says about the window it compared within — the honesty line the
 * markers hang off. Null when there is nothing to qualify (no ranks were earned).
 *
 * `comparedRides === 1` is the FIRST ride with this kind of data. It earns no
 * markers at all, and this sentence is what renders instead: every row would
 * otherwise be a first place, which looks like an achievement and is only a
 * statement that nothing came before.
 */
export function comparedWindowText(
  comparedRides: number,
  noun: "power" | "splits"
): string | null {
  if (comparedRides <= 0) return null;
  const subject = noun === "power" ? "recorded power" : "recorded splits";
  if (comparedRides === 1) return `First ride with ${subject}.`;
  return `Compared with ${comparedRides - 1} earlier ride${
    comparedRides - 1 === 1 ? "" : "s"
  } with ${subject}.`;
}
