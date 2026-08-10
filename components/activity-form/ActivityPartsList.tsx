"use client";

import { useState } from "react";
import {
  IconX,
  IconChevronUp,
  IconChevronDown,
  IconInfoCircle,
} from "@tabler/icons-react";
import type { ActivityType } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import type { Equipment } from "@/lib/types";
import type { ExerciseHistoryMap } from "@/lib/queries";
import type { FormDeloadContext } from "@/lib/routines";
import type { FormRecoveringContext } from "@/lib/injuries";
import type { PlateauFormHint } from "@/lib/rule-findings";
import type { CompanionMap } from "@/lib/companions";
import { biasByCompanions } from "@/lib/companions";
import { muscleFor, baseLiftName, variantOf } from "@/lib/lifts";
import { getExerciseGuide } from "@/lib/exercise-guides";
import { round } from "@/lib/units";
import { type NextSet } from "@/lib/coaching";
import {
  type PartEntry,
  type SetEntry,
  type RepeatSourceSet,
  type PartFault,
} from "@/lib/activity-form-model";
import ActivityCombobox from "@/components/ActivityCombobox";
import ModalShell from "@/components/ModalShell";
import ExerciseGuideSection from "@/components/ExerciseGuideSection";
import CustomTypeChips from "./CustomTypeChips";
import CardioFields from "./CardioFields";
import StrengthSets from "./StrengthSets";
import type { PlateTarget } from "./useActivityParts";

// The activity form's exercise/leg list (#1207 extraction): one `activity-part` row
// per entered part — the name combobox with its muscle badge + reorder/remove
// controls, the type chips for a custom part, the StrengthSets or CardioFields editor,
// and the per-part fault messages — plus the "+ Add activity" button and the live
// multisport roll-up. Pure presentation over the parent's parts state + the
// useActivityParts mutators; every value and handler is a prop.
export default function ActivityPartsList({
  parts,
  stickyFooter,
  isEdit,
  units,
  history,
  deloadContext,
  recoveringContext,
  plateauHints,
  currentActivityId,
  editedDate,
  equipmentList,
  onEquipmentCreated,
  overallDuration,
  // Bodyweight prompt (folded into the first bodyweight part's StrengthSets).
  bwKnown,
  firstBwPart,
  bwInput,
  bwSaving,
  onBwInput,
  onSaveBodyweight,
  // Combobox ordering + name classification.
  equipmentRankedOptions,
  enteredLiftBases,
  liftCompanions,
  isKnown,
  partType,
  partNeedsDistance,
  partIssue,
  blocked,
  // Add / roll-up row.
  canAddPart,
  showRollup,
  rollupDistanceKm,
  rollupDurationMin,
  // Mutators (from useActivityParts).
  onTypePartName,
  onPickPartName,
  onMovePart,
  onRemovePart,
  onAddPart,
  onUpdatePart,
  onUpdateSet,
  onAddSet,
  onRemoveSet,
  onUpdatePartName,
  onApplySuggestion,
  onApplyPerSideSuggestion,
  onFillFromSession,
  onPlateFromSuggestion,
  onPlateTarget,
}: {
  parts: PartEntry[];
  stickyFooter: boolean;
  isEdit: boolean;
  units: UnitPrefs;
  history: ExerciseHistoryMap;
  deloadContext: FormDeloadContext;
  recoveringContext: FormRecoveringContext;
  plateauHints: PlateauFormHint[];
  currentActivityId: number | null;
  editedDate: string | null;
  equipmentList: Equipment[];
  // Pass-through for the strength picker's in-form equipment creation (#1611).
  onEquipmentCreated: (equipment: Equipment) => void;
  overallDuration: number | null;
  bwKnown: boolean;
  firstBwPart: number;
  bwInput: string;
  bwSaving: boolean;
  onBwInput: (v: string) => void;
  onSaveBodyweight: () => void;
  equipmentRankedOptions: string[];
  enteredLiftBases: string[];
  liftCompanions: CompanionMap;
  isKnown: (name: string) => boolean;
  partType: (p: PartEntry) => ActivityType | null;
  partNeedsDistance: (p: PartEntry) => boolean;
  partIssue: (p: PartEntry) => PartFault;
  blocked: boolean;
  canAddPart: boolean;
  showRollup: boolean;
  rollupDistanceKm: number | null;
  rollupDurationMin: number | null;
  onTypePartName: (pi: number, v: string) => void;
  onPickPartName: (pi: number, v: string) => void;
  onMovePart: (pi: number, dir: -1 | 1) => void;
  onRemovePart: (pi: number) => void;
  onAddPart: () => void;
  onUpdatePart: (pi: number, patch: Partial<PartEntry>) => void;
  onUpdateSet: (pi: number, si: number, patch: Partial<SetEntry>) => void;
  onAddSet: (pi: number) => void;
  onRemoveSet: (pi: number, si: number) => void;
  onUpdatePartName: (
    pi: number,
    name: string,
    extra?: Partial<PartEntry>
  ) => void;
  onApplySuggestion: (pi: number, ns: NextSet) => void;
  onApplyPerSideSuggestion: (
    pi: number,
    left: NextSet | null,
    right: NextSet | null
  ) => void;
  onFillFromSession: (pi: number, sessionSets: RepeatSourceSet[]) => void;
  onPlateFromSuggestion: (pi: number, weightKg: number) => void;
  onPlateTarget: (target: PlateTarget) => void;
}) {
  // The exercise how-to overlay (#734) lives HERE, with the part header that
  // triggers it (#1613) — one owner for the state and the modal, so the trigger
  // could move out of StrengthSets' own right-aligned row into the part's action
  // toolbar without duplicating either. Holds the index of the part whose guide
  // is open, so at most one overlay exists no matter how many parts are entered.
  const [guideFor, setGuideFor] = useState<number | null>(null);
  const guidePart =
    guideFor != null &&
    parts[guideFor] &&
    getExerciseGuide(parts[guideFor].name)
      ? parts[guideFor]
      : null;
  return (
    <section aria-labelledby="workout-content-title">
      <h3 id="workout-content-title" className="sr-only">
        Workout
      </h3>
      <div>
        {parts.map((p, pi) => {
          const t = partType(p);
          const valid = t !== null;
          const muscle = t === "strength" ? muscleFor(p.name) : null;
          // Hoist companions of the OTHER entered lifts to the top of this
          // part's picker (issue #195); excludes this part's own name so it
          // can't bias its own list. No-op until a lift is entered.
          const selfBase = p.name.trim()
            ? baseLiftName(p.name).trim().toLowerCase()
            : "";
          const biasedOptions = biasByCompanions(
            equipmentRankedOptions,
            enteredLiftBases.filter((n) => n !== selfBase),
            liftCompanions
          );
          // While a change is stuck on this part, the specific fields at fault
          // are highlighted (in StrengthSets/CardioFields); the equipment fault
          // also gets its inline hint below.
          const issue = blocked ? partIssue(p) : null;
          // The catalog how-to for this lift, when there is one (#734) — the
          // trigger now rides in the part's action toolbar, so the availability
          // check belongs to the header.
          const guide =
            valid && t === "strength" ? getExerciseGuide(p.name) : undefined;
          // Does the header render its action toolbar at all? Below `sm` that
          // toolbar is a whole second row, so the set-schema row underneath has
          // to stick that much further down — `--set-schema-top` carries the
          // offset to StrengthSets, which is where the sticky row lives.
          const hasActions = !!guide || parts.length > 1;
          return (
            <div
              key={pi}
              data-testid="activity-part"
              className={`border-b border-black/5 py-3 first:pt-0 last:border-b-0 [--set-schema-top:2.75rem] dark:border-white/5 ${
                hasActions ? "max-sm:[--set-schema-top:5.875rem]" : ""
              } ${stickyFooter ? "-mx-4 px-4 sm:-mx-6 sm:px-6" : "-mx-5 px-5"}`}
            >
              {/* Below `sm` this is a TWO-ROW sticky header (#1613): the exercise
                  combobox owns the full first row (a canonical name like "Barbell
                  Bench Press" no longer loses ~110px to the sibling actions and
                  truncates), and How-to + reorder/remove form one second-row
                  toolbar with 44px targets. `sm:contents` dissolves that wrapper
                  from `sm` up, so the desktop header stays the single compact row
                  it has always been. */}
              <div
                data-testid="part-header"
                className="sticky top-0 z-10 -mx-1 flex flex-col gap-1 bg-white/95 px-1 py-1 backdrop-blur-sm sm:flex-row sm:items-center sm:gap-2 md:static md:mx-0 md:bg-transparent md:px-0 md:py-0 md:backdrop-blur-none dark:bg-ink-900/95 dark:md:bg-transparent"
              >
                <div className="min-w-0 sm:flex-1">
                  <ActivityCombobox
                    value={p.name}
                    onChange={(v) => onTypePartName(pi, v)}
                    onPick={(v) => onPickPartName(pi, v)}
                    allowFreeText
                    // Composed variant names ("Dumbbell Curl") aren't in the
                    // options list but pick as the known lift — don't promise
                    // a new activity the pick won't create.
                    freeTextLabel={(q) =>
                      isKnown(q) ? (
                        <>Use “{q}”</>
                      ) : (
                        <>Add “{q}” as new activity</>
                      )
                    }
                    options={biasedOptions}
                    placeholder={
                      pi === 0
                        ? "What did you do? e.g. Bench Press, Running, Tennis"
                        : "Add another activity…"
                    }
                    autoFocus={pi === 0 && !isEdit}
                    inputClassName="bg-white dark:bg-ink-900"
                    // A committed custom part isn't "unrecognized" — its
                    // pending type shows as amber chips, not a red border.
                    invalid={p.name.trim() !== "" && !valid && !p.custom}
                    badge={
                      muscle ? (
                        <span className="badge bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                          {muscle}
                        </span>
                      ) : undefined
                    }
                    badgeFor={(opt) => {
                      const m = muscleFor(opt);
                      return m ? (
                        <span className="badge shrink-0 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                          {m}
                        </span>
                      ) : null;
                    }}
                  />
                </div>
                {hasActions && (
                  <div
                    data-testid="part-actions"
                    className="flex items-center justify-end gap-1 sm:contents"
                  >
                    {/* "How to" (#734) — the guide affordance for this lift. It
                        used to occupy a mostly empty right-aligned row of its
                        own below the header; it now shares the part's action
                        toolbar. The overlay state is owned once, above. */}
                    {guide && (
                      <button
                        type="button"
                        onClick={() => setGuideFor(pi)}
                        data-testid="exercise-guide-open"
                        className="inline-flex h-11 shrink-0 items-center gap-1 rounded-sm px-2 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-brand-600 max-sm:mr-auto sm:h-8 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
                      >
                        <IconInfoCircle className="h-4 w-4" />
                        How to
                      </button>
                    )}
                    {parts.length > 1 && (
                      <>
                        {/* Reorder legs (issue #337) — swim → bike → run without
                            deleting and re-adding. 44×44 on a phone (#1613), the
                            unchanged compact size from `sm` up. */}
                        <button
                          type="button"
                          onClick={() => onMovePart(pi, -1)}
                          disabled={pi === 0}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-100 hover:text-brand-600 disabled:opacity-30 disabled:hover:bg-transparent sm:h-8 sm:w-7 dark:text-slate-400 dark:hover:bg-ink-800"
                          aria-label="Move activity up"
                          title="Move activity up"
                        >
                          <IconChevronUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onMovePart(pi, 1)}
                          disabled={pi === parts.length - 1}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-100 hover:text-brand-600 disabled:opacity-30 disabled:hover:bg-transparent sm:h-8 sm:w-7 dark:text-slate-400 dark:hover:bg-ink-800"
                          aria-label="Move activity down"
                          title="Move activity down"
                        >
                          <IconChevronDown className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemovePart(pi)}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-rose-400 hover:bg-rose-50 hover:text-rose-600 sm:h-8 sm:w-8 dark:text-rose-500/80 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                          aria-label="Remove activity"
                          title="Remove activity"
                        >
                          <IconX className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Chips sit outside the `valid` gates: a typeless custom part
                  renders neither block, and the chips are what unblock it. */}
              {p.custom && (p.name.trim() !== "" || p.customType !== null) && (
                <CustomTypeChips
                  activeType={p.customType}
                  fault={issue}
                  onPick={(ct) =>
                    onUpdatePart(pi, { custom: true, customType: ct })
                  }
                />
              )}
              {valid && t === "strength" && (
                <StrengthSets
                  part={p}
                  fault={issue}
                  units={units}
                  isEdit={isEdit}
                  history={history}
                  deloadContext={deloadContext}
                  recoveringContext={recoveringContext}
                  plateauHints={plateauHints}
                  currentActivityId={currentActivityId}
                  editedDate={editedDate}
                  equipmentList={equipmentList}
                  onEquipmentCreated={onEquipmentCreated}
                  showBodyweightPrompt={!bwKnown && pi === firstBwPart}
                  bwInput={bwInput}
                  bwSaving={bwSaving}
                  onBwInput={onBwInput}
                  onSaveBodyweight={onSaveBodyweight}
                  onUpdatePart={(patch) => onUpdatePart(pi, patch)}
                  onUpdateSet={(si, patch) => onUpdateSet(pi, si, patch)}
                  onAddSet={() => onAddSet(pi)}
                  onRemoveSet={(si) => onRemoveSet(pi, si)}
                  onUpdatePartName={(name, extra) =>
                    onUpdatePartName(pi, name, extra)
                  }
                  onApplySuggestion={(ns) => onApplySuggestion(pi, ns)}
                  onApplyPerSideSuggestion={(left, right) =>
                    onApplyPerSideSuggestion(pi, left, right)
                  }
                  onFillFromSession={(sessionSets) =>
                    onFillFromSession(pi, sessionSets)
                  }
                  onPlateFromSuggestion={(weightKg) =>
                    onPlateFromSuggestion(pi, weightKg)
                  }
                  onPlateTarget={(si, field) =>
                    onPlateTarget({ pi, si, field })
                  }
                />
              )}
              {valid && t !== "strength" && (
                <CardioFields
                  part={p}
                  showDist={partNeedsDistance(p)}
                  distanceUnit={units.distanceUnit}
                  overallDuration={overallDuration}
                  fault={issue}
                  onDistance={(v) => onUpdatePart(pi, { distance: v })}
                  onDurationMin={(v) => onUpdatePart(pi, { durationMin: v })}
                />
              )}
              {issue === "type" && (
                <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                  Choose cardio or sport to save. Strength exercises must be
                  picked from the list.
                </p>
              )}
              {issue === "equipment" && (
                <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                  Choose equipment to save this activity.
                </p>
              )}
              {issue === "name" && (
                <p className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400">
                  Pick a matching activity, or add this name as a new activity.
                </p>
              )}
              {issue === "set" && (
                <p className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400">
                  Finish or clear the highlighted set.
                </p>
              )}
              {issue === "content" && (
                <p className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400">
                  {t === "strength"
                    ? "Enter a complete set to save this exercise."
                    : "Enter a distance, duration, or session time range."}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onAddPart}
          disabled={!canAddPart}
          title={
            canAddPart
              ? "Add another activity"
              : "Complete the current activity first"
          }
          className="btn-ghost"
        >
          + Add activity
        </button>
        {/* Live multisport roll-up (issue #337): Σ distance / Σ duration across
            the legs while editing, matching the save-time fold. */}
        {showRollup && (
          <span
            data-testid="multisport-rollup"
            className="text-xs font-medium text-slate-500 dark:text-slate-400"
          >
            Total:
            {rollupDistanceKm != null && (
              <>
                {" "}
                {round(rollupDistanceKm, 2)} {units.distanceUnit}
              </>
            )}
            {rollupDistanceKm != null && rollupDurationMin != null && " ·"}
            {rollupDurationMin != null && <> {rollupDurationMin} min</>}
          </span>
        )}
      </div>

      {/* The how-to overlay (#734), rendered ONCE for whichever part asked for
          it — the same shared ExerciseGuideSection the exercise detail panel
          embeds, scoped to the selected implement. Never a second exercise
          surface, and never a second copy of this state. */}
      {guidePart && (
        <ModalShell
          title={`How to: ${guidePart.name}`}
          onClose={() => setGuideFor(null)}
        >
          <ExerciseGuideSection
            name={guidePart.name}
            equipment={variantOf(guidePart.name)?.equipment ?? null}
          />
        </ModalShell>
      )}
    </section>
  );
}
