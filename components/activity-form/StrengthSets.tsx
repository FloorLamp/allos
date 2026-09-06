"use client";

import FactChipRow, { FactChip } from "@/components/facts/FactChipRow";
import ControlTooltip from "@/components/ControlTooltip";
import IconButton from "@/components/IconButton";
import ExerciseHistory from "./ExerciseHistory";
import { useEffect, useRef, useState } from "react";
import type { Equipment } from "@/lib/types";
import { isBarbell } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import type { ExerciseHistoryMap } from "@/lib/queries";
import {
  isTimed,
  isBodyweight,
  isBarbellLift,
  exerciseHistoryKey,
  loadKindOf,
} from "@/lib/lifts";
import {
  exerciseInjuryVerdict,
  RECOVERING_LOAD_FACTOR,
} from "@/lib/injury-model";
import { isValidDuration } from "@/lib/duration";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { judgeTargets } from "@/lib/training-log-format";
import {
  suggestNextSet,
  contextualNextSet,
  sessionBestSet,
  sessionWorkSets,
  sideSets,
  nextSetText,
  weightIncrementKg,
  weightIncrementLb,
  type NextSet,
} from "@/lib/coaching";
import type { FormDeloadContext } from "@/lib/routines";
import type { FormRecoveringContext } from "@/lib/injuries";
import { resolveTrainingTemper } from "@/lib/niggle-model";
import type { PlateauFormHint } from "@/lib/rule-findings";
import { dismissTrainingObservation } from "@/app/(app)/training/actions";
import { pickSeedSessions } from "@/lib/exercise-window";
import { stepRpe, fmtRpe, rpeSummaryText, type RpeTracking } from "@/lib/rpe";
import {
  dispWeight,
  round,
  stripNegative,
  stripNonPositive,
} from "@/lib/units";
import {
  IconX,
  IconBarbell,
  IconAlertTriangle,
  IconCheck,
  IconTrendingDown,
} from "@tabler/icons-react";
import {
  asPlan,
  confirmSet,
  doneSets,
  setDone,
  partIntent,
  partTotal,
  recentSessionsForForm,
  repeatSessionFill,
  setComplete,
  sidePartial,
  blockedField,
  partSetsSummary,
  sharesLoad,
  type PartEntry,
  type SetEntry,
  type SetPlan,
  type RepeatSourceSet,
  type PartFault,
} from "./model";
import Stepper from "@/components/Stepper";
import type { SetFill } from "./useActivityParts";

// The four set-row steppers share one frame; only the border says whether the field
// is what a stuck change is waiting on.
const fieldBorder = (blocked: boolean) =>
  blocked ? blockedField : "border-black/10 dark:border-white/10";

// A compact, optional per-set RPE selector (issue #743): −/value/+ in half-point
// steps over the 5–10 scale, BLANK by default (logging RPE is never required).
// Stepping down off the floor clears it back to blank; stepping up from blank
// seeds a working rating. The rating rides onto the set's declared intent — it
// never replaces target reps / to-failure.
//
// SIZED TO THE OPTIONS COLUMN FROM `sm` UP: the whole control fits the row's
// w-16 (64px) options column (w-4 + w-7 + w-4 + borders = 62px), stacked above
// the warmup/remove buttons — it must never widen that column, because the
// weight/reps inputs' tap-target width is a pinned ergonomics contract (#337; the
// entry-ergonomics spec asserts the weight input keeps ≥64px). An optional,
// blank-by-default control shrinks first; the load/reps inputs never do.
//
// BELOW `sm` there is no options column to fit (#1612): the set's identity and its
// options share one horizontal toolbar row of their own, so the ± targets take the
// 44px phone minimum there instead of the 16px-wide desktop sliver.
function RpeStepper({
  tracking,
  value,
  onChange,
  testId,
}: {
  // The profile's opted-into scale (#3335). Required, not optional: without one
  // there is no answer to what a tap means, so there is no control to render.
  tracking: RpeTracking;
  value: number | null;
  onChange: (v: number | null) => void;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-center overflow-hidden rounded-md border border-black/10 text-xs dark:border-white/10"
    >
      <ControlTooltip label="Decrease RPE">
        {(anchor) => (
          <button
            {...anchor}
            type="button"
            tabIndex={-1}
            onClick={() => onChange(stepRpe(tracking, value, -1))}
            className="flex h-11 w-11 shrink-0 items-center justify-center font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-600 sm:h-7 sm:w-4 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
          >
            −
          </button>
        )}
      </ControlTooltip>
      <span
        data-testid={testId ? `${testId}-value` : undefined}
        aria-label={value == null ? "RPE not set" : `RPE ${fmtRpe(value)}`}
        className={`w-7 text-center tabular-nums ${
          value == null
            ? "text-xs font-medium uppercase tracking-wide text-slate-300 dark:text-slate-600"
            : "font-semibold text-slate-700 dark:text-slate-200"
        }`}
      >
        {value == null ? "RPE" : fmtRpe(value)}
      </span>
      <ControlTooltip label="Increase RPE">
        {(anchor) => (
          <button
            {...anchor}
            type="button"
            tabIndex={-1}
            onClick={() => onChange(stepRpe(tracking, value, 1))}
            className="flex h-11 w-11 shrink-0 items-center justify-center font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-600 sm:h-7 sm:w-4 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
          >
            +
          </button>
        )}
      </ControlTooltip>
    </div>
  );
}

// Which half of a set one row edits (#5377). The bilateral row and the L/R pair of a
// per-side lift are ONE row shape; all that differs is which `SetEntry` keys it reads
// and writes and what it calls itself, so the side LOOKS THOSE UP instead of being a
// flag the row keeps asking itself about.
type RowSide = "both" | "left" | "right";
const SIDE = {
  both: { label: null, weight: "weight", reps: "reps", duration: "duration" },
  left: { label: "L", weight: "weight", reps: "reps", duration: "duration" },
  right: {
    label: "R",
    weight: "weightRight",
    reps: "repsRight",
    duration: "durationRight",
  },
} as const satisfies Record<
  RowSide,
  {
    label: string | null;
    weight: "weight" | "weightRight";
    reps: "reps" | "repsRight";
    duration: "duration" | "durationRight";
  }
>;

// The ids a row is addressed by. The bilateral row carries them (specs drive
// `set1-weight`, `set2-reps`, `set1-reps-stepper`); a per-side half is reached through
// its L/R label instead, and giving it ids would only duplicate its sibling's. While
// the grid shares one load (#5371) set 1's weight ids sit on the exercise-level field:
// that field IS where set 1's weight is entered — and every other set's — and the two
// never render together.
interface SetRowIds {
  weight: string;
  reps: string;
  weightStepper: string;
  repsStepper: string;
  vary: string;
}
const rowIds = (si: number): SetRowIds => ({
  weight: `set${si + 1}-weight`,
  reps: `set${si + 1}-reps`,
  weightStepper: si === 0 ? "set1-weight-stepper" : "weight-stepper",
  repsStepper: si === 0 ? "set1-reps-stepper" : "reps-stepper",
  vary: `set-vary-${si + 1}`,
});

// The sides a part renders: one row, or an L row over an R row (#335).
const BILATERAL: readonly RowSide[] = ["both"];
const PER_SIDE: readonly RowSide[] = ["left", "right"];

const sideLabel = (side: RowSide) =>
  SIDE[side].label && (
    <span className="w-4 shrink-0 text-xs font-semibold text-slate-500 dark:text-slate-400">
      {SIDE[side].label}
    </span>
  );

// ONE LOAD FIELD: a side's weight stepper (or the plain input a bodyweight or timed
// lift takes added load through), its plate door and its stuck-change flag. A set row
// mounts it beside its reps; while every set shares one load the exercise-level band
// mounts it once above the grid instead (#5371), which is what makes "the exercise-
// level stepper is the same stepper component" true by construction.
function LoadField({
  side,
  set,
  exercise,
  unit,
  weightStep,
  showPlate,
  ids = null,
  plan = null,
  blocked,
  inputRef,
  onChange,
  onPlateTarget,
  onEnter,
}: {
  side: RowSide;
  set: SetEntry;
  exercise: string;
  unit: UnitPrefs["weightUnit"];
  weightStep: number;
  showPlate: boolean;
  ids?: SetRowIds | null;
  // What this load is OFFERED as while nobody has stated it (#5373), or null. The plan
  // is painted as a PLACEHOLDER over an empty field, never written into it: focus is
  // arrival, not intent, so typing "60" over a ghost must give 60 and not 77.560
  // (#1971). The exercise-level band takes set 1's plan, which is how #5371's band is
  // itself a ghost until a set is done — and why a load typed INTO the band shows at
  // once, plan or no plan.
  plan?: SetPlan | null;
  blocked: boolean;
  // Hands the input up on mount, so a "Vary" tap can put the caret in the weight it
  // just revealed.
  inputRef?: (el: HTMLInputElement | null) => void;
  onChange: (patch: Partial<SetEntry>) => void;
  onPlateTarget: (field: "weight" | "weightRight") => void;
  // Enter moves on to the reps this load pairs with (#5371) — the form never
  // submits on Enter, so the keystroke is free.
  onEnter: () => void;
}) {
  const f = SIDE[side];
  // A weighted, untimed lift steps its load; bodyweight and timed lifts have no load
  // to step, so the field stays a plain input.
  const stepped = !isTimed(exercise) && !isBodyweight(exercise);
  // Increment steppers (issue #337). The weight step is lift-appropriate and
  // plate-loadable — the SAME weightIncrementKg/Lb the next-set suggestion adds
  // (5 kg squat vs 2.5 kg accessory), in the user's display unit.
  // Steps from the PLAN while the field is a ghost: the offer is what a person nudges
  // up or down, not a zero.
  const stepWeight = (direction: -1 | 1) => {
    const from = Number(set[f.weight] || plan?.[f.weight]) || 0;
    const next = Math.max(0, round(from + direction * weightStep, 2));
    onChange({ [f.weight]: next > 0 ? String(next) : "" });
  };
  const input = (
    <input
      ref={inputRef}
      type="number"
      step="0.5"
      min="0"
      inputMode="decimal"
      data-testid={ids?.weight}
      value={set[f.weight]}
      onChange={(e) => onChange({ [f.weight]: stripNegative(e.target.value) })}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }}
      placeholder={plan?.[f.weight] || unit}
      className={
        stepped
          ? "number-no-spinner min-w-0 w-full border-x border-y-0 border-black/10 bg-transparent px-2 py-2 text-sm outline-hidden focus:ring-0 dark:border-white/10 dark:text-slate-100 dark:placeholder:text-slate-500"
          : `input ${blocked ? blockedField : ""}`
      }
    />
  );
  return (
    <>
      {stepped ? (
        <Stepper
          testId={ids?.weightStepper ?? "weight-stepper"}
          tabStops={false}
          onStep={stepWeight}
          decreaseLabel="Decrease weight"
          increaseLabel="Increase weight"
          className={`min-w-28 flex-1 basis-0 ${fieldBorder(blocked)}`}
        >
          {input}
        </Stepper>
      ) : (
        input
      )}
      {showPlate && (
        // Keep the set grid's established 28px plate COLUMN while IconButton owns a
        // centered 44px TARGET. The heading reserves this same w-7 slot, so widening
        // the layout column would move both value-column centers (#337).
        <span className="flex w-7 min-w-0 shrink-0 items-center justify-center">
          <IconButton
            type="button"
            // Pointer affordance only — keep it out of the weight→reps tab order (#336).
            tabIndex={-1}
            onClick={() => onPlateTarget(f.weight)}
            label="Open plate builder"
          >
            <IconBarbell className="h-4 w-4" />
          </IconButton>
        </span>
      )}
    </>
  );
}

// ONE set row: a side's `weight × reps` (or hold time) with its steppers, its plate
// door and its stuck-change flags. The bilateral part mounts it once as the values
// column itself; a per-side part mounts it twice inside that column, once per side
// (#335). `className` is the difference the two mounts genuinely have — the phone's
// two-line wrap (#1612) is a property of the column, and a stacked side is a line
// inside it.
//
// While the grid shares one load (#5371) the row is reps only — the load is stated
// once, above the rows — and carries the "Vary" door back to per-set weights.
function SetRow({
  side,
  set,
  exercise,
  unit,
  weightStep,
  showPlate,
  ids = null,
  className,
  testId,
  flagsFor,
  load,
  loadRef,
  repsRef,
  onChange,
  onPlateTarget,
  onEnter,
  onVary,
}: {
  side: RowSide;
  set: SetEntry;
  exercise: string;
  unit: UnitPrefs["weightUnit"];
  weightStep: number;
  showPlate: boolean;
  ids?: SetRowIds | null;
  className: string;
  testId?: string;
  // Which of this side's inputs to flag while a change is stuck.
  flagsFor: (
    w: string,
    r: string,
    d: string
  ) => { weight: boolean; effort: boolean };
  // Whether this row states its own load, or the exercise-level band above does.
  load: "own" | "shared";
  loadRef?: (el: HTMLInputElement | null) => void;
  // Hands this row's reps input up, so the exercise-level weight's Enter can land in
  // set 1's reps (#5371).
  repsRef?: (el: HTMLInputElement | null) => void;
  onChange: (patch: Partial<SetEntry>) => void;
  onPlateTarget: (field: "weight" | "weightRight") => void;
  // Enter in a complete reps field adds the next set (#336), when there is one to add.
  onEnter?: () => void;
  // Give every set its own weight again, starting with this one.
  onVary?: () => void;
}) {
  const f = SIDE[side];
  const timed = isTimed(exercise);
  // This row is the PLAN until it is confirmed (#5373). Its numbers show as ghost
  // placeholders, and the first step or keystroke into them writes the value AND
  // confirms the set — correcting IS confirming, so a failed set is two taps on
  // reps `−` and never a separate confirm afterwards.
  const confirm = (patch: Partial<SetEntry>) =>
    onChange({ ...confirmSet(set), ...patch });
  const flags = flagsFor(set[f.weight], set[f.reps], set[f.duration]);
  const reps = useRef<HTMLInputElement | null>(null);
  const effortRef = (el: HTMLInputElement | null) => {
    reps.current = el;
    repsRef?.(el);
  };
  // Steps from the PLAN's reps while the row is a ghost — "stepping row 2's reps
  // down twice" is `reps − 2` at the planned load, not a count started from zero.
  const stepReps = (direction: -1 | 1) => {
    const from = Number(set[f.reps] || set.plan?.[f.reps]) || 0;
    const next = Math.max(0, from + direction);
    confirm({ [f.reps]: next > 0 ? String(next) : "" });
  };
  // The "effort" input is reps for normal lifts, a m:ss hold time for timed.
  const holdInvalid =
    !!set[f.duration].trim() && !isValidDuration(set[f.duration]);
  const effortInput = timed ? (
    <input
      ref={effortRef}
      type="text"
      inputMode="numeric"
      value={set[f.duration]}
      onChange={(e) => confirm({ [f.duration]: e.target.value })}
      placeholder={set.plan?.[f.duration] || "m:ss"}
      aria-invalid={holdInvalid || undefined}
      className={`input ${
        holdInvalid
          ? "border-rose-300 dark:border-rose-800"
          : flags.effort
            ? blockedField
            : ""
      }`}
    />
  ) : (
    <input
      ref={effortRef}
      type="number"
      min="1"
      inputMode="numeric"
      data-testid={ids?.reps}
      value={set[f.reps]}
      onChange={(e) => confirm({ [f.reps]: stripNonPositive(e.target.value) })}
      onKeyDown={
        onEnter
          ? (e) => {
              // Enter in a complete reps field adds the next set (#336) — the form
              // never submits on Enter, so this is a free keystroke.
              if (e.key === "Enter") {
                e.preventDefault();
                onEnter();
              }
            }
          : undefined
      }
      placeholder={set.plan?.[f.reps] || "reps"}
      // Divider on BOTH sides now that the reps stepper is symmetric
      // (#1524: − input +), exactly like the weight stepper's input.
      className="number-no-spinner min-w-0 w-full border-x border-y-0 border-black/10 bg-transparent px-2 py-2 text-sm outline-hidden focus:ring-0 dark:border-white/10 dark:text-slate-100 dark:placeholder:text-slate-500"
    />
  );
  return (
    <div className={className} data-testid={testId}>
      {sideLabel(side)}
      {load === "own" && (
        <>
          <LoadField
            side={side}
            set={set}
            exercise={exercise}
            unit={unit}
            weightStep={weightStep}
            showPlate={showPlate}
            ids={ids}
            plan={set.plan}
            blocked={flags.weight}
            inputRef={loadRef}
            onChange={confirm}
            onPlateTarget={onPlateTarget}
            onEnter={() => reps.current?.focus()}
          />
          <span className="w-2 shrink-0 text-center text-slate-500 dark:text-slate-400">
            ×
          </span>
        </>
      )}
      {!timed ? (
        <Stepper
          testId={ids?.repsStepper ?? "reps-stepper"}
          tabStops={false}
          onStep={stepReps}
          decreaseLabel="Decrease reps"
          increaseLabel="Add a rep"
          className={`min-w-28 flex-1 basis-0 ${fieldBorder(flags.effort)}`}
        >
          {effortInput}
        </Stepper>
      ) : (
        effortInput
      )}
      {onVary && (
        <button
          type="button"
          onClick={onVary}
          data-testid={ids?.vary}
          className="w-12 shrink-0 py-2 text-xs text-link-muted"
        >
          Vary
        </button>
      )}
    </div>
  );
}

// The strength editor for one part: bodyweight prompt, equipment chips, recent
// sessions, coached next set, per-side + intent options, the set rows, and the
// running total. All state lives in the parent ActivityForm; this component
// renders it and calls back the pi-bound mutators. `fault` is this part's
// partIssue while a change is stuck — it points at the exact inputs to fill.
export default function StrengthSets({
  part,
  fault,
  units,
  isEdit,
  live,
  history,
  deloadContext,
  recoveringContext,
  plateauHints,
  rpeTracking,
  currentActivityId,
  editedDate,
  equipmentList,
  showBodyweightPrompt,
  bwInput,
  bwSaving,
  onBwInput,
  onSaveBodyweight,
  onUpdatePart,
  onUpdateSet,
  onAddSet,
  onRemoveSet,
  onUpdatePartName,
  onFill,
  onPlateTarget,
}: {
  part: PartEntry;
  fault: PartFault;
  units: UnitPrefs;
  isEdit: boolean;
  // Live workout mode (#340). The grid is the JOB in a gym session — you are reading
  // one row and checking it off — so a live part never states itself as a sentence,
  // however uniform its sets are. #3218's own workbench exclusion, which #3228 invokes
  // by name for exactly this surface.
  live: boolean;
  history: ExerciseHistoryMap;
  // Deload/plateau inputs (#923): whether the active routine is in its deload week
  // (+ which lifts to shave), and the active plateau hints keyed by exerciseHistoryKey.
  deloadContext: FormDeloadContext;
  // The recovering-injury regions (#1144): a lift whose region is returning from a
  // RECOVERING injury (#838) gets the tempered load — composed with the deload shave
  // through the ONE shared contextualNextSet, so this form matches the Analyze panel.
  recoveringContext: FormRecoveringContext;
  plateauHints: PlateauFormHint[];
  // The profile's opted-into RPE scale (#3335), or null when it never opted in.
  // Null is the whole opt-in: there is no scale, so there is no column — not a flag
  // this file remembers to consult (lib/rpe-tracking.ts holds the seam).
  rpeTracking: RpeTracking | null;
  // The session the form is saving (edit row id, or the auto-saved create row
  // once it exists, else null) — always excluded from its own "Recent" list.
  currentActivityId: number | null;
  // The edited session's date in edit mode (else null): drops later sessions.
  editedDate: string | null;
  equipmentList: Equipment[];
  showBodyweightPrompt: boolean;
  bwInput: string;
  bwSaving: boolean;
  onBwInput: (v: string) => void;
  onSaveBodyweight: () => void;
  onUpdatePart: (patch: Partial<PartEntry>) => void;
  // One set, or every set at once — the exercise-level weight (#5371).
  onUpdateSet: (si: number | "all", patch: Partial<SetEntry>) => void;
  onAddSet: () => void;
  onRemoveSet: (si: number) => void;
  onUpdatePartName: (name: string, extra?: Partial<PartEntry>) => void;
  // THE ONE FILL (#5377): a coached next set (bilateral or per-side, #335) or a
  // literal repeat of a prior session (#923). Where the values land is the fill's
  // to decide, not this card's — see `SetFill`.
  onFill: (fill: SetFill) => void;
  // Open the plate builder on a set's weight field. `seed` (a display-unit weight)
  // pre-loads it from the coached suggestion instead of the field's current value —
  // the suggestion → plate deep-link (#335).
  onPlateTarget: (
    si: number | "all",
    field: "weight" | "weightRight",
    seed?: number
  ) => void;
}) {
  const formatPrefs = useFormatPrefs();
  const p = part;
  // Plateau hints dismissed in this session (#923) — an optimistic local hide so the
  // inline hint vanishes on tap while the shared-bus write persists it everywhere else.
  const [dismissedPlateaus, setDismissedPlateaus] = useState<Set<string>>(
    () => new Set()
  );
  // THE COMPACT SET NOTATION (#3336, #3228 item 4): a uniform run of completed sets
  // states itself — "60 kg × 8 × 3" — and the grid is one tap behind it.
  //
  // COMPUTED ONCE, AT MOUNT, AND USER-OWNED AFTERWARDS. That is the whole state
  // machine, and the alternative is worse than it looks: derive "collapsed" from
  // uniformity on every render and a part being TYPED snaps shut under the person's
  // fingers the moment set 3 matches set 2 — the compression would fire exactly when
  // they are least ready for it. So the question "did this part ARRIVE as a finished
  // uniform run" is asked once, on the sets the editor opened with, and every later
  // change to the state belongs to whoever made it.
  //
  // `live` is excluded here as well as at the render below, so finishing a live session
  // leaves the grid the person was checking off exactly where it was.
  //
  // AND THE FOLD BELONGS TO SETS THAT ARRIVED FINISHED, which is why this is TWO
  // pieces of state and not one. A part someone is typing set-by-set becomes uniform
  // the instant set 3 matches set 2 — and if the collapse control appeared then, a new
  // button would materialise in a phone toolbar band mid-entry, which is the same
  // surprise as auto-collapsing and is also a layout the #1612 geometry contract pins.
  // So `arrivedCompact` gates the control: it is the WAY BACK from an expansion, not a
  // fold offered to a part that was never folded.
  const [arrivedCompact] = useState(
    () => !live && partSetsSummary(part, units.weightUnit) != null
  );
  const [collapsed, setCollapsed] = useState(arrivedCompact);
  // Recent attempts as a reference — shown when logging fresh AND while editing
  // (issue #188). The current session is always excluded (`currentActivityId`),
  // so a session never appears in its own "Recent": in create that's the
  // auto-saved row once it exists (the layout fetches one spare session per
  // exercise so three priors still show); in edit it's the row being edited,
  // and `editedDate` also drops any session logged after it so the panel stays
  // "previous".
  // Canonical, variant-collapsed key so a typed variant ("Barbell Curl") finds
  // its merged history keyed under the base (#331).
  const hist = p.name.trim() ? history[exerciseHistoryKey(p.name)] : undefined;
  // …then narrowed to the LOAD CONTEXT actually selected on this part (#1610). Two
  // registry machines serialize as the same exact exercise name, so the merged
  // history alone would show the home machine's 80 kg while the hotel machine is
  // selected. Filtering on the equipment LANE only (not the exact variant) keeps the
  // panel the movement-wide reference #331 made it, while a machine with no history
  // yet correctly shows nothing rather than another machine's ghost. For a profile
  // that owns no strength equipment every session is in the same (unassigned) lane,
  // so this is a no-op.
  const inLane = (s: { equipmentId?: number | null }) =>
    (s.equipmentId ?? null) === (p.equipmentId ?? null);
  const recent = recentSessionsForForm(
    hist?.sessions.filter(inLane),
    currentActivityId,
    isEdit ? editedDate : null
  );
  // Suggested next top set — a forward-looking coaching prompt for logging a
  // fresh set, so it stays create-only. Seeded from every set on the newest
  // prior date (two same-day activities are one session, as in
  // getStrengthByExercise), with the exercise's resolved bodyweight flag and
  // fold base shipped by the server so the two surfaces always agree.
  const past = !isEdit
    ? hist?.sessions.filter((s) => s.activityId !== currentActivityId)
    : undefined;
  // Seed off the prior session of the EXACT variant the user is entering (`p.name`)
  // ON THE SELECTED IMPLEMENT (`p.equipmentId`, #1610) — the merged history (#331)
  // interleaves implements, a per-hand dumbbell load is a different progression from
  // a barbell total (#393), and two registry machines logged under one exact name are
  // different progressions again. A load context with no history seeds NOTHING rather
  // than borrowing another machine's numbers. pickSeedSessions is the same ONE
  // decision getStrengthByExercise's lastSessionBest/lastSessionSets use, so the
  // seed is implement-appropriate identically on both surfaces. Two same-day
  // activities are still one session (as in getStrengthByExercise) — the anchor
  // plus every working set so progression judges the session, not the single
  // best set (#330).
  const seed =
    hist && past?.length
      ? pickSeedSessions(past, p.name, p.equipmentId ?? null)
      : [];
  const seedSets = seed.flatMap((s) => s.sets);
  const seedBase = seed[0]?.baseKg ?? 0;
  // Deload-week shave (#923): a lift that resolves (variant-collapsed via
  // exerciseHistoryKey) to a slot in the active routine gets its next-set LOAD pulled
  // ~10% during the routine's deload week — through the SAME deloadAdjust every deload
  // surface reads, so the form and the Training-overview card can't disagree (#221/#741).
  // A non-routine accessory keeps its normal progression (the cycle is the routine's
  // property, not a profile-wide state), and off a deload week routineKeys is empty.
  const deload =
    deloadContext.isDeloadWeek &&
    p.name.trim() !== "" &&
    deloadContext.routineKeys.includes(exerciseHistoryKey(p.name));
  // Recovering-injury temper (#1144): a lift whose coarse region (regionForExercise, the
  // SAME resolver the Analyze panel keys on) is returning from a RECOVERING injury (#838)
  // gets its next-set LOAD backed off to RECOVERING_LOAD_FACTOR — carried into the ONE
  // shared contextualNextSet below alongside the deload flag, so the form composes deload
  // AND the injury temper identically to the server-resolved surfaces (#221/#1115). Off a
  // recovering injury temperedRegions is empty, so a normal lift is byte-for-byte prior.
  // #2024: resolved through the SHARED per-exercise verdict over the constraints the
  // layout serialized, so a constraint declared at exercise or movement level tempers
  // exactly the lift the user named — and their own declared load preference wins over
  // the app's fallback fraction. Off any recovering constraint the verdict is "clear",
  // so a normal lift is byte-for-byte prior.
  // #3244 threads live niggles through the card's shared resolver too, preserving its
  // weaker factor and niggle-specific rationale rather than inventing an injury.
  const trainingTemper =
    p.name.trim() !== ""
      ? resolveTrainingTemper(
          exerciseInjuryVerdict(recoveringContext.constraints, p.name),
          recoveringContext.niggleTempers ?? [],
          p.name
        )
      : null;
  // Build a next-set suggestion from a set list (one shared computation, so a
  // per-side left/right suggestion progresses each side by the SAME rule as the
  // bilateral one — #335). A weighted lift whose newest session carries only
  // weightless sets (possible via imports) has no load to progress from.
  const buildSuggestion = (
    sets: Parameters<typeof sessionBestSet>[0]
  ): NextSet | null => {
    if (!hist) return null;
    // The SIGN of the fold, from the movement's load kind (#1922): an assisted
    // lift's logged weight is a counterweight, so it subtracts. suggestNextSet
    // declines assisted lifts outright, but the seed is folded honestly here so
    // the anchor this reads can never be an inverted load.
    const seedLoadKind = loadKindOf(p.name);
    const best = sessionBestSet(sets, seedBase, seedLoadKind);
    if (!(best && (hist.bodyweight || best.weightKg > 0))) return null;
    const base = suggestNextSet(
      {
        exercise: p.name,
        bodyweight: hist.bodyweight,
        lastSessionBest: best,
        lastSessionSets: sessionWorkSets(sets, seedBase, seedLoadKind),
      },
      units.weightUnit
    );
    // Replace the raw progression with the context-adjusted load — carried by the Use
    // button, the set-1 ghost PLACEHOLDERS and the plate-builder seed alike, since they
    // all read this one `suggestion`. The ghost is an offer and the Use tap is the only
    // write; the `onFocus` fill #335 once had is gone (see the ghost comment below).
    // Routes through the ONE shared contextualNextSet
    // (#1115 Fix B) so the form composes BOTH the deload-week shave (#741, for a routine
    // lift) AND the recovering-injury temper (#838, for a lift whose region is recovering)
    // identically to the server-resolved surfaces (coaching card, Training-overview session
    // card, Analyze/detail panel) — the live logger and its Analyze deep-link target can't
    // disagree on either axis (#221/#923/#1144). Both flags are false off a deload week /
    // recovering injury, so an ordinary lift is byte-for-byte the prior progression.
    return contextualNextSet(base, p.name, {
      deloadWeek: deload,
      recoveringRegion: trainingTemper?.recoveringRegion,
      recoveringFactor: trainingTemper?.factor ?? RECOVERING_LOAD_FACTOR,
      temperRationale: trainingTemper?.rationale,
    });
  };
  // HOW MANY SETS THE PLAN STATES (#5373). The suggestion says what one set is; the
  // seed session says how many — its own working rows, which is what "I intend to do
  // those exact reps" means in practice. Warmups are not part of the prescription
  // (#338), and a row that logged no reps on either side was never a set. A lift with
  // no history plans nothing and keeps its one empty row.
  const plannedSetCount = seedSets.filter(
    (s) => !s.warmup && (s.reps != null || s.reps_right != null)
  ).length;
  // Bilateral parts get one suggestion; per-side parts get an independent
  // suggestion per side (#335) — sessionBestSet already treats each side as its
  // own candidate, so seeding both from the stronger side would over-load the
  // weaker one.
  const suggestion =
    !p.perSide && seedSets.length ? buildSuggestion(seedSets) : null;
  const suggestionLeft =
    p.perSide && seedSets.length
      ? buildSuggestion(sideSets(seedSets, "left"))
      : null;
  const suggestionRight =
    p.perSide && seedSets.length
      ? buildSuggestion(sideSets(seedSets, "right"))
      : null;
  // The active plateau finding for this lift, if any (#923) — matched by the canonical
  // exerciseHistoryKey so a typed variant finds its merged plateau, AND by the load
  // context selected on the part (#1610) so the home machine's stall isn't reported
  // against the hotel machine. It yields to the deload rationale on a deload week (the
  // plateau→deload cross-link already de-dupes this advice at the findings layer,
  // lib/rule-findings), and to an in-session dismissal.
  const plateauHint =
    p.name.trim() !== ""
      ? (plateauHints.find(
          (h) =>
            h.exerciseKey === exerciseHistoryKey(p.name) &&
            (h.equipmentId ?? null) === (p.equipmentId ?? null)
        ) ?? null)
      : null;
  const showPlateauHint =
    plateauHint != null &&
    !deload &&
    !dismissedPlateaus.has(plateauHint.dedupeKey);
  function dismissPlateau(dedupeKey: string) {
    // Optimistic local hide, then persist through the SAME action + dedupeKey the
    // Training-watch card uses (#435/#436) — so a dismissal here silences the plateau on
    // Training → Overview + the dashboard rollup too, and a dismissal there silences this.
    setDismissedPlateaus((prev) => new Set(prev).add(dedupeKey));
    const fd = new FormData();
    fd.set("dedupe_key", dedupeKey);
    void dismissTrainingObservation(fd);
  }
  const timed = isTimed(p.name);
  // A "content" fault means no set counts yet: flag the effort input (reps or
  // hold), and the weight too where a set needs one (not bodyweight/timed).
  const needsSet = fault === "content";
  const weightBlocked = needsSet && !isBodyweight(p.name) && !timed;
  // Which of a side's inputs to flag: all of them while the part has no
  // content at all ("content" fault), or just the missing half of a set
  // someone started ("set" fault — that side blocks auto-save).
  const sideFlags = (w: string, r: string, d: string) => {
    const partial = fault === "set" && sidePartial(p.name, w, r, d);
    return {
      weight: weightBlocked || (partial && !w.trim()),
      effort: needsSet || (partial && (timed ? !d.trim() : !r.trim())),
    };
  };
  // A further set copies the last one the person CONFIRMED (#5373) — until one
  // exists the rows already state the plan, and there is nothing to add to.
  const lastDone = [...p.sets].reverse().find(setDone) ?? null;
  const canAddSet = !!lastDone && setComplete(p.name, lastDone, p.perSide);
  const total = partTotal(p);
  // The sentence this part's sets read as, or null when they are not a uniform run and
  // must stay a grid (lib/activity-form-model). Null is the rule, not a hint: with no
  // sentence there is nothing to render in place of the rows, so "a non-uniform part
  // never collapses" cannot be forgotten here.
  const setsSentence = live ? null : partSetsSummary(p, units.weightUnit);
  // The rating range beside it (#3335/#743), when the profile tracks RPE and anything is
  // logged. Rendered from the SAME rpeSummaryText the Recent panel uses, so a run of
  // identical sets that differed only in effort still says so once compressed.
  const setsRpe = rpeTracking ? rpeSummaryText(p.sets) : null;
  const showGrid = !(collapsed && setsSentence);
  // A pristine part: no set of it has been confirmed, so every row it holds is still
  // the PLAN (#5373 widens #335's set-1 offer to the whole prescription). Confirming
  // or correcting any row ends it, and the untouched-part gates that protect entry in
  // progress from fills read this.
  //
  // The ghost is an OFFER, never a write. #335 originally also applied the
  // suggestion from the fields' `onFocus` — "no Use tap needed" — and #1971
  // measured what that costs: arriving in set 1's weight field writes 77.5 into
  // it, and the digits the person then types land ON TOP of a value they never
  // asked for. Tab in and type "60" → "77.560"; click in and type "60" →
  // "77.605" (the caret sits wherever the click landed). Deterministic at every
  // typing speed and at 6x CPU throttle — not a race. Focus is ARRIVAL, not
  // intent, and this repo's rule is that context gates an offer but the user's
  // tap is the write. The tap is the Next-set card's "Use" button below.
  const partUntouched = !p.sets.some(setDone);
  // Live version of the training log card's missed-target marker, judged by the
  // same shared rule the saved data will be (completed sets only).
  const intent = partIntent(p);
  const targetStatus = judgeTargets(
    doneSets(p)
      .filter((s) => setComplete(p.name, s, false))
      .map((s) => ({
        reps: Number(s.reps),
        target_reps: intent.target,
        to_failure: intent.toFailure ? 1 : 0,
        warmup: s.warmup ? 1 : 0,
      }))
  );
  // A coached next set stated as a STORED set, so the fill runs it through the same
  // kg → display-unit mapping the "repeat last session" path uses and the two can
  // never round apart (#5377). Sides are independent (#335): a side with no
  // suggestion contributes nothing, which is what its blank fields mean.
  const coachedSet = (
    left: NextSet | null,
    right: NextSet | null
  ): RepeatSourceSet => ({
    set_number: 1,
    weight_kg: left && !left.bodyweight ? left.weightKg : null,
    reps: left ? left.reps : null,
    weight_kg_right: right && !right.bodyweight ? right.weightKg : null,
    reps_right: right ? right.reps : null,
    duration_sec: null,
    duration_sec_right: null,
    warmup: null,
  });
  // THE PRESCRIPTION, AS ROWS (#5373). One planned row per set the plan states,
  // carrying the SAME coached numbers the one-set ghost used to paint and `done:
  // false` — so the grid shows the whole prescription as the offer it is, the payload
  // passes over every row of it, and confirming one is a flag flip rather than a
  // second write path. Minted through `repeatSessionFill`, the one kg → display-unit
  // mapping every fill shares (#5377), so a ghost can never round differently from
  // the Use tap that writes the same set.
  const plannedRows = (): SetEntry[] | null => {
    const left = p.perSide ? suggestionLeft : suggestion;
    const right = p.perSide ? suggestionRight : null;
    if ((!left && !right) || plannedSetCount < 1) return null;
    const row = coachedSet(left, right);
    return repeatSessionFill(
      Array.from({ length: plannedSetCount }, (_, i) => ({
        ...row,
        set_number: i + 1,
      })),
      units.weightUnit
    ).sets.map(asPlan);
  };
  // What a fresh part inherits from the plan, seeded ONCE per exercise: the rows
  // above, and the rep target the scheme declares (#335) so a fixed-scheme lifter
  // (5×5) doesn't retype it. Guarded by the last-seeded name so clearing either
  // doesn't re-seed it, and gated on `partUntouched` so it never overrides a session
  // already in progress — a person who has confirmed a set owns their grid.
  const seededTargetFor = useRef<string | null>(null);
  useEffect(() => {
    const name = p.name.trim();
    if (seededTargetFor.current === name) return;
    seededTargetFor.current = name;
    if (!partUntouched) return;
    const patch: Partial<PartEntry> = {};
    if (
      suggestion?.targetReps != null &&
      !isTimed(p.name) &&
      !p.perSide &&
      !p.targetReps.trim() &&
      !p.toFailure
    )
      patch.targetReps = String(suggestion.targetReps);
    const rows = plannedRows();
    if (rows) patch.sets = rows;
    if (Object.keys(patch).length) onUpdatePart(patch);
    // Re-run only when the exercise changes; the ref prevents mid-session re-seeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.name]);
  // Plate builder applies to barbells: a user-defined barbell implement, or any
  // barbell lift (the "Barbell" variant chip, or plain lifts like Back Squat).
  const selectedEq = equipmentList.find((e) => e.id === p.equipmentId);
  const showPlate = isBarbell(selectedEq?.category) || isBarbellLift(p.name);
  // Increment steppers (issue #337). The weight step is lift-appropriate and
  // plate-loadable — the SAME weightIncrementKg/Lb the next-set suggestion adds
  // (5 kg squat vs 2.5 kg accessory), in the user's display unit; each row steps
  // its own side by it.
  const weightStep =
    units.weightUnit === "lb"
      ? weightIncrementLb(p.name)
      : weightIncrementKg(p.name);
  // ONE LOAD FOR THE WHOLE GRID (#5371). Straight sets decide the weight once and
  // vary the reps, so while every set carries the same load (both sides of it, for a
  // per-side lift) the grid states that load once, above the rows, and the rows are
  // reps only. The stored shape is untouched — every set still carries its own
  // weight, and the band writes all of them — this is how the common case RENDERS.
  // Only a lift that steps its load: bodyweight and timed lifts have no stepper to
  // share.
  //
  // AND EXPANSION LATCHES. Derive "shared" from uniformity alone and a grid someone
  // varied on purpose would snap back to one band the moment set 2 was typed back to
  // set 1's number — the fold-under-the-fingers #3336 refused. So once the sets
  // differ (a "Vary" tap, a mixed Recent fill, a stored session that arrived varied)
  // this part stays per-set. The latch is the PART's (`p.varied`, client-only, never
  // saved), not this editor's: ActivityPartsList keys the editors by slot, and a
  // latch held here would stay in the slot when the exercise above was removed or
  // moved, unfolding the next exercise with nothing typed. The Vary tap writes it
  // here; the seed and the fills write it where they write the sets (`latchVaried`),
  // so an untouched form's signature never moves. `sharesLoad` stays in the render
  // so a part that arrives without the latch still shows the loads it has.
  const stepsLoad = !timed && !isBodyweight(p.name);
  // A part with no rows yet has no load to state.
  const sharedLoad =
    stepsLoad && !p.varied && sharesLoad(p) && p.sets.length > 0;
  // Which set's "Vary" tap just revealed the per-set weights, so that set's weight
  // takes the caret; consumed by the input on mount.
  const varyFocus = useRef<number | null>(null);
  const vary = (si: number) => {
    varyFocus.current = si;
    onUpdatePart({ varied: true });
  };
  const loadRef = (si: number) => (el: HTMLInputElement | null) => {
    if (el && varyFocus.current === si) {
      varyFocus.current = null;
      el.focus();
    }
  };
  // Set 1's reps input per side: Enter in the exercise-level weight lands there.
  const firstReps = useRef<Record<RowSide, HTMLInputElement | null>>({
    both: null,
    left: null,
    right: null,
  });
  const badDuration =
    timed &&
    p.sets.some(
      (s) =>
        (!!s.duration.trim() && !isValidDuration(s.duration)) ||
        (p.perSide &&
          !!s.durationRight.trim() &&
          !isValidDuration(s.durationRight))
    );
  // Inline plateau hint (#923): a calm one-liner when this lift has an active
  // (undismissed) plateau finding, at the point of load selection. Reuses the SAME
  // plateau computation/dedupeKey as the Training-watch card — dismissing it here
  // silences that surface too (and vice versa). Never blocks the fill paths; yields
  // to the deload rationale on a deload week.
  // ONE DEFINITION, TWO MOUNTS, and they are mutually exclusive: #5370 folds the note
  // in behind the history line, and a lift with no recent session has no fold for it
  // to go behind.
  const plateauNote =
    showPlateauHint && plateauHint ? (
      <div
        data-testid="plateau-hint"
        className="mt-2 flex items-start justify-between gap-2 rounded-md border border-black/10 bg-slate-50/70 px-2.5 py-1.5 text-xs dark:border-white/10 dark:bg-ink-850/40"
      >
        <span className="flex items-start gap-1.5 text-slate-600 dark:text-slate-300">
          <IconTrendingDown className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          {/* The SHARED plateau-break advice (#1203): the ~10% deload magnitude
              + named variations, phrased identically to the finding/next-set
              surfaces, pre-rendered by the one-computation helper. */}
          <span>{plateauHint.hintText}</span>
        </span>
        <IconButton
          type="button"
          onClick={() => dismissPlateau(plateauHint.dedupeKey)}
          data-testid="plateau-hint-dismiss"
          label="Dismiss plateau hint"
        >
          <IconX className="h-3.5 w-3.5" stroke={2} />
        </IconButton>
      </div>
    ) : null;
  return (
    <>
      {/* The "How to" affordance for this lift (#734) now rides in the part
          header's action toolbar (ActivityPartsList), which also owns the
          overlay state — it used to consume a mostly empty right-aligned row of
          its own here, which is exactly the row a phone could least afford
          (#1613). */}
      {showBodyweightPrompt && (
        <div className="mt-2 rounded-md border border-brand-200 bg-brand-50 px-2.5 py-2 text-xs dark:border-brand-900 dark:bg-brand-950/40">
          <div className="font-medium text-slate-600 dark:text-slate-300">
            Add your bodyweight to track volume &amp; strength for bodyweight
            moves.
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="number"
              min="1"
              step="any"
              value={bwInput}
              onChange={(e) => onBwInput(e.target.value)}
              placeholder={`Bodyweight (${units.weightUnit})`}
              className="input"
            />
            <button
              type="button"
              onClick={onSaveBodyweight}
              disabled={bwSaving || !(Number(bwInput) > 0)}
              className="btn shrink-0"
            >
              {bwSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
      <ExerciseHistory
        sessions={recent}
        fillable={partUntouched}
        onFill={(sets) => onFill({ source: "session", sets })}
        unit={units.weightUnit}
        note={plateauNote}
      />
      {/* The coached next set (same progression as the exercise detail
          panel's card) with a one-tap fill, so the suggestion can be acted
          on right where sets are logged. For a fresh bilateral part it's also
          shown as ghost placeholders on set 1 (#335) — this card keeps the
          rationale and the explicit Use / plate actions. */}
      {suggestion && (
        <div
          data-testid="next-set-card"
          className="mt-2 rounded-md border border-brand-200 bg-brand-50/60 px-2.5 py-1.5 text-xs dark:border-brand-900 dark:bg-brand-950/40"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-brand-600 dark:text-brand-400">
              Next set
            </span>
            <span className="flex items-center gap-2.5">
              <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                {nextSetText(suggestion, units.weightUnit)}
              </span>
              <button
                type="button"
                onClick={() =>
                  onFill({
                    source: "coached",
                    set: coachedSet(suggestion, null),
                    targetReps: suggestion.targetReps,
                  })
                }
                className="rounded-md border border-brand-300 px-2 py-0.5 font-medium text-brand-600 transition hover:bg-brand-500 hover:text-white dark:border-brand-800 dark:text-brand-400 dark:hover:bg-brand-600 dark:hover:text-white"
              >
                Use
              </button>
              {/* Barbell lifts: jump straight into the plate builder seeded with
                  the suggested load, landing it in set 1's weight (#335). */}
              {showPlate &&
                !suggestion.bodyweight &&
                suggestion.weightKg > 0 && (
                  <IconButton
                    type="button"
                    onClick={() =>
                      onPlateTarget(
                        Math.max(0, p.sets.length - 1),
                        "weight",
                        dispWeight(suggestion.weightKg, units.weightUnit, 1)
                      )
                    }
                    label="Load these plates on the bar"
                  >
                    <IconBarbell className="h-3.5 w-3.5" />
                  </IconButton>
                )}
            </span>
          </div>
          <p className="mt-0.5 text-slate-500 dark:text-slate-400">
            {suggestion.rationale}
          </p>
        </div>
      )}
      {/* Per-side parts get an independent suggestion per side (#335): each side
          progresses off its own history, so a stronger side never over-loads the
          weaker one. One Use fills set 1 with both sides. */}
      {p.perSide && (suggestionLeft || suggestionRight) && (
        <div className="mt-2 rounded-md border border-brand-200 bg-brand-50/60 px-2.5 py-1.5 text-xs dark:border-brand-900 dark:bg-brand-950/40">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-brand-600 dark:text-brand-400">
              Next set
            </span>
            <span className="flex items-center gap-2.5">
              <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                {suggestionLeft
                  ? `L ${nextSetText(suggestionLeft, units.weightUnit)}`
                  : "L —"}
                {" · "}
                {suggestionRight
                  ? `R ${nextSetText(suggestionRight, units.weightUnit)}`
                  : "R —"}
              </span>
              <button
                type="button"
                onClick={() =>
                  onFill({
                    source: "coached",
                    set: coachedSet(suggestionLeft, suggestionRight),
                    // Per-side parts declare no rep target (partIntent does not
                    // apply to them), so a per-side fill carries none.
                    targetReps: null,
                  })
                }
                className="rounded-md border border-brand-300 px-2 py-0.5 font-medium text-brand-600 transition hover:bg-brand-500 hover:text-white dark:border-brand-800 dark:text-brand-400 dark:hover:bg-brand-600 dark:hover:text-white"
              >
                Use
              </button>
            </span>
          </div>
          <p className="mt-0.5 text-slate-500 dark:text-slate-400">
            {(suggestionLeft ?? suggestionRight)!.rationale}
          </p>
        </div>
      )}
      {/* With no history to fold it into, the note is the block's only reference and
          stays where it always was. */}
      {recent.length === 0 && plateauNote}
      {/* THE COMPACT SET NOTATION (#3336). A uniform run of completed sets reads as the
          statement it already is on every other surface — the Recent panel, the training
          log card, the timeline — instead of as N identical rows of four controls each.
          A three-exercise session of 3×3 rendered nine of those rows; this is #3228's
          fourth move.

          THE CHIP IS THE DISCLOSURE, mounted from the shared facts primitive
          (#3218/#3299) so the grammar cannot fork: a button with `aria-expanded`, not a
          label beside an invisible control.

          WHAT IS BEHIND IT IS THE GRID ITSELF, not a FactEditorHost panel, and that is
          deliberate. #3218's preconditions exclude a surface whose fields are free
          numeric entry (the measurements form is its recorded counter-case), and #3228
          invokes that same workbench exclusion by name for this grid and for live mode.
          The host's contract is "at most one editor on screen"; a set grid that is on
          screen for most of a strength session is not that, and the host also takes
          focus when it mounts — which would pull the caret out of a weight field the
          moment a part's last set matched its neighbours.

          (An earlier draft of this note also cited #3409 — the escape-layer marker being
          unconditional. #3417 has since made the marker follow whether an editor is
          actually open, so that particular cost is gone. The reason above is the one
          that stands on its own, which is why the retracted half is recorded rather than
          quietly dropped.)

          THE TAP TRADE, recorded here rather than in a census baseline. Folding a
          finished run costs ONE TAP to reach a set you did want to edit, and the UX
          census counts that tap (#1510's discipline). It is bought deliberately: the
          same fold removes nine rows of four controls each from a three-exercise
          session, and the overwhelmingly common thing to do with a finished uniform run
          is READ it. #3390's committed baseline now lives at
          scripts/census-chrome-baseline.json, but it records rendered geometry, not tap
          counts. This tap annotation therefore stays at the point of contact.

          COLLAPSE IS DISPLAY ONLY. The sets stay in `parts` state the whole time, and
          `buildActivityPayload` composes the save from that state — never from mounted
          inputs — so a set behind a closed summary still posts whole (#2359, #2014).
          e2e/compact-set-notation.spec.ts pins that through a real save. */}
      {!showGrid && setsSentence && (
        <FactChipRow testId="set-summary-row" className="mt-2">
          <FactChip
            label={
              <>
                <span className="sr-only">Sets: </span>
                {setsSentence}
                {setsRpe && (
                  <span className="text-slate-500 dark:text-slate-400">
                    {" · "}
                    {setsRpe}
                  </span>
                )}
              </>
            }
            focusKey="sets"
            expanded={false}
            onOpen={() => setCollapsed(false)}
            testId="set-summary"
          />
        </FactChipRow>
      )}
      {showGrid && (
        <>
          {sharedLoad && (
            <div
              data-testid="exercise-weight"
              className="mt-2 flex items-center gap-2"
            >
              <span className="shrink-0 text-xs font-medium whitespace-nowrap text-slate-500 dark:text-slate-400">
                Weight ({units.weightUnit})
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                {(p.perSide ? PER_SIDE : BILATERAL).map((side) => (
                  <div key={side} className="flex items-center gap-2">
                    {sideLabel(side)}
                    <LoadField
                      side={side}
                      set={p.sets[0]}
                      exercise={p.name}
                      unit={units.weightUnit}
                      weightStep={weightStep}
                      showPlate={showPlate}
                      ids={p.perSide ? null : rowIds(0)}
                      plan={p.sets[0].plan}
                      blocked={p.sets.some(
                        (s) =>
                          sideFlags(
                            s[SIDE[side].weight],
                            s[SIDE[side].reps],
                            s[SIDE[side].duration]
                          ).weight
                      )}
                      onChange={(patch) => onUpdateSet("all", patch)}
                      onPlateTarget={(field) => onPlateTarget("all", field)}
                      onEnter={() => firstReps.current[side]?.focus()}
                    />
                    {/* The rows' "Vary" slot, reserved here too: the band's stepper
                        ends where the reps steppers under it end, and the plate
                        door's target (which overhangs its 28px slot) stays inside
                        the band's own box. */}
                    <span className="w-12 shrink-0" aria-hidden />
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* On phones, keep the set schema immediately below the sticky exercise
          picker while long sessions scroll. Desktop has room to keep the whole
          editor context visible, so the row returns to normal flow there.
          `--set-schema-top` is published by the part container (ActivityPartsList),
          because the phone header is one row taller when it carries an action
          toolbar (#1613) and this row has to clear it. That height is exactly what
          `--top-edge-offset` means — how much of the top edge the strip ABOVE has
          already claimed — so it is handed to `top-edge-safe` (app/globals.css) as
          that offset and the status-bar inset lands on top of it (#4515). The two
          compose; neither restates the other's arithmetic.

          Below `sm` the row shows ONLY the value schema — `Weight (unit) × Reps`,
          aligned to the steppers under it (#1612). The `Set` / `Options` headings
          are desktop table furniture: on a phone each set states its own identity
          in its toolbar row, so repeating them here only bought a second detached
          band of headings. */}
          <div
            data-testid="set-column-headings"
            className="sticky top-edge-safe [--top-edge-offset:var(--set-schema-top)] z-9 -mx-1 mt-2 flex items-center gap-2 bg-surface/95 px-1 py-1 section-label backdrop-blur-sm md:static md:mx-0 md:bg-transparent md:px-0 md:backdrop-blur-none dark:md:bg-transparent"
          >
            <span className="hidden w-12 shrink-0 sm:block">Set</span>
            {stepsLoad ? (
              <div className="flex min-w-0 flex-1 basis-0 items-center gap-2 text-center">
                {p.perSide && <span className="w-4 shrink-0" aria-hidden />}
                {!sharedLoad && (
                  <>
                    <span
                      data-testid="weight-column-heading"
                      className="min-w-28 flex-1 basis-0"
                    >
                      Weight ({units.weightUnit})
                    </span>
                    {showPlate && <span className="w-7 shrink-0" aria-hidden />}
                    <span className="w-2 shrink-0" aria-hidden>
                      ×
                    </span>
                  </>
                )}
                <span
                  data-testid="reps-column-heading"
                  className="min-w-28 flex-1 basis-0"
                >
                  Reps
                </span>
                {/* The rows' "Vary" slot, so the heading centres over the stepper. */}
                {sharedLoad && <span className="w-12 shrink-0" aria-hidden />}
              </div>
            ) : (
              <span className="flex-1 basis-0 text-center">
                {timed ? "Hold time" : "Reps"}
              </span>
            )}
            <span className="hidden w-16 shrink-0 text-right sm:block">
              Options
            </span>
          </div>
          <div className="mt-2 space-y-2">
            {p.sets.map((s, si) => (
              // TWO ROWS BELOW `sm`, one table row from `sm` up (#1612). The wrap
              // ordering is unchanged — identity + options on the first line, the
              // values `order-last basis-full` on the second — but the options
              // container is a horizontal toolbar on a phone instead of a 64px
              // two-line column, so the first line reads as ONE compact band
              // ("Set 3 … RPE W ×") tied to the values directly under it, rather
              // than the three disconnected bands #1450's wrap left behind.
              <div
                key={si}
                data-testid={`set-row-${si + 1}`}
                className="flex flex-wrap items-start gap-x-2 gap-y-1 sm:flex-nowrap sm:gap-2"
              >
                <span
                  data-testid={`set-label-${si + 1}`}
                  className="w-12 shrink-0 self-center text-xs font-medium text-slate-500 sm:self-start sm:pt-2 dark:text-slate-400"
                >
                  Set {si + 1}
                </span>
                {/* ONE ROW SHAPE (#5377). A per-side part stacks two of them inside
                    the values column, L then R (#335); a bilateral part IS one of
                    them. Everything the two used to spell twice — the stepper pair,
                    the plate door, the stuck-change flags, the `sm:` geometry — lives
                    in SetRow now, so a change to how a set is entered is made once. */}
                {p.perSide ? (
                  <div
                    data-testid={`set-values-${si + 1}`}
                    className="order-last basis-full flex-1 space-y-1.5 sm:order-0 sm:basis-0"
                  >
                    {PER_SIDE.map((rowSide) => (
                      <SetRow
                        key={rowSide}
                        side={rowSide}
                        className="flex items-center gap-2"
                        set={s}
                        exercise={p.name}
                        unit={units.weightUnit}
                        weightStep={weightStep}
                        showPlate={showPlate}
                        flagsFor={sideFlags}
                        load={sharedLoad ? "shared" : "own"}
                        loadRef={rowSide === "left" ? loadRef(si) : undefined}
                        repsRef={
                          si === 0
                            ? (el) => (firstReps.current[rowSide] = el)
                            : undefined
                        }
                        onChange={(patch) => onUpdateSet(si, patch)}
                        onPlateTarget={(field) => onPlateTarget(si, field)}
                        onEnter={canAddSet ? onAddSet : undefined}
                        onVary={
                          sharedLoad && rowSide === "right"
                            ? () => vary(si)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <SetRow
                    side="both"
                    testId={`set-values-${si + 1}`}
                    className="order-last flex min-w-0 flex-1 basis-full items-center gap-2 sm:order-0 sm:basis-0"
                    ids={rowIds(si)}
                    set={s}
                    exercise={p.name}
                    unit={units.weightUnit}
                    weightStep={weightStep}
                    showPlate={showPlate}
                    flagsFor={sideFlags}
                    load={sharedLoad ? "shared" : "own"}
                    loadRef={loadRef(si)}
                    repsRef={
                      si === 0
                        ? (el) => (firstReps.current.both = el)
                        : undefined
                    }
                    onChange={(patch) => onUpdateSet(si, patch)}
                    onPlateTarget={(field) => onPlateTarget(si, field)}
                    onEnter={canAddSet ? onAddSet : undefined}
                    onVary={sharedLoad ? () => vary(si) : undefined}
                  />
                )}
                <div
                  data-testid={`set-options-${si + 1}`}
                  className="ml-auto flex shrink-0 items-center gap-1 sm:ml-0 sm:w-16 sm:flex-col sm:items-end"
                >
                  {/* Optional per-set RPE selector (#743) — shown for rep-based sets
                (a timed hold's effort is its duration) belonging to a profile
                that OPTED IN (#3335). `rpeTracking` is not a flag being consulted
                here: it is the scale the stepper steps over, and without it
                RpeStepper has no argument to render, so the column cannot appear
                for a profile that never asked. Blank by default; the rating rides
                onto the set without replacing target reps. Stacked INSIDE the same
                w-16 options column the row always had — widening this column
                shrinks the weight/reps inputs below their pinned #337 tap-target
                width (see RpeStepper's sizing note). Below `sm` the column unrolls
                into one horizontal band on the set's toolbar row (#1612), where
                there is room for full-size targets.

                NO TAB STOP EITHER WAY. Both stepper buttons are tabIndex={-1}
                (the values are the tab stops; the steppers are pointer sugar), so
                a row's keyboard sequence is IDENTICAL with the column on and off —
                which is what keeps a conditional column from stranding tab order.
                e2e/rpe-logging.spec.ts asserts that equality directly. */}
                  {!timed && rpeTracking && (
                    <RpeStepper
                      tracking={rpeTracking}
                      value={s.rpe}
                      onChange={(v) => onUpdateSet(si, { rpe: v })}
                      testId={si === 0 ? "set1-rpe" : undefined}
                    />
                  )}
                  {/* CONFIRM THIS SET (#5373). The row is the plan until this is
                tapped: it turns the ghost's numbers into the record and, in live
                mode, starts the rest timer exactly as checking a set off always did
                (#340). It is the same gesture as correcting the reps, so it goes
                away the moment either happens — a confirmed row has nothing left to
                confirm.

                MOUNTS IconButton, whose own box is the 34px `--control-box` the
                options column's controls share (#3938); the geometry is the
                primitive's, not restated here.

                A LINE OF THE OPTIONS COLUMN, NOT A THIRD CONTROL ON THE W/✕ ONE.
                That line is already full: `sm:w-7` + `sm:w-8` + the gap is the
                column's whole 64px, which is pinned because widening it shrinks the
                weight/reps inputs below their #337 tap-target width. A 34px button
                added beside W overflowed LEFT over the row's own "Vary" control and
                swallowed its taps — measured: the entry-ergonomics Vary click could
                not land. Stacked here it is beside W on a phone, where the column
                unrolls into one horizontal toolbar band (#1612), and above it on
                desktop, where the column is a column. */}
                  {!setDone(s) && (
                    <IconButton
                      tone="brand"
                      onClick={() => onUpdateSet(si, confirmSet(s))}
                      label={`Confirm set ${si + 1}`}
                      data-testid={`set-confirm-${si + 1}`}
                    >
                      <IconCheck className="h-4 w-4" stroke={2.5} />
                    </IconButton>
                  )}
                  <div className="flex items-center justify-end gap-1 sm:items-start">
                    {/* Warmup toggle (#338): a light per-set "W" — a warmup is excluded
                from the part's volume total and target markers. One toggle per
                set (both sides of a per-side set share it).

                A TAB STOP SINCE #4511, where it was `tabIndex={-1}`. It is not
                pointer sugar the way the RPE steppers above are: those step a
                value whose own field is the tab stop, so skipping them takes
                nothing away, while this carries `aria-pressed` and is the ONLY
                way to say a set was a warmup. A toggle that holds state a
                keyboard cannot reach is not a control. The bare "W" now says
                what it does on hover and on keyboard focus. */}
                    <ControlTooltip
                      label={s.warmup ? "Unmark warmup set" : "Mark warmup set"}
                    >
                      {(anchor) => (
                        <button
                          {...anchor}
                          type="button"
                          onClick={() => onUpdateSet(si, { warmup: !s.warmup })}
                          aria-pressed={s.warmup}
                          data-testid={si === 0 ? "set1-warmup" : undefined}
                          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded text-xs font-bold sm:mt-1 sm:h-8 sm:w-7 ${
                            s.warmup
                              ? "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
                              : "text-slate-300 hover:bg-slate-100 hover:text-slate-500 dark:text-slate-600 dark:hover:bg-ink-800"
                          }`}
                        >
                          W
                        </button>
                      )}
                    </ControlTooltip>
                    {p.sets.length > 1 && (
                      <ControlTooltip label="Remove set">
                        {(anchor) => (
                          <button
                            {...anchor}
                            type="button"
                            onClick={() => onRemoveSet(si)}
                            data-testid={`set-remove-${si + 1}`}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-rose-400 hover:bg-rose-50 hover:text-rose-600 sm:mt-1 sm:h-8 sm:w-8 dark:text-rose-500/80 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                          >
                            <IconX className="h-4 w-4" />
                          </button>
                        )}
                      </ControlTooltip>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* THE WAY BACK TO THE SENTENCE, and it is rendered exactly when there IS one to
            go back to. A part edited into a varying run loses this control rather than
            offering a collapse that would have to lie about "8, 8, 7"; a part edited
            back into a uniform run gets it again.

            NOT LABELLED "Done": the overlay's own close button is `Done`, and three
            specs already address it by that exact name.

            Only on a part that ARRIVED as a sentence — see `arrivedCompact` above. */}
        {arrivedCompact && showGrid && setsSentence ? (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            data-testid="set-summary-collapse"
            className="-mx-2 -my-2 px-2 py-2 text-xs font-medium text-slate-500 hover:underline dark:text-slate-400"
          >
            Collapse sets
          </button>
        ) : null}
        {showGrid && (
          <button
            type="button"
            onClick={() => onAddSet()}
            disabled={!canAddSet}
            className={`-mx-2 -my-2 px-2 py-2 text-xs font-medium ${
              canAddSet
                ? "text-link"
                : "cursor-not-allowed text-slate-300 dark:text-slate-600"
            }`}
          >
            + Add set
          </button>
        )}
        {!canAddSet && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {timed
              ? "Enter a hold time first."
              : isBodyweight(p.name)
                ? "Enter reps first."
                : "Enter weight and reps first."}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
          {targetStatus && (
            <span
              data-testid="activity-target-status"
              className={`flex items-center gap-1 text-xs font-medium ${
                targetStatus === "missed"
                  ? "text-amber-500 dark:text-amber-400"
                  : "text-brand-600 dark:text-brand-400"
              }`}
            >
              {targetStatus === "missed" ? (
                <IconAlertTriangle className="h-3.5 w-3.5" stroke={2} />
              ) : (
                <IconCheck className="h-3.5 w-3.5" stroke={2.5} />
              )}
              {targetStatus === "missed" ? "Below target" : "Target met"}
            </span>
          )}
          {total > 0 && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Total: {total.toLocaleString("en-US")} {units.weightUnit}
            </span>
          )}
        </span>
      </div>
      {showGrid && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Warmup sets do not count toward volume or target markers.
        </p>
      )}
      {badDuration && (
        <p className="mt-1 text-xs text-rose-500 dark:text-rose-400">
          Enter hold time as m:ss (e.g. 1:30) or seconds (e.g. 90).
        </p>
      )}
    </>
  );
}
