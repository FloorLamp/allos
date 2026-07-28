import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { upsertPracticeLogs } from "@/lib/integrations/normalize";
import { deletePracticeSession } from "@/lib/practice-log";

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
      time: "13:05",
      duration_min: 30,
    };

    expect(upsertPracticeLogs(profileId, [row], "fitbit-takeout")).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });
    expect(upsertPracticeLogs(profileId, [row], "fitbit-takeout")).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
      suppressed: 0,
      edited: 0,
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
    });
    expect(
      db
        .prepare(
          `SELECT duration_min FROM practice_logs
            WHERE id = ? AND profile_id = ?`
        )
        .get(imported.id, profileId)
    ).toEqual({ duration_min: 45 });

    expect(deletePracticeSession(profileId, imported.id)).toEqual({
      kind: "deleted",
      id: imported.id,
    });
    expect(upsertPracticeLogs(profileId, [row], "fitbit-takeout")).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      suppressed: 1,
      edited: 0,
    });
  });
});
