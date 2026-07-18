// Auth-blind write/read cores for the injury layer (issue #838). Takes profileId first and
// never imports lib/auth — the profileId-first + lib-write-core convention. The Server
// Actions own the auth gate + validation + revalidation; this module owns the SQL and the
// row shaping. Every statement filters profile_id (the scoping rule); every mutation runs
// through writeTx (#468).

import { db, writeTx } from "./db";
import {
  injuryConstraints,
  isValidRegion,
  isValidMuscleId,
  parseMuscles,
  parseRegions,
  INJURY_STATUSES,
  type Injury,
  type InjuryConstraint,
  type InjuryStatus,
} from "./injury-model";
import type { MuscleId, MuscleRegion } from "./lifts";

interface InjuryRow {
  id: number;
  label: string;
  regions: string;
  muscles: string | null;
  status: InjuryStatus;
  since: string | null;
  resolved_date: string | null;
  notes: string | null;
  created_at: string;
}

function rowToInjury(r: InjuryRow): Injury {
  return {
    id: r.id,
    label: r.label,
    regions: parseRegions(r.regions),
    muscles: parseMuscles(r.muscles),
    status: r.status,
    since: r.since,
    resolvedDate: r.resolved_date,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

// Every injury for the profile, newest logged first (active/recovering above resolved for
// the chip row). Profile-scoped.
export function getInjuries(profileId: number): Injury[] {
  const rows = db
    .prepare(
      `SELECT id, label, regions, muscles, status, since, resolved_date, notes, created_at
         FROM injuries
        WHERE profile_id = ?
        ORDER BY (status = 'resolved') ASC,
                 COALESCE(since, substr(created_at, 1, 10)) DESC, id DESC`
    )
    .all(profileId) as InjuryRow[];
  return rows.map(rowToInjury);
}

export function getInjury(profileId: number, id: number): Injury | undefined {
  const r = db
    .prepare(
      `SELECT id, label, regions, muscles, status, since, resolved_date, notes, created_at
         FROM injuries WHERE id = ? AND profile_id = ?`
    )
    .get(id, profileId) as InjuryRow | undefined;
  return r ? rowToInjury(r) : undefined;
}

// The NON-resolved injuries shaped into the constraints the recommendation model reads
// (id + label + status + coarse regions). Profile-scoped. The ONE gather every surface's
// coaching input threads through, so the exclusion/tempering is one computation (#221).
export function getInjuryConstraints(profileId: number): InjuryConstraint[] {
  return injuryConstraints(
    getInjuries(profileId).filter((i) => i.status !== "resolved")
  );
}

// Validated input for a create/update. Regions/muscles are already the parsed, valid
// vocabulary arrays (the action validates + filters); label is trimmed non-empty.
export interface InjuryInput {
  label: string;
  regions: MuscleRegion[];
  muscles?: MuscleId[];
  status?: InjuryStatus;
  since?: string | null;
  notes?: string | null;
}

// A typed outcome so an action answers from what happened (never unconditionally confirm).
export type InjuryWriteOutcome =
  { kind: "ok"; id: number } | { kind: "invalid" };

function sanitize(input: InjuryInput): {
  label: string;
  regions: MuscleRegion[];
  muscles: MuscleId[];
  status: InjuryStatus;
  since: string | null;
  notes: string | null;
} | null {
  const label = input.label.trim();
  if (!label) return null;
  const regions = [...new Set(input.regions.filter(isValidRegion))];
  const muscles = [...new Set((input.muscles ?? []).filter(isValidMuscleId))];
  // At least one region (or a fine muscle that rolls up to one) is required — an injury
  // with no affected region can't constrain anything.
  if (regions.length === 0 && muscles.length === 0) return null;
  const status: InjuryStatus =
    input.status && INJURY_STATUSES.includes(input.status)
      ? input.status
      : "active";
  return {
    label: label.slice(0, 120),
    regions,
    muscles,
    status,
    since: input.since ?? null,
    notes: (input.notes ?? "").trim().slice(0, 1000) || null,
  };
}

// Log a new injury. Single IMMEDIATE transaction (#468).
export function logInjuryCore(
  profileId: number,
  input: InjuryInput
): InjuryWriteOutcome {
  const s = sanitize(input);
  if (!s) return { kind: "invalid" };
  return writeTx(() => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO injuries
             (profile_id, label, regions, muscles, status, since, resolved_date, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          profileId,
          s.label,
          JSON.stringify(s.regions),
          s.muscles.length ? JSON.stringify(s.muscles) : null,
          s.status,
          s.since,
          // Born resolved (a historical record) keeps a resolved_date; otherwise null.
          s.status === "resolved" ? (s.since ?? null) : null,
          s.notes
        ).lastInsertRowid
    );
    return { kind: "ok" as const, id };
  });
}

// Edit an existing injury in place (last-write-wins for ordinary fields, #467). Profile-
// scoped; a no-such-row is `invalid`.
export function updateInjuryCore(
  profileId: number,
  id: number,
  input: InjuryInput
): InjuryWriteOutcome {
  const s = sanitize(input);
  if (!s) return { kind: "invalid" };
  return writeTx(() => {
    const existing = db
      .prepare(
        "SELECT status, resolved_date FROM injuries WHERE id = ? AND profile_id = ?"
      )
      .get(id, profileId) as
      { status: InjuryStatus; resolved_date: string | null } | undefined;
    if (!existing) return { kind: "invalid" as const };
    // resolved_date follows status: entering 'resolved' stamps it (keeping any existing);
    // leaving 'resolved' clears it.
    const resolvedDate =
      s.status === "resolved"
        ? (existing.resolved_date ?? s.since ?? null)
        : null;
    db.prepare(
      `UPDATE injuries
          SET label = ?, regions = ?, muscles = ?, status = ?, since = ?,
              resolved_date = ?, notes = ?
        WHERE id = ? AND profile_id = ?`
    ).run(
      s.label,
      JSON.stringify(s.regions),
      s.muscles.length ? JSON.stringify(s.muscles) : null,
      s.status,
      s.since,
      resolvedDate,
      s.notes,
      id,
      profileId
    );
    return { kind: "ok" as const, id };
  });
}

// Set an injury's status (the inline active → recovering → resolved lifecycle). Resolving
// stamps `resolved_date`; un-resolving clears it. Profile-scoped, IMMEDIATE.
export function setInjuryStatusCore(
  profileId: number,
  id: number,
  status: InjuryStatus,
  resolvedDate: string | null
): InjuryWriteOutcome {
  if (!INJURY_STATUSES.includes(status)) return { kind: "invalid" };
  return writeTx(() => {
    const res = db
      .prepare(
        `UPDATE injuries
            SET status = ?, resolved_date = ?
          WHERE id = ? AND profile_id = ?`
      )
      .run(status, status === "resolved" ? resolvedDate : null, id, profileId);
    return res.changes > 0
      ? { kind: "ok" as const, id }
      : { kind: "invalid" as const };
  });
}

// Delete an injury. Nothing is keyed to an injury id (the situation bridge is suggest-only,
// no persistent link; the exclusion disclosure is derived, not stored), so this is a plain
// profile-scoped delete — the row op carries no side-state (#row-ops). IMMEDIATE.
export function deleteInjuryCore(profileId: number, id: number): boolean {
  return writeTx(() => {
    const res = db
      .prepare("DELETE FROM injuries WHERE id = ? AND profile_id = ?")
      .run(id, profileId);
    return res.changes > 0;
  });
}
