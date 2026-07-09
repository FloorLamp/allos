"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/Toast";

// Watches for a new deploy. A deploy restarts the server with a new COMMIT_SHA
// while open tabs keep running the old client bundle; this polls the server's
// hash and, when it no longer matches the one this page was served with, prompts
// the user to refresh. Renders nothing.
const POLL_MS = 60_000;

export default function VersionWatcher({
  current,
}: {
  current: string | null;
}) {
  const toast = useToast();
  // Prompt at most once per page life — the toast has no auto-dismiss, so a
  // repeat would just stack duplicates.
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
          toast(
            commitMessage
              ? `A new version has been deployed: ${commitMessage}`
              : "A new version has been deployed.",
            {
              tone: "success",
              duration: null,
              action: {
                label: "Refresh to update",
                onClick: () => window.location.reload(),
              },
            }
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
  }, [current, toast]);

  return null;
}
