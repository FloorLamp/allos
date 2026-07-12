"use client";

import { useEffect, useRef } from "react";
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
  sessionBestSet,
  sessionWorkSets,
  sideSets,
  nextSetText,
  weightIncrementKg,
  weightIncrementLb,
  type NextSet,
} from "@/lib/coaching";
import { pickSeedSessions } from "@/lib/exercise-window";
import {
  dispWeight,
  round,
  stripNegative,
  stripNonPositive,
} from "@/lib/units";
import { IconX, IconBarbell, IconAlertTriangle } from "@tabler/icons-react";
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
  type PartFault,
} from "./model";

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
  onPlateFromSuggestion,
  onPlateTarget,
}: {
  part: PartEntry;
  fault: PartFault;
  units: UnitPrefs;
  isEdit: boolean;
  history: ExerciseHistoryMap;
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
  // Open the plate builder seeded with the suggestion's weight, loading it into
  // set 1's weight field (the suggestion → plate deep-link, #335).
  onPlateFromSuggestion: (weightKg: number) => void;
  onPlateTarget: (si: number, field: "weight" | "weightRight") => void;
}) {
  const p = part;
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
    return suggestNextSet(
      {
        exercise: p.name,
        bodyweight: hist.bodyweight,
        lastSessionBest: best,
        lastSessionSets: sessionWorkSets(sets, seedBase),
      },
      units.weightUnit
    );
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
  const belowTarget =
    judgeTargets(
      p.sets
        .filter((s) => setComplete(p.name, s, false))
        .map((s) => ({ reps: Number(s.reps), target_reps: intent.target }))
    ) === "missed";
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
      className="-mx-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-500 dark:hover:bg-ink-800 dark:hover:text-brand-400"
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
  // A compact ±/+ stepper button — pointer affordance, so out of the tab order.
  const stepButton = (label: string, onClick: () => void, aria: string) => (
    <button
      type="button"
      tabIndex={-1}
      onClick={onClick}
      aria-label={aria}
      className="flex h-9 w-6 shrink-0 items-center justify-center rounded text-sm font-semibold text-slate-400 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-500 dark:hover:bg-ink-800 dark:hover:text-brand-400"
    >
      {label}
    </button>
  );
  // The "effort" input is reps for normal lifts, a m:ss hold time for timed.
  const effortInput = (
    value: string,
    onChange: (v: string) => void,
    blocked: boolean,
    ghostReps?: number | null,
    onGhostFocus?: () => void,
    onEnter?: () => void
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
          className={`input bg-white dark:bg-ink-900 ${
            blocked ? blockedField : ""
          }`}
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
          <div className="font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Recent
          </div>
          <ul className="mt-0.5 space-y-0.5">
            {recent.map((sess, i) => (
              <li
                key={i}
                className="flex justify-between gap-3 text-slate-600 dark:text-slate-300"
              >
                <span className="shrink-0 text-slate-400 dark:text-slate-500">
                  {formatLongDate(sess.date)}
                </span>
                <span className="flex items-center gap-1 tabular-nums">
                  {summarizeExercise(sess.sets, units.weightUnit).text}
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
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* The coached next set (same progression as the exercise detail
          panel's card) with a one-tap fill, so the suggestion can be acted
          on right where sets are logged. For a fresh bilateral part it's also
          shown as ghost placeholders on set 1 (#335) — this card keeps the
          rationale and the explicit Use / plate actions. */}
      {suggestion && (
        <div className="mt-2 rounded-md border border-brand-200 bg-brand-50/60 px-2.5 py-1.5 text-xs dark:border-brand-900 dark:bg-brand-950/40">
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
      {/* One options row: the per-side toggle (unilateral lifts) and the
          declared intent — planned reps, or an AMRAP ("to failure") plan.
          Intent is optional; without it, no hit/missed-target judgment is
          made. Checking per-side hides the intent controls (per-side parts
          carry no status), but the row itself stays. */}
      {(showPerSide || intent.applies) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-slate-500 dark:text-slate-400">
          {showPerSide && (
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={p.perSide}
                onChange={() => onUpdatePart({ perSide: !p.perSide })}
                className="h-3.5 w-3.5 cursor-pointer accent-brand-600"
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
                <input
                  type="checkbox"
                  checked={p.toFailure}
                  onChange={() => onUpdatePart({ toFailure: !p.toFailure })}
                  className="h-3.5 w-3.5 cursor-pointer accent-brand-600"
                />
                To failure
              </label>
            </>
          )}
        </div>
      )}
      {/* A compact "last time" strip pinned right above the set rows (issue
          #337): the Recent panel scrolls away above a long set list, so mirror
          the newest prior session's sets here — the same summarizeExercise text,
          so "match last time" needs no scrolling. */}
      {recent.length > 0 && (
        <p
          data-testid="last-session-strip"
          className="mt-2 text-xs tabular-nums text-slate-400 dark:text-slate-500"
        >
          <span className="font-medium uppercase tracking-wide">Last</span>{" "}
          {summarizeExercise(recent[0].sets, units.weightUnit).text}
        </p>
      )}
      <div className="mt-2 space-y-2">
        {p.sets.map((s, si) => (
          <div key={si} className="flex items-start gap-2">
            <span className="w-12 shrink-0 pt-2 text-xs font-medium text-slate-400 dark:text-slate-500">
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
                      <span className="w-4 shrink-0 text-xs font-semibold text-slate-400 dark:text-slate-500">
                        {isRight ? "R" : "L"}
                      </span>
                      {!timed &&
                        !isBodyweight(p.name) &&
                        stepButton(
                          "−",
                          () =>
                            stepWeight(
                              si,
                              isRight ? "weightRight" : "weight",
                              -weightStep
                            ),
                          "Decrease weight"
                        )}
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
                      {!timed &&
                        !isBodyweight(p.name) &&
                        stepButton(
                          "+",
                          () =>
                            stepWeight(
                              si,
                              isRight ? "weightRight" : "weight",
                              weightStep
                            ),
                          "Increase weight"
                        )}
                      {showPlate &&
                        plateButton(si, isRight ? "weightRight" : "weight")}
                      <span className="text-slate-400 dark:text-slate-500">
                        ×
                      </span>
                      {effortInput(
                        timed ? sideD : sideR,
                        (v) =>
                          onUpdateSet(
                            si,
                            isRight
                              ? timed
                                ? { durationRight: v }
                                : { repsRight: v }
                              : timed
                                ? { duration: v }
                                : { reps: v }
                          ),
                        flags.effort,
                        null,
                        undefined,
                        canAddSet ? onAddSet : undefined
                      )}
                      {!timed &&
                        stepButton(
                          "+",
                          () => stepReps(si, isRight ? "repsRight" : "reps", 1),
                          "Add a rep"
                        )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-1 items-center gap-2">
                {!timed &&
                  !isBodyweight(p.name) &&
                  stepButton(
                    "−",
                    () => stepWeight(si, "weight", -weightStep),
                    "Decrease weight"
                  )}
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
                      ? String(dispWeight(ghost.weightKg, units.weightUnit, 1))
                      : units.weightUnit
                  }
                  className={`input bg-white dark:bg-ink-900 ${
                    sideFlags(s.weight, s.reps, s.duration).weight
                      ? blockedField
                      : ""
                  }`}
                />
                {!timed &&
                  !isBodyweight(p.name) &&
                  stepButton(
                    "+",
                    () => stepWeight(si, "weight", weightStep),
                    "Increase weight"
                  )}
                {showPlate && plateButton(si, "weight")}
                <span className="text-slate-400 dark:text-slate-500">×</span>
                {effortInput(
                  timed ? s.duration : s.reps,
                  (v) => onUpdateSet(si, timed ? { duration: v } : { reps: v }),
                  sideFlags(s.weight, s.reps, s.duration).effort,
                  si === 0 && ghost && !timed ? ghost.reps : null,
                  si === 0 && ghost
                    ? () => onApplySuggestion(ghost)
                    : undefined,
                  canAddSet ? onAddSet : undefined
                )}
                {!timed &&
                  stepButton("+", () => stepReps(si, "reps", 1), "Add a rep")}
              </div>
            )}
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
          {belowTarget && (
            <span
              className="flex items-center gap-1 text-xs font-medium text-amber-500 dark:text-amber-400"
              title={`At least one set fell short of the ${intent.target}-rep target`}
            >
              <IconAlertTriangle className="h-3.5 w-3.5" stroke={2} />
              Below target
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
