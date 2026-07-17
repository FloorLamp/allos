// DB INTEGRATION TIER — migration 052 splits the legacy single `blood_type`
// profile setting into its `blood_type_abo` / `blood_type_rh` halves.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { migration as m052 } from "@/lib/migrations/versions/052-blood-type-parts";

let db: Database.Database;

function parts(profileId: number) {
  return db
    .prepare(
      "SELECT key, value FROM profile_settings WHERE profile_id = ? AND key LIKE 'blood_type%' ORDER BY key"
    )
    .all(profileId) as { key: string; value: string }[];
}

function seedLegacy(name: string, bloodType: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'blood_type', ?)"
  ).run(id, bloodType);
  return id;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  // Build the schema through everything BEFORE 052, so this test drives up() itself
  // and observes the legacy→split convergence.
  for (const m of MIGRATIONS) if (m.id < m052.id) m.up(db);
  db.pragma("foreign_keys = ON");
});

describe("migration 052 — blood_type → abo/rh parts", () => {
  it("splits every legacy value and drops the old key", () => {
    const a = seedLegacy("legacy-o-pos", "O+");
    const b = seedLegacy("legacy-ab-neg", "AB-");

    m052.up(db);

    expect(parts(a)).toEqual([
      { key: "blood_type_abo", value: "O" },
      { key: "blood_type_rh", value: "+" },
    ]);
    expect(parts(b)).toEqual([
      { key: "blood_type_abo", value: "AB" },
      { key: "blood_type_rh", value: "-" },
    ]);
  });

  it("replaying up() on an already-converged DB is a no-op", () => {
    const p = seedLegacy("legacy-replay", "A-");
    m052.up(db);
    const after = parts(p);
    m052.up(db);
    expect(parts(p)).toEqual(after);
  });

  it("leaves an unparseable legacy value alone rather than guessing", () => {
    const p = seedLegacy("legacy-junk", "unknown");
    m052.up(db);
    // Nothing invented, and the row is kept so nothing is lost.
    expect(parts(p)).toEqual([{ key: "blood_type", value: "unknown" }]);
  });

  it("is a no-op on a DB with no blood types stored", () => {
    const id = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('no-bt')").run()
        .lastInsertRowid
    );
    expect(() => m052.up(db)).not.toThrow();
    expect(parts(id)).toEqual([]);
  });

  it("never clobbers a half already present", () => {
    const p = seedLegacy("legacy-partial", "B+");
    // An adopted group is already on file, disagreeing with the legacy value.
    db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'blood_type_abo', 'O')"
    ).run(p);

    m052.up(db);

    // The existing half stands (INSERT OR IGNORE); only the missing one is written.
    expect(parts(p)).toEqual([
      { key: "blood_type_abo", value: "O" },
      { key: "blood_type_rh", value: "+" },
    ]);
  });
});
