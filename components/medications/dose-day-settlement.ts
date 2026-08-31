"use client";

import {
  resolveDayDoses,
  type ResolveDayDosesResult,
} from "@/app/(app)/nutrition/intake-actions";
import {
  useWritePipeline,
  type WriteSettlement,
} from "@/components/useWritePipeline";
import { doseConfirmMessage, doseResolved } from "@/lib/dose-outcome-text";

type DoseStatus = "taken" | "skipped";
type DoseRowSettlement = {
  note: (doseId: number, text: string) => void;
  resolved: (doseIds: readonly number[]) => void;
};

// ONE DATED-DOSE WRITE OWNER (#4316). The quick sheet and Day ledger compose
// different row chrome around the same two writes; neither restates their pipeline,
// offline admission, action, settlement, or captured-row behavior.
export function useDoseDayResolution({
  date,
  bulkFailureMessage,
  note,
  resolved,
}: { date: string; bulkFailureMessage: string } & DoseRowSettlement) {
  const single = useWritePipeline("dose-day");
  const bulk = useWritePipeline("dose-day-stack");
  const row = { note, resolved };

  async function resolveOne(doseId: number, status: DoseStatus) {
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
    if (outcome === "captured") resolved([doseId]);
  }

  function resolveAll(doseIds: readonly number[]) {
    void bulk.run({
      key: doseIds.join(","),
      fields: { date, status: "taken", dose_ids: doseIds.join(",") },
      action: resolveDayDoses,
      settle: (result) => settleDayDoses(result, "taken", row),
      failureMessage: bulkFailureMessage,
    });
  }

  return {
    resolveOne,
    resolveAll,
    singleBlocked: (doseId: number, status: DoseStatus) =>
      single.blocked(`${doseId}->${status}`),
    bulkBlocked: (doseIds: readonly number[]) =>
      bulk.blocked(doseIds.join(",")),
  };
}

// HOW A DATED DOSE RESOLUTION SETTLES, in ONE place (#4453). Two surfaces post
// `resolveDayDoses` — the quick-log sheet's past-day list and the day ledger — and each
// carried its own copy of this, 36 of 41 lines byte-identical. One action answering two
// ways is how the sentence a user reads starts depending on which screen they tapped on.
//
// ANSWERED FROM THE TYPED OUTCOMES, NEVER FROM THE ASK. The ids a caller names are an
// UPPER BOUND: the action re-derives the day's still-unresolved set and writes only the
// intersection, so a dose the day no longer owes is simply absent from `result.doses`,
// and one that refused is named where it stands rather than folded into a total.
//
// NO UNDO, written rather than omitted — and on a whole-stack tap it is load-bearing:
// the action resolves each dose in its own transaction, so an inverse would have to know
// which ones landed, and that is not a complete local inverse (lib/undo-offer.ts).
function settleDayDoses(
  result: ResolveDayDosesResult,
  status: "taken" | "skipped",
  // The surface's own two answers — where an unresolved dose's reason is shown, and what
  // leaves the list. This is the only thing that ever differed between the two copies.
  row: DoseRowSettlement
): WriteSettlement {
  if (!result.ok)
    return {
      wrote: false,
      announce: { message: result.error, tone: "error", undo: null },
    };
  for (const dose of result.doses) {
    if (!doseResolved(dose.outcome))
      row.note(dose.doseId, doseConfirmMessage(dose.outcome).text);
  }
  const landed = result.doses.filter((d) => doseResolved(d.outcome));
  if (landed.length === 0)
    return {
      wrote: false,
      announce: {
        message:
          result.doses.length === 0
            ? "Nothing left to log for that day."
            : doseConfirmMessage(result.doses[0]!.outcome).text,
        tone: "error",
        undo: null,
      },
    };
  row.resolved(landed.map((d) => d.doseId));
  return {
    wrote: true,
    announce: {
      message:
        landed.length === 1
          ? doseConfirmMessage(landed[0]!.outcome).text
          : `${landed.length} doses ${status === "taken" ? "logged" : "skipped"}.`,
      undo: null,
    },
  };
}
