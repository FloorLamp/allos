import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { assertNoStrandedDrafts } from "../../e2e/shared-profile-guard";
import { makeTmpDir } from "../__tests__/tmp-dir";

describe("profile-scoped stranded-draft assertion", () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = makeTmpDir("draft-assertion");
    dbPath = path.join(dir, "fixture.db");
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE logins (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
      CREATE TABLE login_profiles (
        login_id INTEGER NOT NULL,
        profile_id INTEGER NOT NULL,
        access TEXT NOT NULL
      );
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
      INSERT INTO logins (id, username) VALUES (3, 'e2e_owned_workout');
      INSERT INTO login_profiles (login_id, profile_id, access)
        VALUES (3, 7, 'write');
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
        ownerLogin: "e2e_owned_workout",
      })
    ).toThrow(/Owned workout fixture.*profile 7/);

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM activities").get()
    ).toEqual({ count: 0 });
  });

  it("refuses a profile sweep when the declared owned-profile precondition is false", () => {
    db.prepare(
      `INSERT INTO activities
         (id, profile_id, title, date, source, start_time, end_time, duration_min)
       VALUES (42, 7, 'Must survive rejection', '2026-08-29', NULL, '13:00', NULL, NULL)`
    ).run();

    expect(() =>
      assertNoStrandedDrafts(dbPath, {
        kind: "spec-owned",
        profileId: 7,
        profileName: "Somebody else's fixture",
        ownerLogin: "e2e_owned_workout",
      })
    ).toThrow(/expected owned fixture profile 7/);

    expect(
      db.prepare("SELECT title FROM activities WHERE id = 42").get()
    ).toEqual({ title: "Must survive rejection" });
  });

  it("rejects a profile granted to another login before repairing it", () => {
    db.exec(`
      INSERT INTO logins (id, username) VALUES (4, 'e2e_neighbour');
      INSERT INTO login_profiles (login_id, profile_id, access)
        VALUES (4, 7, 'read');
      INSERT INTO activities
        (id, profile_id, title, date, source, start_time, end_time, duration_min)
        VALUES (43, 7, 'Neighbour draft', '2026-08-29', NULL, '13:00', NULL, NULL);
    `);

    expect(() =>
      assertNoStrandedDrafts(dbPath, {
        kind: "spec-owned",
        profileId: 7,
        profileName: "Owned workout fixture",
        ownerLogin: "e2e_owned_workout",
      })
    ).toThrow(/not exclusively granted/);

    expect(
      db.prepare("SELECT title FROM activities WHERE id = 43").get()
    ).toEqual({ title: "Neighbour draft" });
  });
});
