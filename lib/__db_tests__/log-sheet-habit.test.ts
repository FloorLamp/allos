// DB INTEGRATION TIER (issue #2709): the "most-logged domain" gather.
//
// The decision over these counts is pure and covered in
// lib/__tests__/log-sheet.test.ts. What needs a database is everything the gather
// itself claims: that it counts DAYS rather than rows, that it stops at the window
// edge, that a synced row is not a log, that the Body and Care segments are fed by
// every store their entries write to, and that one profile's logging never lands
// in another's count.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import {
  LOG_HABIT_WINDOW_DAYS,
  openingLogSegment,
  logSheetSegments,
} from "@/lib/log-sheet";
import { getSegmentLogDays } from "@/lib/queries/log-sheet";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  return { profileId, anchor: today(profileId) };
}

function logFood(profileId: number, date: string, group = "fruit"): void {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key)
       DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
}

function logActivity(
  profileId: number,
  date: string,
  source: string | null = null
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, source)
     VALUES (?, ?, 'cardio', 'Walk', ?)`
  ).run(profileId, date, source);
}

describe("getSegmentLogDays", () => {
  it("counts DAYS, not rows — a burst is one day's evidence", () => {
    const { profileId, anchor } = makeProfile("Habit Days");
    // Six food entries on one day, one on each of two others.
    for (const group of ["fruit", "leafy_greens", "nuts_seeds", "legumes"]) {
      logFood(profileId, anchor, group);
    }
    logFood(profileId, shiftDateStr(anchor, -1));
    logFood(profileId, shiftDateStr(anchor, -2));
    expect(getSegmentLogDays(profileId, anchor).food).toBe(3);
  });

  it("stops at the window edge", () => {
    const { profileId, anchor } = makeProfile("Habit Window");
    // The oldest day still inside the window, and the first day outside it.
    logFood(profileId, shiftDateStr(anchor, -(LOG_HABIT_WINDOW_DAYS - 1)));
    logFood(profileId, shiftDateStr(anchor, -LOG_HABIT_WINDOW_DAYS));
    expect(getSegmentLogDays(profileId, anchor).food).toBe(1);
  });

  it("does not count a synced row as a log", () => {
    const { profileId, anchor } = makeProfile("Habit Sync");
    logActivity(profileId, anchor, "strava");
    logActivity(profileId, shiftDateStr(anchor, -1), "health-connect");
    expect(getSegmentLogDays(profileId, anchor).train ?? 0).toBe(0);
    logActivity(profileId, shiftDateStr(anchor, -2));
    expect(getSegmentLogDays(profileId, anchor).train).toBe(1);
  });

  it("feeds Body from every store its entries write to, deduped per day", () => {
    const { profileId, anchor } = makeProfile("Habit Body");
    // A weigh-in, a manual growth/waist sample, a hand-typed vitals sitting and a
    // period start — four stores, one segment.
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 70)"
    ).run(profileId, anchor);
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'waist_circumference_cm', ?, ?, ?, 80)`
    ).run(profileId, anchor, `${anchor}T00:00:00`, `${anchor}T00:00:00`);
    db.prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, value)
       VALUES (?, ?, 'vitals', 'Blood pressure', '118/74')`
    ).run(profileId, shiftDateStr(anchor, -1));
    db.prepare(
      "INSERT INTO cycles (profile_id, period_start) VALUES (?, ?)"
    ).run(profileId, shiftDateStr(anchor, -2));
    // Three distinct days, not four rows.
    expect(getSegmentLogDays(profileId, anchor).body).toBe(3);
  });

  it("leaves an imported clinical result out of the Body count", () => {
    const { profileId, anchor } = makeProfile("Habit Import");
    const documentId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents (profile_id, filename, stored_path)
           VALUES (?, 'visit.pdf', 'x/visit.pdf')`
        )
        .run(profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, value, document_id)
       VALUES (?, ?, 'vitals', 'Blood pressure', '120/80', ?)`
    ).run(profileId, anchor, documentId);
    db.prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, value)
       VALUES (?, ?, 'lab', 'ALT', '20')`
    ).run(profileId, anchor);
    expect(getSegmentLogDays(profileId, anchor).body ?? 0).toBe(0);
  });

  it("feeds Care from doses and practices, and never from the check-in store", () => {
    const { profileId, anchor } = makeProfile("Habit Care");
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind) VALUES (?, 'Vitamin D', 'supplement')`
        )
        .run(profileId).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day) VALUES (?, '1', 'morning')`
        )
        .run(itemId).lastInsertRowid
    );
    db.prepare(
      "INSERT INTO intake_item_logs (dose_id, item_id, date) VALUES (?, ?, ?)"
    ).run(doseId, itemId, anchor);
    db.prepare(
      "INSERT INTO practice_logs (profile_id, practice, date) VALUES (?, 'sauna', ?)"
    ).run(profileId, shiftDateStr(anchor, -1));
    expect(getSegmentLogDays(profileId, anchor).care).toBe(2);
    // A check-in on a third day adds nothing: the #992 contract keeps its store
    // out of every engine, and this measure is an engine.
    db.prepare(
      "INSERT INTO mood_logs (profile_id, date, valence) VALUES (?, ?, 3)"
    ).run(profileId, shiftDateStr(anchor, -2));
    expect(getSegmentLogDays(profileId, anchor).care).toBe(2);
  });

  it("counts one profile's logging only", () => {
    const mine = makeProfile("Habit Mine");
    const theirs = makeProfile("Habit Theirs");
    for (let d = 0; d < 10; d++) {
      logFood(theirs.profileId, shiftDateStr(theirs.anchor, -d));
    }
    expect(getSegmentLogDays(mine.profileId, mine.anchor)).toEqual({});
    expect(getSegmentLogDays(theirs.profileId, theirs.anchor).food).toBe(10);
  });

  it("hands the dashboard a segment the profile actually logs in", () => {
    const { profileId, anchor } = makeProfile("Habit Dashboard");
    // Two weeks of food, one hand-logged walk. Before that history exists the
    // dashboard opens on Train — the historical fallback — and after it, on Food.
    const segments = logSheetSegments(false, true);
    logActivity(profileId, anchor);
    expect(
      openingLogSegment({
        segments,
        pathname: "/",
        habitDays: getSegmentLogDays(profileId, anchor),
      })
    ).toBe("train");
    for (let d = 0; d < 14; d++) logFood(profileId, shiftDateStr(anchor, -d));
    expect(
      openingLogSegment({
        segments,
        pathname: "/",
        habitDays: getSegmentLogDays(profileId, anchor),
      })
    ).toBe("food");
  });
});
