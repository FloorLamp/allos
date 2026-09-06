// Pure model + helpers for ActivityForm. No React, no state, no side effects —
// everything here is a plain type, a value builder, or a pure derivation, so it
// is unit-testable in isolation (see lib/__tests__/activity-form-model.test.ts)
// and shared by the form's presentational sub-components under this directory.

import type { ActivityType } from "@/lib/types";
import { parseComponents } from "@/lib/types";
import type { UnitPrefs, WeightUnit } from "@/lib/settings";
import { isTimed } from "@/lib/lifts";
import { formatSeconds, parseSeconds } from "@/lib/duration";
import { round, kgTo, kmTo, toKg } from "@/lib/units";
import { summarizeExercise, type SetRow } from "@/lib/training-log-format";
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
  // while the Training Log model is assembled, then shared by the card and editor.
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

// Whether a stored/editor seed carries strength content. Shared by every repeat/live
// affordance so the age gate cannot drift between the menu, palette, and provider.
// Malformed legacy components do not manufacture strength; top-level type and sets
// still preserve the historical record's editability.
export function activityEditDataHasStrength(data: ActivityEditData): boolean {
  if (data.type === "strength" || data.sets.length > 0) return true;
  return parseComponents(data.components).some((c) => c.type === "strength");
}

// Minimal create prefill for a protocol's activity-type action (#1584). This is
// deliberately a complete ActivityEditData value because ActivityForm already has
// one tested prefill path; the provider passes it as `prefill` (never `editData`),
// so it creates a fresh activity while seeding only the protocol-owned type.
// The form's input union stays three-valued and NEVER admits `unclassified` (#2272):
// that value means "the source did not say", and a human at a form always has an
// answer. It is reachable by import alone.
export function buildActivityTypePrefill(
  type: "strength" | "cardio" | "sport",
  todayDate: string
): ActivityEditData {
  return {
    id: 0,
    type,
    title: "",
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
      // What a fill maps is a RECORD; the caller decides whether it lands as one or as
      // this session's plan (`asPlan`, #5373).
      plan: null,
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
  // Client-only (#5373): what this row OFFERS while nobody has confirmed it. A planned
  // row's numbers live HERE and its fields stay blank, so the grid paints them as
  // placeholders and typing into one starts from empty rather than landing on top of a
  // value nobody asked for (#1971) — which is also why the plan cannot simply be the
  // fields plus a flag.
  //
  // `null` is the whole answer to "is this a record": confirming or correcting a row
  // moves the plan into the fields and clears it, so the two can never disagree, and
  // the payload, the totals and the judgement all read `setDone`. Never saved — the
  // stored shape is unchanged, and every stored set opens as a record.
  plan: SetPlan | null;
}

// The numbers a planned row offers. Exactly the value half of a set: warmup and RPE
// are what the person says about a row they did, never part of a prescription.
export type SetPlan = Omit<SetEntry, "warmup" | "rpe" | "plan">;
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
  // Client-only (#5371): the set grid states this exercise's weight per set — a
  // "Vary" tap, or the loads differing — and stays that way. Never saved: the
  // entry carries it only so it travels with the exercise through a reorder or a
  // removal above it, where an editor keyed by slot would hand it to the next one.
  varied: boolean;
}

// What the editor can reconstruct of a stored exercise: everything in
// PartEntry except the cardio-only fields and its own client-only state.
export type EditedPart = Omit<PartEntry, "distance" | "durationMin" | "varied">;

// THE PARTS AS THE SERVER WOULD SEE THEM (#5442) — the auto-save signature's view.
// `varied` (#5371) and a set's `plan` (#5373) are PRESENTATIONAL: they decide how the
// grid renders, and `buildActivityPayload` cannot express either. Left in the
// signature they make a change out of a tap that changes no data, and the update path
// then rewrites `updated_at` and — on a row an integration owns — sets `edited = 1`
// permanently, so a re-ingest stops correcting it. Being out of the PAYLOAD is not the
// same as being out of what COUNTS as a change; a client-only field needs both, and a
// third one arriving is meant to be added here.
export const savedShapeOfParts = (parts: PartEntry[]) =>
  parts.map(({ varied: _varied, sets, ...p }) => ({
    ...p,
    sets: sets.map(({ plan: _plan, ...s }) => s),
  }));

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
  // A fresh row is a plan with nothing to offer: an exercise with no history states no
  // prescription, and its one empty row is the plan (#5373).
  plan: BLANK_PLAN,
});
const BLANK_PLAN: SetPlan = {
  weight: "",
  reps: "",
  weightRight: "",
  repsRight: "",
  duration: "",
  durationRight: "",
};
// The same row OFFERED rather than recorded (#5373): its numbers move into the plan and
// its fields go blank. Every plan source runs through this — the coached prescription
// and the Recent panel's session repeat alike — so a ghost can never be minted two ways.
export const asPlan = (s: SetEntry): SetEntry => ({
  ...blankSet(),
  warmup: s.warmup,
  plan: {
    weight: s.weight,
    reps: s.reps,
    weightRight: s.weightRight,
    repsRight: s.repsRight,
    duration: s.duration,
    durationRight: s.durationRight,
  },
});
// Confirming a planned row: the person's own numbers where they typed any — the
// exercise-level load, a corrected rep count — and the plan's where they did not.
// Clearing `plan` is what makes it a record, and it is the ONE patch every gesture that
// confirms a set sends, so the confirm control and a correction cannot drift apart.
export const confirmSet = (s: SetEntry): Partial<SetEntry> =>
  s.plan
    ? {
        weight: s.weight || s.plan.weight,
        reps: s.reps || s.plan.reps,
        weightRight: s.weightRight || s.plan.weightRight,
        repsRight: s.repsRight || s.plan.repsRight,
        duration: s.duration || s.plan.duration,
        durationRight: s.durationRight || s.plan.durationRight,
        plan: null,
      }
    : {};
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
  varied: false,
});

// The load a row STATES: what was typed into it, else what it still offers (#5373).
// A plan of `125 × 12, 120 × 10` is a varying grid before a single row is confirmed,
// so the question has to be asked of what the person is reading.
const shownLoad = (s: SetEntry, side: "weight" | "weightRight") =>
  s[side] || s.plan?.[side] || "";
// One load across every set — both sides of it, for a per-side lift — which the set
// grid states once, above the rows (#5371).
export const sharesLoad = (p: Pick<PartEntry, "sets" | "perSide">) =>
  p.sets.every(
    (s) =>
      shownLoad(s, "weight") === shownLoad(p.sets[0], "weight") &&
      (!p.perSide ||
        shownLoad(s, "weightRight") === shownLoad(p.sets[0], "weightRight"))
  );
// Sets that arrive or are filled at differing loads keep their own weights from then
// on; every writer that puts values into a part's sets says so here, so the grid's
// render never has to write state to remember what it showed.
export const latchVaried = (p: PartEntry): PartEntry =>
  p.varied || sharesLoad(p) ? p : { ...p, varied: true };

// Text a person actually entered into a draft, as opposed to what the form
// derived for them or what they merely tapped (#5111). The close guard asks
// about THIS rather than about `dirty`, which a create trips from a date, an
// effort chip or a gear pick alone — discarding those silently is the natural
// cancel. It is not `namedParts` either: that needs a RECOGNIZED name, and a
// half-typed exercise is precisely the draft no auto-save can hold. The
// generated title is derived, so only an edited one counts.
export function activityDraftHasTypedContent({
  parts,
  title,
  titleEdited,
  notes,
}: {
  parts: PartEntry[];
  title: string;
  titleEdited: boolean;
  notes: string;
}): boolean {
  return (
    parts.some((p) => p.name.trim() !== "") ||
    (titleEdited && title.trim() !== "") ||
    notes.trim() !== ""
  );
}

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
      // A stored set is a record, so an edit opens every set done (#5373) — nothing
      // the person already logged is offered back to them as a plan.
      plan: null,
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
          ? latchVaried({ ...blankPart(), ...g, name: c.name })
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
    return (g.length ? g : [blankPart()]).map((e) =>
      latchVaried({ ...blankPart(), ...e })
    );
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
// the rules live in lib/activity-validate (shared with the training log's
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

// THE SETS THAT ARE A RECORD (#5373). Every set arrives as a plan; a confirmed one is
// what happened. So everything that asks what this part DID — the payload, the volume
// total, the target judgement, the compact sentence, the save gate — asks THIS, and a
// planned row answers none of them however filled its fields look. `setComplete` keeps
// its own meaning (a row whose fields make a set); the two questions are different and
// the payload needs both.
export const setDone = (s: SetEntry) => s.plan === null;
export const doneSets = (p: Pick<PartEntry, "sets">) => p.sets.filter(setDone);

// ---- The compact set notation (#3336) ----

// How many sets a run has to be before stating it as one sentence beats reading the
// rows. Two: "60 kg × 8 × 2" is already shorter than two rows of four controls, and a
// single set has no run to compress — its row IS the sentence.
export const MIN_COMPACT_SETS = 2;

/**
 * The part's sets stated as ONE SENTENCE — "60 kg × 8 × 3" — or null when they are not
 * a uniform run and must stay a grid (#3336, #3228 item 4).
 *
 * REUSES THE ONE NOTATION rather than growing a second (the Recent panel, the training
 * log card, the timeline and the export all render `summarizeExercise`). The editor
 * holds display-unit STRINGS and that function reads canonical kg rows, so the sets are
 * minted through `toKg` and handed over — a round trip that `round(…, 1)` absorbs
 * exactly. Formatting the strings here instead would be a second spelling of "175 lb ×
 * 8 × 3", and the two would drift on the first rounding or unit change.
 *
 * NULL IS THE WHOLE RULE, not a hint: a caller with no sentence has nothing to render
 * in place of the grid, so "a non-uniform part never collapses" cannot be forgotten at
 * a call site.
 *
 * A part qualifies when every set is COMPLETE, none is a WARMUP, and they are all
 * IDENTICAL — because those are the differences the sentence cannot carry. A warmup is
 * excluded from volume and from the target judgment (#338), and "8, 8, 7" states a
 * variation someone chose; folding either into "× 3" would be the summary lying.
 *
 * Uniformity is compared on the RAW STRINGS the fields hold, so "60" and "60.0" read as
 * different sets. That is the safe direction: the disagreement shows the grid, and the
 * grid is what the person was going to look at anyway.
 *
 * RPE IS DELIBERATELY NOT PART OF UNIFORMITY. A rating varies across a run of identical
 * sets by design, and `rpeSummaryText` states a range ("RPE 7–9") beside the sentence —
 * so a part whose sets differ only in effort still compresses, and says so.
 */
export function partSetsSummary(p: PartEntry, unit: WeightUnit): string | null {
  // Over the RECORD, never the plan (#5373): three ghost rows are an offer, and a
  // sentence stating them would announce work nobody has done yet.
  const done = doneSets(p);
  if (done.length < MIN_COMPACT_SETS) return null;
  const first = done[0];
  const uniform = done.every(
    (s) =>
      !s.warmup &&
      s.weight === first.weight &&
      s.reps === first.reps &&
      s.weightRight === first.weightRight &&
      s.repsRight === first.repsRight &&
      s.duration === first.duration &&
      s.durationRight === first.durationRight
  );
  if (!uniform) return null;
  // Every set equals the first, so completeness is one question. A per-side part needs
  // BOTH sides — `setComplete` is satisfied by either, and "L 14 lb × 10 × 3 · R – × 3"
  // is not a sentence anyone wants in place of the row they were about to fill in.
  const complete = p.perSide
    ? sideComplete(p.name, first.weight, first.reps, first.duration) &&
      sideComplete(
        p.name,
        first.weightRight,
        first.repsRight,
        first.durationRight
      )
    : sideComplete(p.name, first.weight, first.reps, first.duration);
  if (!complete) return null;

  const timed = isTimed(p.name);
  const rows: SetRow[] = done.map((s, i) => ({
    set_number: i + 1,
    weight_kg: s.weight ? toKg(Number(s.weight), unit) : null,
    reps: timed ? null : s.reps ? Number(s.reps) : null,
    weight_kg_right:
      p.perSide && s.weightRight ? toKg(Number(s.weightRight), unit) : null,
    reps_right:
      timed || !p.perSide ? null : s.repsRight ? Number(s.repsRight) : null,
    duration_sec: timed ? parseSeconds(s.duration) : null,
    duration_sec_right:
      timed && p.perSide ? parseSeconds(s.durationRight) : null,
    warmup: 0,
  }));
  return summarizeExercise(rows, unit).text;
}

// Working-set volume (weight × reps, summed across sets and both sides) over the sets
// the person confirmed (#5373). Warmups are excluded (#338) — they're not working
// volume.
export function partTotal(p: PartEntry): number {
  return doneSets(p).reduce((sum, s) => {
    if (s.warmup) return sum;
    let v = (Number(s.weight) || 0) * (Number(s.reps) || 0);
    if (p.perSide)
      v += (Number(s.weightRight) || 0) * (Number(s.repsRight) || 0);
    return sum + v;
  }, 0);
}

// EFFORT IS NOT A HUE (#5376). Each level carried its own paint — green, amber,
// rose — the form's OTHER vocabulary for those three: primary action, missed target,
// destructive. The fields are GONE rather than corrected, so a level cannot state a
// colour at all; the picker owns one neutral rest and one brand selection.
export const INTENSITIES: {
  value: string;
  label: string;
  // One-line RPE-style descriptor so the level isn't unexplained (#336). Shown
  // under the picker for the selected level; the choice feeds the calorie MET
  // tier (lib/calorie-estimate), so a note there says the estimate depends on it.
  hint: string;
}[] = [
  {
    value: "easy",
    label: "Easy",
    hint: "Conversational, low effort — RPE 3–4",
  },
  {
    value: "moderate",
    label: "Moderate",
    hint: "Working but can still talk — RPE 5–6",
  },
  {
    value: "hard",
    label: "Hard",
    hint: "Breathless, near-maximal — RPE 7–9",
  },
];

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
