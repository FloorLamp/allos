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

export interface StrengthLadderRow {
  exercise: string;
  placement: StrengthLadderPlacement;
}

/**
 * Build the Overview ladder's rows: place each lift, rank by movement, keep the top
 * few. Lives here rather than in the page because BOTH dots have to be read from the
 * same measurement lane, and that is the rule the two inputs below encode (#3132):
 *
 *  - `currentE1rmKg` is the lift's free-weight e1RM (#2326) — a machine-backed set
 *    states nothing against a barbell population table;
 *  - `points` must come from the SAME free-weight-restricted history, so the prior
 *    dot is the newest standing at or before `priorCutoff` that the current dot's
 *    own rule would have accepted.
 *
 * A lift with no free-weight point before the cutoff gets NO prior — the ladder
 * renders one dot, which is what the Longevity pillar already shows.
 */
export function strengthLadderRows(
  lifts: {
    exercise: string;
    currentE1rmKg: number | null | undefined;
    points: { date: string; value: number }[];
  }[],
  priorCutoff: string,
  sex: Sex | null | undefined,
  bodyweightKg: number | null | undefined,
  limit = 3
): StrengthLadderRow[] {
  return lifts
    .flatMap((lift): StrengthLadderRow[] => {
      const prior = lift.points.filter((p) => p.date <= priorCutoff).at(-1);
      const placement = strengthLadderPlacement(
        lift.exercise,
        lift.currentE1rmKg,
        prior?.value ?? null,
        sex,
        bodyweightKg
      );
      return placement ? [{ exercise: lift.exercise, placement }] : [];
    })
    .sort((a, b) => {
      const move = (r: StrengthLadderRow) =>
        r.placement.current.e1rmKg -
        (r.placement.prior?.e1rmKg ?? r.placement.current.e1rmKg);
      return (
        Number(b.placement.moved) - Number(a.placement.moved) ||
        move(b) - move(a) ||
        a.exercise.localeCompare(b.exercise)
      );
    })
    .slice(0, limit);
}
