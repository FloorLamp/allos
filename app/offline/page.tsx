"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { IconEmergencyBed, IconArrowLeft } from "@tabler/icons-react";
import Wordmark from "@/components/Wordmark";
import EmergencyCardView from "@/components/EmergencyCardView";
import PageContainer from "@/components/PageContainer";
import { readEmergencyPayloadRaw } from "@/components/emergency-offline";
import OfflineSnapshotView from "@/components/offline/OfflineSnapshotView";
import { allSnapshots } from "@/lib/offline/snapshot-db";
import { allIntents } from "@/lib/offline/queue-db";
import {
  SNAPSHOT_REGISTRY,
  overlaySnapshot,
  resolveSnapshotProfile,
  SNAPSHOT_KINDS,
  type AnySnapshot,
  type SnapshotKind,
} from "@/lib/offline/snapshots";
import {
  parseEmergencyPayload,
  type EmergencyCard,
} from "@/lib/emergency-card";

const subscribeToEmergencyCard = () => () => {};

// Offline fallback shown by the service worker (public/sw.js) when a page navigation
// fails with no network — and, since #2908, the OFFLINE HOME. It's a static,
// session-free page (in middleware's public allowlist, precached on SW install) so it
// renders even when the app shell itself can't be reached. A deep-linked navigation
// that fails still lands here, which is the right landing.
//
// It reads two device-local stores and nothing else:
//   • the Emergency Card copy in localStorage (#42), and
//   • the declared read SNAPSHOTS in IndexedDB (#2908) — today's doses, the med list,
//     recent training, the day's food, the practice week — with the write queue's
//     PENDING INTENTS folded in, so a dose tapped in the same dead zone shows as
//     resolved-and-queued instead of vanishing until reconnect.
//
// SINGLE-PROFILE BY CONSTRUCTION. There is no session here to authorize a choice
// between profiles, so there is no picker: the page renders the profile that was active
// at capture, and if the store somehow holds more than one profile's payloads it
// renders NONE of them (resolveSnapshotProfile answers null, and a mixed store means a
// wipe failed to run). Logout and profile switch wipe both stores, so a stale card or
// schedule never lingers for the next person holding the phone.
export default function OfflinePage() {
  const emergencyRaw = useSyncExternalStore(
    subscribeToEmergencyCard,
    readEmergencyPayloadRaw,
    () => null
  );
  const card = useMemo<EmergencyCard | null>(
    () => parseEmergencyPayload(emergencyRaw)?.card ?? null,
    [emergencyRaw]
  );
  const [showCard, setShowCard] = useState(false);
  const [snapshots, setSnapshots] = useState<AnySnapshot[]>([]);
  const [open, setOpen] = useState<SnapshotKind | null>(null);

  // Read once on mount, from a browser task. There is nothing to subscribe to: no
  // network, no Server Actions, and both stores only change on a visit that has a
  // session — which this page, by definition, does not.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [stored, intents] = await Promise.all([
        allSnapshots(),
        allIntents(),
      ]);
      if (cancelled) return;
      const owner = resolveSnapshotProfile(stored);
      if (owner == null) return;
      setSnapshots(
        stored
          .filter((s) => s.profileId === owner)
          .map((s) => overlaySnapshot(s, intents))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const byKind = useMemo(
    () => new Map(snapshots.map((s) => [s.kind, s] as const)),
    [snapshots]
  );
  const available = SNAPSHOT_KINDS.filter((k) => byKind.has(k));
  const openEnv = open ? (byKind.get(open) ?? null) : null;

  // `data-offline-shell` + `offline-card` hook the CSS-only prefers-color-scheme
  // base in globals.css (#2183): this page must render sensibly under OS dark
  // even when NO script runs (a cached shell whose boot script was blocked), so
  // its dark treatment cannot rely solely on the boot-set `.dark` class the
  // `dark:` variants key on.
  if (showCard && card) {
    return (
      <main data-offline-shell className="min-h-screen px-4 py-8">
        <PageContainer width="narrow" className="mx-auto">
          <button
            type="button"
            className="btn-ghost mb-4 print:hidden"
            onClick={() => setShowCard(false)}
          >
            <IconArrowLeft className="h-4 w-4" stroke={1.75} />
            Back
          </button>
          <EmergencyCardView card={card} />
        </PageContainer>
      </main>
    );
  }

  if (openEnv) {
    return (
      <main data-offline-shell className="min-h-screen px-4 py-8">
        <PageContainer width="narrow" className="mx-auto">
          <button
            type="button"
            data-testid="offline-snapshot-back"
            className="btn-ghost mb-4"
            onClick={() => setOpen(null)}
          >
            <IconArrowLeft className="h-4 w-4" stroke={1.75} />
            Back
          </button>
          <div className="offline-card rounded-2xl border border-black/10 bg-white/70 p-5 dark:border-white/5 dark:bg-ink-950/70">
            <OfflineSnapshotView env={openEnv} now={new Date()} />
          </div>
        </PageContainer>
      </main>
    );
  }

  return (
    <main
      data-offline-shell
      className="flex min-h-screen items-center justify-center px-4 py-12"
    >
      <div className="w-full max-w-sm text-center">
        <div className="mb-8 flex items-center justify-center gap-2">
          <Wordmark markClassName="h-8 w-14" />
        </div>
        <div className="offline-card rounded-2xl border border-black/10 bg-white/70 p-6 shadow-xs backdrop-blur-xl dark:border-white/5 dark:bg-ink-950/70">
          <h1 className="mb-1 text-lg font-semibold text-slate-800 dark:text-slate-100">
            You&apos;re offline
          </h1>
          <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
            Allos can&apos;t reach the network right now. Your data is safe on
            the server — reconnect to pick up where you left off.
          </p>
          {available.length > 0 && (
            <div
              data-testid="offline-snapshot-list"
              className="mb-4 flex flex-col gap-2 text-left"
            >
              {available.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  data-testid={`offline-open-${kind}`}
                  className="btn-ghost w-full"
                  onClick={() => setOpen(kind)}
                >
                  {SNAPSHOT_REGISTRY[kind].title}
                </button>
              ))}
            </div>
          )}
          {card && (
            <button
              type="button"
              data-testid="offline-view-emergency"
              className="btn mb-2 w-full"
              onClick={() => setShowCard(true)}
            >
              <IconEmergencyBed className="h-4 w-4" stroke={1.75} />
              View emergency card
            </button>
          )}
          <button
            type="button"
            className="btn-ghost w-full"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      </div>
    </main>
  );
}
