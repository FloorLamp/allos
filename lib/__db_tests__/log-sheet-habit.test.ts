// DB INTEGRATION TIER (issue #2709, re-based by #4249): the "most-logged domain"
// gather.
//
// The decision over these counts is pure and covered in
// lib/__tests__/log-sheet.test.ts. What needs a database is everything the gather
// itself claims: that it counts DAYS rather than rows, that it stops at the window
// edge, that an ingested row is not a log, that Body and Consume are fed by
// every ledger their entries write to, and that one profile's logging never lands
// in another's count.
//
// THE FIXTURES WRITE THROUGH THE REAL CORES wherever a core exists, and that is the
// point of them rather than a stylistic preference. This file once shipped
// hand-writing its `medical_records` row with no `source`, which is a row shape the
// app has never produced: `insertVitals` stamps `source = 'manual'` through
// `recordReading`, so the arm's `source IS NULL` filter excluded every real vitals
// sitting while the fixture's invented one sailed through. A predicate can only be
// held to its writer by a fixture that IS its writer (#2720).
//
// THAT LESSON IS WHY #4249's SWITCH IS VISIBLE HERE AT ALL. The measure no longer
// asks `source` (device-versus-hand); it asks `logged_via` (which surface a person
// used), so every fixture row must now carry the surface its writer stamps. Rows
// written by hand below name one explicitly, and the cross-surface cases in
// lib/__db_tests__/surface-usage.test.ts drive the real Telegram and web cores.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { createCycleRow } from "@/lib/cycle-store";
import { logFoodServingCore } from "@/lib/food-log-write";
import {
  insertBodyMetric,
  insertVitals,
  insertWaistCirc,
} from "@/lib/offline/writes";
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

// The real food core: one `food_daily_totals` bump AND one stamped
// `food_log_events` row, in one transaction, exactly as every food tap writes.
function logFood(profileId: number, date: string, group = "fruit"): void {
  expect(logFoodServingCore(profileId, group, date, "quick-log").kind).toBe(
    "logged"
  );
}

function logActivity(
  profileId: number,
  date: string,
  // A hand-logged session declares its web surface; an integration's import
  // stamps `import` (lib/integrations/normalize.ts) and names its provider in
  // `source`. Both halves are written because the measure reads the first.
  loggedVia: string = "page",
  source: string | null = null
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, source, logged_via)
     VALUES (?, ?, 'cardio', 'Walk', ?, ?)`
  ).run(profileId, date, source, loggedVia);
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

  it("does not count an ingested row as a log", () => {
    const { profileId, anchor } = makeProfile("Habit Sync");
    logActivity(profileId, anchor, "import", "strava");
    logActivity(
      profileId,
      shiftDateStr(anchor, -1),
      "import",
      "health-connect"
    );
    expect(getSegmentLogDays(profileId, anchor).train ?? 0).toBe(0);
    logActivity(profileId, shiftDateStr(anchor, -2));
    expect(getSegmentLogDays(profileId, anchor).train).toBe(1);
  });

  // A row the app cannot attribute to a surface is not evidence about surfaces.
  // `logged_via` arrived nullable with no backfill (#3087), so this is the shape of
  // every row written before 2026-08-22 — and reading it as a web act would be the
  // same unfounded claim #4249 removed, made about older rows instead.
  it("does not count an unstamped row as a web log", () => {
    const { profileId, anchor } = makeProfile("Habit Unstamped");
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title) VALUES (?, ?, 'cardio', 'Walk')`
    ).run(profileId, anchor);
    expect(getSegmentLogDays(profileId, anchor).train ?? 0).toBe(0);
  });

  it("feeds Body from every ledger its entries write to, deduped per day", () => {
    const { profileId, anchor } = makeProfile("Habit Body");
    // A weigh-in and a hand-typed vitals sitting — two ledgers, one segment, each
    // written by the core the sheet's own entry mounts, so each arm is tested
    // against the row shape that entry actually writes.
    expect(
      insertBodyMetric(profileId, {
        date: anchor,
        weight: "70",
        weightUnit: "kg",
        loggedVia: "page",
        bodyFatPct: null,
        restingHr: null,
        notes: null,
      }).wrote
    ).toBe(true);
    expect(
      insertVitals(
        profileId,
        shiftDateStr(anchor, -1),
        {
          systolic: "118",
          diastolic: "74",
        },
        "page"
      ).wrote
    ).toBe(true);
    // The vitals sitting really is a stamped `medical_records` row in the store —
    // the fact the arm's predicate has to agree with, pinned here so a fixture can
    // never again invent an easier row than the app writes.
    expect(
      db
        .prepare(
          `SELECT DISTINCT source, logged_via FROM medical_records
            WHERE profile_id = ? AND category = 'vitals'`
        )
        .all(profileId)
    ).toEqual([{ source: "manual", logged_via: "page" }]);
    expect(getSegmentLogDays(profileId, anchor).body).toBe(2);
  });

  // THE COST OF THE #4249 SWITCH, PINNED RATHER THAN LEFT TO DRIFT (`LOG_DAY_SOURCES`
  // argues both). `metric_samples` and `cycles` are outside the #3087 tranche: a waist
  // measurement and a period start carry no `logged_via`, so neither can say which
  // surface wrote it, and the measure counts WEB acts. `insertWaistCirc` does not even
  // TAKE a surface, which is the fact that argument rests on — so the day is not habit
  // evidence, and Body stays exactly one tap away on the track regardless.
  it("leaves the unstamped Body ledgers out of the count, and says so", () => {
    const { profileId, anchor } = makeProfile("Habit Body Gap");
    expect(
      insertWaistCirc(profileId, anchor, {
        waistCirc: "80",
        waistCircUnit: "cm",
      })
    ).toBe(true);
    createCycleRow(profileId, shiftDateStr(anchor, -1), null, null, null);
    expect(getSegmentLogDays(profileId, anchor).body ?? 0).toBe(0);
    // Not hidden — Body is still a segment on the track with its entries intact.
    expect(logSheetSegments(true).map((s) => s.id)).toContain("body");
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
      `INSERT INTO medical_records (profile_id, date, category, name, value, document_id, logged_via)
       VALUES (?, ?, 'vitals', 'Blood pressure', '120/80', ?, 'import')`
    ).run(profileId, anchor, documentId);
    db.prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, value, logged_via)
       VALUES (?, ?, 'lab', 'ALT', '20', 'page')`
    ).run(profileId, anchor);
    expect(getSegmentLogDays(profileId, anchor).body ?? 0).toBe(0);
  });

  it("feeds Consume from doses and Care from practices, never from check-ins", () => {
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
      "INSERT INTO intake_item_logs (dose_id, item_id, date, logged_via) VALUES (?, ?, ?, 'quick-log')"
    ).run(doseId, itemId, anchor);
    db.prepare(
      "INSERT INTO practice_logs (profile_id, practice, date, logged_via) VALUES (?, 'sauna', ?, 'page')"
    ).run(profileId, shiftDateStr(anchor, -1));
    expect(getSegmentLogDays(profileId, anchor)).toMatchObject({
      food: 1,
      care: 1,
    });
    // A check-in on a third day adds nothing: the #992 contract keeps its store
    // out of every engine, and this measure is an engine.
    db.prepare(
      "INSERT INTO mood_logs (profile_id, date, valence) VALUES (?, ?, 3)"
    ).run(profileId, shiftDateStr(anchor, -2));
    expect(getSegmentLogDays(profileId, anchor)).toMatchObject({
      food: 1,
      care: 1,
    });
  });

  // #4064 added the symptom arm to Care. The check that matters is the PAIRING: a
  // symptom day is Care evidence, and it dedupes with the practice arm on a day that
  // has both, exactly as the Body ledgers do.
  it("counts a symptom day toward Care, deduped against the practice arm", () => {
    const { profileId, anchor } = makeProfile("Habit Symptom");
    const shared = shiftDateStr(anchor, -1);
    db.prepare(
      "INSERT INTO practice_logs (profile_id, practice, date, logged_via) VALUES (?, 'sauna', ?, 'page')"
    ).run(profileId, shared);
    for (const date of [shared, anchor]) {
      db.prepare(
        `INSERT INTO symptom_logs (profile_id, date, symptom, severity, logged_via)
         VALUES (?, ?, 'headache', 2, 'quick-log')`
      ).run(profileId, date);
    }
    expect(getSegmentLogDays(profileId, anchor)).toMatchObject({ care: 2 });
  });

  // #3327 added the substance arm; #4435's event tranche gave it a second stamped
  // ledger. Both are declared, and day SETS union — so a day carried by both is one
  // day's evidence, never two.
  it("counts substance and alcohol taps toward Consume where they land", () => {
    const { profileId, anchor } = makeProfile("Habit Substance");
    db.prepare(
      `INSERT INTO substance_daily_totals (profile_id, date, substance, units, logged_via)
       VALUES (?, ?, 'nicotine', 2, 'quick-log')`
    ).run(profileId, anchor);
    db.prepare(
      `INSERT INTO substance_log_events (profile_id, date, substance, logged_via)
       VALUES (?, ?, 'nicotine', 'quick-log')`
    ).run(profileId, anchor);
    db.prepare(
      `INSERT INTO substance_daily_totals (profile_id, date, substance, units, logged_via)
       VALUES (?, ?, 'Kratom', 1, 'page')`
    ).run(profileId, shiftDateStr(anchor, -1));
    expect(getSegmentLogDays(profileId, anchor).food).toBe(2);

    // TWO substances on ONE day is one logged day, like every other arm: the
    // measure counts days, never rows, which is what keeps a burst from moving it.
    db.prepare(
      `INSERT INTO substance_daily_totals (profile_id, date, substance, units, logged_via)
       VALUES (?, ?, 'cannabis', 1, 'page')`
    ).run(profileId, anchor);
    expect(getSegmentLogDays(profileId, anchor).food).toBe(2);

    // Alcohol's taps land on the food ledger (#860/#944), which the Consume arm
    // already counts. `LOG_DAY_SOURCES` deliberately does not name that ledger twice,
    // so a drink is one segment's evidence rather than two.
    logFood(profileId, shiftDateStr(anchor, -2), "alcohol");
    expect(getSegmentLogDays(profileId, anchor).care ?? 0).toBe(0);
    expect(getSegmentLogDays(profileId, anchor).food).toBe(3);
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
    // dashboard opens on Train — the historical fallback — and after it, on Consume.
    const segments = logSheetSegments(true);
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
