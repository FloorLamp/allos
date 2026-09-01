"use client";

import { useEffect, useMemo, useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import DoseStatusControl from "@/components/DoseStatusControl";
import QuickLogPrnContent from "@/components/medications/QuickLogPrnContent";
import SegmentedControl from "@/components/SegmentedControl";
import { useDoseDayResolution } from "@/components/medications/dose-day-settlement";
import { dosesPhrase } from "@/lib/usual-routine";
import { TIME_BUCKET_LABELS, type TimeBucket } from "@/lib/intake-schedule";
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
// the same `collectDueDosesNow` computation the context chip reads. Nothing here logs
// a dose itself and nothing here draws a dose control: every row mounts
// `DoseStatusControl`, the domain's one row control (#4424 ruling 3).
//
// THE STRADDLE IS GONE. This file used to post `markTaken` for today and
// `resolveDayDoses` for a day behind it, with a "Mark taken" button for the one and an
// icon pair for the other — two write paths and two spellings of the row inside one
// list, which is what the manifest cell named. Both are one mount now, and today's row
// gains the skip and the way back that only the past day had.
//
// **It never unconditionally confirms.** A row leaves the list only when the write
// says it wrote; a refusal — a dose retired by a schedule edit, an item since paused —
// stays put with the honest message beside it, because it is still due. Saying "Dose
// logged" there would be a false confirmation of a possibly-critical medication (the
// #280 defect).
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
              <DoseStatusControl
                doseId={dose.doseId}
                taken={false}
                skipped={false}
                variant="pill"
                label="Mark taken"
                itemName={dose.title}
                onSettled={(result) => {
                  if (result.ok) markResolved(today, [dose.doseId]);
                  else
                    setNotes((prev) => ({
                      ...prev,
                      [occurrenceKey(today, dose.doseId)]: result.error,
                    }));
                }}
              />
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
  const { resolveAll, bulkBlocked } = useDoseDayResolution({
    date,
    bulkFailureMessage:
      "Something went wrong — reopen this sheet to see what was logged.",
    note: onNote,
    resolved: onResolved,
  });

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
                disabled={bulkBlocked(ids)}
                onClick={() => resolveAll(ids)}
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
                  <DoseStatusControl
                    doseId={dose.doseId}
                    date={date}
                    taken={false}
                    skipped={false}
                    variant="pill"
                    compact
                    itemName={dose.name}
                    onSettled={(result) => {
                      if (result.ok) onResolved([dose.doseId]);
                      else onNote(dose.doseId, result.error);
                    }}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
