// WHAT THE DEVICE KNOWS IT NEEDS TO RE-CAPTURE (issue #2908). Pure, CLIENT-SAFE and
// DB-FREE: process-local marks plus the map from "a tap just landed" to "which
// snapshots that tap made wrong". The storage is lib/offline/snapshot-db.ts and the
// actor is components/OfflineSnapshotRefresher.
//
// THE PROBLEM. A snapshot is captured on an authenticated visit and then sits. Its
// READER-facing clock (isSnapshotStale) says a day-scoped payload is today's schedule
// all day, which is true — and the ONLINE write that resolved one of its rows never
// touched this store, so "today's schedule" quietly meant "today's schedule as of this
// morning". Someone who took a dose at 08:00 and walked into a dead zone at 19:00 read
// "Sertraline · Not yet" about a dose they had taken.
//
// TWO HALVES, deliberately. The device-wide half is a SCOPE rule
// (DAY_SNAPSHOT_REFRESH_INTERVAL_MS in lib/offline/snapshots.ts): a day-scoped payload
// is re-captured on essentially any authenticated visit, which covers writes this
// browser never saw — an edit form, another tab, the Telegram bot, another device. The
// half here is the IMMEDIATE one: a tap this page just made is answered now rather than
// up to a minute from now.
//
// MARKS, NEVER DELETES. A dirty mark asks for a re-capture; it never removes what is
// stored. That distinction is the whole reason this is not "invalidate = clear": the
// tap that dirties a snapshot is very often the OFFLINE tap, and clearing the payload
// would take the section off /offline exactly when it is the only copy there is. The
// queued write is folded in by the overlay meanwhile.

import {
  OFFLINE_QUEUE_COVERAGE,
  type FlowKind,
} from "@/lib/offline/queue";
import {
  isArguedExclusion,
  type ArguedExclusion,
} from "@/lib/loggable-domains";
import type { OneTapAffordance } from "@/lib/one-tap";
import {
  snapshotKindsForFlow,
  type SnapshotKind,
} from "@/lib/offline/snapshots";

// Dispatched on `window` when a mark lands, so the refresher acts on a tap instead of
// waiting for the next navigation. A DOM event rather than a subscriber list because
// the marker (a one-tap surface, deep in the tree) and the actor (the layout-level
// refresher) share no React context and should not have to.
export const SNAPSHOT_REFRESH_EVENT = "allos-snapshot-refresh";

// Process-local and intentionally so: it is a hint about writes THIS page made, and a
// reload has the scope rule waiting for it either way.
const dirty = new Set<SnapshotKind>();

export function markSnapshotsDirty(kinds: readonly SnapshotKind[]): void {
  if (kinds.length === 0) return;
  for (const kind of kinds) dirty.add(kind);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SNAPSHOT_REFRESH_EVENT));
  }
}

export function dirtySnapshotKinds(): SnapshotKind[] {
  return [...dirty];
}

// Cleared only by a refresh that actually STORED a fresh payload — a failed or fenced
// refresh leaves the mark standing, so the next trigger asks again.
export function clearDirtySnapshots(kinds: readonly SnapshotKind[]): void {
  for (const kind of kinds) dirty.delete(kind);
}

// Test seam: the marks are module state, so a suite that asserts on them has to be able
// to start from empty.
export function resetDirtySnapshots(): void {
  dirty.clear();
}

// Which snapshots a one-tap affordance's write makes wrong — composed from two
// registries that already exist rather than a third list of its own:
//   • OFFLINE_QUEUE_COVERAGE (lib/offline/queue.ts) maps an affordance to its FLOW,
//     type-checked to be total over OneTapAffordance, or to an argued exclusion;
//   • SNAPSHOT_REGISTRY's `overlays` names the flows each kind folds in — which is
//     exactly the set of flows whose writes change it.
// So a sixth snapshot kind, or a new one-tap affordance, is covered the moment it is
// declared. Nothing here needs editing.
export function snapshotKindsForAffordance(
  affordance: OneTapAffordance
): SnapshotKind[] {
  const flow = OFFLINE_QUEUE_COVERAGE[affordance] as
    | FlowKind
    | ArguedExclusion;
  // An argued exclusion means the tap is online-only, not that it changes nothing —
  // but every excluded affordance writes something no snapshot kind declares an
  // overlay for, so the lookup below would answer [] anyway. Returning early says so.
  if (isArguedExclusion(flow)) return [];
  return snapshotKindsForFlow(flow);
}

// The one call a logging surface makes: "a tap on this affordance settled". Safe to
// call for a tap that was captured offline instead of written — the mark simply waits
// for a network the refresher already waits for.
export function noteOneTapWrite(affordance: OneTapAffordance): void {
  markSnapshotsDirty(snapshotKindsForAffordance(affordance));
}
