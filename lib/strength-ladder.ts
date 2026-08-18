import {
  strengthStanding,
  strengthStandingPercent,
  type StrengthStanding,
} from "./strength-standards";
import type { Sex } from "./types";

export interface StrengthLadderPlacement {
  current: StrengthStanding;
  currentPercent: number;
  prior: StrengthStanding | null;
  priorPercent: number | null;
  moved: boolean;
}

/**
 * Compose the existing standard standing with a 0–100 ladder position. Both
 * Overview and the Longevity strength line consume this entry point, keeping the
 * named level and the plotted dot on the same standards result.
 */
export function strengthLadderPlacement(
  exercise: string,
  currentE1rmKg: number | null | undefined,
  priorE1rmKg: number | null | undefined,
  sex: Sex | null | undefined,
  bodyweightKg: number | null | undefined
): StrengthLadderPlacement | null {
  const current = strengthStanding(exercise, currentE1rmKg, sex, bodyweightKg);
  if (!current) return null;
  const prior = strengthStanding(exercise, priorE1rmKg, sex, bodyweightKg);
  return {
    current,
    currentPercent: strengthStandingPercent(current) ?? 0,
    prior,
    priorPercent: strengthStandingPercent(prior),
    moved: prior != null && current.e1rmKg > prior.e1rmKg,
  };
}
