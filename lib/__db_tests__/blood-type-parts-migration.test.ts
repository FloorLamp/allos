// DB INTEGRATION TIER — migration 052 splits the legacy single `blood_type`
// profile setting into its `blood_type_abo` / `blood_type_rh` halves.

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { NUMBERED_MIGRATIONS } from "@/lib/migrations/versions";
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

describe("migration 052 — blood_type → abo/rh parts", () => {
  it("splits valid values, preserves adopted halves and junk, and replays as a no-op", () => {
    db = new Database(":memory:");
    NUMBERED_MIGRATIONS[0].up(db); // profiles + profile_settings are the only owners

    const a = seedLegacy("legacy-o-pos", "O+");
    const b = seedLegacy("legacy-ab-neg", "AB-");
    const replay = seedLegacy("legacy-replay", "A-");
    const junk = seedLegacy("legacy-junk", "unknown");
    const empty = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('no-bt')").run()
        .lastInsertRowid
    );
    const partial = seedLegacy("legacy-partial", "B+");
    db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'blood_type_abo', 'O')"
    ).run(partial);

    m052.up(db);

    expect(parts(a)).toEqual([
      { key: "blood_type_abo", value: "O" },
      { key: "blood_type_rh", value: "+" },
    ]);
    expect(parts(b)).toEqual([
      { key: "blood_type_abo", value: "AB" },
      { key: "blood_type_rh", value: "-" },
    ]);
    expect(parts(junk)).toEqual([{ key: "blood_type", value: "unknown" }]);
    expect(parts(empty)).toEqual([]);
    expect(parts(partial)).toEqual([
      { key: "blood_type_abo", value: "O" },
      { key: "blood_type_rh", value: "+" },
    ]);

    const afterReplay = parts(replay);
    m052.up(db);
    expect(parts(replay)).toEqual(afterReplay);
    db.close();
  });
});
