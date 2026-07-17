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
