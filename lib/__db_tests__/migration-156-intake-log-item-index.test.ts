// DB INTEGRATION TIER — migration 156 (#2111 half 2): the arming-dose read is actually
// indexed.
//
// `getMedicationFamilyStates` finds an ingredient family's ARMING administration with
// no date bound — deliberately, since the interval clock is armed by the family's most
// recent dose whenever that was. On the baseline indexes SQLite answered it by scanning
// the whole append-only dose ledger through idx_intake_log_dose_date and then sorting
// the survivors, so the read degraded with account age on every dashboard render,
// every /medications render and every tick.
//
// A row count cannot see a plan, so what is pinned here is the PLAN ITSELF: the
// statement the module actually runs must SEARCH the new composite, never SCAN the
// ledger. That is the assertion that fails if a future widened filter quietly falls
// off the index — the failure this migration exists to prevent — and it is asserted
// alongside the answer, because an index must never change one.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Synthetic data
// only (fake meds; no PHI).

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { getMedicationFamilyStates } from "@/lib/queries";
import { utcInstant } from "@/lib/date";

const INDEX = "idx_intake_log_item_recorded";

// The latest-administration statement `getMedicationFamilyStates` prepares
// (lib/queries/intake/prn-family.ts), verbatim for a single-member family. Kept as its
// own constant so the plan assertion is about the real read, not a paraphrase.
const LATEST_SQL = `SELECT l.id AS id,
                COALESCE(l.occurred_at, l.recorded_at) AS administeredAt,
                l.item_id AS itemId
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE s.profile_id = ? AND l.item_id IN (?)
            AND l.status = 'taken'
          ORDER BY COALESCE(l.occurred_at, l.recorded_at) DESC, l.id DESC
          LIMIT 1`;

let profileId: number;
let itemId: number;
let newestId: number;

function plan(sql: string, ...args: unknown[]): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]
  )
    .map((r) => r.detail)
    .join(" | ");
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('ArmingIdx')").run()
      .lastInsertRowid
  );
  itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, min_interval_hours)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'may', 6)`
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', 'anytime', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  // A spread of administrations across days, so a whole-ledger scan plus sort would be
  // the visible alternative to an index-ordered seek.
  const ins = db.prepare(
    `INSERT INTO intake_item_logs
       (dose_id, item_id, date, recorded_at, occurred_at, status, amount)
     VALUES (?, ?, ?, ?, ?, 'taken', '200 mg')`
  );
  const td = today(profileId);
  for (let d = 30; d >= 1; d--) {
    const at = new Date(Date.now() - d * 86_400_000);
    newestId = Number(
      ins.run(doseId, itemId, td, utcInstant(at), utcInstant(at))
        .lastInsertRowid
    );
  }
});

describe("the (item_id, best administration instant) index", () => {
  it("applies: the index exists on the migrated schema", () => {
    const row = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`
      )
      .get(INDEX) as { sql: string } | undefined;
    expect(row?.sql).toBeTruthy();
  });

  it("indexes the event fallback expression and stable id ordering", () => {
    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(INDEX) as {
        sql: string;
      }
    ).sql;
    expect(sql).toContain("item_id, COALESCE(occurred_at, recorded_at), id");
  });

  it("the arming-dose read SEARCHES the index instead of scanning the ledger", () => {
    const detail = plan(LATEST_SQL, profileId, itemId);
    expect(detail).toContain(INDEX);
    expect(detail).toContain("item_id=?");
    // The shape that means "we read the whole append-only ledger to answer this".
    expect(detail).not.toContain("SCAN l");
  });

  it("a single-member family needs no temp b-tree for the ordering either", () => {
    // One item ⇒ the index already emits best-known event order, so LIMIT 1 is a seek.
    expect(plan(LATEST_SQL, profileId, itemId)).not.toContain("TEMP B-TREE");
  });

  it("both baseline indexes SURVIVE — the day-bounded reads still need them", () => {
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'intake_item_logs'`
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("idx_intake_log_date");
    expect(names).toContain("idx_intake_log_dose_date");
  });

  it("still finds the SAME arming administration — an index changes cost, not answers", () => {
    const state = getMedicationFamilyStates(profileId).get(
      itemId
    );
    expect(state?.latestId).toBe(newestId);
    // All 30 rows carry today's `date` while their instants are spread one per day
    // back — so the ceiling window (#4686) holds exactly the newest, sitting on the
    // 24h boundary the window includes. The day-scoped count said 30 and would have
    // called a month-old ledger a month's worth of doses taken today.
    expect(state?.count24h).toBe(1);
  });
});
