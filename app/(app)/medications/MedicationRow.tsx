"use client";

import { useState } from "react";
import Link from "next/link";
import type {
  MedicationCourse,
  MedicationSideEffect,
  Supplement,
  SupplementDose,
} from "@/lib/types";
import type { AdherenceDot } from "@/lib/supplement-adherence";
import { daysOfSupplyForItem, isLowSupply, type DoseRate } from "@/lib/refill";
import {
  sortCourses,
  isMedicationCurrent,
  stopReasonLabel,
  unresolvedCount,
  medicationMetaLine,
} from "@/lib/medication-history";
import { medicationHref } from "@/lib/hrefs";
import { formatMedicationDoseLine } from "@/lib/medication-dose-format";
import {
  RefillBadge,
  AdherenceSummaryLine,
} from "@/components/AdherenceRefill";
import RefillButton from "@/components/medications/RefillButton";
import RxOtcBadge from "@/components/RxOtcBadge";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import { deleteSupplement } from "@/app/(app)/nutrition/supplement-actions";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";

// One medication as a SCANNABLE ROW on the /medications list (#817) — not the old
// lifecycle card. Name/dose · adherence + refill (#747 parity) · course status ·
// PRN/critical badges · next-window chip. The whole row links to the
// /medications/[id] detail page (the clinical-record home); a compact overflow menu
// deep-links to the detail page's edit/stop workflows and keeps delete available.
export default function MedicationRow({
  med,
  doses,
  courses,
  sideEffects,
  strip,
  refillRate,
  prnRedoseLine = null,
  monitoringNote = null,
  todayStr,
}: {
  med: Supplement;
  doses: SupplementDose[];
  courses: MedicationCourse[];
  sideEffects: MedicationSideEffect[];
  strip: AdherenceDot[];
  refillRate: DoseRate | null;
  prnRedoseLine?: string | null;
  // The "Requires monitoring: …" note (issue #995) — the curated labs a clinician
  // typically watches while on this drug. Informational; absent for unmonitored meds.
  monitoringNote?: string | null;
  // The app's configured today, so the refill badge can project the run-out DATE
  // and the one-tap "Refilled" action shows on the low-supply state (#852 item 3).
  todayStr: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const formatPrefs = useFormatPrefs();

  const current = isMedicationCurrent(med);
  const ordered = sortCourses(courses);
  const unresolved = unresolvedCount(sideEffects);
  const subline = med.brand?.trim() || null;
  const medMeta = medicationMetaLine(med);
  const lowSupply = isLowSupply(
    daysOfSupplyForItem(
      med.quantity_on_hand,
      med.qty_per_dose,
      refillRate,
      doses.length
    )
  );
  const doseLines = doses.map((dose) =>
    formatMedicationDoseLine({
      amount: dose.amount,
      product: med.product,
      timeOfDay: dose.time_of_day,
      asNeeded: med.as_needed === 1,
      timeFormat: formatPrefs.timeFormat,
    })
  );

  return (
    <div
      data-testid="medication-row"
      className={`py-4 first:pt-0 last:pb-0 ${menuOpen ? "relative z-20" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <Link
          href={medicationHref(med.id)}
          className="group/med-link -mx-2 -my-1 min-w-0 flex-1 rounded-lg px-2 py-1 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:hover:bg-ink-850 dark:focus-visible:ring-offset-ink-950"
          data-testid="medication-row-link"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className={`text-base font-semibold group-hover/med-link:underline ${
                current
                  ? "text-brand-700 dark:text-brand-400"
                  : "text-slate-600 group-hover/med-link:text-slate-800 dark:text-slate-300 dark:group-hover/med-link:text-slate-100"
              }`}
              data-testid="medication-name"
            >
              {med.name}
            </span>
            {subline && (
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {subline}
              </span>
            )}
            <RxOtcBadge rx={med.rx} />
            {med.as_needed === 1 && (
              <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                As Needed
              </span>
            )}
            {med.critical === 1 && (
              <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                Critical
              </span>
            )}
            {!current && (
              <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                {stopReasonLabel(ordered[ordered.length - 1]?.stop_reason)}
              </span>
            )}
            {unresolved > 0 && (
              <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                {unresolved} side effect{unresolved === 1 ? "" : "s"}
              </span>
            )}
            <RefillBadge
              quantityOnHand={med.quantity_on_hand}
              qtyPerDose={med.qty_per_dose}
              refillRate={refillRate}
              doseCount={doses.length}
              todayStr={todayStr}
            />
          </div>
          <div
            data-testid="medication-dose-summary"
            className={`mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm ${
              current
                ? "text-slate-700 dark:text-slate-200"
                : "text-slate-500 dark:text-slate-400"
            }`}
          >
            {doseLines.length > 0 && doseLines.some(Boolean) ? (
              doseLines.map((line, index) => (
                <span key={doses[index]?.id ?? index}>
                  {line || "Dose not set"}
                </span>
              ))
            ) : med.product ? (
              <span>{med.product}</span>
            ) : (
              <span className="font-normal text-slate-500 dark:text-slate-400">
                Dose not set
              </span>
            )}
          </div>
          {medMeta && (
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {medMeta}
            </div>
          )}
          {prnRedoseLine && (
            <div
              data-testid="prn-redose-line"
              className="mt-0.5 text-xs font-medium text-slate-600 dark:text-slate-300"
            >
              {prnRedoseLine}
            </div>
          )}
          {monitoringNote && (
            <div
              data-testid="medication-monitoring-note"
              className="mt-0.5 text-xs text-slate-500 dark:text-slate-400"
            >
              {monitoringNote}
            </div>
          )}
          <AdherenceSummaryLine strip={strip} />
        </Link>
        <div className="flex shrink-0 items-center gap-1 text-xs">
          {lowSupply && (
            <RefillButton
              itemId={med.id}
              hasLastFill={med.last_fill_size != null}
              lastFillSize={med.last_fill_size}
            />
          )}
          <OverflowMenu
            label="Medication actions"
            open={menuOpen}
            onOpenChange={setMenuOpen}
          >
            {({ close }) => (
              <>
                <Link
                  href={`${medicationHref(med.id)}?action=edit`}
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={close}
                >
                  Edit
                </Link>
                {current && (
                  <Link
                    href={`${medicationHref(med.id)}?action=stop`}
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={close}
                  >
                    Stop medication
                  </Link>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM_DANGER}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Delete medication",
                      message: `Delete “${med.name}” and its whole history? You can undo this.`,
                      confirmLabel: "Delete",
                      danger: true,
                    });
                    if (!ok) return;
                    close();
                    const fd = new FormData();
                    fd.set("id", String(med.id));
                    await undoable(deleteSupplement, fd, {
                      deletedMessage: "Medication deleted.",
                    });
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </OverflowMenu>
        </div>
      </div>
    </div>
  );
}
