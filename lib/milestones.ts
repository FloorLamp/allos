// Milestone detection (issue #32) — a small PURE engine that reports which
// threshold-crossing recognitions a profile has newly earned: their Nth logged
// workout, a streak reaching a notable length, a completed goal, and a run of
// perfect supplement adherence. No DB/network — the persistence (a profile-scoped
// `milestones` table that is BOTH the timeline source AND the once-only fired
// marker) and the gather live in lib/milestones-db.ts. Detection is a pure
// function of the current cumulative stats plus the set of already-fired keys, so
// each milestone fires exactly once and the thresholds are exhaustively unit
// tested.
//
// Tone (issue #32): quiet and factual. A milestone is a recognition, not a reward
// — no points, no confetti, no streak-loss guilt. The titles read like a log
// entry ("100 workouts logged"), and notifying is optional/opt-out per profile.

// The four milestone families and their thresholds. Workout-count and streak-length
// thresholds are deliberately sparse and widely spaced so recognitions stay rare;
// adherence runs mark a week and a month of not missing a due dose.
export const WORKOUT_THRESHOLDS = [10, 50, 100, 250, 500] as const;
export const STREAK_THRESHOLDS = [7, 30, 100, 365] as const;
export const ADHERENCE_RUN_THRESHOLDS = [7, 30] as const;

export type MilestoneKind = "workouts" | "streak" | "adherence" | "goal";

export interface Milestone {
  // Stable, collision-free identity — also the row's unique key in the milestones
  // table, so a present row means "already fired". Domain-prefixed: "workouts:100",
  // "streak:30", "adherence:7", "goal:<goalId>".
  key: string;
  kind: MilestoneKind;
  // The numeric threshold crossed (workout count / streak length / adherence run),
  // or the goal id for a goal completion.
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
  // Current streak length (active days) as of today — the same rest-tolerant
  // "flexible" streak the dashboard headline shows.
  streak: number;
  // Length of the current run of days with perfect supplement adherence (every due
  // dose taken), 0 when the profile tracks nothing or missed recently.
  adherenceRun: number;
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

function streakTitle(n: number): { title: string; detail: string } {
  const span =
    n >= 365
      ? "a year"
      : n >= 30
        ? `${Math.round(n / 30)} months`
        : `${n} days`;
  return {
    title: `${n}-day activity streak`,
    detail: `Your activity streak reached ${n} days — ${span} of staying in motion.`,
  };
}

function adherenceTitle(n: number): { title: string; detail: string } {
  return {
    title: `${n}-day adherence streak`,
    detail: `You've taken every due dose for ${n} days running.`,
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
// order: workouts (ascending threshold), then streak, then adherence, then goals
// (ascending id). A caller persists the returned keys so they never re-fire.
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
  for (const t of STREAK_THRESHOLDS) {
    if (input.streak >= t) add(`streak:${t}`, "streak", t, streakTitle(t));
  }
  for (const t of ADHERENCE_RUN_THRESHOLDS) {
    if (input.adherenceRun >= t)
      add(`adherence:${t}`, "adherence", t, adherenceTitle(t));
  }
  for (const g of [...input.completedGoals].sort((a, b) => a.id - b.id)) {
    add(`goal:${g.id}`, "goal", g.id, goalTitle(g.title));
  }

  return out;
}

// A per-day due/taken summary, oldest-first (the last element is the most recent
// settled day). `due` is how many doses were scheduled that day; `taken` how many
// were confirmed.
export interface AdherenceDay {
  due: number;
  taken: number;
}

// The length of the current run of PERFECT-adherence days: consecutive most-recent
// days on which every due dose was taken. Days with nothing due are transparent —
// they neither extend nor break the run (matching adherenceSummary's "na"). A day
// that missed at least one due dose ends the run. Returns 0 when the profile has no
// due days at all. Pure, so the gather can feed it a bounded window and the
// thresholds stay testable.
export function adherenceRunLength(days: AdherenceDay[]): number {
  let run = 0;
  let sawDue = false;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d.due === 0) continue; // nothing due — transparent to the run
    sawDue = true;
    if (d.taken >= d.due) run++;
    else break;
  }
  return sawDue ? run : 0;
}
