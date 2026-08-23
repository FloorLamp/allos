import { describe, it, expect } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { runBootTx } from "@/lib/migrations/schema-utils";
import { makeTmpDir } from "../__tests__/tmp-dir";

// runBootTx's BOUNDED RETRY, DRIVEN BY A REAL LOCK (#3442).
//
// The retry existed from PR #582 and had never once fired. Its guard was
// `/SQLITE_BUSY/i.test(String(err))`, and better-sqlite3 does not put the result
// code in the message — a busy error stringifies to exactly
// `SqliteError: database is locked`. The code lives on `err.code`. So the
// "bounded retry backstop" the module documents was dead, and the only real wait
// on the boot path was the single `busy_timeout`. #3438's repair migration held
// the write lock for 2m24s and a boot worker five seconds behind CRASHED after
// 122 s rather than retrying.
//
// EVERY BUSY ERROR BELOW IS RAISED BY SQLITE, not synthesised. A test that threw
// `Object.assign(new Error("x"), { code: "SQLITE_BUSY" })` would prove only that
// the new guard reads the property the test just set; it could not have caught the
// original defect, because the original defect was a wrong belief about what
// better-sqlite3 actually throws. The contended connection runs with
// `busy_timeout = 0`, so SQLite raises the moment a peer holds the write lock —
// the same construction `boot-lock-race.test.ts` uses.

/** A file database plus a peer connection already holding the write lock. */
function contendedDb(label: string): {
  file: string;
  holder: InstanceType<typeof Database>;
  worker: InstanceType<typeof Database>;
} {
  const file = path.join(makeTmpDir(label), "allos.db");
  const holder = new Database(file);
  holder.pragma("journal_mode = WAL");
  holder.exec("CREATE TABLE t (v INTEGER PRIMARY KEY)");
  const worker = new Database(file);
  worker.pragma("journal_mode = WAL");
  // No tolerance at all: SQLite throws the INSTANT the lock is held, so the number
  // of throws this test observes is the number of retries and not a timing sample.
  worker.pragma("busy_timeout = 0");
  return { file, holder, worker };
}

describe("runBootTx's bounded SQLITE_BUSY retry (#3442)", () => {
  it("retries a real busy error and commits once the peer lets go", () => {
    const { holder, worker } = contendedDb("boot-tx-busy");
    try {
      holder.exec("BEGIN IMMEDIATE");
      const write = worker.transaction(() => {
        worker.prepare("INSERT INTO t (v) VALUES (?)").run(1);
      });

      let attempts = 0;
      const seenCodes: string[] = [];
      const seenStrings: string[] = [];
      runBootTx({
        immediate: () => {
          attempts++;
          // The peer commits before the THIRD attempt, so attempts 1 and 2 must
          // both raise and be retried. Placed here rather than on a timer: the
          // verdict is then a count, not a race.
          if (attempts === 3) holder.exec("COMMIT");
          try {
            write.immediate();
          } catch (err) {
            seenCodes.push(String((err as { code?: string }).code));
            seenStrings.push(String(err));
            throw err;
          }
        },
      });

      expect(attempts).toBe(3);
      expect(seenCodes).toEqual(["SQLITE_BUSY", "SQLITE_BUSY"]);
      // THE RECEIPT FOR THE WHOLE ISSUE. The retired guard tested this string, and
      // this is what SQLite actually hands it. If a future better-sqlite3 starts
      // putting the code in the message, this assertion flips and the comment
      // above stops being true — which is exactly when someone should re-read it.
      expect(seenStrings[0]).toBe("SqliteError: database is locked");
      expect(/SQLITE_BUSY/i.test(seenStrings[0] ?? "")).toBe(false);
      // The work actually landed: a retry that swallowed the write would satisfy
      // every count above and none of the point.
      expect(
        (worker.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n
      ).toBe(1);
    } finally {
      worker.close();
      holder.close();
    }
  });

  it("gives up after the bound rather than spinning on a lock nobody releases", () => {
    const { holder, worker } = contendedDb("boot-tx-busy-bound");
    try {
      holder.exec("BEGIN IMMEDIATE");
      const write = worker.transaction(() => {
        worker.prepare("INSERT INTO t (v) VALUES (?)").run(2);
      });
      let attempts = 0;
      const thrown = (() => {
        try {
          runBootTx(
            {
              immediate: () => {
                attempts++;
                write.immediate();
              },
            },
            // A small explicit bound so the assertion is about the SHAPE of the
            // loop (attempts + 1 tries, then the real error propagates) and not
            // about the production default.
            2
          );
          return null;
        } catch (err) {
          return err;
        }
      })();
      expect(attempts).toBe(3);
      expect(String((thrown as { code?: string }).code)).toBe("SQLITE_BUSY");
    } finally {
      worker.close();
      holder.close();
    }
  });

  it("propagates a NON-busy error immediately, without burning a retry", () => {
    const { worker } = contendedDb("boot-tx-nonbusy");
    try {
      worker.prepare("INSERT INTO t (v) VALUES (?)").run(7);
      const dupe = worker.transaction(() => {
        worker.prepare("INSERT INTO t (v) VALUES (?)").run(7);
      });
      let attempts = 0;
      const thrown = (() => {
        try {
          runBootTx({
            immediate: () => {
              attempts++;
              dupe.immediate();
            },
          });
          return null;
        } catch (err) {
          return err;
        }
      })();
      // ONE attempt. A guard that retried everything would read as "the retry
      // works" on the test above while quietly turning every boot failure into a
      // five-fold replay of a doomed transaction.
      expect(attempts).toBe(1);
      expect(String((thrown as { code?: string }).code)).toBe(
        "SQLITE_CONSTRAINT_PRIMARYKEY"
      );
    } finally {
      worker.close();
    }
  });
});
