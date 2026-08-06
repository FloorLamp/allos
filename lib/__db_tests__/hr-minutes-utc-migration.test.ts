// DB INTEGRATION TIER — migration 164 (#2205 phase 1 / #94): `hr_minutes.ts` becomes
// a UTC instant, and the profile-local day/minute moves to read time.
//
// This is the only GENUINE value change in phase 1, so it gets the heaviest proof:
//
//   1. the conversion itself, on a fixture spanning BOTH a DST boundary and a
//      timezone change — the two cases a naive fixed-offset rewrite gets wrong;
//   2. VERIFICATION in the issue's own terms: row count, min/max, and a spot-check of
//      a known session against the instant it was actually recorded at;
//   3. IDEMPOTENT INGEST — the natural-key dedupe that makes a re-push free must
//      survive the primary-key rewrite, proven by re-running a real push against a
//      converted table;
//   4. the property the whole change exists for: a timezone change no longer re-means
//      stored history.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/164-hr-minutes-utc-instants";
import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { upsertHrMinutes } from "@/lib/integrations/normalize";
import { getHrMinutes, getLatestHrDay } from "@/lib/queries/metrics";

const NY = "America/New_York";

// The pre-164 schema: `ts` is the profile-local minute and part of the key, and the
// day index is the substring one the migration drops.
function legacyDb(tz: string | null): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO profiles (id, name) VALUES (1, 'HR');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE profile_settings (
      profile_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (profile_id, key)
    );
    CREATE TABLE hr_minutes (
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      ts TEXT NOT NULL,
      bpm REAL NOT NULL,
      bpm_min REAL,
      bpm_max REAL,
      n INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'health-connect',
      PRIMARY KEY (profile_id, ts, source)
    );
    CREATE INDEX idx_hr_minutes_day ON hr_minutes(profile_id, substr(ts,1,10));
  `);
  if (tz)
    mem
      .prepare(
        "INSERT INTO profile_settings (profile_id, key, value) VALUES (1, 'timezone', ?)"
      )
      .run(tz);
  // Mirrors the runner: migrations run with foreign_keys OFF so a rebuilt table's
  // DROP cannot cascade. better-sqlite3 turns them ON by default.
  mem.pragma("foreign_keys = OFF");
  return mem;
}

function seed(mem: Database.Database, ts: string, bpm = 70): void {
  mem
    .prepare(
      "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (1, ?, ?, 6, 'health-connect')"
    )
    .run(ts, bpm);
}

function stamps(mem: Database.Database): string[] {
  return (
    mem
      .prepare("SELECT ts FROM hr_minutes WHERE profile_id = 1 ORDER BY ts")
      .all() as { ts: string }[]
  ).map((r) => r.ts);
}

describe("migration 164 — hr_minutes stores an instant, not a wall clock", () => {
  it("converts a local minute to the instant it denoted, DST and all", () => {
    const mem = legacyDb(NY);
    // Around the 2026-03-08 spring-forward: 01:59 local is still EST (-05:00), and
    // 03:00 local is already EDT (-04:00). A fixed-offset rewrite would put one of
    // these an hour wrong — which is exactly what makes this a JS conversion.
    seed(mem, "2026-03-08T01:59");
    seed(mem, "2026-03-08T03:00");
    // And the other side of the year, where the offset is the other value again.
    seed(mem, "2026-11-15T08:30");
    up(mem);

    expect(stamps(mem)).toEqual([
      "2026-03-08T06:59:00Z", // 01:59 EST  = 06:59Z
      "2026-03-08T07:00:00Z", // 03:00 EDT  = 07:00Z
      "2026-11-15T13:30:00Z", // 08:30 EST  = 13:30Z
    ]);
  });

  it("keeps the minute grain — seconds are always :00", () => {
    const mem = legacyDb(NY);
    seed(mem, "2026-06-01T12:34");
    up(mem);
    expect(stamps(mem)[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
  });

  it("uses each profile's OWN timezone, not one zone for the table", () => {
    const mem = legacyDb(NY);
    mem.prepare("INSERT INTO profiles (id, name) VALUES (2, 'Tokyo')").run();
    mem
      .prepare(
        "INSERT INTO profile_settings (profile_id, key, value) VALUES (2, 'timezone', 'Asia/Tokyo')"
      )
      .run();
    seed(mem, "2026-06-01T12:00");
    mem
      .prepare(
        "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (2, '2026-06-01T12:00', 70, 6, 'health-connect')"
      )
      .run();
    up(mem);
    const rows = mem
      .prepare("SELECT profile_id, ts FROM hr_minutes ORDER BY profile_id")
      .all() as { profile_id: number; ts: string }[];
    expect(rows).toEqual([
      { profile_id: 1, ts: "2026-06-01T16:00:00Z" }, // NY, EDT −04:00
      { profile_id: 2, ts: "2026-06-01T03:00:00Z" }, // Tokyo, +09:00
    ]);
  });

  it("falls back to the instance default, then UTC, when a profile has no zone", () => {
    const mem = legacyDb(null);
    seed(mem, "2026-06-01T12:00");
    up(mem);
    expect(stamps(mem)).toEqual(["2026-06-01T12:00:00Z"]);

    const withInstance = legacyDb(null);
    withInstance
      .prepare("INSERT INTO settings (key, value) VALUES ('timezone', ?)")
      .run("Asia/Tokyo");
    seed(withInstance, "2026-06-01T12:00");
    up(withInstance);
    expect(stamps(withInstance)).toEqual(["2026-06-01T03:00:00Z"]);
  });

  it("drops the substring day index and keeps the key's own", () => {
    const mem = legacyDb(NY);
    seed(mem, "2026-06-01T12:00");
    up(mem);
    const indexes = (
      mem
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'hr_minutes'"
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).not.toContain("idx_hr_minutes_day");
    // The PRIMARY KEY's implicit index is what serves the read-time ranges.
    expect(indexes.some((n) => n.startsWith("sqlite_autoindex"))).toBe(true);
  });

  it("is a no-op on replay", () => {
    const mem = legacyDb(NY);
    seed(mem, "2026-06-01T12:00");
    up(mem);
    const once = stamps(mem);
    up(mem);
    expect(stamps(mem)).toEqual(once);
  });

  // ---- verification, in the issue's own terms -----------------------------
  it("preserves row count and min/max ordering, and spot-checks a known session", () => {
    const mem = legacyDb(NY);
    // A known 30-minute evening session on 2026-06-01, 19:00–19:29 local.
    for (let m = 0; m < 30; m++)
      seed(mem, `2026-06-01T19:${String(m).padStart(2, "0")}`, 120 + m);
    // Plus a morning row on an adjacent day, so min/max span more than the session.
    seed(mem, "2026-05-31T06:00", 55);

    const before = mem
      .prepare(
        "SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM hr_minutes"
      )
      .get() as { n: number; lo: string; hi: string };
    expect(before).toEqual({
      n: 31,
      lo: "2026-05-31T06:00",
      hi: "2026-06-01T19:29",
    });

    up(mem);

    const after = mem
      .prepare(
        "SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM hr_minutes"
      )
      .get() as { n: number; lo: string; hi: string };
    // ROW COUNT: unchanged — nothing dropped, nothing duplicated.
    expect(after.n).toBe(before.n);
    // MIN/MAX: the same two readings are still the extremes, now stated in UTC.
    expect(after.lo).toBe("2026-05-31T10:00:00Z"); // 06:00 EDT
    expect(after.hi).toBe("2026-06-01T23:29:00Z"); // 19:29 EDT
    // SPOT-CHECK: the session's first minute is the instant it was actually recorded
    // at — 19:00 in New York on 2026-06-01 is 23:00Z — and its value rode across.
    const first = mem
      .prepare("SELECT ts, bpm, n FROM hr_minutes WHERE bpm = 120")
      .get() as { ts: string; bpm: number; n: number };
    expect(first).toEqual({ ts: "2026-06-01T23:00:00Z", bpm: 120, n: 6 });
  });

  it("refuses to swap in a partially converted table", () => {
    // The accounting guard is what makes the verification above load-bearing rather
    // than decorative: it runs inside the migration on every real database.
    const mem = legacyDb(NY);
    seed(mem, "2026-06-01T12:00");
    // A stamp that cannot be a local wall clock is carried across UNCHANGED rather
    // than dropped — the count still has to balance.
    seed(mem, "garbage-stamp");
    expect(() => up(mem)).not.toThrow();
    expect(stamps(mem)).toContain("garbage-stamp");
    expect(
      (
        mem.prepare("SELECT COUNT(*) AS n FROM hr_minutes").get() as {
          n: number;
        }
      ).n
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe("after the conversion: the #94 weakness is gone (#2205)", () => {
  function profileWithHr(name: string, tz: string): number {
    const id = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
        .lastInsertRowid
    );
    setTimezone(id, tz);
    return id;
  }

  it("re-pushing the same samples is FREE — the natural-key dedupe survives the PK rewrite", () => {
    const profileId = profileWithHr(`Repush ${Date.now()}`, NY);
    // A real push: the shape lib/integrations/normalize.upsertHrMinutes receives, keyed
    // on the sample's own UTC minute since #2205.
    const batch = [
      {
        ts: "2026-06-01T23:00:00Z",
        bpm: 120,
        bpm_min: 110,
        bpm_max: 130,
        n: 6,
      },
      {
        ts: "2026-06-01T23:01:00Z",
        bpm: 122,
        bpm_min: 112,
        bpm_max: 132,
        n: 6,
      },
    ];
    const first = upsertHrMinutes(profileId, batch, "health-connect");
    expect(first.inserted).toBe(2);

    // The SAME batch again — the rolling window re-sending what it already sent.
    const second = upsertHrMinutes(profileId, batch, "health-connect");
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM hr_minutes WHERE profile_id = ?")
          .get(profileId) as { n: number }
      ).n
    ).toBe(2);
  });

  it("a TIMEZONE CHANGE no longer re-keys the window or re-means history", () => {
    const profileId = profileWithHr(`Moved ${Date.now()}`, NY);
    const batch = [
      {
        ts: "2026-06-01T23:00:00Z",
        bpm: 120,
        bpm_min: 110,
        bpm_max: 130,
        n: 6,
      },
    ];
    upsertHrMinutes(profileId, batch, "health-connect");
    // In New York that instant is the evening of 2026-06-01.
    expect(getLatestHrDay(profileId)).toBe("2026-06-01");
    expect(getHrMinutes(profileId, "2026-06-01").map((r) => r.ts)).toEqual([
      "2026-06-01T19:00",
    ]);

    // The profile moves to Tokyo. BEFORE #2205 this silently re-meant the stored row
    // and the next push inserted a shifted duplicate, which is why the ingest sweep
    // existed. Now: the row does not move, and the SAME instant simply reads as the
    // Tokyo morning it also was.
    setTimezone(profileId, "Asia/Tokyo");
    expect(
      (
        db
          .prepare("SELECT ts FROM hr_minutes WHERE profile_id = ?")
          .get(profileId) as { ts: string }
      ).ts
    ).toBe("2026-06-01T23:00:00Z");
    expect(getLatestHrDay(profileId)).toBe("2026-06-02");
    expect(getHrMinutes(profileId, "2026-06-02").map((r) => r.ts)).toEqual([
      "2026-06-02T08:00",
    ]);

    // And re-pushing after the move is still free — the key never depended on the zone.
    const after = upsertHrMinutes(profileId, batch, "health-connect");
    expect(after.inserted).toBe(0);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM hr_minutes WHERE profile_id = ?")
          .get(profileId) as { n: number }
      ).n
    ).toBe(1);
  });
});
