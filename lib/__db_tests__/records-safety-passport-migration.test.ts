// DB INTEGRATION TIER — migration 122 (issues #1405, #1406).
//
// Pins the three things a schema migration must actually prove: the columns/table
// exist with the vocabularies we intended, the CHECKs really refuse an out-of-set
// value (a CHECK that admits anything is decoration), and the one-shot backfill
// moves the existing scalar reaction onto the child table WITHOUT inventing a row
// for an allergy that never had one.
//
// Deterministic: :memory: only, no network.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { migrate } from "@/lib/db";
import { up as up122 } from "@/lib/migrations/versions/122-records-safety-passport";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  migrate(db);
  return db;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name)
    .sort();
}

function seedProfile(db: Database.Database, name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("migration 122 — schema shape", () => {
  it("adds the allergy safety columns and the allergy_reactions child table", () => {
    const db = newDb();
    const cols = columns(db, "allergies");
    expect(cols).toContain("criticality");
    expect(cols).toContain("verification_status");
    // A CHILD table: no profile_id of its own — it reaches one through allergy_id.
    const child = columns(db, "allergy_reactions");
    expect(child).toEqual([
      "allergy_id",
      "created_at",
      "id",
      "manifestation",
      "position",
      "severity",
    ]);
    expect(child).not.toContain("profile_id");
    db.close();
  });

  it("adds the immunization administration columns and the exemption type", () => {
    const db = newDb();
    const cols = columns(db, "immunizations");
    for (const c of ["lot_number", "route", "site", "reaction"])
      expect(cols).toContain(c);
    expect(columns(db, "immunization_overrides")).toContain("exemption_type");
    db.close();
  });

  it("is replay-safe (a second up() is a pure no-op)", () => {
    const db = newDb();
    const p = seedProfile(db, "replay");
    db.prepare(
      `INSERT INTO allergies (substance, reaction, severity, profile_id)
       VALUES ('Penicillin', 'Hives', 'moderate', ?)`
    ).run(p);
    // The backfill already ran during migrate(); running it again must not double.
    up122(db);
    up122(db);
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM allergy_reactions")
      .get() as { n: number };
    expect(n.n).toBe(1);
    db.close();
  });
});

describe("migration 122 — the CHECKs actually refuse", () => {
  it("rejects an out-of-vocabulary criticality / verification / route / exemption", () => {
    const db = newDb();
    const p = seedProfile(db, "checks");
    const insAllergy = db.prepare(
      `INSERT INTO allergies (substance, criticality, verification_status, profile_id)
       VALUES ('Latex', ?, ?, ?)`
    );
    expect(() => insAllergy.run("catastrophic", null, p)).toThrow();
    expect(() => insAllergy.run(null, "probably", p)).toThrow();
    // …and accepts the pinned values, plus NULL for "unstated".
    expect(() => insAllergy.run("high", "refuted", p)).not.toThrow();
    expect(() => insAllergy.run(null, null, p)).not.toThrow();

    const insImm = db.prepare(
      `INSERT INTO immunizations (date, vaccine, route, profile_id)
       VALUES ('2020-01-02', 'tdap', ?, ?)`
    );
    expect(() => insImm.run("telepathic", p)).toThrow();
    expect(() => insImm.run("intramuscular", p)).not.toThrow();
    expect(() => insImm.run(null, p)).not.toThrow();

    const insOverride = db.prepare(
      `INSERT INTO immunization_overrides (profile_id, vaccine, kind, exemption_type)
       VALUES (?, ?, 'declined', ?)`
    );
    expect(() => insOverride.run(p, "mmr", "vibes")).toThrow();
    expect(() => insOverride.run(p, "hepb", "religious")).not.toThrow();
    db.close();
  });
});

describe("migration 122 — the reaction backfill", () => {
  it("seeds row 0 from an existing scalar reaction, and skips an allergy with none", () => {
    const db = newDb();
    const p = seedProfile(db, "backfill");
    const withReaction = Number(
      db
        .prepare(
          `INSERT INTO allergies (substance, reaction, severity, profile_id)
           VALUES ('Peanut', '  Hives  ', 'moderate', ?)`
        )
        .run(p).lastInsertRowid
    );
    const withoutReaction = Number(
      db
        .prepare(
          `INSERT INTO allergies (substance, reaction, profile_id)
           VALUES ('Dust mite', '   ', ?)`
        )
        .run(p).lastInsertRowid
    );
    // Simulate the pre-122 world for these rows, then run the backfill.
    db.prepare("DELETE FROM allergy_reactions").run();
    up122(db);

    const rows = db
      .prepare(
        `SELECT allergy_id, manifestation, severity, position
           FROM allergy_reactions ORDER BY allergy_id`
      )
      .all() as {
      allergy_id: number;
      manifestation: string;
      severity: string | null;
      position: number;
    }[];
    expect(rows).toEqual([
      {
        allergy_id: withReaction,
        manifestation: "Hives",
        severity: "moderate",
        position: 0,
      },
    ]);
    expect(rows.some((r) => r.allergy_id === withoutReaction)).toBe(false);
    db.close();
  });

  it("cascades the child rows away when the allergy is deleted", () => {
    const db = newDb();
    const p = seedProfile(db, "cascade");
    const id = Number(
      db
        .prepare(
          `INSERT INTO allergies (substance, reaction, profile_id)
           VALUES ('Shellfish', 'Swelling', ?)`
        )
        .run(p).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO allergy_reactions (allergy_id, manifestation, severity, position)
       VALUES (?, 'Anaphylaxis', 'severe', 1)`
    ).run(id);
    db.prepare("DELETE FROM allergies WHERE id = ?").run(id);
    const n = db
      .prepare(
        "SELECT COUNT(*) AS n FROM allergy_reactions WHERE allergy_id = ?"
      )
      .get(id) as { n: number };
    expect(n.n).toBe(0);
    db.close();
  });
});
