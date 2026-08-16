// The fasting stand-down (issue #2757): while a fast is ACTIVE, the app stops ASKING
// about food.
//
// ── THE DOCTRINE THAT MAKES THIS CLEAN ──────────────────────────────────────────────
//
// The system may REDUCE its contact with the user unilaterally; it may never INCREASE
// it. Suppressing a nudge needs no consent, which is why this is a derived predicate
// with no settings row, no send marker, and nothing on the suppression bus. It is not
// an Upcoming dismissal, not a `notify_lifecycle` freeze, and interacts with neither —
// disjoint by construction, the `unroutable()` shape.
//
// NOTHING IS STORED. The stand-down is DERIVED from the active-fast row, so it
// self-heals the instant the fast ends and there is nothing to sweep. A stored
// suppression flag would be a row that outlives its reason, which is the failure mode
// every send-marker retention note in lib/notifications/send-markers.ts is written
// against.
//
// ── WHAT MAY BE SILENCED, AND WHAT MAY NEVER BE ─────────────────────────────────────
//
// THIS IS THE HIGH-STAKES HALF, so the rule is an ALLOWLIST of one kind rather than a
// blocklist, and it is data rather than an `if`. A stand-down that could reach a dose
// reminder or a missed-dose escalation would silence a safety signal for as long as
// somebody claims to be fasting — an indefinite, user-triggerable mute on exactly the
// messages the app is least entitled to withhold. So:
//
//   • `FAST_SUPPRESSIBLE_KINDS` is closed and contains ONLY `food`. Growing it is a
//     deliberate edit that review sees.
//   • lib/__tests__/fasting-standdown.test.ts asserts the set is DISJOINT from
//     `SAFETY_NOTIFICATION_KINDS`, and enumerates every member of
//     `ALL_NOTIFICATION_KINDS` to prove that each non-food kind answers "not
//     suppressible" — including `dose`, `escalation` and `redose` by name. That check
//     is over the union, so a kind added to the app later is covered without anyone
//     remembering this file.
//   • The predicate takes the KIND. There is no way to call it that suppresses a send
//     without naming what is being suppressed.
//
// A fast is a claim about eating. It is not a claim about medication, and #2758 holds
// the with-food dose question separately precisely because that one carries its own
// safety ruling.

import type { NotificationKind } from "./notifications/types";
import { fastControlState, type Fast } from "./fasting";

// The CLOSED set of notification kinds an active fast may stand down. One member, and
// the reason it is a set at all is so the disjointness proof in the tests has something
// to quantify over. Adding a kind here is asserting that a user who claims to be fasting
// has thereby consented to not hearing it — which is true of a food nudge (it asks about
// eating, and they have told us they are not eating) and true of nothing else so far.
export const FAST_SUPPRESSIBLE_KINDS: ReadonlySet<NotificationKind> = new Set([
  "food",
]);

/** Whether an active fast is permitted to stand this kind of send down at all. */
export function isFastSuppressibleKind(kind: NotificationKind): boolean {
  return FAST_SUPPRESSIBLE_KINDS.has(kind);
}

// ── THE STALENESS TERM: A SUPPRESSION MUST BE ABLE TO END BY ITSELF ─────────────────
//
// A suppression whose only exit is the user opening the app is not self-healing, it is
// a trap — and it is a trap sprung on the exact channel that existed to prompt them.
// An active fast can be days old: a backdated start, a fast someone forgot to end, a
// row left open by any means at all. Without a bound, the food nudge is silenced for as
// long as that row sits there, and the only signal that anything is wrong is a card on
// a page the silenced nudge was supposed to bring them to.
//
// So the stand-down is bounded by the SAME plausibility bound the surface uses
// (`fastControlState`, FAST_STALE_HOURS). Once a fast reads as STALE it has stopped
// being evidence that the user is not eating and started being evidence that a row was
// abandoned — and an abandoned row is not consent to silence. The nudge comes back
// precisely when the claim stops being credible, which is also exactly when the user
// most needs the prompt.
//
// The direction is deliberate: an error here re-sends a food nudge to someone who is
// genuinely fasting, which costs one ignorable message. The opposite error is silence
// with no exit.
function fastSuppresses(active: Fast | null, at: Date): boolean {
  if (!active) return false;
  return fastControlState(active, at).kind === "active";
}

// THE PREDICATE. A send of `kind` stands down when the profile has an active fast that
// is still PLAUSIBLE and the kind is on the allowlist. All three conditions are
// required, and the kind check is not short-circuitable from the call site: a caller
// with no kind in hand cannot ask this question.
//
// `active` is the profile's active-fast row (null when none) and `at` is the instant the
// plausibility is judged against. Both are passed IN rather than read here so this module
// stays pure — the tick memoizes the one row read per profile (`tickCached`) and supplies
// its own clock reading.
export function standsDownForFast(
  active: Fast | null,
  kind: NotificationKind,
  at: Date
): boolean {
  return fastSuppresses(active, at) && isFastSuppressibleKind(kind);
}

// The OFFER half (#2419's line, held exactly): the usual-routine one-tap stands down
// while a fast is active — the OFFER, never the LOGGING. Every food row stays exactly as
// loggable on every surface, and a log fired anyway meets #2756's "End your fast?"
// follow-up. Withdrawing an offer is the app declining to campaign; withdrawing the
// ability to log would be the app arguing with the user about what they just ate.
// Bounded by the same staleness term, for the same reason: an offer withdrawn by an
// abandoned row is a surface that quietly stops working with nothing on screen saying so.
export function standsDownUsualRoutine(active: Fast | null, at: Date): boolean {
  return fastSuppresses(active, at);
}
