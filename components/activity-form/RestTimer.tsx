"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconPlayerPlayFilled,
  IconPlayerPauseFilled,
  IconRotateClockwise,
} from "@tabler/icons-react";
import { formatSeconds } from "@/lib/duration";
import ControlTooltip from "@/components/ControlTooltip";
import { useHaptics } from "@/components/useHaptics";
import FilterPills from "@/components/FilterPills";
import Stepper from "@/components/Stepper";
import {
  REST_PRESETS_SEC,
  REST_STEP_SEC,
  clampRestSec,
  suggestedRestSec,
} from "@/lib/live-workout";

// The live-mode rest timer (issue #340): a purely client-side countdown between
// sets. Big touch targets for the phone-at-the-gym surface. The default rest is
// lift-appropriate (suggestedRestSec, reusing the coaching heavy classification),
// preset chips + ± nudges let the user tune it, and it beeps + vibrates + flashes
// at zero. `autoStartKey` bumps each time a set is checked off in the form, so
// confirming a set restarts the countdown automatically (point 3 of the spec).
export default function RestTimer({
  exercise,
  autoStartKey,
}: {
  // The lift currently being worked; picks the default rest duration.
  exercise: string;
  // Monotonic nonce: any increase auto-starts a fresh countdown (a set was
  // logged). 0 on mount means "don't auto-start until the first set".
  autoStartKey: number;
}) {
  // The chosen rest target (seconds). Seeded from the lift and kept in sync while
  // the timer is idle so switching exercises re-defaults it — but never yanked
  // out from under a running countdown.
  const [target, setTarget] = useState(() => suggestedRestSec(exercise));
  // Seconds remaining; running vs paused/idle.
  const [remaining, setRemaining] = useState(target);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [seedExercise, setSeedExercise] = useState(exercise);
  const lastAutoRef = useRef(autoStartKey);
  // A single lazily-created AudioContext for the end-of-rest chime.
  const audioRef = useRef<AudioContext | null>(null);
  // The shared haptic adapter (#1422) — pattern choice + reduced-motion suppression.
  const haptic = useHaptics();

  // Re-default the target to the lift while idle (not mid-countdown): a fresh
  // exercise gets its own rest, but an in-progress rest is left alone. This is a
  // prop-keyed draft reset, so perform it during render and retry atomically.
  if (seedExercise !== exercise) {
    setSeedExercise(exercise);
    if (!running && !done) {
      const next = suggestedRestSec(exercise);
      setTarget(next);
      setRemaining(next);
    }
  }

  const beep = useCallback(() => {
    // Best-effort audible + haptic cue; both degrade silently where unsupported
    // (no AudioContext, autoplay blocked, or no Vibration API).
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
      // AudioContext unavailable/blocked — the visual "Rest done" cue stands in.
    }
    // The end-of-rest double-pulse — distinguishable through a pocket from the
    // `commit` tick, and suppressed under prefers-reduced-motion (#1422).
    haptic("alert");
  }, [haptic]);

  const start = useCallback(
    (seconds?: number) => {
      const secs = seconds ?? target;
      setRemaining(secs);
      setDone(false);
      setRunning(secs > 0);
    },
    [target]
  );

  // Auto-start on a set check-off: the form bumps autoStartKey. Ignore the mount
  // value so the timer doesn't fire before the first set.
  useEffect(() => {
    if (autoStartKey > lastAutoRef.current) {
      lastAutoRef.current = autoStartKey;
      start();
    }
  }, [autoStartKey, start]);

  // The countdown tick. One interval while running; clears on pause/unmount.
  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          setRunning(false);
          setDone(true);
          beep();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(h);
  }, [running, beep]);

  const reset = () => {
    setRunning(false);
    setDone(false);
    setRemaining(target);
  };

  const nudge = (delta: number) => {
    const next = clampRestSec((running || done ? remaining : target) + delta);
    if (running || done) {
      setRemaining(next);
      if (next > 0) setDone(false);
    } else {
      setTarget(next);
      setRemaining(next);
    }
  };

  const pickPreset = (secs: number) => {
    setTarget(secs);
    if (running) start(secs);
    else {
      setRemaining(secs);
      setDone(false);
    }
  };

  return (
    <div
      data-testid="rest-timer"
      className={`rounded-lg border p-3 transition ${
        done
          ? "border-emerald-400 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-950/40"
          : "border-brand-200 bg-brand-50/60 dark:border-brand-900 dark:bg-brand-950/40"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="section-label text-brand-600 dark:text-brand-400">
            Rest
          </span>
          <span
            data-testid="rest-remaining"
            aria-live="polite"
            className={`text-3xl font-bold tabular-nums ${
              done
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-slate-800 dark:text-slate-100"
            }`}
          >
            {done ? "Rest done" : formatSeconds(remaining)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {/* The step size stays on the face, not only in the label: a bare ± on a
              running clock does not say how far one tap moves it. */}
          <Stepper
            className="border-black/10 dark:border-white/10"
            onStep={(direction) => nudge(direction * REST_STEP_SEC)}
            decreaseLabel={`Subtract ${REST_STEP_SEC} seconds`}
            increaseLabel={`Add ${REST_STEP_SEC} seconds`}
          >
            <span className="self-center px-1 text-xs font-semibold tabular-nums text-slate-500 dark:text-slate-400">
              {REST_STEP_SEC}s
            </span>
          </Stepper>
          <ControlTooltip
            label={running ? "Pause rest timer" : "Start rest timer"}
          >
            {(anchor) => (
              <button
                {...anchor}
                type="button"
                onClick={() => (running ? setRunning(false) : start())}
                data-testid="rest-toggle"
                className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-600 text-white hover:bg-brand-500 active:scale-95"
              >
                {running ? (
                  <IconPlayerPauseFilled className="h-5 w-5" />
                ) : (
                  <IconPlayerPlayFilled className="h-5 w-5" />
                )}
              </button>
            )}
          </ControlTooltip>
          <ControlTooltip label="Reset rest timer">
            {(anchor) => (
              <button
                {...anchor}
                type="button"
                onClick={reset}
                className="flex h-11 w-11 items-center justify-center rounded-lg border border-black/10 bg-surface text-slate-600 hover:bg-slate-50 active:scale-95 dark:border-white/10 dark:text-slate-300"
              >
                <IconRotateClockwise className="h-5 w-5" />
              </button>
            )}
          </ControlTooltip>
        </div>
      </div>
      <div className="mt-2">
        <FilterPills
          mode="button"
          layout="wrap"
          label="Rest duration"
          value={target}
          onSelect={pickPreset}
          options={REST_PRESETS_SEC.map((secs) => ({
            value: secs,
            label: formatSeconds(secs),
          }))}
        />
      </div>
    </div>
  );
}
