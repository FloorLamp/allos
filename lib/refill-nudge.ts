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
//     threshold, or its rate is no longer estimable) OR the item leaves the tracked
//     set entirely (paused, or quantity tracking turned off), so the next time it
//     runs low a fresh nudge fires. Without this the marker would silence it forever.
//     The clear is SELF-HEALING (issue #325): the notifier feeds planRefillNudges the
//     FULL set of live markers (`getProfileSettingKeysWithPrefix`), not just the
//     current candidates, so a marker whose item is no longer even a tracked candidate
//     is swept regardless of which transition removed it — mirroring the preventive
//     nudge (lib/preventive-nudge.ts). The write seams (pause/untrack/delete) also
//     clear eagerly (leftRefillTrackedSet, below) so a same-session re-entry re-fires
//     without waiting for a tick.
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
// suppressed item ids. Pure. `markedIds` is the FULL set of live episode markers (the
// notifier reads them all via getProfileSettingKeysWithPrefix), NOT just the ids among
// `candidates` — that is what makes the clear self-healing (issue #325). `suppressedIds`
// is the set whose `refill:<id>` finding the user has dismissed/snoozed — held out of
// `toSend` and never cleared here, so its episode marker stays frozen while the
// suppression stands. `toClear` is sorted for deterministic output.
export function planRefillNudges(
  candidates: readonly RefillCandidate[],
  markedIds: Iterable<number>,
  suppressedIds: Iterable<number> = []
): RefillNudgePlan {
  const marked = new Set(markedIds);
  const suppressed = new Set(suppressedIds);
  const candidateIds = new Set(candidates.map((c) => c.id));
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
  // Self-healing sweep (issue #325): a marker whose item is no longer even a tracked
  // candidate — paused, or quantity tracking turned off — never reaches the per-
  // candidate branch above, so clear it here. The item isn't a candidate, so it can
  // carry no live refill finding: suppression cannot freeze it.
  for (const id of marked) if (!candidateIds.has(id)) toClear.push(id);
  toClear.sort((a, b) => a - b);
  return { toSend, toClear };
}

// The per-item episode-marker key + prefix. The SINGLE source of truth for the
// `notify_last_refill_<id>` profile-setting key: the notifier reads/writes/enumerates
// markers through these, and the medicine write seams (pause/untrack/delete) clear
// through refillMarkerKey — so the string is never spelled inline anywhere.
export const REFILL_MARKER_PREFIX = "notify_last_refill_";
export function refillMarkerKey(itemId: number): string {
  return `${REFILL_MARKER_PREFIX}${itemId}`;
}
// Parse the item id back out of a marker key (for the notifier's self-healing sweep).
// Returns NaN for a malformed key; the caller filters those out.
export function refillIdFromMarker(key: string): number {
  return Number(key.slice(REFILL_MARKER_PREFIX.length));
}

// An intake item's membership in the refill-nudge tracked set: active AND opted into
// quantity tracking (quantity_on_hand set). Only such an item can ever be a low-supply
// candidate, so this is exactly the predicate the notifier's `tracked` filter applies.
export interface RefillTrackState {
  active: boolean;
  quantityOnHand: number | null;
}

// Whether an edit/toggle moved an item OUT of the refill-nudge tracked set — the
// transition (pause, or quantity tracking turned off) at which its low-supply episode
// marker must be cleared eagerly (issue #325), mirroring the delete seam. Pure so the
// write actions share one decision. Entering the set (or staying in/out) is never a
// clear: a still-tracked item that merely dropped below/above threshold is handled by
// the tick's per-candidate branch, and an item that was never tracked has no marker.
export function leftRefillTrackedSet(
  prev: RefillTrackState,
  next: RefillTrackState
): boolean {
  const inSet = (s: RefillTrackState) => s.active && s.quantityOnHand != null;
  return inSet(prev) && !inSet(next);
}

// The stable suppression/identity key for a refill finding: `refill:<id>`. The
// SINGLE source of truth for the key — the Upcoming refill item (lib/queries/upcoming.ts)
// AND this nudge derive from it, so a page dismissal and its push cousin line up.
export function refillSignalKey(supplementId: number): string {
  return `refill:${supplementId}`;
}
