// DB INTEGRATION TIER — migration 155 (#2111 half 2): the arming-dose read is actually
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
import { utcSqlString } from "@/lib/date";

const INDEX = "idx_intake_log_item_given";

// The latest-administration statement `getMedicationFamilyStates` prepares
// (lib/queries/intake/prn-family.ts), verbatim for a single-member family. Kept as its
// own constant so the plan assertion is about the real read, not a paraphrase.
const LATEST_SQL = `SELECT l.id AS id, l.given_at AS givenAt, l.item_id AS itemId
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE s.profile_id = ? AND l.item_id IN (?)
            AND l.status = 'taken' AND l.given_at IS NOT NULL
          ORDER BY l.given_at DESC, l.id DESC
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
    `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, status, amount)
     VALUES (?, ?, ?, ?, 'taken', '200 mg')`
  );
  const td = today(profileId);
  for (let d = 30; d >= 1; d--) {
    const at = new Date(Date.now() - d * 86_400_000);
    newestId = Number(
      ins.run(doseId, itemId, td, utcSqlString(at)).lastInsertRowid
    );
  }
});

describe("migration 155 — the (item_id, given_at) administration index", () => {
  it("applies: the index exists on the migrated schema", () => {
    const row = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`
      )
      .get(INDEX) as { sql: string } | undefined;
    expect(row?.sql).toBeTruthy();
  });

  it("indexes the two columns the read needs, in the order it needs them", () => {
    const cols = (
      db.prepare(`PRAGMA index_info(${INDEX})`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(["item_id", "given_at"]);
  });

  it("the arming-dose read SEARCHES the index instead of scanning the ledger", () => {
    const detail = plan(LATEST_SQL, profileId, itemId);
    expect(detail).toContain(INDEX);
    expect(detail).toContain("item_id=?");
    // The shape that means "we read the whole append-only ledger to answer this".
    expect(detail).not.toContain("SCAN l");
  });

  it("a single-member family needs no temp b-tree for the ordering either", () => {
    // One item ⇒ the index already emits given_at order, so LIMIT 1 is a seek.
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
    const state = getMedicationFamilyStates(profileId, today(profileId)).get(
      itemId
    );
    expect(state?.latestId).toBe(newestId);
    expect(state?.countToday).toBe(30);
  });
});
