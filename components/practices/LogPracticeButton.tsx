"use client";

import { useState, type FormEvent } from "react";
import { IconCheck, IconClock, IconMinus, IconPlus } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import DateField from "@/components/DateField";
import { practiceRelogMessage, shouldConfirmRelog } from "@/lib/one-tap";
import {
  PRACTICE_DURATION_STEP_MIN,
  PRACTICE_USUAL_DAY_TEXT,
  stepPracticeDuration,
} from "@/lib/practice";
import {
  DOSE_ACTION_BRAND,
  DOSE_ACTION_LABEL,
  DOSE_ACTION_NEUTRAL,
} from "@/components/medications/dose-action-styles";
import type { PracticeLogOutcome } from "@/lib/types";
import { logPractice } from "@/app/(app)/wellness/actions";

// Shared one-tap "Log session" control for a wellness practice (#1259). Logs a session for
// TODAY through the shared write core and answers from its typed outcome — NEVER an
// unconditional confirm (a session log is not idempotent; multi-session days are the
// point). Today's running count sits beside the button (the PRN widget shape) so a
// deliberate second tap is informed, not accidental. The button is a plain formatter
// over the one server action every practice surface shares.
//
// A practice session is the CADENCED case of #2007 — additive, but with a real
// ~daily expectation — so all three layers apply here:
//
//   1. the shared ledger's post-success cooldown absorbs the accidental double-tap;
//   2. the affordance RENDERS today's state (#1893): once a session is logged the
//      button reads "Log another" and names the day's count, so the second tap is
//      never byte-identical to the first;
//   3. only then, a deliberate second tap of the same day ASKS — a confirm, never a
//      block (#798): a genuine second sauna is legitimate, so the dialog's default is
//      to proceed and cancelling writes nothing.
export default function LogPracticeButton({
  practice,
  todayCount,
  atCeiling = false,
  today,
  defaultDurationMin = null,
  showDetails = false,
  inlineDuration = false,
  lastLoggedTime = null,
  usualSessionDay = false,
}: {
  practice: string;
  // Sessions already logged on `today`, by contract — both the line beside the button
  // and the day-scoped re-log question read it.
  todayCount: number;
  atCeiling?: boolean;
  // The acting profile's today (YYYY-MM-DD).
  today: string;
  // The duration the controls START at — `practiceDurationPrefill` server-side, never
  // re-derived here. Null means blank, and blank is a real answer.
  defaultDurationMin?: number | null;
  showDetails?: boolean;
  // Render the INLINE duration stepper beside the tap (#2204). On for the quick-log
  // sheet — whose whole reason for existing is that opening the expanded form is the
  // thing you were avoiding — and, by owner ruling, on the Wellness card too: the
  // card's one-tap button discarded the duration just as silently, and "the modal is
  // one tap away" answered where the field LIVES, not what the tap WRITES. The two
  // controls share one `duration` state there, so the modal opens holding whatever the
  // stepper shows and vice versa.
  //
  // The gate is load-bearing for constraint 2 ("a logged duration must always be one
  // the user saw"): `duration` is seeded from the prefill for the modal's benefit on
  // every mount, so the one-tap write may only send it where the stepper is actually
  // on screen. A surface without the stepper posts no duration at all, exactly as
  // before. See `stepperShown` below — the render and the write read ONE expression,
  // and any future condition on the stepper's visibility belongs there rather than in
  // the JSX, or the two drift and a value nobody saw gets logged.
  inlineDuration?: boolean;
  // The local HH:MM of today's most recent session, when the surface knows it. The
  // confirm names it ("You logged Sauna today at 08:12"); a surface that only holds
  // the count still asks an honest question rather than inventing a time.
  lastLoggedTime?: string | null;
  // Whether today is one of this practice's INFERRED rhythm days (#2188). The server
  // decides (isPredictedPracticeDay / WellnessPractice.usuallyToday); this component
  // only formats. No pattern → the caller passes false and the note renders NOWHERE
  // (#558). Data, not dueness (#1505) — it never changes the button or the counts.
  usualSessionDay?: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const ledger = useOptimisticLedger("practice-session");
  const [pending, setPending] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [count, setCount] = useState(todayCount);
  // The time the confirm names, dropped once this mount logs its own session: the
  // action answers with the day's count, not with a local clock reading, and a stale
  // time on a fresh session would be the informational half telling a small lie.
  const [lastTime, setLastTime] = useState(lastLoggedTime);
  // Follow the SERVER whenever it disagrees. The local count exists so a tap answers
  // instantly, but every write here revalidates, and sessions can also be deleted or
  // corrected from the history table beside this button — after which a local count
  // frozen at mount would both label the button wrongly and ask the re-log question
  // about a day that no longer has a session in it.
  const [serverCount, setServerCount] = useState(todayCount);
  if (serverCount !== todayCount) {
    setServerCount(todayCount);
    setCount(todayCount);
    setLastTime(lastLoggedTime);
  }
  const [duration, setDuration] = useState(
    defaultDurationMin == null ? "" : String(defaultDurationMin)
  );
  // Follow the SERVER's prefill for the same reason the count does: the prefill is
  // "the last LOGGED duration", and a session can be corrected or deleted from the
  // history table beside this button. A local value frozen at mount would keep
  // offering a duration the log no longer contains — which is the "last-shown"
  // failure #2204 constraint 4 names, arriving by the back door.
  const [serverDuration, setServerDuration] = useState(defaultDurationMin);
  if (serverDuration !== defaultDurationMin) {
    setServerDuration(defaultDurationMin);
    setDuration(defaultDurationMin == null ? "" : String(defaultDurationMin));
  }

  // ONE expression, read by BOTH the stepper's render and the tap's write. Constraint
  // 2 of #2204 — a logged duration must always be one the user saw — is only as strong
  // as the fact that these two cannot disagree, so a future rule ("hide the stepper at
  // the weekly ceiling", "hide it on a narrow row") is added HERE and both halves
  // follow it. Adding it to the JSX alone would leave the tap posting a value that is
  // no longer on screen, which is precisely the failure the constraint names.
  const stepperShown = inlineDuration;

  // The stepper's current value as the pure helper speaks it. A half-typed or
  // non-numeric input reads as blank rather than NaN.
  const durationValue = (): number | null => {
    const n = Number(duration);
    return duration.trim() !== "" && Number.isFinite(n) && n >= 1
      ? Math.round(n)
      : null;
  };
  function step(delta: number) {
    const next = stepPracticeDuration(durationValue(), delta);
    setDuration(next == null ? "" : String(next));
  }

  function report(outcome: PracticeLogOutcome) {
    if (outcome.kind === "logged") {
      setCount(outcome.count);
      setLastTime(null);
      toast(
        outcome.count === 1
          ? "Logged today's session"
          : `Logged — ${outcome.count} sessions today`
      );
      return;
    }
    toast("Couldn't log that session.");
  }

  async function onClick() {
    // Inside the post-success window this tap is the second half of a double-tap:
    // absorbed silently, and — checked here rather than inside `tap` — never
    // escalated into a dialog the user did not ask for.
    if (ledger.blocked()) return;
    // Layer 3. `count` is TODAY's by the prop's contract, so a non-zero count is a
    // session already logged on `today`; the shared decision owns what that means.
    const asks = shouldConfirmRelog({
      affordance: ledger.affordance,
      lastLoggedDate: count > 0 ? today : null,
      today,
    });
    if (
      asks &&
      !(await confirm({
        title: "Log another session?",
        message: practiceRelogMessage(practice, count, lastTime),
        confirmLabel: "Log session",
      }))
    )
      return;
    await ledger.tap({
      write: () => {
        const fd = new FormData();
        fd.set("practice", practice);
        // Only where the stepper is rendered, and only when it holds a value: the tap
        // may write a duration the user SAW, never the seeded-for-the-modal state.
        // No `time` field is set on any path here — its absence is what tells the
        // write core to stamp the tap instant (#2204 part 2).
        const mins = stepperShown ? durationValue() : null;
        if (mins != null) fd.set("duration_min", String(mins));
        return logPractice(fd);
      },
      settle: (outcome) => {
        report(outcome);
        // A refused log (a forged date, a stale target) wrote nothing, so the tap
        // stays immediately retryable instead of cooling down.
        return outcome.kind === "logged"
          ? { kind: "keep" }
          : { kind: "rollback" };
      },
      onError: () => {
        toast("Couldn't log that session. Try again.");
        return { kind: "rollback" };
      },
    });
  }

  async function onDetailedSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    const fd = new FormData(form);
    fd.set("practice", practice);
    try {
      const outcome = await logPractice(fd);
      report(outcome);
      if (outcome.kind === "logged") {
        setDetailsOpen(false);
      }
    } catch {
      toast("Couldn't log that session. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="flex flex-wrap items-start justify-between gap-3"
      data-testid="practice-log-control"
    >
      <div className="min-w-0">
        <div className="section-label">Today</div>
        <div
          className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-200"
          data-testid="practice-today-count"
        >
          {count === 0
            ? "No sessions yet"
            : count === 1
              ? "1 session logged"
              : `${count} sessions logged`}
          {atCeiling ? " · weekly maximum reached" : ""}
          {/* The rhythm note (#2188): only on a predicted day with nothing logged
              yet, and NEVER at the ceiling — a dose-limited practice done for the
              week must not be handed a reason for more (#998's posture). */}
          {count === 0 && usualSessionDay && !atCeiling && (
            <span data-testid="practice-rhythm-note">
              {" · "}
              {PRACTICE_USUAL_DAY_TEXT}
            </span>
          )}
        </div>
      </div>
      {/* The control cluster WRAPS, and stopped being `shrink-0`, once the stepper
          joined it on a surface that also carries "Log with details" (#2204 + the
          owner ruling). Three controls in one un-shrinkable row overflowed a 390px
          phone by ~26px, which `expectNoClippedContent` caught. `justify-end` keeps
          the cluster right-aligned against the count when it fits on one line, and
          the details button drops to a second line when it does not. */}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
        {/* The INLINE duration control (#2204). The standing objection was never to
            the field — it was to stacking a MODAL over a one-tap sheet, and that
            objection holds. This is the other shape: prefilled from the practice's
            own last logged session, accepted by the same "Log now" tap that already
            existed (zero extra taps when the default is right, which is the common
            case), adjusted with two steppers, and cleared by stepping off the bottom.
            Nothing here logs — the value rides the existing tap's FormData. */}
        {stepperShown && (
          // shrink-0: the three parts of the stepper stay together and stay legible;
          // the cluster above is what wraps.
          <div
            className="flex shrink-0 items-center gap-0.5"
            data-testid="practice-inline-duration"
          >
            <button
              type="button"
              onClick={() => step(-PRACTICE_DURATION_STEP_MIN)}
              disabled={pending || ledger.pending() || duration === ""}
              className={`${DOSE_ACTION_LABEL} ${DOSE_ACTION_NEUTRAL} px-1.5`}
              aria-label={`Shorten the ${practice} session by ${PRACTICE_DURATION_STEP_MIN} minutes`}
              title={`−${PRACTICE_DURATION_STEP_MIN} min`}
              data-testid="practice-duration-down"
            >
              <IconMinus className="h-3.5 w-3.5" stroke={2.5} aria-hidden />
            </button>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
              className="input w-14 px-1.5 py-1 text-center text-sm"
              aria-label={`Duration in minutes for this ${practice} session`}
              placeholder="min"
              data-testid="practice-duration-input"
            />
            <button
              type="button"
              onClick={() => step(PRACTICE_DURATION_STEP_MIN)}
              disabled={pending || ledger.pending()}
              className={`${DOSE_ACTION_LABEL} ${DOSE_ACTION_NEUTRAL} px-1.5`}
              aria-label={`Lengthen the ${practice} session by ${PRACTICE_DURATION_STEP_MIN} minutes`}
              title={`+${PRACTICE_DURATION_STEP_MIN} min`}
              data-testid="practice-duration-up"
            >
              <IconPlus className="h-3.5 w-3.5" stroke={2.5} aria-hidden />
            </button>
          </div>
        )}
        <button
          type="button"
          disabled={pending || ledger.pending()}
          onClick={onClick}
          data-testid="practice-log-button"
          // Layer 2 (#1893's doctrine): the affordance renders today's state, so the
          // second tap of a day is visibly a SECOND one before it is taken. The
          // count itself is on the line beside it — the title carries the whole
          // sentence for a pointer, and the label stays short enough for a phone.
          title={
            count === 0
              ? `Log a ${practice} session for today`
              : `Log another ${practice} session — ${count} already logged today`
          }
          className={`${DOSE_ACTION_LABEL} ${DOSE_ACTION_BRAND}`}
        >
          <IconCheck className="h-3.5 w-3.5" stroke={2.5} aria-hidden />
          {count === 0 ? "Log now" : "Log another"}
        </button>
        {showDetails && (
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            disabled={pending}
            className={`${DOSE_ACTION_LABEL} ${DOSE_ACTION_NEUTRAL}`}
            aria-label="Log with details"
            title="Log with details"
            data-testid="practice-log-details-trigger"
          >
            <IconClock className="h-4 w-4" stroke={2} aria-hidden />
            <span className="sm:hidden">Details</span>
            <span className="hidden sm:inline">Log with details</span>
          </button>
        )}
      </div>
      {detailsOpen && (
        <ModalShell
          title={`Log ${practice}`}
          onClose={() => setDetailsOpen(false)}
          className="w-full max-w-lg rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900"
        >
          <form
            onSubmit={onDetailedSubmit}
            className="mt-4 grid gap-3 sm:grid-cols-2"
            data-testid="practice-log-details"
          >
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Date
              <DateField
                name="date"
                defaultValue={today}
                inputClassName="mt-1 w-full"
                required
              />
            </label>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Time
              <input type="time" name="time" className="input mt-1 w-full" />
            </label>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Duration (minutes)
              <input
                type="number"
                name="duration_min"
                min="1"
                step="1"
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
                className="input mt-1 w-full"
              />
            </label>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200 sm:col-span-2">
              Notes
              <textarea name="notes" rows={2} className="input mt-1 w-full" />
            </label>
            <button
              type="submit"
              disabled={pending}
              className="btn w-fit disabled:opacity-50 sm:col-span-2"
              data-testid="practice-log-detailed-submit"
            >
              {pending ? "Logging…" : "Log session"}
            </button>
          </form>
        </ModalShell>
      )}
    </div>
  );
}
