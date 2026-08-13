// DB INTEGRATION TIER — migration 173 (#2205 phase 2 wave 2): `intake_item_logs
// .given_at` becomes `recorded_at`.
//
// A rename is the cheapest-looking migration and the one with the most ways to lose
// data quietly, so what earns a test here is everything the rebuild has to carry
// across, plus the two traps this table sets:
//
//   1. the rename lands, and EVERY column's value survives it byte-for-byte — the old
//      `given_at` values are the new `recorded_at` values, and nothing else moved;
//   2. the vestigial `given_at` shell exists and is NULL, and the FROZEN-MIGRATION
//      PREPARE TRAP it exists for is actually closed: replaying 041 (which guards its
//      whole rebuild on that column) and 156 (which indexes it) over a converted
//      database neither throws nor changes the schema;
//   3. the indexes and the two product-snapshot triggers survive the rebuild, and the
//      arming-administration composite still points at the live column;
//   4. the FK graph survives — the table is a CHILD of three tables and the rebuild
//      runs with foreign_keys OFF, so the recreated references have to be re-declared,
//      and ON DELETE CASCADE from a dose still reaches its logs;
//   5. AUTOINCREMENT high-water: log ids are external identity (Telegram dose
//      callbacks, correction-burst anchors, the undo registry's captured row), so a
//      DROP must not let them recycle;
//   6. replay safety — migrate() is not version-gated, so a second up() is a no-op;
//   7. the SAFETY-CRITICAL pin: a pre-173 administration still arms the PRN redose
//      window and the phantom-dose proximity guard after the rename, because those key
//      on the renamed column and read the same instants they always did.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, NUMBERED_MIGRATIONS } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/173-intake-log-recorded-at";
import { recordInstant } from "@/lib/row-instants";

// The real schema at version `maxId`, built the way the runner builds it.
function schemaAt(maxId: number): Database.Database {
  const mem = new Database(":memory:");
  mem.pragma("foreign_keys = OFF");
  for (const m of NUMBERED_MIGRATIONS) if (m.id <= maxId) m.up(mem);
  return mem;
}

interface LogRow {
  id: number;
  dose_id: number;
  item_id: number | null;
  date: string;
  taken_at: string;
  amount: string | null;
  status: string;
  skip_reason: string | null;
  product: string | null;
  supply_adjusted: number;
  occurred_at: string | null;
  notify_message_id: number | null;
}

// One profile + item + dose, and a spread of administrations covering every shape the
// column takes: a PRN row with a stated intake time, a scheduled confirm, a SKIP (which
// writes no given_at at all — the row that falls through to taken_at), and a row that
// also carries the wave-1 `occurred_at` event instant.
function seed(mem: Database.Database): { doseId: number; itemId: number } {
  mem.prepare("INSERT INTO profiles (id, name) VALUES (1, 'Rename')").run();
  const itemId = Number(
    mem
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, product, active, kind, condition, obligation)
         VALUES (1, 'Ibuprofen', 'Oral suspension', 1, 'medication', 'daily', 'may')`
      )
      .run().lastInsertRowid
  );
  const doseId = Number(
    mem
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', 'anytime', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  const ins = mem.prepare(
    `INSERT INTO intake_item_logs
       (dose_id, item_id, date, taken_at, given_at, amount, status, skip_reason,
        product, supply_adjusted, occurred_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  ins.run(
    doseId,
    itemId,
    "2026-07-15",
    "2026-07-15 16:02:07",
    "2026-07-15 16:02:00",
    "200 mg",
    "taken",
    null,
    "Oral suspension",
    1,
    null
  );
  ins.run(
    doseId,
    itemId,
    "2026-07-15",
    "2026-07-15 22:10:41",
    "2026-07-15 22:10:41",
    "200 mg",
    "taken",
    null,
    "Oral suspension",
    0,
    "2026-07-15T21:30:00Z"
  );
  // A SKIP: no given_at, so the record chain falls through to taken_at.
  ins.run(
    doseId,
    itemId,
    "2026-07-16",
    "2026-07-16 09:00:00",
    null,
    null,
    "skipped",
    "felt fine",
    null,
    1,
    null
  );
  return { doseId, itemId };
}

function logs(mem: Database.Database, cols: string): unknown[] {
  return mem
    .prepare(`SELECT ${cols} FROM intake_item_logs ORDER BY id`)
    .all() as unknown[];
}

function schemaText(mem: Database.Database): string {
  return (
    mem
      .prepare(
        `SELECT group_concat(sql, ';') AS s FROM sqlite_master
          WHERE sql IS NOT NULL ORDER BY name`
      )
      .get() as { s: string }
  ).s;
}

const OTHER_COLUMNS =
  "id, dose_id, item_id, date, taken_at, amount, status, skip_reason, " +
  "product, supply_adjusted, occurred_at, notify_message_id";

describe("migration 173 — intake_item_logs.given_at → recorded_at", () => {
  it("moves every given_at value onto recorded_at and leaves the rest untouched", () => {
    const mem = schemaAt(172);
    seed(mem);
    const before = logs(mem, OTHER_COLUMNS) as LogRow[];
    const givenBefore = (
      mem
        .prepare("SELECT given_at AS v FROM intake_item_logs ORDER BY id")
        .all() as { v: string | null }[]
    ).map((r) => r.v);

    up(mem);

    // The old values, under the new name — not "equivalent", identical strings.
    const recordedAfter = (
      mem
        .prepare("SELECT recorded_at AS v FROM intake_item_logs ORDER BY id")
        .all() as { v: string | null }[]
    ).map((r) => r.v);
    expect(recordedAfter).toEqual(givenBefore);
    expect(recordedAfter).toEqual([
      "2026-07-15 16:02:00",
      "2026-07-15 22:10:41",
      null,
    ]);
    // Every other column, byte-identical. A rename may not launder a status, a
    // supply_adjusted flag, or the wave-1 event instant beside it.
    expect(logs(mem, OTHER_COLUMNS)).toEqual(before);
  });

  it("keeps the vestigial given_at column, empty, so the frozen migrations still run", () => {
    const mem = schemaAt(172);
    seed(mem);
    up(mem);

    const cols = (
      mem.prepare("PRAGMA table_info(intake_item_logs)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toContain("recorded_at");
    expect(cols).toContain("given_at");
    const stranded = (
      mem
        .prepare(
          "SELECT COUNT(*) AS c FROM intake_item_logs WHERE given_at IS NOT NULL"
        )
        .get() as { c: number }
    ).c;
    expect(stranded).toBe(0);
  });

  it("closes the frozen-migration PREPARE trap: replaying 041 and 156 is a clean no-op", () => {
    // THE TRAP. migrate() (lib/db.ts) replays every migration unconditionally, and
    // SQLite validates column names at PREPARE time — before it looks at a row. 041
    // guards its whole administration-ledger rebuild on `given_at` being present, so
    // without the vestigial shell a replay would decide the table still needs
    // rebuilding and then throw on an INSERT…SELECT naming columns that are gone; 156
    // would fail to prepare its index outright.
    const mem = schemaAt(172);
    seed(mem);
    up(mem);
    const before = schemaText(mem);
    const rowsBefore = logs(mem, OTHER_COLUMNS);

    const m041 = MIGRATIONS.find((m) => m.id === 41)!;
    const m156 = MIGRATIONS.find((m) => m.id === 156)!;
    expect(() => m041.up(mem)).not.toThrow();
    expect(() => m156.up(mem)).not.toThrow();

    // And they changed NOTHING: no second dead index, no rebuilt table.
    expect(schemaText(mem)).toBe(before);
    expect(logs(mem, OTHER_COLUMNS)).toEqual(rowsBefore);
  });

  it("rebuilds the indexes, with the arming composite on the live column", () => {
    const mem = schemaAt(172);
    seed(mem);
    up(mem);

    const names = (
      mem
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'intake_item_logs'
              AND name NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names.sort()).toEqual([
      "idx_intake_item_logs_notify_message",
      "idx_intake_log_date",
      "idx_intake_log_dose_date",
      "idx_intake_log_item_given",
    ]);
    // The index NAME is frozen by frozen migration 156's `CREATE INDEX IF NOT EXISTS`
    // (renaming it would build a second, dead index on a replay); its COLUMNS follow
    // the rename, which is what keeps the arming-administration read a seek.
    const composite = (
      mem.prepare("PRAGMA index_info(idx_intake_log_item_given)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(composite).toEqual(["item_id", "recorded_at"]);
  });

  it("re-creates the product-snapshot triggers, and they still fire", () => {
    const mem = schemaAt(172);
    const { doseId, itemId } = seed(mem);
    up(mem);

    const triggers = (
      mem
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND tbl_name = 'intake_item_logs'`
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(triggers.sort()).toEqual([
      "intake_log_snapshot_product_insert",
      "intake_log_snapshot_product_taken",
    ]);

    // The insert trigger snapshots the item's current formulation onto a row that
    // states none — the #79 behaviour, unchanged by the rebuild.
    const id = Number(
      mem
        .prepare(
          `INSERT INTO intake_item_logs (dose_id, item_id, date, recorded_at)
           VALUES (?,?,?,?)`
        )
        .run(doseId, itemId, "2026-07-17", "2026-07-17 08:00:00")
        .lastInsertRowid
    );
    const product = (
      mem
        .prepare("SELECT product AS p FROM intake_item_logs WHERE id = ?")
        .get(id) as { p: string | null }
    ).p;
    expect(product).toBe("Oral suspension");
  });

  it("keeps the FK graph: the links re-declare and a dose delete still cascades", () => {
    const mem = schemaAt(172);
    const { doseId } = seed(mem);
    up(mem);

    // The rebuild runs with foreign_keys OFF, so the copied values are only as good as
    // the recreated declarations. Nothing dangles.
    mem.pragma("foreign_keys = ON");
    expect(mem.pragma("foreign_key_check(intake_item_logs)")).toEqual([]);

    const parents = (
      mem.pragma("foreign_key_list(intake_item_logs)") as { table: string }[]
    )
      .map((f) => f.table)
      .sort();
    expect(parents).toEqual([
      "intake_item_doses",
      "intake_items",
      "notify_messages",
    ]);

    mem.prepare("DELETE FROM intake_item_doses WHERE id = ?").run(doseId);
    const left = (
      mem.prepare("SELECT COUNT(*) AS c FROM intake_item_logs").get() as {
        c: number;
      }
    ).c;
    expect(left).toBe(0);
  });

  it("preserves the AUTOINCREMENT high-water mark so log ids never recycle", () => {
    const mem = schemaAt(172);
    seed(mem);
    // Delete the newest administration: the copy's own max id now UNDERSTATES the
    // high-water mark, which is exactly the case a plain rebuild loses.
    const maxId = (
      mem.prepare("SELECT MAX(id) AS m FROM intake_item_logs").get() as {
        m: number;
      }
    ).m;
    mem.prepare("DELETE FROM intake_item_logs WHERE id = ?").run(maxId);

    up(mem);

    const seq = (
      mem
        .prepare(
          "SELECT seq AS s FROM sqlite_sequence WHERE name = 'intake_item_logs'"
        )
        .get() as { s: number }
    ).s;
    expect(seq).toBe(maxId);
  });

  it("is replay-safe: a second up() changes neither schema nor rows", () => {
    const mem = schemaAt(172);
    seed(mem);
    up(mem);
    const schema = schemaText(mem);
    const rows = logs(mem, `${OTHER_COLUMNS}, recorded_at, given_at`);

    expect(() => up(mem)).not.toThrow();
    expect(schemaText(mem)).toBe(schema);
    expect(logs(mem, `${OTHER_COLUMNS}, recorded_at, given_at`)).toEqual(rows);
  });

  it("still answers the record question through the chain, in order", () => {
    const mem = schemaAt(172);
    seed(mem);
    up(mem);

    const rows = mem
      .prepare(
        `SELECT recorded_at, taken_at, occurred_at, date
           FROM intake_item_logs ORDER BY id`
      )
      .all() as Record<string, unknown>[];

    // Link 1: the row that recorded a tap answers from `recorded_at`.
    const first = recordInstant("intake_item_logs", rows[0]);
    expect(first).toMatchObject({
      known: true,
      column: "recorded_at",
      at: "2026-07-15T16:02:00Z",
    });
    // Link 2: the SKIP wrote no `recorded_at`, so the chain falls through to the
    // insert stamp — a fallback WITHIN the record question, not a substitution.
    const skip = recordInstant("intake_item_logs", rows[2]);
    expect(skip).toMatchObject({
      known: true,
      column: "taken_at",
      at: "2026-07-16T09:00:00Z",
    });
  });

  it("SAFETY PIN: a migrated administration still arms the redose and phantom guards", () => {
    // Both guards key on the renamed column — the PRN redose window takes the latest
    // non-null `recorded_at` for the family, and the phantom-dose guard tests whether a
    // new administration lands within ADMIN_DEDUP_WINDOW_SEC of an existing one. A row
    // written before the rename must be just as visible to them afterwards, which is
    // the whole of #2228's constraint 3.
    const mem = schemaAt(172);
    const { doseId } = seed(mem);
    up(mem);

    const arming = mem
      .prepare(
        `SELECT id, recorded_at FROM intake_item_logs
          WHERE dose_id = ? AND status = 'taken' AND recorded_at IS NOT NULL
          ORDER BY recorded_at DESC, id DESC LIMIT 1`
      )
      .get(doseId) as { id: number; recorded_at: string };
    expect(arming.recorded_at).toBe("2026-07-15 22:10:41");

    const near = mem
      .prepare(
        `SELECT id FROM intake_item_logs
          WHERE dose_id = ? AND status = 'taken' AND recorded_at IS NOT NULL
            AND ABS(strftime('%s', recorded_at) - strftime('%s', ?)) <= ?
          LIMIT 1`
      )
      .get(doseId, "2026-07-15 22:11:30", 120) as { id: number } | undefined;
    expect(near?.id).toBe(arming.id);

    // …and a genuinely different intake time is still NOT a duplicate.
    const far = mem
      .prepare(
        `SELECT id FROM intake_item_logs
          WHERE dose_id = ? AND status = 'taken' AND recorded_at IS NOT NULL
            AND ABS(strftime('%s', recorded_at) - strftime('%s', ?)) <= ?
          LIMIT 1`
      )
      .get(doseId, "2026-07-15 23:30:00", 120) as { id: number } | undefined;
    expect(far).toBeUndefined();
  });
});
