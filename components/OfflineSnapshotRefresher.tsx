"use client";

import { useEffect, useRef } from "react";
import {
  allSnapshots,
  clearSnapshots,
  putSnapshots,
} from "@/lib/offline/snapshot-db";
import {
  parseSnapshot,
  resolveSnapshotProfile,
  snapshotsToRefresh,
  type AnySnapshot,
} from "@/lib/offline/snapshots";

// Refreshes the offline read snapshots (issue #2908) on an ONLINE, AUTHENTICATED visit.
// Mounted once inside the (app) layout beside OfflineQueueProvider, so it only ever runs
// for a logged-in session — which is the entire refresh policy:
//
//   • No background sync. No service-worker credentials. No push. The device gets fresh
//     snapshots because the person opened the app, and at no other time. That is what
//     "the server stays authoritative" means here in practice.
//   • public/sw.js is UNTOUCHED, and must stay so: rendered HTML is still never cached,
//     the precache is still the shell + icon, and no service worker touches a data
//     route. These snapshots are application-layer storage the app wrote deliberately,
//     which is exactly the distinction components/emergency-offline.ts:11 draws for the
//     emergency card.
//   • lib/nav-fetch-guard.ts is untouched too. Its wrapper matches only navigation RSC
//     GETs (`RSC: 1` without `Next-Router-Prefetch`); this is a plain data fetch, so it
//     passes through by reference and can never be HELD by the navigation retry. Good:
//     a snapshot refresh is background work nobody is waiting on, and holding it would
//     be the polling-miss case #2982 deliberately excluded.
//
// It asks the server for nothing when everything it holds is current — `snapshotsToRefresh`
// answers from the stored envelopes' own clocks, in the PROFILE'S timezone.
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

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      if (running.current) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      running.current = true;
      try {
        const stored = await allSnapshots();
        // A store holding ANOTHER profile's payload is a broken invariant, not a state
        // to reconcile: wipe it whole and re-capture for whoever is active now. The
        // same answer covers the mixed-store case resolveSnapshotProfile refuses.
        const held = resolveSnapshotProfile(stored);
        if (stored.length > 0 && held !== activeProfileId) {
          await clearSnapshots();
        }
        const mine = held === activeProfileId ? stored : [];
        const wanted = snapshotsToRefresh(mine, activeProfileId, new Date());
        if (wanted.length === 0 || cancelled) return;

        const res = await fetch(
          `/api/offline-snapshots?kinds=${wanted.join(",")}`,
          { headers: { Accept: "application/json" } }
        );
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          enabled?: boolean;
          profileId?: number;
          snapshots?: unknown[];
        };
        if (cancelled) return;
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
        await putSnapshots(fresh);
      } catch {
        /* offline, a blip, a lapsed cookie — the device keeps whatever it already
           holds. A failed refresh is never a wipe: only an identity CHANGE is. */
      } finally {
        running.current = false;
      }
    }

    // From a browser task, like OfflineQueueProvider's own initial sync, so the state
    // this touches originates in an external callback rather than in render.
    const initial = window.setTimeout(() => void refresh(), 0);
    const onOnline = () => void refresh();
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.removeEventListener("online", onOnline);
    };
  }, [activeProfileId]);

  return null;
}
