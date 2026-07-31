"use client";

import { useState, useTransition } from "react";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { doseConfirmMessage, doseResolved } from "@/lib/dose-outcome-text";
import { markTaken } from "@/app/(app)/upcoming/actions";
import type { QuickEntryDose } from "@/app/(app)/quick-entry-actions";

// The quick-entry overlay's DOSE form (issue #1468): today's due doses, each with
// a confirm.
//
// It is a thin LIST over an existing write path, not a new one. The rows come
// from the same `collectHouseholdRollup` due-dose computation the household card
// and the medications strip read (gathered in quick-entry-actions.ts), and the
// confirm posts the EXISTING `markTaken` action — the same idempotent
// markDoseTaken the Upcoming page's inline form, the dashboard hero and the
// Telegram tap all go through. Nothing here logs a dose itself.
//
// **It never unconditionally confirms.** `markTaken` returns markDoseTaken's
// typed DoseTakenOutcome, and every branch is answered from it: a dose retired by
// a schedule edit, an item since paused, or a dose already resolved as SKIPPED
// logs NOTHING, and saying "Dose logged" there would be a false confirmation of a
// possibly-critical medication (the #280 defect). The row only leaves the list
// when the outcome says a taken log actually stands; otherwise it stays put with
// the honest message beside it, because it is still due.
export default function QuickDoseList({
  doses,
  onDone,
}: {
  doses: QuickEntryDose[];
  // Called once the list has nothing left to confirm — the overlay closes itself
  // rather than leaving an empty sheet on screen.
  onDone: () => void;
}) {
  const toast = useToast();
  const [, startTransition] = useTransition();
  // Doses resolved during THIS overlay session, dropped from the list. Local
  // rather than re-fetched: the sheet is a transactional surface, and re-running
  // the gather mid-list would reorder rows under the user's finger.
  const [resolved, setResolved] = useState<Set<number>>(() => new Set());
  // The last outcome per dose that did NOT resolve it — shown inline so the
  // reason the row is still there is legible without hunting for the toast.
  const [notes, setNotes] = useState<Record<number, string>>({});

  const remaining = doses.filter((d) => !resolved.has(d.doseId));

  async function confirm(dose: QuickEntryDose) {
    const fd = new FormData();
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
      const next = new Set(resolved);
      next.add(dose.doseId);
      setResolved(next);
      if (next.size === doses.length) onDone();
    } else {
      setNotes((prev) => ({ ...prev, [dose.doseId]: text }));
    }
    // Keep the page behind the overlay honest — the user stays put, so what they
    // are looking at has to reflect the write.
  }

  if (remaining.length === 0) {
    return (
      <p
        data-testid="quick-entry-dose-empty"
        className="py-2 text-sm text-slate-500 dark:text-slate-400"
      >
        Nothing left to confirm.
      </p>
    );
  }

  return (
    <ul data-testid="quick-entry-dose-list" className="flex flex-col gap-1.5">
      {remaining.map((dose) => (
        <li
          key={dose.doseId}
          data-testid={`quick-entry-dose-${dose.doseId}`}
          className="flex items-center gap-3 rounded-lg border border-black/10 bg-white px-3 py-2 dark:border-white/10 dark:bg-ink-900"
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
            <SubmitButton
              pendingLabel="…"
              className="tap-target rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
            >
              Mark taken
            </SubmitButton>
          </form>
        </li>
      ))}
    </ul>
  );
}
