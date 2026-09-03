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

// The ride's own rows, as narrow as the ranking needs them. `SessionDistanceSplit`
// is structurally assignable, so the detail page passes its rendered splits
// straight in; the dashboard, which has only cached summary numbers and never a
// stream, can build the same shape from those. One rule, both readers.
export interface RideEfforts {
  powerCurve: readonly { seconds: number; watts: number }[];
  splits: readonly { index: number; timeSec: number }[];
}

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
  ride: RideEfforts,
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
          const pool = powerPriors.flatMap((prior) =>
            prior.powerCurve
              .filter((point) => point.seconds === seconds)
              .map((point) => point.watts)
          );
          // NO PRIORS AT *THIS DURATION*, NO MARKER AT THIS DURATION — the same
          // rule as the empty-history case, asked at the granularity the marker is
          // actually about. A ride's curve stops at its own length, so the first
          // ride long enough to record a 45-minute effort has an EMPTY pool there
          // however many earlier rides carry power. "Best" over nothing is the
          // over-claim this feature exists not to make (#2385), and the population
          // footnote counts rides rather than durations, so it cannot catch it.
          if (pool.length === 0) return [];
          const rank = rankAmong(watts, pool, higher);
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
    // ZERO WHEN THE RIDE CONTRIBUTED NOTHING OF THIS KIND, priors or no priors:
    // there was no comparison, so there is no population to state. Counting the
    // priors alone would let a ride whose only split is a 1.7 km run-out print
    // "compared with 2 earlier rides with recorded splits" under a table where
    // nothing was compared at all.
    comparedPowerRides:
      ride.powerCurve.length > 0 ? powerPriors.length + 1 : 0,
    comparedSplitRides: ride.splits.length > 0 ? splitPriors.length + 1 : 0,
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

// ── THE POST-RIDE CELEBRATION (#3195 parts 3 and 4) ────────────────────────────
//
// One statement per qualifying ride, assembled from the ranks above by the same
// fixed-template rule: it names the best and then the population it was best of,
// in the same sentence, so the claim can never be read as a lifetime one the data
// cannot support (#2385).

// Which single row a ride's celebration names. THE LONGEST POWER DURATION IT WON,
// because that is the effort a rider recognises — a five-second best is a sprint
// out of a junction, a forty-five-minute best is the ride. A ride that won no
// power duration falls back to its fastest split; one that won nothing, or that is
// the FIRST ride of its kind (`comparedRides === 1`, where "best" would only mean
// "only"), earns no statement at all.
export type RideBestHeadline = (
  | { kind: "power"; seconds: number; watts: number }
  | { kind: "split"; index: number; timeSec: number }
) & { comparedRides: number };

// The winning row's own NUMBER travels with the verdict rather than being looked
// up again beside it: a headline that named a duration whose watts the caller
// then failed to find is a state this union cannot represent.
export function rideBestHeadline(
  ride: RideEfforts,
  bests: RideBests
): RideBestHeadline | null {
  if (bests.comparedPowerRides > 1) {
    const won = bests.power
      .filter((entry) => entry.rank === 1)
      .sort((a, b) => b.seconds - a.seconds)[0];
    const point =
      won && ride.powerCurve.find((entry) => entry.seconds === won.seconds);
    if (point) {
      return {
        kind: "power",
        seconds: point.seconds,
        watts: point.watts,
        comparedRides: bests.comparedPowerRides,
      };
    }
  }
  if (bests.comparedSplitRides > 1) {
    const won = bests.splits.find((entry) => entry.rank === 1);
    const split =
      won && ride.splits.find((entry) => entry.index === won.index);
    if (split) {
      return {
        kind: "split",
        index: split.index,
        timeSec: split.timeSec,
        comparedRides: bests.comparedSplitRides,
      };
    }
  }
  return null;
}

/**
 * The celebration's sentence. `subject` is what was won, already worded and
 * unit-formatted by the caller that knows the reader's units ("45 min power",
 * "5 km split"); everything after it is this module's, so the population is
 * stated the same way here as under the tables.
 */
export function rideBestStatementDetail(
  subject: string,
  headline: RideBestHeadline
): string {
  const noun = headline.kind === "power" ? "recorded power" : "recorded splits";
  return `Best ${subject} of ${headline.comparedRides} rides with ${noun}`;
}

/**
 * The segment line (#3195 part 4). `names` are the ride's `pr_rank = 1` efforts.
 *
 * NO POPULATION PHRASE HERE, and that is deliberate rather than an oversight: a
 * segment PR is the PROVIDER's own rank over the provider's own effort history,
 * not a comparison this module made, so it carries no claim about what Allos has
 * seen and must not borrow the sentence that does.
 */
export function segmentPrStatement(
  names: readonly string[]
): { value: string; detail: string } | null {
  if (names.length === 0) return null;
  if (names.length === 1) return { value: names[0]!, detail: "Segment PR" };
  return {
    value: `${names.length} segments`,
    detail: `Segment PRs: ${names.join(", ")}`,
  };
}
