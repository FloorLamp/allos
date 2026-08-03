"use client";

import { useState } from "react";
import type { Supplement, SupplementDose, SupplementPair } from "@/lib/types";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import {
  CONDITION_LABELS,
  FOOD_TIMING_HINTS,
  OBLIGATION_LABELS,
  obligationClass,
} from "@/lib/supplement-schedule";
import { medicationMetaLine } from "@/lib/medication-history";
import type { AdherenceDot } from "@/lib/supplement-adherence";
import type { DoseRate } from "@/lib/refill";
import {
  RefillBadge,
  SharedSupplyChip,
  AdherenceSummaryLine,
} from "@/components/AdherenceRefill";
import type { PoolChipData } from "@/lib/queries/intake";
import SupplementForm from "@/components/SupplementForm";
import ModalShell from "@/components/ModalShell";
import FoodGuidance from "@/components/FoodGuidance";
import NotesText from "@/components/NotesText";
import DoseStatusControl from "@/components/DoseStatusControl";
import DoseHistoryPanel, {
  type DoseHistoryEntry,
} from "@/components/intake/DoseHistoryPanel";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import {
  updateSupplement,
  toggleActive,
  deleteSupplement,
} from "./supplement-actions";
import { isPrn } from "@/lib/supplement-schedule";

// One scheduled dose of a supplement, as it appears in a time bucket. A
// supplement with multiple doses renders one of these per dose. Editing opens
// the full supplement form (all its doses).
export default function EditableSupplementRow({
  supplement,
  dose,
  doses,
  allSupplements,
  stackItems,
  pgxVariants,
  pairs,
  isTaken,
  isSkipped,
  due,
  strip,
  trainingRestricted,
  refillRate,
  poolChip = null,
  historicalStatus = null,
  suppressedFoodKeys = [],
  doseHistory = [],
  historyMaxDate,
  defaultHistoryTime,
  historyWindowDays,
}: {
  supplement: Supplement;
  dose: SupplementDose;
  doses: SupplementDose[];
  allSupplements: { id: number; name: string }[];
  stackItems: InteractionItem[];
  pgxVariants: PgxVariantInput[];
  pairs: SupplementPair[];
  isTaken: boolean;
  isSkipped: boolean;
  due: boolean;
  strip: AdherenceDot[];
  trainingRestricted: boolean;
  refillRate: DoseRate | null;
  // The shared-bottle chip when this item draws from a pool (#1374) — it REPLACES
  // the per-item refill badge, since a linked item keeps no private count.
  poolChip?: PoolChipData | null;
  // Past schedule days are read-only: show the recorded outcome without exposing
  // today's write control against a historical row.
  historicalStatus?: "taken" | "skipped" | "missed" | null;
  // Active food-timing dismissals for this profile (#435), threaded to FoodGuidance.
  suppressedFoodKeys?: string[];
  // This item's recorded administrations over the page's history window (#1933), for
  // the Dose history panel — the same panel, over the same ungated shared cores, that
  // the medication detail page renders. Backfill / amend / delete-with-undo are
  // adherence machinery, and adherence machinery is not split by kind.
  doseHistory?: DoseHistoryEntry[];
  historyMaxDate: string;
  defaultHistoryTime: string;
  historyWindowDays: number;
}) {
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const s = supplement;

  const subline = [s.brand, s.product].filter(Boolean).join(" · ");
  const foodHint = FOOD_TIMING_HINTS[dose.food_timing];
  const multi = doses.length > 1;

  // Recent adherence (last 14 days) and the refill "≈N days left" badge are the
  // shared AdherenceSummaryLine / RefillBadge formatters (#313/#38/#301), rendered
  // identically here and on the medication card (#747 parity).

  // Medication identity: the stricter affordances (Rx/PRN/escalate
  // badges above, prescriber/pharmacy/Rx line below).
  const isMed = s.kind === "medication";
  const medMeta = isMed ? medicationMetaLine(s) : "";

  return (
    <>
      <div
        data-testid="supplement-row"
        className={`card grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 !rounded-lg !border-black/10 !bg-white !px-3 !py-3 !shadow-none !backdrop-blur-none dark:!border-white/10 dark:!bg-ink-900 ${
          !s.active ? "opacity-50" : ""
        } ${menuOpen ? "relative z-20" : ""}`}
      >
        <div className="col-start-1 row-start-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              data-testid="medicine-name"
              className="min-w-0 break-words font-medium text-slate-800 dark:text-slate-100"
            >
              {s.name}
            </span>
            {s.obligation !== "should" && (
              <span
                data-testid={`intake-obligation-${s.obligation}`}
                className={`badge ${obligationClass(s.obligation)}`}
              >
                {OBLIGATION_LABELS[s.obligation]}
              </span>
            )}
            {multi && (
              <span className="badge bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                split
              </span>
            )}
            {historicalStatus && (
              <span
                data-testid={`supplement-history-${historicalStatus}`}
                className={`badge ${
                  historicalStatus === "taken"
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    : historicalStatus === "skipped"
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                      : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                }`}
              >
                {historicalStatus === "taken"
                  ? "Taken"
                  : historicalStatus === "skipped"
                    ? "Skipped"
                    : "Missed"}
              </span>
            )}
            {s.condition !== "daily" && (
              <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                {CONDITION_LABELS[s.condition]}
                {s.condition === "situational" && s.situation
                  ? ` — ${s.situation}`
                  : ""}
              </span>
            )}
            {s.stack && (
              <span className="badge bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                {s.stack}
              </span>
            )}
            {poolChip ? (
              <SharedSupplyChip pool={poolChip} />
            ) : (
              <RefillBadge
                quantityOnHand={s.quantity_on_hand}
                qtyPerDose={s.qty_per_dose}
                refillRate={refillRate}
                doseCount={doses.length}
              />
            )}
            {isMed && (
              <span className="badge bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                Rx
              </span>
            )}
            {isMed && isPrn(s) && (
              <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                PRN
              </span>
            )}
            {s.critical === 1 && (
              <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                Escalates
              </span>
            )}
          </div>
        </div>
        <div className="col-start-2 row-start-1 flex shrink-0 items-center gap-3 text-xs">
          {!!s.active && due && (
            <DoseStatusControl
              doseId={dose.id}
              taken={isTaken}
              skipped={isSkipped}
              variant="circle"
            />
          )}
          <OverflowMenu
            label="Supplement actions"
            open={menuOpen}
            onOpenChange={setMenuOpen}
          >
            {({ close, runAction }) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setEditing(true);
                    close();
                  }}
                  className={MENU_ITEM}
                >
                  Edit
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowHistory((open) => !open);
                    close();
                  }}
                  className={MENU_ITEM}
                >
                  {showHistory ? "Hide dose history" : "Dose history"}
                </button>
                <form
                  action={(fd) =>
                    runAction(
                      async (data) => {
                        await toggleActive(data);
                      },
                      fd,
                      s.active ? "Supplement paused" : "Supplement resumed"
                    )
                  }
                >
                  <input type="hidden" name="id" value={s.id} />
                  <button type="submit" role="menuitem" className={MENU_ITEM}>
                    {s.active ? "Pause" : "Resume"}
                  </button>
                </form>
                {/* Plain button (not a form action): confirm() runs a modal the
                  user must answer, which deadlocks inside a form-action
                  transition. onClick is a normal handler, so the dialog shows. */}
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM_DANGER}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Delete supplement",
                      message: `Delete “${s.name}”? You can undo this.`,
                      confirmLabel: "Delete",
                      danger: true,
                    });
                    if (!ok) return;
                    close();
                    const fd = new FormData();
                    fd.set("id", String(s.id));
                    await undoable(deleteSupplement, fd, {
                      deletedMessage: "Supplement deleted.",
                    });
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </OverflowMenu>
        </div>
        <div
          data-testid="supplement-row-details"
          className="col-span-2 col-start-1 row-start-2 min-w-0 md:col-span-1"
        >
          {(dose.amount || subline) && (
            <div
              data-testid="supplement-dose-brand"
              className="flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-slate-400"
            >
              {dose.amount && <span>{dose.amount}</span>}
              {subline && (
                <>
                  {dose.amount && <span aria-hidden="true">·</span>}
                  <span>{subline}</span>
                </>
              )}
            </div>
          )}
          {foodHint && (
            <div className="mt-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {foodHint}
            </div>
          )}
          {medMeta && (
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {medMeta}
            </div>
          )}
          <NotesText
            as="div"
            notes={s.notes}
            className="mt-0.5 text-xs text-slate-500 dark:text-slate-400"
          />
          {/* Food–drug guidance (issue #154): per-item food note for a matching
            item (e.g. dairy/minerals × iron-binding drugs). */}
          <FoodGuidance
            itemId={s.id}
            name={s.name}
            rxcui={s.rxcui}
            rxcuiIngredients={s.rxcui_ingredients}
            suppressedFoodKeys={suppressedFoodKeys}
          />
          <AdherenceSummaryLine strip={strip} noteworthyOnly />
        </div>
        {/* Dose history is a DISCLOSURE inside the row, not a modal: the ⋯ row
          actions portal above the page but below a modal backdrop, so a menu
          rendered inside a dialog would be unclickable. Inline also matches the
          medication card, which renders the same panel in place. */}
        {showHistory && (
          <div
            data-testid="supplement-dose-history-panel"
            className="col-span-2 col-start-1 row-start-3 mt-3 min-w-0 border-t border-black/5 pt-3 dark:border-white/5"
          >
            <DoseHistoryPanel
              itemId={s.id}
              itemName={s.name}
              product={s.product}
              doses={doses.map((d) => ({
                id: d.id,
                amount: d.amount,
                time_of_day: d.time_of_day,
              }))}
              asNeeded={isPrn(s)}
              courseBound={isMed}
              history={doseHistory}
              maxDate={historyMaxDate}
              defaultTime={defaultHistoryTime}
              note={`Showing the last ${historyWindowDays} days. A backfill can still reach any past date.`}
              backfillDisabledReason={
                doses.length === 0
                  ? "This item has no dose to log against"
                  : undefined
              }
            />
          </div>
        )}
      </div>

      {editing && (
        <ModalShell
          title={`Edit ${s.name}`}
          onClose={() => setEditing(false)}
          className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900"
        >
          <div
            data-testid="supplement-edit-panel"
            className="mt-4 min-h-0 overflow-y-auto px-1"
          >
            <SupplementForm
              action={updateSupplement}
              supplement={s}
              doses={doses}
              allSupplements={allSupplements}
              stackItems={stackItems}
              pgxVariants={pgxVariants}
              pairs={pairs}
              onDone={() => setEditing(false)}
              trainingRestricted={trainingRestricted}
            />
          </div>
        </ModalShell>
      )}
    </>
  );
}
