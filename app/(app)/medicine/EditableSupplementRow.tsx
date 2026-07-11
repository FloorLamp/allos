"use client";

import { useState } from "react";
import { IconFlame } from "@tabler/icons-react";
import type { Supplement, SupplementDose, SupplementPair } from "@/lib/types";
import type { InteractionItem } from "@/lib/drug-interactions";
import { CONDITION_LABELS, FOOD_TIMING_HINTS } from "@/lib/supplement-schedule";
import {
  adherenceSummary,
  type AdherenceDot,
} from "@/lib/supplement-adherence";
import {
  daysOfSupplyForItem,
  isLowSupply,
  refillBasisLabel,
  type DoseRate,
} from "@/lib/refill";
import SupplementForm from "./SupplementForm";
import FoodGuidance from "./FoodGuidance";
import DoseStatusControl from "@/components/DoseStatusControl";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import { updateSupplement, toggleActive, deleteSupplement } from "./actions";

// One scheduled dose of a supplement, as it appears in a time bucket. A
// supplement with multiple doses renders one of these per dose. Editing opens
// the full supplement form (all its doses).
export default function EditableSupplementRow({
  supplement,
  dose,
  doses,
  allSupplements,
  stackItems,
  pairs,
  isTaken,
  isSkipped,
  due,
  strip,
  trainingRestricted,
  refillRate,
}: {
  supplement: Supplement;
  dose: SupplementDose;
  doses: SupplementDose[];
  allSupplements: { id: number; name: string }[];
  stackItems: InteractionItem[];
  pairs: SupplementPair[];
  isTaken: boolean;
  isSkipped: boolean;
  due: boolean;
  strip: AdherenceDot[];
  trainingRestricted: boolean;
  refillRate: DoseRate | null;
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

  // Recent adherence (last 14 days) as a streak + percentage, shown once at the
  // bottom of the card. The streak only surfaces once it's worth celebrating.
  const adherence = adherenceSummary(strip);

  // Refill tracking: "≈N days left" from on-hand quantity. The
  // doses/day rate comes from the shared refill estimate (#38) — the ACTUAL
  // taken-log rate when the item has enough history, else the scheduled-dose-count
  // estimate — with the basis surfaced in the badge's tooltip. Only shown when the
  // item opts into quantity tracking (quantity_on_hand set). daysOfSupplyForItem
  // is the one computation the dashboard Low-supply widget also formats over (#301).
  const daysLeft = daysOfSupplyForItem(
    s.quantity_on_hand,
    s.qty_per_dose,
    refillRate,
    doses.length
  );
  const lowSupply = isLowSupply(daysLeft);
  const refillBasis = refillBasisLabel(refillRate?.basis ?? "schedule");

  // Medication identity: the stricter affordances (Rx/PRN/escalate
  // badges above, prescriber/pharmacy/Rx line below).
  const isMed = s.kind === "medication";
  const medMeta = isMed
    ? [
        s.prescriber && `Dr. ${s.prescriber.replace(/^dr\.?\s*/i, "")}`,
        s.pharmacy,
        s.rx_number && `Rx ${s.rx_number.replace(/^rx\s*/i, "")}`,
        // The linked provider from the shared registry.
        s.provider_name,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

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
            <span className="font-medium text-slate-800 dark:text-slate-100">
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
            {daysLeft !== null && (
              <span
                data-testid="refill-days-left"
                className={`badge ${
                  lowSupply
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                    : "bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400"
                }`}
                title={`Estimated days of supply remaining — ${refillBasis}`}
              >
                {lowSupply ? "Low · " : ""}≈{daysLeft} day
                {daysLeft === 1 ? "" : "s"} left
                <span className="ml-1 font-normal opacity-70">
                  · {refillBasis}
                </span>
              </span>
            )}
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
            name={s.name}
            rxcui={s.rxcui}
            rxcuiIngredients={s.rxcui_ingredients}
          />
          {(adherence.pct !== null || adherence.skippedDays > 0) && (
            <div
              className="mt-1.5 flex items-center gap-1.5 text-xs"
              title="Adherence over the last 14 days"
            >
              {adherence.streak >= 2 && (
                <>
                  <span className="flex items-center gap-1 font-medium text-slate-600 dark:text-slate-300">
                    <IconFlame
                      className="h-3.5 w-3.5 text-brand-500 dark:text-brand-400"
                      aria-hidden="true"
                    />
                    {adherence.streak}-day streak
                  </span>
                  <span
                    aria-hidden="true"
                    className="text-slate-300 dark:text-slate-600"
                  >
                    ·
                  </span>
                </>
              )}
              {adherence.pct !== null && (
                <span className="text-slate-500 dark:text-slate-400">
                  {adherence.pct}% adherence
                </span>
              )}
              {adherence.skippedDays > 0 && (
                <>
                  {adherence.pct !== null && (
                    <span
                      aria-hidden="true"
                      className="text-slate-300 dark:text-slate-600"
                    >
                      ·
                    </span>
                  )}
                  <span className="text-amber-600 dark:text-amber-400">
                    {adherence.skippedDays} skipped
                  </span>
                </>
              )}
            </div>
          )}
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
                    toggleActive,
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
