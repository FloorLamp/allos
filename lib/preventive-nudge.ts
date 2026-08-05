// Pure episode-dedup decision for the proactive preventive-care nudge (issue #87),
// mirroring the refill nudge's "once per low-supply EPISODE" semantics
// (lib/notifications/refill.ts). The DB gather + Telegram send lives in
// lib/notifications/preventive.ts; this file only DECIDES, given the currently
// due/overdue preventive items and the set of rule keys already nudged, which
// items to nudge now and which stale markers to clear. Kept here (not inline in
// the notifier) so the episode logic is unit-tested with no DB/network.
//
// Dedup semantics — "once per due EPISODE", not once per day:
//   - notify_last_preventive_<ruleKey> is set once a nudge goes out and suppresses
//     further nudges while the item STAYS due/overdue.
//   - The marker is CLEARED the moment the item is no longer actionable (satisfied,
//     overridden, or aged out of the window), so when the NEXT interval comes due a
//     fresh nudge fires. Without this the marker would silence the rule forever.
//
// Scheduled-visit coverage (issue #183) — align the push with the Upcoming page's
// "Scheduled" quiet state (issue #85): a due item that already has a FUTURE
// matching-kind appointment booked is "covered". A covered rule is treated as "not
// actionable for nudging" — it is excluded from BOTH `toSend` (no ping) and
// `toClear` (its marker is neither set nor cleared), so its once-per-episode state
// is FROZEN exactly as it stood while coverage lasts. When coverage disappears
// (visit cancelled/completed) the rule resumes its normal lifecycle: a covered item
// that was never nudged (came due after the booking existed) fires the moment it's
// un-covered, and a mid-episode marked item keeps its marker rather than
// double-nudging. This is why covered items are held out of the clear set instead of
// being dropped from `actionable` — dropping them would age their marker out and let
// a later un-cover re-nudge the SAME episode.
//
// Page suppression (issue #227) — the SAME frozen-marker treatment for a rule the
// user dismissed/snoozed on the Upcoming page. The push is the pull surface's cousin,
// so a bus dismissal (keyed by the rule's `<kind>:<ruleKey>` signal — the identical
// dedupeKey the Upcoming item carries) must silence the ping too. A suppressed rule
// is held out of BOTH `toSend` and `toClear` exactly like a covered one, so its
// episode marker is frozen: un-dismissing later (or a snooze expiring) resumes the
// normal lifecycle — a never-nudged rule fires, a mid-episode marked rule does not
// re-nudge the same episode. Covered and suppressed are the two "frozen" sources.

import type { AppRoute } from "./hrefs";
import {
  ONCE_PER_EPISODE_FROZEN_KEEPS,
  planNudgeCadence,
} from "./nudge-cadence";

// One due/overdue preventive item the nudge can announce. Derived from the pure
// assessor's actionable slice (lib/preventive-status.ts): `ruleKey` is the catalog
// key, used both for the message and as the per-item dedup marker suffix.
export interface PreventiveNudgeItem {
  ruleKey: string;
  name: string;
  status: "due" | "overdue";
  detail: string | null;
  // The concrete-action deep link + its named CTA (#1083), from preventiveNudgeAction
  // — the SAME per-class link + label the Upcoming row carries (#221). Relative href
  // (the message absolute-izes it via getPublicUrl); both null for an unmapped rule
  // with no concrete action to link.
  href: AppRoute | null;
  ctaLabel: string | null;
}

export interface PreventiveNudgePlan {
  // Items to nudge now (actionable AND not already marked) — the notifier sends
  // these and sets their markers on a successful delivery.
  toSend: PreventiveNudgeItem[];
  // Rule keys whose marker should be deleted: a previously-nudged rule that is no
  // longer actionable, so its episode has ended and a future due can re-fire.
  toClear: string[];
}

// Decide the nudge plan from the actionable items and the currently-set markers.
// Pure: `markedRuleKeys` is the set of rule keys that already have a
// notify_last_preventive_<ruleKey> marker. `coveredRuleKeys` is the set of rule keys
// currently covered by a booked matching-kind visit (issue #183); `suppressedRuleKeys`
// is the set the user dismissed/snoozed on the Upcoming page (issue #227). Both are
// "frozen" sources — a rule in EITHER is held out of BOTH `toSend` and `toClear` so
// its episode marker stays exactly as-is while the coverage/suppression stands.
// `toClear` is sorted for deterministic output (delete order is irrelevant, but
// stable output keeps tests simple).
//
// Since #2036 the send / freeze / sweep rules are the shared planNudgeCadence decision
// (lib/nudge-cadence.ts). What stays here is the preventive vocabulary: the two frozen
// SOURCES (booked coverage and page dismissal) folding into one frozen set, and
// `frozenBlocksClear` — the one place this domain differs from refill, for the reason
// stated above (dropping a covered rule from the clear set is what keeps a later
// un-cover from re-nudging the SAME episode).
export function planPreventiveNudges(
  actionable: readonly PreventiveNudgeItem[],
  markedRuleKeys: Iterable<string>,
  coveredRuleKeys: Iterable<string> = [],
  suppressedRuleKeys: Iterable<string> = []
): PreventiveNudgePlan {
  const marked = new Set(markedRuleKeys);
  const plan = planNudgeCadence<string, PreventiveNudgeItem>({
    candidates: actionable.map((a) => ({
      key: a.ruleKey,
      item: a,
      // The caller passes the ACTIONABLE slice; anything not in it is, by construction,
      // no longer live and reaches the sweep through `marked`.
      actionable: true,
      sends: marked.has(a.ruleKey) ? 1 : 0,
      firstSentDate: null,
    })),
    marked: markedRuleKeys,
    // Covered (booked visit) and suppressed (page dismissal) both freeze the episode.
    frozen: [...coveredRuleKeys, ...suppressedRuleKeys],
    policy: ONCE_PER_EPISODE_FROZEN_KEEPS,
  });
  return {
    toSend: plan.toSend.map((s) => s.item),
    toClear: plan.toClear.sort(),
  };
}
