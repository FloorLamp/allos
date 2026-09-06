import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Equipment } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import type { ExerciseHistoryMap } from "@/lib/queries";
import {
  isUnilateral,
  variantOf,
  composeVariant,
  exerciseHistoryKey,
} from "@/lib/lifts";
import { inferFreeTextType, titleCase } from "@/lib/activity-meta";
import {
  type ActivityEditData,
  type PartEntry,
  type SetEntry,
  type RepeatSourceSet,
  blankSet,
  blankPart,
  partIntent,
  initialPartsFromSeed,
  repeatSessionFill,
  setComplete,
  setPartial,
} from "@/lib/activity-form-model";

// Which set's weight field the plate builder is targeting, if open. `seed`
// (display-unit weight) pre-loads the builder from the coached suggestion instead
// of the field's current value (#335); omitted for a plain icon tap. `"all"` is the
// exercise-level weight (#5371): while every set shares one load the builder is
// seeded from it and its result lands on every set, so the grid stays shared.
export interface PlateTarget {
  pi: number;
  si: number | "all";
  field: "weight" | "weightRight";
  seed?: number;
}

// What a fill puts into a part's sets, and the only two shapes that exist (#5377).
// Both arms hand over the SAME stored set shape `repeatSessionFill` maps — canonical
// kilograms in, display units out — so no fill path can round differently from
// another. The tag is what the source IS, and it answers the questions each writer
// used to answer for itself: where the values land, and what a fill may change
// besides the numbers.
export type SetFill =
  // A whole prior workout (#923). It IS the (pristine) part's sets, and the part's
  // side-tracking follows the source exactly as that session was logged.
  | { source: "session"; sets: RepeatSourceSet[] }
  // One coached set (#335), bilateral or per-side. It lands on the last row while
  // that row is still untouched, else as a new set; it never changes side-tracking
  // (a side with no history must not un-track the other); and it carries the
  // declared rep target the scheme states, or null for a heuristic suggestion.
  | { source: "coached"; set: RepeatSourceSet; targetReps: number | null };

// The ActivityForm parts/sets state machine (#1207 extraction). Owns the `parts`
// list and the plate-builder target, plus every mutation the form performs on them:
// name selection (variant/implement resolution, per-side defaulting, free-text
// commits), set edit/add/remove, part reorder, suggestion + repeat-session fills, and
// the plate-builder round-trip. Pure UI state logic — no auth, no persistence (the
// parent's auto-save observes `parts` through its form signature) — so the parent is
// left as composition over this hook plus the presentational sections.
export function useActivityParts({
  seed,
  units,
  history,
  isEdit,
  equipmentList,
  isKnown,
  customFlags,
  defaultCustomType,
  onSetCheckedOff,
}: {
  seed: ActivityEditData | null;
  units: UnitPrefs;
  history: ExerciseHistoryMap;
  isEdit: boolean;
  equipmentList: Equipment[];
  isKnown: (name: string) => boolean;
  customFlags: (name: string) => Partial<PartEntry>;
  // Type-scoped protocol creates keep their requested cardio/sport type as the
  // fallback for a newly committed free-text name whose type cannot be inferred.
  defaultCustomType: "cardio" | "sport" | null;
  // Fires when a set is "checked off" (a new set added) — the parent starts the
  // live-mode rest timer off this (#340).
  onSetCheckedOff: () => void;
}): {
  parts: PartEntry[];
  setParts: Dispatch<SetStateAction<PartEntry[]>>;
  plateTarget: PlateTarget | null;
  setPlateTarget: Dispatch<SetStateAction<PlateTarget | null>>;
  updatePart: (i: number, patch: Partial<PartEntry>) => void;
  updatePartName: (i: number, name: string, extra?: Partial<PartEntry>) => void;
  typePartName: (i: number, v: string) => void;
  pickPartName: (i: number, rawName: string) => void;
  updateSet: (pi: number, si: number | "all", patch: Partial<SetEntry>) => void;
  addSet: (pi: number) => void;
  movePart: (i: number, dir: -1 | 1) => void;
  removeSet: (pi: number, si: number) => void;
  removePart: (i: number) => void;
  addPart: () => void;
  fillSets: (pi: number, fill: SetFill) => void;
  applyPlateBuild: (total: number, barId: number | null) => void;
} {
  const [parts, setParts] = useState<PartEntry[]>(() =>
    initialPartsFromSeed(seed, units, isKnown)
  );
  const [plateTarget, setPlateTarget] = useState<PlateTarget | null>(null);

  function updatePart(i: number, patch: Partial<PartEntry>) {
    setParts((prev) =>
      prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p))
    );
  }
  // Set the part's name, defaulting the per-side toggle: a bilateral lift is
  // never per-side; a unilateral lift defaults on when its most recent session
  // was logged per-side (when freshly logging, not editing). Variant lifts pick
  // their equipment via chips, which call this with the composed name.
  // `extra` merges into the same state update, so callers adjusting sibling
  // fields (equipment, custom flags) don't queue a second parts clone.
  function updatePartName(i: number, name: string, extra?: Partial<PartEntry>) {
    setParts((prev) =>
      prev.map((p, idx) => {
        if (idx !== i) return p;
        if (!isUnilateral(name))
          return { ...p, ...extra, name, perSide: false };
        if (isEdit) return { ...p, ...extra, name }; // keep the toggle as loaded
        const latest = history[exerciseHistoryKey(name)]?.sessions[0];
        const perSide = !!latest?.sets.some(
          (s) =>
            s.weight_kg_right != null ||
            s.reps_right != null ||
            s.duration_sec_right != null
        );
        return { ...p, ...extra, name, perSide };
      })
    );
  }
  // The most recent implement used for a variant base (across all its variants):
  // the composed variant name plus any custom implement id, or null if untrained.
  // History merges a base's variants under one canonical key (#331), so the base's
  // most recent session is history[exerciseHistoryKey(base)].sessions[0]; that
  // session's own logged name recovers which concrete variant was last used.
  function lastUsedVariant(
    base: string
  ): { name: string; equipmentId: number | null } | null {
    const s = history[exerciseHistoryKey(base)]?.sessions[0];
    if (!s) return null;
    const v = variantOf(s.exercise);
    const name = v
      ? v.equipment
        ? composeVariant(v.group, v.equipment)
        : v.group.name
      : s.exercise;
    const equipmentId = s.equipment
      ? (equipmentList.find(
          (e) => e.name.toLowerCase() === s.equipment!.toLowerCase()
        )?.id ?? null)
      : null;
    return { name, equipmentId };
  }
  // The custom implement id used in the most recent session of an exercise. The
  // merged history is keyed by the canonical base (#331); prefer the newest
  // session logged under the exact name, else the base's newest session.
  function lastEquipmentId(name: string): number | null {
    const sessions = history[exerciseHistoryKey(name)]?.sessions;
    if (!sessions?.length) return null;
    const exact = name.trim().toLowerCase();
    const s =
      sessions.find((se) => se.exercise.trim().toLowerCase() === exact) ??
      sessions[0];
    const eqName = s.equipment;
    if (!eqName) return null;
    return (
      equipmentList.find((e) => e.name.toLowerCase() === eqName.toLowerCase())
        ?.id ?? null
    );
  }
  // Actively picking an exercise from the combobox (create OR edit) defaults to
  // the implement used last for it — a variant base resolves to its last-used
  // variant; other lifts restore any custom implement previously used.
  function selectPartName(i: number, rawName: string) {
    const v = variantOf(rawName);
    if (v && v.equipment === null) {
      // Variant base → resolve to a concrete variant so it's never left bare:
      // the implement used last for it, else the group's first equipment
      // (usually Barbell). The user can still switch via the chips.
      const last = lastUsedVariant(rawName);
      if (last) {
        updatePartName(i, last.name, { equipmentId: last.equipmentId });
      } else {
        updatePartName(i, composeVariant(v.group, v.group.equipment[0]), {
          equipmentId: null,
        });
      }
      return;
    }
    updatePartName(i, rawName, { equipmentId: lastEquipmentId(rawName) });
  }
  // Typing in the combobox: a plain name update (keeping updatePartName's
  // per-side defaulting and the last-used-implement sync) that re-derives the
  // custom flags from the text — a novel free-text commit only survives an
  // explicit pick. Variant bases are NOT resolved here; doing that per
  // keystroke would rewrite mid-word names under the user's cursor.
  function typePartName(i: number, v: string) {
    updatePartName(i, v, {
      ...customFlags(v),
      equipmentId: lastEquipmentId(v),
    });
  }
  // Explicit pick from the dropdown — a known option or the "Add '<x>' as new
  // activity" row. Novel names commit as custom parts, title-cased so the
  // commit is visible, typed by keyword inference (chips shown either way).
  // Known names (Combobox fires onChange with the pick first, so the custom
  // flags are already set by typePartName) get the pick-time defaults.
  function pickPartName(i: number, rawName: string) {
    if (isKnown(rawName)) {
      selectPartName(i, rawName);
      return;
    }
    const name = titleCase(rawName.trim());
    updatePart(i, {
      name,
      custom: true,
      customType: inferFreeTextType(name) ?? defaultCustomType,
      equipmentId: null,
      perSide: false,
    });
  }
  // Patch one set, or every set at once — the exercise-level weight (#5371) is one
  // load stated for the whole grid, so it writes through the same door as a row.
  function updateSet(pi: number, si: number | "all", patch: Partial<SetEntry>) {
    setParts((prev) =>
      prev.map((p, idx) =>
        idx === pi
          ? {
              ...p,
              sets: p.sets.map((s, j) =>
                si === "all" || j === si ? { ...s, ...patch } : s
              ),
            }
          : p
      )
    );
  }
  function addSet(pi: number) {
    // Adding the next set is the "checked off the previous set" gesture — in live
    // mode that's when the rest timer starts (issue #340).
    onSetCheckedOff();
    setParts((prev) =>
      prev.map((p, idx) => {
        if (idx !== pi) return p;
        const last = p.sets[p.sets.length - 1];
        return {
          ...p,
          sets: [
            ...p.sets,
            {
              weight: last?.weight ?? "",
              reps: last?.reps ?? "",
              weightRight: last?.weightRight ?? "",
              repsRight: last?.repsRight ?? "",
              duration: last?.duration ?? "",
              durationRight: last?.durationRight ?? "",
              // A new set is a working set by default — never inherit the
              // previous row's warmup flag (#338).
              warmup: false,
              // RPE is logged per set, never carried forward (#743) — blank by
              // default, so the next set starts unrated.
              rpe: null,
            },
          ],
        };
      })
    );
  }
  // Reorder parts (issue #337): swap a multisport leg with its neighbour so a
  // brick's legs can be ordered swim → bike → run without delete-and-re-add.
  function movePart(i: number, dir: -1 | 1) {
    setParts((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function removeSet(pi: number, si: number) {
    setParts((prev) =>
      prev.map((p, idx) =>
        idx === pi ? { ...p, sets: p.sets.filter((_, j) => j !== si) } : p
      )
    );
  }
  // Remove a whole activity leg (the ✕ on a multi-part composite).
  function removePart(i: number) {
    setParts((prev) => prev.filter((_, idx) => idx !== i));
  }
  // Append a fresh blank leg (+ Add activity).
  function addPart() {
    setParts((prev) => [...prev, blankPart()]);
  }
  // THE ONE WRITER for every path that puts values into a part's sets (#5377): the
  // coached next set, its per-side pair, and the "repeat last session" repeat. What
  // the values ARE is the caller's (a `SetFill`, above); WHERE they land and what
  // else may move is this function's, once, instead of restated per path.
  //
  // A session repeat replaces the part's sets outright and adopts the source's
  // side-tracking — the explicit gesture is gated on a pristine part in the set
  // editor, so it can never clobber entry in progress (#923).
  //
  // A coached set fills the last row while that row is still UNTOUCHED (nothing
  // counted, nothing half-entered), else arrives as a new set. It leaves the landing
  // row's warmup flag and RPE alone: those are what the person said about the row,
  // not what the suggestion says about the load. When the suggestion progresses a
  // declared rep target, adopt it as the exercise's intent — unless the user already
  // set one — so the scheme carries into the next session too.
  function fillSets(pi: number, fill: SetFill) {
    const { sets, perSide } = repeatSessionFill(
      fill.source === "session" ? fill.sets : [fill.set],
      units.weightUnit
    );
    const [values] = sets;
    if (!values) return;
    if (fill.source === "session") {
      setParts((prev) =>
        prev.map((part, idx) =>
          idx === pi ? { ...part, sets, perSide } : part
        )
      );
      return;
    }
    const { targetReps } = fill;
    setParts((prev) =>
      prev.map((part, idx) => {
        if (idx !== pi) return part;
        const li = part.sets.length - 1;
        const last = part.sets[li];
        const untouched =
          !!last &&
          !setComplete(part.name, last, part.perSide) &&
          !setPartial(part.name, last, part.perSide);
        const land = (row: SetEntry): SetEntry => ({
          ...values,
          warmup: row.warmup,
          rpe: row.rpe,
        });
        return {
          ...part,
          sets: untouched
            ? part.sets.map((s, j) => (j === li ? land(s) : s))
            : [...part.sets, land(blankSet())],
          targetReps:
            targetReps != null &&
            partIntent(part).applies &&
            !part.targetReps.trim() &&
            !part.toFailure
              ? String(targetReps)
              : part.targetReps,
        };
      })
    );
  }
  // Apply a plate-builder result to the targeted set weight. Auto-tag the
  // exercise with the bar only when no implement is chosen yet — never silently
  // replace a deliberate selection (the equipment dropdown changes it instead).
  function applyPlateBuild(total: number, barId: number | null) {
    if (!plateTarget) return;
    const { pi, si, field } = plateTarget;
    updateSet(pi, si, { [field]: String(total) });
    if (barId != null && parts[pi]?.equipmentId == null)
      updatePart(pi, { equipmentId: barId });
    setPlateTarget(null);
  }

  return {
    parts,
    setParts,
    plateTarget,
    setPlateTarget,
    updatePart,
    updatePartName,
    typePartName,
    pickPartName,
    updateSet,
    addSet,
    movePart,
    removeSet,
    removePart,
    addPart,
    fillSets,
    applyPlateBuild,
  };
}
