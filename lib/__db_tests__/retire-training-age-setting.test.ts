import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { up } from "@/lib/migrations/versions/20260817-retire-training-age-setting";

describe("retired training age setting migration (#3067)", () => {
  it("removes only the retired setting and preserves protocol data", () => {
    const profileId = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('migration age fixture')")
        .run().lastInsertRowid
    );
    const retiredKey = "min" + "_training_age";
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, '18')"
    ).run(retiredKey);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('retire_training_age_control', 'preserved')"
    ).run();
    const protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols (profile_id, name, start_date, outcome_keys)
           VALUES (?, 'Preserved protocol', '2026-08-01', '[]')`
        )
        .run(profileId).lastInsertRowid
    );

    up(db);

    expect(
      db.prepare("SELECT value FROM settings WHERE key = ?").get(retiredKey)
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT value FROM settings WHERE key = 'retire_training_age_control'"
        )
        .get()
    ).toEqual({ value: "preserved" });
    expect(
      db.prepare("SELECT name FROM protocols WHERE id = ?").get(protocolId)
    ).toEqual({ name: "Preserved protocol" });
  });
});
