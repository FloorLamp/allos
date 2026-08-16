"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  allSnapshots,
  captureSnapshotToken,
  clearSnapshots,
  disableSnapshotWrites,
  putSnapshots,
  snapshotWritesClosed,
} from "@/lib/offline/snapshot-db";
import {
  clearDirtySnapshots,
  dirtySnapshotKinds,
  SNAPSHOT_REFRESH_EVENT,
} from "@/lib/offline/snapshot-refresh";
import {
  parseSnapshot,
  resolveSnapshotProfile,
  snapshotsToRefresh,
  type AnySnapshot,
  type SnapshotKind,
} from "@/lib/offline/snapshots";
import {
  warmOfflineRoute,
  WARM_START_DELAY_MS,
} from "@/lib/offline/warm-offline-route";

// How long after a page load the first snapshot refresh runs. See the call site: the
// endpoint does synchronous SQLite work in the same single-threaded server that is
// answering the page, so "as soon as possible" is precisely the wrong schedule for work
// nobody is waiting on.
const INITIAL_REFRESH_DELAY_MS = 1_200;

// Refreshes the offline read snapshots (issue #2908) on an ONLINE, AUTHENTICATED visit.
// Mounted once inside the (app) layout beside OfflineQueueProvider, so it only ever runs
// for a logged-in session — which is the entire refresh policy:
//
//   • No background sync. No service-worker credentials. No push. The device gets fresh
//     snapshots because the person opened the app, and at no other time. That is what
//     "the server stays authoritative" means here in practice.
//   • public/sw.js is UNTOUCHED: rendered HTML is still never cached, the PRECACHE is
//     still the shell + icon, and no service worker touches a data route. These
//     snapshots are application-layer storage the app wrote deliberately, which is
//     exactly the distinction components/emergency-offline.ts:11 draws for the
//     emergency card.
//
//     What DID change is when the shell's own code arrives (owner ruling, #2997): this
//     component also warms /offline's route chunks through the worker's existing
//     `cacheFirst` path, because a precached HTML shell that cannot hydrate renders
//     nothing at all — no snapshot list, and no emergency-card button either. See
//     lib/offline/warm-offline-route.ts. That warm-up is SHELL-level and deliberately
//     NOT gated on the snapshots toggle: the shipped emergency card depends on the same
//     chunks and is a separate feature with a separate opt-in.
//   • lib/nav-fetch-guard.ts is untouched too. Its wrapper matches only navigation RSC
//     GETs (`RSC: 1` without `Next-Router-Prefetch`); this is a plain data fetch, so it
//     passes through by reference and can never be HELD by the navigation retry. Good:
//     a snapshot refresh is background work nobody is waiting on, and holding it would
//     be the polling-miss case #2982 deliberately excluded.
//
// It asks the server for nothing when everything it holds is current — `snapshotsToRefresh`
// answers from the stored envelopes' own clocks, in the PROFILE'S timezone.
//
// WHEN IT RUNS. "An authenticated visit" is not the same thing as a hard page load, and
// keying the effect on `[activeProfileId]` alone quietly made it one: this is an App
// Router SPA, so someone who opens the app in the morning and then moves around inside
// it all day got exactly ONE refresh. The triggers are therefore the pathname (every
// in-app navigation, which is what a "visit" actually looks like here), the tab becoming
// visible again, reconnecting, and a dirty mark from a tap this page just made — the
// same belt-and-braces set OfflineQueueProvider uses for replay, and cheap for the same
// reason: a run with nothing to fetch is one IndexedDB read and no request.
export default function OfflineSnapshotRefresher({
  activeProfileId,
}: {
  // The session's active profile at render time (#599). Snapshots are stored under it,
  // read back under it, and a stored payload naming any other profile is wiped rather
  // than kept — the switch wipe in components/ProfileSwitchWatcher is the primary
  // defense, and this is what closes the window if it ever failed to run.
  activeProfileId: number;
}) {
  // One refresh in flight at a time. Not a correctness guard (the endpoint is a plain
  // read) — it just keeps a reconnect storm from firing five identical GETs.
  const running = useRef(false);
  const pathname = usePathname();

  // MOUNT-SCOPED — `[]`, deliberately not the effect below, which re-runs on every in-app
  // navigation. (Re-opening the device write gate after a logout is the other
  // mount-scoped job and it lives in OfflineQueueProvider: the gate is device-wide, not
  // snapshot-specific, and that provider's mount means "there is a session" for every
  // lane at once.)
  //
  // The shell warm-up runs ONCE per mount and well off the critical path. It used to ride
  // the same `setTimeout(…, 0)` as the refresh, which put a burst of asset fetches in
  // direct competition with the page the person had just asked for. Mount-scoped also
  // means an in-app navigation cannot re-arm the timer and starve it: a user who clicks
  // around faster than the delay would otherwise never get a warmed shell at all.
  useEffect(() => {
    const warm = window.setTimeout(
      () => void warmOfflineRoute(),
      WARM_START_DELAY_MS
    );
    return () => window.clearTimeout(warm);
  }, []);

  useEffect(() => {
    async function refresh() {
      if (running.current) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false)
        return;
      running.current = true;
      // THE WRITE TOKEN (lib/offline/write-gate.ts), captured BEFORE the first await and
      // spent inside `putSnapshots`'s own transaction.
      //
      // Nothing in this component can be the guard, and three attempts to make it one are
      // why: the effect's `cancelled` flag is set on UNMOUNT, which on logout happens only
      // after the navigation lands; a module generation cannot see a refresh that STARTED
      // after a wipe; a module `closed` flag cannot see another TAB. The gate is in the
      // database the writes land in, so it sees all three.
      let token = await captureSnapshotToken();
      try {
        // Asked BEFORE the fetch, not merely before the write: a page whose device has
        // been logged out — or whose owner just turned the off switch off, here or in
        // another tab — has no business requesting a fresh copy of what was erased. The
        // write would be refused either way; this stops the request too.
        if (await snapshotWritesClosed()) return;
        const stored = await allSnapshots();
        // A store holding ANOTHER profile's payload is a broken invariant, not a state
        // to reconcile: wipe it whole and re-capture for whoever is active now. The
        // same answer covers the mixed-store case resolveSnapshotProfile refuses.
        const held = resolveSnapshotProfile(stored);
        if (stored.length > 0 && held !== activeProfileId) {
          await clearSnapshots();
          // Our OWN wipe moved the generation. Re-arm against it: the token exists to
          // catch somebody else's wipe, and re-capturing after a deliberate identity wipe
          // is the whole point of the branch we are in.
          token = await captureSnapshotToken();
        }
        const mine = held === activeProfileId ? stored : [];
        // What the stored clocks ask for, plus what a tap on this page has marked. The
        // marks are the immediate half of read-your-writes for an ONLINE write: nothing
        // else on the device hears a Server Action land.
        const wanted = [
          ...new Set<SnapshotKind>([
            ...snapshotsToRefresh(mine, activeProfileId, new Date()),
            ...dirtySnapshotKinds(),
          ]),
        ];
        if (wanted.length === 0) return;

        const res = await fetch(
          `/api/offline-snapshots?kinds=${wanted.join(",")}`,
          { headers: { Accept: "application/json" } }
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          enabled?: boolean;
          profileId?: number;
          snapshots?: unknown[];
        };
        // The off switch, honored from the SERVER's answer as well as from the toggle
        // itself: a profile turned off on another device stops having payloads here at
        // its next authenticated visit. Nothing re-materializes until it is turned back
        // on.
        if (body.enabled === false) {
          // The server is authoritative and says this profile is off. Close the lane
          // rather than only wiping, so a refresh starting a moment later cannot ask
          // again and be answered differently by a racing toggle.
          await disableSnapshotWrites();
          return;
        }
        // Never store a body that is not about the profile we asked as. A response that
        // disagrees means the session moved mid-flight; the next mount re-asks.
        if (body.profileId !== activeProfileId) return;
        const fresh = (body.snapshots ?? [])
          .map(parseSnapshot)
          .filter(
            (s): s is AnySnapshot =>
              s !== null && s.profileId === activeProfileId
          );
        // Gated. A wipe, a logout or an off switch that landed anywhere in the round trip
        // above — in this tab or any other — drops this write, decided inside the write's
        // own transaction.
        if (await putSnapshots(fresh, token)) clearDirtySnapshots(wanted);
      } catch {
        /* offline, a blip, a lapsed cookie — the device keeps whatever it already
           holds. A failed refresh is never a wipe: only an identity CHANGE is. */
      } finally {
        running.current = false;
      }
    }

    // From a browser task, like OfflineQueueProvider's own initial sync, so the state
    // this touches originates in an external callback rather than in render.
    //
    // NOT AT ZERO, for the same reason the warm-up moved off this task:
    // /api/offline-snapshots is `force-dynamic` and builds five payloads with SYNCHRONOUS
    // better-sqlite3 reads, so while it runs the server answers nothing else — including
    // the request the person is waiting on. Firing it the instant a page loads aims that
    // squarely at the page's own traffic. A second costs the feature nothing: the copy is
    // for a dead zone that has not happened yet. Only the INITIAL run is delayed; the
    // event triggers stay immediate, because a tap's dirty mark is read-your-writes and a
    // reconnect is the moment there is finally a network.
    const initial = window.setTimeout(
      () => void refresh(),
      INITIAL_REFRESH_DELAY_MS
    );
    const onOnline = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onDirty = () => void refresh();
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(SNAPSHOT_REFRESH_EVENT, onDirty);
    return () => {
      window.clearTimeout(initial);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(SNAPSHOT_REFRESH_EVENT, onDirty);
    };
  }, [activeProfileId, pathname]);

  return null;
}
