// DB INTEGRATION TIER (issue #2702).
//
// The pre-flight migration snapshot, driven through the REAL `runMigrations`
// against real file-backed SQLite databases (not `:memory:` — the whole feature is
// about a file being copied). Three obligations, in order of how easy they are to
// skip:
//
//   1. It is TAKEN when a populated database has migrations pending.
//   2. It is NOT taken on the boots that dominate — nothing pending, a fresh
//      install, an in-memory handle, or an operator who switched it off.
//   3. It RESTORES to the pre-migration state. This is the one that matters: a
//      snapshot that exists but cannot be installed is worse than none, because it
//      reads as a safety net. It is exercised through `restoreCore` — the same core
//      `npm run restore` calls — including the #472 version gate, so this also
//      proves the runner does not produce a snapshot its own restore path refuses.
//
// Plus the refusal (nothing applied when the copy cannot be made) and the
// crash-loop reuse that stops a failing migration re-VACUUMing on every restart.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, afterEach } from "vitest";
import {
  runMigrations,
  readVersion,
  type Migration,
} from "@/lib/migrations/runner";
import { MIGRATIONS } from "@/lib/migrations/versions";
import {
  MigrationSnapshotError,
  listMigrationSnapshots,
  takePreMigrationSnapshot,
} from "@/lib/migrations/snapshot";
import {
  migrationSidecarName,
  migrationSnapshotDir,
  type PreMigrationSnapshotMeta,
} from "@/lib/migrations/snapshot-policy";
import {
  verificationSidecarName,
  decideSnapshotVersion,
} from "@/lib/backup-verify";
import { restoreCore, readSnapshotUserVersion } from "@/lib/restore";
import { listBackupNames, readVerification } from "@/lib/backup";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

const tmpRoots: string[] = [];

function tmpDb(): { root: string; dbPath: string; snapDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "allos-premigrate-"));
  tmpRoots.push(root);
  const dbPath = path.join(root, "allos.db");
  return { root, dbPath, snapDir: migrationSnapshotDir(dbPath) };
}

function open(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  return db;
}

afterEach(() => {
  let root: string | undefined;
  while ((root = tmpRoots.pop())) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// A tiny synthetic registry: one migration that builds a table, one that deletes
// rows out of it. Small on purpose — the runner's behaviour is what is under test,
// not the real 190-migration replay (which one case below does exercise, for the
// version gate).
const base: Migration = {
  name: "20260101-notes-table",
  up(db) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`
    );
  },
};
const deleteDrafts: Migration = {
  name: "20260102-drop-drafts",
  up(db) {
    db.prepare(`DELETE FROM notes WHERE body LIKE 'draft %'`).run();
  },
};

function seedNotes(db: Database.Database): void {
  const ins = db.prepare(`INSERT INTO notes (body) VALUES (?)`);
  ins.run("keep this one");
  ins.run("draft one");
  ins.run("draft two");
}

function noteBodies(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT body FROM notes ORDER BY id`).all() as { body: string }[]
  ).map((r) => r.body);
}

function ledger(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM schema_migrations ORDER BY rowid`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function readMeta(dir: string, name: string): PreMigrationSnapshotMeta {
  return JSON.parse(
    fs.readFileSync(path.join(dir, migrationSidecarName(name)), "utf8")
  ) as PreMigrationSnapshotMeta;
}

describe("pre-flight snapshot — taken when an upgrade meets data", () => {
  it("copies the database before a row-deleting migration applies, and records what it precedes", () => {
    const { dbPath, snapDir } = tmpDb();
    const db = open(dbPath);
    runMigrations(db, [base]);
    seedNotes(db);

    runMigrations(db, [base, deleteDrafts]);

    // The migration did its (destructive) work.
    expect(noteBodies(db)).toEqual(["keep this one"]);

    const names = listMigrationSnapshots(snapDir);
    expect(names).toHaveLength(1);
    const meta = readMeta(snapDir, names[0]);
    expect(meta.pending).toEqual(["20260102-drop-drafts"]);
    expect(meta.appliedCount).toBe(1);
    expect(meta.fromUserVersion).toBe(1);
    expect(meta.bytes).toBeGreaterThan(0);

    // The runner's foreign-key posture is restored exactly as before (#95).
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("writes the verification sidecar the restore tooling reads, so the snapshot is not refused as unverified", () => {
    const { dbPath, snapDir } = tmpDb();
    const db = open(dbPath);
    runMigrations(db, [base]);
    seedNotes(db);
    runMigrations(db, [base, deleteDrafts]);
    db.close();

    const [name] = listMigrationSnapshots(snapDir);
    expect(
      fs.existsSync(path.join(snapDir, verificationSidecarName(name)))
    ).toBe(true);
    // The real functions the restore CLI lists and classifies with.
    expect(listBackupNames(snapDir)).toContain(name);
    expect(readVerification(name, snapDir)?.integrity).toBe("ok");
  });
});

describe("pre-flight snapshot — restorable to the pre-migration state", () => {
  it("puts the deleted rows back through restoreCore, and the migration back in the pending set", () => {
    const { dbPath, snapDir } = tmpDb();
    let db = open(dbPath);
    runMigrations(db, [base]);
    seedNotes(db);
    runMigrations(db, [base, deleteDrafts]);
    expect(noteBodies(db)).toEqual(["keep this one"]);
    db.close();

    const [name] = listMigrationSnapshots(snapDir);
    const snapshotPath = path.join(snapDir, name);
    const snapshotUserVersion = readSnapshotUserVersion(snapshotPath);
    expect(snapshotUserVersion).toBe(1);

    // The same call `npm run restore -- <snapshot.db>` makes, gates included.
    const { asidePath } = restoreCore({
      snapshotPath,
      livePath: dbPath,
      snapshotOk: true,
      force: false,
      snapshotUserVersion,
      buildMigrationCount: MIGRATIONS.length,
    });
    expect(asidePath).not.toBeNull();

    db = open(dbPath);
    // The rows the migration removed are back...
    expect(noteBodies(db)).toEqual(["keep this one", "draft one", "draft two"]);
    // ...and so is the pre-migration schema state: the deleting migration is no
    // longer in the ledger, and the tripwire matches.
    expect(ledger(db)).toEqual(["20260101-notes-table"]);
    expect(readVersion(db)).toBe(1);
    db.close();
  });

  it("a snapshot from a pre-migration database passes the #472 restore version gate", () => {
    // The realistic shape, against the REAL registry: the snapshot's user_version
    // is the applied count BEFORE the pending set, which is necessarily lower than
    // the build's migration count — so `decideSnapshotVersion` (which only refuses
    // a snapshot NEWER than the build) accepts it.
    const { dbPath, snapDir } = tmpDb();
    const db = open(dbPath);
    const allButLast = MIGRATIONS.slice(0, MIGRATIONS.length - 1);
    runMigrations(db, allButLast);
    runMigrations(db);
    db.close();

    const [name] = listMigrationSnapshots(snapDir);
    const snapshotUserVersion = readSnapshotUserVersion(
      path.join(snapDir, name)
    );
    expect(snapshotUserVersion).toBe(allButLast.length);
    expect(
      decideSnapshotVersion({
        snapshotUserVersion,
        buildMigrationCount: MIGRATIONS.length,
        force: false,
      })
    ).toEqual({ ok: true, snapshotNewer: false });
  });
});

describe("pre-flight snapshot — NOT taken", () => {
  it("takes nothing on a fresh install: an empty ledger means there are no rows to lose", () => {
    const { dbPath, snapDir } = tmpDb();
    const db = open(dbPath);
    runMigrations(db, [base, deleteDrafts]);
    db.close();
    expect(fs.existsSync(snapDir)).toBe(false);
  });

  it("takes nothing on the ordinary boot, where nothing is pending", () => {
    const { dbPath, snapDir } = tmpDb();
    const db = open(dbPath);
    runMigrations(db, [base]);
    seedNotes(db);
    runMigrations(db, [base, deleteDrafts]);
    expect(listMigrationSnapshots(snapDir)).toHaveLength(1);

    // Every subsequent boot: same registry, nothing pending.
    runMigrations(db, [base, deleteDrafts]);
    runMigrations(db, [base, deleteDrafts]);
    expect(listMigrationSnapshots(snapDir)).toHaveLength(1);
    db.close();
  });

  it("takes nothing for an in-memory database — there is no file to copy", () => {
    const db = new Database(":memory:");
    const outcome = takePreMigrationSnapshot(db, {
      pending: ["20260102-drop-drafts"],
      appliedCount: 1,
      fromUserVersion: 1,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "in-memory" });
    db.close();
  });

  it("takes nothing when the operator switched it off, and applies the migration anyway", () => {
    const { dbPath, snapDir } = tmpDb();
    const db = open(dbPath);
    runMigrations(db, [base]);
    seedNotes(db);

    const prior = process.env.ALLOS_MIGRATION_SNAPSHOT;
    try {
      process.env.ALLOS_MIGRATION_SNAPSHOT = "off";
      runMigrations(db, [base, deleteDrafts]);
    } finally {
      if (prior === undefined) delete process.env.ALLOS_MIGRATION_SNAPSHOT;
      else process.env.ALLOS_MIGRATION_SNAPSHOT = prior;
    }

    expect(fs.existsSync(snapDir)).toBe(false);
    expect(noteBodies(db)).toEqual(["keep this one"]);
    expect(ledger(db)).toContain("20260102-drop-drafts");
    db.close();
  });
});

describe("pre-flight snapshot — the refusal", () => {
  it("refuses the boot with NOTHING applied when the copy cannot be made", () => {
    const { dbPath, snapDir } = tmpDb();
    const db = open(dbPath);
    runMigrations(db, [base]);
    seedNotes(db);

    // A plain FILE where the snapshot directory belongs: mkdir -p fails ENOTDIR.
    fs.mkdirSync(path.dirname(snapDir), { recursive: true });
    fs.writeFileSync(snapDir, "not a directory\n");

    expect(() => runMigrations(db, [base, deleteDrafts])).toThrow(
      MigrationSnapshotError
    );
    // Reversible by construction: the pending migration did not apply, the ledger
    // and tripwire are untouched, and the rows it would have deleted are all there.
    expect(ledger(db)).toEqual(["20260101-notes-table"]);
    expect(readVersion(db)).toBe(1);
    expect(noteBodies(db)).toEqual(["keep this one", "draft one", "draft two"]);
    db.close();
  });

  it("names the override in its own message, so the escape hatch is discoverable when it is needed", () => {
    const { dbPath, snapDir } = tmpDb();
    const db = open(dbPath);
    runMigrations(db, [base]);
    seedNotes(db);
    fs.mkdirSync(path.dirname(snapDir), { recursive: true });
    fs.writeFileSync(snapDir, "not a directory\n");

    expect(() => runMigrations(db, [base, deleteDrafts])).toThrow(
      /ALLOS_MIGRATION_SNAPSHOT=off/
    );
    expect(() => runMigrations(db, [base, deleteDrafts])).toThrow(
      /20260102-drop-drafts/
    );
    db.close();
  });
});

describe("pre-flight snapshot — a crash loop does not re-copy the database", () => {
  it("reuses the previous boot's snapshot while the same set is still pending", () => {
    const { dbPath, snapDir } = tmpDb();
    const db = open(dbPath);
    runMigrations(db, [base]);
    seedNotes(db);

    const explodes: Migration = {
      name: "20260103-explodes",
      up() {
        throw new Error("migration failed on purpose");
      },
    };

    expect(() => runMigrations(db, [base, explodes])).toThrow(/on purpose/);
    const first = listMigrationSnapshots(snapDir);
    expect(first).toHaveLength(1);

    // Restart, restart, restart: the same migration is still pending, so the same
    // copy still describes the database and is reused rather than retaken.
    expect(() => runMigrations(db, [base, explodes])).toThrow(/on purpose/);
    expect(() => runMigrations(db, [base, explodes])).toThrow(/on purpose/);
    expect(listMigrationSnapshots(snapDir)).toEqual(first);
    db.close();
  });

  it("takes a fresh one once the pending set has moved", () => {
    const { dbPath, snapDir } = tmpDb();
    const db = open(dbPath);
    runMigrations(db, [base]);
    seedNotes(db);

    runMigrations(db, [base, deleteDrafts]);
    const afterFirst = listMigrationSnapshots(snapDir);
    expect(afterFirst).toHaveLength(1);

    const second: Migration = {
      name: "20260104-add-column",
      up(db) {
        db.exec(`ALTER TABLE notes ADD COLUMN tag TEXT`);
      },
    };
    runMigrations(db, [base, deleteDrafts, second]);

    const afterSecond = listMigrationSnapshots(snapDir);
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[0]).not.toBe(afterFirst[0]);
    expect(readMeta(snapDir, afterSecond[0]).pending).toEqual([
      "20260104-add-column",
    ]);
    db.close();
  });
});
