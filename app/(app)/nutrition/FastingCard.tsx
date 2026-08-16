"use client";

// The fasting surface on the Nutrition tab (#2756): a live state chip, one control
// whose label NAMES the write it will perform, the stale suggest, and the history of
// completed fasts.
//
// RENDERED FROM STATE (#1892). The control is not a button that hopes — it is
// `fastControlState` made visible, the SAME pure derivation the write core re-checks
// under its own lock. So the worst a stale tab can do is tap and get an honest refusal,
// and the label can never promise a write the state does not support.
//
// NO STREAKS, NO "KEEP GOING", NO SENDS. Fasting sits in the coaching tier on calm
// surfaces only: a reminder here would be the system increasing contact toward a
// behavior goal, which contact-consent forbids unless the user schedules one themselves.
// The elapsed counter states a fact and stops.

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import {
  fastControlLabel,
  fastControlState,
  formatFastDuration,
  servingsDuringFastNote,
  type Fast,
  type FastControlState,
} from "@/lib/fasting";
import {
  discardFastAction,
  endFastAction,
  startFastAction,
  undoEndFastAction,
} from "./fast-actions";

export interface FastHistoryEntry {
  fast: Fast;
  /** Profile-local day the fast is attributed to — the day it ENDED (#94). */
  day: string | null;
  label: string;
  duration: string;
  /** Servings with a stated eating instant inside the interval. Annotation only. */
  servingsDuring: number;
}

export default function FastingCard({
  active,
  history,
  nowMs,
}: {
  active: Fast | null;
  history: FastHistoryEntry[];
  // The SERVER's clock reading at render, so the first paint matches what the server
  // decided and hydration cannot disagree with it. The ticking counter below advances
  // from here rather than from the browser's own clock, which may be minutes off.
  nowMs: number;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [elapsedNow, setElapsedNow] = useState(nowMs);

  // The chip ticks once a minute — the smallest unit the label renders, so a shorter
  // interval would repaint without changing a character.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setElapsedNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [active]);

  const state: FastControlState = fastControlState(
    active,
    new Date(elapsedNow)
  );

  async function run(
    fn: (fd: FormData) => Promise<
      { ok: true; message: string; undoFastId?: number } | { ok: false; error: string }
    >,
    fd: FormData
  ) {
    if (pending) return;
    setPending(true);
    try {
      const result = await fn(fd);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      // UNDO on an end (#2756). The inverse is complete and local — one column on one
      // named row — so this restores exactly the state that existed a second ago rather
      // than approximating it.
      toast(
        result.message,
        result.undoFastId != null
          ? {
              action: {
                label: "Undo",
                onClick: () => {
                  const undo = new FormData();
                  undo.set("id", String(result.undoFastId));
                  void run(undoEndFastAction, undo);
                },
              },
            }
          : undefined
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      data-testid="fasting-card"
      className="mb-4 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
    >
      <h2 className="mb-2 section-label">Fasting</h2>

      {state.kind === "start" ? (
        <p
          data-testid="fasting-state"
          className="mb-2 text-sm text-slate-500 dark:text-slate-400"
        >
          No fast running.
        </p>
      ) : (
        <p
          data-testid="fasting-state"
          className="mb-2 text-sm text-slate-700 dark:text-slate-200"
        >
          Fasting for {formatFastDuration(state.elapsedMs)}.
        </p>
      )}

      <button
        type="button"
        data-testid="fasting-control"
        disabled={pending}
        onClick={() =>
          void run(
            state.kind === "start" ? startFastAction : endFastAction,
            new FormData()
          )
        }
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-600"
      >
        {fastControlLabel(state)}
      </button>

      {/* The stale SUGGEST (#921's shape, never a timeout). Past the plausibility bound
          the app says what it noticed and offers BOTH resolutions — end it at a time you
          choose, or discard it as never-happened. It never picks, and it never
          auto-ends: "I stopped at some point" and "I never actually fasted" are
          different truths and only the user knows which one happened. */}
      {state.kind === "stale" && (
        <div
          data-testid="fasting-stale-suggest"
          className="mt-3 rounded-md bg-slate-50 p-2 text-sm dark:bg-slate-800"
        >
          <p className="mb-2 text-slate-700 dark:text-slate-200">
            This fast has been running for {formatFastDuration(state.elapsedMs)}.
            End it at the time you actually stopped, or discard it if it never
            happened.
          </p>
          <button
            type="button"
            data-testid="fasting-discard"
            disabled={pending}
            onClick={() => {
              const fd = new FormData();
              fd.set("id", String(state.fast.id));
              void run(discardFastAction, fd);
            }}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-600"
          >
            Discard
          </button>
        </div>
      )}

      {history.length > 0 && (
        <ul data-testid="fasting-history" className="mt-3 space-y-1 text-sm">
          {history.map((entry) => {
            // The quiet annotation (#2756): food logged inside a completed fast's
            // interval. BOTH FACTS STAND — the fast is the user's claim and the
            // servings are the user's record — so this reports and offers no verdict.
            const note = servingsDuringFastNote(entry.servingsDuring);
            return (
              <li
                key={entry.fast.id}
                data-testid="fasting-history-row"
                className="flex justify-between gap-2 text-slate-600 dark:text-slate-300"
              >
                <span>{entry.label}</span>
                <span className="shrink-0 tabular-nums">
                  {entry.duration}
                  {note ? (
                    <span
                      data-testid="fasting-during-note"
                      className="ml-2 text-xs text-slate-400"
                    >
                      {note}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {history.length > 0 && (
        <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
          A fast counts for the day it ends.
        </p>
      )}
    </section>
  );
}
