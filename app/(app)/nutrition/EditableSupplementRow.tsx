"use client";

import { useState } from "react";
import type { Supplement, SupplementDose, SupplementPair } from "@/lib/types";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import { CONDITION_LABELS, FOOD_TIMING_HINTS } from "@/lib/supplement-schedule";
import { medicationMetaLine } from "@/lib/medication-history";
import type { AdherenceDot } from "@/lib/supplement-adherence";
import type { DoseRate } from "@/lib/refill";
import {
  RefillBadge,
  AdherenceSummaryLine,
} from "@/components/AdherenceRefill";
import SupplementForm from "@/components/SupplementForm";
import FoodGuidance from "@/components/FoodGuidance";
import DoseStatusControl from "@/components/DoseStatusControl";
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
  suppressedFoodKeys = [],
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
  // Active food-timing dismissals for this profile (#435), threaded to FoodGuidance.
  suppressedFoodKeys?: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const s = supplement;

  if (editing) {
    return (
      <div className="card bg-slate-50/60 dark:bg-ink-900/60">
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
    );
  }

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
    <div
      className={`card !py-3 flex items-start justify-between gap-3 ${
        !s.active ? "opacity-50" : ""
      } ${
        s.priority === "mandatory"
          ? "border-l-4 border-l-rose-400 dark:border-l-rose-500"
          : s.priority === "high"
            ? "border-l-4 border-l-brand-500 dark:border-l-brand-400"
            : "border-l-4 border-l-transparent"
      } ${menuOpen ? "relative z-20" : ""}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-4">
        {!!s.active && due && (
          <DoseStatusControl
            doseId={dose.id}
            taken={isTaken}
            skipped={isSkipped}
            variant="circle"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              data-testid="medicine-name"
              className="min-w-0 break-words font-medium text-slate-800 dark:text-slate-100"
            >
              {s.name}
            </span>
            {(dose.amount || subline) && (
              <div className="order-1 flex basis-full flex-wrap items-center gap-2 text-sm text-slate-500 lg:order-none lg:basis-auto dark:text-slate-400">
                {dose.amount && (
                  <>
                    <span aria-hidden="true" className="hidden lg:inline">
                      ·
                    </span>
                    <span>{dose.amount}</span>
                  </>
                )}
                {subline && (
                  <>
                    <span
                      aria-hidden="true"
                      className={dose.amount ? undefined : "hidden lg:inline"}
                    >
                      ·
                    </span>
                    <span>{subline}</span>
                  </>
                )}
              </div>
            )}
            {multi && (
              <span className="badge bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                split
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
            <RefillBadge
              quantityOnHand={s.quantity_on_hand}
              qtyPerDose={s.qty_per_dose}
              refillRate={refillRate}
              doseCount={doses.length}
            />
            {isMed && (
              <span className="badge bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                Rx
              </span>
            )}
            {isMed && s.as_needed === 1 && (
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
          {s.notes && (
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {s.notes}
            </div>
          )}
          {/* Food–drug guidance (issue #154): per-item food note for a matching
              item (e.g. dairy/minerals × iron-binding drugs). */}
          <FoodGuidance
            itemId={s.id}
            name={s.name}
            rxcui={s.rxcui}
            rxcuiIngredients={s.rxcui_ingredients}
            suppressedFoodKeys={suppressedFoodKeys}
          />
          <AdherenceSummaryLine strip={strip} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs">
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
    </div>
  );
}
