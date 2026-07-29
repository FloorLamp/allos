// ---- Correction lineage for a reading (issue #1404) --------------------------
//
// A source-owned reading keeps ONE stable row id across a re-import — its id is
// referenced by encounter links, follow-up labs, saved items, dismissal keys and the
// per-row sync provenance ledger, so minting a new row for a corrected value would
// strand all of them. The reading is therefore updated IN PLACE, and the value being
// overwritten is preserved here first, as a CHILD row.
//
// A revision is NOT an observation: it never charts, counts, flags, or dedupes. It
// is provenance about one reading, which is exactly why it lives beside the reading
// instead of among the readings (see migration 120's note on the ~80 read sites an
// archived medical_records row would have had to hide from).
//
// Scoping: medical_record_revisions carries no profile_id and reaches one through
// `record_id` → medical_records, the repo's child-table convention. Every read below
// joins the parent and filters its profile_id; the write core is called with a
// record id the caller has ALREADY matched by profile_id (the ingest upsert's own
// `WHERE profile_id = ? AND external_id = ?` lookup).

import { db } from "../../db";
import {
  normalizeResultStatus,
  type ReadingState,
  type ResultStatus,
} from "../../lab-result-lifecycle";
import type { MedicalFlag, MedicalRecordRevision } from "../../types";

// The prior state a revision preserves — the reading's own columns, as they stood
// before the overwrite.
export interface RevisionSnapshot extends ReadingState {
  reference_range?: string | null;
  flag?: MedicalFlag | null;
}

const insertStmt = () =>
  db.prepare(
    `INSERT INTO medical_record_revisions
       (record_id, date, value, value_num, unit, reference_range, flag,
        result_status, superseded_by_status, source)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );

// Preserve one reading's prior state. Auth-blind write core (AGENTS.md): it takes an
// already-authorized record id and never consults lib/auth. MUST be called inside
// the caller's transaction, immediately before the UPDATE that overwrites the row,
// so the snapshot and the overwrite commit together or not at all.
//
// `supersededByStatus` is what the INCOMING result called itself; `source` is the
// ingest that performed the overwrite. Returns the new revision id.
export function insertRecordRevision(
  recordId: number,
  prior: RevisionSnapshot,
  supersededByStatus: string | null,
  source: string | null
): number {
  const info = insertStmt().run(
    recordId,
    prior.date ?? null,
    prior.value ?? null,
    prior.value_num ?? null,
    prior.unit ?? null,
    prior.reference_range ?? null,
    prior.flag ?? null,
    normalizeResultStatus(prior.result_status),
    normalizeResultStatus(supersededByStatus),
    source
  );
  return Number(info.lastInsertRowid);
}

function rowToRevision(r: Record<string, unknown>): MedicalRecordRevision {
  return {
    id: Number(r.id),
    record_id: Number(r.record_id),
    date: (r.date as string | null) ?? null,
    value: (r.value as string | null) ?? null,
    value_num: r.value_num == null ? null : Number(r.value_num),
    unit: (r.unit as string | null) ?? null,
    reference_range: (r.reference_range as string | null) ?? null,
    flag: (r.flag as MedicalFlag | null) ?? null,
    result_status: normalizeResultStatus(r.result_status as string | null),
    superseded_by_status: normalizeResultStatus(
      r.superseded_by_status as string | null
    ) as ResultStatus | null,
    source: (r.source as string | null) ?? null,
    superseded_at: String(r.superseded_at),
  };
}

// Every preserved prior state of ONE reading, newest first. Profile-scoped through
// the parent join, so a record id belonging to another profile reads as empty.
// Returns plain serializable objects (never a better-sqlite3 row proxy), so a Server
// Component can hand them straight to a client component.
export function getRecordRevisions(
  profileId: number,
  recordId: number
): MedicalRecordRevision[] {
  const rows = db
    .prepare(
      `SELECT rev.* FROM medical_record_revisions rev
         JOIN medical_records mr ON mr.id = rev.record_id
        WHERE rev.record_id = ? AND mr.profile_id = ?
        ORDER BY rev.superseded_at DESC, rev.id DESC`
    )
    .all(recordId, profileId) as Record<string, unknown>[];
  return rows.map(rowToRevision);
}

// The revisions for a SET of readings, grouped by record id — the list-surface twin
// of the single read above (a biomarker detail page renders many readings, and one
// query beats N). Profile-scoped through the same parent join. An empty id list
// returns an empty map without touching the database.
export function getRevisionsByRecord(
  profileId: number,
  recordIds: number[]
): Map<number, MedicalRecordRevision[]> {
  const out = new Map<number, MedicalRecordRevision[]>();
  const ids = recordIds.filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT rev.* FROM medical_record_revisions rev
         JOIN medical_records mr ON mr.id = rev.record_id
        WHERE mr.profile_id = ?
          AND rev.record_id IN (${ids.map(() => "?").join(",")})
        ORDER BY rev.superseded_at DESC, rev.id DESC`
    )
    .all(profileId, ...ids) as Record<string, unknown>[];
  for (const r of rows) {
    const rev = rowToRevision(r);
    const list = out.get(rev.record_id) ?? [];
    list.push(rev);
    out.set(rev.record_id, list);
  }
  return out;
}
