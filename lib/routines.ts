// Routine write cores + reads (#738, Pillar 3 of the workout-UX epic #732).
//
// These are AUTH-BLIND (the profileId-first convention): every function takes
// `profileId` first and NEVER imports lib/auth — the auth gate lives entirely in the
// calling Server Action (app/(app)/training/actions.ts). Templates and custom
// routines share ONE runtime representation (migration 039): adopting a template
// COPIES it into the routine tables, after which the engine (#740) only ever reads
// the DB shape (#559: it resolves and fills, it never invents a program).
//
// The load-bearing invariant is ACTIVATION replacing training-scope frequency
// targets: activating a routine deletes the profile's `frequency_targets` rows with
// `scope_kind IN ('region','group','type')` and inserts the routine's DECLARED derived
// targets — but NEVER touches `food_group` rows (nutrition, migration 031). Deriving
// those targets is ONE pure computation (`deriveRoutineTargets`) so a template's
// declared targets and a custom routine's day-derived targets can't fork.

import { db, writeTx, today } from "./db";
import {
  regionForExercise,
  exerciseHistoryKey,
  type MuscleRegion,
} from "./lifts";
import { getProfileSetting, setProfileSetting } from "./settings";
import {
  resolveTodayRoutineDayIndex,
  sessionCreditsDay,
} from "./workout-recommendation";
import { parseComponents } from "./types/training";
import {
  effectiveCycleStart,
  weekInCycle as weekInCycleOf,
  isDeloadWeek as isDeloadWeekOf,
  weeksUntilDeload as weeksUntilDeloadOf,
} from "./mesocycle";
import type { RoutineTemplate } from "./routine-templates";
import { getRoutineTemplate } from "./routine-templates";
import {
  deriveRoutineTargets,
  type RoutineDayInput,
  type RoutineInput,
} from "./routine-derive";
import type {
  Routine,
  RoutineDay,
  RoutineSlot,
  RoutineWithDays,
} from "./types";

// Re-export the pure authoring helpers so callers can `import { ... } from
// "@/lib/routines"` as one surface; the implementations live in the db-free
// lib/routine-derive.ts so the pure tier can test them without importing lib/db.
export {
  deriveRoutineTargets,
  deriveFocusFromCandidates,
  validateRoutineInput,
  TRAINING_TARGET_SCOPES,
} from "./routine-derive";
export type {
  RoutineInput,
  RoutineDayInput,
  RoutineSlotInput,
} from "./routine-derive";

// ── Reads ────────────────────────────────────────────────────────────────────
function parseFocus(json: string): MuscleRegion[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as MuscleRegion[]) : [];
  } catch {
    return [];
  }
}
function parseCandidates(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

export function getRoutines(profileId: number): Routine[] {
  return db
    .prepare(
      `SELECT id, name, source, template_id, active, started_date, position,
              cycle_weeks, created_at
         FROM routines
        WHERE profile_id = ?
        ORDER BY active DESC, created_at DESC, id DESC`
    )
    .all(profileId) as Routine[];
}

export function getActiveRoutine(profileId: number): RoutineWithDays | null {
  const row = db
    .prepare(
      `SELECT id, name, source, template_id, active, started_date, position,
              cycle_weeks, created_at
         FROM routines
        WHERE profile_id = ? AND active = 1
        ORDER BY id DESC LIMIT 1`
    )
    .get(profileId) as Routine | undefined;
  if (!row) return null;
  return getRoutineWithDays(profileId, row.id);
}

export function getRoutineWithDays(
  profileId: number,
  routineId: number
): RoutineWithDays | null {
  const routine = db
    .prepare(
      `SELECT id, name, source, template_id, active, started_date, position,
              cycle_weeks, created_at
         FROM routines
        WHERE id = ? AND profile_id = ?`
    )
    .get(routineId, profileId) as Routine | undefined;
  if (!routine) return null;

  // Child reads are scoped through the parent routine (they carry no profile_id):
  // the JOIN to routines filters profile_id, per the scoping rule.
  const dayRows = db
    .prepare(
      `SELECT rd.id, rd.routine_id, rd.ordinal, rd.label, rd.focus
         FROM routine_days rd
         JOIN routines r ON r.id = rd.routine_id
        WHERE rd.routine_id = ? AND r.profile_id = ?
        ORDER BY rd.ordinal, rd.id`
    )
    .all(routineId, profileId) as (Omit<RoutineDay, "focus"> & {
    focus: string;
  })[];

  const slotRows = db
    .prepare(
      `SELECT rs.id, rs.routine_day_id, rs.ordinal, rs.candidates, rs.sets,
              rs.rep_min, rs.rep_max
         FROM routine_slots rs
         JOIN routine_days rd ON rd.id = rs.routine_day_id
         JOIN routines r ON r.id = rd.routine_id
        WHERE rd.routine_id = ? AND r.profile_id = ?
        ORDER BY rs.routine_day_id, rs.ordinal, rs.id`
    )
    .all(routineId, profileId) as (Omit<RoutineSlot, "candidates"> & {
    candidates: string;
  })[];

  const slotsByDay = new Map<number, RoutineSlot[]>();
  for (const s of slotRows) {
    const list = slotsByDay.get(s.routine_day_id) ?? [];
    list.push({ ...s, candidates: parseCandidates(s.candidates) });
    slotsByDay.set(s.routine_day_id, list);
  }

  return {
    ...routine,
    days: dayRows.map((d) => ({
      ...d,
      focus: parseFocus(d.focus),
      slots: slotsByDay.get(d.id) ?? [],
    })),
  };
}

// Every routine with its days + slots — the shape the builder UI (#739) reads to
// render the list (day count = days.length) and pre-fill the editor. A thin fan-out
// over getRoutineWithDays; profile counts are small, so N+1 is fine here.
export function getRoutinesWithDays(profileId: number): RoutineWithDays[] {
  return getRoutines(profileId)
    .map((r) => getRoutineWithDays(profileId, r.id))
    .filter((r): r is RoutineWithDays => r !== null);
}

// ── Writes ────────────────────────────────────────────────────────────────────

// Insert a routine's days + slots. Shared by adopt/create/update; caller owns the
// enclosing writeTx.
function insertDays(
  routineId: number,
  days: RoutineDayInput[] | RoutineTemplate["days"]
): void {
  const dayStmt = db.prepare(
    `INSERT INTO routine_days (routine_id, ordinal, label, focus)
       VALUES (?, ?, ?, ?)`
  );
  const slotStmt = db.prepare(
    `INSERT INTO routine_slots
       (routine_day_id, ordinal, candidates, sets, rep_min, rep_max)
       VALUES (?, ?, ?, ?, ?, ?)`
  );
  days.forEach((d, di) => {
    const dayId = Number(
      dayStmt.run(routineId, di, d.label, JSON.stringify(d.focus))
        .lastInsertRowid
    );
    d.slots.forEach((s, si) => {
      // Template slots and builder-input slots share the same shape.
      slotStmt.run(
        dayId,
        si,
        JSON.stringify(s.candidates),
        s.sets,
        s.repMin,
        s.repMax
      );
    });
  });
}

// Adopt a catalog template: COPY it into the profile's routine tables (source
// 'template', inactive). Returns the new routine id. Does NOT touch frequency
// targets — that happens on activation. Throws on an unknown template id.
export function adoptTemplate(profileId: number, templateId: string): number {
  const template = getRoutineTemplate(templateId);
  if (!template) {
    throw new Error(`Unknown routine template: ${templateId}`);
  }
  return writeTx(() => {
    const routineId = Number(
      db
        .prepare(
          `INSERT INTO routines
             (name, source, template_id, active, cycle_weeks, profile_id)
             VALUES (?, 'template', ?, 0, ?, ?)`
        )
        .run(template.name, template.id, template.cycleWeeks, profileId)
        .lastInsertRowid
    );
    insertDays(routineId, template.days);
    return routineId;
  });
}

// Author a custom routine from builder input (source 'custom', inactive). Returns
// the new routine id.
export function createCustomRoutine(
  profileId: number,
  input: RoutineInput
): number {
  return writeTx(() => {
    const routineId = Number(
      db
        .prepare(
          `INSERT INTO routines
             (name, source, template_id, active, cycle_weeks, profile_id)
             VALUES (?, 'custom', NULL, 0, ?, ?)`
        )
        .run(input.name, input.cycleWeeks ?? null, profileId).lastInsertRowid
    );
    insertDays(routineId, input.days);
    return routineId;
  });
}

// Edit a routine: rename + REPLACE its days/slots (the row-ops convention — the old
// children are deleted through the parent, never cascade-stranded). Editing an
// adopted template is just editing your routine. Returns true if the routine existed
// and was updated. Does not re-activate or change targets; if the routine is active,
// the caller should re-activate to refresh derived targets.
export function updateRoutine(
  profileId: number,
  routineId: number,
  input: RoutineInput
): boolean {
  return writeTx(() => {
    const owned = db
      .prepare(`SELECT id FROM routines WHERE id = ? AND profile_id = ?`)
      .get(routineId, profileId) as { id: number } | undefined;
    if (!owned) return false;
    db.prepare(
      `UPDATE routines SET name = ?, cycle_weeks = ?
         WHERE id = ? AND profile_id = ?`
    ).run(input.name, input.cycleWeeks ?? null, routineId, profileId);
    deleteRoutineChildren(profileId, routineId);
    insertDays(routineId, input.days);
    return true;
  });
}

// Delete a routine's children (slots → days), scoped through the parent routine.
// Slots first (they FK routine_days). Caller owns the writeTx.
function deleteRoutineChildren(profileId: number, routineId: number): void {
  db.prepare(
    `DELETE FROM routine_slots
       WHERE routine_day_id IN (
         SELECT rd.id FROM routine_days rd
           JOIN routines r ON r.id = rd.routine_id
          WHERE rd.routine_id = ? AND r.profile_id = ?
       )`
  ).run(routineId, profileId);
  db.prepare(
    `DELETE FROM routine_days
       WHERE routine_id IN (
         SELECT id FROM routines WHERE id = ? AND profile_id = ?
       )`
  ).run(routineId, profileId);
}

// Delete a routine and all its children (explicit, never cascade-stranded — #199).
// Frequency targets are LEFT ALONE: once inserted on activation they are ordinary
// user-owned targets (same as deactivation keeps them). Returns true if it existed.
export function deleteRoutine(profileId: number, routineId: number): boolean {
  return writeTx(() => {
    const owned = db
      .prepare(`SELECT id FROM routines WHERE id = ? AND profile_id = ?`)
      .get(routineId, profileId) as { id: number } | undefined;
    if (!owned) return false;
    deleteRoutineChildren(profileId, routineId);
    db.prepare(`DELETE FROM routines WHERE id = ? AND profile_id = ?`).run(
      routineId,
      profileId
    );
    return true;
  });
}

// The training-scope frequency targets an activation would replace — surfaced so the
// confirm dialog (#739) can list them, and so the confirm only appears when there ARE
// targets to replace (a fresh profile has none → activation is one tap, #719).
export function getTrainingTargetsToReplace(
  profileId: number
): { scope_kind: string; scope_value: string; per_week: number }[] {
  return db
    .prepare(
      `SELECT scope_kind, scope_value, per_week
         FROM frequency_targets
        WHERE profile_id = ?
          AND scope_kind IN ('region','group','type')
        ORDER BY scope_kind, scope_value`
    )
    .all(profileId) as {
    scope_kind: string;
    scope_value: string;
    per_week: number;
  }[];
}

// Activate a routine — the load-bearing write core. In ONE writeTx:
//   1. deactivate every other routine (single-active invariant);
//   2. delete the profile's training-scope frequency_targets
//      (scope_kind IN region/group/type) — NEVER food_group;
//   3. insert the routine's DERIVED targets (deriveRoutineTargets);
//   4. set active=1, started_date=today, position=0.
// Returns false if the routine doesn't exist / isn't the profile's.
export function activateRoutine(profileId: number, routineId: number): boolean {
  return writeTx(() => {
    const routine = getRoutineWithDays(profileId, routineId);
    if (!routine) return false;

    const targets = deriveRoutineTargets({
      source: routine.source,
      templateId: routine.template_id,
      days: routine.days,
    });

    // Single-active: deactivate the rest in the same transaction.
    db.prepare(
      `UPDATE routines SET active = 0 WHERE profile_id = ? AND id != ?`
    ).run(profileId, routineId);

    // Replace ONLY training-scope targets — food_group (nutrition) is untouched.
    db.prepare(
      `DELETE FROM frequency_targets
         WHERE profile_id = ?
           AND scope_kind IN ('region','group','type')`
    ).run(profileId);

    const insertTarget = db.prepare(
      `INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id)
         VALUES (?, ?, ?, ?)`
    );
    for (const t of targets) {
      insertTarget.run(t.scopeKind, t.scopeValue, t.perWeek, profileId);
    }

    db.prepare(
      `UPDATE routines SET active = 1, started_date = ?, position = 0
         WHERE id = ? AND profile_id = ?`
    ).run(today(profileId), routineId, profileId);
    return true;
  });
}

// Manually restart the mesocycle (#741): set the routine's `started_date` to today,
// so week-in-cycle counts fresh from now (a deliberate reset, distinct from the
// automatic pause re-anchoring). Only affects a routine that HAS a cycle; a no-op
// (returns false) for a routine without `cycle_weeks`, or one that isn't the
// profile's. The rotation `position` is intentionally left alone — restarting the
// deload clock doesn't skip the user forward in the day sequence.
export function restartRoutineCycle(
  profileId: number,
  routineId: number
): boolean {
  return writeTx(() => {
    const owned = db
      .prepare(
        `SELECT cycle_weeks FROM routines WHERE id = ? AND profile_id = ?`
      )
      .get(routineId, profileId) as { cycle_weeks: number | null } | undefined;
    if (!owned || owned.cycle_weeks == null) return false;
    db.prepare(
      `UPDATE routines SET started_date = ? WHERE id = ? AND profile_id = ?`
    ).run(today(profileId), routineId, profileId);
    return true;
  });
}

// ── Session crediting → position advance (#740) ─────────────────────────────────

// The per-profile marker holding the last profile-local DATE the active routine's
// position advanced, keyed by routine id. Enforces "advance at most once per
// profile-local day". Id-keyed, so a deleted routine leaves a harmless dead row
// (integer ids never recycle — the #203 convention), no cleanup obligation.
function advanceMarkerKey(routineId: number): string {
  return `routine_position_advanced_${routineId}`;
}

// Advance the active routine's rotation cursor when a logged session CREDITS
// today's routine day — the write half of the crediting rule (#740). Called from
// the activity write path (saveActivity) with the session's strength regions and
// whether it included cardio, plus the profile-local date the session belongs to.
//
// It advances `position` by one AT MOST ONCE per profile-local day (the marker
// guards re-advance within a day, re-read under the write lock so two concurrent
// writers can't both advance), and ONLY on a credited session — a skipped/rest day
// or an off-focus session never advances it, so a missed day stays next up. A no-op
// (returns false) when there's no active routine, the routine has no days, the
// session doesn't credit the current day, or the day already advanced.
export function creditRoutineSession(
  profileId: number,
  onDate: string,
  session: { regions: MuscleRegion[]; hasCardio: boolean }
): boolean {
  const routine = getActiveRoutine(profileId);
  if (!routine) return false;

  // Same cursor→today's-day computation the recommendation core uses to show the
  // session (#831) — so a logged session can't advance past a different day than
  // the one the user was shown and trained.
  const idx = resolveTodayRoutineDayIndex(routine);
  if (idx === null) return false;
  const day = routine.days[idx];
  if (!sessionCreditsDay(session, day.focus)) return false;

  const markerKey = advanceMarkerKey(routine.id);
  return writeTx(() => {
    // Re-read the marker inside the write lock: another writer (a second save this
    // tick) may have advanced already, and the guard must see its committed marker.
    if (getProfileSetting(profileId, markerKey) === onDate) return false;
    db.prepare(
      `UPDATE routines SET position = position + 1
         WHERE id = ? AND profile_id = ? AND active = 1`
    ).run(routine.id, profileId);
    setProfileSetting(profileId, markerKey, onDate);
    return true;
  });
}

// ── Mesocycle & deload awareness (#741) ─────────────────────────────────────────

// The credited-session DATES for a routine, since `since` (inclusive) — reusing the
// SAME crediting rule as the #740 position advance (sessionCreditsDay), so the cycle's
// pause detection and the rotation cursor can't disagree about what counts as
// "training the routine" (one computation). A date credits when its aggregated session
// (that day's strength regions + whether it included cardio) credits ANY of the
// routine's days. Derived entirely from logged data — no stored link column.
//
// Profile-scoped: exercise_sets reaches profile_id via the JOIN to activities;
// activities carries it directly.
export function getRoutineCreditedDates(
  profileId: number,
  routine: RoutineWithDays,
  since: string
): string[] {
  const dayFocuses = routine.days.map((d) => d.focus);
  if (dayFocuses.length === 0) return [];

  const byDate = new Map<
    string,
    { regions: Set<MuscleRegion>; hasCardio: boolean }
  >();
  const ensure = (d: string) => {
    let e = byDate.get(d);
    if (!e) {
      e = { regions: new Set(), hasCardio: false };
      byDate.set(d, e);
    }
    return e;
  };

  // Strength regions per date (via exerciseHistoryKey → LiftDef.region), matching the
  // saveActivity crediting gather.
  const strengthRows = db
    .prepare(
      `SELECT a.date AS date, s.exercise AS exercise
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ? AND a.date >= ?`
    )
    .all(profileId, since) as { date: string; exercise: string }[];
  for (const r of strengthRows) {
    const reg = regionForExercise(r.exercise);
    if (reg) ensure(r.date).regions.add(reg);
  }

  // Cardio-bearing dates: a cardio activity or a component of type cardio — the same
  // hasCardio test the write path uses.
  const activityRows = db
    .prepare(
      `SELECT date, type, components FROM activities
        WHERE profile_id = ? AND date >= ?`
    )
    .all(profileId, since) as {
    date: string;
    type: string;
    components: string | null;
  }[];
  for (const r of activityRows) {
    const hasCardio =
      r.type === "cardio" ||
      parseComponents(r.components).some((c) => c.type === "cardio");
    if (hasCardio) ensure(r.date).hasCardio = true;
  }

  const credited: string[] = [];
  for (const [date, sig] of byDate) {
    const session = { regions: [...sig.regions], hasCardio: sig.hasCardio };
    if (dayFocuses.some((f) => sessionCreditsDay(session, f)))
      credited.push(date);
  }
  return credited.sort();
}

// The resolved deload/cycle state of the profile's ACTIVE routine, or null when
// there is none / it declares no usable cycle (`cycle_weeks` NULL, < 2, or no
// started_date) — the null case is what makes an un-cycled routine byte-for-byte the
// prior behavior everywhere. This is the ONE gather (#221/#741) every surface reads:
// the recommendation core's deload phrasing, the workout-nudge softening, the
// behind-target suppression, the #742 volume-band hook, and the plateau
// cross-reference all key on THIS result, so they can never disagree about "is it a
// deload week."
export interface RoutineCycleStatus {
  routineId: number;
  cycleWeeks: number;
  effectiveStart: string; // pause-re-anchored cycle start
  weekInCycle: number; // 0-based
  isDeloadWeek: boolean;
  weeksUntilDeload: number; // 0 when this IS the deload week
}

export function getRoutineCycleStatus(
  profileId: number,
  today: string
): RoutineCycleStatus | null {
  const routine = getActiveRoutine(profileId);
  if (
    !routine ||
    routine.cycle_weeks == null ||
    routine.cycle_weeks < 2 ||
    !routine.started_date
  )
    return null;

  const cycleWeeks = routine.cycle_weeks;
  const credited = getRoutineCreditedDates(
    profileId,
    routine,
    routine.started_date
  );
  const effectiveStart = effectiveCycleStart(
    routine.started_date,
    credited,
    today
  );
  const week = weekInCycleOf(effectiveStart, today, cycleWeeks);
  return {
    routineId: routine.id,
    cycleWeeks,
    effectiveStart,
    weekInCycle: week,
    isDeloadWeek: isDeloadWeekOf(week, cycleWeeks),
    weeksUntilDeload: weeksUntilDeloadOf(week, cycleWeeks),
  };
}

// The deload context the activity form reads (#923): whether the active routine places
// today in its deload week, and the set of canonical (variant-collapsed via
// exerciseHistoryKey) exercise keys that appear as a candidate in any of the routine's
// slots. The form shaves ONLY a lift that resolves to a routine slot — the cycle is the
// routine's property, so a non-routine accessory keeps its normal progression. Reads the
// SAME getRoutineCycleStatus gather every deload surface uses (#221/#741). `routineKeys`
// is empty off a deload week (the form never shaves then), so a non-cycled / routine-less
// profile is byte-for-byte the prior behavior.
export interface FormDeloadContext {
  isDeloadWeek: boolean;
  routineKeys: string[];
}

export function getFormDeloadContext(
  profileId: number,
  todayStr: string
): FormDeloadContext {
  const cycle = getRoutineCycleStatus(profileId, todayStr);
  if (!cycle?.isDeloadWeek) return { isDeloadWeek: false, routineKeys: [] };
  const routine = getActiveRoutine(profileId);
  const keys = new Set<string>();
  if (routine)
    for (const d of routine.days)
      for (const s of d.slots)
        for (const c of s.candidates) keys.add(exerciseHistoryKey(c));
  return { isDeloadWeek: true, routineKeys: [...keys] };
}

// Deactivate a routine. KEEPS the derived frequency targets (they're now ordinary
// user-editable targets — the confirm copy in #739 states this). Returns false if the
// routine doesn't exist / isn't the profile's / wasn't active.
export function deactivateRoutine(
  profileId: number,
  routineId: number
): boolean {
  return writeTx(() => {
    const res = db
      .prepare(
        `UPDATE routines SET active = 0
           WHERE id = ? AND profile_id = ? AND active = 1`
      )
      .run(routineId, profileId);
    return res.changes > 0;
  });
}
