// Pure episode-dedup decision for the low-supply refill nudge, mirroring
// lib/preventive-nudge.ts. The DB gather + Telegram send lives in
// lib/notifications/refill.ts; this file only DECIDES, given each tracked item's
// current supply state, the already-nudged item ids, and the item ids the user
// dismissed/snoozed on the Upcoming page (issue #227), which items to nudge now and
// which stale markers to clear. Kept here (not inline in the notifier) so the
// episode + suppression logic is unit-tested with no DB/network.
//
// Dedup semantics — "once per low-supply EPISODE", not once per day:
//   - notify_last_refill_<id> is set once a nudge goes out and suppresses further
//     nudges while the item STAYS low.
//   - The marker is CLEARED the moment the item is no longer low (refilled above the
//     threshold, or its rate is no longer estimable), so the next time it runs low a
//     fresh nudge fires. Without this the marker would silence it forever.
//
// Page suppression (issue #227) — a dismissed/snoozed refill finding (keyed by the
// item's `refill:<id>` signal, the identical dedupeKey the Upcoming item carries)
// FREEZES the episode exactly like the preventive nudge's covered/suppressed rules:
// a suppressed low item is held out of `toSend` (no ping) and its marker is left
// untouched, so un-dismissing later (or a snooze expiring) resumes the normal
// lifecycle. Suppression only bears on the low/would-send branch — a NOT-low item
// has no refill finding to suppress, so its recovered-marker clear runs regardless.

// One low item the nudge can announce.
export interface RefillNudgeItem {
  id: number;
  name: string;
  daysLeft: number;
}

// A tracked item's current supply state, as gathered by the notifier: `daysLeft`
// from lib/refill's daysOfSupplyLeft (null when unestimable) and `low` from
// isLowSupply. `id`/`name` carry through to the message.
export interface RefillCandidate {
  id: number;
  name: string;
  daysLeft: number | null;
  low: boolean;
}

export interface RefillNudgePlan {
  // Items to nudge now (low AND not already marked AND not suppressed) — the
  // notifier sends these and sets their markers on a successful delivery.
  toSend: RefillNudgeItem[];
  // Item ids whose marker should be deleted: a previously-nudged item that is no
  // longer low, so its episode has ended and a future low run can re-fire.
  toClear: number[];
}

// Decide the nudge plan from the candidates, the currently-marked item ids, and the
// suppressed item ids. Pure. `suppressedIds` is the set whose `refill:<id>` finding
// the user has dismissed/snoozed — held out of `toSend` and never cleared here, so
// its episode marker stays frozen while the suppression stands.
export function planRefillNudges(
  candidates: readonly RefillCandidate[],
  markedIds: Iterable<number>,
  suppressedIds: Iterable<number> = []
): RefillNudgePlan {
  const marked = new Set(markedIds);
  const suppressed = new Set(suppressedIds);
  const toSend: RefillNudgeItem[] = [];
  const toClear: number[] = [];
  for (const c of candidates) {
    if (c.low && c.daysLeft != null) {
      if (!marked.has(c.id) && !suppressed.has(c.id))
        toSend.push({ id: c.id, name: c.name, daysLeft: c.daysLeft });
    } else if (marked.has(c.id)) {
      // Recovered (refilled / no longer estimable) → end the episode. A not-low item
      // carries no refill finding, so suppression is irrelevant to this clear.
      toClear.push(c.id);
    }
  }
  return { toSend, toClear };
}

// The stable suppression/identity key for a refill finding: `refill:<id>`. The
// SINGLE source of truth for the key — the Upcoming refill item (lib/queries/upcoming.ts)
// AND this nudge derive from it, so a page dismissal and its push cousin line up.
export function refillSignalKey(supplementId: number): string {
  return `refill:${supplementId}`;
}
