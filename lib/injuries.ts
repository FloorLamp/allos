// Auth-blind write/read cores for the injury layer (issue #838). Takes profileId first and
// never imports lib/auth — the profileId-first + lib-write-core convention. The Server
// Actions own the auth gate + validation + revalidation; this module owns the SQL and the
// row shaping. Every statement filters profile_id (the scoping rule); every mutation runs
// through writeTx (#468).

import { db, writeTx } from "./db";
import { sqlNow } from "./clock";
import {
  injuryConstraints,
  isDateStr,
  isValidLaterality,
  isValidMovementPattern,
  isValidRegion,
  isValidMuscleId,
  parseInjuryExercises,
  parseLoadFactor,
  parseMovements,
  parseMuscles,
  parseRegions,
  temperedRegions,
  INJURY_STATUSES,
  type Injury,
  type InjuryConstraint,
  type InjuryLaterality,
  type InjuryStatus,
} from "./injury-model";
import { exerciseHistoryKey, type MovementPattern } from "./lifts";
import type { MuscleId, MuscleRegion } from "./lifts";

// The columns every read selects — one list so a new #2024 field can't be selected by one
// reader and missed by another.
const INJURY_COLUMNS = `id, label, regions, muscles, status, since, resolved_date, notes,
                        created_at, laterality, movements, exercises, load_factor,
                        review_date`;

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
  laterality: string | null;
  movements: string | null;
  exercises: string | null;
  load_factor: number | null;
  review_date: string | null;
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
    // #2024 — defensive reads: a stored value outside the vocabulary is dropped rather
    // than thrown, exactly like `regions`/`muscles` above, so a legacy or hand-edited row
    // degrades to the region-scoped constraint it always was.
    laterality:
      r.laterality != null && isValidLaterality(r.laterality)
        ? r.laterality
        : null,
    movements: parseMovements(r.movements),
    exercises: parseInjuryExercises(r.exercises),
    loadFactor: r.load_factor != null ? parseLoadFactor(r.load_factor) : null,
    reviewDate:
      r.review_date != null && isDateStr(r.review_date) ? r.review_date : null,
  };
}

// Every injury for the profile, newest logged first (active/recovering above resolved for
// the chip row). Profile-scoped.
export function getInjuries(profileId: number): Injury[] {
  const rows = db
    .prepare(
      `SELECT ${INJURY_COLUMNS}
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
      `SELECT ${INJURY_COLUMNS}
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

// The recovering-injury context the activity form reads (#1144): the coarse regions
// returning from a RECOVERING injury (#838), so the live logger tempers a lift whose
// region is one of them — reading the SAME temperedRegions gather the Analyze/detail
// panel and coaching card already use, so the form and its deep-link target can't
// disagree on the injury axis (#221/#1115). Parallels getFormDeloadContext: empty when
// no recovering injury applies (byte-for-byte the prior form behavior). Membership is
// what the form reads (region ∈ set), so serialization order is immaterial.
//
// #2024 — the form ALSO carries the resolved constraints themselves, so a lift the user
// picks can be tempered by an exercise- or movement-scoped constraint (and by the user's
// own declared load preference) rather than only by its coarse region. Plain serializable
// data; the client resolves it through the same pure `exerciseInjuryVerdict` every server
// surface uses, so the logger and its deep-link target still can't disagree.
export interface FormRecoveringContext {
  temperedRegions: MuscleRegion[];
  constraints: InjuryConstraint[];
}

export function getFormRecoveringContext(
  profileId: number
): FormRecoveringContext {
  const constraints = getInjuryConstraints(profileId);
  return {
    temperedRegions: [...temperedRegions(constraints)],
    constraints,
  };
}

// Validated input for a CREATE. Regions/muscles are already the parsed, valid
// vocabulary arrays (the action validates + filters); label is trimmed non-empty.
// On this shape an omitted optional field means EMPTY — a new row states everything
// about itself. `InjuryPatch` below is the edit shape, where omitted means unchanged.
export interface InjuryInput {
  label: string;
  regions: MuscleRegion[];
  muscles?: MuscleId[];
  status?: InjuryStatus;
  since?: string | null;
  notes?: string | null;
  // #2024, all optional and all USER-DECLARED. Omitting every one of them writes exactly
  // the region-scoped constraint this core always wrote.
  laterality?: InjuryLaterality | null;
  movements?: MovementPattern[];
  exercises?: string[];
  loadFactor?: number | null;
  reviewDate?: string | null;
}

// The EDIT shape (#2359). An absent key means UNCHANGED; a present key is written,
// including a present `null`, which clears. That is the whole difference from
// `InjuryInput`, where absent means empty.
//
// Ordinary edit forms are last-write-wins, and this still is — for the fields the
// form actually carries. What it is no longer is whole-ROW: a form that does not
// carry a field cannot clear it. The edit form used to buy that property by
// round-tripping four values it never edits as hidden inputs, which is a
// must-remember invariant whose failure is silent and destructive — add a column,
// write it from the core, forget the hidden input, and every scope edit quietly
// erases a value the user has been curating. Nothing would fail. Now the core is
// told what changed, so a column nobody mentions is a column nobody touches.
export type InjuryPatch = Partial<InjuryInput>;

// A typed outcome so an action answers from what happened (never unconditionally confirm).
export type InjuryWriteOutcome =
  { kind: "ok"; id: number } | { kind: "invalid" };

interface SanitizedInjury {
  label: string;
  regions: MuscleRegion[];
  muscles: MuscleId[];
  status: InjuryStatus;
  since: string | null;
  notes: string | null;
  laterality: InjuryLaterality | null;
  movements: MovementPattern[];
  exercises: string[];
  loadFactor: number | null;
  reviewDate: string | null;
}

function sanitize(input: InjuryInput): SanitizedInjury | null {
  const label = input.label.trim();
  if (!label) return null;
  const regions = [...new Set(input.regions.filter(isValidRegion))];
  const muscles = [...new Set((input.muscles ?? []).filter(isValidMuscleId))];
  // At least one region (or a fine muscle that rolls up to one) is required — an injury
  // with no affected region can't constrain anything. The #2024 precision NARROWS a
  // constraint within its region; it never replaces the region, so this stays required.
  if (regions.length === 0 && muscles.length === 0) return null;
  const status: InjuryStatus =
    input.status && INJURY_STATUSES.includes(input.status)
      ? input.status
      : "active";
  // Exercise identities are normalized through the canonical identity function, never
  // stored as the raw label the user picked from (#2024's no-duplicate-vocabulary rule).
  const exercises = [
    ...new Set(
      (input.exercises ?? [])
        .map((e) => exerciseHistoryKey(String(e)))
        .filter((k) => k.length > 0)
    ),
  ].slice(0, 20);
  return {
    label: label.slice(0, 120),
    regions,
    muscles,
    status,
    since: input.since ?? null,
    notes: (input.notes ?? "").trim().slice(0, 1000) || null,
    laterality:
      input.laterality != null && isValidLaterality(input.laterality)
        ? input.laterality
        : null,
    movements: [
      ...new Set((input.movements ?? []).filter(isValidMovementPattern)),
    ],
    exercises,
    // A recovery preference only means anything while recovering; storing one on an
    // active/resolved row would silently reappear on a later status change the user never
    // tied it to.
    loadFactor:
      status === "recovering" && input.loadFactor != null
        ? parseLoadFactor(input.loadFactor)
        : null,
    reviewDate:
      input.reviewDate != null && isDateStr(input.reviewDate)
        ? input.reviewDate
        : null,
  };
}

// The #2024 columns, in the order both writes bind them.
function scopeBindings(s: SanitizedInjury): [
  string | null, // laterality
  string | null, // movements JSON
  string | null, // exercises JSON
  number | null, // load_factor
  string | null, // review_date
] {
  return [
    s.laterality,
    s.movements.length ? JSON.stringify(s.movements) : null,
    s.exercises.length ? JSON.stringify(s.exercises) : null,
    s.loadFactor,
    s.reviewDate,
  ];
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
             (profile_id, label, regions, muscles, status, since, resolved_date, notes,
              created_at, laterality, movements, exercises, load_factor, review_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          s.notes,
          // created_at from the clock seam (#1534) — the Timeline day fallback.
          sqlNow(),
          ...scopeBindings(s)
        ).lastInsertRowid
    );
    return { kind: "ok" as const, id };
  });
}

// Merge a patch over the row as it stands (#2359). `undefined` — the key absent from
// the patch — takes the stored value; anything else, `null` included, is the caller
// stating a new one. Done BEFORE `sanitize` on purpose, so the merged whole still
// passes every cross-field rule the create path enforces (a label is required, a
// region or a fine muscle is required, a load preference only survives while
// recovering) rather than each field being validated against a row it no longer
// belongs to.
function mergePatch(existing: Injury, patch: InjuryPatch): InjuryInput {
  const take = <T>(v: T | undefined, stored: T): T =>
    v === undefined ? stored : v;
  return {
    label: take(patch.label, existing.label),
    regions: take(patch.regions, existing.regions),
    muscles: take(patch.muscles, existing.muscles),
    status: take(patch.status, existing.status),
    since: take(patch.since, existing.since),
    notes: take(patch.notes, existing.notes),
    laterality: take(patch.laterality, existing.laterality),
    movements: take(patch.movements, existing.movements),
    exercises: take(patch.exercises, existing.exercises),
    loadFactor: take(patch.loadFactor, existing.loadFactor),
    reviewDate: take(patch.reviewDate, existing.reviewDate),
  };
}

// Edit an existing injury (last-write-wins for the fields the caller names, #467).
// PARTIAL since #2359: a field absent from the patch is left exactly as stored, so a
// form is only ever responsible for what it edits. Profile-scoped; a no-such-row is
// `invalid`.
export function updateInjuryCore(
  profileId: number,
  id: number,
  patch: InjuryPatch
): InjuryWriteOutcome {
  return writeTx(() => {
    // Read the whole row, not just the lifecycle columns: it is both the merge base
    // and the existence check, and one read inside the transaction is what makes
    // "unchanged" mean unchanged rather than "as it looked before we started".
    const existing = getInjury(profileId, id);
    if (!existing) return { kind: "invalid" as const };
    const s = sanitize(mergePatch(existing, patch));
    if (!s) return { kind: "invalid" as const };
    // resolved_date follows status: entering 'resolved' stamps it (keeping any existing);
    // leaving 'resolved' clears it.
    const resolvedDate =
      s.status === "resolved"
        ? (existing.resolvedDate ?? s.since ?? null)
        : null;
    db.prepare(
      `UPDATE injuries
          SET label = ?, regions = ?, muscles = ?, status = ?, since = ?,
              resolved_date = ?, notes = ?, laterality = ?, movements = ?,
              exercises = ?, load_factor = ?, review_date = ?
        WHERE id = ? AND profile_id = ?`
    ).run(
      s.label,
      JSON.stringify(s.regions),
      s.muscles.length ? JSON.stringify(s.muscles) : null,
      s.status,
      s.since,
      resolvedDate,
      s.notes,
      ...scopeBindings(s),
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
    // A recovery load preference only means anything while recovering (#2024): leaving
    // `recovering` clears it, so it can't silently reappear on a later transition the user
    // never tied it to. Everything else the user declared is left exactly as they wrote it —
    // a status change is not permission to rewrite their constraint.
    const res = db
      .prepare(
        `UPDATE injuries
            SET status = ?, resolved_date = ?,
                load_factor = CASE WHEN ? = 'recovering' THEN load_factor ELSE NULL END
          WHERE id = ? AND profile_id = ?`
      )
      .run(
        status,
        status === "resolved" ? resolvedDate : null,
        status,
        id,
        profileId
      );
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
