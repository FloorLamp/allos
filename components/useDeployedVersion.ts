"use client";

import { useEffect, useRef, useState } from "react";
import { UPDATE_CHECK_MS } from "@/lib/sw-update";

// What commit the SERVER is running, read from /api/version (issue #1795).
//
// This is a DETECTOR, not a surface. It used to be components/VersionWatcher — a
// component that polled, decided for itself that a deploy had happened, and rendered
// its own banner with its own Refresh button, in parallel with the service worker's
// update bar. One deploy, two notices, two reload mechanics, one of which left the
// worker waiting. The polling was never the problem; owning a second answer was. So
// the poll survives as a hook that reports only what the server said, and the single
// decision is made by resolveUpdateState() for the single bar.
//
// TWO REASONS TO ASK, hence the mode:
//   * "poll" — this context has no service worker, so the sha is the ONLY way to
//     notice a deploy. Ask on the shared cadence, and when the tab regains focus so
//     someone returning after a deploy doesn't wait out the interval.
//   * "once" — the worker has already reported an update waiting; the only thing left
//     to learn is WHAT was deployed, so the bar can name it. One read, no interval.
//   * "off" — a worker is watching and has nothing to report. Ask nothing.

export type DeployedVersion = {
  sha: string | null;
  commitMessage: string | null;
  /**
   * This hook has finished asking — the answer below is final for this mode.
   *
   * `sha: null, settled: true` is a real outcome, not a transient one: /api/version
   * is session-gated (#390), so an anonymous tab settles knowing nothing. The
   * load-time worker decision (#1905) needs to tell "hasn't answered yet" from
   * "answered with nothing", because only the first is worth holding the bar for.
   */
  settled: boolean;
};

export type VersionWatchMode = "poll" | "once" | "off";

const NOTHING: DeployedVersion = {
  sha: null,
  commitMessage: null,
  settled: false,
};

export function useDeployedVersion({
  baseline,
  mode,
  generation,
}: {
  /** The commit this document was served with — null when it couldn't be resolved. */
  baseline: string | null;
  mode: VersionWatchMode;
  /**
   * Which waiting worker the answer is FOR. A settled read describes the deploy
   * state at the moment it was made; a worker that starts waiting later — a second
   * deploy under the same open page — re-opens the question, and judging it
   * against the old answer would silently consume a genuine update (#1905). The
   * registrar bumps this for each newly-waiting worker; a bump un-settles the read.
   */
  generation: number;
}): DeployedVersion {
  const [deployed, setDeployed] = useState<DeployedVersion>(NOTHING);
  // Stop asking once the answer can no longer change: the server has named a build
  // we are not on, or we were told to read once, or nobody is allowed to ask. A ref
  // (not state) because the in-flight fetch closure needs the CURRENT value, not its
  // render's snapshot. The comparison here decides only whether to keep ASKING — the
  // pending-state decision stays in lib/sw-update.ts.
  const settledRef = useRef(false);
  const generationRef = useRef(generation);

  useEffect(() => {
    if (generationRef.current !== generation) {
      generationRef.current = generation;
      settledRef.current = false;
      setDeployed(NOTHING);
    }
    // No baseline means nothing to compare a sha against, so there is no question to
    // ask; `off` means the worker is answering it instead.
    if (mode === "off" || !baseline || settledRef.current) return;

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const settle = () => {
      settledRef.current = true;
      if (intervalId) clearInterval(intervalId);
      setDeployed((prev) => (prev.settled ? prev : { ...prev, settled: true }));
    };

    async function check() {
      // Background tabs are not POLLED — but the one-shot read still happens in a
      // hidden tab: it is what the load-time worker decision waits on (#1905), and
      // deferring it would leave a tab that loaded in the background holding the bar
      // until it was looked at.
      if (settledRef.current) return;
      if (mode === "poll" && document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        // The endpoint is session-gated (#390). An anonymous context — the login
        // page, or a session that expired under an open tab — can never learn the
        // deployed sha, so stop asking rather than 401 once a minute forever.
        if (res.status === 401) {
          settle();
          return;
        }
        if (!res.ok) return;
        const body = (await res.json()) as {
          sha: string | null;
          commitMessage: string | null;
        };
        if (cancelled || settledRef.current) return;
        if (!body.sha) return;
        setDeployed((prev) => ({
          ...prev,
          sha: body.sha,
          commitMessage: body.commitMessage ?? null,
        }));
        if (mode === "once" || body.sha !== baseline) settle();
      } catch {
        // Network blip, or a deploy caught mid-restart — ask again next tick.
      }
    }

    if (mode === "once") {
      // The worker has already decided an update is pending; this read exists only
      // to name it, so it happens now and never again. It settles on EVERY outcome —
      // a 5xx, an offline blip, an unparseable body — because the load-time worker
      // decision (#1905) blocks on this read and a read that never settles would
      // hold the bar back forever.
      void check().finally(() => {
        if (!cancelled) settle();
      });
      return () => {
        cancelled = true;
      };
    }

    // Polling cadence unchanged from the watcher this absorbed: the first read is one
    // tick away, not on mount, because a document this server just rendered is by
    // definition on this server's build. The visibility hook is the other half —
    // someone returning to a tab after a deploy shouldn't wait out the interval.
    intervalId = setInterval(check, UPDATE_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [baseline, mode, generation]);

  return deployed;
}
