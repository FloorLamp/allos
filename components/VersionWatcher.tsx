"use client";

import { useEffect, useRef, useState } from "react";
import { IconRefresh, IconSparkles } from "@tabler/icons-react";

// Watches for a new deploy. A deploy restarts the server with a new COMMIT_SHA
// while open tabs keep running the old client bundle; this polls the server's
// hash and, when it no longer matches the one this page was served with, tells
// the user a refresh is available.
//
// The notice is an INLINE BANNER at the top of the content container, NOT a toast
// (issue #1520). The toast it used to raise carried `duration: null`, so it became
// a permanent floating card pinned over the bottom-right corner — covering page
// content (and, on a phone, the workout dock) until dismissed by hand, for a
// message with no deadline. A deploy notice is ambient page state, so it renders
// like page state: in the flow, scrolling with the content, in the same slot
// OnboardingReturnBanner uses (the app layout mounts this INSIDE the content
// container for exactly that reason). Polling and the "prompt once, then stop
// polling" behavior are unchanged — only the channel moved.
//
// Accepted tradeoff (owner, #1520): someone deep in a long page won't see it until
// they scroll back up. That is the price of not floating, and it is deliberate —
// do NOT add a sticky/fixed fallback here.
//
// ONE component on every viewport: an ordinary block in the content flow, so there
// is no `hidden md:*` / `md:hidden` pair to drift.
const POLL_MS = 60_000;

export default function VersionWatcher({
  current,
}: {
  current: string | null;
}) {
  // The detected deploy's message, once. Null = nothing to say (the normal case),
  // and the component renders nothing at all.
  const [notice, setNotice] = useState<string | null>(null);
  // Prompt at most once per page life — the banner has no auto-dismiss, so a
  // repeat would only rewrite the same line. A ref (not the state above) because
  // the async poll closure needs the CURRENT value, not its render's snapshot.
  const notified = useRef(false);

  useEffect(() => {
    // No baseline to compare against (hash couldn't be resolved) — don't watch.
    if (!current) return;

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    async function check() {
      if (notified.current || document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { sha, commitMessage } = (await res.json()) as {
          sha: string | null;
          commitMessage: string | null;
        };
        if (cancelled || notified.current) return;
        if (sha && sha !== current) {
          notified.current = true;
          // Prompted once — no need to keep polling.
          if (intervalId) clearInterval(intervalId);
          setNotice(
            commitMessage
              ? `A new version has been deployed: ${commitMessage}`
              : "A new version has been deployed."
          );
        }
      } catch {
        // Network blip or a deploy mid-flight — just try again next tick.
      }
    }

    intervalId = setInterval(check, POLL_MS);
    // Also check when the tab regains focus, so someone returning after a deploy
    // sees the prompt without waiting out the interval.
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [current]);

  if (!notice) return null;

  return (
    <div
      data-testid="version-update-banner"
      role="status"
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm dark:border-brand-500/25 dark:bg-brand-500/10"
    >
      <span className="inline-flex min-w-0 items-center gap-2 text-brand-800 dark:text-brand-200">
        <IconSparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">{notice}</span>
      </span>
      <button
        type="button"
        data-testid="version-update-refresh"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline dark:text-brand-300"
      >
        <IconRefresh className="h-4 w-4" aria-hidden="true" />
        Refresh to update
      </button>
    </div>
  );
}
