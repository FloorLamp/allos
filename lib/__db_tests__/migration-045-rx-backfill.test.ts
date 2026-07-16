// DB INTEGRATION TIER — migration 045 (the Rx flag) adds the column and backfills it
// once from existing columns (#851 item 1). A medication with a recorded prescriber
// OR Rx number is derived Rx=1; every other row (OTC meds, all supplements) stays 0.
// The backfill runs ONLY when the column is freshly added (guarded on PRAGMA
// table_info), so a later migrate() replay is a pure no-op and can't re-flip a row the
// user has since edited. Applied to a raw pre-045 schema built by hand.

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { up } from "@/lib/migrations/versions/045-medication-rx-flag";

interface SeedIds {
  a: number;
  b: number;
  c: number;
  d: number;
}

// The minimal slice of intake_items the backfill reads — no `rx` column yet, so up()
// takes its fresh-add branch. Only the columns the derivation touches are present.
function seedPre045(): { db: Database.Database; ids: SeedIds } {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE intake_items (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       profile_id INTEGER NOT NULL,
       name TEXT NOT NULL,
       kind TEXT NOT NULL,
       prescriber TEXT,
       rx_number TEXT
     );`
  );
  const ins = db.prepare(
    "INSERT INTO intake_items (profile_id, name, kind, prescriber, rx_number) VALUES (?,?,?,?,?)"
  );
  // (a) medication WITH a prescriber → derived Rx.
  const a = Number(
    ins.run(1, "Lisinopril", "medication", "Dr. Ada Test", null).lastInsertRowid
  );
  // (b) medication WITH an Rx number → derived Rx.
  const b = Number(
    ins.run(1, "Atorvastatin", "medication", null, "RX-000123").lastInsertRowid
  );
  // (c) medication with NEITHER → OTC (stays 0).
  const c = Number(
    ins.run(1, "Ibuprofen", "medication", null, null).lastInsertRowid
  );
  // (d) a supplement → always OTC (stays 0), even though prescriber columns exist.
  const d = Number(
    ins.run(1, "Vitamin D", "supplement", null, null).lastInsertRowid
  );
  return { db, ids: { a, b, c, d } };
}

function rxOf(db: Database.Database, id: number): number {
  return (
    db.prepare("SELECT rx FROM intake_items WHERE id = ?").get(id) as {
      rx: number;
    }
  ).rx;
}

describe("migration 045 — rx column + one-shot backfill", () => {
  it("adds rx and derives it from prescriber / Rx-number; supplements & bare meds stay OTC", () => {
    const { db, ids } = seedPre045();

    up(db);

    // Column exists now.
    const cols = new Set(
      (
        db.prepare("PRAGMA table_info(intake_items)").all() as {
          name: string;
        }[]
      ).map((r) => r.name)
    );
    expect(cols.has("rx")).toBe(true);

    expect(rxOf(db, ids.a)).toBe(1); // prescriber ⇒ Rx
    expect(rxOf(db, ids.b)).toBe(1); // Rx number ⇒ Rx
    expect(rxOf(db, ids.c)).toBe(0); // OTC med
    expect(rxOf(db, ids.d)).toBe(0); // supplement
  });

  it("is idempotent — a second up() is a no-op and never re-flips values", () => {
    const { db, ids } = seedPre045();
    up(db);

    // Simulate a user correction between replays: flip the derived-Rx (a) back to OTC.
    db.prepare("UPDATE intake_items SET rx = 0 WHERE id = ?").run(ids.a);

    // Second apply must NOT re-run the backfill (column already present), so the
    // user's edit survives and nothing else changes.
    expect(() => up(db)).not.toThrow();
    expect(rxOf(db, ids.a)).toBe(0); // stayed as the user set it, not re-derived to 1
    expect(rxOf(db, ids.b)).toBe(1);
    expect(rxOf(db, ids.c)).toBe(0);
    expect(rxOf(db, ids.d)).toBe(0);
  });
});
