"use client";

import FactChipRow, { FactChip } from "@/components/facts/FactChipRow";
import ControlTooltip from "@/components/ControlTooltip";
import IconButton from "@/components/IconButton";
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
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { judgeTargets, summarizeExercise } from "@/lib/training-log-format";
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
  partIntent,
  partTotal,
  recentSessionsForForm,
  setComplete,
  setPartial,
  sidePartial,
  blockedField,
  partSetsSummary,
  type PartEntry,
  type SetEntry,
  type RepeatSourceSet,
  type PartFault,
} from "./model";
import Stepper from "@/components/Stepper";

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
  const last = p.sets[p.sets.length - 1];
  const canAddSet = !!last && setComplete(p.name, last, p.perSide);
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
  // A pristine part (no set started): its set 1 shows the suggestion as ghost
  // PLACEHOLDERS (#335). Once anything is typed it's no longer pristine, so the
  // ghosts vanish and never fight real input.
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
  const partUntouched = p.sets.every(
    (s) =>
      !setComplete(p.name, s, p.perSide) && !setPartial(p.name, s, p.perSide)
  );
  // The bilateral suggestion to ghost set 1 with. Only for a fresh bilateral
  // part with a weighted suggestion — per-side offers via its own Use button,
  // and a bodyweight suggestion has no weight ghost.
  const ghost = !p.perSide && partUntouched ? suggestion : null;
  // Live version of the training log card's missed-target marker, judged by the
  // same shared rule the saved data will be (completed sets only).
  const intent = partIntent(p);
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
  // Plate builder applies to barbells: a user-defined barbell implement, or any
  // barbell lift (the "Barbell" variant chip, or plain lifts like Back Squat).
  const selectedEq = equipmentList.find((e) => e.id === p.equipmentId);
  const showPlate = isBarbell(selectedEq?.category) || isBarbellLift(p.name);
  // Small button that opens the plate builder for a specific weight field.
  const plateButton = (si: number, field: "weight" | "weightRight") => (
    // Keep the set grid's established 28px plate COLUMN while IconButton owns a
    // centered 44px TARGET. The heading reserves this same w-7 slot below, so
    // widening the layout column would move both value-column centers (#337).
    <span className="flex w-7 min-w-0 shrink-0 items-center justify-center">
      <IconButton
        type="button"
        // Pointer affordance only — keep it out of the weight→reps tab order (#336).
        tabIndex={-1}
        onClick={() => onPlateTarget(si, field)}
        label="Open plate builder"
      >
        <IconBarbell className="h-4 w-4" />
      </IconButton>
    </span>
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
    onEnter?: () => void,
    segmented = false,
    testId?: string
  ) => {
    if (!timed) {
      return (
        <input
          type="number"
          min="1"
          inputMode="numeric"
          data-testid={testId}
          value={value}
          onChange={(e) => onChange(stripNonPositive(e.target.value))}
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
              ? // Divider on BOTH sides now that the reps stepper is symmetric
                // (#1524: − input +), exactly like the weight stepper's input.
                "number-no-spinner min-w-0 w-full border-x border-y-0 border-black/10 bg-transparent px-2 py-2 text-sm outline-hidden focus:ring-0 dark:border-white/10 dark:text-slate-100 dark:placeholder:text-slate-500"
              : `input ${blocked ? blockedField : ""}`
          }
        />
      );
    }
    const invalid = !!value.trim() && !isValidDuration(value);
    return (
      <input
        type="text"
        inputMode="numeric"
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="m:ss"
        aria-invalid={invalid || undefined}
        className={`input ${
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
      {recent.length > 0 && (
        <div
          data-testid="recent-sessions"
          className="mt-2 rounded-md border border-black/10 bg-surface px-2.5 py-1.5 text-xs dark:border-white/10"
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
                  {formatLongDate(sess.date, formatPrefs)}
                </span>
              );
              const metrics = (
                <span className="flex items-center gap-1 tabular-nums">
                  {summarizeExercise(sess.sets, units.weightUnit).text}
                  {/* Logged RPE for the session, shown when present (#743). */}
                  {rpeSummaryText(sess.sets) && (
                    <span className="rounded-sm bg-slate-100 px-1 text-xs font-medium text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                      {rpeSummaryText(sess.sets)}
                    </span>
                  )}
                  {/* Same missed-target marker as the training log card; the
                      session status is judged server-side. */}
                  {sess.status === "missed" && (
                    <span className="inline-flex items-center gap-0.5 text-xs text-amber-500 dark:text-amber-400">
                      <IconAlertTriangle className="h-3.5 w-3.5" stroke={2} />
                      Missed target
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
                      className="-mx-1 flex w-full items-center justify-between gap-3 rounded-sm px-1 py-0.5 text-left text-slate-600 transition hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-brand-950/40 dark:hover:text-brand-300"
                    >
                      {dateEl}
                      <span className="flex items-center gap-2">
                        {metrics}
                        <span className="shrink-0 rounded-sm border border-brand-300 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-brand-600 dark:border-brand-800 dark:text-brand-400">
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
                    onClick={() => onPlateFromSuggestion(suggestion.weightKg)}
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
                  onApplyPerSideSuggestion(suggestionLeft, suggestionRight)
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
      )}
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
            {!timed && !isBodyweight(p.name) ? (
              <div className="flex min-w-0 flex-1 basis-0 items-center gap-2 text-center">
                {p.perSide && <span className="w-4 shrink-0" aria-hidden />}
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
                <span
                  data-testid="reps-column-heading"
                  className="min-w-28 flex-1 basis-0"
                >
                  Reps
                </span>
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
                {p.perSide ? (
                  <div
                    data-testid={`set-values-${si + 1}`}
                    className="order-last basis-full flex-1 space-y-1.5 sm:order-0 sm:basis-0"
                  >
                    {(["", "Right"] as const).map((_, sideIdx) => {
                      const isRight = sideIdx === 1;
                      const sideW = isRight ? s.weightRight : s.weight;
                      const sideR = isRight ? s.repsRight : s.reps;
                      const sideD = isRight ? s.durationRight : s.duration;
                      const flags = sideFlags(sideW, sideR, sideD);
                      const stepSideWeight = (direction: -1 | 1) =>
                        stepWeight(
                          si,
                          isRight ? "weightRight" : "weight",
                          direction * weightStep
                        );
                      const stepSideReps = (direction: -1 | 1) =>
                        stepReps(si, isRight ? "repsRight" : "reps", direction);
                      return (
                        <div key={sideIdx} className="flex items-center gap-2">
                          <span className="w-4 shrink-0 text-xs font-semibold text-slate-500 dark:text-slate-400">
                            {isRight ? "R" : "L"}
                          </span>
                          {!timed && !isBodyweight(p.name) ? (
                            <Stepper
                              testId="weight-stepper"
                              tabStops={false}
                              onStep={stepSideWeight}
                              decreaseLabel="Decrease weight"
                              increaseLabel="Increase weight"
                              className={`min-w-28 flex-1 basis-0 ${fieldBorder(flags.weight)}`}
                            >
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
                                      : {
                                          weight: stripNegative(e.target.value),
                                        }
                                  )
                                }
                                placeholder={units.weightUnit}
                                className="number-no-spinner min-w-0 w-full border-x border-y-0 border-black/10 bg-transparent px-2 py-2 text-sm outline-hidden focus:ring-0 dark:border-white/10 dark:text-slate-100 dark:placeholder:text-slate-500"
                              />
                            </Stepper>
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
                                    ? {
                                        weightRight: stripNegative(
                                          e.target.value
                                        ),
                                      }
                                    : { weight: stripNegative(e.target.value) }
                                )
                              }
                              placeholder={units.weightUnit}
                              className={`input ${
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
                            <Stepper
                              testId="reps-stepper"
                              tabStops={false}
                              onStep={stepSideReps}
                              decreaseLabel="Decrease reps"
                              increaseLabel="Add a rep"
                              className={`min-w-28 flex-1 basis-0 ${fieldBorder(flags.effort)}`}
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
                                canAddSet ? onAddSet : undefined,
                                true
                              )}
                            </Stepper>
                          ) : (
                            effortInput(
                              sideD,
                              (v) =>
                                onUpdateSet(
                                  si,
                                  isRight
                                    ? { durationRight: v }
                                    : { duration: v }
                                ),
                              flags.effort,
                              null,
                              canAddSet ? onAddSet : undefined
                            )
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div
                    data-testid={`set-values-${si + 1}`}
                    className="order-last flex min-w-0 flex-1 basis-full items-center gap-2 sm:order-0 sm:basis-0"
                  >
                    {!timed && !isBodyweight(p.name) ? (
                      <Stepper
                        testId={
                          si === 0 ? "set1-weight-stepper" : "weight-stepper"
                        }
                        tabStops={false}
                        onStep={(direction) =>
                          stepWeight(si, "weight", direction * weightStep)
                        }
                        decreaseLabel="Decrease weight"
                        increaseLabel="Increase weight"
                        className={`min-w-28 flex-1 basis-0 ${fieldBorder(sideFlags(s.weight, s.reps, s.duration).weight)}`}
                      >
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          inputMode="decimal"
                          data-testid={`set${si + 1}-weight`}
                          value={s.weight}
                          onChange={(e) =>
                            onUpdateSet(si, {
                              weight: stripNegative(e.target.value),
                            })
                          }
                          placeholder={
                            si === 0 && ghost && !ghost.bodyweight
                              ? String(
                                  dispWeight(
                                    ghost.weightKg,
                                    units.weightUnit,
                                    1
                                  )
                                )
                              : units.weightUnit
                          }
                          className="number-no-spinner min-w-0 w-full border-x border-y-0 border-black/10 bg-transparent px-2 py-2 text-sm outline-hidden focus:ring-0 dark:border-white/10 dark:text-slate-100 dark:placeholder:text-slate-500"
                        />
                      </Stepper>
                    ) : (
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        inputMode="decimal"
                        data-testid={`set${si + 1}-weight`}
                        value={s.weight}
                        onChange={(e) =>
                          onUpdateSet(si, {
                            weight: stripNegative(e.target.value),
                          })
                        }
                        placeholder={
                          si === 0 && ghost && !ghost.bodyweight
                            ? String(
                                dispWeight(ghost.weightKg, units.weightUnit, 1)
                              )
                            : units.weightUnit
                        }
                        className={`input ${
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
                      <Stepper
                        testId={si === 0 ? "set1-reps-stepper" : "reps-stepper"}
                        tabStops={false}
                        onStep={(direction) => stepReps(si, "reps", direction)}
                        decreaseLabel="Decrease reps"
                        increaseLabel="Add a rep"
                        className={`min-w-28 flex-1 basis-0 ${fieldBorder(sideFlags(s.weight, s.reps, s.duration).effort)}`}
                      >
                        {effortInput(
                          s.reps,
                          (v) => onUpdateSet(si, { reps: v }),
                          sideFlags(s.weight, s.reps, s.duration).effort,
                          si === 0 && ghost ? ghost.reps : null,
                          canAddSet ? onAddSet : undefined,
                          true,
                          `set${si + 1}-reps`
                        )}
                      </Stepper>
                    ) : (
                      effortInput(
                        s.duration,
                        (v) => onUpdateSet(si, { duration: v }),
                        sideFlags(s.weight, s.reps, s.duration).effort,
                        null,
                        canAddSet ? onAddSet : undefined
                      )
                    )}
                  </div>
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
