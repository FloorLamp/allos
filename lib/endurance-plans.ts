// Auth-blind write/read cores for endurance event plans (issue #839). Takes profileId
// first and never imports lib/auth — the profileId-first + lib-write-core convention. The
// Server Actions own the auth gate + validation + revalidation; this module owns the SQL
// and the row shaping. Every statement filters profile_id (the scoping rule); every
// mutation runs through writeTx (#468).

import { db, writeTx } from "./db";
import {
  DEFAULT_EVENT_KIND,
  disciplineForActivityName,
  eventTitle,
  isEnduranceDiscipline,
  isEventLinkDecided,
  type EndurancePlan,
  type EndurancePlanDiscipline,
  type EndurancePlanStatus,
} from "./endurance-plan";

// The milestones key for a completed plan (#839): completing a plan records a quiet
// timeline milestone (the milestones table is the timeline source), so the achievement
// shows on the Timeline. Cleaned up if the plan is later deleted (row-ops side-state).
function planMilestoneKey(id: number): string {
  return `endurance-plan:${id}`;
}

interface PlanRow {
  id: number;
  kind: string;
  event_name: string | null;
  discipline: EndurancePlanDiscipline | null;
  event_date: string;
  target_distance_km: number | null;
  target_time_sec: number | null;
  status: EndurancePlanStatus;
  notes: string | null;
  completed_on: string | null;
}

function rowToPlan(r: PlanRow): EndurancePlan {
  return {
    id: r.id,
    kind: r.kind,
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

const SELECT_COLS = `id, kind, event_name, discipline, event_date, target_distance_km,
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

// Validated input for a CREATE. The action parses raw form values; this shape is the
// already-typed values (distance km canonical, time seconds). On this shape an omitted
// optional field means EMPTY — a new row states everything about itself.
// `EndurancePlanPatch` below is the edit shape, where omitted means unchanged.
export interface EndurancePlanInput {
  // The open event kind (#3285). Absent means 'race' — what every row was before
  // the store generalized, and the only kind the pre-#3285 form could produce.
  kind?: string | null;
  eventName?: string | null;
  // The cardio pair, both optional since #3285: a lifting meet has neither. They
  // are validated TOGETHER below — one without the other is refused rather than
  // half-stored, so `coachedPlan` never has to decide what a half-pair meant.
  discipline?: EndurancePlanDiscipline | null;
  eventDate: string;
  targetDistanceKm?: number | null;
  targetTimeSec?: number | null;
  notes?: string | null;
}

// The EDIT shape (#2573), the same two-types split #2359/#2571 established on the injury
// core. An absent key means UNCHANGED; a present key is written, including a present
// `null`, which clears. That is the whole difference from `EndurancePlanInput`, where
// absent means empty.
//
// Ordinary edit forms are last-write-wins, and this still is — for the fields the caller
// actually names. What it is no longer is whole-ROW. The injury form bought that property
// by round-tripping the values it never edits as hidden inputs; the plan bar never did,
// so `notes` — a column this module reads back and the plan card RENDERS — was written
// null by every edit. Nothing has failed yet only because nothing has ever written a
// non-null `notes`: the create action reads the same missing field. One importer, one
// notes control or one second write path away from silent data loss.
export type EndurancePlanPatch = Partial<EndurancePlanInput>;

// A typed outcome so an action answers from what happened (never unconditionally confirm).
// `duplicate` ⇒ an active plan already exists for the discipline (one-active-per-discipline).
export type EndurancePlanWriteOutcome =
  { kind: "ok"; id: number } | { kind: "invalid" } | { kind: "duplicate" };

function sanitize(input: EndurancePlanInput): {
  kind: string;
  eventName: string | null;
  discipline: EndurancePlanDiscipline | null;
  eventDate: string;
  targetDistanceKm: number | null;
  targetTimeSec: number | null;
  notes: string | null;
} | null {
  const eventDate = (input.eventDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;
  // The kind is open text, so the only rules are non-empty and bounded. Lowercased
  // so 'Race' and 'race' are one kind rather than two that sort apart.
  const kind =
    (input.kind ?? "").trim().toLowerCase().slice(0, 40) || DEFAULT_EVENT_KIND;
  // The cardio pair, validated as a pair. A discipline the classifier does not know
  // is invalid; a distance outside the plausible band is invalid; and exactly one of
  // the two present is invalid, because a trajectory needs both and a stored half
  // would render as a plan the engine silently declines to coach.
  const discipline =
    input.discipline == null || input.discipline === ("" as string)
      ? null
      : isEnduranceDiscipline(input.discipline)
        ? input.discipline
        : undefined;
  if (discipline === undefined) return null;
  const rawDist = input.targetDistanceKm;
  let dist: number | null = null;
  if (rawDist != null && String(rawDist) !== "") {
    const n = Number(rawDist);
    if (!Number.isFinite(n) || n <= 0 || n > 1000) return null;
    dist = n;
  }
  if ((discipline == null) !== (dist == null)) return null;
  const time =
    input.targetTimeSec != null && Number.isFinite(Number(input.targetTimeSec))
      ? Math.max(0, Math.round(Number(input.targetTimeSec)))
      : null;
  return {
    kind,
    eventName: (input.eventName ?? "").trim().slice(0, 120) || null,
    discipline,
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
  discipline: EndurancePlanDiscipline | null,
  exceptId?: number
): boolean {
  // An event with no cardio discipline is outside the one-active-plan-per-discipline
  // rule entirely — a household may have a meet, a tournament and a 10K on the
  // calendar at once. Stated here rather than left to SQL, where `discipline = NULL`
  // would answer "no duplicate" for the right result by accident (and would answer
  // the same if the column stopped being nullable). The partial UNIQUE index agrees:
  // SQLite treats NULLs as distinct, so it never collides these rows either.
  if (discipline == null) return false;
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
             (profile_id, kind, event_name, discipline, event_date, target_distance_km,
              target_time_sec, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
        )
        .run(
          profileId,
          s.kind,
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

// Merge a patch over the plan as it stands (#2573). `undefined` — the key absent from the
// patch — takes the stored value; anything else, `null` included, is the caller stating a
// new one. Done BEFORE `sanitize` on purpose, so the merged whole still passes every
// cross-field rule the create path enforces (a real event date, a positive target
// distance) rather than each field being validated against a row it no longer belongs to.
function mergePatch(
  existing: EndurancePlan,
  patch: EndurancePlanPatch
): EndurancePlanInput {
  const take = <T>(v: T | undefined, stored: T): T =>
    v === undefined ? stored : v;
  return {
    kind: take(patch.kind, existing.kind),
    eventName: take(patch.eventName, existing.eventName),
    discipline: take(patch.discipline, existing.discipline),
    eventDate: take(patch.eventDate, existing.eventDate),
    targetDistanceKm: take(patch.targetDistanceKm, existing.targetDistanceKm),
    targetTimeSec: take(patch.targetTimeSec, existing.targetTimeSec),
    notes: take(patch.notes, existing.notes),
  };
}

// Edit an existing plan (last-write-wins for the fields the caller names, #467). PARTIAL
// since #2573: a field absent from the patch is left exactly as stored, so a form is only
// ever responsible for what it edits. If the edit changes discipline into one that already
// has another active plan, it's refused. Profile-scoped; a no-such-row is `invalid`.
export function updateEndurancePlanCore(
  profileId: number,
  id: number,
  patch: EndurancePlanPatch
): EndurancePlanWriteOutcome {
  return writeTx(() => {
    // Read the whole row, not just `status`: it is both the merge base and the existence
    // check, and one read inside the transaction is what makes "unchanged" mean unchanged
    // rather than "as it looked before we started".
    const existing = getEndurancePlan(profileId, id);
    if (!existing) return { kind: "invalid" as const };
    const s = sanitize(mergePatch(existing, patch));
    if (!s) return { kind: "invalid" as const };
    // Only an active plan can collide on the one-active-per-discipline rule.
    if (
      existing.status === "active" &&
      hasActiveForDiscipline(profileId, s.discipline, id)
    )
      return { kind: "duplicate" as const };
    db.prepare(
      `UPDATE endurance_plans
          SET kind = ?, event_name = ?, discipline = ?, event_date = ?,
              target_distance_km = ?, target_time_sec = ?, notes = ?
        WHERE id = ? AND profile_id = ?`
    ).run(
      s.kind,
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
      .get(id, profileId) as
      { discipline: EndurancePlanDiscipline | null } | undefined;
    if (!existing) return { kind: "invalid" as const };
    if (
      status === "active" &&
      hasActiveForDiscipline(profileId, existing.discipline, id)
    )
      return { kind: "duplicate" as const };
    db.prepare(
      `UPDATE endurance_plans
          SET status = ?, completed_on = ?
        WHERE id = ? AND profile_id = ?`
    ).run(status, status === "completed" ? date : null, id, profileId);
    // Completing records a quiet timeline milestone (#839). Re-completing is idempotent
    // (INSERT OR IGNORE on the unique (profile_id, key) index).
    if (status === "completed") {
      // Re-read through the shared reader so the milestone title comes off the ONE
      // naming rule (`eventTitle`) every other surface uses — a meet with no cardio
      // pair has no "21.1 km Run" to fall back on, and duplicating the fallback here
      // is how the card and the milestone would have drifted.
      const plan = getEndurancePlan(profileId, id);
      if (plan) {
        const name = eventTitle(plan);
        db.prepare(
          `INSERT OR IGNORE INTO milestones
             (profile_id, key, kind, threshold, title, detail, achieved_on)
           VALUES (?, ?, 'endurance', ?, ?, ?, ?)`
        ).run(
          profileId,
          planMilestoneKey(id),
          id,
          `Event completed: ${name}`,
          `You completed your ${name} event plan.`,
          date
        );
      }
    }
    return { kind: "ok" as const, id };
  });
}

// Delete a plan. The trajectory is derived and the timeline event is date-derived;
// the two things keyed to a plan id are cleared here: its completion milestone, and
// the activities linked to it (#3285 item 2), which are UNLINKED and kept — a logged
// session is training history and outlives the event it was entered for. The FK is
// `ON DELETE SET NULL` and agrees; the explicit UPDATE keeps this transaction
// correct on a connection where the pragma is off (the migration runner's).
//
// The person's decision is left exactly as it is, on both paths. A session whose link
// a person set by hand keeps its decision ordinal when the event goes away, so the
// next sync cannot quietly re-attach it to some other event that day; a session the
// sync linked on its own carries no decision and stays a candidate. IMMEDIATE.
export function deleteEndurancePlanCore(
  profileId: number,
  id: number
): boolean {
  return writeTx(() => {
    // Row-ops side-state (#row-ops): clear the completion milestone keyed to this plan so a
    // deleted plan leaves no orphaned timeline milestone.
    db.prepare("DELETE FROM milestones WHERE profile_id = ? AND key = ?").run(
      profileId,
      planMilestoneKey(id)
    );
    db.prepare(
      `UPDATE activities SET endurance_plan_id = NULL
        WHERE endurance_plan_id = ? AND profile_id = ?`
    ).run(id, profileId);
    const res = db
      .prepare("DELETE FROM endurance_plans WHERE id = ? AND profile_id = ?")
      .run(id, profileId);
    return res.changes > 0;
  });
}

// ── Linked activities (#3285 item 2) ──────────────────────────────────────────────
//
// `activities.endurance_plan_id` attaches a logged session to the event it was the
// result of. An event's result is the set of activities pointing at it; an activity
// is the result of at most one event.

// The ordinal a decision about an event link is recorded with (#3285 item 2): one
// past the newest this profile has. Taken inside the caller's IMMEDIATE transaction,
// so the write lock is what makes it strictly increasing — no clock, no ties. Gaps
// are fine (a refused link burns one); only the order is read. A merge deletes rows
// and with them their ordinals, and that is harmless for the same reason: the next
// decision only has to beat the ones still standing.
function nextEventLinkDecisionSeq(profileId: number): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(MAX(endurance_link_decided_seq), 0) + 1 AS next
           FROM activities WHERE profile_id = ?`
      )
      .get(profileId) as { next: number }
  ).next;
}

// Link an activity to an event, MANUALLY. Both rows must be the profile's, the
// activity must be logged on the event's day, and the event must not be ABANDONED —
// the one statement carries every rule, so a cross-profile id, an off-day session or
// an abandoned event simply changes nothing. IMMEDIATE.
//
// An abandoned event never attracts a result, by hand or by sync: the person said the
// event did not happen for them, and a result would contradict it on the event's own
// page ("Abandoned · Result: Harbor 10k"). The auto-link says the same thing in its
// own WHERE clause (`linkRaceActivityCore`); the page stops offering the button.
// Detaching stays available, so a result attached before the event was abandoned can
// still be taken off.
//
// A hand link RECORDS the decision (`endurance_link_decided_seq`), it does not clear
// it: the person has decided this session's link, and the link column already records
// which event they chose. Clearing it instead would leave the session free the moment
// anything removed that link without them — deleting the event, a merge, an undo —
// and the next sync would attach it to the very event they detached it from.
export function linkEventActivityCore(
  profileId: number,
  planId: number,
  activityId: number
): boolean {
  return writeTx(
    () =>
      db
        .prepare(
          `UPDATE activities
              SET endurance_plan_id = ?, endurance_link_decided_seq = ?
            WHERE id = ? AND profile_id = ?
              AND date = (SELECT event_date FROM endurance_plans
                           WHERE id = ? AND profile_id = ?
                             AND status IN ('active', 'completed'))`
        )
        .run(
          planId,
          nextEventLinkDecisionSeq(profileId),
          activityId,
          profileId,
          planId,
          profileId
        ).changes > 0
  );
}

// Detach an activity from whatever event it is linked to. Profile-scoped; false
// when the row is not the profile's or was not linked. IMMEDIATE.
//
// The detach is REMEMBERED (`endurance_link_decided_seq`): this is a person saying the
// session is not that event's result, and without it the auto-link runs again on the
// next value-changing re-sync. Re-linking by hand does not clear the memory — it
// records a NEWER decision, and both are the person's; the newer one wins wherever
// the two ever have to be resolved against each other.
export function unlinkEventActivityCore(
  profileId: number,
  activityId: number
): boolean {
  return writeTx(
    () =>
      db
        .prepare(
          `UPDATE activities
              SET endurance_plan_id = NULL, endurance_link_decided_seq = ?
            WHERE id = ? AND profile_id = ? AND endurance_plan_id IS NOT NULL`
        )
        .run(nextEventLinkDecisionSeq(profileId), activityId, profileId)
        .changes > 0
  );
}

// The AUTO-link, from the one hint a source supplies: Strava labels an activity's
// `workout_type` "race". A race-labelled cardio session whose title maps onto a
// discipline links to the profile's event on that day IN that discipline — an event
// with no discipline (a meet, a tournament) is not a race and is never a candidate,
// and a session already linked, by hand or by an earlier sync, is left exactly where
// it is. Active or completed events both count: a race synced the evening after it
// was marked done still belongs to it. An abandoned event never attracts a result.
// A session whose link a person has SET by hand — attached or detached — is never
// claimed again, whatever the source later says about it and whatever later happens
// to the link itself (`isEventLinkDecided`).
// Called by the integration upsert after every insert or value-changing update;
// returns whether a link was written. IMMEDIATE (a SAVEPOINT under the sync's lock).
export function linkRaceActivityCore(
  profileId: number,
  activityId: number
): boolean {
  return writeTx(() => {
    const a = db
      .prepare(
        `SELECT date, type, title, workout_type, endurance_plan_id,
                endurance_link_decided_seq
           FROM activities WHERE id = ? AND profile_id = ?`
      )
      .get(activityId, profileId) as
      | {
          date: string;
          type: string;
          title: string;
          workout_type: string | null;
          endurance_plan_id: number | null;
          endurance_link_decided_seq: number | null;
        }
      | undefined;
    if (
      !a ||
      a.endurance_plan_id != null ||
      isEventLinkDecided(a.endurance_link_decided_seq) ||
      a.type !== "cardio" ||
      a.workout_type !== "race"
    )
      return false;
    const discipline = disciplineForActivityName(a.title);
    if (!discipline) return false;
    const plan = db
      .prepare(
        `SELECT id FROM endurance_plans
          WHERE profile_id = ? AND event_date = ? AND discipline = ?
            AND status IN ('active', 'completed')
          ORDER BY (status = 'active') DESC, id DESC LIMIT 1`
      )
      .get(profileId, a.date, discipline) as { id: number } | undefined;
    if (!plan) return false;
    db.prepare(
      `UPDATE activities SET endurance_plan_id = ? WHERE id = ? AND profile_id = ?`
    ).run(plan.id, activityId, profileId);
    return true;
  });
}
