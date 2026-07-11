// DB INTEGRATION TIER — equipment lifecycle + category enum (issue #341).
//
// Covers migrations 017 (retired column) and 018 (category CHECK + legacy fold),
// plus the lib/equipment.ts retire/query behavior against the real schema. The db
// singleton is redirected at a per-file temp DB by lib/__db_tests__/setup.ts before
// this file is imported (profile 1 exists via bootstrapAuth).

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { up as up017 } from "@/lib/migrations/versions/017-equipment-retire";
import { up as up018 } from "@/lib/migrations/versions/018-equipment-category-enum";
import {
  getEquipment,
  createEquipment,
  setEquipmentRetired,
} from "@/lib/equipment";
import { EQUIPMENT_CATEGORIES } from "@/lib/types";

function equipmentSql(handle: Database.Database): string {
  return (
    handle
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'equipment'"
      )
      .get() as { sql: string }
  ).sql;
}

describe("equipment schema — migrations 017 + 018", () => {
  it("has the retired column defaulting to 0, and the category CHECK", () => {
    const sql = equipmentSql(db);
    expect(sql).toMatch(/retired INTEGER NOT NULL DEFAULT 0/);
    // The CHECK lists the full fixed set.
    for (const c of EQUIPMENT_CATEGORIES) {
      expect(sql).toContain(`'${c}'`);
    }
  });

  it("accepts every canonical category and NULL", () => {
    for (const c of [...EQUIPMENT_CATEGORIES, null]) {
      expect(() =>
        db
          .prepare(
            "INSERT INTO equipment (profile_id, name, category) VALUES (1, ?, ?)"
          )
          .run(`ok-${c ?? "null"}`, c)
      ).not.toThrow();
    }
  });

  it("rejects an unknown category value", () => {
    for (const bad of ["Resistance band", "barbell", "", "Sled"]) {
      expect(() =>
        db
          .prepare(
            "INSERT INTO equipment (profile_id, name, category) VALUES (1, ?, ?)"
          )
          .run("bad", bad)
      ).toThrow(/CHECK constraint failed/);
    }
  });

  it("new rows default retired = 0", () => {
    const e = createEquipment(1, {
      name: "Fresh Bar",
      weight_kg: 20,
      category: "Barbell",
    });
    expect(e.retired).toBe(0);
  });
});

describe("getEquipment / setEquipmentRetired — retire semantics", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM equipment WHERE profile_id = 1").run();
  });

  it("excludes retired rows by default, includes them with includeRetired", () => {
    const live = createEquipment(1, {
      name: "Live Bar",
      weight_kg: 20,
      category: "Barbell",
    });
    const gone = createEquipment(1, {
      name: "Old Bar",
      weight_kg: 15,
      category: "Barbell",
    });
    setEquipmentRetired(1, gone.id, true);

    const visible = getEquipment(1).map((e) => e.id);
    expect(visible).toContain(live.id);
    expect(visible).not.toContain(gone.id);

    const all = getEquipment(1, { includeRetired: true }).map((e) => e.id);
    expect(all).toContain(live.id);
    expect(all).toContain(gone.id);
  });

  it("un-retire brings a row back into the default read", () => {
    const e = createEquipment(1, {
      name: "Kettlebell 24",
      weight_kg: 24,
      category: "Kettlebell",
    });
    setEquipmentRetired(1, e.id, true);
    expect(getEquipment(1).map((x) => x.id)).not.toContain(e.id);
    setEquipmentRetired(1, e.id, false);
    expect(getEquipment(1).map((x) => x.id)).toContain(e.id);
  });

  it("retire is profile-scoped — a foreign id is a no-op", () => {
    const e = createEquipment(1, {
      name: "Scoped Bar",
      weight_kg: 20,
      category: "Barbell",
    });
    setEquipmentRetired(999, e.id, true); // wrong profile
    expect(getEquipment(1).map((x) => x.id)).toContain(e.id);
  });
});

// Targeted fold test: simulate a pre-341 DB (baseline equipment: no retired column,
// no category CHECK, arbitrary free-text categories), seed legacy rows, then apply
// ONLY 017 + 018's up() and assert the fold + CHECK.
describe("migration 018 legacy category fold", () => {
  function preDb(): Database.Database {
    const handle = new Database(":memory:");
    handle.pragma("foreign_keys = OFF"); // no profiles row needed for this targeted test
    MIGRATIONS[0].up(handle); // 001-baseline (old equipment shape)
    return handle;
  }

  it("folds legacy free text to Other, canonicalizes casing, keeps NULL and known", () => {
    const handle = preDb();
    expect(equipmentSql(handle)).not.toContain("'Kettlebell'"); // pre-migration: no CHECK

    const seed = handle.prepare(
      "INSERT INTO equipment (id, profile_id, name, category) VALUES (?, 1, ?, ?)"
    );
    seed.run(1, "Trap bar", "barbell"); // lowercase canonical → 'Barbell'
    seed.run(2, "Leg press", "Machine"); // already canonical
    seed.run(3, "Foam roller", "Recovery tool"); // legacy free text → 'Other'
    seed.run(4, "Unknown", null); // NULL stays NULL
    seed.run(5, "Sauna cabin", "SAUNA"); // new-set name in wrong case → 'Sauna'

    up017(handle); // add retired
    up018(handle); // rebuild + fold

    expect(equipmentSql(handle)).toContain("'Kettlebell'"); // CHECK present now
    const rows = handle
      .prepare("SELECT id, category, retired FROM equipment ORDER BY id")
      .all() as { id: number; category: string | null; retired: number }[];
    expect(rows).toEqual([
      { id: 1, category: "Barbell", retired: 0 },
      { id: 2, category: "Machine", retired: 0 },
      { id: 3, category: "Other", retired: 0 },
      { id: 4, category: null, retired: 0 },
      { id: 5, category: "Sauna", retired: 0 },
    ]);
    handle.close();
  });

  it("preserves ids so exercise_sets.equipment_id links survive the rebuild", () => {
    const handle = preDb();
    handle
      .prepare(
        "INSERT INTO equipment (id, profile_id, name, category) VALUES (42, 1, 'PR Bar', 'barbell')"
      )
      .run();
    up017(handle);
    up018(handle);
    const row = handle
      .prepare("SELECT id, name FROM equipment WHERE id = 42")
      .get() as { id: number; name: string };
    expect(row).toEqual({ id: 42, name: "PR Bar" });
    handle.close();
  });

  it("replays as a pure no-op on an already-converged DB (sentinel-guarded)", () => {
    const handle = preDb();
    up017(handle);
    up018(handle);
    const before = equipmentSql(handle);
    handle
      .prepare(
        "INSERT INTO equipment (id, profile_id, name, category, retired) VALUES (7, 1, 'keep', 'Bike', 1)"
      )
      .run();

    expect(() => up018(handle)).not.toThrow(); // sentinel: CHECK already lists 'Kettlebell'
    expect(() => up017(handle)).not.toThrow(); // guarded ADD COLUMN

    expect(equipmentSql(handle)).toBe(before);
    const row = handle
      .prepare("SELECT category, retired FROM equipment WHERE id = 7")
      .get() as { category: string; retired: number };
    expect(row).toEqual({ category: "Bike", retired: 1 });
    handle.close();
  });
});
