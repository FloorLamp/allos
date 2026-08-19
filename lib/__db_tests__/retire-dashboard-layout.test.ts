import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { up } from "@/lib/migrations/versions/20260818-retire-dashboard-layout";

describe("retired dashboard layout migration (#3096)", () => {
  it("removes the retired key for every profile and preserves other settings", () => {
    const first = Number(
      db
        .prepare(
          "INSERT INTO profiles (name) VALUES ('dashboard migration one')"
        )
        .run().lastInsertRowid
    );
    const second = Number(
      db
        .prepare(
          "INSERT INTO profiles (name) VALUES ('dashboard migration two')"
        )
        .run().lastInsertRowid
    );
    const retiredKey = "dashboard" + "_layout";
    const insert = db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)"
    );
    insert.run(first, retiredKey, '{"order":["steps-today"]}');
    insert.run(second, retiredKey, '{"hidden":["recent-labs"]}');
    insert.run(first, "week_mode", "rolling");

    up(db);

    expect(
      db
        .prepare("SELECT profile_id FROM profile_settings WHERE key = ?")
        .all(retiredKey)
    ).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'week_mode'"
        )
        .get(first)
    ).toEqual({ value: "rolling" });
  });
});
