import { decayedWeight, SUGGESTION_HALF_LIFE_DAYS } from "./decay";
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
  const weights = new Map(DEFAULT_ORDER.map((suite) => [suite, 0]));
  for (const row of rows) {
    const represented = new Set<TrainingDepthSuite>();
    const own = suiteForType(row.type);
    if (own) represented.add(own);
    for (const component of parseComponents(row.components)) {
      const suite = suiteForType(component.type);
      if (suite) represented.add(suite);
    }
    const weight = decayedWeight(row.date, today, halfLifeDays);
    for (const suite of represented) {
      weights.set(suite, (weights.get(suite) ?? 0) + weight);
    }
  }
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  return DEFAULT_ORDER.map((suite, index) => ({
    suite,
    weight: weights.get(suite) ?? 0,
    share: total > 0 ? (weights.get(suite) ?? 0) / total : 0,
    index,
  }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map(({ index: _index, ...row }) => row);
}
