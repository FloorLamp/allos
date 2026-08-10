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
// THE ONLY THING THAT CAN NOTICE A DEPLOY IN AN OPEN TAB (issue #2329). #1795 turned
// this poll OFF wherever a service worker existed, on the premise that the worker
// would notice instead. It cannot: public/sw.js reads its version from its own URL,
// so a deploy changes none of its bytes, `registration.update()` installs nothing,
// and nothing re-registers a document that is already open. A waiting worker RESOLVES
// an update; asking the server is how a running tab NOTICES one. So the mode is now
// only about whether there is anything to ask:
//
//   * "poll" — there is a baseline sha to compare against. Ask on the shared cadence,
//     immediately on mount, and whenever the tab regains focus so someone returning
//     after a deploy doesn't wait out the interval.
//   * "off" — no baseline, so there is no question. Ask nothing.

export type DeployedVersion = {
  sha: string | null;
  commitMessage: string | null;
  /**
   * This hook has finished asking — the answer below is final.
   *
   * `sha: null, settled: true` is a real outcome, not a transient one: /api/version
   * is session-gated (#390), so an anonymous tab settles knowing nothing. The
   * load-time worker decision (#1905) needs to tell "hasn't answered yet" from
   * "answered with nothing", because only the first is worth holding the bar for.
   */
  settled: boolean;
};

export type VersionWatchMode = "poll" | "off";

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
  // we are not on, or nobody is allowed to ask. A ref (not state) because the
  // in-flight fetch closure needs the CURRENT value, not its render's snapshot. The
  // comparison here decides only whether to keep ASKING — the pending-state decision
  // stays in lib/sw-update.ts.
  const settledRef = useRef(false);
  const generationRef = useRef(generation);

  useEffect(() => {
    if (generationRef.current !== generation) {
      generationRef.current = generation;
      settledRef.current = false;
      setDeployed(NOTHING);
    }
    // No baseline means nothing to compare a sha against, so there is no question to
    // ask.
    if (mode === "off" || !baseline || settledRef.current) return;

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const settle = () => {
      settledRef.current = true;
      if (intervalId) clearInterval(intervalId);
      setDeployed((prev) => (prev.settled ? prev : { ...prev, settled: true }));
    };

    async function check({ onMount }: { onMount: boolean }) {
      // Background tabs are not POLLED — but the mount read still happens in a hidden
      // tab: it is what the load-time worker decision waits on (#1905), and deferring
      // it would leave a tab that loaded in the background holding the bar until it
      // was looked at.
      if (settledRef.current) return;
      if (!onMount && document.visibilityState === "hidden") return;
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
        if (body.sha !== baseline) settle();
      } catch {
        // Network blip, or a deploy caught mid-restart — ask again next tick.
      }
    }

    // THE FIRST READ IS ON MOUNT (#2329), not one tick away. A document this server
    // just rendered is by definition on this server's build, so the mount read
    // normally reports the same sha, finds no mismatch and costs one cheap request —
    // but it is the read `waitingWorkerPlan` blocks on (`plan === "wait"` suppresses
    // the bar until it settles), so deferring it held a fresh post-deploy load
    // silent for up to a full interval. The interval and the visibility hook are the
    // other halves: someone returning to a tab after a deploy shouldn't wait it out
    // either.
    void check({ onMount: true });
    intervalId = setInterval(() => void check({ onMount: false }), UPDATE_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check({ onMount: false });
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
