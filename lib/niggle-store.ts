// The auth-blind write/read core for the niggle layer (issue #2948, part 1). Takes
// profileId first and never imports lib/auth — the profileId-first + lib-write-core
// convention. The Server Action owns the auth gate and the revalidation; this module owns
// the SQL, the row shaping, and the ONE state transition the table has.
//
// Registered in lib/stateful-writes.ts as the sole write core for `niggles`. The
// invariant it exists to hold: AT MOST ONE LIVE NIGGLE PER (profile, region, laterality).
// A person does not have two simultaneous right-knee niggles — they have one that keeps
// coming back — and every future consumer (the #2948 tempering, the pre-workout heads-up)
// reads the live set assuming that. A raw INSERT from a third module would mint the
// duplicate, so `reportNiggle` compare-and-sets inside one writeTx: an existing LIVE row
// on the same key is RE-REPORTED (its `last_reported_at` advances, resetting the quiet
// clock); otherwise a new row is born.

import { db, writeTx } from "./db";
import { instantNow } from "./clock";
import { isValidLaterality, isValidRegion } from "./injury-model";
import type { InjuryLaterality } from "./injury-model";
import { exerciseHistoryKey } from "./lifts";
import type { MuscleRegion } from "./lifts";
import { isNiggleLive, liveNiggles, type Niggle } from "./niggle-model";

const NIGGLE_COLUMNS = `id, region, laterality, body_term, source_activity_id,
                        source_exercise, reported_at, last_reported_at`;

interface NiggleRow {
  id: number;
  region: string;
  laterality: string | null;
  body_term: string | null;
  source_activity_id: number | null;
  source_exercise: string | null;
  reported_at: string;
  last_reported_at: string;
}

// A stored value outside the vocabulary is dropped rather than thrown — the defensive
// read `lib/injuries.ts` already uses. A row whose region no longer parses cannot be
// shaped at all, so it is skipped by `rowsToNiggles` instead of degrading into a
// wrong region.
function rowToNiggle(r: NiggleRow): Niggle | null {
  if (!isValidRegion(r.region)) return null;
  return {
    id: r.id,
    region: r.region,
    laterality:
      r.laterality != null && isValidLaterality(r.laterality)
        ? r.laterality
        : null,
    bodyTerm: r.body_term,
    sourceActivityId: r.source_activity_id,
    sourceExercise: r.source_exercise,
    reportedAt: r.reported_at,
    lastReportedAt: r.last_reported_at,
  };
}

function rowsToNiggles(rows: NiggleRow[]): Niggle[] {
  const out: Niggle[] = [];
  for (const r of rows) {
    const n = rowToNiggle(r);
    if (n) out.push(n);
  }
  return out;
}

// Every niggle on record for the profile, most recently reported first. Includes EXPIRED
// ones: expiry is a read-time derivation, not a delete, so the history stays browsable
// (Data → Manage, the export) even though nothing coaches off it.
export function getNiggles(profileId: number): Niggle[] {
  const rows = db
    .prepare(
      `SELECT ${NIGGLE_COLUMNS}
         FROM niggles
        WHERE profile_id = ?
        ORDER BY last_reported_at DESC, id DESC`
    )
    .all(profileId) as NiggleRow[];
  return rowsToNiggles(rows);
}

// The LIVE set — what a consumer that wants "what is bothering this person right now"
// should read. `now` is injectable so a caller with a frozen clock (tests, a recap
// composed for a stated instant) gets a deterministic answer.
export function getLiveNiggles(
  profileId: number,
  now: string = instantNow()
): Niggle[] {
  return liveNiggles(getNiggles(profileId), now);
}

// What a caller is asking to record. Every field but `region` is optional, because a
// person naming a sore knee with no side and no lift is a complete report.
export interface NiggleReport {
  region: MuscleRegion;
  laterality?: InjuryLaterality | null;
  // The person's own word, display only.
  bodyTerm?: string | null;
  sourceActivityId?: number | null;
  // A user-facing lift name; normalized to the canonical identity before storage.
  sourceExercise?: string | null;
}

export type ReportNiggleOutcome =
  // `kind` names which transition happened, so the caller's confirmation can say the
  // truth ("Tracking it" vs "Noted again") instead of one message for both.
  | { ok: true; kind: "created" | "re-reported"; id: number }
  | {
      ok: false;
      reason: "invalid-region" | "invalid-laterality" | "not-owned";
    };

// Record a niggle, or advance the one already live on the same key. The ONLY write path
// to this table.
//
// `sourceActivityId` is re-verified against the profile here rather than trusted from the
// caller: the id arrives from a form and must not be able to attach one profile's niggle
// to another profile's session.
//
// A RE-REPORT keeps the ORIGINAL provenance. "Your right knee felt weird after squats"
// should keep naming the session that first said so; the fresh fact a re-report carries
// is the CLOCK, and that is what advances.
export function reportNiggle(
  profileId: number,
  report: NiggleReport,
  now: string = instantNow()
): ReportNiggleOutcome {
  if (!isValidRegion(report.region))
    return { ok: false, reason: "invalid-region" };
  const laterality = report.laterality ?? null;
  if (laterality != null && !isValidLaterality(laterality))
    return { ok: false, reason: "invalid-laterality" };

  if (report.sourceActivityId != null) {
    const owned = db
      .prepare(`SELECT id FROM activities WHERE id = ? AND profile_id = ?`)
      .get(report.sourceActivityId, profileId);
    if (!owned) return { ok: false, reason: "not-owned" };
  }

  const bodyTerm = report.bodyTerm?.trim() || null;
  const sourceExercise = report.sourceExercise?.trim()
    ? exerciseHistoryKey(report.sourceExercise) || null
    : null;

  return writeTx(() => {
    // The compare half of the compare-and-set. `laterality IS ?` (not `= ?`) so a NULL
    // side matches a NULL side — with `=` every unstated-side report would miss its own
    // live row and mint a duplicate, which is precisely the corruption this core exists
    // to prevent.
    const existing = db
      .prepare(
        `SELECT id, last_reported_at
           FROM niggles
          WHERE profile_id = ? AND region = ? AND laterality IS ?
          ORDER BY last_reported_at DESC, id DESC`
      )
      .all(profileId, report.region, laterality) as {
      id: number;
      last_reported_at: string;
    }[];
    const live = existing.find((r) =>
      isNiggleLive({ lastReportedAt: r.last_reported_at }, now)
    );
    if (live) {
      db.prepare(
        `UPDATE niggles SET last_reported_at = ? WHERE id = ? AND profile_id = ?`
      ).run(now, live.id, profileId);
      return { ok: true, kind: "re-reported", id: live.id } as const;
    }
    const res = db
      .prepare(
        `INSERT INTO niggles
           (profile_id, region, laterality, body_term, source_activity_id,
            source_exercise, reported_at, last_reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        report.region,
        laterality,
        bodyTerm,
        report.sourceActivityId ?? null,
        sourceExercise,
        now,
        now
      );
    return {
      ok: true,
      kind: "created",
      id: Number(res.lastInsertRowid),
    } as const;
  });
}
