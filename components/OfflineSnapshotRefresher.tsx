"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  allSnapshots,
  clearSnapshots,
  openSnapshotStore,
  putSnapshots,
  snapshotEpoch,
  snapshotStoreClosed,
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
import { warmOfflineRoute } from "@/lib/offline/warm-offline-route";

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

  // A NEW authenticated mount re-opens snapshot writing after a logout closed it (see
  // lib/offline/snapshot-db.ts). Mount-scoped on purpose — `[]`, not the effect below:
  // this layout is mounted only when there IS a session, whereas the effect below
  // re-runs on every in-app navigation, including the one logout performs. Re-opening
  // there would hand the close straight back.
  useEffect(() => {
    openSnapshotStore();
  }, []);

  useEffect(() => {
    async function refresh() {
      if (running.current) return;
      // Logout has ended snapshot writing for this document. Return before the FETCH,
      // not merely before the write: a page on its way to /login has no business asking
      // the server for a fresh copy of the payload it just erased.
      if (snapshotStoreClosed()) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false)
        return;
      running.current = true;
      // THE WIPE FENCE (lib/offline/snapshot-db.ts), captured BEFORE the first await.
      //
      // The effect's own `cancelled` flag cannot do this job: it is set on UNMOUNT, and
      // on logout the sidebar wipes FIRST and then keeps this page alive for the whole
      // logout round trip, so the component is still mounted — and `cancelled` still
      // false — for the entire window in which a wipe has already happened. A generation
      // captured here and re-checked inside `putSnapshots` sees the wipe; a mount flag
      // never can.
      //
      // The fence covers a refresh caught MID-FLIGHT by a wipe. It structurally cannot
      // cover a refresh that STARTS after one — that generation is legitimately current
      // — which is why logout CLOSES the store, checked above, rather than only bumping.
      let fence = snapshotEpoch();
      try {
        const stored = await allSnapshots();
        // A store holding ANOTHER profile's payload is a broken invariant, not a state
        // to reconcile: wipe it whole and re-capture for whoever is active now. The
        // same answer covers the mixed-store case resolveSnapshotProfile refuses.
        const held = resolveSnapshotProfile(stored);
        if (stored.length > 0 && held !== activeProfileId) {
          await clearSnapshots();
          // Our OWN wipe bumped the generation. Re-arm against it: this fence exists to
          // catch somebody else's wipe, and re-capturing after a deliberate identity
          // wipe is the whole point of the branch we are in.
          fence = snapshotEpoch();
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
          await clearSnapshots();
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
        // Fenced. A wipe that landed anywhere in the round trip above drops this write.
        if (await putSnapshots(fresh, fence)) clearDirtySnapshots(wanted);
      } catch {
        /* offline, a blip, a lapsed cookie — the device keeps whatever it already
           holds. A failed refresh is never a wipe: only an identity CHANGE is. */
      } finally {
        running.current = false;
      }
    }

    // From a browser task, like OfflineQueueProvider's own initial sync, so the state
    // this touches originates in an external callback rather than in render. The shell
    // warm-up rides the same task and is independent of the refresh: it must run for a
    // profile with snapshots switched off, because the emergency card needs it too.
    const initial = window.setTimeout(() => {
      void refresh();
      void warmOfflineRoute();
    }, 0);
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
