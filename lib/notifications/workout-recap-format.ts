// Pure composition for the recap-led post-workout finish nudge (issue #924) — no
// DB/network, so it stays unit-testable and the DB gather + dispatch in
// ./workout-presence wire it up. The #921 finish nudge (the due post-workout
// supplement doses) is unchanged; this only PREPENDS the session recap line and
// makes a recap-only finish still send.
//
// Composition rule:
//   • recap line — gated by its own per-profile toggle (workout-recap kind, on by
//     default) AND by there being real strength work to recap;
//   • supplement section — the existing dose reminder, gated by dueness;
//   • either alone still sends; both absent ⇒ no send.

import type { NotificationMessage } from "./types";
import { formatRecapLine, type Recap } from "../session-recap";
import { frequencyScopeLabel } from "../goals";

// The workout-affectable frequency scopes (#1122): the target kinds a lifting/cardio
// session can actually advance. `food_group` (a nutrition scope, #580) and
// `mobility_region` (a recovery scope, #840) are EXCLUDED from a *workout* recap — a
// barbell session structurally can't move veg-servings or mobility days, so grading
// them here is what made the old line read "0 of 4" ("your workout didn't count").
// `substance` (a weekly cap, #998) is already excluded upstream by
// `getFrequencyTargetProgress`; listing only the floors keeps this positive.
const WORKOUT_RECAP_SCOPE_KINDS: ReadonlySet<string> = new Set([
  "region",
  "group",
  "type",
]);

// The minimal shape the recap line reads from a `getFrequencyTargetProgress` row —
// scope identity (to filter + label), the paced count, and the met flag. Structurally
// a subset of `FrequencyTargetProgress`, so the caller passes that array directly.
export interface WeeklyRecapTarget {
  target: { scope_kind: string; scope_value: string };
  count: number;
  per_week: number;
  met: boolean;
}

// The weekly-status line the recap message gains (issue #981 §3, corrected by #1122):
// riding INSIDE the congratulatory finish message where its tone is natural. Two fixes
// over the original "N of M met" tally:
//   1. SCOPE to workout-affectable targets — a workout recap never grades food/mobility
//      habits a lifting session can't move (that's how it showed "0 of 4").
//   2. PACE, not met-count — lead with the target this session ADVANCED but hasn't yet
//      completed ("Legs — 1 of 2 this week, one more to go"), using each target's count
//      rather than the all-or-nothing `met`, so a session that rarely *completes* a
//      2–4×/week goal still reads as progress. Acknowledge the session; don't tally
//      unfinished weekly goals.
// The underlying rollup stays the ONE computation (`getFrequencyTargetProgress`, #221);
// this is a workout-scoped FORMATTER over it. Null when there are no workout targets, or
// when the session didn't measurably advance one and none are met (stay quiet rather than
// revert to the misleading "0 of N").
export function weeklyRemainingLine(
  routine: readonly WeeklyRecapTarget[]
): string | null {
  const workout = routine.filter((t) =>
    WORKOUT_RECAP_SCOPE_KINDS.has(t.target.scope_kind)
  );
  if (workout.length === 0) return null;

  // Lead with the closest-to-done target the session advanced but hasn't completed.
  const inProgress = workout
    .filter((t) => !t.met && t.count >= 1)
    .sort((a, b) => a.per_week - a.count - (b.per_week - b.count));
  if (inProgress.length > 0) {
    const t = inProgress[0];
    const remaining = t.per_week - t.count;
    const tail = remaining === 1 ? "one more to go" : `${remaining} more to go`;
    const label = frequencyScopeLabel(
      t.target.scope_kind,
      t.target.scope_value
    );
    return `${label} — ${t.count} of ${t.per_week} this week, ${tail}.`;
  }

  // Nothing in progress: a calm celebratory line when every workout target is met,
  // else silence (don't tally the untouched goals as "0 of N").
  if (workout.every((t) => t.met)) return "All weekly targets met — nice work.";
  return null;
}

// The recap line for the nudge, or null when the toggle is off or there's nothing
// worth recapping. A finish with no strength working sets (a pure-cardio/import
// row) yields no recap line — the nudge then behaves exactly as it did pre-#924
// (dose-only), so a promptly-synced run can't spam a "run done" note.
export function recapNudgeLine(
  recap: Recap | null,
  enabled: boolean
): string | null {
  if (!enabled || !recap) return null;
  if (recap.totalWorkingSets === 0) return null;
  const line = formatRecapLine(recap);
  return line || null;
}

// Compose the finish nudge: the recap line (when present) LEADS, then the due
// post-workout supplement section (the existing dose message) follows. Returns
// null when both are absent so the caller sends nothing (and doesn't burn the
// one-shot). The combined message keeps the dose message's kind ("dose") so its
// SAFETY-tier routing/actions are preserved; a recap-only message is classified
// "workout-recap" for structured-channel routing.
export function composeFinishNudge(
  recapLine: string | null,
  doseMessage: NotificationMessage | null
): NotificationMessage | null {
  if (!recapLine && !doseMessage) return null;
  if (doseMessage) {
    if (!recapLine) return doseMessage;
    return { ...doseMessage, body: `${recapLine}\n\n${doseMessage.body}` };
  }
  return {
    title: "🏋️ Workout complete",
    body: recapLine!,
    kind: "workout-recap",
  };
}
