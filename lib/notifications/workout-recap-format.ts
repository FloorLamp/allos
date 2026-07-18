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

// The weekly-remaining line the recap message gains (issue #981 §3): the forward-looking
// "N of M this week — one more to go" status, riding INSIDE the congratulatory finish
// message where its tone is natural (which is what makes #981's silent reminder-skip —
// rather than a softened second ping — correct: one moment, one message). Read from the
// SAME weekly target rollup the reminder reads (#221) — `getFrequencyTargetProgress`,
// which the reminder's behind-set (`routine.filter(t => !t.met)`) also derives — so the
// two can't disagree about "how many left this week". Null when there are NO targets;
// a calm all-met line when every target is met (celebratory-neutral, no cheer).
export function weeklyRemainingLine(
  routine: readonly { met: boolean }[]
): string | null {
  if (routine.length === 0) return null;
  const remaining = routine.filter((t) => !t.met).length; // the reminder's behind-set
  const total = routine.length;
  const met = total - remaining;
  if (remaining === 0) return "All weekly targets met — nice work.";
  const tail = remaining === 1 ? "one more to go" : `${remaining} more to go`;
  return `${met} of ${total} this week — ${tail}.`;
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
