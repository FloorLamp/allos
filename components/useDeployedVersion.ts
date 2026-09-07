"use client";

import { useEffect, useRef, useState } from "react";
import { UPDATE_CHECK_MS } from "@/lib/sw-update";

// Reports /api/version; resolveUpdateState owns the pending-update decision.
// Poll whenever a baseline exists, including worker-controlled tabs: a worker's
// unchanged script cannot reliably detect a new deployment in an open document.
// Read on mount, on visible intervals, and when the tab becomes visible.
// Contract: docs/internals/deploy-skew.md.

export type DeployedVersion = {
  sha: string | null;
  commitMessage: string | null;
  /** A read completed, even without a SHA. Independent of whether polling stops. */
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
  // The answer can no longer change — the server has named a build we are not on, or
  // nobody is allowed to ask — so stop asking. Distinct from the reported `settled`
  // (#2329): a poll that has an answer and keeps asking is the normal state, and only
  // this flag ends the interval. A ref (not state) because the in-flight fetch closure
  // needs the CURRENT value, not its render's snapshot. Both decide only whether to
  // keep ASKING and what to REPORT — the pending-state decision stays in
  // lib/sw-update.ts.
  const finalRef = useRef(false);
  const generationRef = useRef(generation);

  useEffect(() => {
    if (generationRef.current !== generation) {
      generationRef.current = generation;
      finalRef.current = false;
      setDeployed(NOTHING);
    }
    // No baseline means nothing to compare a sha against, so there is no question to
    // ask.
    if (mode === "off" || !baseline || finalRef.current) return;

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    // A read came back. Report it as settled WHATEVER it said — a 5xx, an offline
    // blip, an unparseable body — because #1905's plan blocks on this flag and a
    // read that never settles holds the bar back forever. The poll keeps asking, so
    // an answer given in the dark is corrected by the next tick rather than frozen.
    const answered = () =>
      setDeployed((prev) => (prev.settled ? prev : { ...prev, settled: true }));
    // Nothing left to learn: stop the interval too.
    const final = () => {
      finalRef.current = true;
      if (intervalId) clearInterval(intervalId);
      answered();
    };
    // A read whose result must no longer be acted on: this effect has been torn down, or
    // another read already reached a final answer. EVERY branch that resumes after an
    // `await` asks this, not only the sha comparison (#2447) — `finalRef` outlives one
    // effect run, since it is reset only by a `generation` bump, so a stale 401 landing
    // after teardown would latch it on and silently end the poll for the instance that
    // reuses the ref.
    const obsolete = () => cancelled || finalRef.current;

    async function check({ onMount }: { onMount: boolean }) {
      // Background tabs are not POLLED — but the mount read still happens in a hidden
      // tab: it is what the load-time worker decision waits on (#1905), and deferring
      // it would leave a tab that loaded in the background holding the bar until it
      // was looked at.
      if (finalRef.current) return;
      if (!onMount && document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (obsolete()) return;
        // The endpoint is session-gated (#390). An anonymous context — the login
        // page, or a session that expired under an open tab — can never learn the
        // deployed sha, so stop asking rather than 401 once a minute forever.
        if (res.status === 401) {
          final();
          return;
        }
        if (!res.ok) {
          answered();
          return;
        }
        const body = (await res.json()) as {
          sha: string | null;
          commitMessage: string | null;
        };
        // `res.json()` is a second suspension point, so the same question is asked again.
        if (obsolete()) return;
        if (!body.sha) {
          answered();
          return;
        }
        setDeployed((prev) => ({
          ...prev,
          sha: body.sha,
          commitMessage: body.commitMessage ?? null,
        }));
        // The server has named a build this document is not on. Nothing a later read
        // could say would change that, so this is the last one.
        if (body.sha !== baseline) final();
        else answered();
      } catch {
        // Network blip, or a deploy caught mid-restart — ask again next tick, but
        // report the read as answered so the plan is not held open on a tab that may
        // be offline for hours.
        if (!obsolete()) answered();
      }
    }

    // The waiting-worker decision needs a settled answer immediately after load.
    void check({ onMount: true });
    intervalId = setInterval(
      () => void check({ onMount: false }),
      UPDATE_CHECK_MS
    );
    const onVisible = () => {
      if (document.visibilityState === "visible")
        void check({ onMount: false });
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
