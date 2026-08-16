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
import type { Fast } from "./fasting";

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

// THE PREDICATE. A send of `kind` stands down when the profile has an active fast AND
// the kind is on the allowlist. Both halves are required, and the kind check is not
// short-circuitable from the call site: a caller with no kind in hand cannot ask this
// question.
//
// `active` is the profile's active-fast row (null when none). It is passed IN rather
// than read here so this module stays pure and so the tick can memoize the one read per
// profile per tick (`tickCached`) instead of paying for it once per candidate send.
export function standsDownForFast(
  active: Fast | null,
  kind: NotificationKind
): boolean {
  return active !== null && isFastSuppressibleKind(kind);
}

// The OFFER half (#2419's line, held exactly): the usual-routine one-tap stands down
// while a fast is active — the OFFER, never the LOGGING. Every food row stays exactly as
// loggable on every surface, and a log fired anyway meets #2756's "End your fast?"
// follow-up. Withdrawing an offer is the app declining to campaign; withdrawing the
// ability to log would be the app arguing with the user about what they just ate.
export function standsDownUsualRoutine(active: Fast | null): boolean {
  return active !== null;
}
