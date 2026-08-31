"use client";

import { useEffect, useMemo, useState } from "react";
import { IconCheck, IconPlayerTrackNext, IconPlus } from "@tabler/icons-react";
import Button from "@/components/Button";
import QuickLogPrnContent from "@/components/medications/QuickLogPrnContent";
import SegmentedControl from "@/components/SegmentedControl";
import { useWritePipeline } from "@/components/useWritePipeline";
import { settleDayDoses } from "@/components/medications/dose-day-settlement";
import {
  DOSE_ACTION_BRAND,
  DOSE_ACTION_ICON,
  DOSE_ACTION_NEUTRAL,
} from "@/components/medications/dose-action-styles";
import { doseConfirmMessage, doseResolved } from "@/lib/dose-outcome-text";
import { dosesPhrase } from "@/lib/usual-routine";
import { TIME_BUCKET_LABELS, type TimeBucket } from "@/lib/intake-schedule";
import { localDate } from "@/lib/offline/queue";
import { markTaken } from "@/app/(app)/upcoming/actions";
import { resolveDayDoses } from "@/app/(app)/nutrition/intake-actions";
import type {
  QuickEntryDose,
  QuickEntryPastDay,
  QuickEntryPastDose,
  QuickEntryPrn,
} from "@/app/(app)/quick-entry-actions";

// The quick-entry overlay's DOSE form (issue #1468), with the recent-past day
// switcher (#3936).
//
// It is a thin LIST over existing write paths, not a new one. Today's rows come from
// the same `collectDueDosesNow` computation the context chip reads and confirm through
// the EXISTING `markTaken` action — the same idempotent markDoseTaken the Upcoming
// page's inline form, the dashboard atom and the Telegram tap all go through. Nothing
// here logs a dose itself.
//
// **It never unconditionally confirms.** `markTaken` returns markDoseTaken's typed
// DoseTakenOutcome, and every branch is answered from it: a dose retired by a schedule
// edit, an item since paused, or a dose already resolved as SKIPPED logs NOTHING, and
// saying "Dose logged" there would be a false confirmation of a possibly-critical
// medication (the #280 defect). The row only leaves the list when the outcome says a
// taken log actually stands; otherwise it stays put with the honest message beside it,
// because it is still due.
//
// ── THE DAY SWITCHER (#3936) ─────────────────────────────────────────────────
//
// Every fast path in the app was today/now-only, so a forgotten day cost N item
// traversals and N date/time forms — which is why a forgotten day stayed unlogged and
// the adherence record lied. The switcher offers exactly `doseLogDays(today)`: today,
// yesterday, the day before. Those three days are resolved SERVER-side from
// DOSE_LOG_DATE_WINDOW_DAYS, the same constant `markDoseTaken` / `markDoseSkipped`
// gate on, so the sheet cannot offer a day the write would refuse. A fourth day is a
// different decision and is not this control's to make.
//
// A past day differs from today in two ways, both of them the day's own doing rather
// than a second policy: nothing is filtered by arrived slot (every bucket of a closed
// day has arrived), and the row carries BOTH verbs, because on a day that has already
// ended "I skipped it" is as ordinary an answer as "I took it".
// The identity of one dose OCCURRENCE: the profile-local day it belongs to plus the
// schedule row that asks for it. Minted in exactly one place so no reader can key on
// half of it.
function occurrenceKey(date: string, doseId: number): string {
  return `${date}:${doseId}`;
}

export default function QuickDoseList({
  today,
  doses,
  prn,
  pastDays,
  onDone,
}: {
  today: string;
  doses: QuickEntryDose[];
  prn?: QuickEntryPrn;
  pastDays: QuickEntryPastDay[];
  // Called once the sheet has nothing left to confirm on ANY offered day — the
  // overlay closes itself rather than leaving an empty sheet on screen. Today
  // emptying on its own is NOT that moment any more: closing then would take the
  // switcher, and the missed day behind it, away with it.
  onDone: () => void;
}) {
  // The shared client write pipeline (#3276) — the same one DoseStatusControl runs, so
  // today's row cannot drift from the tri-state control's contract again (#3272).
  const pipeline = useWritePipeline("dose-status");
  // Doses resolved during THIS overlay session, dropped from their day's list. Local
  // rather than re-fetched: the sheet is a transactional surface, and re-running the
  // gather mid-list would reorder rows under the user's finger.
  //
  // KEYED BY (DAY, DOSE), AND THAT IS THE WHOLE POINT. `doseId` is an
  // `intake_item_doses` row id — a SCHEDULE row, not an occurrence — so a daily
  // supplement unlogged for three days is the same id on all three tabs. Keying this
  // by dose id alone meant logging yesterday's forgotten dose ALSO struck today's row
  // off the list and, with nothing left to show, closed the sheet with a success
  // toast — the #280 false-confirmation this file's header says it never commits,
  // reached by the most ordinary use of the control. It reversed too, and `notes`
  // carried the same collision: a refusal earned on yesterday rendered under today's
  // row. One occurrence is one (day, dose) pair; nothing here may key on less.
  const [resolved, setResolved] = useState<Set<string>>(() => new Set());
  // The last outcome per (day, dose) that did NOT resolve it — shown inline so the
  // reason the row is still there is legible without hunting for the toast.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [day, setDay] = useState(today);

  const remaining = doses.filter(
    (d) => !resolved.has(occurrenceKey(today, d.doseId))
  );
  const pastSlots = useMemo(
    () =>
      new Map(
        pastDays.map((past) => [
          past.date,
          past.slots
            .map((slot) => ({
              ...slot,
              doses: slot.doses.filter(
                (d) => !resolved.has(occurrenceKey(past.date, d.doseId))
              ),
            }))
            .filter((slot) => slot.doses.length > 0),
        ])
      ),
    [pastDays, resolved]
  );

  // FUNCTIONAL, not `new Set(resolved)`. The past-day view is the first surface here
  // built for resolving SEVERAL doses in quick succession — and the bulk row calls this
  // with many ids at once — so two taps landing inside one render batch would have the
  // second overwrite the first from a stale closure: the first row reappears, and
  // tapping it again earns "Nothing left to log for that day." in error tone for a dose
  // that is correctly logged. `setNotes` beside it was already written this way.
  function markResolved(date: string, doseIds: readonly number[]): void {
    setResolved((prev) => {
      const next = new Set(prev);
      for (const id of doseIds) next.add(occurrenceKey(date, id));
      return next;
    });
  }

  // Nothing left ANYWHERE in the window is the only state that may close the sheet, and
  // it is asked from the COMMITTED `resolved` rather than inside the updater above —
  // an updater must stay pure (React may invoke it twice), and closing the sheet is the
  // least pure thing this component does. `resolved.size > 0` keeps it to days this
  // session actually cleared: a sheet that opened with something to show never closes
  // itself on mount.
  useEffect(() => {
    if (resolved.size === 0) return;
    const left =
      doses.some((d) => !resolved.has(occurrenceKey(today, d.doseId))) ||
      pastDays.some((past) =>
        past.slots.some((slot) =>
          slot.doses.some(
            (d) => !resolved.has(occurrenceKey(past.date, d.doseId))
          )
        )
      );
    if (!left) onDone();
  }, [resolved, doses, pastDays, today, onDone]);

  async function confirm(dose: QuickEntryDose) {
    const result = await pipeline.run({
      key: occurrenceKey(today, dose.doseId),
      fields: { dose_id: String(dose.doseId) },
      action: markTaken,
      // Never an unconditional confirm: `markTaken` returns markDoseTaken's typed
      // outcome, and a dose retired, paused or already skipped logs NOTHING. The row
      // only leaves the list when a taken log actually stands (#280).
      settle: (result) => {
        if (!result.ok)
          return {
            wrote: false,
            announce: { message: result.error, tone: "error", undo: null },
          };
        const { text, tone } = doseConfirmMessage(result.outcome);
        const resolvedNow = doseResolved(result.outcome);
        if (resolvedNow) markResolved(today, [dose.doseId]);
        else
          setNotes((prev) => ({
            ...prev,
            [occurrenceKey(today, dose.doseId)]: text,
          }));
        return {
          wrote: resolvedNow,
          // NO UNDO, said out loud rather than left out: this row's inverse would have
          // to un-resolve a dose the sheet has already dropped from the list, and
          // whether that is a complete local inverse is the separate ruling in #2642.
          announce: { message: text, tone, undo: null },
        };
      },
      failureMessage: "Couldn't log that dose. Try again.",
      offline: (tappedAt) => ({
        kind: "capture",
        flow: "dose",
        date: localDate(tappedAt),
        // The tap's own instant, captured before the online attempt, so a dead-spot
        // confirm lands with the time the dose was taken (#1427).
        payload: { doseId: dose.doseId, clientTakenAt: tappedAt.toISOString() },
        keptMessage: "Dose saved offline — will sync when you reconnect.",
      }),
    });
    if (result === "captured") markResolved(today, [dose.doseId]);
  }

  const days = [
    { date: today, label: "Today" },
    ...pastDays.map((past) => ({ date: past.date, label: past.label })),
  ];

  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        options={days.map((entry, daysAgo) => ({
          value: entry.date,
          label: entry.label,
          testId: `quick-entry-dose-day-${daysAgo}`,
          dataAttributes: { "data-days-ago": daysAgo },
        }))}
        value={day}
        onChange={setDay}
        ariaLabel="Day to log"
        testId="quick-entry-dose-day-toggle"
      />
      {day !== today ? (
        <PastDayDoses
          date={day}
          slots={pastSlots.get(day) ?? []}
          notes={notes}
          onNote={(doseId, text) =>
            setNotes((prev) => ({
              ...prev,
              [occurrenceKey(day, doseId)]: text,
            }))
          }
          onResolved={(doseIds) => markResolved(day, doseIds)}
        />
      ) : remaining.length === 0 && !prn?.meds.length ? (
        <p
          data-testid="quick-entry-dose-empty"
          className="py-2 text-sm text-slate-500 dark:text-slate-400"
        >
          Nothing left to confirm.
        </p>
      ) : remaining.length > 0 ? (
        <ul
          data-testid="quick-entry-dose-list"
          className="flex flex-col gap-1.5"
        >
          {remaining.map((dose) => (
            <li
              key={dose.doseId}
              data-testid={`quick-entry-dose-${dose.doseId}`}
              className="flex items-center gap-3 rounded-lg border border-(--border) bg-surface px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-slate-800 dark:text-slate-100">
                  {dose.title}
                </span>
                {dose.detail && (
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                    {dose.detail}
                  </span>
                )}
                {notes[occurrenceKey(today, dose.doseId)] && (
                  <span
                    data-testid={`quick-entry-dose-note-${dose.doseId}`}
                    className="block text-xs font-medium text-rose-600 dark:text-rose-400"
                  >
                    {notes[occurrenceKey(today, dose.doseId)]}
                  </span>
                )}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                {dose.dueText}
              </span>
              <form
                action={() => confirm(dose)}
                className="shrink-0"
                data-testid={`quick-entry-dose-form-${dose.doseId}`}
              >
                <Button type="submit" pendingLabel="…">
                  Mark taken
                </Button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
      {day === today && prn && prn.meds.length > 0 && (
        <QuickLogPrnContent {...prn} title={null} showPageLink={false} />
      )}
    </div>
  );
}

// One switched-to day: its still-unresolved doses, grouped by the bucket each was
// DECLARED in, with a whole-stack one tap above any bucket holding two or more.
function PastDayDoses({
  date,
  slots,
  notes,
  onNote,
  onResolved,
}: {
  date: string;
  slots: { bucket: TimeBucket; doses: QuickEntryPastDose[] }[];
  // Keyed by `occurrenceKey`, not by dose id — see the host's note on why a schedule
  // row id is not an occurrence.
  notes: Record<string, string>;
  onNote: (doseId: number, text: string) => void;
  onResolved: (doseIds: readonly number[]) => void;
}) {
  // Two affordances, two pipelines (#2041): a stack tap and the single taps beneath it
  // are different writes and neither may be absorbed by the other's cooldown. The
  // difference the ENROLLMENT GATE makes visible is the offline half — `dose-day` is a
  // covered flow, so its `offline` decision is required; `dose-day-stack` is an argued
  // exclusion in OFFLINE_QUEUE_COVERAGE, so passing one here is a compile error and the
  // stack is online-only by declaration rather than by omission.
  const single = useWritePipeline("dose-day");
  const stack = useWritePipeline("dose-day-stack");
  // The two answers this surface gives a dated settlement, which is the only thing that
  // ever differed between it and the ledger's copy of the same choreography.
  const row = { note: onNote, resolved: onResolved };

  // A single dated tap MAY be captured offline: the queued intent already carries its
  // own day and the replay re-checks the window with the same predicate the core does
  // (lib/offline/writes.ts).
  //
  // WHAT OFFLINE ALSO CHANGES: the SLACK. `isDoseDateAccepted` is evaluated at REPLAY
  // time, so a capture for today tolerates two days offline, yesterday one, and the
  // oldest offered day NONE — reconnect the next morning and the replay refuses it. The
  // refusal is reported rather than swallowed, so this is a tolerance the user can be
  // told about, not a silent loss.
  //
  // No `clientTakenAt` — the tap instant belongs to TODAY, and `resolveQueuedTakenAt`
  // refuses a stamp whose local date is not the row's own day, so sending it would only
  // buy a discarded value.
  async function resolveOne(doseId: number, status: "taken" | "skipped") {
    const outcome = await single.run({
      key: `${doseId}->${status}`,
      fields: { date, status, dose_ids: String(doseId) },
      action: resolveDayDoses,
      settle: (result) => settleDayDoses(result, status, row),
      failureMessage: "Couldn't update this dose. Try again.",
      offline: () => ({
        kind: "capture",
        flow: status === "taken" ? "dose" : "skip-dose",
        date,
        payload: { doseId },
        keptMessage:
          status === "taken"
            ? "Dose saved offline — will sync when you reconnect."
            : "Skip saved offline — will sync when you reconnect.",
      }),
    });
    // A kept capture IS a landing, so the row leaves the day's list the way an online
    // resolution does. Today's row above already settles this way; the past-day row was
    // doing it before the pipeline landed and must keep doing it.
    if (outcome === "captured") onResolved([doseId]);
  }

  function resolveStack(doseIds: readonly number[]) {
    void stack.run({
      key: doseIds.join(","),
      fields: { date, status: "taken", dose_ids: doseIds.join(",") },
      action: resolveDayDoses,
      settle: (result) => settleDayDoses(result, "taken", row),
      // A THROW HERE IS NOT "NOTHING HAPPENED". The action resolves each dose in its OWN
      // transaction, so a failure on the third of five leaves the first two committed
      // WITH their supply decrements — and "Couldn't log that stack" would be the one
      // thing this file is otherwise careful never to do: report a write wrongly. We do
      // not know what landed, so we say that and point at the record.
      failureMessage:
        "Something went wrong — reopen this sheet to see what was logged.",
    });
  }

  if (slots.length === 0) {
    return (
      <p
        data-testid="quick-entry-dose-day-empty"
        className="py-2 text-sm text-slate-500 dark:text-slate-400"
      >
        Nothing left to log for this day.
      </p>
    );
  }

  return (
    <div data-testid="quick-entry-dose-day" data-date={date}>
      {slots.map((slot) => {
        const ids = slot.doses.map((d) => d.doseId);
        // The promise, in the shared #3098 grammar: the profile's own name for the
        // group when every dose in the bucket shares one, otherwise every name.
        const phrase = dosesPhrase(slot.doses);
        const heading = `${TIME_BUCKET_LABELS[slot.bucket]} stack (${ids.length})`;
        return (
          <section key={slot.bucket} className="mb-3 last:mb-0">
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
              {TIME_BUCKET_LABELS[slot.bucket]}
            </h3>
            {slot.doses.length > 1 && (
              <button
                type="button"
                data-testid={`quick-entry-dose-stack-${slot.bucket}`}
                data-doses={ids.join(",")}
                aria-label={`${heading}: ${phrase}`}
                disabled={stack.blocked(ids.join(","))}
                onClick={() => resolveStack(ids)}
                className="mb-1.5 flex w-full items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-left transition hover:bg-brand-50 disabled:opacity-50 dark:border-brand-900 dark:bg-brand-950/40 dark:hover:bg-brand-950/60"
              >
                <IconPlus
                  className="h-5 w-5 shrink-0 text-brand-700 dark:text-brand-300"
                  stroke={2}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {heading}
                  </span>
                  <span
                    data-testid={`quick-entry-dose-stack-names-${slot.bucket}`}
                    className="block truncate text-xs text-slate-600 dark:text-slate-300"
                  >
                    {phrase}
                  </span>
                </span>
              </button>
            )}
            <ul className="flex flex-col gap-1.5">
              {slot.doses.map((dose) => (
                <li
                  key={dose.doseId}
                  data-testid={`quick-entry-dose-${dose.doseId}`}
                  className="flex items-center gap-3 rounded-lg border border-(--border) bg-surface px-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-slate-800 dark:text-slate-100">
                      {dose.name}
                    </span>
                    {dose.detail && (
                      <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                        {dose.detail}
                      </span>
                    )}
                    {notes[occurrenceKey(date, dose.doseId)] && (
                      <span
                        data-testid={`quick-entry-dose-note-${dose.doseId}`}
                        className="block text-xs font-medium text-rose-600 dark:text-rose-400"
                      >
                        {notes[occurrenceKey(date, dose.doseId)]}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      data-testid="dose-take"
                      aria-label={`Mark ${dose.name} taken`}
                      disabled={single.blocked(`${dose.doseId}->taken`)}
                      onClick={() => void resolveOne(dose.doseId, "taken")}
                      className={`${DOSE_ACTION_ICON} ${DOSE_ACTION_BRAND}`}
                    >
                      <IconCheck className="h-3.5 w-3.5" stroke={2.5} />
                    </button>
                    <button
                      type="button"
                      data-testid="dose-skip"
                      aria-label={`Skip ${dose.name}`}
                      disabled={single.blocked(`${dose.doseId}->skipped`)}
                      onClick={() => void resolveOne(dose.doseId, "skipped")}
                      className={`${DOSE_ACTION_ICON} ${DOSE_ACTION_NEUTRAL}`}
                    >
                      <IconPlayerTrackNext
                        className="h-3.5 w-3.5"
                        stroke={2.5}
                      />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
