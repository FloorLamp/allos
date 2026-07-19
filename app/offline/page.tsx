"use client";

import { useEffect, useState } from "react";
import { IconEmergencyBed, IconArrowLeft } from "@tabler/icons-react";
import Wordmark from "@/components/Wordmark";
import EmergencyCardView from "@/components/EmergencyCardView";
import { readEmergencyPayloadRaw } from "@/components/emergency-offline";
import {
  parseEmergencyPayload,
  type EmergencyCard,
} from "@/lib/emergency-card";

// Offline fallback shown by the service worker (public/sw.js) when a page
// navigation fails with no network. It's a static, session-free page — added to
// middleware's public allowlist and precached on SW install — so it renders even
// when the app shell itself can't be reached. Client component so "Try again" can
// re-attempt the navigation and so it can read the offline Emergency Card from
// localStorage (issue #42): the authenticated Passport page (/profile#emergency)
// refreshes that copy
// on each visit, so here — with no network and no session — we can still surface
// it instead of dead-ending. localStorage is cleared on logout / profile switch,
// so a stale card never lingers.
export default function OfflinePage() {
  const [card, setCard] = useState<EmergencyCard | null>(null);
  const [showCard, setShowCard] = useState(false);

  useEffect(() => {
    const parsed = parseEmergencyPayload(readEmergencyPayloadRaw());
    setCard(parsed?.card ?? null);
  }, []);

  if (showCard && card) {
    return (
      <main className="min-h-screen px-4 py-8">
        <div className="mx-auto max-w-2xl">
          <button
            type="button"
            className="btn-ghost mb-4 print:hidden"
            onClick={() => setShowCard(false)}
          >
            <IconArrowLeft className="h-4 w-4" stroke={1.75} />
            Back
          </button>
          <EmergencyCardView card={card} />
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm text-center">
        <div className="mb-8 flex items-center justify-center gap-2">
          <Wordmark markClassName="h-8 w-14" />
        </div>
        <div className="rounded-2xl border border-black/10 bg-white/70 p-6 shadow-sm backdrop-blur-xl dark:border-white/5 dark:bg-ink-950/70">
          <h1 className="mb-1 text-lg font-semibold text-slate-800 dark:text-slate-100">
            You&apos;re offline
          </h1>
          <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
            Allos can&apos;t reach the network right now. Your data is safe on
            the server — reconnect to pick up where you left off.
          </p>
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
