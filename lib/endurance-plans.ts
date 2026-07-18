// Auth-blind write/read cores for endurance event plans (issue #839). Takes profileId
// first and never imports lib/auth — the profileId-first + lib-write-core convention. The
// Server Actions own the auth gate + validation + revalidation; this module owns the SQL
// and the row shaping. Every statement filters profile_id (the scoping rule); every
// mutation runs through writeTx (#468).

import { db, writeTx } from "./db";
import {
  isEnduranceDiscipline,
  type EndurancePlan,
  type EndurancePlanDiscipline,
  type EndurancePlanStatus,
} from "./endurance-plan";

interface PlanRow {
  id: number;
  event_name: string | null;
  discipline: EndurancePlanDiscipline;
  event_date: string;
  target_distance_km: number;
  target_time_sec: number | null;
  status: EndurancePlanStatus;
  notes: string | null;
  completed_on: string | null;
}

function rowToPlan(r: PlanRow): EndurancePlan {
  return {
    id: r.id,
    eventName: r.event_name,
    discipline: r.discipline,
    eventDate: r.event_date,
    targetDistanceKm: r.target_distance_km,
    targetTimeSec: r.target_time_sec,
    status: r.status,
    notes: r.notes,
    completedOn: r.completed_on,
  };
}

const SELECT_COLS = `id, event_name, discipline, event_date, target_distance_km,
  target_time_sec, status, notes, completed_on`;

// Every plan for the profile: active first, then by event date (soonest first).
// Profile-scoped.
export function getEndurancePlans(profileId: number): EndurancePlan[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS}
         FROM endurance_plans
        WHERE profile_id = ?
        ORDER BY (status = 'active') DESC, event_date ASC, id DESC`
    )
    .all(profileId) as PlanRow[];
  return rows.map(rowToPlan);
}

// The active plans (one per discipline at most), soonest event first. Profile-scoped.
export function getActiveEndurancePlans(profileId: number): EndurancePlan[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS}
         FROM endurance_plans
        WHERE profile_id = ? AND status = 'active'
        ORDER BY event_date ASC, id DESC`
    )
    .all(profileId) as PlanRow[];
  return rows.map(rowToPlan);
}

export function getEndurancePlan(
  profileId: number,
  id: number
): EndurancePlan | undefined {
  const r = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM endurance_plans WHERE id = ? AND profile_id = ?`
    )
    .get(id, profileId) as PlanRow | undefined;
  return r ? rowToPlan(r) : undefined;
}

// Validated create/update input. The action parses raw form values; this shape is the
// already-typed values (distance km canonical, time seconds).
export interface EndurancePlanInput {
  eventName?: string | null;
  discipline: EndurancePlanDiscipline;
  eventDate: string;
  targetDistanceKm: number;
  targetTimeSec?: number | null;
  notes?: string | null;
}

// A typed outcome so an action answers from what happened (never unconditionally confirm).
// `duplicate` ⇒ an active plan already exists for the discipline (one-active-per-discipline).
export type EndurancePlanWriteOutcome =
  | { kind: "ok"; id: number }
  | { kind: "invalid" }
  | { kind: "duplicate" };

function sanitize(input: EndurancePlanInput): {
  eventName: string | null;
  discipline: EndurancePlanDiscipline;
  eventDate: string;
  targetDistanceKm: number;
  targetTimeSec: number | null;
  notes: string | null;
} | null {
  if (!isEnduranceDiscipline(input.discipline)) return null;
  const eventDate = (input.eventDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;
  const dist = Number(input.targetDistanceKm);
  if (!Number.isFinite(dist) || dist <= 0 || dist > 1000) return null;
  const time =
    input.targetTimeSec != null && Number.isFinite(Number(input.targetTimeSec))
      ? Math.max(0, Math.round(Number(input.targetTimeSec)))
      : null;
  return {
    eventName: (input.eventName ?? "").trim().slice(0, 120) || null,
    discipline: input.discipline,
    eventDate,
    targetDistanceKm: dist,
    targetTimeSec: time && time > 0 ? time : null,
    notes: (input.notes ?? "").trim().slice(0, 1000) || null,
  };
}

// Whether an ACTIVE plan already exists for the discipline (excluding `exceptId` on an
// edit). Belt-and-braces alongside the partial unique index. Profile-scoped.
function hasActiveForDiscipline(
  profileId: number,
  discipline: EndurancePlanDiscipline,
  exceptId?: number
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM endurance_plans
        WHERE profile_id = ? AND discipline = ? AND status = 'active'
          AND id != ?`
    )
    .get(profileId, discipline, exceptId ?? -1) as { n: number };
  return row.n > 0;
}

// Create a new active plan. Refuses a second active plan for the same discipline
// (one-active-per-discipline). Single IMMEDIATE transaction (#468).
export function createEndurancePlanCore(
  profileId: number,
  input: EndurancePlanInput
): EndurancePlanWriteOutcome {
  const s = sanitize(input);
  if (!s) return { kind: "invalid" };
  return writeTx(() => {
    if (hasActiveForDiscipline(profileId, s.discipline))
      return { kind: "duplicate" as const };
    const id = Number(
      db
        .prepare(
          `INSERT INTO endurance_plans
             (profile_id, event_name, discipline, event_date, target_distance_km,
              target_time_sec, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
        )
        .run(
          profileId,
          s.eventName,
          s.discipline,
          s.eventDate,
          s.targetDistanceKm,
          s.targetTimeSec,
          s.notes
        ).lastInsertRowid
    );
    return { kind: "ok" as const, id };
  });
}

// Edit an existing plan in place (last-write-wins ordinary fields, #467). If the edit
// changes discipline into one that already has another active plan, it's refused.
export function updateEndurancePlanCore(
  profileId: number,
  id: number,
  input: EndurancePlanInput
): EndurancePlanWriteOutcome {
  const s = sanitize(input);
  if (!s) return { kind: "invalid" };
  return writeTx(() => {
    const existing = db
      .prepare("SELECT status FROM endurance_plans WHERE id = ? AND profile_id = ?")
      .get(id, profileId) as { status: EndurancePlanStatus } | undefined;
    if (!existing) return { kind: "invalid" as const };
    // Only an active plan can collide on the one-active-per-discipline rule.
    if (existing.status === "active" && hasActiveForDiscipline(profileId, s.discipline, id))
      return { kind: "duplicate" as const };
    db.prepare(
      `UPDATE endurance_plans
          SET event_name = ?, discipline = ?, event_date = ?, target_distance_km = ?,
              target_time_sec = ?, notes = ?
        WHERE id = ? AND profile_id = ?`
    ).run(
      s.eventName,
      s.discipline,
      s.eventDate,
      s.targetDistanceKm,
      s.targetTimeSec,
      s.notes,
      id,
      profileId
    );
    return { kind: "ok" as const, id };
  });
}

// Set a plan's status (active → completed / abandoned). Completing stamps completed_on;
// any other status clears it. Reactivating is refused when another active plan holds the
// discipline. Profile-scoped, IMMEDIATE.
export function setEndurancePlanStatusCore(
  profileId: number,
  id: number,
  status: EndurancePlanStatus,
  date: string
): EndurancePlanWriteOutcome {
  if (!["active", "completed", "abandoned"].includes(status))
    return { kind: "invalid" };
  return writeTx(() => {
    const existing = db
      .prepare(
        "SELECT discipline FROM endurance_plans WHERE id = ? AND profile_id = ?"
      )
      .get(id, profileId) as { discipline: EndurancePlanDiscipline } | undefined;
    if (!existing) return { kind: "invalid" as const };
    if (status === "active" && hasActiveForDiscipline(profileId, existing.discipline, id))
      return { kind: "duplicate" as const };
    db.prepare(
      `UPDATE endurance_plans
          SET status = ?, completed_on = ?
        WHERE id = ? AND profile_id = ?`
    ).run(status, status === "completed" ? date : null, id, profileId);
    return { kind: "ok" as const, id };
  });
}

// Delete a plan. Nothing is keyed to a plan id (the trajectory is derived, the timeline
// event/completion milestone are date-derived), so this is a plain profile-scoped delete.
// IMMEDIATE.
export function deleteEndurancePlanCore(profileId: number, id: number): boolean {
  return writeTx(() => {
    const res = db
      .prepare("DELETE FROM endurance_plans WHERE id = ? AND profile_id = ?")
      .run(id, profileId);
    return res.changes > 0;
  });
}
