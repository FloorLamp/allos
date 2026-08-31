import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { upsertPracticeLogs } from "@/lib/integrations/normalize";
import {
  deletePracticeSession,
  updatePracticeSession,
} from "@/lib/practice-log";
import { updateWellnessPractice } from "@/lib/practice-store";
import { writeImportTombstone } from "@/lib/integrations/tombstones";

describe("imported wellness practices", () => {
  it("is idempotent, respects manual edits, and stays deleted", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('PRACTICE IMPORT')").run()
        .lastInsertRowid
    );
    const row = {
      external_id: "fitbit-takeout:practice-test",
      practice: "Meditation",
      date: "2026-06-13",
      start_time: "13:05",
      duration_min: 30,
    };

    expect(upsertPracticeLogs(profileId, [row], "fitbit-takeout")).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
      superseded: 0,
    });
    expect(upsertPracticeLogs(profileId, [row], "fitbit-takeout")).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
      suppressed: 0,
      edited: 0,
      superseded: 0,
    });

    const imported = db
      .prepare(
        `SELECT id FROM practice_logs
          WHERE profile_id = ? AND external_id = ?`
      )
      .get(profileId, row.external_id) as { id: number };
    db.prepare(
      `UPDATE practice_logs SET duration_min = 45, edited = 1
        WHERE id = ? AND profile_id = ?`
    ).run(imported.id, profileId);
    expect(upsertPracticeLogs(profileId, [row], "fitbit-takeout")).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 1,
      superseded: 0,
    });
    expect(
      db
        .prepare(
          `SELECT duration_min FROM practice_logs
            WHERE id = ? AND profile_id = ?`
        )
        .get(imported.id, profileId)
    ).toEqual({ duration_min: 45 });

    // Since #2038 a session delete captures for undo and carries the token; the
    // tombstone below is written by the SAME transaction and is what keeps the resync
    // from resurrecting the row — undo and idempotency are orthogonal.
    expect(deletePracticeSession(profileId, imported.id)).toMatchObject({
      kind: "deleted",
      id: imported.id,
      undoId: expect.any(Number),
    });
    expect(upsertPracticeLogs(profileId, [row], "fitbit-takeout")).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      suppressed: 1,
      edited: 0,
      superseded: 0,
    });
  });

  it("keeps legacy activity edits, attachments, and deletions suppressed", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('PRACTICE LEGACY')").run()
        .lastInsertRowid
    );
    const editedId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, source, external_id, edited)
           VALUES (?, '2026-06-10', 'mobility', 'Breathwork',
                   'fitbit-takeout', 'fitbit-takeout:legacy-edited', 1)`
        )
        .run(profileId).lastInsertRowid
    );
    const attachedId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, source, external_id, edited)
           VALUES (?, '2026-06-11', 'sport', 'Meditating',
                   'fitbit-takeout', 'fitbit-takeout:legacy-attached', 0)`
        )
        .run(profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number)
       VALUES (?, 'Attached note', 1)`
    ).run(attachedId);
    writeImportTombstone(
      profileId,
      "activities",
      "fitbit-takeout:legacy-deleted"
    );

    const result = upsertPracticeLogs(
      profileId,
      [
        {
          external_id: "fitbit-takeout:legacy-edited",
          practice: "Meditation",
          date: "2026-06-10",
          start_time: "08:00",
          duration_min: 10,
        },
        {
          external_id: "fitbit-takeout:legacy-attached",
          practice: "Meditation",
          date: "2026-06-11",
          start_time: "08:00",
          duration_min: 15,
        },
        {
          external_id: "fitbit-takeout:legacy-deleted",
          practice: "Meditation",
          date: "2026-06-12",
          start_time: "08:00",
          duration_min: 20,
        },
      ],
      "fitbit-takeout"
    );

    expect(result).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      suppressed: 2,
      edited: 1,
      superseded: 0,
    });
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM practice_logs WHERE profile_id = ?`)
        .get(profileId)
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          `SELECT id FROM activities
            WHERE profile_id = ? AND id IN (?, ?) ORDER BY id`
        )
        .all(profileId, editedId, attachedId)
    ).toEqual([{ id: editedId }, { id: attachedId }]);
  });

  it("locks an imported session when its practice is renamed", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('PRACTICE RENAME')").run()
        .lastInsertRowid
    );
    const row = {
      external_id: "fitbit-takeout:rename",
      practice: "Meditation",
      date: "2026-06-13",
      start_time: "13:05",
      duration_min: 30,
    };
    upsertPracticeLogs(profileId, [row], "fitbit-takeout");
    const targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week)
           VALUES (?, 'practice', 'Meditation', 'meditation', 3)`
        )
        .run(profileId).lastInsertRowid
    );

    expect(
      updateWellnessPractice(profileId, targetId, "Mindfulness", 3, null)
    ).toEqual({ kind: "saved", targetId });
    expect(
      db
        .prepare(
          `SELECT practice, edited FROM practice_logs
            WHERE profile_id = ? AND external_id = ?`
        )
        .get(profileId, row.external_id)
    ).toEqual({ practice: "Mindfulness", edited: 1 });
    expect(upsertPracticeLogs(profileId, [row], "fitbit-takeout")).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 1,
      superseded: 0,
    });
    expect(
      db
        .prepare(
          `SELECT practice FROM practice_logs
            WHERE profile_id = ? AND external_id = ?`
        )
        .get(profileId, row.external_id)
    ).toEqual({ practice: "Mindfulness" });
  });

  // #4425 owner ruling: the bound this test was named for is gone. A dated correction
  // surface reaches any real past day, so a 2018 import is correctable to any 2018 day
  // — what was "bounded" is now simply "past". The FUTURE half is what still refuses,
  // and it is a tightening: the retired predicate accepted a date within thirty days of
  // the row being corrected, which for an old imported session meant a future one.
  it("corrects a historical imported session to any past day, never a future one", () => {
    const profileId = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('PRACTICE HISTORY')")
        .run().lastInsertRowid
    );
    const id = Number(
      db
        .prepare(
          `INSERT INTO practice_logs
             (profile_id, practice, date, duration_min, source, external_id)
           VALUES (?, 'Meditation', '2018-05-28', 10,
                   'fitbit-takeout', 'fitbit-takeout:historical')`
        )
        .run(profileId).lastInsertRowid
    );

    expect(
      updatePracticeSession(profileId, id, {
        date: "2018-05-29",
        startTime: "07:30",
        durationMin: 20,
        notes: "Corrected",
      })
    ).toMatchObject({
      kind: "updated",
      session: {
        id,
        date: "2018-05-29",
        duration_min: 20,
        edited: 1,
      },
    });
    expect(
      updatePracticeSession(profileId, id, {
        date: "2019-05-29",
        durationMin: 20,
      })
    ).toMatchObject({ kind: "updated", session: { date: "2019-05-29" } });
    expect(
      updatePracticeSession(profileId, id, {
        date: shiftDateStr(today(profileId), 1),
        durationMin: 20,
      })
    ).toEqual({ kind: "invalid-date" });
  });
});
