import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, rawDb, writeTx } from "@/lib/db";
import { readDataWriteRevision } from "@/lib/write-revision";

function revision(): number {
  return readDataWriteRevision(db);
}

function insert(id: number, value = `value-${id}`): void {
  db.prepare(
    "INSERT INTO data_write_revision_probe (id, value) VALUES (?, ?)"
  ).run(id, value);
}

describe("transaction-owned data write revision", () => {
  beforeAll(() => {
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS data_write_revision_probe (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL UNIQUE
      )
    `);
  });

  beforeEach(() => {
    db.prepare("DELETE FROM data_write_revision_probe").run();
  });

  it("advances once for direct, outer, and nested changed commits", () => {
    let before = revision();
    insert(1);
    expect(revision()).toBe(before + 1);

    before = revision();
    writeTx(() => {
      insert(2);
      insert(3);
      writeTx(() => insert(4));
    });
    expect(revision()).toBe(before + 1);
  });

  it("does not advance for zero changes or rolled-back writes", () => {
    const before = revision();
    db.prepare("DELETE FROM data_write_revision_probe WHERE id = -1").run();
    expect(revision()).toBe(before);

    expect(() =>
      writeTx(() => {
        insert(10);
        throw new Error("rollback");
      })
    ).toThrow("rollback");
    expect(revision()).toBe(before);

    writeTx(() => {
      try {
        writeTx(() => {
          insert(11);
          throw new Error("savepoint rollback");
        });
      } catch {
        // The outer transaction intentionally commits no work.
      }
    });
    expect(revision()).toBe(before);
  });

  it("advances after a caught inner rollback only when later outer work lands", () => {
    const before = revision();
    writeTx(() => {
      try {
        writeTx(() => {
          insert(20);
          throw new Error("savepoint rollback");
        });
      } catch {
        insert(21);
      }
    });
    expect(revision()).toBe(before + 1);
    expect(
      db.prepare("SELECT id FROM data_write_revision_probe ORDER BY id").all()
    ).toEqual([{ id: 21 }]);
  });

  it("accounts for rows retained by a caught SQLite FAIL", () => {
    const before = revision();
    writeTx(() => {
      try {
        db.prepare(
          `INSERT OR FAIL INTO data_write_revision_probe (id, value)
           VALUES (30, 'kept'), (31, 'kept')`
        ).run();
      } catch {
        // FAIL retains the first row and leaves the transaction live.
      }
    });
    expect(revision()).toBe(before + 1);
    expect(
      db.prepare("SELECT id FROM data_write_revision_probe ORDER BY id").all()
    ).toEqual([{ id: 30 }]);

    const afterCommit = revision();
    expect(() =>
      writeTx(() => {
        try {
          db.prepare(
            `INSERT OR FAIL INTO data_write_revision_probe (id, value)
             VALUES (40, 'rolled-back'), (41, 'rolled-back')`
          ).run();
        } catch {
          // The outer failure below rolls back both the retained row and signal.
        }
        throw new Error("outer rollback");
      })
    ).toThrow("outer rollback");
    expect(revision()).toBe(afterCommit);
    expect(
      db.prepare("SELECT id FROM data_write_revision_probe WHERE id = 40").get()
    ).toBeUndefined();
  });

  it("preserves a bare SQLite FAIL prefix and commits its revision before throwing", () => {
    const before = revision();
    expect(() =>
      db
        .prepare(
          `INSERT OR FAIL INTO data_write_revision_probe (id, value)
         VALUES (45, 'bare-kept'), (46, 'bare-kept')`
        )
        .run()
    ).toThrow();
    expect(revision()).toBe(before + 1);
    expect(
      db
        .prepare(
          "SELECT id FROM data_write_revision_probe WHERE id IN (45, 46) ORDER BY id"
        )
        .all()
    ).toEqual([{ id: 45 }]);
  });

  it("does not advance for a bare SQLite ABORT that retains no rows", () => {
    insert(47, "abort-existing");
    const before = revision();
    expect(() =>
      db
        .prepare(
          `INSERT INTO data_write_revision_probe (id, value)
         VALUES (48, 'abort-new'), (49, 'abort-existing')`
        )
        .run()
    ).toThrow();
    expect(revision()).toBe(before);
    expect(
      db
        .prepare(
          "SELECT id FROM data_write_revision_probe WHERE id IN (48, 49) ORDER BY id"
        )
        .all()
    ).toEqual([]);
  });

  it("tracks mutating RETURNING executions through get, all, and iterate", () => {
    insert(50);
    insert(51);
    insert(52);

    let before = revision();
    expect(
      db
        .prepare(
          "UPDATE data_write_revision_probe SET value = value || '-get' WHERE id = 50 RETURNING id"
        )
        .get()
    ).toEqual({ id: 50 });
    expect(revision()).toBe(before + 1);

    before = revision();
    expect(
      db
        .prepare(
          "UPDATE data_write_revision_probe SET value = value || '-all' WHERE id = 51 RETURNING id"
        )
        .all()
    ).toEqual([{ id: 51 }]);
    expect(revision()).toBe(before + 1);

    before = revision();
    expect([
      ...db
        .prepare(
          "UPDATE data_write_revision_probe SET value = value || '-iterate' WHERE id = 52 RETURNING id"
        )
        .iterate(),
    ]).toEqual([{ id: 52 }]);
    expect(revision()).toBe(before + 1);
  });

  it("keeps fluent statement returns inside the project capability", () => {
    const statement = db.prepare(
      "SELECT value FROM data_write_revision_probe WHERE id = ?"
    );
    for (const fluent of [
      statement.pluck(),
      statement.pluck(false),
      statement.raw(),
      statement.raw(false),
      statement.expand(),
      statement.expand(false),
      statement.safeIntegers(),
      statement.safeIntegers(false),
      statement.bind(999),
    ]) {
      expect(fluent).toBe(statement);
      expect("database" in fluent).toBe(false);
    }
    expect("database" in statement).toBe(false);
    expect("transaction" in db).toBe(false);
    expect("exec" in db).toBe(false);
  });
});
