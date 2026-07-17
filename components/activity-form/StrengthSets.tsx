"use client";

import { useEffect, useRef, useState } from "react";
import type { Equipment } from "@/lib/types";
import { isBarbell } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import type { ExerciseHistoryMap } from "@/lib/queries";
import {
  isUnilateral,
  isTimed,
  isBodyweight,
  isBarbellLift,
  variantOf,
  composeVariant,
  defaultEquipment,
  exerciseHistoryKey,
} from "@/lib/lifts";
import { isValidDuration } from "@/lib/duration";
import { formatLongDate } from "@/lib/format-date";
import {
  judgeTargets,
  summarizeExercise,
  SET_STATUS_TITLES,
} from "@/lib/journal-format";
import {
  suggestNextSet,
  deloadFormSuggestion,
  sessionBestSet,
  sessionWorkSets,
  sideSets,
  nextSetText,
  weightIncrementKg,
  weightIncrementLb,
  type NextSet,
} from "@/lib/coaching";
import type { FormDeloadContext } from "@/lib/routines";
import type { PlateauFormHint } from "@/lib/rule-findings";
import { dismissTrainingObservation } from "@/app/(app)/training/actions";
import { pickSeedSessions } from "@/lib/exercise-window";
import { stepRpe, fmtRpe, rpeSummaryText } from "@/lib/rpe";
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
  IconInfoCircle,
  IconTrendingDown,
} from "@tabler/icons-react";
import { getExerciseGuide } from "@/lib/exercise-guides";
import ModalShell from "@/components/ModalShell";
import ExerciseGuideSection from "@/components/ExerciseGuideSection";
import {
  partIntent,
  partTotal,
  recentSessionsForForm,
  setComplete,
  setPartial,
  sidePartial,
  blockedField,
  blockedRing,
  chipCls,
  type PartEntry,
  type SetEntry,
  type RepeatSourceSet,
  type PartFault,
} from "./model";

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
            : "border-black/20 bg-white text-transparent dark:border-white/20 dark:bg-ink-900"
        }`}
      >
        <IconCheck className="h-3 w-3" stroke={3} />
      </span>
    </span>
  );
}

// A compact, optional per-set RPE selector (issue #743): −/value/+ in half-point
// steps over the 5–10 scale, BLANK by default (logging RPE is never required).
// Stepping down off the floor clears it back to blank; stepping up from blank
// seeds a working rating. The rating rides onto the set's declared intent — it
// never replaces target reps / to-failure.
//
// SIZED TO THE OPTIONS COLUMN: the whole control fits the row's w-16 (64px)
// options column (w-4 + w-7 + w-4 + borders = 62px), stacked above the warmup/
// remove buttons — it must never widen that column, because the weight/reps
// inputs' tap-target width is a pinned ergonomics contract (#337; the
// entry-ergonomics spec asserts the weight input keeps ≥64px). An optional,
// blank-by-default control shrinks first; the load/reps inputs never do.
function RpeStepper({
  value,
  onChange,
  testId,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      title="RPE — rate of perceived exertion (5–10, optional)"
      className="flex items-center overflow-hidden rounded-md border border-black/10 text-xs dark:border-white/10"
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={() => onChange(stepRpe(value, -1))}
        aria-label="Decrease RPE"
        className="flex h-7 w-4 shrink-0 items-center justify-center font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
      >
        −
      </button>
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
      <button
        type="button"
        tabIndex={-1}
        onClick={() => onChange(stepRpe(value, 1))}
        aria-label="Increase RPE"
        className="flex h-7 w-4 shrink-0 items-center justify-center font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
      >
        +
      </button>
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
  history,
  deloadContext,
  plateauHints,
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
  onApplySuggestion,
  onApplyPerSideSuggestion,
  onFillFromSession,
  onPlateFromSuggestion,
  onPlateTarget,
}: {
  part: PartEntry;
  fault: PartFault;
  units: UnitPrefs;
  isEdit: boolean;
  history: ExerciseHistoryMap;
  // Deload/plateau inputs (#923): whether the active routine is in its deload week
  // (+ which lifts to shave), and the active plateau hints keyed by exerciseHistoryKey.
  deloadContext: FormDeloadContext;
  plateauHints: PlateauFormHint[];
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
  onUpdateSet: (si: number, patch: Partial<SetEntry>) => void;
  onAddSet: () => void;
  onRemoveSet: (si: number) => void;
  onUpdatePartName: (name: string, extra?: Partial<PartEntry>) => void;
  onApplySuggestion: (ns: NextSet) => void;
  // Fill set 1 (or a new set) with a per-side suggestion — each side seeded from
  // its own progression (#335). Either side may be null (no history that side).
  onApplyPerSideSuggestion: (
    left: NextSet | null,
    right: NextSet | null
  ) => void;
  // Replace this (pristine) part's sets with a literal repeat of a prior session (#923).
  onFillFromSession: (sets: RepeatSourceSet[]) => void;
  // Open the plate builder seeded with the suggestion's weight, loading it into
  // set 1's weight field (the suggestion → plate deep-link, #335).
  onPlateFromSuggestion: (weightKg: number) => void;
  onPlateTarget: (si: number, field: "weight" | "weightRight") => void;
}) {
  const p = part;
  // The how-to guide for the current lift (#734). Catalog lifts have one; a
  // custom (non-catalog) lift resolves to undefined, so the ⓘ affordance simply
  // doesn't render. The overlay reuses the SAME guide section the exercise detail
  // panel embeds — one guide component, never a second exercise surface.
  const [guideOpen, setGuideOpen] = useState(false);
  // Plateau hints dismissed in this session (#923) — an optimistic local hide so the
  // inline hint vanishes on tap while the shared-bus write persists it everywhere else.
  const [dismissedPlateaus, setDismissedPlateaus] = useState<Set<string>>(
    () => new Set()
  );
  const guide = getExerciseGuide(p.name);
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
  const recent = recentSessionsForForm(
    hist?.sessions,
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
  // Seed off the prior session of the EXACT variant the user is entering
  // (`p.name`), falling back to the newest session overall — the merged history
  // (#331) interleaves implements, and a per-hand dumbbell load is a different
  // progression from a barbell total (#393). pickSeedSessions is the same ONE
  // decision getStrengthByExercise's lastSessionBest/lastSessionSets use, so the
  // seed is implement-appropriate identically on both surfaces. Two same-day
  // activities are still one session (as in getStrengthByExercise) — the anchor
  // plus every working set so progression judges the session, not the single
  // best set (#330).
  const seed = hist && past?.length ? pickSeedSessions(past, p.name) : [];
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
  // Build a next-set suggestion from a set list (one shared computation, so a
  // per-side left/right suggestion progresses each side by the SAME rule as the
  // bilateral one — #335). A weighted lift whose newest session carries only
  // weightless sets (possible via imports) has no load to progress from.
  const buildSuggestion = (
    sets: Parameters<typeof sessionBestSet>[0]
  ): NextSet | null => {
    if (!hist) return null;
    const best = sessionBestSet(sets, seedBase);
    if (!(best && (hist.bodyweight || best.weightKg > 0))) return null;
    const base = suggestNextSet(
      {
        exercise: p.name,
        bodyweight: hist.bodyweight,
        lastSessionBest: best,
        lastSessionSets: sessionWorkSets(sets, seedBase),
      },
      units.weightUnit
    );
    // On a deload week for a routine lift, replace the progression with the deload-
    // adjusted load (#923) — carried by the Use button, the set-1 ghost + focus-fill, and
    // the plate-builder seed alike, since they all read this one `suggestion`.
    return deloadFormSuggestion(base, p.name, deload);
  };
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
  // exerciseHistoryKey so a typed variant finds its merged plateau. It yields to the
  // deload rationale on a deload week (the plateau→deload cross-link already de-dupes this
  // advice at the findings layer, lib/rule-findings), and to an in-session dismissal.
  const plateauHint =
    p.name.trim() !== ""
      ? (plateauHints.find(
          (h) => h.exerciseKey === exerciseHistoryKey(p.name)
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
  const last = p.sets[p.sets.length - 1];
  const canAddSet = !!last && setComplete(p.name, last, p.perSide);
  const total = partTotal(p);
  // A pristine part (no set started): its set 1 shows the suggestion as ghost
  // placeholders, and focusing an input fills it — auto-consuming the coached
  // next set without a "Use" tap (#335). Once anything is typed it's no longer
  // pristine, so the ghosts vanish and never fight real input.
  const partUntouched = p.sets.every(
    (s) =>
      !setComplete(p.name, s, p.perSide) && !setPartial(p.name, s, p.perSide)
  );
  // The bilateral suggestion to auto-seed set 1 with (ghost + focus-fill). Only
  // for a fresh bilateral part with a weighted suggestion — per-side seeds via
  // its own Use button, and a bodyweight suggestion has no weight ghost.
  const ghost = !p.perSide && partUntouched ? suggestion : null;
  // Live version of the journal card's missed-target marker, judged by the
  // same shared rule the saved data will be (completed sets only).
  const intent = partIntent(p);
  const showPerSide = isUnilateral(p.name);
  const targetStatus = judgeTargets(
    p.sets
      .filter((s) => setComplete(p.name, s, false))
      .map((s) => ({
        reps: Number(s.reps),
        target_reps: intent.target,
        to_failure: intent.toFailure ? 1 : 0,
        warmup: s.warmup ? 1 : 0,
      }))
  );
  // Inherit the rep target from last session (#335): when the coached suggestion
  // carries a declared target (the user's scheme) and this fresh part has none,
  // adopt it so a fixed-scheme lifter (5×5) doesn't retype the target each time.
  // Guarded by the last-seeded name so clearing the field doesn't re-seed it, and
  // gated on `partUntouched` so it never overrides a session already in progress.
  const seededTargetFor = useRef<string | null>(null);
  useEffect(() => {
    const name = p.name.trim();
    if (seededTargetFor.current === name) return;
    seededTargetFor.current = name;
    if (
      suggestion?.targetReps != null &&
      !isTimed(p.name) &&
      !p.perSide &&
      partUntouched &&
      !p.targetReps.trim() &&
      !p.toFailure
    )
      onUpdatePart({ targetReps: String(suggestion.targetReps) });
    // Re-run only when the exercise changes; the ref prevents mid-session re-seeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.name]);
  const variant = variantOf(p.name);
  // For lifts with no selectable equipment variant, show their normal implement.
  const defaultEq = variant ? null : defaultEquipment(p.name);
  // Plate builder applies to barbells: a user-defined barbell implement, or any
  // barbell lift (the "Barbell" variant chip, or plain lifts like Back Squat).
  const selectedEq = equipmentList.find((e) => e.id === p.equipmentId);
  const showPlate = isBarbell(selectedEq?.category) || isBarbellLift(p.name);
  // Small button that opens the plate builder for a specific weight field.
  const plateButton = (si: number, field: "weight" | "weightRight") => (
    <button
      type="button"
      // Pointer affordance only — keep it out of the weight→reps tab order (#336).
      tabIndex={-1}
      onClick={() => onPlateTarget(si, field)}
      title="Plate builder"
      aria-label="Open plate builder"
      className="flex h-9 w-7 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
    >
      <IconBarbell className="h-4 w-4" />
    </button>
  );
  // Increment steppers (issue #337). The weight step is lift-appropriate and
  // plate-loadable — the SAME weightIncrementKg/Lb the next-set suggestion adds
  // (5 kg squat vs 2.5 kg accessory), in the user's display unit; reps step ±1.
  const weightStep =
    units.weightUnit === "lb"
      ? weightIncrementLb(p.name)
      : weightIncrementKg(p.name);
  const stepWeight = (
    si: number,
    field: "weight" | "weightRight",
    delta: number
  ) => {
    const cur =
      Number(field === "weight" ? p.sets[si].weight : p.sets[si].weightRight) ||
      0;
    const next = Math.max(0, round(cur + delta, 2));
    onUpdateSet(si, { [field]: next > 0 ? String(next) : "" });
  };
  const stepReps = (si: number, field: "reps" | "repsRight", delta: number) => {
    const cur =
      Number(field === "reps" ? p.sets[si].reps : p.sets[si].repsRight) || 0;
    const next = Math.max(0, cur + delta);
    onUpdateSet(si, { [field]: next > 0 ? String(next) : "" });
  };
  // The "effort" input is reps for normal lifts, a m:ss hold time for timed.
  const effortInput = (
    value: string,
    onChange: (v: string) => void,
    blocked: boolean,
    ghostReps?: number | null,
    onGhostFocus?: () => void,
    onEnter?: () => void,
    segmented = false
  ) => {
    if (!timed) {
      return (
        <input
          type="number"
          min="1"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(stripNonPositive(e.target.value))}
          onFocus={onGhostFocus}
          onKeyDown={
            onEnter
              ? (e) => {
                  // Enter in a complete reps field adds the next set (#336) —
                  // the form never submits on Enter, so this is a free keystroke.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onEnter();
                  }
                }
              : undefined
          }
          placeholder={ghostReps != null ? String(ghostReps) : "reps"}
          className={
            segmented
              ? "number-no-spinner min-w-0 w-full border-y-0 border-r border-l-0 border-black/10 bg-transparent px-2 py-2 text-sm outline-none focus:ring-0 dark:border-white/10 dark:text-slate-100 dark:placeholder:text-slate-500"
              : `input bg-white dark:bg-ink-900 ${blocked ? blockedField : ""}`
          }
        />
      );
    }
    const invalid = !!value.trim() && !isValidDuration(value);
    return (
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="m:ss"
        aria-invalid={invalid || undefined}
        title={
          invalid ? "Enter time as m:ss or seconds, e.g. 1:30 or 90" : undefined
        }
        className={`input bg-white dark:bg-ink-900 ${
          invalid
            ? "border-rose-300 dark:border-rose-800"
            : blocked
              ? blockedField
              : ""
        }`}
      />
    );
  };
  const badDuration =
    timed &&
    p.sets.some(
      (s) =>
        (!!s.duration.trim() && !isValidDuration(s.duration)) ||
        (p.perSide &&
          !!s.durationRight.trim() &&
          !isValidDuration(s.durationRight))
    );
  return (
    <>
      {/* A "How to" affordance for the current lift (#734) — shown only when a
          catalog guide exists (custom lifts have none). Opens the shared guide
          section in an overlay, scoped to the selected implement. */}
      {guide && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            data-testid="exercise-guide-open"
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400"
          >
            <IconInfoCircle className="h-4 w-4" />
            How to
          </button>
        </div>
      )}
      {guideOpen && guide && (
        <ModalShell
          title={`How to: ${p.name}`}
          onClose={() => setGuideOpen(false)}
        >
          <ExerciseGuideSection
            name={p.name}
            equipment={variantOf(p.name)?.equipment ?? null}
          />
        </ModalShell>
      )}
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
              className="input bg-white dark:bg-ink-900"
            />
            <button
              type="button"
              onClick={onSaveBodyweight}
              disabled={bwSaving || !(Number(bwInput) > 0)}
              className="btn shrink-0 disabled:opacity-50"
            >
              {bwSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
      {(variant || defaultEq || equipmentList.length > 0) && (
        <div
          className={`mt-2 flex flex-wrap items-center gap-1.5 ${
            fault === "equipment"
              ? `-mx-1.5 -my-1 rounded-lg px-1.5 py-1 ${blockedRing}`
              : ""
          }`}
        >
          {variant &&
            variant.group.equipment.map((eq) => {
              // A variant equipment and a custom implement are mutually
              // exclusive, so a variant chip is active only when no custom
              // implement is chosen.
              const active = variant.equipment === eq && p.equipmentId == null;
              return (
                <button
                  key={eq}
                  type="button"
                  onClick={() => {
                    onUpdatePartName(composeVariant(variant.group, eq));
                    onUpdatePart({ equipmentId: null });
                  }}
                  className={chipCls(active)}
                >
                  {eq}
                </button>
              );
            })}
          {/* This lift's default implement — click to clear any custom
              implement and use the default; highlighted while it's active. */}
          {defaultEq && (
            <button
              type="button"
              onClick={() => onUpdatePart({ equipmentId: null })}
              title="Use the default equipment"
              className={chipCls(p.equipmentId == null)}
            >
              {defaultEq}
            </button>
          )}
          {/* User-defined implement: a compact dropdown sharing the chip row.
              Selecting one drops any variant equipment (resets to the base). */}
          {equipmentList.length > 0 && (
            <select
              value={p.equipmentId ?? ""}
              onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                if (id != null) {
                  // Match the name (and strength grouping) to the implement's
                  // type: a Barbell/Machine implement composes that variant,
                  // "Other" falls back to the base lift.
                  const v = variantOf(p.name);
                  if (v) {
                    const cat = (
                      equipmentList.find((x) => x.id === id)?.category ?? ""
                    )
                      .trim()
                      .toLowerCase();
                    const wantEquip =
                      cat === "barbell"
                        ? "Barbell"
                        : cat === "machine"
                          ? "Machine"
                          : null;
                    const name =
                      wantEquip !== null &&
                      v.group.equipment.includes(wantEquip)
                        ? composeVariant(v.group, wantEquip)
                        : v.group.name;
                    if (name !== p.name) onUpdatePartName(name);
                  }
                }
                onUpdatePart({ equipmentId: id });
              }}
              className={chipCls(p.equipmentId != null)}
            >
              <option value="">Equipment</option>
              {equipmentList.map((eq) => (
                <option key={eq.id} value={eq.id}>
                  {eq.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {recent.length > 0 && (
        <div
          data-testid="recent-sessions"
          className="mt-2 rounded-md border border-black/10 bg-white px-2.5 py-1.5 text-xs dark:border-white/10 dark:bg-ink-900"
        >
          <div className="section-label">Recent</div>
          {/* Each row is a "repeat this session" fill path (#923) while the part is
              pristine (same partUntouched gate as the ghosts, so a tap can never clobber
              in-progress entry) — the newest row is the primary "repeat last session"
              gesture, but every recent session is a tap away (a light/off last day makes
              the one before it useful). Once anything is typed the rows revert to plain
              read-only reference. */}
          <ul className="mt-0.5 space-y-0.5">
            {recent.map((sess, i) => {
              const dateEl = (
                <span className="shrink-0 text-slate-500 dark:text-slate-400">
                  {formatLongDate(sess.date)}
                </span>
              );
              const metrics = (
                <span className="flex items-center gap-1 tabular-nums">
                  {summarizeExercise(sess.sets, units.weightUnit).text}
                  {/* Logged RPE for the session, shown when present (#743). */}
                  {rpeSummaryText(sess.sets) && (
                    <span className="rounded bg-slate-100 px-1 text-xs font-medium text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                      {rpeSummaryText(sess.sets)}
                    </span>
                  )}
                  {/* Same missed-target marker as the journal card; the
                      session status is judged server-side. */}
                  {sess.status === "missed" && (
                    <span
                      className="text-amber-500 dark:text-amber-400"
                      title={SET_STATUS_TITLES.missed}
                    >
                      <IconAlertTriangle className="h-3.5 w-3.5" stroke={2} />
                    </span>
                  )}
                </span>
              );
              return (
                <li key={i}>
                  {partUntouched ? (
                    <button
                      type="button"
                      data-testid="recent-session-fill"
                      onClick={() => onFillFromSession(sess.sets)}
                      title="Fill the set editor with this session"
                      className="-mx-1 flex w-full items-center justify-between gap-3 rounded px-1 py-0.5 text-left text-slate-600 transition hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-brand-950/40 dark:hover:text-brand-300"
                    >
                      {dateEl}
                      <span className="flex items-center gap-2">
                        {metrics}
                        <span className="shrink-0 rounded border border-brand-300 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-brand-600 dark:border-brand-800 dark:text-brand-400">
                          Fill
                        </span>
                      </span>
                    </button>
                  ) : (
                    <div className="flex items-center justify-between gap-3 text-slate-600 dark:text-slate-300">
                      {dateEl}
                      {metrics}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
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
                onClick={() => onApplySuggestion(suggestion)}
                title="Fill this into a set"
                className="rounded-md border border-brand-300 px-2 py-0.5 font-medium text-brand-600 transition hover:bg-brand-500 hover:text-white dark:border-brand-800 dark:text-brand-400 dark:hover:bg-brand-600 dark:hover:text-white"
              >
                Use
              </button>
              {/* Barbell lifts: jump straight into the plate builder seeded with
                  the suggested load, landing it in set 1's weight (#335). */}
              {showPlate &&
                !suggestion.bodyweight &&
                suggestion.weightKg > 0 && (
                  <button
                    type="button"
                    onClick={() => onPlateFromSuggestion(suggestion.weightKg)}
                    title="Load these plates on the bar"
                    aria-label="Load these plates on the bar"
                    className="flex h-6 w-6 items-center justify-center rounded-md border border-brand-300 text-brand-600 transition hover:bg-brand-500 hover:text-white dark:border-brand-800 dark:text-brand-400 dark:hover:bg-brand-600 dark:hover:text-white"
                  >
                    <IconBarbell className="h-3.5 w-3.5" />
                  </button>
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
                  onApplyPerSideSuggestion(suggestionLeft, suggestionRight)
                }
                title="Fill both sides into a set"
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
      {/* Inline plateau hint (#923): a calm one-liner when this lift has an active
          (undismissed) plateau finding, at the point of load selection. Reuses the SAME
          plateau computation/dedupeKey as the Training-watch card — dismissing it here
          silences that surface too (and vice versa). Never blocks the fill paths; yields
          to the deload rationale on a deload week. */}
      {showPlateauHint && plateauHint && (
        <div
          data-testid="plateau-hint"
          className="mt-2 flex items-start justify-between gap-2 rounded-md border border-black/10 bg-slate-50/70 px-2.5 py-1.5 text-xs dark:border-white/10 dark:bg-ink-850/40"
        >
          <span className="flex items-start gap-1.5 text-slate-600 dark:text-slate-300">
            <IconTrendingDown className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            <span>Flat ~6 weeks — consider a deload or a variation.</span>
          </span>
          <button
            type="button"
            onClick={() => dismissPlateau(plateauHint.dedupeKey)}
            data-testid="plateau-hint-dismiss"
            aria-label="Dismiss plateau hint"
            title="Dismiss"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-200 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-300"
          >
            <IconX className="h-3.5 w-3.5" stroke={2} />
          </button>
        </div>
      )}
      {/* One options row: the per-side toggle (unilateral lifts) and the
          declared intent — planned reps, or an AMRAP ("to failure") plan.
          Intent is optional; without it, no hit/missed-target judgment is
          made. Checking per-side hides the intent controls (per-side parts
          carry no status), but the row itself stays. */}
      {(showPerSide || intent.applies) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-slate-500 dark:text-slate-400">
          {showPerSide && (
            <label className="flex cursor-pointer items-center gap-2">
              <BrandedCheckbox
                checked={p.perSide}
                onChange={() => onUpdatePart({ perSide: !p.perSide })}
                inputTestId="per-side-checkbox"
                controlTestId="per-side-control"
              />
              Track sides separately
            </label>
          )}
          {intent.applies && (
            <>
              <label className="flex items-center gap-1.5">
                Target reps
                <input
                  type="number"
                  min="1"
                  value={p.targetReps}
                  disabled={p.toFailure}
                  onChange={(e) =>
                    onUpdatePart({
                      targetReps: stripNonPositive(e.target.value),
                    })
                  }
                  placeholder="—"
                  className="input w-16 bg-white px-2 py-1 disabled:opacity-40 dark:bg-ink-900"
                />
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <BrandedCheckbox
                  checked={p.toFailure}
                  onChange={() => onUpdatePart({ toFailure: !p.toFailure })}
                  inputTestId="to-failure-checkbox"
                  controlTestId="to-failure-control"
                />
                To failure
              </label>
            </>
          )}
        </div>
      )}
      {/* On phones, keep the set schema immediately below the sticky exercise
          picker while long sessions scroll. Desktop has room to keep the whole
          editor context visible, so the row returns to normal flow there. */}
      <div
        data-testid="set-column-headings"
        className="sticky top-11 z-[9] -mx-1 mt-2 flex items-center gap-2 bg-white/95 px-1 py-1 section-label backdrop-blur md:static md:mx-0 md:bg-transparent md:px-0 md:backdrop-blur-none dark:bg-ink-900/95 dark:md:bg-transparent"
      >
        <span className="w-12 shrink-0">Set</span>
        {!timed && !isBodyweight(p.name) ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 text-center">
            {p.perSide && <span className="w-4 shrink-0" aria-hidden />}
            <span
              data-testid="weight-column-heading"
              className="min-w-20 flex-1 basis-0"
            >
              Weight ({units.weightUnit})
            </span>
            {showPlate && <span className="w-7 shrink-0" aria-hidden />}
            <span className="w-2 shrink-0" aria-hidden>
              ×
            </span>
            <span
              data-testid="reps-column-heading"
              className="min-w-20 flex-1 basis-0"
            >
              Reps
            </span>
          </div>
        ) : (
          <span className="flex-1 text-center">
            {timed ? "Hold time" : "Reps"}
          </span>
        )}
        <span className="w-16 shrink-0 text-right">Options</span>
      </div>
      <div className="mt-2 space-y-2">
        {p.sets.map((s, si) => (
          <div key={si} className="flex items-start gap-2">
            <span className="w-12 shrink-0 pt-2 text-xs font-medium text-slate-500 dark:text-slate-400">
              Set {si + 1}
            </span>
            {p.perSide ? (
              <div className="flex-1 space-y-1.5">
                {(["", "Right"] as const).map((_, sideIdx) => {
                  const isRight = sideIdx === 1;
                  const sideW = isRight ? s.weightRight : s.weight;
                  const sideR = isRight ? s.repsRight : s.reps;
                  const sideD = isRight ? s.durationRight : s.duration;
                  const flags = sideFlags(sideW, sideR, sideD);
                  return (
                    <div key={sideIdx} className="flex items-center gap-2">
                      <span className="w-4 shrink-0 text-xs font-semibold text-slate-500 dark:text-slate-400">
                        {isRight ? "R" : "L"}
                      </span>
                      {!timed && !isBodyweight(p.name) ? (
                        <div
                          data-testid="weight-stepper"
                          className={`flex min-w-20 flex-1 basis-0 overflow-hidden rounded-lg border bg-white focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 dark:bg-ink-900 ${
                            flags.weight
                              ? blockedField
                              : "border-black/10 dark:border-white/10"
                          }`}
                        >
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() =>
                              stepWeight(
                                si,
                                isRight ? "weightRight" : "weight",
                                -weightStep
                              )
                            }
                            aria-label="Decrease weight"
                            className="flex h-9 w-7 shrink-0 items-center justify-center text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
                          >
                            −
                          </button>
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            inputMode="decimal"
                            value={sideW}
                            onChange={(e) =>
                              onUpdateSet(
                                si,
                                isRight
                                  ? {
                                      weightRight: stripNegative(
                                        e.target.value
                                      ),
                                    }
                                  : { weight: stripNegative(e.target.value) }
                              )
                            }
                            placeholder={units.weightUnit}
                            className="number-no-spinner min-w-0 w-full border-x border-y-0 border-black/10 bg-transparent px-2 py-2 text-sm outline-none focus:ring-0 dark:border-white/10 dark:text-slate-100 dark:placeholder:text-slate-500"
                          />
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() =>
                              stepWeight(
                                si,
                                isRight ? "weightRight" : "weight",
                                weightStep
                              )
                            }
                            aria-label="Increase weight"
                            className="flex h-9 w-7 shrink-0 items-center justify-center text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
                          >
                            +
                          </button>
                        </div>
                      ) : (
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          inputMode="decimal"
                          value={sideW}
                          onChange={(e) =>
                            onUpdateSet(
                              si,
                              isRight
                                ? { weightRight: stripNegative(e.target.value) }
                                : { weight: stripNegative(e.target.value) }
                            )
                          }
                          placeholder={units.weightUnit}
                          className={`input bg-white dark:bg-ink-900 ${
                            flags.weight ? blockedField : ""
                          }`}
                        />
                      )}
                      {showPlate &&
                        plateButton(si, isRight ? "weightRight" : "weight")}
                      <span className="w-2 shrink-0 text-center text-slate-500 dark:text-slate-400">
                        ×
                      </span>
                      {!timed ? (
                        <div
                          data-testid="reps-stepper"
                          className={`flex min-w-20 flex-1 basis-0 overflow-hidden rounded-lg border bg-white focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 dark:bg-ink-900 ${
                            flags.effort
                              ? blockedField
                              : "border-black/10 dark:border-white/10"
                          }`}
                        >
                          {effortInput(
                            sideR,
                            (v) =>
                              onUpdateSet(
                                si,
                                isRight ? { repsRight: v } : { reps: v }
                              ),
                            flags.effort,
                            null,
                            undefined,
                            canAddSet ? onAddSet : undefined,
                            true
                          )}
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() =>
                              stepReps(si, isRight ? "repsRight" : "reps", 1)
                            }
                            aria-label="Add a rep"
                            className="flex h-9 w-7 shrink-0 items-center justify-center text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
                          >
                            +
                          </button>
                        </div>
                      ) : (
                        effortInput(
                          sideD,
                          (v) =>
                            onUpdateSet(
                              si,
                              isRight ? { durationRight: v } : { duration: v }
                            ),
                          flags.effort,
                          null,
                          undefined,
                          canAddSet ? onAddSet : undefined
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {!timed && !isBodyweight(p.name) ? (
                  <div
                    data-testid={
                      si === 0 ? "set1-weight-stepper" : "weight-stepper"
                    }
                    className={`flex min-w-20 flex-1 basis-0 overflow-hidden rounded-lg border bg-white focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 dark:bg-ink-900 ${
                      sideFlags(s.weight, s.reps, s.duration).weight
                        ? blockedField
                        : "border-black/10 dark:border-white/10"
                    }`}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => stepWeight(si, "weight", -weightStep)}
                      aria-label="Decrease weight"
                      className="flex h-9 w-7 shrink-0 items-center justify-center text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      inputMode="decimal"
                      data-testid={si === 0 ? "set1-weight" : undefined}
                      value={s.weight}
                      onChange={(e) =>
                        onUpdateSet(si, {
                          weight: stripNegative(e.target.value),
                        })
                      }
                      onFocus={
                        si === 0 && ghost
                          ? () => onApplySuggestion(ghost)
                          : undefined
                      }
                      placeholder={
                        si === 0 && ghost && !ghost.bodyweight
                          ? String(
                              dispWeight(ghost.weightKg, units.weightUnit, 1)
                            )
                          : units.weightUnit
                      }
                      className="number-no-spinner min-w-0 w-full border-x border-y-0 border-black/10 bg-transparent px-2 py-2 text-sm outline-none focus:ring-0 dark:border-white/10 dark:text-slate-100 dark:placeholder:text-slate-500"
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => stepWeight(si, "weight", weightStep)}
                      aria-label="Increase weight"
                      className="flex h-9 w-7 shrink-0 items-center justify-center text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
                    >
                      +
                    </button>
                  </div>
                ) : (
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    inputMode="decimal"
                    data-testid={si === 0 ? "set1-weight" : undefined}
                    value={s.weight}
                    onChange={(e) =>
                      onUpdateSet(si, {
                        weight: stripNegative(e.target.value),
                      })
                    }
                    onFocus={
                      si === 0 && ghost
                        ? () => onApplySuggestion(ghost)
                        : undefined
                    }
                    placeholder={
                      si === 0 && ghost && !ghost.bodyweight
                        ? String(
                            dispWeight(ghost.weightKg, units.weightUnit, 1)
                          )
                        : units.weightUnit
                    }
                    className={`input bg-white dark:bg-ink-900 ${
                      sideFlags(s.weight, s.reps, s.duration).weight
                        ? blockedField
                        : ""
                    }`}
                  />
                )}
                {showPlate && plateButton(si, "weight")}
                <span className="w-2 shrink-0 text-center text-slate-500 dark:text-slate-400">
                  ×
                </span>
                {!timed ? (
                  <div
                    data-testid={
                      si === 0 ? "set1-reps-stepper" : "reps-stepper"
                    }
                    className={`flex min-w-20 flex-1 basis-0 overflow-hidden rounded-lg border bg-white focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 dark:bg-ink-900 ${
                      sideFlags(s.weight, s.reps, s.duration).effort
                        ? blockedField
                        : "border-black/10 dark:border-white/10"
                    }`}
                  >
                    {effortInput(
                      s.reps,
                      (v) => onUpdateSet(si, { reps: v }),
                      sideFlags(s.weight, s.reps, s.duration).effort,
                      si === 0 && ghost ? ghost.reps : null,
                      si === 0 && ghost
                        ? () => onApplySuggestion(ghost)
                        : undefined,
                      canAddSet ? onAddSet : undefined,
                      true
                    )}
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => stepReps(si, "reps", 1)}
                      aria-label="Add a rep"
                      className="flex h-9 w-7 shrink-0 items-center justify-center text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400"
                    >
                      +
                    </button>
                  </div>
                ) : (
                  effortInput(
                    s.duration,
                    (v) => onUpdateSet(si, { duration: v }),
                    sideFlags(s.weight, s.reps, s.duration).effort,
                    null,
                    si === 0 && ghost
                      ? () => onApplySuggestion(ghost)
                      : undefined,
                    canAddSet ? onAddSet : undefined
                  )
                )}
              </div>
            )}
            <div className="flex w-16 shrink-0 flex-col items-end gap-1">
              {/* Optional per-set RPE selector (#743) — shown for rep-based sets
                (a timed hold's effort is its duration). Blank by default; the
                rating rides onto the set without replacing target reps. Stacked
                INSIDE the same w-16 options column the row always had — widening
                this column shrinks the weight/reps inputs below their pinned
                #337 tap-target width (see RpeStepper's sizing note). */}
              {!timed && (
                <RpeStepper
                  value={s.rpe}
                  onChange={(v) => onUpdateSet(si, { rpe: v })}
                  testId={si === 0 ? "set1-rpe" : undefined}
                />
              )}
              <div className="flex items-start justify-end gap-1">
                {/* Warmup toggle (#338): a light per-set "W" — a warmup is excluded
                from the part's volume total and target markers. One toggle per
                set (both sides of a per-side set share it). */}
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => onUpdateSet(si, { warmup: !s.warmup })}
                  aria-pressed={s.warmup}
                  data-testid={si === 0 ? "set1-warmup" : undefined}
                  title={
                    s.warmup
                      ? "Warmup set — excluded from volume & target markers"
                      : "Mark as a warmup set"
                  }
                  aria-label={
                    s.warmup ? "Unmark warmup set" : "Mark warmup set"
                  }
                  className={`mt-1 flex h-8 w-7 shrink-0 items-center justify-center rounded text-xs font-bold ${
                    s.warmup
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
                      : "text-slate-300 hover:bg-slate-100 hover:text-slate-500 dark:text-slate-600 dark:hover:bg-ink-800"
                  }`}
                >
                  W
                </button>
                {p.sets.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onRemoveSet(si)}
                    className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded text-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:text-rose-500/80 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                    aria-label="Remove set"
                  >
                    <IconX className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => onAddSet()}
          disabled={!canAddSet}
          title={
            canAddSet
              ? "Add another set"
              : timed
                ? "Enter a hold time first"
                : isBodyweight(p.name)
                  ? "Enter reps first"
                  : "Enter weight and reps first"
          }
          className={`-mx-2 -my-2 px-2 py-2 text-xs font-medium ${
            canAddSet
              ? "text-brand-600 hover:underline dark:text-brand-400"
              : "cursor-not-allowed text-slate-300 dark:text-slate-600"
          }`}
        >
          + Add set
        </button>
        <span className="flex items-center gap-3">
          {targetStatus && (
            <span
              data-testid="activity-target-status"
              className={`flex items-center gap-1 text-xs font-medium ${
                targetStatus === "missed"
                  ? "text-amber-500 dark:text-amber-400"
                  : "text-brand-600 dark:text-brand-400"
              }`}
              title={SET_STATUS_TITLES[targetStatus]}
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
              Total: {total.toLocaleString()} {units.weightUnit}
            </span>
          )}
        </span>
      </div>
      {badDuration && (
        <p className="mt-1 text-xs text-rose-500 dark:text-rose-400">
          Enter hold time as m:ss (e.g. 1:30) or seconds (e.g. 90).
        </p>
      )}
    </>
  );
}
