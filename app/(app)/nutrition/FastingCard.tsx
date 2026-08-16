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
  canStart,
  history,
  nowMs,
}: {
  active: Fast | null;
  // Whether this profile may START a fast. FALSE with an active fast is the
  // harm-reduction case the write core's end-side exemption exists for: a profile that
  // became restricted MID-FAST still gets the way out, and nothing else — no start
  // control, no history, no elapsed-time framing that would read as tracking. Rendering
  // nothing at all here would recreate the stranded row the exemption prevents at the
  // core, one layer up (lib/fast-write.ts).
  canStart: boolean;
  history: FastHistoryEntry[];
  // The SERVER's clock reading at render, so the first paint matches what the server
  // decided and hydration cannot disagree with it. The ticking counter below advances
  // from here rather than from the browser's own clock, which may be minutes off.
  nowMs: number;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [elapsedNow, setElapsedNow] = useState(nowMs);
  // The backdated wall time, as a `datetime-local` value (`YYYY-MM-DDTHH:MM`). The form
  // carries the profile-local WALL TIME and the SERVER resolves it against the profile's
  // timezone (`parseBackdated`, ./fast-actions) — never a client instant, so a tab open
  // across a zone change or a browser with a skewed clock cannot stamp one.
  const [backdate, setBackdate] = useState("");
  const [showBackdate, setShowBackdate] = useState(false);

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
    fn: (
      fd: FormData
    ) => Promise<
      | { ok: true; message: string; undoFastId?: number }
      | { ok: false; error: string }
    >,
    fd: FormData
  ) {
    if (pending) return;
    setPending(true);
    try {
      const result = await fn(fd);
      if (!result.ok) {
        // The typed refusal is reported and the backdated value is LEFT IN PLACE — the
        // user may want to correct the time they just entered, and clearing the field
        // under a refusal would make them retype it.
        toast(result.error, { tone: "error" });
        return;
      }
      // The backdated instant has been CONSUMED, so the field is cleared and the
      // disclosure closes. Leaving it set is a real hazard rather than a tidiness point:
      // the control's next write is the opposite transition, so a start time the user
      // typed would silently be submitted as an END time — which is at or before the
      // start it just created, and the write is refused with a message about a value the
      // user cannot see. The field belongs to ONE write.
      setBackdate("");
      setShowBackdate(false);
      // UNDO on an end (#2756). The inverse is complete and local — one column on one
      // named row — so this restores exactly the state that existed a second ago rather
      // than approximating it.
      //
      // DRAWN WHEN THE SERVER SAYS SO, never from a rule re-derived here. The action
      // carries `undoFastId` only when the reopen behind it was accepted for this
      // profile at the moment the end committed (./fast-actions), so the restricted
      // close-out below needs no flag of its own: the same end there simply comes back
      // without an id.
      //
      // WHAT THAT BUYS, STATED NARROWLY. This surface's rule is that it does not draw a
      // control whose every tap would be refused, and asking the server is what keeps it
      // — but only because the action's answer covers ALL of the reopen's refusals, not
      // because asking is inherently enough. It was not enough for a revision: the id
      // came back on a backdated end whose Undo was already `too-old`, since the age
      // bound read the instant the end NAMED rather than the instant it was WRITTEN.
      // The bound now reads the write (lib/fast-write.ts), which is what makes the
      // question this asks the whole question. The toast auto-dismisses in seconds, well
      // inside FAST_REOPEN_MAX_MINUTES, so the window cannot lapse under a drawn button.
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

  // The backdated instant this card would submit, or absent for a plain "now" write.
  // One helper so the start control and the stale suggest cannot diverge on the field
  // name the action parses.
  function withBackdate(field: "started_at" | "ended_at"): FormData {
    const fd = new FormData();
    if (backdate) fd.set(field, backdate);
    return fd;
  }

  // A restricted profile with a fast still running (#2756's end-side exemption). The
  // ONLY thing offered is the way out. Deliberately no elapsed duration, no history and
  // no stale suggest: this is closing an account, not tracking a practice. There is no
  // Undo on the end either — reopening is the one thing the gate withholds — and that
  // now falls out of the action rather than being asserted here: `endFastAction` withholds
  // `undoFastId` for exactly the profiles `reopenFast` would refuse.
  //
  // ONE BUTTON IS ENOUGH ONLY BECAUSE THE CORE CANNOT REFUSE IT, and this branch is why
  // `endFast` carries no duration ceiling. There is no backdate field and no Discard
  // here, so a plain end that could be refused would leave this profile no move at all —
  // which is what a FAST_MAX_HOURS guard inside `endFast` did for one revision to every
  // fast older than 14 days. Carrying Discard here was the other available fix and was
  // deliberately NOT taken: "I never actually fasted" is a claim about what happened, and
  // making it the only exit steers someone into a false one. The fix belongs in the core,
  // and the rule this branch leans on is one line: for a restricted profile with an
  // active fast, this button lands.
  if (!canStart) {
    return (
      <section
        data-testid="fasting-card"
        className="mb-4 rounded-lg border border-black/10 p-3 dark:border-white/10"
      >
        <h2 className="mb-2 section-label">Fasting</h2>
        <p
          data-testid="fasting-closeout-note"
          className="mb-2 text-sm text-slate-500 dark:text-slate-400"
        >
          You have a fast open. You can close it out here.
        </p>
        <button
          type="button"
          data-testid="fasting-control"
          disabled={pending}
          onClick={() => void run(endFastAction, new FormData())}
          className="rounded-md border border-black/10 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-white/10"
        >
          End fast
        </button>
      </section>
    );
  }

  return (
    <section
      data-testid="fasting-card"
      className="mb-4 rounded-lg border border-black/10 p-3 dark:border-white/10"
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
            state.kind === "start"
              ? withBackdate("started_at")
              : withBackdate("ended_at")
          )
        }
        className="rounded-md border border-black/10 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-white/10"
      >
        {fastControlLabel(state)}
      </button>

      {/* BACKDATING (#2756): forgot-to-tap is the common failure, so both writes accept
          an explicit instant. Behind a disclosure because the overwhelmingly common tap
          is "now" and a date field in the default path would make a one-tap control a
          form. The field is the profile's own WALL time; the server resolves it. */}
      <div className="mt-2">
        <button
          type="button"
          data-testid="fasting-backdate-toggle"
          onClick={() => setShowBackdate((v) => !v)}
          className="text-xs text-slate-500 underline dark:text-slate-400"
        >
          {state.kind === "start" ? "Started earlier?" : "Stopped earlier?"}
        </button>
        {showBackdate && (
          <input
            type="datetime-local"
            data-testid="fasting-backdate-input"
            aria-label={state.kind === "start" ? "Start time" : "End time"}
            value={backdate}
            onChange={(e) => setBackdate(e.target.value)}
            className="input mt-1 block text-sm"
          />
        )}
      </div>

      {/* The stale SUGGEST (#921's shape, never a timeout). Past the plausibility bound
          the app says what it noticed and offers BOTH resolutions — end it at a time you
          choose, or discard it as never-happened. It never picks, and it never
          auto-ends: "I stopped at some point" and "I never actually fasted" are
          different truths and only the user knows which one happened. The copy points at
          the backdating field above, which is why that control ships with it rather than
          later: an instruction that names an affordance the page does not have is worse
          than no instruction. */}
      {state.kind === "stale" && (
        <div
          data-testid="fasting-stale-suggest"
          className="mt-3 rounded-md bg-slate-50 p-2 text-sm dark:bg-slate-800"
        >
          <p className="mb-2 text-slate-700 dark:text-slate-200">
            This fast has been running for {formatFastDuration(state.elapsedMs)}
            . End it at the time you actually stopped — set that time under
            “Stopped earlier?” above — or discard it if it never happened.
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
            className="rounded-md border border-black/10 px-2 py-1 text-xs disabled:opacity-50 dark:border-white/10"
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
                      className="ml-2 text-xs text-slate-500 dark:text-slate-400"
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
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          A fast counts for the day it ends.
        </p>
      )}
    </section>
  );
}
