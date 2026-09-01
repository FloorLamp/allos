"use client";

import { useState } from "react";
import type {
  IntakeItem,
  IntakeDose,
  IntakePair,
  IntakeConditionOption,
} from "@/lib/types";
import type { IntakeItemIngredient } from "@/lib/intake-ingredients";
import type { IntakeItemPurpose } from "@/lib/intake-purposes";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import {
  CONDITION_LABELS,
  FOOD_TIMING_HINTS,
  OBLIGATION_LABELS,
  obligationClass,
  stackSchedule,
} from "@/lib/intake-schedule";
import type { AdherenceDot } from "@/lib/intake-adherence";
import type { DoseRate } from "@/lib/refill";
import {
  RefillBadge,
  SharedSupplyChip,
  AdherenceSummaryLine,
} from "@/components/AdherenceRefill";
import type { PoolChipData } from "@/lib/queries/intake";
import DoseStatusControl from "@/components/DoseStatusControl";
import IntakeItemForm from "@/components/IntakeItemForm";
import ModalShell from "@/components/ModalShell";
import FoodGuidance from "@/components/FoodGuidance";
import DoseHistoryPanel, {
  type DoseHistoryEntry,
} from "@/components/intake/DoseHistoryPanel";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
  OverflowMenuSubmitItem,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import {
  updateIntakeItem,
  setItemActive,
  deleteIntakeItem,
} from "./intake-actions";
import { isOnDemand } from "@/lib/intake-schedule";

// ONE ROW OF THE MANAGED STACK (#3987 phase 2). A supplement with two doses renders
// two rows, because two doses ARE two things to manage — different amount, different
// slot, different calendar.
//
// It is a MANAGEMENT row and no longer a schedule row: the bucket heading that used to
// state its time went with the daily schedule in phase 1, so the row says its own
// schedule now ("Evening · Every other day", "Anytime" for an on-demand item). It says
// it in ONE line — what the item is, what it costs you today, and what it is running
// out of. The composition, the notes and the whole edit surface are behind ⋯ → Edit,
// where they were always written; the dose history is behind ⋯ → Dose history. What
// stays inline is the safety layer — the food-timing hint and the food-drug guidance,
// advice about taking the thing that must never need a tap to find (#2385) — and the
// adherence line, which is SILENT unless the misses are noteworthy and is the visible
// reason an obligation-demotion suggestion is being offered below.
export default function EditableSupplementRow({
  supplement,
  dose,
  isTaken,
  isSkipped,
  doses,
  retiredDoses = [],
  allIntakeItems,
  stackItems,
  pgxVariants,
  pairs,
  ingredients = [],
  purposes = [],
  purposeConditions = [],
  purposeBiomarkers = [],
  strip,
  refillRate,
  poolChip = null,
  suppressedFoodKeys = [],
  doseHistory = [],
  historyMaxDate,
  defaultHistoryTime,
  historyWindowDays,
  activityScheduleAvailable = true,
}: {
  supplement: IntakeItem;
  dose: IntakeDose;
  /**
   * TODAY'S RESOLUTION, ONLY WHERE THIS ROW IS THE ONE STATING IT (#3987).
   *
   * The Day ledger states every dose the day OWES and every dose the day RESOLVED, so
   * a row that appears there must not restate it here — that is the duplication the
   * redesign exists to end. What the ledger cannot reach is a dose the day never owed
   * and nobody logged: a `may` item, an off-cadence row, a situation-inactive one.
   * #2419's guarantee is that those are still ONE TAP away, and this is where that tap
   * lives now.
   *
   * ABSENT means "the ledger is stating this dose" — not "false". Making it optional
   * rather than a `showControl` flag is deliberate: there is no way to ask for the
   * control without also supplying the state it renders, so the two cannot come apart.
   */
  isTaken?: boolean;
  isSkipped?: boolean;
  doses: IntakeDose[];
  // Retired doses of this item (#2131), for the edit form's Restore affordance.
  retiredDoses?: IntakeDose[];
  allIntakeItems: { id: number; name: string }[];
  stackItems: InteractionItem[];
  pgxVariants: PgxVariantInput[];
  pairs: IntakePair[];
  // This item's label composition (#2856): the "What's in this" disclosure below and
  // the edit form's repeater. Empty for the ordinary single-substance item.
  ingredients?: IntakeItemIngredient[];
  // Purpose links and their picker sources (#2857), passed straight to the edit form.
  purposes?: IntakeItemPurpose[];
  purposeConditions?: IntakeConditionOption[];
  purposeBiomarkers?: string[];
  strip: AdherenceDot[];
  refillRate: DoseRate | null;
  // The shared-bottle chip when this item draws from a pool (#1374) — it REPLACES
  // the per-item refill badge, since a linked item keeps no private count.
  poolChip?: PoolChipData | null;
  // Past schedule days are read-only: show the recorded outcome without exposing
  // today's write control against a historical row.
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
  activityScheduleAvailable?: boolean;
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
  const schedule = stackSchedule(s, dose).label;
  // The refill "≈N days left" badge is the shared RefillBadge formatter (#38/#301),
  // rendered identically here and on the medication card (#747 parity).

  return (
    <>
      <div
        data-testid="supplement-row"
        className={`card grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 px-3! py-3! shadow-none! ${
          !s.active ? "opacity-50" : ""
        } ${menuOpen ? "relative z-20" : ""}`}
      >
        <div className="col-start-1 row-start-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              data-testid="intake-item-name"
              className="min-w-0 wrap-break-word font-medium text-slate-800 dark:text-slate-100"
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
            {s.critical === 1 && (
              <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                Escalates
              </span>
            )}
          </div>
        </div>
        <div className="col-start-2 row-start-1 flex shrink-0 items-center gap-3 text-xs">
          {/* ONE TAP AWAY, FOR EVERY ACTIVE ITEM (#2419) — on the rows the Day ledger
            cannot reach. The gate is the item's state and the row's DAY, never its
            dueness: dueness gates NUDGING, and logging is a statement about what
            happened. So a `may` item, an off-cadence row and a situation-inactive one
            all keep their tap here, while a dose the ledger already states (owed, or
            resolved today) renders no control at all — because it has one THERE, and
            two would be the duplication #3987 retired. A paused item has none either,
            matching setDoseStatus's own refusals. The logged day is TODAY: a tap says
            "I took this now", it never claims the item was scheduled. */}
          {!!s.active && isTaken !== undefined && (
            <DoseStatusControl
              doseId={dose.id}
              taken={isTaken}
              skipped={isSkipped ?? false}
              variant="circle"
            />
          )}
          <OverflowMenu
            kind="Supplement"
            itemName={s.name}
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
                {/* STATE-NAMED transition (#2133): the form posts the state this render
                  promised (`to`), and the toast words come from the write's OUTCOME —
                  a stale row's tap gets the typed refusal ("Already paused…"), never
                  the wrong write with the wrong words. */}
                <form
                  action={(fd) =>
                    runAction(
                      async (data) => {
                        const res = await setItemActive(data);
                        if (!res.ok) return res;
                        return {
                          ok: true,
                          message:
                            res.state === "paused"
                              ? "Supplement paused"
                              : "Supplement resumed",
                        };
                      },
                      fd,
                      s.active ? "Supplement paused" : "Supplement resumed"
                    )
                  }
                >
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="to" value={s.active ? "0" : "1"} />
                  <OverflowMenuSubmitItem>
                    {s.active ? "Pause" : "Resume"}
                  </OverflowMenuSubmitItem>
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
                    await undoable(deleteIntakeItem, fd, {
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
          {/* THE MANAGEMENT LINE: what it costs, when it is taken, what it is. The
            schedule is unconditional — a row that cannot say when it is taken is
            not a stack row — so the composition ("What's in this", #2856) and the
            item notes moved into ⋯ → Edit, which is where both were written and
            where the numbers behind a UL warning are still inspectable. */}
          <div
            data-testid="supplement-dose-brand"
            className="flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-slate-400"
          >
            {[dose.amount, schedule, subline]
              .filter((part): part is string => !!part)
              .map((part, index) => (
                <span key={part} className="flex items-center gap-2">
                  {index > 0 && <span aria-hidden="true">·</span>}
                  <span
                    data-testid={
                      part === schedule ? "supplement-row-schedule" : undefined
                    }
                  >
                    {part}
                  </span>
                </span>
              ))}
          </div>
          {foodHint && (
            <div className="mt-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {foodHint}
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
              asNeeded={isOnDemand(s)}
              courseBound={false}
              history={doseHistory}
              strip={strip}
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
          size="lg"
        >
          <div
            data-testid="supplement-edit-panel"
            className="min-h-0 overflow-y-auto px-1"
          >
            <IntakeItemForm
              action={updateIntakeItem}
              kind="supplement"
              item={s}
              doses={doses}
              ingredients={ingredients}
              purposes={purposes}
              conditions={purposeConditions}
              biomarkers={purposeBiomarkers}
              retiredDoses={retiredDoses}
              allIntakeItems={allIntakeItems}
              stackItems={stackItems}
              pgxVariants={pgxVariants}
              pairs={pairs}
              activityScheduleAvailable={activityScheduleAvailable}
              onDone={() => setEditing(false)}
            />
          </div>
        </ModalShell>
      )}
    </>
  );
}
