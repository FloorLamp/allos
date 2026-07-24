// Pure model + helpers for ActivityForm. No React, no state, no side effects —
// everything here is a plain type, a value builder, or a pure derivation, so it
// is unit-testable in isolation (see lib/__tests__/activity-form-model.test.ts)
// and shared by the form's presentational sub-components under this directory.

import type { ActivityType } from "@/lib/types";
import { parseComponents } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import { isTimed } from "@/lib/lifts";
import { formatSeconds } from "@/lib/duration";
import { round, kgTo, kmTo } from "@/lib/units";
import { isCuratedActivity } from "@/lib/activities-catalog";
import { legacyActivityName } from "@/lib/activity-meta";
import { sideCompleteBy, sidePartialBy } from "@/lib/activity-validate";
import { cachedDateTimeFormat, dateStrInTz } from "@/lib/date";
import type { ImportedActivityMetrics } from "@/lib/activity-import-details";
import type { ZoneId } from "@/lib/training-zones";
import type { RoutineSession } from "@/lib/workout-recommendation";

export interface ActivityEditData {
  id: number;
  // The profile this activity BELONGS to (issue #1330). Present only on a merged
  // multi-view EDIT card so the editor's save/delete targets the subject's profile
  // (buildFormData posts it → gateItemProfile → requireProfileWriteAccess). Absent on
  // a single-view edit and on every CREATE/repeat prefill (a new/repeated activity
  // always lands on the ACTING profile) — buildRepeatPrefill/buildRoutineSessionPrefill
  // deliberately drop it, so "Log again" on someone else's card logs it as YOURS.
  subjectProfileId?: number;
  type: ActivityType;
  title: string;
  date: string;
  duration_min: number | null;
  // ELAPSED (wall-clock) minutes (issue #1202) — preloads the form's active·elapsed
  // summary; the form still derives elapsed from start/end when this is null.
  elapsed_min?: number | null;
  distance_km: number | null;
  intensity: string | null;
  start_time: string | null;
  end_time: string | null;
  components: string | null;
  notes: string | null;
  // Provenance for the editor header (issue #11). Present on stored rows opened
  // for edit; omitted when creating a new activity. `source` is the raw source
  // id (null = manual), `edited` marks a hand-edited import, and created_at/
  // updated_at are UTC datetimes (updated_at NULL until first edited).
  source?: string | null;
  edited?: number | null;
  created_at?: string;
  updated_at?: string | null;
  // Stored estimated calories for a MANUAL activity (issue #151), so an edit
  // preloads the saved value instead of recomputing it. NULL/absent otherwise.
  est_calories?: number | null;
  // Session-level equipment link (issue #342): the gear the whole activity used
  // (Equipment.id), or null. Preloads the activity-level picker on edit; distinct
  // from the per-set implement below (sets[].equipment_id).
  equipment_id?: number | null;
  // Read-only provider measurements shown while editing an imported activity.
  // The save action never accepts these fields, so form edits cannot overwrite
  // the integration's source data.
  imported_metrics?: ImportedActivityMetrics;
  // Card-derived display context carried into the editor. These values are
  // read-only and never enter the save payload.
  calorie_kcal?: number | null;
  calorie_estimated?: boolean;
  route_polyline?: string | null;
  // The profile-relative zone for the displayed average HR. It is computed once
  // while the Journal model is assembled, then shared by the card and editor.
  heart_rate_zone?: ZoneId | null;
  sets: {
    exercise: string;
    set_number: number;
    weight_kg: number | null;
    reps: number | null;
    weight_kg_right: number | null;
    reps_right: number | null;
    duration_sec: number | null;
    duration_sec_right: number | null;
    equipment_id: number | null;
    // Declared intent: planned rep count, or "to failure" (AMRAP, 1 = true).
    target_reps: number | null;
    to_failure: number | null;
    // Warmup flag (#338, 1 = warmup); populated back into the set row on edit.
    warmup: number | null;
    // Optional logged RPE (5–10) for the set (#743), or null; preloads the set
    // row's RPE selector on edit so the rating round-trips.
    rpe: number | null;
  }[];
}

// Build a create-prefill from a stored activity for "Log again" / "Repeat last"
// (issue #29). Keeps the title, component structure, and every set, but resets
// the identity and session context: no id/provenance (the form treats it as a
// brand-new row), the date is today, and the start/end times + notes start
// clean. Pure so it's unit-tested. The form seeds its initial state from this
// exactly as it does from editData, but — because it arrives as `prefill`, not
// `editData` — saves create a new activity instead of updating the source.
export function buildRepeatPrefill(
  source: ActivityEditData,
  todayDate: string
): ActivityEditData {
  return {
    ...source,
    // A repeat CREATES a new row on the ACTING profile (issue #1330): drop any
    // subject stamp the source card carried, so repeating another member's workout
    // logs it as yours, never a cross-profile write.
    subjectProfileId: undefined,
    // id is retained only so the editor can key a fresh remount off it; the form
    // ignores it in prefill mode (savableId reads editData/createdId, not this).
    date: todayDate,
    start_time: null,
    end_time: null,
    notes: null,
    source: null,
    edited: null,
    created_at: undefined,
    updated_at: null,
    imported_metrics: undefined,
    calorie_kcal: undefined,
    calorie_estimated: undefined,
    route_polyline: undefined,
    heart_rate_zone: undefined,
    // Deep-copy the sets so the prefill can't alias (and later mutate) the
    // source row's array.
    sets: source.sets.map((s) => ({ ...s })),
  };
}

// Build an ActivityEditData PREFILL from a resolved routine session (#740). The
// day's slots become the activity's exercises, each with its prescribed number of
// blank sets carrying the rep target (top of the slot's range), so "Log this
// session" opens the form pre-filled with the slate and the user fills loads/reps
// live (the #340 live mode). Loads are LEFT BLANK — entered at the gym, and the
// same cold-start behavior whether or not a next-set seed exists. A cardio-focus
// day yields a plain cardio log (no strength slate). Pure, so it's unit-tested.
export function buildRoutineSessionPrefill(
  session: RoutineSession,
  todayDate: string
): ActivityEditData {
  const base: ActivityEditData = {
    id: 0, // fresh row — the form ignores this in prefill mode
    type: session.kind === "cardio" ? "cardio" : "strength",
    title: session.label,
    date: todayDate,
    duration_min: null,
    distance_km: null,
    intensity: null,
    start_time: null,
    end_time: null,
    components: null,
    notes: null,
    sets: [],
  };
  if (session.kind === "cardio") return base;

  const filled = session.slots.filter((s) => s.exercise);
  const components = filled.map((s) => ({
    name: s.exercise,
    type: "strength" as ActivityType,
    distance_km: null,
    duration_min: null,
  }));
  const sets: ActivityEditData["sets"] = [];
  for (const slot of filled) {
    const count = Math.max(1, slot.sets);
    for (let i = 0; i < count; i++) {
      sets.push({
        exercise: slot.exercise,
        set_number: i + 1,
        weight_kg: null,
        reps: null,
        weight_kg_right: null,
        reps_right: null,
        duration_sec: null,
        duration_sec_right: null,
        equipment_id: null,
        // Plan the top of the slot's rep range; the missed-target signal compares
        // logged reps against it.
        target_reps: slot.repMax,
        to_failure: null,
        warmup: null,
        rpe: null,
      });
    }
  }
  return {
    ...base,
    components: components.length ? JSON.stringify(components) : null,
    sets,
  };
}

// One stored set of a prior session, as the "repeat last session" fill reads it
// (#923). A structural subset of the history query's RecentSession sets, so the pure
// mapper below stays decoupled from lib/queries (and its DB import) and unit-testable.
export interface RepeatSourceSet {
  set_number: number;
  weight_kg: number | null;
  reps: number | null;
  weight_kg_right: number | null;
  reps_right: number | null;
  duration_sec: number | null;
  duration_sec_right: number | null;
  warmup: number | null;
}

// Map a prior session's stored sets to editable set rows for the "repeat last session"
// fill path (#923): a LITERAL repeat of that session's work. Weights are rendered in the
// login's display unit, reps/holds preserved, warmup flags (#338) and per-side values
// (#335) carried across; `perSide` is true when ANY set carried a right side, so the
// filled part tracks sides exactly as the source did. RPE and declared intent are NOT
// carried — a repeat re-enters the WORK, not the plan (target reps live on the part, and
// RPE is logged fresh per set, #743). Ordered by set_number. Pure, so it's unit-tested.
export function repeatSessionFill(
  sets: RepeatSourceSet[],
  unit: UnitPrefs["weightUnit"]
): { sets: SetEntry[]; perSide: boolean } {
  const perSide = sets.some(
    (s) => s.weight_kg_right != null || s.reps_right != null
  );
  const out = [...sets]
    .sort((a, b) => a.set_number - b.set_number)
    .map((s) => ({
      weight:
        s.weight_kg != null ? String(round(kgTo(s.weight_kg, unit), 1)) : "",
      reps: s.reps != null ? String(s.reps) : "",
      weightRight:
        s.weight_kg_right != null
          ? String(round(kgTo(s.weight_kg_right, unit), 1))
          : "",
      repsRight: s.reps_right != null ? String(s.reps_right) : "",
      duration: s.duration_sec != null ? formatSeconds(s.duration_sec) : "",
      durationRight:
        s.duration_sec_right != null ? formatSeconds(s.duration_sec_right) : "",
      warmup: !!s.warmup,
      rpe: null as number | null,
    }));
  return { sets: out, perSide };
}

export interface SetEntry {
  weight: string;
  reps: string;
  weightRight: string; // per-side (asymmetric) right-side load
  repsRight: string;
  duration: string; // timed holds, entered as m:ss
  durationRight: string;
  // Warmup flag (#338): a ramp-up set, excluded from volume/judgment/progression.
  warmup: boolean;
  // Optional per-set RPE (5–10 half-point) or null when unlogged (#743). Held as
  // a number (not a text field) — the set row edits it through a stepper, and the
  // save boundary canonicalizes it (lib/rpe.ts).
  rpe: number | null;
}
export interface PartEntry {
  name: string;
  // Free-text activity the user explicitly committed via the combobox's
  // "Add as new" row (typing alone never sets this — auto-save would persist
  // typos). Its type comes from customType instead of the picker vocabulary.
  custom: boolean;
  // The committed part's type: keyword-inferred at commit, or chosen via the
  // Cardio/Sport chips. null blocks the save until a chip is picked. Strength
  // is deliberately impossible — lifts stay a closed list.
  customType: ActivityType | null;
  sets: SetEntry[]; // strength
  perSide: boolean; // track left/right separately (unilateral lifts)
  equipmentId: number | null; // user-defined implement (strength), or null
  distance: string; // distance-based, user unit
  durationMin: string; // optional, non-strength
  // Declared intent for this exercise's sets: planned reps ("" = none), or
  // AMRAP. Only meaningful for rep-based bilateral parts; the missed-target
  // signal compares actual reps against this instead of rep variance.
  targetReps: string;
  toFailure: boolean;
}

// What the editor can reconstruct of a stored exercise: everything in
// PartEntry except the cardio-only fields.
export type EditedPart = Omit<PartEntry, "distance" | "durationMin">;

export const todayStr = (tz: string) => dateStrInTz(tz);
// Runs on every render (the "now" shortcut's visibility check), so use the
// cached formatter rather than constructing one per call.
export const nowHHMM = (tz: string) =>
  cachedDateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

export const blankSet = (): SetEntry => ({
  weight: "",
  reps: "",
  weightRight: "",
  repsRight: "",
  duration: "",
  durationRight: "",
  warmup: false,
  rpe: null,
});
export const blankPart = (): PartEntry => ({
  name: "",
  custom: false,
  customType: null,
  sets: [blankSet()],
  perSide: false,
  equipmentId: null,
  distance: "",
  durationMin: "",
  targetReps: "",
  toFailure: false,
});

// The declared intent a part's UI edits and its sets are saved with. Intent
// only applies to rep-based bilateral parts — elsewhere it's inert and nulled
// on save so stale values can't linger. The single source for the control's
// visibility, the live marker, and the save payload.
export function partIntent(p: PartEntry): {
  applies: boolean;
  target: number | null;
  toFailure: boolean;
} {
  const applies = !isTimed(p.name) && !p.perSide;
  const toFailure = applies && p.toFailure;
  const target =
    applies && !toFailure && p.targetReps.trim() ? Number(p.targetReps) : null;
  return { applies, target, toFailure };
}

export function groupEditSets(
  sets: ActivityEditData["sets"],
  unit: UnitPrefs["weightUnit"]
): EditedPart[] {
  const ordered = [...sets].sort((a, b) => a.set_number - b.set_number);
  const byName: EditedPart[] = [];
  for (const s of ordered) {
    let entry = byName.find((e) => e.name === s.exercise);
    if (!entry) {
      entry = {
        name: s.exercise,
        custom: false, // exercise sets are always catalog strength lifts
        customType: null,
        sets: [],
        perSide: false,
        equipmentId: null,
        targetReps: "",
        // Collapses to true only if EVERY set is AMRAP (see below).
        toFailure: true,
      };
      byName.push(entry);
    }
    if (
      s.weight_kg_right != null ||
      s.reps_right != null ||
      s.duration_sec_right != null
    )
      entry.perSide = true;
    // Take the first implement recorded across the exercise's sets.
    if (entry.equipmentId == null && s.equipment_id != null)
      entry.equipmentId = s.equipment_id;
    // Intent is stored per set but edited per exercise, so mixed per-set
    // intent (possible via the save API, not this form) collapses lossily on
    // the next save: first target found wins, and to-failure only survives
    // when ALL sets carry it — a mixed 5/3/1-style "1+" degrades to targeted
    // sets rather than losing its targets entirely.
    if (!entry.targetReps && s.target_reps != null)
      entry.targetReps = String(s.target_reps);
    entry.toFailure = entry.toFailure && !!s.to_failure;
    entry.sets.push({
      weight:
        s.weight_kg != null ? String(round(kgTo(s.weight_kg, unit), 1)) : "",
      reps: s.reps != null ? String(s.reps) : "",
      weightRight:
        s.weight_kg_right != null
          ? String(round(kgTo(s.weight_kg_right, unit), 1))
          : "",
      repsRight: s.reps_right != null ? String(s.reps_right) : "",
      duration: s.duration_sec != null ? formatSeconds(s.duration_sec) : "",
      durationRight:
        s.duration_sec_right != null ? formatSeconds(s.duration_sec_right) : "",
      warmup: !!s.warmup,
      rpe: s.rpe ?? null,
    });
  }
  return byName;
}

// Reconstruct the form's initial `parts` state from the row it opens on — a stored
// activity being edited, or a "Log again"/"Repeat last" prefill (issue #127; the
// #1207 extraction of ActivityForm's inline useState initializer). Pure so it is
// unit-testable and can't diverge from the save/reconstruct round-trip: a structured
// `components` blob loads the typed parts (strength parts joined back to their sets),
// else a strength row groups its sets, else a legacy cardio/sport row derives its
// single part from the freeform title. `isKnown` is the picker-vocabulary predicate
// (from the form's name classifier) used to recover a legacy part's name.
export function initialPartsFromSeed(
  seed: ActivityEditData | null,
  units: UnitPrefs,
  isKnown: (name: string) => boolean
): PartEntry[] {
  if (!seed) return [blankPart()];
  if (seed.components) {
    // Shared parseComponents (issue #334): a stored components string is always
    // a valid non-empty array (saveActivity writes NULL for an empty list), so
    // this loads the structured parts; a malformed blob yields [] here.
    const grouped = groupEditSets(seed.sets, units.weightUnit);
    return parseComponents(seed.components).map((c) => {
      if (c.type === "strength") {
        const g = grouped.find(
          (e) => e.name.toLowerCase() === c.name.toLowerCase()
        );
        // Spread the reconstructed part wholesale (keeping the component's
        // casing for the name) so new EditedPart fields can't be missed.
        return g
          ? { ...blankPart(), ...g, name: c.name }
          : { ...blankPart(), name: c.name };
      }
      // Any non-curated cardio/sport name is a custom activity: load it
      // committed and typed as stored, whether or not the suggestions
      // know it yet — so its chips and distance field survive re-edits.
      const custom = !isCuratedActivity(c.name);
      return {
        ...blankPart(),
        name: c.name,
        custom,
        customType: custom ? c.type : null,
        distance:
          c.distance_km != null
            ? String(round(kmTo(c.distance_km, units.distanceUnit), 2))
            : "",
        durationMin: c.duration_min != null ? String(c.duration_min) : "",
      };
    });
  }
  if (seed.type === "strength") {
    const g = groupEditSets(seed.sets, units.weightUnit);
    return (g.length ? g : [blankPart()]).map((e) => ({
      ...blankPart(),
      ...e,
    }));
  }
  // Legacy cardio/sport rows (no components): the part name is derived
  // from the freeform title (see legacyActivityName); a non-curated one
  // loads as a custom part typed by the row — editable instead of
  // permanently blocked.
  const name = legacyActivityName(seed.title, isKnown);
  const custom = !isCuratedActivity(name);
  return [
    {
      ...blankPart(),
      name,
      custom,
      customType: custom ? seed.type : null,
      distance:
        seed.distance_km != null
          ? String(round(kmTo(seed.distance_km, units.distanceUnit), 2))
          : "",
      durationMin: seed.duration_min != null ? String(seed.duration_min) : "",
    },
  ];
}

// What makes a strength set "count" / what pauses auto-save as half-filled:
// the rules live in lib/activity-validate (shared with the journal's
// stored-row validator); these adapters feed it trimmed-string presence.
export const sideComplete = (name: string, w: string, r: string, d: string) =>
  sideCompleteBy(name, !!w.trim(), !!r.trim(), !!d.trim());
export const setComplete = (name: string, set: SetEntry, perSide: boolean) =>
  sideComplete(name, set.weight, set.reps, set.duration) ||
  (perSide &&
    sideComplete(name, set.weightRight, set.repsRight, set.durationRight));
export const sidePartial = (name: string, w: string, r: string, d: string) =>
  sidePartialBy(name, !!w.trim(), !!r.trim(), !!d.trim());
export const setPartial = (name: string, set: SetEntry, perSide: boolean) =>
  sidePartial(name, set.weight, set.reps, set.duration) ||
  (perSide &&
    sidePartial(name, set.weightRight, set.repsRight, set.durationRight));

// Working-set volume (weight × reps, summed across sets and both sides).
// Warmups are excluded (#338) — they're not working volume.
export function partTotal(p: PartEntry): number {
  return p.sets.reduce((sum, s) => {
    if (s.warmup) return sum;
    let v = (Number(s.weight) || 0) * (Number(s.reps) || 0);
    if (p.perSide)
      v += (Number(s.weightRight) || 0) * (Number(s.repsRight) || 0);
    return sum + v;
  }, 0);
}

export const INTENSITIES: {
  value: string;
  label: string;
  // One-line RPE-style descriptor so the level isn't unexplained (#336). Shown
  // under the picker for the selected level; the choice feeds the calorie MET
  // tier (lib/calorie-estimate), so a note there says the estimate depends on it.
  hint: string;
  cls: string;
  active: string;
}[] = [
  {
    value: "easy",
    label: "Easy",
    hint: "Conversational, low effort — RPE 3–4",
    cls: "text-green-700 border-green-200 dark:text-green-300 dark:border-green-800",
    active: "bg-green-500 text-white border-green-500",
  },
  {
    value: "moderate",
    label: "Moderate",
    hint: "Working but can still talk — RPE 5–6",
    cls: "text-amber-700 border-amber-200 dark:text-amber-300 dark:border-amber-800",
    active: "bg-amber-500 text-white border-amber-500",
  },
  {
    value: "hard",
    label: "Hard",
    hint: "Breathless, near-maximal — RPE 7–9",
    cls: "text-rose-700 border-rose-200 dark:text-rose-300 dark:border-rose-800",
    active: "bg-rose-500 text-white border-rose-500",
  },
];

// Shared by the equipment chips (variant/default/custom <select>) and the
// custom activity's type chips. On touch devices globals.css floors
// form-control text at 16px (the iOS focus-zoom guard), which would make the
// select tower over text-xs buttons — so the whole row steps up to match
// there, which also gives the chips finger-sized targets.
export const chipCls = (active: boolean) =>
  `cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium transition [@media(pointer:coarse)]:text-base ${
    active
      ? "border-brand-500 bg-brand-500 text-white"
      : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
  }`;

// Amber for the specific inputs the save is waiting on — the border for
// fields, the ring for the equipment chip row — matching the blocker line.
export const blockedField = "border-amber-400 dark:border-amber-600";
export const blockedRing = "ring-1 ring-amber-400 dark:ring-amber-600";

// This part's fault while a change is stuck: the reason the activity can't be
// saved, so its card and the offending inputs can be flagged. `null` when fine.
export type PartFault =
  "name" | "type" | "equipment" | "set" | "content" | null;

// Which of an exercise's recent sessions to surface in the form's "Recent"
// reference panel — shared by create AND edit (issue #188). The input is the
// history query's newest-first list; that order is preserved.
//
// `currentActivityId` is the session the form is saving, and is ALWAYS excluded
// so a session never lists itself: in create that's the auto-saved row once it
// exists (was null → excludes nothing until then); in edit it's the row being
// edited. `editedDate` is the edited session's date in edit mode (else null) —
// used to drop any session logged strictly AFTER the edited one, so the panel
// stays semantically "previous" when editing a back-dated session (in create
// the saved row is always newest, so this filter is inert). Same-day siblings
// are kept (they aren't "after"); self is already gone by id. Newest-first
// slice to `limit`, matching create's prior behaviour exactly.
export function recentSessionsForForm<
  T extends { activityId: number; date: string },
>(
  sessions: T[] | undefined,
  currentActivityId: number | null,
  editedDate: string | null,
  limit = 3
): T[] {
  if (!sessions) return [];
  return sessions
    .filter((s) => s.activityId !== currentActivityId)
    .filter((s) => editedDate == null || s.date <= editedDate)
    .slice(0, limit);
}
