// DB INTEGRATION TIER (issue #560).
//
// Situations are promoted from free-text string-keyed state to id-keyed rows:
//   • getActiveSituations/setActiveSituations read/write the `situations` table;
//   • resolveSituationId is NOCASE get-or-create (one vocabulary, no casing/
//     whitespace fragility);
//   • a situational supplement links via intake_items.situation_id, and
//     getSupplements COALESCEs the row's name so a rename re-keys it (and stays in
//     lockstep with the active set);
//   • migration 029 backfills legacy free-text situations + the active_situations
//     JSON into rows.
//
// Deterministic: :memory:-backed temp DB via setup.ts; no network.

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { db, migrate } from "@/lib/db";
import { MIGRATIONS } from "@/lib/migrations/versions";
import {
  getActiveSituations,
  setActiveSituations,
  resolveSituationId,
  getSituations,
} from "@/lib/settings";
import { getSupplements, getSituationalDueCount } from "@/lib/queries";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("situations vocabulary (#560)", () => {
  it("setActiveSituations upserts rows; getActiveSituations reads them back", () => {
    const p = newProfile("active-situations");
    expect(getActiveSituations(p)).toEqual([]);

    setActiveSituations(p, ["Illness", "Travel"]);
    expect(getActiveSituations(p).sort()).toEqual(["Illness", "Travel"]);
    // Toggling Travel off keeps its ROW (vocabulary) but reads inactive.
    setActiveSituations(p, ["Illness"]);
    expect(getActiveSituations(p)).toEqual(["Illness"]);
    expect(
      getSituations(p)
        .map((s) => s.name)
        .sort()
    ).toEqual(["Illness", "Travel"]);
  });

  it("resolveSituationId is NOCASE/whitespace get-or-create (one vocabulary)", () => {
    const p = newProfile("resolve");
    const a = resolveSituationId(p, "Poor sleep");
    const b = resolveSituationId(p, "  poor   sleep ");
    expect(a).not.toBeNull();
    expect(b).toBe(a); // same row despite casing/whitespace
    expect(resolveSituationId(p, "   ")).toBeNull();
    expect(getSituations(p).length).toBe(1);
  });

  it("getSupplements COALESCEs the linked situation row name (rename-safe)", () => {
    const p = newProfile("linked");
    const sid = resolveSituationId(p, "Illness")!;
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, condition, priority, situation, situation_id)
           VALUES (?, 'Zinc', 'situational', 'low', 'Illness', ?)`
        )
        .run(p, sid).lastInsertRowid
    );
    expect(getSupplements(p).find((s) => s.id === itemId)?.situation).toBe(
      "Illness"
    );

    // Rename the situation row → the supplement's displayed situation follows it,
    // AND the active set follows it, so they never disagree (#560 rename-safety).
    setActiveSituations(p, ["Illness"]);
    db.prepare("UPDATE situations SET name = 'Sickness' WHERE id = ?").run(sid);
    expect(getSupplements(p).find((s) => s.id === itemId)?.situation).toBe(
      "Sickness"
    );
    expect(getActiveSituations(p)).toEqual(["Sickness"]);
  });

  it("an unlinked legacy row falls back to its free-text situation", () => {
    const p = newProfile("legacy");
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, condition, priority, situation)
           VALUES (?, 'Zinc', 'situational', 'low', 'Illness')`
        )
        .run(p).lastInsertRowid
    );
    expect(getSupplements(p).find((s) => s.id === itemId)?.situation).toBe(
      "Illness"
    );
  });
});

// getSituationalDueCount (#1221 part 6): the shared dueness count behind BOTH the
// Supplements-bar activation line and the dashboard check-in "Anything going on?" line.
describe("getSituationalDueCount (#1221 part 6)", () => {
  it("counts situational supplements as due only while their situation is active", () => {
    const p = newProfile("situational-due");
    const sid = resolveSituationId(p, "Travel")!;
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, condition, priority, situation, situation_id, active)
           VALUES (?, 'Melatonin', 'situational', 'low', 'Travel', ?, 1)`
        )
        .run(p, sid).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '3 mg', 'Anytime', 'any', 0)`
    ).run(itemId);

    // Travel inactive → not due.
    expect(getSituationalDueCount(p)).toBe(0);
    // Activate Travel → the situational item is now due.
    setActiveSituations(p, ["Travel"]);
    expect(getSituationalDueCount(p)).toBe(1);
    // Deactivate → back to 0 (the toggle-off "trip's over" path).
    setActiveSituations(p, []);
    expect(getSituationalDueCount(p)).toBe(0);
  });
});

// Migration 029 backfill: a DB seeded with the PRE-029 shape (free-text situation +
// active_situations JSON) is migrated into situations rows + situation_id links.
describe("migration 029 backfill", () => {
  // Reproduce the PRE-029 schema: run migrations 001..028 by hand (the runner
  // applies with foreign_keys OFF for table/FK rebuilds, so mirror that).
  function preSituationsDb(): Database.Database {
    const d = new Database(":memory:");
    d.pragma("busy_timeout = 10000");
    d.pragma("foreign_keys = OFF");
    for (const m of MIGRATIONS) {
      if (m.id >= 29) break;
      m.up(d);
    }
    d.pragma("foreign_keys = ON");
    return d;
  }

  it("backfills free-text situations + active_situations into rows and links items", () => {
    const d = preSituationsDb();
    const profileId = Number(
      d.prepare("INSERT INTO profiles (name) VALUES ('legacy')").run()
        .lastInsertRowid
    );
    // A situational supplement with free-text situation, and a differently-cased
    // active_situations entry — the exact fragility the promotion fixes.
    const itemId = Number(
      d
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, condition, priority, situation)
           VALUES (?, 'Zinc', 'situational', 'low', 'Illness')`
        )
        .run(profileId).lastInsertRowid
    );
    d.prepare(
      `INSERT INTO profile_settings (profile_id, key, value)
       VALUES (?, 'active_situations', ?)`
    ).run(profileId, JSON.stringify(["illness", "Travel"]));

    // Now run migration 029.
    const m029 = MIGRATIONS.find((m) => m.id === 29)!;
    m029.up(d);

    const rows = d
      .prepare(
        "SELECT name, active FROM situations WHERE profile_id = ? ORDER BY name COLLATE NOCASE"
      )
      .all(profileId) as { name: string; active: number }[];
    // NOCASE-deduped vocabulary: Illness (active — matched the cased JSON entry) +
    // Travel (active).
    expect(rows.map((r) => r.name)).toEqual(["Illness", "Travel"]);
    expect(rows.find((r) => r.name === "Illness")?.active).toBe(1);
    expect(rows.find((r) => r.name === "Travel")?.active).toBe(1);

    // The item is linked to the Illness row.
    const link = d
      .prepare("SELECT situation_id FROM intake_items WHERE id = ?")
      .get(itemId) as { situation_id: number | null };
    const illnessId = (
      d
        .prepare(
          "SELECT id FROM situations WHERE profile_id = ? AND name = 'Illness' COLLATE NOCASE"
        )
        .get(profileId) as { id: number }
    ).id;
    expect(link.situation_id).toBe(illnessId);

    // The migrated string-keyed source is retired.
    const stale = d
      .prepare(
        "SELECT 1 FROM profile_settings WHERE profile_id = ? AND key = 'active_situations'"
      )
      .get(profileId);
    expect(stale).toBeUndefined();
    d.close();
  });

  it("migrate() (full apply incl. 029) leaves a fresh DB consistent", () => {
    // A full boot (baseline + all migrations + boot tasks) has no legacy data, so
    // situations is empty and boots cleanly — a no-op backfill.
    const d = new Database(":memory:");
    d.pragma("foreign_keys = ON");
    process.env.ADMIN_PASSWORD =
      process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";
    migrate(d);
    const n = (
      d.prepare("SELECT COUNT(*) AS n FROM situations").get() as { n: number }
    ).n;
    expect(n).toBe(0);
    d.close();
  });
});
