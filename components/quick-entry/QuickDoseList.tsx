"use client";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";

import { useEffect, useMemo, useState } from "react";
import { IconCheck, IconPlayerTrackNext, IconPlus } from "@tabler/icons-react";
import Button from "@/components/Button";
import SegmentedControl from "@/components/SegmentedControl";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import {
  DOSE_ACTION_BRAND,
  DOSE_ACTION_ICON,
  DOSE_ACTION_NEUTRAL,
} from "@/components/medications/dose-action-styles";
import { doseConfirmMessage, doseResolved } from "@/lib/dose-outcome-text";
import { dosesPhrase } from "@/lib/usual-routine";
import { TIME_BUCKET_LABELS, type TimeBucket } from "@/lib/intake-schedule";
import {
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
  shouldQueueOffline,
} from "@/lib/offline/queue";
import { markTaken } from "@/app/(app)/upcoming/actions";
import { resolveDayDoses } from "@/app/(app)/nutrition/intake-actions";
import type {
  QuickEntryDose,
  QuickEntryPastDay,
  QuickEntryPastDose,
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
export default function QuickDoseList({
  today,
  doses,
  pastDays,
  onDone,
}: {
  today: string;
  doses: QuickEntryDose[];
  pastDays: QuickEntryPastDay[];
  // Called once the sheet has nothing left to confirm on ANY offered day — the
  // overlay closes itself rather than leaving an empty sheet on screen. Today
  // emptying on its own is NOT that moment any more: closing then would take the
  // switcher, and the missed day behind it, away with it.
  onDone: () => void;
}) {
  const toast = useToast();
  // Doses resolved during THIS overlay session, dropped from their day's list. Local
  // rather than re-fetched: the sheet is a transactional surface, and re-running the
  // gather mid-list would reorder rows under the user's finger. ONE set across every
  // day, because a dose belongs to exactly one of them.
  const [resolved, setResolved] = useState<Set<number>>(() => new Set());
  // The last outcome per dose that did NOT resolve it — shown inline so the reason
  // the row is still there is legible without hunting for the toast.
  const [notes, setNotes] = useState<Record<number, string>>({});
  // The surface this list is rendered in (#3087).
  const stampLoggedVia = useLoggedViaStamp();
  const [day, setDay] = useState(today);

  const remaining = doses.filter((d) => !resolved.has(d.doseId));
  const pastSlots = useMemo(
    () =>
      new Map(
        pastDays.map((past) => [
          past.date,
          past.slots
            .map((slot) => ({
              ...slot,
              doses: slot.doses.filter((d) => !resolved.has(d.doseId)),
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
  function markResolved(doseIds: readonly number[]): void {
    setResolved((prev) => {
      const next = new Set(prev);
      for (const id of doseIds) next.add(id);
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
      doses.some((d) => !resolved.has(d.doseId)) ||
      pastDays.some((past) =>
        past.slots.some((slot) =>
          slot.doses.some((d) => !resolved.has(d.doseId))
        )
      );
    if (!left) onDone();
  }, [resolved, doses, pastDays, onDone]);

  async function confirm(dose: QuickEntryDose) {
    // The quick-log sheet, not the Upcoming page — the two mountings post the SAME
    // action, so the sheet declares itself (#3087). The value comes from the host
    // region rather than being asserted here.
    const fd = stampLoggedVia(new FormData());
    fd.set("dose_id", String(dose.doseId));
    let result;
    try {
      result = await markTaken(fd);
    } catch {
      toast("Couldn't log that dose. Try again.", { tone: "error" });
      return;
    }
    if (!result.ok) {
      toast(result.error, { tone: "error" });
      return;
    }
    const { text, tone } = doseConfirmMessage(result.outcome);
    toast(text, { tone });
    if (doseResolved(result.outcome)) {
      markResolved([dose.doseId]);
    } else {
      setNotes((prev) => ({ ...prev, [dose.doseId]: text }));
    }
    // Keep the page behind the overlay honest — the user stays put, so what they
    // are looking at has to reflect the write.
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
            setNotes((prev) => ({ ...prev, [doseId]: text }))
          }
          onResolved={markResolved}
        />
      ) : remaining.length === 0 ? (
        <p
          data-testid="quick-entry-dose-empty"
          className="py-2 text-sm text-slate-500 dark:text-slate-400"
        >
          Nothing left to confirm.
        </p>
      ) : (
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
                {notes[dose.doseId] && (
                  <span
                    data-testid={`quick-entry-dose-note-${dose.doseId}`}
                    className="block text-xs font-medium text-rose-600 dark:text-rose-400"
                  >
                    {notes[dose.doseId]}
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
  notes: Record<number, string>;
  onNote: (doseId: number, text: string) => void;
  onResolved: (doseIds: readonly number[]) => void;
}) {
  const toast = useToast();
  const stampLoggedVia = useLoggedViaStamp();
  const { enqueue } = useOfflineQueue();
  // Two affordances, two ledgers (#2041): a stack tap and the single taps beneath it
  // are different writes and neither may be absorbed by the other's cooldown.
  const single = useOptimisticLedger("dose-day");
  const stack = useOptimisticLedger("dose-day-stack");

  // Post one dated resolution. The named ids are an UPPER BOUND: the action re-derives
  // the day's still-unresolved set and writes only the intersection, so this can never
  // ask for more than the label promised and never get more than the day still owes.
  async function post(
    doseIds: readonly number[],
    status: "taken" | "skipped"
  ): Promise<"wrote" | "nothing"> {
    const fd = stampLoggedVia(new FormData());
    fd.set("date", date);
    fd.set("status", status);
    fd.set("dose_ids", doseIds.join(","));
    const result = await resolveDayDoses(fd);
    if (!result.ok) {
      toast(result.error, { tone: "error" });
      return "nothing";
    }
    // Answered from the typed outcomes, never from the ask. A dose the day no longer
    // owes is simply absent from `result.doses`; one that refused is named where it
    // stands, exactly as today's list names its own refusals.
    for (const dose of result.doses) {
      if (!doseResolved(dose.outcome))
        onNote(dose.doseId, doseConfirmMessage(dose.outcome).text);
    }
    const landed = result.doses.filter((d) => doseResolved(d.outcome));
    if (landed.length === 0) {
      toast(
        result.doses.length === 0
          ? "Nothing left to log for that day."
          : doseConfirmMessage(result.doses[0]!.outcome).text,
        { tone: "error" }
      );
      return "nothing";
    }
    toast(
      landed.length === 1
        ? doseConfirmMessage(landed[0]!.outcome).text
        : `${landed.length} doses ${status === "taken" ? "logged" : "skipped"}.`
    );
    onResolved(landed.map((d) => d.doseId));
    return "wrote";
  }

  // A single dated tap may be CAPTURED offline: the queued intent already carries its
  // own day and the replay re-checks the window with the same predicate the core does
  // (lib/offline/writes.ts).
  //
  // WHAT OFFLINE ALSO CHANGES, and an earlier version of this comment wrongly said it
  // did not: the SLACK. `isDoseDateAccepted` is evaluated at REPLAY time, so a capture
  // for today tolerates two days offline, yesterday one, and the oldest offered day
  // NONE — reconnect the next morning and the replay refuses it. The refusal is
  // reported rather than swallowed (the replay tells an out-of-window entry apart from
  // a deleted dose precisely so it can explain itself), so this is a tolerance the user
  // can be told about, not a silent loss — but it is a real difference from the
  // same-day tap, and it is written here rather than left for someone to rediscover.
  //
  // No `clientTakenAt` — the tap instant belongs to TODAY, and `resolveQueuedTakenAt`
  // refuses a stamp whose local date is not the row's own day, so sending it would only
  // buy a discarded value.
  async function queue(
    doseId: number,
    status: "taken" | "skipped"
  ): Promise<"wrote" | "nothing"> {
    const kept =
      (await enqueue(status === "taken" ? "dose" : "skip-dose", date, {
        doseId,
      })) === "kept";
    // READ THE ANSWER: the queue can refuse (logged out, no IndexedDB), and claiming
    // a save that did not happen is worse than the missing save (#3038).
    if (!kept) {
      toast(OFFLINE_CAPTURE_REFUSED_MESSAGE, { tone: "error" });
      return "nothing";
    }
    toast(
      status === "taken"
        ? "Dose saved offline — will sync when you reconnect."
        : "Skip saved offline — will sync when you reconnect."
    );
    onResolved([doseId]);
    return "wrote";
  }

  function resolveOne(doseId: number, status: "taken" | "skipped") {
    void single.tap<"wrote" | "nothing">({
      key: `${doseId}->${status}`,
      write: async () => {
        const online =
          typeof navigator === "undefined" || navigator.onLine !== false;
        if (!online) return queue(doseId, status);
        try {
          return await post([doseId], status);
        } catch (err) {
          if (shouldQueueOffline(navigator.onLine !== false, err))
            return queue(doseId, status);
          toast("Couldn't update this dose. Try again.", { tone: "error" });
          return "nothing";
        }
      },
      settle: (outcome) =>
        outcome === "wrote" ? { kind: "keep" } : { kind: "rollback" },
      onError: () => {
        toast("Couldn't update this dose. Try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  function resolveStack(doseIds: readonly number[]) {
    void stack.tap<"wrote" | "nothing">({
      key: doseIds.join(","),
      write: () => post(doseIds, "taken"),
      settle: (outcome) =>
        outcome === "wrote" ? { kind: "keep" } : { kind: "rollback" },
      onError: () => {
        // A THROW HERE IS NOT "NOTHING HAPPENED". The action resolves each dose in its
        // OWN transaction, so a failure on the third of five leaves the first two
        // committed WITH their supply decrements — and "Couldn't log that stack" would
        // then be the one thing this file is otherwise careful never to do: report a
        // write wrongly. We do not know what landed, so we say that and point at the
        // record, rather than claiming either outcome. (Online-only by declaration in
        // OFFLINE_QUEUE_COVERAGE: the shortcut needs a connection; the single taps
        // beneath it queue.)
        toast(
          "Something went wrong — reopen this sheet to see what was logged.",
          {
            tone: "error",
          }
        );
        return { kind: "rollback" };
      },
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
                    {notes[dose.doseId] && (
                      <span
                        data-testid={`quick-entry-dose-note-${dose.doseId}`}
                        className="block text-xs font-medium text-rose-600 dark:text-rose-400"
                      >
                        {notes[dose.doseId]}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      data-testid="dose-take"
                      aria-label={`Mark ${dose.name} taken`}
                      disabled={single.blocked(`${dose.doseId}->taken`)}
                      onClick={() => resolveOne(dose.doseId, "taken")}
                      className={`${DOSE_ACTION_ICON} ${DOSE_ACTION_BRAND}`}
                    >
                      <IconCheck className="h-3.5 w-3.5" stroke={2.5} />
                    </button>
                    <button
                      type="button"
                      data-testid="dose-skip"
                      aria-label={`Skip ${dose.name}`}
                      disabled={single.blocked(`${dose.doseId}->skipped`)}
                      onClick={() => resolveOne(dose.doseId, "skipped")}
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
