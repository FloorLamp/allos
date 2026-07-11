// Pure key helpers for the per-dose missed-dose escalation dedup markers, split out
// of escalate.ts (issue #328) so delete/retire seams can sweep the markers WITHOUT
// importing escalate.ts — which pulls in the Telegram sender. Mirrors the pure
// lib/refill-nudge.ts split for the refill markers. escalate.ts re-exports this.

// Per-day/slot dedup marker for a dose's escalation (value = the profile-local date
// it was last escalated). Both the tick's send (escalate.ts) and the Telegram
// "👍 I'm on it" ack (telegram-callbacks.ts) write this SAME per-episode marker, so
// an acknowledged episode isn't re-nudged.
export const escalationMarkerKey = (doseId: number) =>
  `notify_last_esc_${doseId}`;
