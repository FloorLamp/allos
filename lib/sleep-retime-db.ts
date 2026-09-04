import { db, writeTx, today } from "@/lib/db";
import { shiftDateStr, utcInstant } from "@/lib/date";
import { zonedDateParts } from "@/lib/date";
import { profileDayZone } from "@/lib/travel-excusal";
import { zoneOf } from "@/lib/travel-timezone";
import {
  SLEEP_STAGE_METRICS,
  stagesOwnedBy,
  type SleepSessionRow,
} from "@/lib/sleep-overlap";
import {
  removeImportTombstone,
  writeImportTombstone,
} from "@/lib/integrations/tombstones";
import { metricSampleTombstoneKey } from "@/lib/integrations/tombstone-keys";
import {
  getSuspectSleepWakeDays,
  SLEEP_SKEW_HISTORY_DAYS,
} from "@/lib/queries/sleep-clock-skew";
import { SLEEP_RETIME_KIND } from "@/lib/sleep-retime-kind";

// RE-TIMING A HEDGED SLEEP SESSION (issue #5021), store half.
//
// #4299 gave a contradicted night two states: hedged, or deleted. A person who KNOWS
// when they slept had to lose the night to keep the record honest. This is the third
// state, and it is theirs to trigger: nothing here runs without a person stating the
// window, because #4299's ruling stands — a silent 6-hour rewrite of imported data is a
// bigger lie than the one it fixes.
//
// ── ONE DELTA, AND WHY THE LENGTH MAY NOT CHANGE ─────────────────────────────
// The defect this exists for is stamped instants with correct durations — "the
// durations were right; only the instants were fabricated" (#4299). So the write is a
// MOVE: the session and every stage row filed under it shift by one delta, and the
// breakdown arrives at the new hours intact. A stated window of a different LENGTH has
// no single delta, and the alternatives are both fabrication — scaling a scored
// breakdown, or dropping the stages that fall outside. It is refused instead, with the
// stored length named, and the person who genuinely wants to restate how long they
// slept still has the delete and the manual duration behind it.
//
// ── UNDO IS A MOVE BACK, NOT A RE-INSERT ─────────────────────────────────────
// It rides the delete's own holding table and the same "You can undo this" sentence,
// as `administration` does (lib/queries/intake/adherence.ts) — this kind writes its own
// `deleted_rows` row and owns its restore, which is what keeps the shared
// `captureDelete` out of it. That matters: `captureDelete` DELETES, and
// `restoreDeletedRow` re-INSERTS. A re-time moves the row's natural key, so the generic
// restore's live-row adoption could not fire and it would insert a SECOND session at
// the old instants beside the moved one — two nights where there was one.
export { SLEEP_RETIME_KIND } from "@/lib/sleep-retime-kind";

export type SleepRetimeOutcome =
  | { kind: "retimed"; undoId: number }
  | { kind: "not-found" }
  /** The lock stays on a session the detector has not contradicted (#5021 scope). */
  | { kind: "not-hedged" }
  | { kind: "invalid-window" }
  | { kind: "length-changed"; storedMinutes: number };

interface CapturedSleepRetime {
  sampleId: number;
  /** Every row this move touched, at the instants it held before it. */
  rows: {
    id: number;
    date: string;
    started_at: string;
    ended_at: string;
    edited: number;
  }[];
  /** The natural key the move tombstoned, so the undo can withdraw exactly that one. */
  tombstone: {
    metric: string;
    source: string;
    origin: string | null;
    startedAt: string;
  };
}

const SESSION_COLUMNS =
  "id, date, metric, origin, started_at, ended_at, edited";

/** The stage rows filed under this session, by the same question the collapse asks. */
function stagesOf(
  profileId: number,
  session: SleepSessionRow & { source: string },
  startMs: number,
  endMs: number
): SleepSessionRow[] {
  const from = shiftDateStr(session.date, -1);
  const to = shiftDateStr(session.date, 1);
  const others = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' AND source = ?
          AND date >= ? AND date <= ? AND id != ?`
    )
    .all(profileId, session.source, from, to, session.id) as SleepSessionRow[];
  const stages = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM metric_samples
        WHERE profile_id = ? AND source = ? AND origin IS ?
          AND metric IN (${SLEEP_STAGE_METRICS.map(() => "?").join(",")})
          AND date >= ? AND date <= ?`
    )
    .all(
      profileId,
      session.source,
      session.origin,
      ...SLEEP_STAGE_METRICS,
      from,
      to
    ) as SleepSessionRow[];
  return stagesOwnedBy({ date: session.date, startMs, endMs }, others, stages);
}

/**
 * Move a hedged sleep session, and the stage rows under it, onto the window a person
 * stated. Returns the undo token, or the refusal that stopped it.
 */
export function retimeSleepSessionCore(
  profileId: number,
  sampleId: number,
  window: { bedAt: string; wakeAt: string }
): SleepRetimeOutcome {
  const newStart = Date.parse(window.bedAt);
  const newEnd = Date.parse(window.wakeAt);
  if (
    !Number.isFinite(newStart) ||
    !Number.isFinite(newEnd) ||
    newEnd <= newStart
  )
    return { kind: "invalid-window" };
  // Never the future, the record's own rule: a night that has not happened cannot be
  // the night this one really was.
  if (newEnd > Date.now()) return { kind: "invalid-window" };

  const session = db
    .prepare(
      `SELECT ${SESSION_COLUMNS}, source FROM metric_samples
        WHERE id = ? AND profile_id = ? AND metric = 'sleep_min'`
    )
    .get(sampleId, profileId) as
    (SleepSessionRow & { source: string }) | undefined;
  if (!session) return { kind: "not-found" };

  // ONLY A HEDGED NIGHT. #5021's out-of-scope line is explicit — the edit lock stays on
  // a session the detector has not contradicted — and asking the detector is the only
  // way to know, so it is asked here rather than trusted from the caller.
  const suspect = getSuspectSleepWakeDays(
    profileId,
    shiftDateStr(today(profileId), -SLEEP_SKEW_HISTORY_DAYS)
  );
  if (!suspect.has(session.date)) return { kind: "not-hedged" };

  const oldStart = Date.parse(session.started_at);
  const oldEnd = Date.parse(session.ended_at);
  if (!Number.isFinite(oldStart) || !Number.isFinite(oldEnd))
    return { kind: "not-found" };
  const storedMs = oldEnd - oldStart;
  if (newEnd - newStart !== storedMs)
    return {
      kind: "length-changed",
      storedMinutes: Math.round(storedMs / 60_000),
    };

  const delta = newStart - oldStart;
  if (delta === 0) return { kind: "invalid-window" };

  return writeTx((): SleepRetimeOutcome => {
    const stages = stagesOf(profileId, session, oldStart, oldEnd);
    const moving = [session as SleepSessionRow, ...stages];
    const captured: CapturedSleepRetime = {
      sampleId,
      rows: moving.map((row) => ({
        id: row.id,
        date: row.date,
        started_at: row.started_at,
        ended_at: row.ended_at,
        edited: row.edited ? 1 : 0,
      })),
      tombstone: {
        metric: "sleep_min",
        source: session.source,
        origin: session.origin,
        startedAt: session.started_at,
      },
    };
    const undo = db
      .prepare(
        `INSERT INTO deleted_rows (profile_id, kind, label, payload)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        profileId,
        SLEEP_RETIME_KIND,
        "sleep session",
        JSON.stringify(captured)
      );

    // The DATE follows the new WAKE, through the zone that was in force at that
    // instant — the same rule the ingest applies (`parts(end, tz)` in
    // lib/integrations/health-connect.ts) and the same one #5042 taught the summary.
    // Resolving it through the profile's CURRENT zone would file a corrected night
    // under the day the traveller is standing in rather than the one they woke on.
    const zone = profileDayZone(profileId);
    const move = db.prepare(
      `UPDATE metric_samples SET date = ?, started_at = ?, ended_at = ?, edited = 1
        WHERE id = ? AND profile_id = ?`
    );
    for (const row of moving) {
      const rowStart = Date.parse(row.started_at) + delta;
      const rowEnd = Date.parse(row.ended_at) + delta;
      const wake = new Date(rowEnd);
      move.run(
        // A stage keeps its SESSION's wake day, which is the parser's own rule and the
        // one `stagesOwnedBy` reads to find them again.
        zonedDateParts(zoneOf(zone, new Date(newEnd)), new Date(newEnd)).date,
        utcInstant(new Date(rowStart)),
        utcInstant(wake),
        row.id,
        profileId
      );
    }

    // The exporter re-sends the last 48 h, so the mis-stamped copy would land again
    // beside the corrected one without this. It is the SAME tombstone the delete
    // writes, and the undo below withdraws it.
    writeImportTombstone(
      profileId,
      "metric_samples",
      metricSampleTombstoneKey(
        "sleep_min",
        session.source,
        session.origin,
        session.started_at
      )
    );
    return { kind: "retimed", undoId: Number(undo.lastInsertRowid) };
  });
}

/**
 * Put a re-timed session back where it was, and withdraw the tombstone with it.
 *
 * Dispatched from `restoreDeletedRow` beside `administration`'s, for the reason the
 * header states: this undo MOVES rows, and the generic restore inserts them.
 */
export function restoreSleepRetime(profileId: number, undoId: number): boolean {
  return writeTx((): boolean => {
    const holding = db
      .prepare(
        `SELECT payload FROM deleted_rows
          WHERE id = ? AND profile_id = ? AND kind = ?`
      )
      .get(undoId, profileId, SLEEP_RETIME_KIND) as
      { payload: string } | undefined;
    if (!holding) return false;
    let captured: CapturedSleepRetime;
    try {
      captured = JSON.parse(holding.payload) as CapturedSleepRetime;
    } catch {
      return false;
    }

    const back = db.prepare(
      `UPDATE metric_samples SET date = ?, started_at = ?, ended_at = ?, edited = ?
        WHERE id = ? AND profile_id = ?`
    );
    // A row the person deleted between the re-time and the undo simply is not moved
    // back; the rest are. Restoring it would resurrect a row they removed on purpose.
    for (const row of captured.rows)
      back.run(
        row.date,
        row.started_at,
        row.ended_at,
        row.edited,
        row.id,
        profileId
      );

    // With the key free again, the exporter's next re-send refreshes the restored row
    // rather than being dropped — which is what makes the undo complete.
    removeImportTombstone(
      profileId,
      "metric_samples",
      metricSampleTombstoneKey(
        captured.tombstone.metric,
        captured.tombstone.source,
        captured.tombstone.origin,
        captured.tombstone.startedAt
      )
    );
    db.prepare(`DELETE FROM deleted_rows WHERE id = ? AND profile_id = ?`).run(
      undoId,
      profileId
    );
    return true;
  });
}
