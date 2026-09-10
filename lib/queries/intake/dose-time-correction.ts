// Part of the lib/queries/intake barrel (#319), split out of adherence.ts under
// #2960 / rule #5670. The profile-scoping guard walks all of lib/, so this module
// stays covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
//
// ADMINISTRATION-TIME CORRECTION (#2020): the reads the "wrong time?" offer is built
// from and the one core that restamps a burst. It is the dose ledger's only writer of
// `occurred_at` ALONE — no status transition, no supply movement, no dedupe — which is
// why it is its own module rather than a tail on the resolution core: correcting WHEN
// a dose was given is a different question from whether it was given at all, and the
// two must never grow a shared "and also fix the time" door.
import { db, today, writeTx } from "../../db";
import { now as clockNow } from "../../clock";
import { dateStrInTz, utcInstant, parseUtcSql } from "../../date";
import { getTimezone } from "../../settings";
import {
  restampBurst,
  type RestampSelection,
  correctionBursts,
  CORRECTION_FRESH_MIN,
  type CorrectionBurst,
  type CorrectionMessageBinding,
} from "../../correction-time";

// ---- Administration-time correction (issue #2020) ----

// One recent dose confirmation as the correction offer reads it. `tapAt` is the
// immutable `recorded_at` audit stamp; `statedAt` is the mutable `occurred_at`
// administration instant. Corrections never renew the tap window (#2206, #2876).
export interface DoseTapRow {
  id: number;
  bundleId?: string | null;
  tapAt: string;
  statedAt: string | null;
  // Which message's tap wrote this row (#2264) — the burst's attribution; null for a
  // web/offline confirm in the broad read or a pruned chat message row.
  messageRef: number | null;
  label: string;
  doseId: number;
  date: string;
}

// The profile's dose confirmations tapped within the correction window, oldest first.
// Bounded by that window, so the read is a handful of rows. Profile-scoped through the
// dose → item JOIN.
//
// SCHEDULED CONFIRMS ONLY IS NOT THE RULE — a PRN administration is exactly the case
// #2020 is about, so both are here. What IS excluded is a row with no `occurred_at`:
// there is no stated administration instant to correct. `chatOnly` narrows the
// chat-facing gather to chat provenance (#4356); the broad read remains the write core's.
export function getRecentDoseTaps(
  profileId: number,
  now: Date = clockNow(),
  chatOnly = false
): DoseTapRow[] {
  const since = utcInstant(
    new Date(now.getTime() - CORRECTION_FRESH_MIN * 60_000)
  );
  const rows = db
    .prepare(
      `SELECT l.id AS id, l.dose_id AS doseId, l.date AS date,
              l.recorded_at AS tapAt, l.occurred_at AS statedAt,
              l.notify_message_id AS messageRef, l.bundle_id AS bundleId, s.name AS name
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.status = 'taken'
          AND l.occurred_at IS NOT NULL AND l.recorded_at >= ?
          AND (? = 0 OR l.logged_via IS NULL
            OR l.logged_via IN ('telegram-nudge', 'telegram-command'))
        ORDER BY l.recorded_at, l.id
        LIMIT 100`
    )
    .all(profileId, since, chatOnly ? 1 : 0) as {
    id: number;
    doseId: number;
    date: string;
    tapAt: string;
    statedAt: string | null;
    messageRef: number | null;
    bundleId: string | null;
    name: string;
  }[];
  const out: DoseTapRow[] = [];
  for (const r of rows) {
    // Stored datetimes carry no zone, so they are parsed as UTC rather than handed to
    // `new Date`, which would read them in the process-local zone.
    const tap = parseUtcSql(r.tapAt);
    if (!tap) continue;
    const given = r.statedAt ? parseUtcSql(r.statedAt) : null;
    out.push({
      id: r.id,
      tapAt: tap.toISOString(),
      statedAt: given ? given.toISOString() : null,
      messageRef: r.messageRef,
      bundleId: r.bundleId,
      label: r.name,
      doseId: r.doseId,
      date: r.date,
    });
  }
  return out;
}

// The correction rows a dose keyboard should carry right now. Same computation as the
// food side (#221), over the ledger the dose reminder itself writes to. `binding` is
// the rendering message's #2264 identity; omitting it returns the profile-wide set,
// which only a caller that is not rendering a message may use.
export function getDoseCorrectionBursts(
  profileId: number,
  now: Date = clockNow(),
  binding?: CorrectionMessageBinding
): CorrectionBurst[] {
  const taps = getRecentDoseTaps(profileId, now, binding !== undefined);
  return correctionBursts(taps, now, binding);
}

// The typed result of a dose-time correction:
//   restamped — `count` log rows now carry a corrected `occurred_at`; `crossedMidnight`
//               says whether any of them landed on a different calendar day, which the
//               toast has to mention because the row's DAY deliberately does not move.
//               `anchor` names the dose + day the message can be rebuilt from once the
//               session's own buttons are gone.
//   no-burst  — the anchor row is gone or belongs to another profile. Nothing written.
//   out-of-range — the resolver refused at least one row (a chip that would walk the
//               burst past the floor, #2206). All-or-nothing: a burst is one error.
//   not-bound — the caller's `stillBound` guard refused the re-derived burst (#3092
//               follow-up): by write time it no longer belongs to the message the tap
//               came from. Nothing written.
export type DoseRestampOutcome =
  | {
      kind: "restamped";
      count: number;
      crossedMidnight: boolean;
      anchor: { doseId: number; date: string };
    }
  | { kind: "no-burst" }
  | { kind: "out-of-range" }
  | { kind: "not-bound" };

// Correct a burst of administration instants (issue #2020).
//
// THE ROW'S `date` DOES NOT MOVE, and this is the deliberate contrast with the food
// side. A serving's day is a fact about the serving, so #2019's correction re-dates it;
// a dose's day is SCHEDULE-OWNED (#614 — the token's date is the day the reminder was
// asking about), so a correction that crosses midnight moves only `occurred_at` and leaves
// the adherence day where the schedule put it. A bedtime dose confirmed at 07:00 and
// corrected to 22:00 was still last night's bedtime dose.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//
//   • It does not re-evaluate the phantom-dose PROXIMITY GUARD (see logAdministration).
//     That guard runs at INSERT time and decides whether a new row is the same intent as
//     an existing one. A correction can legitimately move two administrations within its
//     window, and merging or deleting a row on that basis would destroy a real record of
//     something that was taken. The instant is adjusted; the rows stay.
//   • It does not RE-ARM anything (#1933). A corrected instant is a correction of
//     history, not a new event, so no escalation reopens and no reminder returns.
//   • It only ever moves an instant EARLIER (chips step back, picker hours are all past),
//     so the PRN redose window can only become MORE conservative — the safe direction
//     for the one consumer that is safety-relevant. Repeat chip taps COMPOSE off the
//     stored `occurred_at` (#2206), which keeps that direction and bounds how far it can go
//     through the resolver's own floor rather than through idempotence.
export function restampDoseLogsCore(
  profileId: number,
  fromLogId: RestampSelection,
  resolve: (row: { tapAt: string; statedAt: string | null }) => Date | null,
  // The tap-time binding, re-evaluated INSIDE this write transaction (#3092 follow-up).
  // The handler's own check runs before its write call, but an `await` separates the
  // two, and a concurrent handler's pointer delete landing in that gap re-merges the
  // anchor into the null partition — so the burst the transaction re-derives is the one
  // the binding must hold FOR. The caller builds this from the SAME predicate its
  // renderer used (`burstsForMessage` + `correctionMessageBinding`); a chat-less caller
  // passes nothing and keeps the unguarded behavior.
  stillBound?: (burst: CorrectionBurst) => boolean
): DoseRestampOutcome {
  return writeTx(() => {
    const rows = db
      .prepare(
        `SELECT l.id AS id, l.dose_id AS doseId, l.date AS date,
                l.recorded_at AS tapAt, l.occurred_at AS statedAt,
                l.notify_message_id AS messageRef, l.bundle_id AS bundleId, s.name AS name
           FROM intake_item_logs l
           JOIN intake_item_doses d ON d.id = l.dose_id
           JOIN intake_items s ON s.id = d.item_id
          WHERE s.profile_id = ? AND ${typeof fromLogId === "number" ? "l.id >= ?" : "l.id IN (SELECT value FROM json_each(?))"} AND l.status = 'taken'
            AND l.occurred_at IS NOT NULL
          ORDER BY l.recorded_at, l.id
          ${typeof fromLogId === "number" ? "LIMIT 200" : ""}`
      )
      .all(
        profileId,
        typeof fromLogId === "number"
          ? fromLogId
          : JSON.stringify(fromLogId.ids)
      ) as {
      id: number;
      doseId: number;
      date: string;
      tapAt: string;
      statedAt: string | null;
      messageRef: number | null;
      bundleId: string | null;
      name: string;
    }[];
    const taps: {
      row: (typeof rows)[number];
      tapAt: string;
      statedAt: string | null;
    }[] = [];
    for (const r of rows) {
      const tap = parseUtcSql(r.tapAt);
      if (!tap) continue;
      const given = r.statedAt ? parseUtcSql(r.statedAt) : null;
      if (typeof fromLogId !== "number" && !given)
        return { kind: "no-burst" as const };
      taps.push({
        row: r,
        tapAt: tap.toISOString(),
        statedAt: given ? given.toISOString() : null,
      });
    }
    const byId = new Map(taps.map((t) => [t.row.id, t]));
    const burst = restampBurst(
      taps.map((t) => ({
        id: t.row.id,
        tapAt: t.tapAt,
        statedAt: t.statedAt,
        // A burst is one message's error (#3092): the write partitions by the same
        // provenance the renderer partitioned by, so a chip re-stamps exactly the
        // rows whose correction row it was.
        messageRef: t.row.messageRef,
        bundleId: t.row.bundleId,
        label: t.row.name,
      })),
      fromLogId
    );
    if (!burst) return { kind: "no-burst" as const };
    if (stillBound && !stillBound(burst)) return { kind: "not-bound" as const };

    // Resolve every row before writing any: one refusal refuses the burst.
    const targets = new Map<number, Date>();
    for (const id of burst.ids) {
      const t = byId.get(id);
      if (!t) continue;
      const instant = resolve({ tapAt: t.tapAt, statedAt: t.statedAt });
      if (!instant) return { kind: "out-of-range" as const };
      targets.set(id, instant);
    }

    const tz = getTimezone(profileId);
    let crossedMidnight = false;
    for (const id of burst.ids) {
      const t = byId.get(id);
      const instant = targets.get(id);
      if (!t || !instant) continue;
      if (dateStrInTz(tz, instant) !== t.row.date) crossedMidnight = true;
      // Re-scoped at the point of the WRITE (#2059), not only at the read that
      // produced `id`. The burst ids already come from the profile-filtered SELECT
      // above, so this changes no outcome today — it is the same double defence every
      // other `intake_item_logs` write in this file carries, and the reason CLAUDE.md
      // asks for it is that the ONE statement that mutates a row must not depend on a
      // sibling query staying correct through a later refactor or a new call site.
      // Scoped through dose → item rather than the row's own `item_id`, so the write
      // and the burst SELECT walk the identical join.
      db.prepare(
        `UPDATE intake_item_logs SET occurred_at = ?
          WHERE id = ? AND dose_id IN (
            SELECT d.id FROM intake_item_doses d
            JOIN intake_items s ON s.id = d.item_id
           WHERE s.profile_id = ?
          )`
      ).run(utcInstant(instant), id, profileId);
    }
    const anchorRow = byId.get(burst.fromId)?.row;
    return {
      kind: "restamped" as const,
      count: burst.ids.length,
      crossedMidnight,
      anchor: anchorRow
        ? { doseId: anchorRow.doseId, date: anchorRow.date }
        : { doseId: 0, date: today(profileId) },
    };
  });
}
