// DB INTEGRATION TIER — the cross-practice day-history gather groups
// practice_logs by day and canonical practice identity, window-bounded and
// profile-scoped.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getPracticeDays } from "@/lib/queries/wellness";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function insertLog(
  profileId: number,
  date: string,
  practice: string,
  durationMin: number | null
): void {
  db.prepare(
    `INSERT INTO practice_logs (profile_id, practice, date, duration_min)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, practice, date, durationMin);
}

describe("getPracticeDays", () => {
  it("groups by day and canonical identity, merging spelling variants", () => {
    const profileId = newProfile("Practice Days");
    insertLog(profileId, "2026-06-01", "Sauna", 20);
    insertLog(profileId, "2026-06-01", "sauna", null); // spelling variant, null duration
    insertLog(profileId, "2026-06-03", "Cold plunge", 5);

    const rows = getPracticeDays(profileId, "2026-06-01", "2026-06-30");
    const sauna = rows.find((r) => r.date === "2026-06-01");
    expect(sauna).toMatchObject({ count: 2, minutes: 20, label: "Sauna" });
    expect(rows.find((r) => r.date === "2026-06-03")).toMatchObject({
      count: 1,
      minutes: 5,
    });
    // Both spellings share one canonical key.
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it("is window-bounded and profile-scoped", () => {
    const a = newProfile("Practice Days A");
    const b = newProfile("Practice Days B");
    insertLog(a, "2026-05-31", "Sauna", 20); // before window
    insertLog(a, "2026-06-02", "Sauna", 20);
    insertLog(a, "2026-06-04", "Sauna", 20); // after window
    insertLog(b, "2026-06-02", "Sauna", 99);

    const rows = getPracticeDays(a, "2026-06-01", "2026-06-03");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-06-02", minutes: 20 });
  });
});
