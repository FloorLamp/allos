"use client";

// The fasting surface on the Nutrition tab (#2756): a live state chip, one control
// whose label NAMES the write it will perform, the stale suggest, and the history of
// completed fasts — each row of which can have its TIMES CORRECTED (#2993), which is
// what a recorded fast with a mis-set date has instead of a six-second Undo.
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
//
// FOLDED WHEN IDLE, NEVER WHEN LIVE (#3672, owner decision; implemented by #3987).
// The idle state spent a whole card at the top of the page saying nothing happened —
// a section label, "No fast running.", a button and a text link, ~150px of chrome ahead
// of the surface the tab exists for. It is now ONE "Start fast" affordance in the
// day-controls row, in the app's rare-cadence disclosure idiom (#1497: a standing form
// is a tax charged on every visit whether or not the visit is an entry visit); opening
// it reveals today's controls unchanged, history included, because history is reference
// and belongs behind the fold with them.
//
// A RUNNING fast keeps its full prominence. Live state announces itself in this app —
// the same reason the workout dock parks visibly — and folding it would be the one
// change here that costs something real.

import { useEffect, useState } from "react";
import { IconChevronDown, IconPlus } from "@tabler/icons-react";
import Button from "@/components/Button";
import Disclosure from "@/components/Disclosure";
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
  editFastAction,
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
  // The correction form's prefill: this fast's own instants as profile-local WALL times
  // (`YYYY-MM-DDTHH:MM`), resolved on the SERVER, which is the tier that knows the zone.
  startedLocal: string;
  endedLocal: string;
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
  // The recorded fast being CORRECTED (#2993), and the two wall times its form holds.
  // One row at a time: the form is the row, so opening a second one closes the first
  // rather than leaving two sets of times on screen with no way to tell which will save.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");

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
  ): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    try {
      const result = await fn(fd);
      if (!result.ok) {
        // The typed refusal is reported and the backdated value is LEFT IN PLACE — the
        // user may want to correct the time they just entered, and clearing the field
        // under a refusal would make them retype it.
        toast(result.error, { tone: "error" });
        return false;
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
      return true;
    } finally {
      setPending(false);
    }
  }

  // Open the correction form on one recorded fast, prefilled with the times it actually
  // carries. Prefilled rather than blank because the ordinary correction moves ONE of the
  // two — the end of a fast someone forgot to tap — and a blank pair would make the user
  // retype the half that was already right.
  function openEdit(entry: FastHistoryEntry): void {
    setEditingId(entry.fast.id);
    setEditStart(entry.startedLocal);
    setEditEnd(entry.endedLocal);
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
        <Button
          data-testid="fasting-control"
          disabled={pending}
          onClick={() => void run(endFastAction, new FormData())}
        >
          End fast
        </Button>
      </section>
    );
  }

  const idle = state.kind === "start";
  const body = (
    <>
      {!idle && (
        <p
          data-testid="fasting-state"
          className="mb-2 text-sm text-slate-700 dark:text-slate-200"
        >
          Fasting for {formatFastDuration(state.elapsedMs)}.
        </p>
      )}

      <Button
        data-testid="fasting-control"
        disabled={pending}
        onClick={() =>
          void run(
            idle ? startFastAction : endFastAction,
            idle ? withBackdate("started_at") : withBackdate("ended_at")
          )
        }
      >
        {fastControlLabel(state)}
      </Button>

      {/* BACKDATING (#2756): forgot-to-tap is the common failure, so both writes accept
          an explicit instant. Behind a disclosure because the overwhelmingly common tap
          is "now" and a date field in the default path would make a one-tap control a
          form. The field is the profile's own WALL time; the server resolves it. */}
      <div className="mt-2">
        <Button
          data-testid="fasting-backdate-toggle"
          aria-expanded={showBackdate}
          onClick={() => setShowBackdate((v) => !v)}
        >
          {idle ? "Started earlier?" : "Stopped earlier?"}
        </Button>
        {showBackdate && (
          <input
            type="datetime-local"
            data-testid="fasting-backdate-input"
            aria-label={idle ? "Start time" : "End time"}
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
          <Button
            data-testid="fasting-discard"
            disabled={pending}
            onClick={() => {
              const fd = new FormData();
              fd.set("id", String(state.fast.id));
              void run(discardFastAction, fd);
            }}
          >
            Discard
          </Button>
        </div>
      )}

      {history.length > 0 && (
        <ul data-testid="fasting-history" className="mt-3 space-y-1 text-sm">
          {history.map((entry) => {
            // The quiet annotation (#2756): food logged inside a completed fast's
            // interval. BOTH FACTS STAND — the fast is the user's claim and the
            // servings are the user's record — so this reports and offers no verdict.
            const note = servingsDuringFastNote(entry.servingsDuring);
            const editing = editingId === entry.fast.id;
            return (
              <li
                key={entry.fast.id}
                data-testid="fasting-history-row"
                className="text-slate-600 dark:text-slate-300"
              >
                <div className="flex justify-between gap-2">
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
                </div>

                {/* CORRECTING A RECORDED FAST (#2993). A fast recorded with a mis-set
                    date — the 15-day one the app itself calls far likelier to be a typo
                    than a fast — had no way out once the end's Undo lapsed. This is that
                    way out, and it is an EDIT rather than a delete on purpose: removing
                    the row would assert the fast never happened, while correcting its
                    times asserts what actually did. Same disclosure shape as the backdate
                    field above, and the same division of labour — the field carries the
                    profile's WALL time and the server resolves it. */}
                <Button
                  data-testid="fasting-edit-toggle"
                  aria-expanded={editing}
                  onClick={() =>
                    editing ? setEditingId(null) : openEdit(entry)
                  }
                >
                  {editing ? "Cancel" : "Edit times"}
                </Button>
                {editing && (
                  <div
                    data-testid="fasting-edit-form"
                    className="mt-1 space-y-1"
                  >
                    <input
                      type="datetime-local"
                      data-testid="fasting-edit-start"
                      aria-label="Start time"
                      value={editStart}
                      onChange={(e) => setEditStart(e.target.value)}
                      className="input block text-sm"
                    />
                    <input
                      type="datetime-local"
                      data-testid="fasting-edit-end"
                      aria-label="End time"
                      value={editEnd}
                      onChange={(e) => setEditEnd(e.target.value)}
                      className="input block text-sm"
                    />
                    <Button
                      data-testid="fasting-edit-save"
                      disabled={pending}
                      onClick={() => {
                        const fd = new FormData();
                        fd.set("id", String(entry.fast.id));
                        // ONLY THE FIELDS THE USER ACTUALLY MOVED. Each prefill is the
                        // row's own instant rendered at MINUTE grain, so posting an
                        // untouched field asks the server to re-resolve a wall time the
                        // user never typed — which truncates the stored seconds on every
                        // save, loses an hour across a DST fall-back, and loses a whole
                        // offset if the profile's zone changed since this rendered. An
                        // unsent field means "leave this instant alone" (./fast-actions),
                        // the same discipline that keeps `note` out of the edit entirely.
                        if (editStart !== entry.startedLocal)
                          fd.set("started_at", editStart);
                        if (editEnd !== entry.endedLocal)
                          fd.set("ended_at", editEnd);
                        // The form closes only on a write that LANDED. A typed refusal
                        // leaves the times on screen for the same reason the backdate
                        // field keeps its value: the user is one character from the
                        // correction, and clearing it would make them start over.
                        void run(editFastAction, fd).then((saved) => {
                          if (saved) setEditingId(null);
                        });
                      }}
                    >
                      Save times
                    </Button>
                  </div>
                )}
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
    </>
  );

  // IDLE: one affordance, and everything else behind it. The summary is the whole
  // control at rest, so `fasting-state` — the sentence that said "No fast running." —
  // has no reason to exist any more: the collapsed fold IS that statement.
  if (idle) {
    return (
      <Disclosure data-testid="fasting-card" className="mb-4">
        <summary
          data-testid="fasting-fold"
          className="fold-control flex list-none items-center gap-1.5 text-sm font-medium text-slate-600 [&::-webkit-details-marker]:hidden dark:text-slate-300"
        >
          <IconPlus className="h-4 w-4 shrink-0" stroke={2} />
          <span className="flex-1">Start fast</span>
          <IconChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-2">{body}</div>
      </Disclosure>
    );
  }

  // RUNNING: unchanged. Live state announces itself.
  return (
    <section
      data-testid="fasting-card"
      className="mb-4 rounded-lg border border-black/10 p-3 dark:border-white/10"
    >
      <h2 className="mb-2 section-label">Fasting</h2>
      {body}
    </section>
  );
}
