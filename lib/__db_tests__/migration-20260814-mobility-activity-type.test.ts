import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { NUMBERED_MIGRATIONS } from "@/lib/migrations/versions";
import { up as backfillFitbitComponents } from "@/lib/migrations/versions/117-fitbit-activity-components";
import { up as renameMobility } from "@/lib/migrations/versions/20260814-mobility-activity-type";

// The migrations that own the activity columns and CHECK consumed by the rename.
// The central runner suite owns full-chain ordering and application.
const ACTIVITY_SCHEMA_IDS = new Set([1, 9, 19, 58, 107, 172]);

function beforeMobilityRename(): Database.Database {
  const mem = new Database(":memory:");
  mem.pragma("foreign_keys = OFF");
  for (const migration of NUMBERED_MIGRATIONS) {
    if (ACTIVITY_SCHEMA_IDS.has(migration.id)) migration.up(mem);
  }
  return mem;
}

describe("20260814 mobility activity type", () => {
  it("renames stored and historical Fitbit tokens without disturbing the row graph", () => {
    const mem = beforeMobilityRename();
    mem.exec(`
      INSERT INTO profiles (id, name) VALUES (1, 'Alex');
      INSERT INTO equipment (id, name, category, profile_id)
      VALUES (8, 'Heat room', 'Sauna', 1);
      INSERT INTO activities
        (id, profile_id, date, type, title, notes, duration_min, distance_km,
         intensity, start_time, end_time, components, created_at, source,
         external_id, avg_hr, max_hr, elevation_m, avg_speed_kmh, max_speed_kmh,
         relative_effort, avg_power_w, max_power_w, weighted_avg_power_w,
         avg_cadence, avg_temp_c, kilojoules, workout_type, edited, updated_at,
         est_calories, equipment_id, elapsed_min)
      VALUES
        (40, 1, '2026-08-12', 'recovery', 'Mobility flow', 'hips', 25, 1.5,
         'easy', '07:00', '07:25',
         '[{"name":"Hip flow","type":"recovery","duration_min":25}]',
         '2026-08-12 11:00:00', 'manual', 'mobility-40', 88, 111, 12, 3.6,
         5.1, 7, 80, 120, 91, 70, 22, 190, 'flow', 1,
         '2026-08-12 11:30:00', 120, 8, 27),
        (41, 1, '2026-08-13', 'sport', 'Mixed session', NULL, 15, NULL,
         NULL, NULL, NULL,
         '[{"name":"Cooldown","type":"recovery"},{"name":"Run","type":"cardio"}]',
         '2026-08-13 11:00:00', 'manual', NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
         NULL, NULL, NULL),
        (42, 1, '2026-08-14', 'recovery', 'Legacy malformed', NULL, NULL, NULL,
         NULL, NULL, NULL, '{not-json', '2026-08-14 11:00:00', 'manual', NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, 0, NULL, NULL, NULL, NULL);
      INSERT INTO activities
        (id, profile_id, date, type, title, duration_min, source, edited)
      VALUES (43, 1, '2026-08-10', 'sport', 'Yoga', 35, 'fitbit-takeout', 0);
      INSERT INTO exercise_sets
        (id, activity_id, exercise, set_number, duration_sec)
      VALUES (70, 40, 'Hip flow', 1, 1500);
      UPDATE sqlite_sequence SET seq = 99 WHERE name = 'activities';
    `);
    backfillFitbitComponents(mem);

    const before = mem
      .prepare("SELECT * FROM activities WHERE id = 40")
      .get() as Record<string, unknown>;

    // The production runner disables FK enforcement around parent-table rebuilds.
    mem.pragma("foreign_keys = OFF");
    renameMobility(mem);
    mem.pragma("foreign_keys = ON");

    const after = mem
      .prepare("SELECT * FROM activities WHERE id = 40")
      .get() as Record<string, unknown>;
    expect({
      ...after,
      type: before.type,
      components: before.components,
    }).toEqual(before);
    expect(after.type).toBe("mobility");
    expect(JSON.parse(String(after.components))).toEqual([
      { name: "Hip flow", type: "mobility", duration_min: 25 },
    ]);
    expect(
      JSON.parse(
        String(
          mem
            .prepare("SELECT components FROM activities WHERE id = 41")
            .pluck()
            .get()
        )
      )
    ).toEqual([
      { name: "Cooldown", type: "mobility" },
      { name: "Run", type: "cardio" },
    ]);
    expect(
      mem.prepare("SELECT type, components FROM activities WHERE id = 42").get()
    ).toEqual({ type: "mobility", components: "{not-json" });
    const fitbit = mem
      .prepare("SELECT type, components FROM activities WHERE id = 43")
      .get() as { type: string; components: string };
    expect(fitbit.type).toBe("mobility");
    expect(JSON.parse(fitbit.components)).toEqual([
      {
        name: "Yoga",
        type: "mobility",
        distance_km: null,
        duration_min: 35,
      },
    ]);
    expect(
      mem
        .prepare("SELECT activity_id FROM exercise_sets WHERE id = 70")
        .pluck()
        .get()
    ).toBe(40);
    expect(
      mem.prepare("SELECT category FROM equipment WHERE id = 8").pluck().get()
    ).toBe("Sauna");
    expect(
      mem
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'activities'")
        .pluck()
        .get()
    ).toBe(99);
    expect(mem.pragma("foreign_key_check")).toEqual([]);
    expect(
      mem
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'activities' ORDER BY name"
        )
        .pluck()
        .all()
    ).toEqual(["idx_activities_external", "idx_activities_profile_date"]);

    const schema = mem
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'activities'"
      )
      .pluck()
      .get() as string;
    expect(schema).toContain("'mobility'");
    expect(schema).not.toContain("'recovery'");
    expect(() =>
      mem
        .prepare(
          "INSERT INTO activities (profile_id, date, type, title) VALUES (1, '2026-08-15', 'recovery', 'No')"
        )
        .run()
    ).toThrow();

    const rows = mem.prepare("SELECT * FROM activities ORDER BY id").all();
    renameMobility(mem);
    expect(mem.prepare("SELECT * FROM activities ORDER BY id").all()).toEqual(
      rows
    );
    mem.close();
  });
});
