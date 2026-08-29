import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoStrandedDrafts } from "../../e2e/shared-profile-guard";

describe("profile-scoped stranded-draft assertion", () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-draft-assertion-"));
    dbPath = path.join(dir, "fixture.db");
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE activities (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        source TEXT,
        start_time TEXT,
        end_time TEXT,
        duration_min REAL
      );
      INSERT INTO profiles (id, name) VALUES (7, 'Owned workout fixture');
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails the owning spec when its discard is removed and names its profile", () => {
    db.prepare(
      `INSERT INTO activities
         (id, profile_id, title, date, source, start_time, end_time, duration_min)
       VALUES (41, 7, 'Unfinished probe', '2026-08-29', NULL, '13:00', NULL, NULL)`
    ).run();

    expect(() =>
      assertNoStrandedDrafts(dbPath, {
        kind: "spec-owned",
        profileId: 7,
        profileName: "Owned workout fixture",
      })
    ).toThrow(/Owned workout fixture.*profile 7/);

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM activities").get()
    ).toEqual({ count: 0 });
  });

  it("refuses a profile sweep when the declared owned-profile precondition is false", () => {
    expect(() =>
      assertNoStrandedDrafts(dbPath, {
        kind: "spec-owned",
        profileId: 7,
        profileName: "Somebody else's fixture",
      })
    ).toThrow(/expected owned fixture profile 7/);
  });
});
