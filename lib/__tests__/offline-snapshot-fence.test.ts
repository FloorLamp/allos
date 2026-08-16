// THE WIPE FENCE and the dirty marks (#2908 D1 and D4).
//
// The fence is the feature's primary safety property expressed as a number. Every
// snapshot survived logout and rendered session-free at /offline because the refresher
// had no guard a WIPE could trip: its only one was the effect's `cancelled` flag, set on
// unmount, and on logout the page stays mounted for the whole logout round trip. So the
// entire logout POST was an open window in which an in-flight `putSnapshots(fresh)`
// re-wrote a med list and a dose schedule into a store that had just been cleared.
//
// The property these pin is the one that failed: A WIPE INVALIDATES EVERY GENERATION
// CAPTURED BEFORE IT, SYNCHRONOUSLY — at the moment the wipe is CALLED, not whenever
// its IndexedDB transaction happens to complete. Fire-and-forget call sites
// (`void clearSnapshots()` at the off switch) and awaited ones (logout's `clearQueue`)
// both depend on that ordering, and both leave the page alive afterwards.
//
// The store itself is browser-only glue, so what a real wipe/write race does to real
// IndexedDB is pinned in e2e/offline-snapshots.spec.ts, with latency on both legs so
// the race is deterministic rather than a fast box.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  bumpSnapshotEpoch,
  clearSnapshots,
  closeSnapshotStore,
  openSnapshotStore,
  putSnapshots,
  snapshotEpoch,
  snapshotFenceHolds,
  snapshotStoreClosed,
} from "@/lib/offline/snapshot-db";
import { clearQueue } from "@/lib/offline/queue-db";
import {
  clearDirtySnapshots,
  dirtySnapshotKinds,
  noteOneTapWrite,
  resetDirtySnapshots,
  snapshotKindsForAffordance,
} from "@/lib/offline/snapshot-refresh";
import { SNAPSHOT_VERSION, type AnySnapshot } from "@/lib/offline/snapshots";

const snapshot = {
  version: SNAPSHOT_VERSION,
  kind: "medication-list",
  profileId: 7,
  timeZone: "America/Denver",
  capturedOn: "2026-08-16",
  fetchedAt: "2026-08-16T22:00:00Z",
  data: { rows: [] },
} as unknown as AnySnapshot;

describe("the wipe fence (#2908)", () => {
  it("holds until something wipes, and never again for that generation", () => {
    const fence = snapshotEpoch();
    expect(snapshotFenceHolds(fence)).toBe(true);
    bumpSnapshotEpoch();
    expect(snapshotFenceHolds(fence)).toBe(false);
    // Monotonic: a later wipe can never restore an earlier generation.
    bumpSnapshotEpoch();
    expect(snapshotFenceHolds(fence)).toBe(false);
  });

  it("clearSnapshots invalidates SYNCHRONOUSLY — before its promise settles", async () => {
    // The off switch does `void clearSnapshots()` and leaves the page mounted. If the
    // generation only moved when the transaction completed, a refresh already in flight
    // would land in the gap and re-materialize everything the toggle just erased.
    const fence = snapshotEpoch();
    const wiping = clearSnapshots();
    expect(snapshotFenceHolds(fence)).toBe(false);
    await wiping;
    expect(snapshotFenceHolds(fence)).toBe(false);
  });

  it("clearQueue invalidates SYNCHRONOUSLY too — it is the logout path", async () => {
    // components/SidebarContent wipes through clearQueue and THEN submits the logout,
    // keeping the page alive for the entire round trip. This is the moment that has to
    // fence the refresher, and it is the moment the leak happened in.
    const fence = snapshotEpoch();
    const wiping = clearQueue();
    expect(snapshotFenceHolds(fence)).toBe(false);
    await wiping;
    openSnapshotStore();
  });

  it("putSnapshots refuses a payload fetched before a wipe", async () => {
    const stale = snapshotEpoch();
    bumpSnapshotEpoch();
    expect(await putSnapshots([snapshot], stale)).toBe(false);
  });

  it("…and refuses an empty write regardless, so a no-op never reads as a write", async () => {
    expect(await putSnapshots([], snapshotEpoch())).toBe(false);
  });
});

describe("the logout close — what the fence structurally cannot do (#2908)", () => {
  afterEach(() => {
    openSnapshotStore();
  });

  it("refuses a write whose generation is PERFECTLY CURRENT, once logout has closed", async () => {
    // The hole the fence left, and the one that shipped red on CI. A refresh that STARTS
    // after the logout wipe captures the POST-wipe generation, so its fence holds — by
    // the fence's own rule, correctly. It then finds an empty store, concludes every
    // kind is missing, asks for all five, and is answered 200 because the logout POST
    // has not landed and the session is still alive. Observed: five payloads back in the
    // store, readable session-free at /offline.
    closeSnapshotStore();
    const current = snapshotEpoch();
    expect(snapshotStoreClosed()).toBe(true);
    expect(snapshotFenceHolds(current)).toBe(false);
    expect(await putSnapshots([snapshot], current)).toBe(false);
  });

  it("clearQueue closes SYNCHRONOUSLY — it is the logout wipe, and its only caller", async () => {
    expect(snapshotStoreClosed()).toBe(false);
    const wiping = clearQueue();
    expect(snapshotStoreClosed()).toBe(true);
    await wiping;
  });

  it("clearSnapshots does NOT close: the switch and the off switch must re-capture", async () => {
    // The asymmetry is the point. A profile switch wipes so the NEXT profile's payloads
    // can be captured, and the off switch wipes so the server's `enabled: false` answer
    // is honoured on the next visit. Closing either would be a different feature.
    await clearSnapshots();
    expect(snapshotStoreClosed()).toBe(false);
    expect(snapshotFenceHolds(snapshotEpoch())).toBe(true);
  });

  it("a new authenticated mount re-opens, so logging back in still caches", () => {
    closeSnapshotStore();
    expect(snapshotFenceHolds(snapshotEpoch())).toBe(false);
    // The refresher calls this from a MOUNT-scoped effect: the (app) layout is mounted
    // only when there is a session. The effect that re-runs on in-app navigation
    // deliberately does not, or the logout navigation would hand the close straight back.
    openSnapshotStore();
    expect(snapshotFenceHolds(snapshotEpoch())).toBe(true);
  });
});

describe("dirty marks — read-your-own-ONLINE-writes (#2908)", () => {
  beforeEach(() => {
    resetDirtySnapshots();
  });

  it("maps a one-tap affordance to the snapshots its write makes wrong", () => {
    // Composed from OFFLINE_QUEUE_COVERAGE and the registry's own `overlays`, so a new
    // affordance or a sixth kind is covered the moment it is declared.
    expect(snapshotKindsForAffordance("dose-status")).toEqual([
      "dose-schedule",
    ]);
    expect(snapshotKindsForAffordance("food-serving")).toEqual([
      "food-tallies",
    ]);
    expect(snapshotKindsForAffordance("protein-grams")).toEqual([
      "food-tallies",
    ]);
    expect(snapshotKindsForAffordance("practice-session")).toEqual([
      "practice-week",
    ]);
    // A mood check-in is queueable and changes no snapshot kind — no kind declares a
    // `mood` overlay, so there is nothing to re-capture.
    expect(snapshotKindsForAffordance("mood-valence")).toEqual([]);
    // An argued exclusion is online-only and equally changes nothing here.
    expect(snapshotKindsForAffordance("prn-dose")).toEqual([]);
  });

  it("marks on a tap and clears only what a refresh actually stored", () => {
    noteOneTapWrite("dose-status");
    noteOneTapWrite("practice-session");
    expect(dirtySnapshotKinds().sort()).toEqual([
      "dose-schedule",
      "practice-week",
    ]);
    // A refresh that stored only one of them leaves the other asking.
    clearDirtySnapshots(["dose-schedule"]);
    expect(dirtySnapshotKinds()).toEqual(["practice-week"]);
  });

  it("marks nothing for a tap that changes no snapshot", () => {
    noteOneTapWrite("mood-valence");
    expect(dirtySnapshotKinds()).toEqual([]);
  });
});
