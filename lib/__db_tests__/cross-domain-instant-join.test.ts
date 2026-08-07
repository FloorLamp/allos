// DB INTEGRATION TIER — the cross-domain join, over all five semantic patterns
// (issue #2205 phase 3).
//
// This is the query shape the issue says produced two confidently wrong answers: read
// rows from more than one domain, order or window them against each other, and report
// what happened. It was untestable until phase 1 landed, because before then the
// answer depended on which convention each table happened to be on. Now it is
// testable, so it is tested — including the half that is STILL wrong if you compare
// stored strings, which is the point.
//
// The fixture spans every pattern the issue enumerates:
//
//   1. event/record pair — food_log_events (eaten_at canonical / logged_at canonical),
//                          and intake_item_logs, whose given_at/taken_at turned out
//                          under the owner's ruling to be a RECORD CHAIN rather than
//                          an event/record pair — so the table has no event instant at
//                          all until phase 2 wave 2 adds `occurred_at`
//   2. record-only       — substance_log (logged_at canonical)
//   3. optional event    — practice_logs (a local HH:MM, and a NULL one)
//   4. window            — metric_samples (start_time / end_time)
//   5. day-only          — body_metrics (a date and nothing else)
//
// plus hr_minutes, whose instant is canonical since migration 164.
//
// Every statement is profile-scoped. `intake_item_logs` carries no `profile_id` of its
// own — it scopes through `intake_items` — which is itself a small worked example of
// why a cross-domain reader has to be careful.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  bestKnownInstant,
  eventInstant,
  instantDate,
  recordInstant,
  rowLocalDay,
} from "@/lib/row-instants";

const TZ = "America/New_York";
const DAY = "2026-03-10"; // inside US DST (it begins March 8), so local = UTC−4.

let profileId: number;
let itemId: number;
let doseId: number;

beforeAll(() => {
  profileId = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run("Cross-domain fixture").lastInsertRowid
  );
  itemId = Number(
    db
      .prepare(
        "INSERT INTO intake_items (profile_id, name, kind, obligation) VALUES (?, ?, 'medication', 'may')"
      )
      .run(profileId, "Fixture antipyretic").lastInsertRowid
  );
  doseId = Number(
    db
      .prepare("INSERT INTO intake_item_doses (item_id, amount) VALUES (?, ?)")
      .run(itemId, "1 tab").lastInsertRowid
  );

  // Pattern 1a — a PRN administration. `given_at` is on SQLite's BARE shape; the dose
  // was taken at 13:30Z, i.e. ten minutes AFTER the meal below.
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, taken_at, status)
     VALUES (?, ?, ?, ?, ?, 'taken')`
  ).run(doseId, itemId, DAY, "2026-03-10 13:30:00", "2026-03-10 18:05:00");

  // Pattern 1b — two servings. The first STATES an eating time (13:20Z); the second is
  // a web backfill that states none, so `eaten_at` is NULL and stays that way.
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, logged_at, eaten_at, time_source)
     VALUES (?, 'protein', ?, ?, ?, 'stated')`
  ).run(profileId, DAY, "2026-03-10T13:25:00Z", "2026-03-10T13:20:00Z");
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, logged_at, eaten_at, time_source)
     VALUES (?, 'vegetables', ?, ?, NULL, NULL)`
  ).run(profileId, DAY, "2026-03-10T23:50:00Z");

  // Pattern 2 — record-only.
  db.prepare(
    `INSERT INTO substance_log (profile_id, date, substance, units, logged_at)
     VALUES (?, ?, 'alcohol', 1, ?)`
  ).run(profileId, DAY, "2026-03-10T22:40:00Z");

  // Pattern 3 — one practice with a local clock, one from the quick path with none.
  db.prepare(
    "INSERT INTO practice_logs (profile_id, practice, date, time) VALUES (?, 'meditation', ?, '07:30')"
  ).run(profileId, DAY);
  // An explicit created_at, so the record-instant fallback below is a fixed value
  // rather than whatever the wall clock said when the suite ran.
  db.prepare(
    `INSERT INTO practice_logs (profile_id, practice, date, time, created_at)
     VALUES (?, 'stretching', ?, NULL, '2026-03-10 21:15:00')`
  ).run(profileId, DAY);

  // Pattern 4 — a window.
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'fixture', 'steps', ?, ?, ?, 4200)`
  ).run(profileId, DAY, "2026-03-10T12:00:00Z", "2026-03-10T13:00:00Z");

  // Pattern 5 — a day and nothing else.
  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 70.5)"
  ).run(profileId, DAY);

  // hr_minutes — 03:30Z, which is the PREVIOUS local evening in New York.
  db.prepare(
    "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, 58, 60, 'fixture')"
  ).run(profileId, "2026-03-10T03:30:00Z");
});

// The dose and the meal, joined the way a "did this med land near a meal?" question
// would join them.
function doseAndMeal() {
  const dose = db
    .prepare(
      `SELECT l.date AS date, l.given_at AS given_at, l.taken_at AS taken_at
         FROM intake_item_logs l
         JOIN intake_items ii ON ii.id = l.item_id
        WHERE ii.profile_id = ? AND l.date = ?`
    )
    .get(profileId, DAY) as Record<string, unknown>;
  const meal = db
    .prepare(
      `SELECT date, logged_at, eaten_at, time_source
         FROM food_log_events
        WHERE profile_id = ? AND date = ? AND eaten_at IS NOT NULL`
    )
    .get(profileId, DAY) as Record<string, unknown>;
  return { dose, meal };
}

describe("the comparison that produced the wrong answers", () => {
  it("is still wrong when two conventions are compared as strings", () => {
    // This is not a hypothetical. `given_at` is bare ('2026-03-10 13:30:00') and
    // `eaten_at` carries a Z ('2026-03-10T13:20:00Z'); within one day ' ' (0x20) sorts
    // before 'T' (0x54), so the LATER dose compares as EARLIER — and the query returns
    // a clean, confident, wrong row rather than an error.
    const row = db
      .prepare(
        `SELECT (l.given_at > f.eaten_at) AS dose_came_after
           FROM intake_item_logs l
           JOIN intake_items ii ON ii.id = l.item_id
           JOIN food_log_events f
             ON f.profile_id = ii.profile_id AND f.date = l.date
          WHERE ii.profile_id = ? AND l.date = ? AND f.eaten_at IS NOT NULL`
      )
      .get(profileId, DAY) as { dose_came_after: number };
    expect(row.dose_came_after).toBe(0); // the dose WAS after the meal. This says no.
  });

  it("is right when each row is asked for its instant", () => {
    const { dose, meal } = doseAndMeal();
    // Note WHICH question each side answers. The meal states when it was EATEN; the
    // dose, by the owner's #2205 ruling, has only a record instant — the confirm's tap
    // — because nothing in the schema observes when the intake happened. Before phase
    // 3 that difference was invisible inside a `COALESCE`; here it is the API.
    expect(eventInstant("intake_item_logs", dose)).toMatchObject({
      known: false,
      why: "not-declared",
    });
    const doseAt = instantDate(recordInstant("intake_item_logs", dose))!;
    const mealAt = instantDate(eventInstant("food_log_events", meal))!;
    expect(doseAt.getTime()).toBeGreaterThan(mealAt.getTime());
    expect((doseAt.getTime() - mealAt.getTime()) / 60_000).toBe(10);
  });

  it("is also right in SQL when both sides go through a date function", () => {
    // Worth pinning: SQLite parses BOTH conventions, so the fix inside a query is to
    // compare parsed values rather than stored strings. The reader exists because the
    // caller should not have to remember which of the two a column is on.
    const row = db
      .prepare(
        `SELECT (julianday(l.given_at) > julianday(f.eaten_at)) AS dose_came_after
           FROM intake_item_logs l
           JOIN intake_items ii ON ii.id = l.item_id
           JOIN food_log_events f
             ON f.profile_id = ii.profile_id AND f.date = l.date
          WHERE ii.profile_id = ? AND l.date = ? AND f.eaten_at IS NOT NULL`
      )
      .get(profileId, DAY) as { dose_came_after: number };
    expect(row.dose_came_after).toBe(1);
  });
});

describe("one ordering across all five patterns", () => {
  interface Entry {
    label: string;
    at: string;
    semantic: "event" | "record";
  }

  function timeline(): Entry[] {
    const out: Entry[] = [];
    const push = (
      label: string,
      table: Parameters<typeof bestKnownInstant>[0],
      row: Record<string, unknown>
    ) => {
      const when = bestKnownInstant(table, row, TZ);
      if (when.known) out.push({ label, at: when.at, semantic: when.semantic });
    };

    const dose = db
      .prepare(
        `SELECT l.date AS date, l.given_at AS given_at, l.taken_at AS taken_at
           FROM intake_item_logs l
           JOIN intake_items ii ON ii.id = l.item_id
          WHERE ii.profile_id = ? AND l.date = ?`
      )
      .all(profileId, DAY) as Record<string, unknown>[];
    for (const r of dose) push("dose", "intake_item_logs", r);

    const food = db
      .prepare(
        `SELECT group_key, date, logged_at, eaten_at, time_source
           FROM food_log_events WHERE profile_id = ? AND date = ? ORDER BY id`
      )
      .all(profileId, DAY) as Record<string, unknown>[];
    for (const r of food)
      push(`food:${r.group_key as string}`, "food_log_events", r);

    const drinks = db
      .prepare(
        "SELECT date, logged_at, created_at FROM substance_log WHERE profile_id = ? AND date = ?"
      )
      .all(profileId, DAY) as Record<string, unknown>[];
    for (const r of drinks) push("drink", "substance_log", r);

    const practice = db
      .prepare(
        "SELECT practice, date, time, created_at FROM practice_logs WHERE profile_id = ? AND date = ? ORDER BY id"
      )
      .all(profileId, DAY) as Record<string, unknown>[];
    for (const r of practice) {
      push(`practice:${r.practice as string}`, "practice_logs", r);
    }

    const hr = db
      .prepare("SELECT ts FROM hr_minutes WHERE profile_id = ? ORDER BY ts")
      .all(profileId) as Record<string, unknown>[];
    for (const r of hr) push("hr", "hr_minutes", r);

    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  it("orders every domain correctly once each row is normalized", () => {
    // Ordering by the CANONICAL instant is safe precisely because every entry is on one
    // convention by the time it gets here — which the stored columns are not. Sorting
    // the same rows by their stored strings interleaves the bare and the Z-bearing
    // values wrongly, which is the failure the first block above pins.
    expect(timeline().map((e) => e.label)).toEqual([
      "hr", //                  03:30Z
      "practice:meditation", // 07:30 local = 11:30Z
      "food:protein", //        stated eating time, 13:20Z
      "dose", //                13:30Z, stored bare — a RECORD instant (the tap)
      "practice:stretching", // no clock recorded → its 21:15Z tap stamp
      "drink", //               22:40Z, record-only by design
      "food:vegetables", //     no eating time stated → its 23:50Z log stamp
    ]);
  });

  it("puts the event-bearing rows in the right order", () => {
    const t = timeline();
    const events = t.filter((e) => e.semantic === "event").map((e) => e.label);
    // The dose is NOT here. Its stamp is the confirm's, and #2205's ruling made that
    // explicit rather than letting it pass for an observed intake time.
    expect(events).toEqual(["hr", "practice:meditation", "food:protein"]);
  });

  it("keeps the rows with no event instant labelled as record answers", () => {
    const t = timeline();
    const records = t
      .filter((e) => e.semantic === "record")
      .map((e) => e.label)
      .sort();
    expect(records).toEqual([
      "dose",
      "drink",
      "food:vegetables",
      "practice:stretching",
    ]);
  });
});

describe("the null-event rows do not contaminate an event-time analysis", () => {
  it("an eating-time distribution counts only the servings that stated one", () => {
    const rows = db
      .prepare(
        `SELECT group_key, date, logged_at, eaten_at, time_source
           FROM food_log_events WHERE profile_id = ? AND date = ?`
      )
      .all(profileId, DAY) as Record<string, unknown>[];

    const stated = rows
      .map((r) => eventInstant("food_log_events", r))
      .filter((r) => r.known);
    expect(stated).toHaveLength(1);

    // And the row that is excluded is excluded for a STATED reason, so a surface can
    // say "1 of 2 servings has an eating time" instead of quietly averaging tap stamps.
    const absent = rows
      .map((r) => eventInstant("food_log_events", r))
      .filter((r) => !r.known);
    expect(absent).toEqual([
      { known: false, why: "not-recorded", column: "eaten_at" },
    ]);
  });

  it("a practice rhythm sees a clock only where one was recorded", () => {
    const rows = db
      .prepare(
        "SELECT practice, date, time, created_at FROM practice_logs WHERE profile_id = ? AND date = ? ORDER BY id"
      )
      .all(profileId, DAY) as Record<string, unknown>[];
    expect(rows.map((r) => eventInstant("practice_logs", r, TZ).known)).toEqual(
      [true, false]
    );
    // The one that has a clock resolves through the profile timezone, not UTC.
    expect(eventInstant("practice_logs", rows[0], TZ)).toMatchObject({
      at: "2026-03-10T11:30:00Z",
      derived: true,
    });
  });
});

describe("day attribution across the same join", () => {
  it("uses each row's stored day where it has one", () => {
    const weighIn = db
      .prepare(
        "SELECT date FROM body_metrics WHERE profile_id = ? AND date = ?"
      )
      .get(profileId, DAY) as Record<string, unknown>;
    const sample = db
      .prepare(
        "SELECT date, start_time, end_time FROM metric_samples WHERE profile_id = ? AND date = ?"
      )
      .get(profileId, DAY) as Record<string, unknown>;
    expect(rowLocalDay("body_metrics", weighIn, TZ)).toMatchObject({
      date: DAY,
      from: "stored",
    });
    expect(rowLocalDay("metric_samples", sample, TZ)).toMatchObject({
      date: DAY,
      from: "stored",
    });
  });

  it("derives the local day for a table that stores only an instant", () => {
    // The whole reason migration 164 moved hr_minutes' attribution to read time: a
    // 03:30Z sample belongs to the PREVIOUS local day in New York, and it should still
    // belong to it after the profile moves.
    const hr = db
      .prepare("SELECT ts FROM hr_minutes WHERE profile_id = ?")
      .get(profileId) as Record<string, unknown>;
    expect(rowLocalDay("hr_minutes", hr, TZ)).toEqual({
      known: true,
      date: "2026-03-09",
      from: "derived",
      column: "ts",
    });
    expect(rowLocalDay("hr_minutes", hr, "Asia/Tokyo")).toMatchObject({
      date: "2026-03-10",
    });
  });
});
