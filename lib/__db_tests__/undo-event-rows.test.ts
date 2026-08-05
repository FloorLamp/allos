// DB INTEGRATION TIER — undo for the two "remove one logged event" paths that used to
// hard-delete (issue #2038).
//
// The undo substrate is one engine that was applied unevenly to three siblings: deleting
// one substance history row captured, deleting one practice session or one food serving
// did not. Owner ruling 2026-08-05: extend undo to both. This file proves the round trip
// through the REAL write cores, not through captureDelete directly:
//
//   • practice session — delete → undo restores date/time/duration/notes, the weekly
//     progress read recomputes, and the re-import tombstone written by the delete is
//     removed again so a resync may legitimately re-ingest the session it just gave back.
//   • food serving — delete → undo restores the ledger row AND the day counter it
//     decremented, including the case where that serving was the day's LAST and the
//     counter row was dropped at zero (the generalization of the alcohol kind's
//     pair-capture assertion).
//   • buffer expiry — a swept (never-undone) delete leaves the tombstone standing, so the
//     idempotency contract outlives the undo window exactly as before.
//
// The db singleton is redirected at a per-file temp DB by setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { restoreDeletedRow, sweepDeletedRows } from "@/lib/undo-delete-db";
import {
  deletePracticeSession,
  logPracticeSession,
  updatePracticeSession,
} from "@/lib/practice-log";
import {
  deleteFoodLogEventCore,
  logFoodServingCore,
} from "@/lib/food-log-write";
import { getPracticeDayCount, getPracticeSessions } from "@/lib/queries";
import { loadImportTombstones } from "@/lib/integrations/tombstones";

let seq = 0;

function seedProfileRow(): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`Undo E${++seq}`)
      .lastInsertRowid
  );
}

// Every session of one practice, newest first — the read the history table renders.
const practiceSessions = (profileId: number, practice: string) =>
  getPracticeSessions(profileId, practice);

const countRows = (sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { c: number }).c;

function servings(
  profileId: number,
  date: string,
  group: string
): number | null {
  const row = db
    .prepare(
      `SELECT servings AS s FROM food_log
        WHERE profile_id = ? AND date = ? AND group_key = ?`
    )
    .get(profileId, date, group) as { s: number } | undefined;
  return row ? row.s : null;
}

function eventIds(profileId: number, date: string, group: string): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = ? ORDER BY id`
      )
      .all(profileId, date, group) as { id: number }[]
  ).map((r) => r.id);
}

describe("one practice session: delete → undo (#2038)", () => {
  it("restores the session with its facts intact and the weekly progress recomputed", () => {
    const profileId = seedProfileRow();
    const date = today(profileId);
    const logged = logPracticeSession(profileId, "Breathwork", date);
    expect(logged.kind).toBe("logged");
    const id = practiceSessions(profileId, "Breathwork")[0].id;
    // Give the session every field a correction could have set, so the restore is
    // asserted on more than its existence.
    updatePracticeSession(profileId, id, {
      date,
      time: "07:30",
      durationMin: 12,
      notes: "box breathing before work",
    });
    expect(getPracticeDayCount(profileId, "Breathwork", date)).toBe(1);

    const removed = deletePracticeSession(profileId, id);
    expect(removed.kind).toBe("deleted");
    expect(practiceSessions(profileId, "Breathwork")).toEqual([]);
    // The progress the card renders drops with it — the session is really gone, not
    // hidden.
    expect(getPracticeDayCount(profileId, "Breathwork", date)).toBe(0);

    const undoId = removed.kind === "deleted" ? removed.undoId : 0;
    expect(restoreDeletedRow(profileId, undoId)).toBe(true);

    const back = practiceSessions(profileId, "Breathwork");
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      practice: "Breathwork",
      date,
      time: "07:30",
      duration_min: 12,
      notes: "box breathing before work",
    });
    // A restore re-inserts with a NEW id (the substrate's contract) — nothing else
    // references a session by id, and the weekly progress reads the rows, not the ids.
    expect(getPracticeDayCount(profileId, "Breathwork", date)).toBe(1);
    // The holding row is consumed; a second undo of the same token finds nothing.
    expect(restoreDeletedRow(profileId, undoId)).toBe(false);
  });

  it("deleting one session leaves the practice's OTHER sessions alone", () => {
    const profileId = seedProfileRow();
    const date = today(profileId);
    logPracticeSession(profileId, "Sauna", date);
    const first = practiceSessions(profileId, "Sauna")[0].id;
    logPracticeSession(profileId, "Sauna", date);
    expect(practiceSessions(profileId, "Sauna")).toHaveLength(2);

    const removed = deletePracticeSession(profileId, first);
    expect(removed.kind).toBe("deleted");
    expect(practiceSessions(profileId, "Sauna")).toHaveLength(1);
    if (removed.kind !== "deleted") return;
    expect(restoreDeletedRow(profileId, removed.undoId)).toBe(true);
    expect(practiceSessions(profileId, "Sauna")).toHaveLength(2);
  });

  it("a leaked id and another profile's session both no-op", () => {
    const owner = seedProfileRow();
    const stranger = seedProfileRow();
    const date = today(owner);
    logPracticeSession(owner, "Cold plunge", date);
    const id = practiceSessions(owner, "Cold plunge")[0].id;

    expect(deletePracticeSession(stranger, id).kind).toBe("not-found");
    expect(deletePracticeSession(owner, id + 9999).kind).toBe("not-found");
    expect(practiceSessions(owner, "Cold plunge")).toHaveLength(1);
    // Nothing was captured for a refused delete.
    expect(
      countRows(
        `SELECT COUNT(*) AS c FROM deleted_rows WHERE profile_id = ?`,
        stranger
      )
    ).toBe(0);
  });
});

describe("the import tombstone and undo coexist (#2038)", () => {
  // The delete of an IMPORTED session writes a re-import tombstone so the next rolling
  // resync doesn't resurrect it. That is orthogonal to user-initiated undo: an undo
  // removes it (the row is back, the window may ingest its key again), and a delete left
  // to expire keeps it forever.
  function seedImportedSession(profileId: number, date: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO practice_logs (profile_id, practice, date, source, external_id)
           VALUES (?, 'Yoga', ?, 'health-connect', ?)`
        )
        .run(profileId, date, `hc-yoga-${++seq}`).lastInsertRowid
    );
  }

  it("undo removes the tombstone the delete wrote", () => {
    const profileId = seedProfileRow();
    const date = today(profileId);
    const id = seedImportedSession(profileId, date);

    const removed = deletePracticeSession(profileId, id);
    expect(removed.kind).toBe("deleted");
    expect(loadImportTombstones(profileId, "practice_logs").size).toBe(1);

    if (removed.kind !== "deleted") return;
    expect(restoreDeletedRow(profileId, removed.undoId)).toBe(true);
    expect(loadImportTombstones(profileId, "practice_logs").size).toBe(0);
  });

  it("an expired (never-undone) delete leaves the tombstone standing", () => {
    const profileId = seedProfileRow();
    const date = today(profileId);
    const id = seedImportedSession(profileId, date);

    expect(deletePracticeSession(profileId, id).kind).toBe("deleted");
    // Age the holding row past the buffer, then sweep — the retention expiry.
    db.prepare(
      `UPDATE deleted_rows SET deleted_at = datetime('now', '-2 days')
        WHERE profile_id = ?`
    ).run(profileId);
    expect(sweepDeletedRows(1)).toBeGreaterThan(0);
    expect(loadImportTombstones(profileId, "practice_logs").size).toBe(1);
    expect(
      countRows(
        `SELECT COUNT(*) AS c FROM practice_logs WHERE profile_id = ?`,
        profileId
      )
    ).toBe(0);
  });
});

describe("one food serving: delete → undo (#2038)", () => {
  it("restores the ledger row AND the day counter it decremented", () => {
    const profileId = seedProfileRow();
    const date = today(profileId);
    logFoodServingCore(profileId, "other_vegetables", date);
    logFoodServingCore(profileId, "other_vegetables", date);
    logFoodServingCore(profileId, "other_vegetables", date);
    expect(servings(profileId, date, "other_vegetables")).toBe(3);
    const ids = eventIds(profileId, date, "other_vegetables");
    expect(ids).toHaveLength(3);

    // Remove the MIDDLE tap: the whole point of the row-scoped removal (#1963) is that
    // it takes the row the user named, not the newest one.
    const removed = deleteFoodLogEventCore(profileId, ids[1]);
    expect(removed.kind).toBe("deleted");
    expect(servings(profileId, date, "other_vegetables")).toBe(2);
    expect(eventIds(profileId, date, "other_vegetables")).toEqual([
      ids[0],
      ids[2],
    ]);

    if (removed.kind !== "deleted") return;
    expect(restoreDeletedRow(profileId, removed.undoId)).toBe(true);
    // Both halves of the one fact come back: the counter is a DECREMENT/INCREMENT, so
    // the other two servings are untouched throughout.
    expect(servings(profileId, date, "other_vegetables")).toBe(3);
    expect(eventIds(profileId, date, "other_vegetables")).toHaveLength(3);
  });

  it("re-creates the counter row when the deleted serving was the day's last", () => {
    const profileId = seedProfileRow();
    const date = today(profileId);
    logFoodServingCore(profileId, "lean_fish", date);
    // A note on the day counter proves the RE-INSERT restores the snapshot, not just a
    // bare count.
    db.prepare(
      `UPDATE food_log SET notes = 'salmon, grilled'
        WHERE profile_id = ? AND date = ? AND group_key = 'lean_fish'`
    ).run(profileId, date);
    const [only] = eventIds(profileId, date, "lean_fish");

    const removed = deleteFoodLogEventCore(profileId, only);
    expect(removed.kind).toBe("deleted");
    // Emptied to zero, so the counter row itself is dropped — the pre-existing behavior
    // this undo has to be able to invert.
    expect(servings(profileId, date, "lean_fish")).toBeNull();
    expect(eventIds(profileId, date, "lean_fish")).toEqual([]);

    if (removed.kind !== "deleted") return;
    expect(restoreDeletedRow(profileId, removed.undoId)).toBe(true);
    expect(servings(profileId, date, "lean_fish")).toBe(1);
    expect(eventIds(profileId, date, "lean_fish")).toHaveLength(1);
    expect(
      (
        db
          .prepare(
            `SELECT notes AS n FROM food_log
              WHERE profile_id = ? AND date = ? AND group_key = 'lean_fish'`
          )
          .get(profileId, date) as { n: string | null }
      ).n
    ).toBe("salmon, grilled");
  });

  it("folds into a counter the day regained between the delete and the undo", () => {
    const profileId = seedProfileRow();
    const date = today(profileId);
    logFoodServingCore(profileId, "legumes", date);
    const [only] = eventIds(profileId, date, "legumes");
    const removed = deleteFoodLogEventCore(profileId, only);
    expect(removed.kind).toBe("deleted");

    // The user logs another legume serving before tapping Undo. The restore must give
    // back ONE serving on top of what stands, never reset the day to the snapshot.
    logFoodServingCore(profileId, "legumes", date);
    expect(servings(profileId, date, "legumes")).toBe(1);

    if (removed.kind !== "deleted") return;
    expect(restoreDeletedRow(profileId, removed.undoId)).toBe(true);
    expect(servings(profileId, date, "legumes")).toBe(2);
    expect(eventIds(profileId, date, "legumes")).toHaveLength(2);
  });

  it("keeps the serving's own meal-slot and eating-time facts across the round trip", () => {
    const profileId = seedProfileRow();
    const date = today(profileId);
    logFoodServingCore(
      profileId,
      "whole_grains",
      date,
      `${date}T18:40:00.000Z`,
      "Evening",
      { eatenAt: `${date}T18:00:00.000Z`, source: "stated" as const }
    );
    const [only] = eventIds(profileId, date, "whole_grains");
    const before = db
      .prepare(
        `SELECT group_key, date, meal_slot, eaten_at, time_source, logged_at
           FROM food_log_events WHERE id = ?`
      )
      .get(only);

    const removed = deleteFoodLogEventCore(profileId, only);
    expect(removed.kind).toBe("deleted");
    if (removed.kind !== "deleted") return;
    expect(restoreDeletedRow(profileId, removed.undoId)).toBe(true);

    const after = db
      .prepare(
        `SELECT group_key, date, meal_slot, eaten_at, time_source, logged_at
           FROM food_log_events WHERE profile_id = ? AND group_key = 'whole_grains'`
      )
      .get(profileId);
    // Everything but the autoincrement id survives — which is exactly why an undo beats
    // "just log it again": a re-tap would invent a fresh tap instant and lose the stated
    // eating time.
    expect(after).toEqual(before);
  });

  it("another profile's event id is a no-op that captures nothing", () => {
    const owner = seedProfileRow();
    const stranger = seedProfileRow();
    const date = today(owner);
    logFoodServingCore(owner, "nuts_seeds", date);
    const [only] = eventIds(owner, date, "nuts_seeds");

    expect(deleteFoodLogEventCore(stranger, only).kind).toBe("not-found");
    expect(servings(owner, date, "nuts_seeds")).toBe(1);
    expect(
      countRows(
        `SELECT COUNT(*) AS c FROM deleted_rows WHERE profile_id = ?`,
        stranger
      )
    ).toBe(0);
  });
});
