"use client";

import { useRef, useState } from "react";
import {
  IconX,
  IconCheck,
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
import type { RpeTracking } from "@/lib/rpe";
import type { CompanionMap } from "@/lib/companions";
import { biasByCompanions } from "@/lib/companions";
import {
  muscleFor,
  baseLiftName,
  variantOf,
  composeVariant,
  defaultEquipment,
} from "@/lib/lifts";
import {
  moreFactsLabel,
  partFactSummary,
  partOptionsOffered,
} from "@/lib/activity-part-facts";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import { setRpeTrackingAction } from "@/app/(app)/training/activity-actions";
import { getExerciseGuide } from "@/lib/exercise-guides";
import { round, stripNonPositive } from "@/lib/units";
import { type NextSet } from "@/lib/coaching";
import {
  blockedRing,
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
import Chip from "@/components/Chip";
import FactChipRow, {
  FactAddChip,
  FactChip,
  FactMoreChip,
} from "@/components/facts/FactChipRow";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import EquipmentRegistryLink from "./EquipmentRegistryLink";
import EquipmentQuickAdd, { categoryForVariant } from "./EquipmentQuickAdd";
import type { PlateTarget } from "./useActivityParts";

// The brand-filled checkbox the options facts are edited with. It moved here from
// StrengthSets with the row it belongs to (#3349) and has no other caller.
//
// NOT `components/CheckboxControl`, the bare-checkbox primitive: that one is an
// icon-only native box named by `aria-label`, and these three are boxes with visible
// text beside them whose painted span is what `to-failure-control` and its siblings
// assert a fill colour on. Converging the two is a real question — it is an
// accessible-naming change as much as a visual one — and it is not this conversion's.
function BrandedCheckbox({
  checked,
  onChange,
  inputTestId,
  controlTestId,
}: {
  checked: boolean;
  onChange: () => void;
  inputTestId?: string;
  controlTestId?: string;
}) {
  return (
    <span className="relative inline-flex">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        data-testid={inputTestId}
        className="peer sr-only"
      />
      <span
        data-testid={controlTestId}
        aria-hidden
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-1 dark:peer-focus-visible:ring-offset-ink-900 ${
          checked
            ? "border-brand-600 bg-brand-600 text-white dark:border-brand-500 dark:bg-brand-500"
            : "border-black/20 bg-field text-transparent dark:border-white/20"
        }`}
      >
        <IconCheck className="h-3 w-3" stroke={3} />
      </span>
    </span>
  );
}

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
  live,
  units,
  history,
  deloadContext,
  recoveringContext,
  plateauHints,
  rpeTracking,
  onRpeTrackingChange,
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
  usedActivityNames,
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
  // Live workout mode (#340), passed straight through: a live part always shows its
  // full grid with the check-offs, never the compact sentence (#3336).
  live: boolean;
  units: UnitPrefs;
  history: ExerciseHistoryMap;
  deloadContext: FormDeloadContext;
  recoveringContext: FormRecoveringContext;
  plateauHints: PlateauFormHint[];
  // The profile's opted-into RPE scale, or null (#3335). Passed straight through:
  // this list owns no strength state, and the effort column belongs to StrengthSets.
  rpeTracking: RpeTracking | null;
  onRpeTrackingChange: (tracking: RpeTracking | null) => void;
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
  // Lowercased names this profile has actually logged (#2384) — passed to the
  // exercise combobox so a keystroke ranks a lift you train above a sport you have
  // never played, instead of discarding every ranker for string geometry.
  usedActivityNames: ReadonlySet<string>;
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
  // WHICH PART'S EQUIPMENT EDITOR IS OPEN (#3349), for the same reason `guideFor`
  // holds an index: at most one is open no matter how many parts are entered. That is
  // what keeps the registry door — which lives inside the panel — to ONE PER FORM
  // instead of the one-per-exercise the row used to repeat. The shared facts hook
  // rather than a plain `useState` because opening a panel unmounts the chip that was
  // activated, and this is what puts focus back on it afterwards (#3311).
  const partsRef = useRef<HTMLElement>(null);
  const {
    openEditor: openEquipment,
    open: openEquipmentEditor,
    close: closeEquipmentEditor,
    onKeyDown: onEquipmentKeyDown,
  } = useFactEditor<string>({ scopeRef: partsRef });
  // The in-form quick-add (#1611) rides the open panel, so ONE flag is right for the
  // whole list — there is only ever one panel to be inside.
  const [addingEquipment, setAddingEquipment] = useState(false);
  const closePartFact = () => {
    setAddingEquipment(false);
    closeEquipmentEditor();
  };
  // Index-keyed panels must close before the parent changes list order or length;
  // otherwise the same key silently targets its new neighbour (#4185).
  const movePart = (pi: number, dir: -1 | 1) => {
    closePartFact();
    onMovePart(pi, dir);
  };
  const removePart = (pi: number) => {
    closePartFact();
    onRemovePart(pi);
  };
  // One RPE opt-in round-trip at a time (#3335). ONE flag for the list rather than one
  // per part, which is what the fact actually is: the effort column is PROFILE-wide,
  // and two parts cannot be mid-toggle on different answers.
  const [rpeToggling, setRpeToggling] = useState(false);
  // Opting the effort column in or out from the editor itself (#3335) — no settings
  // trip. It does NOT hide optimistically: the scale the column renders over is minted
  // server-side and nowhere else (lib/rpe-tracking.ts), so the tap waits for the
  // action's answer rather than manufacturing one locally.
  async function toggleRpeTracking() {
    if (rpeToggling) return;
    setRpeToggling(true);
    try {
      const { tracking } = await setRpeTrackingAction(!rpeTracking);
      onRpeTrackingChange(tracking);
    } finally {
      setRpeToggling(false);
    }
  }
  // THE PART'S EQUIPMENT, STATED (#3349) rather than rendered as its machinery.
  //
  // This row used to live inside StrengthSets and draw six-plus controls on EVERY
  // exercise — the variant chips, the implement <select>, "+ Equipment", and a
  // "Manage equipment" link repeated once per part — whether or not anyone disagreed
  // with the implement the editor had already resolved. It states that conclusion now;
  // the picker, the quick-add and the registry door are one tap behind it, in the same
  // facts-with-editors grammar the session-level gear chip uses (#3334/#3218) and the
  // compact set notation inside StrengthSets already speaks (#3336).
  //
  // IT LIVES HERE, not in StrengthSets, because ONE PER FORM is a property of the LIST.
  // The chips, the one open editor and the hook that pairs them are the primitive's
  // unit, and splitting them across two files would give each exercise its own panel —
  // which is the door repeating again, wearing a disclosure.
  //
  // THE ROW IS STILL UNGATED (#1611). It used to render only when the lift had a
  // variant/default implement or the profile already owned equipment, which hid the
  // only door to the registry from exactly the users who needed it — a profile with no
  // strength gear, and a traveller registering the hotel machine mid-workout. Both
  // still reach the registry in one tap, through the "+ equipment" prompt this renders
  // when there is nothing to state.
  function partFactRow(p: PartEntry, pi: number, fault: PartFault) {
    const gearKey = `equipment:${pi}`;
    const optionsKey = `options:${pi}`;
    const gearOpen = openEquipment === gearKey;
    const optionsOpen = openEquipment === optionsKey;
    const variant = variantOf(p.name);
    // For lifts with no selectable equipment variant, show their normal implement.
    const defaultEq = variant ? null : defaultEquipment(p.name);
    const selectedEq = equipmentList.find((e) => e.id === p.equipmentId);
    // WHAT THE ROW STATES: the implement in the order the editor itself resolves it —
    // a user-defined row wins, then the equipment composed into the lift's own name
    // ("Dumbbell Curl" → Dumbbell), then the lift's normal implement.
    const label = selectedEq?.name ?? variant?.equipment ?? defaultEq ?? null;
    // WHAT THE WHOLE ROW STATES. The chip shapes, the three-state equipment
    // distinction and which offered facts have nothing to say all live in
    // `lib/activity-part-facts` — this function renders them and owns no vocabulary of
    // its own. `effortOn` is the profile's opt-in, the one fact here that is not the
    // part's.
    const summary = partFactSummary({
      part: p,
      gearName: label,
      effortOn: !!rpeTracking,
    });
    const moreLabel = moreFactsLabel(summary.absent);
    // WHICH CONTROLS THE OPTIONS PANEL DRAWS — the same three questions, asked
    // separately, which is what carries #3367's reachability clause through the
    // conversion. See the module.
    const offered = partOptionsOffered(p);
    // Select a custom implement on this part, matching the lift NAME (and therefore its
    // strength grouping) to the implement's type: a Barbell/Machine implement composes
    // that variant, "Other" falls back to the base lift. `created` carries a row that
    // isn't in `equipmentList` yet — the just-created one (#1611), since the parent's
    // state update hasn't reached this render.
    const selectEquipment = (id: number | null, created?: Equipment) => {
      if (id != null) {
        const v = variantOf(p.name);
        if (v) {
          const row =
            created?.id === id
              ? created
              : equipmentList.find((x) => x.id === id);
          const cat = (row?.category ?? "").trim().toLowerCase();
          const wantEquip =
            cat === "barbell"
              ? "Barbell"
              : cat === "machine"
                ? "Machine"
                : null;
          const name =
            wantEquip !== null && v.group.equipment.includes(wantEquip)
              ? composeVariant(v.group, wantEquip)
              : v.group.name;
          if (name !== p.name) onUpdatePartName(pi, name);
        }
      }
      onUpdatePart(pi, { equipmentId: id });
    };
    // WHICH PANEL A CHIP OPENS, and it is not one panel per chip. Equipment has its
    // own; sides, target and effort share ONE options panel, and so does the trailing
    // affordance — the primitive's documented shape for a row whose chips and panels do
    // not correspond one to one ("several chips can open one editor"). Three panels
    // holding one control each would have been three disclosures to shut. `focusKey`
    // stays per-chip, so closing still returns focus to the chip that was activated
    // rather than to the first of the three (#3311).
    const focusKeyFor = (fk: string) => `${fk}:${pi}`;
    const chipProps = (fk: string, panel: string, testId: string) => ({
      testId,
      expanded: false,
      onOpen: () => openEquipmentEditor(panel, focusKeyFor(fk)),
    });

    if (!gearOpen && !optionsOpen)
      return (
        <FactChipRow
          testId="part-fact-row"
          className={`mt-2 ${
            fault === "equipment"
              ? `-mx-1.5 -my-1 px-1.5 py-1 ${blockedRing}`
              : ""
          }`}
        >
          {summary.chips.map((c) => {
            const props = chipProps(
              c.key,
              c.key === "equipment" ? gearKey : optionsKey,
              c.key === "equipment"
                ? "strength-equipment-chip"
                : `part-fact-${c.key}`
            );
            return c.state === "add" ? (
              <FactAddChip
                key={c.key}
                {...props}
                focusKey={focusKeyFor(c.key)}
                label={c.label}
              />
            ) : (
              <FactChip
                key={c.key}
                {...props}
                focusKey={focusKeyFor(c.key)}
                label={c.label}
                state={c.state}
              />
            );
          })}
          {/* THE ONE TRAILING AFFORDANCE, holding the offered facts with nothing to
              state and NAMING them, so "more" never means "somewhere in here". This is
              what makes the conversion a density win rather than a relabelling: three
              standing "+ thing" prompts would have replaced four controls with four.

              EQUIPMENT IS NOT AMONG THEM, and that asymmetry is #3349 AC 1 rather than
              an oversight: the picker and its door are ONE TAP behind the row, and the
              empty case is the one where that matters most. Folding the `+ equipment`
              prompt in here would make the part with no implement the only part paying
              a second tap — affordance, then menu item — to reach the picker, because
              equipment's editor is a different panel from this one's. The asymmetry is
              recorded in lib/activity-part-facts.ts, which is also where the case for
              revisiting it is written down. */}
          {moreLabel && (
            <FactMoreChip
              {...chipProps("more", optionsKey, "part-fact-more")}
              focusKey={focusKeyFor("more")}
              label={moreLabel}
            />
          )}
        </FactChipRow>
      );

    if (optionsOpen)
      return (
        <FactEditorHost
          testId="part-options-editor"
          doneTestId="part-options-done"
          panel="options"
          className="mt-2 rounded-lg border border-(--border) bg-surface p-3"
          onDone={closePartFact}
        >
          {/* The row #3335 and #1612 built, verbatim, now one tap behind its own
              conclusions. Each control keeps the testid other specs address it by —
              nothing here is renamed, only relocated.

              THE THREE CONDITIONS ARE ASKED SEPARATELY, which is #3367's clause and the
              thing a conversion loses by folding them into one. See
              `partOptionsOffered`. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-medium text-slate-500 dark:text-slate-400">
            {offered.sides && (
              <label className="flex cursor-pointer items-center gap-2">
                <BrandedCheckbox
                  checked={p.perSide}
                  onChange={() => onUpdatePart(pi, { perSide: !p.perSide })}
                  inputTestId="per-side-checkbox"
                  controlTestId="per-side-control"
                />
                Track sides separately
              </label>
            )}
            {offered.intent && (
              <>
                <label className="flex items-center gap-1.5">
                  Target reps
                  <input
                    type="number"
                    min="1"
                    value={p.targetReps}
                    disabled={p.toFailure}
                    onChange={(e) =>
                      onUpdatePart(pi, {
                        targetReps: stripNonPositive(e.target.value),
                      })
                    }
                    placeholder="—"
                    className="input w-16 px-2 py-1 disabled:opacity-40"
                  />
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <BrandedCheckbox
                    checked={p.toFailure}
                    onChange={() =>
                      onUpdatePart(pi, { toFailure: !p.toFailure })
                    }
                    inputTestId="to-failure-checkbox"
                    controlTestId="to-failure-control"
                  />
                  To failure
                </label>
              </>
            )}
            {offered.effort && (
              <span className="inline-flex items-center gap-1">
                <label
                  className={`flex items-center gap-2 ${
                    rpeToggling
                      ? "cursor-progress opacity-60"
                      : "cursor-pointer"
                  }`}
                >
                  <BrandedCheckbox
                    checked={!!rpeTracking}
                    onChange={() => void toggleRpeTracking()}
                    inputTestId="rpe-tracking-checkbox"
                    controlTestId="rpe-tracking-control"
                  />
                  Rate effort (RPE)
                </label>
                <InfoTooltipIcon
                  label="RPE means rate of perceived exertion (5–10, optional). It adds an effort rating to every set row, now and in future sessions."
                  data-testid="rpe-help"
                />
              </span>
            )}
          </div>
        </FactEditorHost>
      );

    return (
      <FactEditorHost
        testId="strength-equipment-editor"
        doneTestId="strength-equipment-done"
        panel="equipment"
        className="mt-2 rounded-lg border border-(--border) bg-surface p-3"
        onDone={closePartFact}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {variant &&
            variant.group.equipment.map((eq) => {
              // A variant equipment and a custom implement are mutually exclusive, so
              // a variant chip is active only when no custom implement is chosen.
              const active = variant.equipment === eq && p.equipmentId == null;
              return (
                <Chip
                  key={eq}
                  role="filter"
                  onClick={() => {
                    onUpdatePartName(pi, composeVariant(variant.group, eq));
                    onUpdatePart(pi, { equipmentId: null });
                  }}
                  pressed={active}
                >
                  {eq}
                </Chip>
              );
            })}
          {/* This lift's default implement — click to clear any custom implement and
              use the default; highlighted while it's active. */}
          {defaultEq && (
            <Chip
              role="filter"
              onClick={() => onUpdatePart(pi, { equipmentId: null })}
              pressed={p.equipmentId == null}
            >
              {defaultEq}
            </Chip>
          )}
          {/* User-defined implement: a compact dropdown sharing the chip row.
              Selecting one drops any variant equipment (resets to the base). */}
          {equipmentList.length > 0 && (
            <select
              value={p.equipmentId ?? ""}
              data-testid="strength-equipment-select"
              onChange={(e) =>
                selectEquipment(e.target.value ? Number(e.target.value) : null)
              }
              className="input w-auto px-2.5 text-xs"
            >
              <option value="">Equipment</option>
              {equipmentList.map((eq) => (
                <option key={eq.id} value={eq.id}>
                  {eq.name}
                </option>
              ))}
            </select>
          )}
          {/* Compact in-form creation (#1611) — the travel-workout path. Registering
              the hotel machine here keeps the in-progress sets intact AND gives it a
              distinct equipment id, which is what makes its history/seed separate from
              the home machine's (#1610). */}
          {!addingEquipment && (
            <button
              type="button"
              onClick={() => setAddingEquipment(true)}
              data-testid="strength-equipment-add"
              className="btn-ghost px-2.5 text-xs"
            >
              + Equipment
            </button>
          )}
          {/* Full management stays on /equipment — the same same-app door
              ActivityEquipmentPicker renders for non-strength activities (#592). ONE
              PER FORM, not one per exercise: only one of these panels is ever open. */}
          <EquipmentRegistryLink testId="strength-equipment-link">
            {equipmentList.length === 0
              ? "Add equipment →"
              : "Manage equipment"}
          </EquipmentRegistryLink>
        </div>
        {addingEquipment && (
          <EquipmentQuickAdd
            // Default the category from the lift's built-in variant when it's
            // unambiguous ("Machine Chest Press" → Machine); otherwise the field is
            // empty and required rather than guessed.
            defaultCategory={categoryForVariant(
              variant?.equipment ?? defaultEq
            )}
            unit={units.weightUnit}
            onCreated={(eq) => {
              // Editor-local state gains the row (so every OTHER part of this same open
              // activity can pick it too) and the current part selects it immediately —
              // no reopen, no re-entered sets.
              onEquipmentCreated(eq);
              selectEquipment(eq.id, eq);
              setAddingEquipment(false);
            }}
            onCancel={() => setAddingEquipment(false)}
          />
        )}
      </FactEditorHost>
    );
  }

  const guidePart =
    guideFor != null &&
    parts[guideFor] &&
    getExerciseGuide(parts[guideFor].name)
      ? parts[guideFor]
      : null;
  return (
    <section
      ref={partsRef}
      aria-labelledby="workout-content-title"
      onKeyDown={onEquipmentKeyDown}
    >
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
          // THE OFFSETS ARE DERIVED FROM THE CONTROL BOX, not written down: `py-1`
          // (8px) around the exercise picker, plus — when the toolbar row is there
          // — `gap-1` (4px) and that row's own 44px. #3708 moved these when the
          // field grew to 44 and #3938 moves them again now every control is the
          // 34px box, which is exactly why they read `var(--control-box)` instead
          // of a rem literal that has to be recomputed by hand each time.
          const hasActions = !!guide || parts.length > 1;
          return (
            <div
              key={pi}
              data-testid="activity-part"
              className={`border-b border-black/5 py-3 first:pt-0 last:border-b-0 [--set-schema-top:calc(0.5rem_+_var(--control-box))] dark:border-white/5 ${
                hasActions
                  ? "max-sm:[--set-schema-top:calc(0.5rem_+_var(--control-box)_+_0.25rem_+_2.75rem)]"
                  : ""
              } ${stickyFooter ? "-mx-4 px-4 sm:-mx-8 sm:px-8" : "-mx-5 px-5"}`}
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
                className="sticky top-0 z-10 -mx-1 flex flex-col gap-1 bg-surface/95 px-1 py-1 backdrop-blur-sm sm:flex-row sm:items-center sm:gap-2 md:static md:mx-0 md:bg-transparent md:px-0 md:py-0 md:backdrop-blur-none dark:md:bg-transparent"
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
                    usedOptions={usedActivityNames}
                    placeholder={
                      pi === 0
                        ? "What did you do? e.g. Bench Press, Running, Tennis"
                        : "Add another activity…"
                    }
                    autoFocus={pi === 0 && !isEdit}
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
                          onClick={() => movePart(pi, -1)}
                          disabled={pi === 0}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-100 hover:text-brand-600 disabled:opacity-30 disabled:hover:bg-transparent sm:h-8 sm:w-7 dark:text-slate-400 dark:hover:bg-ink-800"
                          aria-label="Move activity up"
                        >
                          <IconChevronUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => movePart(pi, 1)}
                          disabled={pi === parts.length - 1}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-100 hover:text-brand-600 disabled:opacity-30 disabled:hover:bg-transparent sm:h-8 sm:w-7 dark:text-slate-400 dark:hover:bg-ink-800"
                          aria-label="Move activity down"
                        >
                          <IconChevronDown className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removePart(pi)}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-rose-400 hover:bg-rose-50 hover:text-rose-600 sm:h-8 sm:w-8 dark:text-rose-500/80 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                          aria-label="Remove activity"
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
              {valid && t === "strength" && partFactRow(p, pi, issue)}
              {valid && t === "strength" && (
                <StrengthSets
                  part={p}
                  fault={issue}
                  units={units}
                  isEdit={isEdit}
                  live={live}
                  history={history}
                  deloadContext={deloadContext}
                  recoveringContext={recoveringContext}
                  plateauHints={plateauHints}
                  rpeTracking={rpeTracking}
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
        <div>
          <button
            type="button"
            onClick={onAddPart}
            disabled={!canAddPart}
            className="btn-ghost"
          >
            + Add another activity
          </button>
          {!canAddPart && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Complete the current activity first.
            </p>
          )}
        </div>
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
