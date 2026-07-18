// The shared findings-LIFECYCLE spine's suppression + marker vocabulary (issue #942,
// #860 Track A). PURE — no DB/network, so it's a client-safe leaf importable from
// any tier and unit-tested in lib/__tests__/lifecycle.test.ts.
//
// The unified lifecycle is: signal → tiered reach → suppress/snooze → escalate →
// resolve, every stage citation-carrying (lib/reasons.ts) and chainable
// (lib/followup.ts). This leaf module owns the two CROSS-CUTTING decisions the spine
// had grown as per-domain copies, so every consumer speaks ONE vocabulary (the
// "one question, one computation" rule at the lifecycle layer):
//
//   1. THE SUPPRESSION POLICY — how a signal answers the shared findings-suppression
//      bus (upcoming_dismissals). Three tiers, most-to-least silenceable:
//        - "normal":         a dismiss hides indefinitely, a snooze hides while live.
//                            Ordinary care/coaching findings + the bus-gated nudges.
//        - "snooze-only":    an OVERDUE safety follow-up (#700 ask 5) — HONORS a live
//                            time-boxed snooze but RESISTS an indefinite dismiss, so a
//                            possibly-missed re-scan can be deferred but never silently
//                            dismissed into oblivion.
//        - "safety-ungated": the #449 carve-out — the bus is IGNORED ENTIRELY. Dose
//                            reminders + missed-dose ESCALATION declare it (#942, the
//                            first lifecycle tenant): a page dismissal must NEVER
//                            silence a possibly-critical medication signal. This is the
//                            NON-NEGOTIABLE safety invariant, now expressed as DATA in
//                            the shared machinery rather than the scattered "we just
//                            never call the bus" convention — pinned by a regression
//                            test that isHiddenUnderPolicy("safety-ungated", <any live
//                            dismiss/snooze>, today) is ALWAYS false.
//
//   2. THE MARKER TRANSITION — the set/clear/freeze state machine an episode/health
//      marker follows (the delivery-health marker #131/#192, the per-episode nudge
//      markers' "frozen" third state #227). Named here so `decideMarker`
//      (lib/notifications/delivery-status.ts) and the episode-marker consumers speak
//      one vocabulary: a dispatch SETs a fresh failure, CLEARs a healed one, or FREEZEs
//      (leaves untouched) when nothing actionable changed / a suppression stands.

import type { SuppressionRecord } from "./upcoming-suppress";

// The three suppression tiers, ordered most→least silenceable. Backed by a runtime
// const array so the set is ENUMERABLE (a reflection guard can assert a tenant's
// declared policy is one of these), mirroring REASON_CODES in lib/reasons.ts.
export const LIFECYCLE_SUPPRESSION_POLICIES = [
  "normal",
  "snooze-only",
  "safety-ungated",
] as const;

export type LifecycleSuppressionPolicy =
  (typeof LIFECYCLE_SUPPRESSION_POLICIES)[number];

// The ONE "is this signal hidden RIGHT NOW by the findings-suppression bus" decision,
// given its policy, the stored suppression record (or undefined when the signal was
// never dismissed/snoozed), and today (profile-local YYYY-MM-DD). Every domain-specific
// hidden-check (isSuppressed / isItemHiddenBySuppression / isFollowUpHidden) routes
// through this so they can never disagree about what a policy means:
//   - "safety-ungated" → ALWAYS false. The bus cannot hide it, full stop (#449/#942).
//     This branch is FIRST and unconditional — no record is even consulted — so the
//     safety carve-out is structurally impossible to weaken by a record edit.
//   - "snooze-only"    → a live snooze hides it; a dismiss is RESISTED (ignored).
//   - "normal"         → a dismiss hides indefinitely; a snooze hides while today <
//     snooze_until; dismiss takes precedence over a lingering snooze on the same row.
export function isHiddenUnderPolicy(
  policy: LifecycleSuppressionPolicy,
  record: SuppressionRecord | undefined,
  today: string
): boolean {
  // The #449 safety carve-out — the bus is ignored entirely. Checked before the
  // record so nothing recorded on upcoming_dismissals can ever silence it.
  if (policy === "safety-ungated") return false;
  if (!record) return false;
  if (policy === "snooze-only") {
    // Resist an indefinite dismiss; honor only a live snooze.
    if (record.snooze_until && !record.dismissed_at)
      return today < record.snooze_until;
    return false;
  }
  // "normal": dismiss hides indefinitely, snooze while today < snooze_until.
  if (record.dismissed_at) return true;
  if (record.snooze_until) return today < record.snooze_until;
  return false;
}

// The set/clear/freeze state machine a lifecycle MARKER follows. "freeze" is the third
// state (#227): the marker is deliberately left exactly as it stood — a suppressed
// nudge frozen at its old value, or a delivery-health marker a healthy dispatch didn't
// touch because it never exercised the previously-failing channel (#192). Named here
// so the delivery-health decision (`decideMarker`) and the episode-marker planners
// share one vocabulary rather than each spelling "keep"/"leave"/"hold" its own way.
export const MARKER_LIFECYCLE_ACTIONS = ["set", "clear", "freeze"] as const;

export type MarkerLifecycleAction = (typeof MARKER_LIFECYCLE_ACTIONS)[number];
