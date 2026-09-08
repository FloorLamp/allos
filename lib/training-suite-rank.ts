import { SUGGESTION_HALF_LIFE_DAYS } from "./decay";
import { decayWeights } from "./rank-by-frequency";
import { parseComponents, type ActivityType } from "./types/training";

export type TrainingDepthSuite = "strength" | "endurance" | "sport";

export interface TrainingMixRow {
  date: string;
  type: ActivityType;
  components?: string | null;
}

export interface RankedTrainingSuite {
  suite: TrainingDepthSuite;
  weight: number;
  share: number;
}

const DEFAULT_ORDER: readonly TrainingDepthSuite[] = [
  "strength",
  "endurance",
  "sport",
];

function suiteForType(type: ActivityType): TrainingDepthSuite | null {
  if (type === "strength") return "strength";
  if (type === "cardio") return "endurance";
  if (type === "sport") return "sport";
  return null;
}

/**
 * Order depth suites by the observed, recency-weighted training mix. Composite
 * sessions credit every represented performance domain once; mobility and
 * unclassified sessions do not pretend to be one of the three suites. With no
 * meaningful history all weights tie at zero and the stable default order wins.
 */
export function rankTrainingSuites(
  rows: readonly TrainingMixRow[],
  today: string,
  halfLifeDays = SUGGESTION_HALF_LIFE_DAYS
): RankedTrainingSuite[] {
  const occurrences = rows.flatMap((row) => {
    const represented = new Set<TrainingDepthSuite>();
    const own = suiteForType(row.type);
    if (own) represented.add(own);
    for (const component of parseComponents(row.components)) {
      const suite = suiteForType(component.type);
      if (suite) represented.add(suite);
    }
    return [...represented].map((name) => ({ name, date: row.date }));
  });
  const weights = decayWeights(occurrences, today, halfLifeDays);
  const total = DEFAULT_ORDER.reduce(
    (sum, suite) => sum + (weights.get(suite) ?? 0),
    0
  );
  return DEFAULT_ORDER.map((suite, index) => ({
    suite,
    weight: weights.get(suite) ?? 0,
    share: total > 0 ? (weights.get(suite) ?? 0) / total : 0,
    index,
  }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map(({ index: _index, ...row }) => row);
}
