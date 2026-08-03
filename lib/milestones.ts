// Milestone detection (issue #32) — a small PURE engine that reports which
// threshold-crossing recognitions a profile has newly earned: their Nth logged
// workout and a completed goal. No DB/network — the persistence (a profile-scoped
// `milestones` table that is BOTH the timeline source AND the once-only fired
// marker) and the gather live in lib/milestones-db.ts. Detection is a pure
// function of the current cumulative stats plus the set of already-fired keys, so
// each milestone fires exactly once and the thresholds are exhaustively unit
// tested.
//
// Tone (issue #32): quiet and factual. A milestone is a recognition, not a reward
// — no points, no confetti, no loss framing. The titles read like a log entry
// ("100 workouts logged"), and notifying is optional/opt-out per profile.
//
// TWO FAMILIES ONLY, and the boundary is the point (#1939). The retired `streak:`
// and `adherence:` families both rewarded MAINTAINING A RUN — a rest-tolerant
// activity streak and a run of days where every due dose was taken — which is the
// cliff class this app does not do: their copy was congratulatory, and the
// adherence one recast a deliberate skip (#232), a legitimate act the dose
// machinery handles without judgment, as breaking something. What survives cannot
// be broken: 100 workouts is 100 workouts regardless of the gaps between them, and
// a completed goal is a user-declared intent being met. No cliff, no loss dynamic.
// Migration 148 deleted the rows the retired families had already minted, so the
// Timeline carries no badge the app no longer awards.

// The two milestone families and their thresholds. Workout-count thresholds are
// deliberately sparse and widely spaced so recognitions stay rare.
export const WORKOUT_THRESHOLDS = [10, 50, 100, 250, 500] as const;

export type MilestoneKind = "workouts" | "goal";

export interface Milestone {
  // Stable, collision-free identity — also the row's unique key in the milestones
  // table, so a present row means "already fired". Domain-prefixed: "workouts:100",
  // "goal:<goalId>".
  key: string;
  kind: MilestoneKind;
  // The numeric threshold crossed (workout count), or the goal id for a goal
  // completion.
  threshold: number;
  title: string;
  detail: string;
}

// A goal a profile has completed, as the engine needs to see it.
export interface CompletedGoal {
  id: number;
  title: string;
}

export interface MilestoneInput {
  // Cumulative count of workouts (activities) ever logged.
  totalWorkouts: number;
  // Goals currently marked achieved.
  completedGoals: CompletedGoal[];
  // Keys already recorded as fired (from the milestones table), so nothing re-fires.
  fired: ReadonlySet<string>;
}

// The largest reached threshold in a sorted ascending list, or null when none is
// reached. Milestones fire per crossed threshold (see detectMilestones), so this
// is only a convenience for callers that want the current tier.
export function reachedThreshold(
  value: number,
  thresholds: readonly number[]
): number | null {
  let best: number | null = null;
  for (const t of thresholds) if (value >= t) best = t;
  return best;
}

function workoutTitle(n: number): { title: string; detail: string } {
  return {
    title: `${n} workouts logged`,
    detail: `You've logged ${n} workouts. Consistency is the point — nice going.`,
  };
}

function goalTitle(title: string): { title: string; detail: string } {
  return {
    title: `Goal reached: ${title}`,
    detail: `You completed the goal "${title}".`,
  };
}

// Detect every milestone the profile has newly crossed — i.e. whose threshold is
// met by the current stats and whose key is not already in `fired`. Deterministic
// order: workouts (ascending threshold), then goals (ascending id). A caller
// persists the returned keys so they never re-fire.
export function detectMilestones(input: MilestoneInput): Milestone[] {
  const out: Milestone[] = [];

  const add = (
    key: string,
    kind: MilestoneKind,
    threshold: number,
    t: { title: string; detail: string }
  ) => {
    if (input.fired.has(key)) return;
    out.push({ key, kind, threshold, title: t.title, detail: t.detail });
  };

  for (const t of WORKOUT_THRESHOLDS) {
    if (input.totalWorkouts >= t)
      add(`workouts:${t}`, "workouts", t, workoutTitle(t));
  }
  for (const g of [...input.completedGoals].sort((a, b) => a.id - b.id)) {
    add(`goal:${g.id}`, "goal", g.id, goalTitle(g.title));
  }

  return out;
}
