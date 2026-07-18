"use client";

import { useEffect, useRef, useState } from "react";
import { formatSeconds } from "@/lib/duration";

// A count-UP stopwatch for the Fitness check's timed tests (plank, dead hang, single-leg
// balance, step-test cadence) — issue #834. Distinct from the rest-between-sets RestTimer
// (#340), which counts DOWN from a preset; a fitness test times how long you last. Big
// phone-at-the-gym touch targets. `onUse` hands the elapsed whole seconds back to the
// test form so the user doesn't retype it.
export default function FitnessTestTimer({
  onUse,
  testId,
}: {
  onUse: (seconds: number) => void;
  testId?: string;
}) {
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAt = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (startedAt.current != null) {
        setElapsedMs(Date.now() - startedAt.current);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
  }, [running]);

  const seconds = Math.floor(elapsedMs / 1000);

  function start() {
    startedAt.current = Date.now() - elapsedMs;
    setRunning(true);
  }
  function pause() {
    setRunning(false);
  }
  function reset() {
    setRunning(false);
    setElapsedMs(0);
    startedAt.current = null;
  }

  return (
    <div
      data-testid={testId ?? "fitness-timer"}
      className="mt-2 flex items-center gap-3 rounded-lg border border-black/10 bg-slate-100 p-2 dark:border-white/10 dark:bg-slate-800/50"
    >
      <span
        aria-live="polite"
        className="min-w-16 font-mono text-xl tabular-nums text-slate-800 dark:text-slate-100"
      >
        {formatSeconds(seconds)}
      </span>
      {running ? (
        <button type="button" onClick={pause} className="btn-secondary h-9 px-3">
          Pause
        </button>
      ) : (
        <button type="button" onClick={start} className="btn-secondary h-9 px-3">
          {elapsedMs > 0 ? "Resume" : "Start"}
        </button>
      )}
      <button type="button" onClick={reset} className="btn-secondary h-9 px-3">
        Reset
      </button>
      <button
        type="button"
        onClick={() => onUse(seconds)}
        disabled={seconds <= 0}
        className="btn h-9 px-3 disabled:opacity-50"
      >
        Use {formatSeconds(seconds)}
      </button>
    </div>
  );
}
