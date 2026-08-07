// DB INTEGRATION TIER — migration 168 (#2232): illness_episodes joins the day-window
// vocabulary. `started_at`/`ended_at` become `start_date`/`end_date`, and the stored
// end converts from the EXCLUSIVE first inactive day to the INCLUSIVE last active day
// (the house convention every other stored day-window end already uses).
//
// What earns a test here:
//   1. the rename lands and the indexes are rebuilt on the new columns;
//   2. a seeded exclusive end reads back as the inclusive last active day, with the
//      episode's membership and duration preserved exactly;
//   3. a NULL end (an ongoing episode) and a NULL start (a before-log episode) pass
//      through untouched;
//   4. a malformed end value is carried over unchanged rather than guessed at;
//   5. replay safety — the migrate() wrapper is not version-gated, so a second run
//      must be a no-op (the -1 day rewrite firing twice would silently shrink every
//      closed episode);
//   6. the AUTOINCREMENT high-water mark survives the rebuild (episode ids must never
//      recycle — the recently-resolved dismissal and stale-nudge ack sets rely on it).

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/168-illness-episode-day-window";
import { db } from "@/lib/db";
import {
  createEpisodeRow,
  getEpisodeRowForDate,
  illnessDaysInWindow,
} from "@/lib/illness-episode-store";
import { assembleIllnessEpisode } from "@/lib/illness-episode";
import { episodeRowToDerived, getEpisodeRow } from "@/lib/illness-episode-store";

// The pre-168 shape, as migration 046 created it.
function legacyDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO profiles (id, name) VALUES (1, 'Windows');
    CREATE TABLE illness_episodes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      situation  TEXT NOT NULL,
      started_at TEXT,
      ended_at   TEXT,
      note       TEXT,
      outcome    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_illness_episodes_profile
      ON illness_episodes(profile_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_illness_episodes_open
      ON illness_episodes(profile_id, situation, ended_at);
  `);
  // Mirrors the runner: migrations run with foreign_keys OFF.
  mem.pragma("foreign_keys = OFF");
  return mem;
}

function seed(
  mem: Database.Database,
  startedAt: string | null,
  endedAt: string | null,
  note: string | null = null
): number {
  return Number(
    mem
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at, note)
         VALUES (1, 'Illness', ?, ?, ?)`
      )
      .run(startedAt, endedAt, note).lastInsertRowid
  );
}

function rows(mem: Database.Database) {
  return mem
    .prepare(
      `SELECT id, start_date, end_date, note FROM illness_episodes ORDER BY id`
    )
    .all() as {
    id: number;
    start_date: string | null;
    end_date: string | null;
    note: string | null;
  }[];
}

describe("migration 168 — illness_episodes start_date/end_date, inclusive end", () => {
  it("renames the columns and converts a closed episode's end to its last active day", () => {
    const mem = legacyDb();
    // Sick 2026-03-01 .. 2026-03-07 under the old convention (ended_at = 03-08, the
    // first well day). Duration: 7 days.
    seed(mem, "2026-03-01", "2026-03-08", "week-long flu");
    up(mem);

    const [row] = rows(mem);
    expect(row.start_date).toBe("2026-03-01");
    expect(row.end_date).toBe("2026-03-07");
    expect(row.note).toBe("week-long flu");
    // Membership and duration are preserved exactly: the inclusive window covers the
    // same 7 days the exclusive one did.
    const contains = mem.prepare(
      `SELECT 1 FROM illness_episodes
        WHERE (start_date IS NULL OR start_date <= ?)
          AND (end_date IS NULL OR end_date >= ?)`
    );
    const coveredDays: string[] = [];
    for (let day = 27; day <= 39; day++) {
      const d = mem
        .prepare(`SELECT date('2026-02-01', '+' || ? || ' days') AS d`)
        .get(day - 1) as { d: string };
      if (contains.get(d.d, d.d)) coveredDays.push(d.d);
    }
    expect(coveredDays).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
    ]);
    // The old columns are gone — a reader cannot silently keep the old semantics.
    const cols = (
      mem.prepare(`PRAGMA table_info(illness_episodes)`).all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toContain("start_date");
    expect(cols).toContain("end_date");
    expect(cols).not.toContain("started_at");
    expect(cols).not.toContain("ended_at");
  });

  it("leaves NULL bounds (ongoing / before-log) untouched and keeps a one-day episode one day", () => {
    const mem = legacyDb();
    seed(mem, "2026-05-01", null); // ongoing
    seed(mem, null, "2026-04-02"); // before-log, last active 04-01
    seed(mem, "2026-06-05", "2026-06-06"); // one-day episode
    up(mem);

    const all = rows(mem);
    expect(all[0]).toMatchObject({ start_date: "2026-05-01", end_date: null });
    expect(all[1]).toMatchObject({ start_date: null, end_date: "2026-04-01" });
    // A one-day episode: end_date == start_date, not an inverted window.
    expect(all[2]).toMatchObject({
      start_date: "2026-06-05",
      end_date: "2026-06-05",
    });
  });

  it("carries a malformed end value over unchanged rather than guessing", () => {
    const mem = legacyDb();
    seed(mem, "2026-01-01", "not-a-date");
    up(mem);
    expect(rows(mem)[0].end_date).toBe("not-a-date");
  });

  it("is replay-safe: a second run does not shift ends again", () => {
    const mem = legacyDb();
    seed(mem, "2026-03-01", "2026-03-08");
    up(mem);
    up(mem);
    expect(rows(mem)[0].end_date).toBe("2026-03-07");
  });

  it("rebuilds the two profile indexes on the renamed columns", () => {
    const mem = legacyDb();
    up(mem);
    const indexSql = (
      mem
        .prepare(
          `SELECT sql FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'illness_episodes' AND sql IS NOT NULL`
        )
        .all() as { sql: string }[]
    ).map((r) => r.sql);
    expect(indexSql.some((s) => s.includes("start_date"))).toBe(true);
    expect(indexSql.some((s) => s.includes("end_date"))).toBe(true);
    expect(indexSql.every((s) => !s.includes("started_at"))).toBe(true);
  });

  it("preserves the AUTOINCREMENT high-water mark across the rebuild", () => {
    const mem = legacyDb();
    seed(mem, "2026-03-01", "2026-03-08");
    const dropped = seed(mem, "2026-04-01", "2026-04-05");
    // Delete the newest episode so the surviving max id sits BELOW the sequence.
    mem.prepare(`DELETE FROM illness_episodes WHERE id = ?`).run(dropped);
    up(mem);
    const fresh = Number(
      mem
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
           VALUES (1, 'Illness', '2026-07-01', NULL)`
        )
        .run().lastInsertRowid
    );
    // The dropped id is never reused.
    expect(fresh).toBeGreaterThan(dropped);
  });
});

// The off-by-one this issue exists to prevent, asked through the live store on the
// MIGRATED schema: "was I ill on date D?" at the start day, the last active day, and
// the day after — plus the episode's duration.
describe("was-I-ill-on-D boundaries over the inclusive [start_date, end_date]", () => {
  it("covers the start day and the last active day, not the day after", () => {
    const p = Number(
      db.prepare(`INSERT INTO profiles (name) VALUES ('Boundary')`).run()
        .lastInsertRowid
    );
    // Sick 2026-03-01 .. 2026-03-07 — end_date IS the last active day.
    const id = createEpisodeRow(p, "Illness", "2026-03-01", "2026-03-07");

    expect(getEpisodeRowForDate(p, "2026-02-28")).toBeNull();
    expect(getEpisodeRowForDate(p, "2026-03-01")?.id).toBe(id);
    expect(getEpisodeRowForDate(p, "2026-03-04")?.id).toBe(id);
    expect(getEpisodeRowForDate(p, "2026-03-07")?.id).toBe(id);
    expect(getEpisodeRowForDate(p, "2026-03-08")).toBeNull();

    // Duration: the assembly counts 7 inclusive days with no compensation.
    const assembled = assembleIllnessEpisode(
      p,
      episodeRowToDerived(getEpisodeRow(p, id)!)
    );
    expect(assembled.lastActiveDay).toBe("2026-03-07");
    expect(assembled.dayCount).toBe(7);

    // The weekly-recap counter agrees at both boundaries.
    expect(illnessDaysInWindow(p, "2026-03-01", "2026-03-07")).toBe(7);
    expect(illnessDaysInWindow(p, "2026-03-07", "2026-03-08")).toBe(1);
    expect(illnessDaysInWindow(p, "2026-03-08", "2026-03-10")).toBe(0);
  });
});
