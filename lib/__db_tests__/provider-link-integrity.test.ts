// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Cheap backstop for the bare-INTEGER provider links: the nullable
// provider_id / location_provider_id columns on profile-owned rows point into the
// shared, GLOBAL providers registry, but several were added via addColumnIfMissing
// as plain INTEGERs (no enforced REFERENCES on upgraded DBs). This test asserts no
// such link dangles (points at a missing providers row) in a seeded DB, and proves
// the checker itself has teeth by planting a dangling ref and catching it.
//
// Runs via `npm run test:db`. The `db` singleton is pointed at a throwaway per-file
// temp DB by lib/__db_tests__/setup.ts; migrate() has already run.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";

// Every (owned table, provider-link column) pair. A new provider link must be
// added here so this backstop covers it.
const PROVIDER_LINKS: { table: string; column: string }[] = [
  { table: "immunizations", column: "provider_id" },
  { table: "medical_records", column: "provider_id" },
  { table: "intake_items", column: "provider_id" },
  { table: "encounters", column: "provider_id" },
  { table: "encounters", column: "location_provider_id" },
  { table: "appointments", column: "provider_id" },
];

// Rows whose non-null provider link has no matching providers row. Returns
// [] when every link resolves.
function danglingProviderLinks(): {
  table: string;
  column: string;
  id: number;
}[] {
  const out: { table: string; column: string; id: number }[] = [];
  for (const { table, column } of PROVIDER_LINKS) {
    const rows = db
      .prepare(
        `SELECT id FROM ${table}
          WHERE ${column} IS NOT NULL
            AND ${column} NOT IN (SELECT id FROM providers)`
      )
      .all() as { id: number }[];
    for (const r of rows) out.push({ table, column, id: r.id });
  }
  return out;
}

let profileId: number;
let providerId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('PL')").run()
      .lastInsertRowid
  );
  providerId = Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, dedup_key)
         VALUES ('Quest Diagnostics', 'organization', 'quest')`
      )
      .run().lastInsertRowid
  );
  // A row per provider-linked table: one resolving link + one NULL link, so the
  // checker exercises both the resolvable and the (legitimately) unlinked path.
  db.prepare(
    `INSERT INTO immunizations (profile_id, date, vaccine, provider_id) VALUES (?, '2020-01-01', 'mmr', ?)`
  ).run(profileId, providerId);
  db.prepare(
    `INSERT INTO medical_records (profile_id, date, category, name, provider_id) VALUES (?, '2020-01-01', 'lab', 'Glucose', ?)`
  ).run(profileId, providerId);
  db.prepare(
    `INSERT INTO medical_records (profile_id, date, category, name) VALUES (?, '2020-01-02', 'lab', 'HDL')`
  ).run(profileId);
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, active, kind, provider_id) VALUES (?, 'Vit D', 1, 'supplement', ?)`
  ).run(profileId, providerId);
  db.prepare(
    `INSERT INTO encounters (profile_id, date, provider_id, location_provider_id) VALUES (?, '2020-01-01', ?, ?)`
  ).run(profileId, providerId, providerId);
  db.prepare(
    `INSERT INTO appointments (profile_id, scheduled_at, provider_id) VALUES (?, '2030-01-01', ?)`
  ).run(profileId, providerId);
});

describe("provider links never dangle", () => {
  it("every seeded provider_id / location_provider_id resolves to a providers row", () => {
    expect(danglingProviderLinks()).toEqual([]);
  });

  it("the checker catches a planted dangling link", () => {
    // Insert an appointment pointing at a non-existent provider with FK enforcement
    // off (mimicking an addColumnIfMissing INTEGER link on an upgraded DB), prove
    // the checker flags it, then clean it up so the suite stays consistent.
    db.pragma("foreign_keys = OFF");
    const bad = Number(
      db
        .prepare(
          `INSERT INTO appointments (profile_id, scheduled_at, provider_id) VALUES (?, '2030-02-02', 999999)`
        )
        .run(profileId).lastInsertRowid
    );
    db.pragma("foreign_keys = ON");

    const dangling = danglingProviderLinks();
    expect(dangling).toContainEqual({
      table: "appointments",
      column: "provider_id",
      id: bad,
    });

    db.prepare("DELETE FROM appointments WHERE id = ?").run(bad);
    expect(danglingProviderLinks()).toEqual([]);
  });
});
