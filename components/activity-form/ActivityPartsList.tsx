import { IconX, IconChevronUp, IconChevronDown } from "@tabler/icons-react";
import type { ActivityType } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import type { Equipment } from "@/lib/types";
import type { ExerciseHistoryMap } from "@/lib/queries";
import type { FormDeloadContext } from "@/lib/routines";
import type { FormRecoveringContext } from "@/lib/injuries";
import type { PlateauFormHint } from "@/lib/rule-findings";
import type { CompanionMap } from "@/lib/companions";
import { biasByCompanions } from "@/lib/companions";
import { muscleFor, baseLiftName } from "@/lib/lifts";
import { round } from "@/lib/units";
import { type NextSet } from "@/lib/coaching";
import {
  type PartEntry,
  type SetEntry,
  type RepeatSourceSet,
  type PartFault,
} from "@/lib/activity-form-model";
import ActivityCombobox from "@/components/ActivityCombobox";
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
          return (
            <div
              key={pi}
              data-testid="activity-part"
              className={`border-b border-black/5 py-3 first:pt-0 last:border-b-0 dark:border-white/5 ${
                stickyFooter ? "-mx-4 px-4 sm:-mx-6 sm:px-6" : "-mx-5 px-5"
              }`}
            >
              <div className="sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-white/95 px-1 py-1 backdrop-blur md:static md:mx-0 md:bg-transparent md:px-0 md:py-0 md:backdrop-blur-none dark:bg-ink-900/95 dark:md:bg-transparent">
                <div className="min-w-0 flex-1">
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
                {parts.length > 1 && (
                  <>
                    {/* Reorder legs (issue #337) — swim → bike → run without
                        deleting and re-adding. */}
                    <button
                      type="button"
                      onClick={() => onMovePart(pi, -1)}
                      disabled={pi === 0}
                      className="flex h-8 w-7 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-brand-600 disabled:opacity-30 disabled:hover:bg-transparent dark:text-slate-400 dark:hover:bg-ink-800"
                      aria-label="Move activity up"
                    >
                      <IconChevronUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMovePart(pi, 1)}
                      disabled={pi === parts.length - 1}
                      className="flex h-8 w-7 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-brand-600 disabled:opacity-30 disabled:hover:bg-transparent dark:text-slate-400 dark:hover:bg-ink-800"
                      aria-label="Move activity down"
                    >
                      <IconChevronDown className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemovePart(pi)}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:text-rose-500/80 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                      aria-label="Remove activity"
                    >
                      <IconX className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>

              {/* Chips sit outside the `valid` gates: a typeless custom part
                  renders neither block, and the chips are what unblock it. */}
              {p.custom && p.name.trim() !== "" && (
                <CustomTypeChips
                  activeType={t}
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
          className="btn-ghost disabled:cursor-not-allowed disabled:opacity-50"
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
    </section>
  );
}
