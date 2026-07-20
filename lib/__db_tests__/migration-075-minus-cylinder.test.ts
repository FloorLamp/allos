// DB INTEGRATION TIER — migration 075 (#1036): the one-shot transposition of
// stored PLUS-cylinder optical prescriptions onto canonical MINUS-cylinder
// notation. Applied to a hand-built minimal table (the migration-045 pattern):
// a plus-cyl row transposes per the exact algebra (sphere += cyl, cyl negated,
// axis ± 90 on the 1–180 convention), while minus-cyl and cylinder-less rows stay
// byte-identical, and a replay is a pure no-op (no positive cylinders remain).

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { up } from "@/lib/migrations/versions/075-optical-minus-cylinder";

interface RxRow {
  id: number;
  od_sphere: number | null;
  od_cylinder: number | null;
  od_axis: number | null;
  os_sphere: number | null;
  os_cylinder: number | null;
  os_axis: number | null;
}

function seed(): { db: Database.Database; ids: Record<string, number> } {
  const db = new Database(":memory:");
  // The minimal slice of optical_prescriptions the transposition touches.
  db.exec(
    `CREATE TABLE optical_prescriptions (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       profile_id INTEGER NOT NULL,
       od_sphere REAL, od_cylinder REAL, od_axis INTEGER,
       os_sphere REAL, os_cylinder REAL, os_axis INTEGER
     );`
  );
  const ins = db.prepare(
    `INSERT INTO optical_prescriptions
       (profile_id, od_sphere, od_cylinder, od_axis, os_sphere, os_cylinder, os_axis)
     VALUES (1,?,?,?,?,?,?)`
  );
  const ids: Record<string, number> = {};
  // (a) plus-cyl both eyes: OD −3.00 +1.00 ×090 (axis wraps to 180),
  //     OS plano +0.50 ×180 (axis wraps to 90).
  ids.plus = Number(ins.run(-3, 1, 90, 0, 0.5, 180).lastInsertRowid);
  // (b) minus-cyl row — must stay byte-identical.
  ids.minus = Number(ins.run(-2, -1, 180, -1.75, -0.25, 85).lastInsertRowid);
  // (c) cylinder-less row — must stay byte-identical.
  ids.sphereOnly = Number(
    ins.run(-1.5, null, null, -1.25, null, null).lastInsertRowid
  );
  // (d) plus-cyl with a missing axis (sphere/cyl still transpose) and a missing
  //     sphere on the other eye (cyl/axis transpose, sphere stays null).
  ids.partial = Number(ins.run(-3, 1, null, null, 1.5, 45).lastInsertRowid);
  return { db, ids };
}

function row(db: Database.Database, id: number): RxRow {
  return db
    .prepare(`SELECT * FROM optical_prescriptions WHERE id = ?`)
    .get(id) as RxRow;
}

describe("migration 075 — plus-cylinder rows transpose to canonical minus-cyl", () => {
  it("transposes stored plus-cyl rows and leaves minus-cyl / cyl-less rows untouched", () => {
    const { db, ids } = seed();
    const minusBefore = row(db, ids.minus);
    const sphereOnlyBefore = row(db, ids.sphereOnly);

    up(db);

    // (a) both eyes transposed: sphere += cyl, cyl negated, axis ± 90.
    expect(row(db, ids.plus)).toMatchObject({
      od_sphere: -2,
      od_cylinder: -1,
      od_axis: 180,
      os_sphere: 0.5,
      os_cylinder: -0.5,
      os_axis: 90,
    });
    // (b)/(c) untouched byte-for-byte.
    expect(row(db, ids.minus)).toEqual(minusBefore);
    expect(row(db, ids.sphereOnly)).toEqual(sphereOnlyBefore);
    // (d) missing axis → sphere/cyl transpose, axis stays null; missing sphere →
    //     stays null while cyl/axis transpose.
    expect(row(db, ids.partial)).toMatchObject({
      od_sphere: -2,
      od_cylinder: -1,
      od_axis: null,
      os_sphere: null,
      os_cylinder: -1.5,
      os_axis: 135,
    });
  });

  it("a replay is a pure no-op (no positive cylinders remain)", () => {
    const { db, ids } = seed();
    up(db);
    const after = Object.values(ids).map((id) => row(db, id));
    up(db);
    expect(Object.values(ids).map((id) => row(db, id))).toEqual(after);
  });

  it("no-ops on a handle without the table (partial-schema guard)", () => {
    const db = new Database(":memory:");
    expect(() => up(db)).not.toThrow();
  });
});
