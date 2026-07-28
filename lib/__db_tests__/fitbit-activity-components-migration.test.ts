import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/117-fitbit-activity-components";

describe("migration 117 — Fitbit activity components", () => {
  it("backfills only unedited Fitbit rows whose component is missing", () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE profiles (
        id INTEGER PRIMARY KEY
      );
      INSERT INTO profiles (id) VALUES (1);
      CREATE TABLE activities (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL,
        source TEXT,
        edited INTEGER DEFAULT 0,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        duration_min INTEGER,
        distance_km REAL,
        components TEXT
      );
      INSERT INTO activities
        (id, profile_id, source, edited, title, type, duration_min, distance_km, components)
      VALUES
        (1, 1, 'fitbit-takeout', 0, 'Walk', 'cardio', 20, NULL, NULL),
        (2, 1, 'fitbit-takeout', 0, 'Outdoor Bike', 'cardio', 40, 12.5, NULL),
        (3, 1, 'fitbit-takeout', 0, 'Snowshoe Adventure', 'sport', 30, 2.1, NULL),
        (4, 1, 'fitbit-takeout', 1, 'Walk', 'cardio', 25, NULL, NULL),
        (5, 1, 'strava', 0, 'Walk', 'cardio', 15, 1.2, NULL),
        (6, 1, 'fitbit-takeout', 0, 'Walk', 'cardio', 10, 0.8,
         '[{"name":"Custom Walking","type":"cardio","distance_km":0.8,"duration_min":10}]'),
        (7, 1, 'fitbit-takeout', 0, 'Spinning', 'cardio', 50, NULL, NULL),
        (8, 1, 'fitbit-takeout', 0, 'Yoga', 'sport', 35, NULL, NULL),
        (9, 1, 'fitbit-takeout', 0, 'HIIT', 'sport', 25, NULL, NULL),
        (10, 1, 'fitbit-takeout', 0, 'Weights', 'sport', 45, NULL, NULL),
        (11, 1, 'fitbit-takeout', 0, 'Tennis', 'sport', 60, NULL, NULL),
        (12, 1, 'fitbit-takeout', 0, 'Skateboarding', 'sport', 30, 3.2, NULL),
        (13, 1, 'fitbit-takeout', 0, 'Jumping rope', 'sport', 15, NULL, NULL),
        (14, 1, 'fitbit-takeout', 0, 'Rowing Machine', 'strength', 25, NULL, NULL),
        (15, 1, 'fitbit-takeout', 0, 'Tabata Workout', 'sport', 20, NULL, NULL),
        (16, 1, 'fitbit-takeout', 0, 'TRX', 'sport', 35, NULL, NULL),
        (17, 1, 'fitbit-takeout', 0, 'Roller blading', 'sport', 40, 8.5, NULL);
    `);

    up(mem);
    up(mem);

    const rows = mem
      .prepare("SELECT id, type, components FROM activities ORDER BY id")
      .all() as { id: number; type: string; components: string | null }[];
    const component = (id: number) => {
      const value = rows.find((row) => row.id === id)?.components;
      return value ? JSON.parse(value) : null;
    };
    const type = (id: number) => rows.find((row) => row.id === id)?.type;

    expect(component(1)).toEqual([
      {
        name: "Walking",
        type: "cardio",
        distance_km: null,
        duration_min: 20,
      },
    ]);
    expect(component(2)).toEqual([
      {
        name: "Cycling",
        type: "cardio",
        distance_km: 12.5,
        duration_min: 40,
      },
    ]);
    expect(component(3)).toEqual([
      {
        name: "Snowshoe Adventure",
        type: "cardio",
        distance_km: 2.1,
        duration_min: 30,
      },
    ]);
    expect(type(3)).toBe("cardio");
    expect(component(4)).toBeNull();
    expect(type(4)).toBe("cardio");
    expect(component(5)).toBeNull();
    expect(type(5)).toBe("cardio");
    expect(component(6)).toEqual([
      {
        name: "Custom Walking",
        type: "cardio",
        distance_km: 0.8,
        duration_min: 10,
      },
    ]);
    expect(component(7)).toEqual([
      {
        name: "Stationary Bike",
        type: "cardio",
        distance_km: null,
        duration_min: 50,
      },
    ]);
    expect(component(8)).toEqual([
      {
        name: "Yoga",
        type: "recovery",
        distance_km: null,
        duration_min: 35,
      },
    ]);
    expect(type(8)).toBe("recovery");
    expect(component(9)).toEqual([
      {
        name: "HIIT",
        type: "cardio",
        distance_km: null,
        duration_min: 25,
      },
    ]);
    expect(type(9)).toBe("cardio");
    expect(component(10)).toEqual([
      {
        name: "Weight Training",
        type: "strength",
        distance_km: null,
        duration_min: 45,
      },
    ]);
    expect(type(10)).toBe("strength");
    expect(component(11)).toEqual([
      {
        name: "Tennis",
        type: "sport",
        distance_km: null,
        duration_min: 60,
      },
    ]);
    expect(type(11)).toBe("sport");
    expect(component(12)).toEqual([
      {
        name: "Skateboarding",
        type: "sport",
        distance_km: 3.2,
        duration_min: 30,
      },
    ]);
    expect(type(12)).toBe("sport");
    expect(component(13)).toEqual([
      {
        name: "Jump Rope",
        type: "cardio",
        distance_km: null,
        duration_min: 15,
      },
    ]);
    expect(type(13)).toBe("cardio");
    expect(component(14)).toEqual([
      {
        name: "Rowing",
        type: "cardio",
        distance_km: null,
        duration_min: 25,
      },
    ]);
    expect(type(14)).toBe("cardio");
    expect(component(15)).toEqual([
      {
        name: "HIIT",
        type: "cardio",
        distance_km: null,
        duration_min: 20,
      },
    ]);
    expect(type(15)).toBe("cardio");
    expect(component(16)).toEqual([
      {
        name: "TRX",
        type: "strength",
        distance_km: null,
        duration_min: 35,
      },
    ]);
    expect(type(16)).toBe("strength");
    expect(component(17)).toEqual([
      {
        name: "Rollerblading",
        type: "cardio",
        distance_km: 8.5,
        duration_min: 40,
      },
    ]);
    expect(type(17)).toBe("cardio");

    mem.close();
  });
});
