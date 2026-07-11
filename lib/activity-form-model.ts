// Pure model + helpers for ActivityForm. No React, no state, no side effects —
// everything here is a plain type, a value builder, or a pure derivation, so it
// is unit-testable in isolation (see lib/__tests__/activity-form-model.test.ts)
// and shared by the form's presentational sub-components under this directory.

import type { ActivityType } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import { isTimed } from "@/lib/lifts";
import { formatSeconds } from "@/lib/duration";
import { round, kgTo } from "@/lib/units";
import { sideCompleteBy, sidePartialBy } from "@/lib/activity-validate";
import { cachedDateTimeFormat, dateStrInTz } from "@/lib/date";

export interface ActivityEditData {
  id: number;
  type: ActivityType;
  title: string;
  date: string;
  duration_min: number | null;
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
    // Deep-copy the sets so the prefill can't alias (and later mutate) the
    // source row's array.
    sets: source.sets.map((s) => ({ ...s })),
  };
}

export interface SetEntry {
  weight: string;
  reps: string;
  weightRight: string; // per-side (asymmetric) right-side load
  repsRight: string;
  duration: string; // timed holds, entered as m:ss
  durationRight: string;
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
    });
  }
  return byName;
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
export function partTotal(p: PartEntry): number {
  return p.sets.reduce((sum, s) => {
    let v = (Number(s.weight) || 0) * (Number(s.reps) || 0);
    if (p.perSide)
      v += (Number(s.weightRight) || 0) * (Number(s.repsRight) || 0);
    return sum + v;
  }, 0);
}

export const INTENSITIES: {
  value: string;
  label: string;
  cls: string;
  active: string;
}[] = [
  {
    value: "easy",
    label: "Easy",
    cls: "text-green-700 border-green-200 dark:text-green-300 dark:border-green-800",
    active: "bg-green-500 text-white border-green-500",
  },
  {
    value: "moderate",
    label: "Moderate",
    cls: "text-amber-700 border-amber-200 dark:text-amber-300 dark:border-amber-800",
    active: "bg-amber-500 text-white border-amber-500",
  },
  {
    value: "hard",
    label: "Hard",
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
