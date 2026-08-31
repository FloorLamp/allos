import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { NUMBERED_MIGRATIONS } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/20260814-intake-log-time-vocabulary";

const LOG_SCHEMA_IDS = new Set([
  1, 5, 8, 11, 41, 56, 79, 80, 135, 156, 165, 170, 173,
]);

function beforeRename(): Database.Database {
  const mem = new Database(":memory:");
  mem.pragma("foreign_keys = OFF");
  for (const migration of NUMBERED_MIGRATIONS) {
    if (LOG_SCHEMA_IDS.has(migration.id)) migration.up(mem);
  }
  return mem;
}

function seedParents(mem: Database.Database): {
  itemId: number;
  doseId: number;
} {
  mem
    .prepare("INSERT INTO profiles (id, name) VALUES (1, 'Time rename')")
    .run();
  const itemId = Number(
    mem
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, product, active, kind, condition)
         VALUES (1, 'Ibuprofen', 'Oral suspension', 1, 'medication', 'daily')`
      )
      .run().lastInsertRowid
  );
  const doseId = Number(
    mem
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', 'anytime', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

describe("#2876 dose event/record vocabulary migration", () => {
  it("preserves event meaning while rebuilding identity, triggers, and foreign keys", () => {
    const mem = beforeRename();
    const { itemId, doseId } = seedParents(mem);
    const insert = mem.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, taken_at, recorded_at, occurred_at, amount, status)
       VALUES (?, ?, ?, ?, ?, ?, '200 mg', 'taken')`
    );
    insert.run(
      doseId,
      itemId,
      "2026-08-12",
      "2026-08-12 14:00:05",
      "2026-08-12 13:55:00",
      null
    );
    insert.run(
      doseId,
      itemId,
      "2026-08-13",
      "2026-08-13 09:00:05",
      "2026-08-13 08:55:00",
      "2026-08-13T08:45:00Z"
    );
    mem
      .prepare(
        `INSERT INTO deleted_rows (profile_id, kind, label, payload)
       VALUES (1, 'administration', 'administration', ?)`
      )
      .run(
        JSON.stringify({
          administration: {
            dose_id: doseId,
            item_id: itemId,
            date: "2026-08-11",
            taken_at: "2026-08-11 18:00:05",
            recorded_at: "2026-08-11 17:50:00",
            amount: "200 mg",
            status: "taken",
            supply_adjusted: 1,
          },
        })
      );
    mem
      .prepare(
        `INSERT INTO intake_item_logs (id, dose_id, item_id, date, taken_at, status)
       VALUES (41, ?, ?, '2026-08-10', '2026-08-10 09:00:05', 'taken')`
      )
      .run(doseId, itemId);
    mem.prepare("DELETE FROM intake_item_logs WHERE id = 41").run();

    up(mem);

    expect(
      mem
        .prepare(
          `SELECT id, recorded_at, occurred_at, amount
             FROM intake_item_logs ORDER BY id`
        )
        .all()
    ).toEqual([
      {
        id: 1,
        recorded_at: "2026-08-12T14:00:05Z",
        occurred_at: "2026-08-12T13:55:00Z",
        amount: "200 mg",
      },
      {
        id: 2,
        recorded_at: "2026-08-13T09:00:05Z",
        occurred_at: "2026-08-13T08:45:00Z",
        amount: "200 mg",
      },
    ]);
    const payload = JSON.parse(
      (
        mem
          .prepare(
            "SELECT payload FROM deleted_rows WHERE kind = 'administration'"
          )
          .get() as { payload: string }
      ).payload
    ) as { administration: Record<string, unknown> };
    expect(payload.administration).toMatchObject({
      recorded_at: "2026-08-11T18:00:05Z",
      occurred_at: "2026-08-11T17:50:00Z",
    });
    expect(payload.administration).not.toHaveProperty("taken_at");
    const schema = (
      mem
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'intake_item_logs'"
        )
        .get() as { sql: string }
    ).sql;
    expect(schema).toContain("recorded_at TEXT NOT NULL");
    expect(schema).toContain("occurred_at TEXT");
    expect(schema).not.toContain("taken_at");
    expect(
      (
        mem
          .prepare(
            "SELECT seq FROM sqlite_sequence WHERE name = 'intake_item_logs'"
          )
          .get() as { seq: number }
      ).seq
    ).toBe(41);

    expect(() => up(mem)).not.toThrow();
    mem.pragma("foreign_keys = ON");
    expect(mem.pragma("foreign_key_check(intake_item_logs)")).toEqual([]);
    const inserted = mem
      .prepare(
        `INSERT INTO intake_item_logs
           (dose_id, item_id, date, occurred_at, status)
         VALUES (?, ?, '2026-08-14', '2026-08-14T08:00:00Z', 'taken')`
      )
      .run(doseId, itemId);
    expect(Number(inserted.lastInsertRowid)).toBe(42);
    expect(
      (
        mem
          .prepare("SELECT product FROM intake_item_logs WHERE id = 42")
          .get() as { product: string | null }
      ).product
    ).toBe("Oral suspension");
    mem.prepare("DELETE FROM intake_item_doses WHERE id = ?").run(doseId);
    expect(
      (
        mem.prepare("SELECT COUNT(*) AS n FROM intake_item_logs").get() as {
          n: number;
        }
      ).n
    ).toBe(0);
    mem.close();
  });
});
