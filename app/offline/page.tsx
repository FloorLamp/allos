"use client";

import Wordmark from "@/components/Wordmark";

// Offline fallback shown by the service worker (public/sw.js) when a page
// navigation fails with no network. It's a static, session-free page — added to
// middleware's public allowlist and precached on SW install — so it renders even
// when the app shell itself can't be reached. Client component so "Try again"
// can re-attempt the navigation the browser just failed.
export default function OfflinePage() {
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
          <button
            type="button"
            className="btn w-full"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      </div>
    </main>
  );
}
