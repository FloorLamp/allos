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
import { windowsOverlap } from "@/lib/metric-window-overlap";
import { sleepWindowFromClocks } from "@/lib/vitals-input";
import { resolveSleepWindow } from "@/lib/offline/writes";
import {
  removeImportTombstone,
  writeImportTombstone,
} from "@/lib/integrations/tombstones";
import { metricSampleTombstoneKey } from "@/lib/integrations/tombstone-keys";
import {
  getSuspectSleepSessions,
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
  /**
   * The wake day holds a SECOND session of the same source overlapping this one — a
   * night stored twice (#5125). Refused rather than moved, because `stagesOwnedBy`
   * vetoes every stage a second session also covers: the row would move and its whole
   * breakdown would stay behind, which is exactly what `length-changed` exists to
   * prevent, arriving through the path that refusal allows. Settling the pair is
   * Review's "Keep this one" and it is the door this refusal names.
   */
  | { kind: "stored-twice" }
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

/** Another `sleep_min` row of the same source covering this one — a night stored twice. */
function overlappingTwin(
  profileId: number,
  session: SleepSessionRow & { source: string }
): boolean {
  const from = shiftDateStr(session.date, -1);
  const to = shiftDateStr(session.date, 1);
  const others = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' AND source = ?
          AND date >= ? AND date <= ? AND id != ?`
    )
    .all(profileId, session.source, from, to, session.id) as SleepSessionRow[];
  return others.some((other) =>
    windowsOverlap(
      session.started_at,
      session.ended_at,
      other.started_at,
      other.ended_at
    )
  );
}

/**
 * Move a hedged sleep session, and the stage rows under it, onto the window a person
 * stated. Returns the undo token, or the refusal that stopped it.
 *
 * THE WINDOW ARRIVES AS TWO WALL CLOCKS, not as instants (#5125 item 3). The surface
 * DISPLAYS the stored window through the zone in force at those instants
 * (`lib/queries/sleep.ts` projects it through `zoneOf(profileDayZone(…), at)`), and a
 * person types against what they see — so the same zone has to interpret what they
 * typed. It used to be folded at the action boundary through the profile's CURRENT
 * zone, and on a profile with a recorded Tokyo→London switch a one-hour nudge moved the
 * row NINE hours with every refusal silent.
 *
 * The fold lives here rather than beside the display because two call sites that must
 * agree about a zone will drift again. This one already reads the session row, which is
 * what names the instant the zone is taken at, and there is no signature left that
 * accepts instants which skipped the rule.
 *
 * EVERYTHING IS INSIDE ONE TRANSACTION, including the reads (#5125's PLAUSIBLE note).
 * The session read, the detector call and the length check used to sit outside it; two
 * concurrent posts could not produce a wrong row, but a check whose subject can move
 * before the write is not worth keeping once the code is open anyway.
 */
export function retimeSleepSessionCore(
  profileId: number,
  sampleId: number,
  stated: { date: string; bed: string; wake: string }
): SleepRetimeOutcome {
  return writeTx((): SleepRetimeOutcome => {
    const session = db
      .prepare(
        `SELECT ${SESSION_COLUMNS}, source FROM metric_samples
        WHERE id = ? AND profile_id = ? AND metric = 'sleep_min'`
      )
      .get(sampleId, profileId) as
      (SleepSessionRow & { source: string }) | undefined;
    if (!session) return { kind: "not-found" };

    // ONLY THE SESSION THE DETECTOR JUDGED (#5125 item 1). This used to ask for the
    // hedged wake DAYS and test `has(session.date)` — but the detector judges the day's
    // MAIN session only (#5019's nap exclusion) and never looks at a `source='manual'`
    // row at all. So a nap or a manual duration sharing a hedged day passed a lock whose
    // own comment says the opposite, got moved, and — worse — got its natural key
    // tombstoned, which stops the source re-sending it with nothing on screen to say so.
    //
    // `sampleId` is the identity the detector already carries, so the lock asks the
    // question it always meant: is THIS row the one that was contradicted.
    const judged = getSuspectSleepSessions(
      profileId,
      shiftDateStr(today(profileId), -SLEEP_SKEW_HISTORY_DAYS)
    ).some((s) => s.sampleId === sampleId);
    if (!judged) return { kind: "not-hedged" };

    // A NIGHT STORED TWICE cannot be moved with its breakdown, so it is not moved at all.
    // See the outcome's own note: `stagesOwnedBy` vetoes every stage a second session
    // also covers, and a session that arrives at new hours with its stages left at the
    // old ones is the orphaned breakdown this whole feature refuses elsewhere.
    if (overlappingTwin(profileId, session)) return { kind: "stored-twice" };

    const oldStart = Date.parse(session.started_at);
    const oldEnd = Date.parse(session.ended_at);
    if (!Number.isFinite(oldStart) || !Number.isFinite(oldEnd))
      return { kind: "not-found" };

    // The person's two clocks, through the zone this night was actually lived in — the
    // one the surface displayed the stored window in.
    const zone = profileDayZone(profileId);
    const statedWindow = sleepWindowFromClocks(stated.bed, stated.wake);
    const resolved = statedWindow
      ? resolveSleepWindow(
          zoneOf(zone, new Date(oldEnd)),
          stated.date,
          statedWindow
        )
      : null;
    if (!resolved) return { kind: "invalid-window" };
    const newStart = Date.parse(resolved.startedAt);
    const newEnd = Date.parse(resolved.endedAt);
    if (!Number.isFinite(newStart) || !Number.isFinite(newEnd))
      return { kind: "invalid-window" };
    // Never the future, the record's own rule: a night that has not happened cannot be
    // the night this one really was.
    if (newEnd > Date.now()) return { kind: "invalid-window" };

    const storedMs = oldEnd - oldStart;
    if (newEnd - newStart !== storedMs)
      return {
        kind: "length-changed",
        storedMinutes: Math.round(storedMs / 60_000),
      };

    const delta = newStart - oldStart;
    if (delta === 0) return { kind: "invalid-window" };

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
    // lib/integrations/health-connect.ts) and the same one #5042 taught the summary,
    // and the same `zone` the stated clocks were interpreted through above.
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
