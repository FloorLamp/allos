"use client";

import { useState } from "react";
import {
  IconCheck,
  IconClock,
  IconMinus,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
} from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import PracticeSessionForm from "@/components/practices/PracticeSessionForm";
import { useTimeStatement } from "@/components/TimeStatement";
import { practiceRelogMessage, shouldConfirmRelog } from "@/lib/one-tap";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import {
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
  shouldQueueOffline,
} from "@/lib/offline/queue";
import {
  PRACTICE_DURATION_STEP_MIN,
  PRACTICE_USUAL_DAY_TEXT,
  practiceIdentity,
  practiceLogOutcomeText,
  stepPracticeDuration,
} from "@/lib/practice";
import {
  DOSE_ACTION_BRAND,
  DOSE_ACTION_LABEL,
  DOSE_ACTION_NEUTRAL,
} from "@/components/medications/dose-action-styles";
import type { LivePracticeSession, PracticeLogOutcome } from "@/lib/types";
import {
  endPracticeLive,
  logPractice,
  startPracticeLive,
} from "@/app/(app)/wellness/actions";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";

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
  liveSession = null,
  showDetails = false,
  inlineDuration = false,
  inlineWhen = false,
  lastLoggedTime = null,
  usualSessionDay = false,
  compact = false,
  primaryTone = "brand",
  defaultDetailsOpen = false,
  initialDetailsDate,
  detailsMinDate,
  detailsMaxDate,
  subjectProfileId,
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
  liveSession?: LivePracticeSession | null;
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
  // Quick-sheet-only collapsed statement retained from #3273. With the new
  // just-finished intent it states the observed END, not an invented start.
  inlineWhen?: boolean;
  // The local HH:MM of today's most recent session, when the surface knows it. The
  // confirm names it ("You logged Sauna today at 08:12"); a surface that only holds
  // the count still asks an honest question rather than inventing a time.
  lastLoggedTime?: string | null;
  // Whether today is one of this practice's INFERRED rhythm days (#2188). The server
  // decides (isPredictedPracticeDay / WellnessPractice.usuallyToday); this component
  // only formats. No pattern → the caller passes false and the note renders NOWHERE
  // (#558). Data, not dueness (#1505) — it never changes the button or the counts.
  usualSessionDay?: boolean;
  // Dashboard protocol rows collapse the redundant TODAY / no-sessions chrome.
  compact?: boolean;
  // A may-tier practice is a secondary dashboard action, never the page's loudest.
  primaryTone?: "brand" | "neutral";
  defaultDetailsOpen?: boolean;
  initialDetailsDate?: string;
  detailsMinDate?: string;
  detailsMaxDate?: string;
  // THE SUBJECT, OPTIONAL AND SPELLED ONCE (#4424 ruling 4): absent means the acting
  // profile, present posts `profile_id` and is re-gated server-side by
  // `gateItemProfile`. Upcoming's multi-view rows are the mount that needs it — a
  // practice due on Sam's row must write to SAM — and the offline queue is narrowed
  // to the acting profile because a replay carries no session to gate against.
  subjectProfileId?: number;
}) {
  // WHICH SURFACE THIS MOUNTING IS (#3087). One component, four homes — the Wellness
  // card, the protocols row, the quick-log sheet and Upcoming's practice row — all
  // posting ONE Server Action, so only the mounting can say where a tap happened.
  // Read from the region rather than taken as a prop: a prop has to be passed at every
  // one of those four call sites and is silent when it is not, which is the failure
  // mode this column exists to avoid. Posted as a form field and re-checked
  // server-side against the web subset.
  //
  // THE BACKFILL LAUNCHER USED TO BE ON THAT LIST AND IS NOT A MOUNT OF THIS COMPONENT
  // — it mounts the FORM (#3143 extracted it), which is why it could be named here
  // while never posting a tap. Upcoming's row took its place for real (#4424).
  const stampLoggedVia = useLoggedViaStamp();
  // EVERY WRITE THIS CONTROL POSTS NAMES ITS SUBJECT (ruling 4), including the live
  // lifecycle's two: a mount that could log a household member's session while
  // starting the ACTING profile's would be the cross-profile leak the ruling exists to
  // close. Absent on a single-subject mount, which posts a byte-identical body.
  const subject = (fd: FormData): FormData => {
    if (subjectProfileId != null)
      fd.set("profile_id", String(subjectProfileId));
    return fd;
  };
  const toast = useToast();
  const confirm = useConfirm();
  const ledger = useOptimisticLedger("practice-session");
  const { enqueue } = useOfflineQueue();
  const [pending, setPending] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(defaultDetailsOpen);
  const [count, setCount] = useState(todayCount);
  const [currentLive, setCurrentLive] = useState(liveSession);
  const [serverLive, setServerLive] = useState(liveSession);
  if (serverLive?.id !== liveSession?.id) {
    setServerLive(liveSession);
    setCurrentLive(liveSession);
  }
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
  // Follow the SERVER's usual-duration prefill for the same reason the count does: a
  // session can be corrected or deleted from the history table beside this button. A
  // local value frozen at mount would keep offering a duration the log no longer
  // supports.
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
  // The duration belongs to the Just-finished statement. A running session's End
  // action derives elapsed time from its two taps, so leaving this input beside End
  // would show a value that the action deliberately ignores.
  const stepperShown = inlineDuration && !currentLive;
  // The collapsed time statement, retained from #3273 and now the shared one (#4426).
  // The same one-expression discipline the stepper keeps: `shown` is what both the
  // render and the write read, so a running session — whose End action derives elapsed
  // time from its two taps — can neither show the statement nor post one.
  const statement = useTimeStatement({
    shown: inlineWhen && !currentLive,
    day: today,
    label: "Happened earlier?",
    timeLabel: `End time of this ${practice} session`,
    testId: "practice-when",
    disabled: pending || ledger.pending(),
    className: "w-full",
  });

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
      if (outcome.date === today) {
        setCount(outcome.count);
        setLastTime(null);
      }
    }
    toast(practiceLogOutcomeText(outcome, today));
  }

  // Park this tap for replay (#2908). DAY-IDEMPOTENT by construction: the replay
  // inserts only when this (practice-identity, day) still holds no session, so a day
  // already logged from another device is a no-op rather than a second session — which
  // is exactly what makes the offline capture safe without the #2007 confirm, since
  // there is no server to ask.
  async function queueOffline(): Promise<void> {
    const mins = stepperShown ? durationValue() : null;
    const kept =
      (await enqueue("practice", today, {
        practice,
        identity: practiceIdentity(practice),
        durationMin: mins,
      })) === "kept";
    // READ THE ANSWER. The queue can refuse — this device is logged out, or has no
    // IndexedDB to queue into — and the toast below promises the tap will sync. Nothing
    // contradicts that promise afterwards: no badge, no dead-letter entry, no replay. The
    // count must not move either, since it is this card's claim that the practice landed.
    // Every quick-log flow reads this boolean and answers with the one shared
    // sentence (#3038; the enumeration lives on the constant).
    if (!kept) {
      toast(OFFLINE_CAPTURE_REFUSED_MESSAGE, { tone: "error" });
      return;
    }
    setCount((n) => n + 1);
    toast("Saved offline — it'll sync when you're back online.");
  }

  async function onFinished() {
    // Inside the post-success window this tap is the second half of a double-tap:
    // absorbed silently, and — checked here rather than inside `tap` — never
    // escalated into a dialog the user did not ask for.
    if (ledger.blocked()) return;
    // Offline, a second same-day tap enqueues NOTHING: the replay would no-op it, and
    // a queue badge counting an entry that will never become a session is its own small
    // lie. The narrowing is enforced here, not merely documented.
    // A CROSS-PROFILE TAP NEVER QUEUES (the #1373 dose rule, same seam): the replay
    // route carries no target profile, so a captured session would land on the acting
    // one. Go online and let a dropped link surface the retry sentence instead.
    if (
      typeof navigator !== "undefined" &&
      navigator.onLine === false &&
      subjectProfileId == null
    ) {
      if (count > 0) {
        toast("Already logged today — it'll sync when you're back online.");
        return;
      }
      await queueOffline();
      return;
    }
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
    // The statement THIS tap consumes, read once — both as the wall time it posts and
    // as the value the spend below compares against.
    const stated = statement.at;
    await ledger.tap({
      write: () => {
        const fd = subject(new FormData());
        stampLoggedVia(fd);
        fd.set("practice", practice);
        fd.set("intent", "finished");
        // Only where the stepper is rendered, and only when it holds a value: the tap
        // may write a duration the user SAW, never the seeded-for-the-modal state.
        // The intent is the statement: the server stamps the end tap and derives a
        // start only from the visible usual duration. Client clock fields never cross
        // this boundary.
        const mins = stepperShown ? durationValue() : null;
        if (mins != null) fd.set("duration_min", String(mins));
        // Only where the control is rendered AND a time was stated. The field's
        // ABSENCE is what tells the write core to stamp the tap instant (#2204 part
        // 2), so an untouched surface posts exactly the body it posted before.
        if (stated) fd.set("end_time", stated);
        return logPractice(fd);
      },
      settle: (outcome) => {
        report(outcome);
        if (outcome.kind === "logged") statement.spend(stated);
        // A refused log (a forged date, a stale target) wrote nothing, so the tap
        // stays immediately retryable instead of cooling down.
        return outcome.kind === "logged"
          ? { kind: "keep" }
          : { kind: "rollback" };
      },
      onError: (err) => {
        // The connection dropped between the online check above and the submit (or the
        // tab's build went stale). Park it rather than losing the tap — same reading of
        // the failure the dose confirm takes.
        if (
          shouldQueueOffline(navigator.onLine !== false, err) &&
          count === 0 &&
          subjectProfileId == null
        ) {
          void queueOffline();
          return { kind: "keep" };
        }
        toast("Couldn't log that session. Try again.");
        return { kind: "rollback" };
      },
    });
  }

  async function onStart() {
    if (pending || currentLive) return;
    setPending(true);
    const fd = subject(new FormData());
    stampLoggedVia(fd);
    fd.set("practice", practice);
    try {
      const outcome = await startPracticeLive(fd);
      if (outcome.kind === "started") {
        setCurrentLive(outcome.session);
        toast("Session started");
      } else if (outcome.kind === "already-live") {
        // The server's row wins over this mount's stale state. Offer the same shared
        // decision substrate as re-log, and end ONLY the exact row the typed refusal
        // returned — never a client-guessed practice/name lookup.
        setCurrentLive(outcome.session);
        if (
          await confirm({
            title: "End running session?",
            message: `${practice} is already running. End it now?`,
            confirmLabel: "End session",
          })
        ) {
          await finishLive(outcome.session);
        } else {
          toast("Session is already running");
        }
      } else {
        toast("Couldn't start that session.");
      }
    } catch {
      toast("Couldn't start that session. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function finishLive(session: LivePracticeSession) {
    const fd = subject(new FormData());
    fd.set("id", String(session.id));
    const outcome = await endPracticeLive(fd);
    if (outcome.kind === "ended") {
      setCurrentLive(null);
      setCount(outcome.count);
      setLastTime(null);
      toast("Session finished");
    } else {
      setCurrentLive(null);
      toast("That session is no longer running.");
    }
  }

  async function onEnd() {
    if (pending || !currentLive) return;
    setPending(true);
    try {
      await finishLive(currentLive);
    } catch {
      toast("Couldn't end that session. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className={`flex flex-wrap justify-between gap-3 ${
        compact ? "items-center" : "items-start"
      }`}
      data-testid="practice-log-control"
    >
      {!compact || count > 0 || usualSessionDay || atCeiling ? (
        <div className="min-w-0">
          {!compact ? <div className="section-label">Today</div> : null}
          <div
            className={`${compact ? "" : "mt-1 "}text-sm font-medium text-slate-700 dark:text-slate-200`}
            data-testid="practice-today-count"
          >
            {count === 0
              ? compact
                ? null
                : "No sessions yet"
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
      ) : null}
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
              data-testid="practice-duration-up"
            >
              <IconPlus className="h-3.5 w-3.5" stroke={2.5} aria-hidden />
            </button>
          </div>
        )}
        {currentLive ? (
          <button
            type="button"
            disabled={pending}
            onClick={onEnd}
            data-testid="practice-end-button"
            aria-label={`End the running ${practice} session`}
            className={`${DOSE_ACTION_LABEL} ${DOSE_ACTION_BRAND}`}
          >
            <IconPlayerStop className="h-3.5 w-3.5" stroke={2.5} aria-hidden />
            End session
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={onStart}
              data-testid="practice-start-button"
              aria-label={`Start a ${practice} session now`}
              className={`${DOSE_ACTION_LABEL} ${DOSE_ACTION_NEUTRAL}`}
            >
              <IconPlayerPlay
                className="h-3.5 w-3.5"
                stroke={2.5}
                aria-hidden
              />
              Start now
            </button>
            <button
              type="button"
              disabled={pending || ledger.blocked()}
              onClick={onFinished}
              data-testid="practice-log-button"
              // Layer 2 (#1893's doctrine): the affordance renders today's state, so the
              // second tap of a day is visibly a SECOND one before it is taken. The
              // count itself is on the line beside it; the accessible name composes the
              // whole sentence while the visible label stays short enough for a phone.
              aria-label={
                count === 0
                  ? `Just finished a ${practice} session`
                  : `Just finished another ${practice} session — ${count} already logged today`
              }
              className={`${DOSE_ACTION_LABEL} ${
                primaryTone === "neutral"
                  ? DOSE_ACTION_NEUTRAL
                  : DOSE_ACTION_BRAND
              }`}
            >
              <IconCheck className="h-3.5 w-3.5" stroke={2.5} aria-hidden />
              Just finished
            </button>
          </>
        )}
        {showDetails && (
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            disabled={pending}
            className={`${DOSE_ACTION_LABEL} ${DOSE_ACTION_NEUTRAL}`}
            aria-label="Log with details"
            data-testid="practice-log-details-trigger"
          >
            <IconClock className="h-4 w-4" stroke={2} aria-hidden />
            <span className="sm:hidden">Details</span>
            <span className="hidden sm:inline">Log with details</span>
          </button>
        )}
      </div>
      {statement.node}
      {detailsOpen && (
        <ModalShell
          title={`Log ${practice}`}
          onClose={() => setDetailsOpen(false)}
          size="sm"
        >
          <PracticeSessionForm
            practices={[practice]}
            today={today}
            date={initialDetailsDate ?? today}
            defaultDurationMin={durationValue()}
            minDate={detailsMinDate}
            maxDate={detailsMaxDate}
            subjectProfileId={subjectProfileId}
            onSaved={(logged) => {
              // The form owns its own confirmation; what the BUTTON still owns is the
              // day's count on the line beside it, which only a same-day log moves.
              if (logged && logged.date === today) {
                setCount(logged.count);
                setLastTime(null);
              }
              setDetailsOpen(false);
            }}
            onCancel={() => setDetailsOpen(false)}
          />
        </ModalShell>
      )}
    </div>
  );
}
