"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconFlagCheck,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconRotateClockwise,
  IconX,
} from "@tabler/icons-react";
import { FitnessPictogram } from "@/components/fitness-pictograms";
import { useWakeLock } from "@/components/useWakeLock";
import { formatSeconds } from "@/lib/duration";
import {
  IDLE_TIMER,
  countdownState,
  elapsedSeconds,
  finishFill,
  isRunning,
  pauseRun,
  startRun,
  type TimerRun,
} from "@/lib/fitness-timer";

// The Fitness-check large-format timer (#1275). A launcher in the entry sheet opens a
// full-screen takeover on mobile / a large in-sheet panel on desktop — wall-clock-sized
// readout, one giant Start→Finish button, a screen wake lock (the shared useWakeLock, the
// same best-effort acquire/re-acquire the live workout panel uses). ONE component, ONE
// responsive tree (breakpoint insets, never a hand-mirrored hidden md:* branch), driven by
// the pure timer engine in lib/fitness-timer (elapsed/countdown derived from Date.now).
//
// Two modes, chosen by `window` (the test's dataset `timerWindow`):
//   • no window → count UP: Finish stamps the elapsed whole seconds via onFinish (the form
//     fills its seconds input). #794: it prefills only — the user still submits.
//   • window → count DOWN from the window, auto-ending at 0:00 with a best-effort chime +
//     vibration, then onFinish flips the caller to its result (reps) input. Finish-early is
//     always available — a stopped run is still a result.
//
// Escape / the collapse control returns to the sheet WITHOUT losing elapsed state (the run
// lives here and the component stays mounted — only the overlay hides).
export default function FitnessTestTimer({
  label,
  testKey,
  window: windowSeconds,
  onFinish,
  testId,
}: {
  label: string;
  testKey: string;
  window?: number;
  // Count-up: the elapsed whole seconds to stamp into the seconds input. Countdown: called
  // on end/finish-early (elapsed passed for completeness; the caller focuses its result input).
  onFinish: (elapsedSeconds: number) => void;
  testId?: string;
}) {
  const base = testId ?? `fitness-timer-${testKey}`;
  const isCountdown = windowSeconds != null;

  const [expanded, setExpanded] = useState(false);
  const [run, setRun] = useState<TimerRun>(IDLE_TIMER);
  // A monotonically-updated "now" so the readout re-renders each animation frame while
  // running. The timer keeps REAL time (lib/clock's freeze seam is date-derivation only).
  const [nowMs, setNowMs] = useState(() => Date.now());
  const running = isRunning(run);

  // Live cues/announcements fire once per transition — track what we've already said/played.
  const endedRef = useRef(false);
  const announcedFinalRef = useRef(false);
  const [announce, setAnnounce] = useState("");
  const audioRef = useRef<AudioContext | null>(null);

  // Keep the screen awake only while the takeover is open (holding a plank / a stance).
  useWakeLock(expanded);

  // Best-effort end cue: a short WebAudio chime + a vibration. Both degrade silently where
  // denied (no AudioContext, autoplay blocked, no Vibration API) — the visual/aria end
  // state stands in. Mirrors the RestTimer cue.
  const cue = useCallback(() => {
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctor) {
        const ctx = audioRef.current ?? new Ctor();
        audioRef.current = ctx;
        void ctx.resume?.();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.42);
      }
    } catch {
      // AudioContext unavailable/blocked — the visual "Time" cue stands in.
    }
    try {
      navigator.vibrate?.([120, 60, 120]);
    } catch {
      // Vibration API absent (desktop) — no-op.
    }
  }, []);

  const finish = useCallback(() => {
    const at = Date.now();
    const fill = finishFill(windowSeconds, run, at);
    setRun((r) => pauseRun(r, at));
    setExpanded(false);
    // Count-up hands back its seconds; countdown passes elapsed (caller focuses its result).
    onFinish(fill ?? elapsedSeconds(run, at));
  }, [onFinish, run, windowSeconds]);

  // The rAF loop while running: advance `nowMs` for the readout, announce the final-10s
  // warning (countdown), and auto-end at 0:00 with the cue → onFinish.
  useEffect(() => {
    if (!running || !expanded) return;
    let raf = 0;
    const tick = () => {
      const at = Date.now();
      setNowMs(at);
      if (isCountdown) {
        const s = countdownState(windowSeconds!, run, at);
        if (s.ended) {
          if (!endedRef.current) {
            endedRef.current = true;
            setAnnounce("Time");
            cue();
            const fill = finishFill(windowSeconds, run, at);
            setRun((r) => pauseRun(r, at));
            setExpanded(false);
            onFinish(fill ?? elapsedSeconds(run, at));
          }
          return; // stop the loop; ended
        }
        if (s.finalCountdown && !announcedFinalRef.current) {
          announcedFinalRef.current = true;
          setAnnounce(`${s.remainingSeconds} seconds left`);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, expanded, isCountdown, windowSeconds, run, cue, onFinish]);

  // Escape collapses the takeover (elapsed state is kept — the run lives on).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [expanded]);

  function start() {
    endedRef.current = false;
    announcedFinalRef.current = false;
    const at = Date.now();
    setNowMs(at);
    setRun((r) => startRun(r, at));
    setAnnounce(isCountdown ? "Countdown started" : "Timer started");
  }
  function pause() {
    setRun((r) => pauseRun(r, Date.now()));
  }
  function reset() {
    endedRef.current = false;
    announcedFinalRef.current = false;
    setRun(IDLE_TIMER);
    setNowMs(Date.now());
    setAnnounce("");
  }
  function openTakeover() {
    setExpanded(true);
    setNowMs(Date.now());
  }

  const elapsed = elapsedSeconds(run, nowMs);
  const cd = isCountdown ? countdownState(windowSeconds!, run, nowMs) : null;
  const displaySeconds = cd ? cd.remainingSeconds : elapsed;
  const started = run.accumulatedMs > 0 || running;

  // ── Collapsed launcher (in the sheet) ──────────────────────────────────────────────
  if (!expanded) {
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={openTakeover}
          data-testid={`${base}-launch`}
          className="btn-secondary flex w-full items-center justify-center gap-2 py-2.5 text-sm font-semibold"
        >
          <IconPlayerPlayFilled className="h-4 w-4" />
          {started
            ? `Resume timer · ${formatSeconds(displaySeconds)}`
            : isCountdown
              ? `Start ${formatSeconds(windowSeconds!)} timer`
              : "Start timer"}
        </button>
      </div>
    );
  }

  // ── Takeover: full-screen on mobile, large centered panel on desktop ────────────────
  // ONE responsive tree — breakpoint insets, not a hidden md:* mirror.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${label} timer`}
      data-testid={`${base}-panel`}
      className="fixed inset-0 z-[60] flex flex-col bg-white p-5 dark:bg-slate-900 sm:inset-8 sm:rounded-3xl sm:border sm:border-black/10 sm:shadow-2xl md:inset-x-[22%] md:inset-y-[12%] dark:sm:border-white/10"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FitnessPictogram
            testKey={testKey}
            className="h-7 w-7 shrink-0 text-slate-500 dark:text-slate-400"
          />
          <span className="truncate text-lg font-semibold">{label}</span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          data-testid={`${base}-collapse`}
          aria-label="Collapse timer"
          className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
        >
          <IconX className="h-6 w-6" />
        </button>
      </div>

      {/* Polite announcements: start / final-10s / end (text, never color-only). */}
      <span
        aria-live="polite"
        className="sr-only"
        data-testid={`${base}-announce`}
      >
        {announce}
      </span>

      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        {isCountdown && (
          <span className="section-label">
            {cd?.ended ? "Time" : "Counting down"}
          </span>
        )}
        <span
          data-testid={`${base}-readout`}
          className={`font-mono text-7xl font-bold tabular-nums sm:text-8xl ${
            cd?.finalCountdown
              ? "text-amber-600 dark:text-amber-400"
              : "text-slate-900 dark:text-slate-50"
          }`}
        >
          {formatSeconds(displaySeconds)}
        </span>
        <div className="mt-2 flex items-center gap-3">
          {running && (
            <button
              type="button"
              onClick={pause}
              data-testid={`${base}-pause`}
              aria-label="Pause"
              className="flex h-12 w-12 items-center justify-center rounded-full border border-black/10 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800"
            >
              <IconPlayerPauseFilled className="h-6 w-6" />
            </button>
          )}
          {started && (
            <button
              type="button"
              onClick={reset}
              data-testid={`${base}-reset`}
              aria-label="Reset"
              className="flex h-12 w-12 items-center justify-center rounded-full border border-black/10 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800"
            >
              <IconRotateClockwise className="h-6 w-6" />
            </button>
          )}
        </div>
      </div>

      {/* One giant Start→Finish target. */}
      {running ? (
        <button
          type="button"
          onClick={finish}
          data-testid={`${base}-finish`}
          className="flex w-full items-center justify-center gap-3 rounded-2xl bg-brand-600 py-6 text-2xl font-bold text-white hover:bg-brand-500 active:scale-[0.99]"
        >
          <IconFlagCheck className="h-7 w-7" />
          Finish
        </button>
      ) : (
        <button
          type="button"
          onClick={start}
          data-testid={`${base}-start`}
          className="flex w-full items-center justify-center gap-3 rounded-2xl bg-brand-600 py-6 text-2xl font-bold text-white hover:bg-brand-500 active:scale-[0.99]"
        >
          <IconPlayerPlayFilled className="h-7 w-7" />
          {started ? "Resume" : "Start"}
        </button>
      )}
    </div>
  );
}
