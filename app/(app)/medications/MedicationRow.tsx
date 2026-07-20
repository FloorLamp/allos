"use client";

import { useState } from "react";
import Link from "next/link";
import { IconChevronRight } from "@tabler/icons-react";
import type {
  MedicationCourse,
  MedicationSideEffect,
  Supplement,
  SupplementDose,
} from "@/lib/types";
import type { AdherenceDot } from "@/lib/supplement-adherence";
import { daysOfSupplyForItem, isLowSupply, type DoseRate } from "@/lib/refill";
import {
  isCoverageLimited,
  COVERAGE_LIMITED_CHIP,
  COVERAGE_LIMITED_HINT,
} from "@/lib/safety-coverage";
import {
  sortCourses,
  isMedicationCurrent,
  stopReasonLabel,
  unresolvedCount,
  medicationMetaLine,
} from "@/lib/medication-history";
import { medicationHref } from "@/lib/hrefs";
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

// One medication as a SCANNABLE ROW on the /medications list (#817) — not the old
// lifecycle card. Name/dose · adherence + refill (#747 parity) · course status ·
// PRN/critical badges · next-window chip. The whole row links to the
// /medications/[id] detail page (the clinical-record home); a compact overflow menu
// keeps the delete affordance without opening the row.
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

  const current = isMedicationCurrent(med);
  const ordered = sortCourses(courses);
  const unresolved = unresolvedCount(sideEffects);
  const subline = [med.brand, med.product].filter(Boolean).join(" · ");
  const medMeta = medicationMetaLine(med);
  const lowSupply = isLowSupply(
    daysOfSupplyForItem(
      med.quantity_on_hand,
      med.qty_per_dose,
      refillRate,
      doses.length
    )
  );

  return (
    <div
      data-testid="medication-row"
      className={`card !py-3 ${current ? "" : "opacity-70"} ${
        menuOpen ? "relative z-20" : ""
      } border-l-4 ${
        current
          ? "border-l-rose-400 dark:border-l-rose-500"
          : "border-l-slate-300 dark:border-l-ink-700"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <Link
          href={medicationHref(med.id)}
          className="group min-w-0 flex-1"
          data-testid="medication-row-link"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-medium text-slate-800 group-hover:underline dark:text-slate-100">
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
                PRN
              </span>
            )}
            {med.critical === 1 && (
              <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                Critical
              </span>
            )}
            {current ? (
              <span className="badge bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                Current
              </span>
            ) : (
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
            {/* Screening-coverage chip (#1032): a name-only item (no confirmed
                RxNorm code) is less likely to match a code-keyed safety rule — say
                so QUIETLY, pointing at the existing #851 confirm flow (the edit
                form). Informational styling, never a warning. */}
            {current && isCoverageLimited(med) && (
              <span
                className="badge bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400"
                data-testid="coverage-limited-chip"
                title={COVERAGE_LIMITED_HINT}
              >
                {COVERAGE_LIMITED_CHIP}
              </span>
            )}
          </div>
          {medMeta && (
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
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
              className="mt-0.5 text-xs text-sky-700 dark:text-sky-300"
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
                  href={medicationHref(med.id)}
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={close}
                >
                  View details
                </Link>
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
          <Link
            href={medicationHref(med.id)}
            aria-label={`Open ${med.name}`}
            className="tap-target flex h-8 w-8 items-center justify-center rounded text-slate-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400"
          >
            <IconChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
