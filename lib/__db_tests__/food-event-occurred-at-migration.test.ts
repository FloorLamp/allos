// DB INTEGRATION TIER — migration 183: `food_log_events.logged_at` becomes
// `recorded_at`, `eaten_at` becomes `occurred_at`, and both are normalized onto the
// canonical stored-instant shape (#2205 phase 2, the food wave; #2370).
//
// A rename is the cheapest-looking migration and the one with the most ways to lose
// data quietly, so what earns a test here is everything the rebuild has to carry
// across, plus the two things specific to this table:
//
//   1. the rename lands and EVERY value survives it — the old `logged_at` values ARE
//      the new `recorded_at` values, and the only thing that moves is a fractional
//      second, truncated rather than reparsed;
//   2. the #2370 hazard, DEMONSTRATED rather than asserted from the outside: comparison
//      is LEXICAL, so before the migration a millisecond-bearing instant sorts BEFORE
//      the bare-second instant of the same second ('.' < 'Z') and a `>=` boundary
//      against a second-resolution literal drops it. Every query still looks right.
//      After the migration one column holds one shape and both answer correctly;
//   3. the vestigial `eaten_at` shell exists and is NULL, and the FROZEN-MIGRATION trap
//      it exists for is closed: replaying 056 / 116 / 154 / 170 over a converted
//      database neither throws nor changes the schema — 154 would otherwise ADD the
//      column straight back;
//   4. the indexes survive under their frozen NAMES, pointed at the renamed column;
//   5. the FK graph survives — the table is a CHILD of profiles and notify_messages and
//      the rebuild runs with foreign_keys OFF, so the references have to be re-declared,
//      and ON DELETE SET NULL still degrades a pruned pointer to UNATTRIBUTED;
//   6. AUTOINCREMENT high-water: event ids are external identity (the row menu's
//      delete/undo token, the correction burst's anchors), so a DROP must not let them
//      recycle;
//   7. replay safety — migrate() is not version-gated, so a second up() is a no-op;
//   8. the stored undo snapshots are rewritten, because restore builds its INSERT from
//      the captured row's OWN KEYS and the trash outlives a deploy;
//   9. `date` is untouched (#2205 constraint 4) and NOTHING is backfilled into
//      `occurred_at` — a row nobody stated a time for still answers "not recorded".

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, NUMBERED_MIGRATIONS } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/183-food-event-occurred-at";
import { eventInstant, recordInstant } from "@/lib/row-instants";

// The real schema at version `maxId`, built the way the runner builds it.
function schemaAt(maxId: number): Database.Database {
  const mem = new Database(":memory:");
  mem.pragma("foreign_keys = OFF");
  for (const m of NUMBERED_MIGRATIONS) if (m.id <= maxId) m.up(mem);
  return mem;
}

interface EventRow {
  id: number;
  profile_id: number;
  group_key: string;
  date: string;
  created_at: string;
  meal_slot: string | null;
  time_source: string | null;
  notify_message_id: number | null;
}

const OTHER_COLUMNS =
  "id, profile_id, group_key, date, created_at, meal_slot, time_source, " +
  "notify_message_id";

// The two serializations the column really holds (#2370), plus the shapes around them:
// a tap on the canonical shape, a tap in the millisecond shape the offline replay wrote,
// a stated eating time also in the millisecond shape, and a serving nobody timed.
function seed(mem: Database.Database): { messageId: number } {
  mem.prepare("INSERT INTO profiles (id, name) VALUES (1, 'Rename')").run();
  const messageId = Number(
    mem
      .prepare(
        `INSERT INTO notify_messages
           (profile_id, chat_id, message_id, kind, date, keyboard, sent_at)
         VALUES (1, 'chat9', 44, 'food', '2026-07-18', '[]', '2026-07-18T14:00:00Z')`
      )
      .run().lastInsertRowid
  );
  const ins = mem.prepare(
    `INSERT INTO food_log_events
       (profile_id, group_key, date, logged_at, created_at, meal_slot, eaten_at,
        time_source, notify_message_id)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Canonical, second resolution — the shape the column declares.
  ins.run(
    "leafy-greens",
    "2026-07-18",
    "2026-07-18T15:02:31Z",
    "2026-07-18 15:02:31",
    "Midday",
    null,
    null,
    null
  );
  // The DRIFTED shape: same second, millisecond serialization. This is the row that
  // sorts and compares wrong before the migration.
  ins.run(
    "berries",
    "2026-07-18",
    "2026-07-18T15:02:31.865Z",
    "2026-07-18 15:02:31",
    null,
    "2026-07-18T14:45:09.120Z",
    "stated",
    messageId
  );
  // A serving nobody stated a time for — the null-event case #2019 protects.
  ins.run(
    "nuts",
    "2026-07-19",
    "2026-07-19T08:00:00Z",
    "2026-07-19 08:00:00",
    "Morning",
    null,
    null,
    null
  );
  return { messageId };
}

function events(mem: Database.Database, cols: string): unknown[] {
  return mem
    .prepare(`SELECT ${cols} FROM food_log_events ORDER BY id`)
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

function column(mem: Database.Database, col: string): (string | null)[] {
  return (
    mem
      .prepare(`SELECT ${col} AS v FROM food_log_events ORDER BY id`)
      .all() as { v: string | null }[]
  ).map((r) => r.v);
}

describe("migration 183 — food_log_events instants renamed and normalized", () => {
  it("moves both columns onto their vocabulary names, truncating only the fraction", () => {
    const mem = schemaAt(182);
    seed(mem);
    const before = events(mem, OTHER_COLUMNS) as EventRow[];
    const dates = column(mem, "date");

    up(mem);

    // The tap stamps: the second each row STATED is unchanged; only the fractional
    // part is gone, and a value already canonical is byte-identical.
    expect(column(mem, "recorded_at")).toEqual([
      "2026-07-18T15:02:31Z",
      "2026-07-18T15:02:31Z",
      "2026-07-19T08:00:00Z",
    ]);
    // The eating instants, same rule — and the row nobody timed keeps its NULL. There
    // is no backfill from the tap stamp: food refuses to infer an eating time
    // (#2019/#2053), and the rename does not become the thing that invents one.
    expect(column(mem, "occurred_at")).toEqual([
      null,
      "2026-07-18T14:45:09Z",
      null,
    ]);
    // Every other column, byte-identical — including `created_at`, which stays on
    // SQLite's bare bookkeeping shape and is NOT swept into the convention.
    expect(events(mem, OTHER_COLUMNS)).toEqual(before);
    // #2205 constraint 4: no day attribution moved.
    expect(column(mem, "date")).toEqual(dates);
  });

  it("ends the mixed-serialization ordering hazard the column was carrying (#2370)", () => {
    // THE DEFECT, shown before it is fixed. Comparison is LEXICAL: '.' (0x2E) sorts
    // before 'Z' (0x5A), so the millisecond-bearing instant of a second orders AHEAD
    // of the bare-second instant of the SAME second, and a `>=` boundary against a
    // second-resolution literal excludes it. Both queries look entirely reasonable.
    const mem = schemaAt(182);
    seed(mem);

    const orderBefore = (
      mem
        .prepare(
          `SELECT group_key AS g FROM food_log_events
            WHERE date = '2026-07-18' ORDER BY logged_at, id`
        )
        .all() as { g: string }[]
    ).map((r) => r.g);
    // Wrong: berries was tapped 0.865s AFTER leafy-greens and sorts first.
    expect(orderBefore).toEqual(["berries", "leafy-greens"]);

    const atOrAfterBefore = (
      mem
        .prepare(
          `SELECT COUNT(*) AS c FROM food_log_events
            WHERE date = '2026-07-18' AND logged_at >= '2026-07-18T15:02:31Z'`
        )
        .get() as { c: number }
    ).c;
    // Wrong: both of the day's taps are at or after that second; the boundary sees
    // one, because the millisecond-bearing value sorts BELOW the literal.
    expect(atOrAfterBefore).toBe(1);

    up(mem);

    const orderAfter = (
      mem
        .prepare(
          `SELECT group_key AS g FROM food_log_events
            WHERE date = '2026-07-18' ORDER BY recorded_at, id`
        )
        .all() as { g: string }[]
    ).map((r) => r.g);
    // One shape, so a same-second pair falls back to the id tiebreak — insertion
    // order, which is tap order.
    expect(orderAfter).toEqual(["leafy-greens", "berries"]);

    const atOrAfterAfter = (
      mem
        .prepare(
          `SELECT COUNT(*) AS c FROM food_log_events
            WHERE date = '2026-07-18' AND recorded_at >= '2026-07-18T15:02:31Z'`
        )
        .get() as { c: number }
    ).c;
    expect(atOrAfterAfter).toBe(2);
  });

  it("keeps the vestigial eaten_at column, empty, so the frozen migrations still run", () => {
    // THE TRAP. migrate() (lib/db.ts) replays every migration unconditionally, and
    // migration 154 adds `eaten_at` back unless its PRAGMA guard finds it — which
    // would grow a dead column under a wrapper whose contract is that a replay changes
    // nothing.
    const mem = schemaAt(182);
    seed(mem);
    up(mem);

    const cols = (
      mem.prepare("PRAGMA table_info(food_log_events)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toContain("recorded_at");
    expect(cols).toContain("occurred_at");
    expect(cols).toContain("eaten_at");
    const stranded = (
      mem
        .prepare(
          "SELECT COUNT(*) AS c FROM food_log_events WHERE eaten_at IS NOT NULL"
        )
        .get() as { c: number }
    ).c;
    expect(stranded).toBe(0);

    const before = schemaText(mem);
    const rows = events(mem, OTHER_COLUMNS);
    for (const id of [56, 116, 154, 170]) {
      const m = MIGRATIONS.find((x) => x.id === id)!;
      expect(() => m.up(mem)).not.toThrow();
    }
    expect(schemaText(mem)).toBe(before);
    expect(events(mem, OTHER_COLUMNS)).toEqual(rows);
  });

  it("rebuilds the indexes under their frozen names, on the renamed column", () => {
    const mem = schemaAt(182);
    seed(mem);
    up(mem);

    const names = (
      mem
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'food_log_events'
              AND name NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names.sort()).toEqual([
      "idx_food_log_events_notify_message",
      "idx_food_log_events_pop",
      "idx_food_log_events_profile",
    ]);
    // The NAMES are frozen by migration 056's `CREATE INDEX IF NOT EXISTS` (renaming
    // one would build a second, dead index on a replay); the COLUMNS follow the rename,
    // which is what keeps the ranking read a seek.
    const cols = (name: string) =>
      (
        mem.prepare(`PRAGMA index_info(${name})`).all() as { name: string }[]
      ).map((c) => c.name);
    expect(cols("idx_food_log_events_profile")).toEqual([
      "profile_id",
      "recorded_at",
    ]);
    expect(cols("idx_food_log_events_pop")).toEqual([
      "profile_id",
      "date",
      "group_key",
      "recorded_at",
    ]);
  });

  it("keeps the FK graph: the links re-declare and a pruned pointer still SET NULLs", () => {
    const mem = schemaAt(182);
    const { messageId } = seed(mem);
    up(mem);

    // The rebuild runs with foreign_keys OFF, so the copied values are only as good as
    // the recreated declarations.
    mem.pragma("foreign_keys = ON");
    expect(mem.pragma("foreign_key_check(food_log_events)")).toEqual([]);

    const parents = (
      mem.pragma("foreign_key_list(food_log_events)") as { table: string }[]
    )
      .map((f) => f.table)
      .sort();
    expect(parents).toEqual(["notify_messages", "profiles"]);

    // #2264's designed degradation: a message pointer pruned inside the ledger's life
    // leaves the tap UNATTRIBUTED rather than deleting it.
    mem.prepare("DELETE FROM notify_messages WHERE id = ?").run(messageId);
    const left = (
      mem
        .prepare(
          `SELECT COUNT(*) AS c FROM food_log_events
            WHERE notify_message_id IS NOT NULL`
        )
        .get() as { c: number }
    ).c;
    expect(left).toBe(0);
    expect(
      (
        mem.prepare("SELECT COUNT(*) AS c FROM food_log_events").get() as {
          c: number;
        }
      ).c
    ).toBe(3);
  });

  it("preserves the AUTOINCREMENT high-water mark so event ids never recycle", () => {
    const mem = schemaAt(182);
    seed(mem);
    // Delete the newest tap: the copy's own max id now UNDERSTATES the high-water
    // mark, which is exactly the case a plain rebuild loses.
    const maxId = (
      mem.prepare("SELECT MAX(id) AS m FROM food_log_events").get() as {
        m: number;
      }
    ).m;
    mem.prepare("DELETE FROM food_log_events WHERE id = ?").run(maxId);

    up(mem);

    const seq = (
      mem
        .prepare(
          "SELECT seq AS s FROM sqlite_sequence WHERE name = 'food_log_events'"
        )
        .get() as { s: number }
    ).s;
    expect(seq).toBe(maxId);
  });

  it("rewrites the stored undo snapshots, which restore reads by key", () => {
    // `deleted_rows.payload` holds `SELECT *` copies and restore builds its INSERT from
    // the captured row's own keys, so a serving deleted before the migration and undone
    // after it would name a column that no longer exists. The default trash window is
    // 30 days — entirely live across a deploy.
    const mem = schemaAt(182);
    seed(mem);
    const payload = JSON.stringify({
      v: 1,
      kind: "food-serving",
      rows: {
        event: [
          {
            id: 7,
            profile_id: 1,
            group_key: "berries",
            date: "2026-07-18",
            logged_at: "2026-07-18T15:02:31.865Z",
            eaten_at: "2026-07-18T14:45:09.120Z",
            time_source: "stated",
          },
        ],
        counter: [{ id: 3, date: "2026-07-18", group_key: "berries" }],
      },
    });
    mem
      .prepare(
        `INSERT INTO deleted_rows (profile_id, kind, label, payload)
         VALUES (1, 'food-serving', 'food serving', ?)`
      )
      .run(payload);

    up(mem);

    const stored = JSON.parse(
      (
        mem.prepare("SELECT payload AS p FROM deleted_rows").get() as {
          p: string;
        }
      ).p
    ) as { rows: { event: Record<string, unknown>[] } };
    const row = stored.rows.event[0];
    expect(Object.keys(row)).not.toContain("logged_at");
    expect(Object.keys(row)).not.toContain("eaten_at");
    // The keys moved AND the values were normalized with them, so a restored row lands
    // on the same convention as a live one.
    expect(row.recorded_at).toBe("2026-07-18T15:02:31Z");
    expect(row.occurred_at).toBe("2026-07-18T14:45:09Z");
    // The sibling counter snapshot is a `food_log` row and is left exactly alone.
    expect(stored.rows).toHaveProperty("counter");
  });

  it("is replay-safe: a second up() changes neither schema nor rows", () => {
    const mem = schemaAt(182);
    seed(mem);
    up(mem);
    const schema = schemaText(mem);
    const rows = events(
      mem,
      `${OTHER_COLUMNS}, recorded_at, occurred_at, eaten_at`
    );

    expect(() => up(mem)).not.toThrow();
    expect(schemaText(mem)).toBe(schema);
    expect(
      events(mem, `${OTHER_COLUMNS}, recorded_at, occurred_at, eaten_at`)
    ).toEqual(rows);
  });

  it("answers the event and record questions through the renamed columns", () => {
    const mem = schemaAt(182);
    seed(mem);
    up(mem);

    const rows = mem
      .prepare(
        `SELECT date, recorded_at, occurred_at, time_source
           FROM food_log_events ORDER BY id`
      )
      .all() as Record<string, unknown>[];

    // A stated eating time is the EVENT instant, read off the renamed column.
    expect(eventInstant("food_log_events", rows[1])).toMatchObject({
      known: true,
      column: "occurred_at",
      at: "2026-07-18T14:45:09Z",
    });
    // A serving nobody timed has NO event instant — the tap stamp is not handed back
    // in its place, which is the whole reason the column stays nullable.
    expect(eventInstant("food_log_events", rows[0])).toEqual({
      known: false,
      why: "not-recorded",
      column: "occurred_at",
    });
    expect(recordInstant("food_log_events", rows[0])).toMatchObject({
      known: true,
      column: "recorded_at",
      at: "2026-07-18T15:02:31Z",
    });
  });
});
