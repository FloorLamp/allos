// DB INTEGRATION TIER — the reminder gather and the quick-log sheet answer a PAST day
// the same way, on the two axes #3989 left behind (#4019, #4011).
//
// `collectWindowDoses → gatherWindowDoses` and `pendingDayDoses` are the two surfaces a
// single late tap reaches: a stale Telegram keyboard rebuilding yesterday's message
// (lib/notifications/telegram-callbacks.ts `✅ All`) and the sheet's day switcher. Both
// take a profile-local `date` that may be a day or two back, and what the first returns
// is what `markDoseTaken` writes — so a disagreement is not a wording bug, it is a
// `taken` row and a stock decrement on a day the dose was not owed.
//
// ASSERTED AS AN EQUALITY BETWEEN THE TWO SEAMS, and carrying the day's real answer
// alongside: before #3989 both halves were wrong in the same direction and agreed, so a
// pair of literals would have passed on that tree for the wrong reason — and two empty
// lists agree about nothing. The situation axis is pinned in
// reminder-past-day-situations.test.ts, whose fixtures carry no activity rows at all;
// these carry them, which is how #4019 stayed hidden under a guard that looked total.
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect, afterEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone, switchProfileTimezone } from "@/lib/settings";
import { collectWindowDoses } from "@/lib/notifications/intake";
import { pendingDayDoses } from "@/lib/queries/usual-routine";

let seq = 0;
function newProfile(tz = "UTC"): number {
  const id = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`Past Day Agreement ${seq++}`).lastInsertRowid
  );
  setTimezone(id, tz);
  return id;
}

// One active MEDICATION with a single Morning dose. A medication so the #1156
// obligation floor can never be what decides membership, and `must` so nothing
// short-circuits ahead of the condition gate. `ageDays` back-dates BOTH creation
// stamps — the lifetime clamp reads the later of them.
function seedItem(
  profileId: number,
  name: string,
  condition: string,
  ageDays: number
): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, condition, obligation, active)
         VALUES (?, ?, 'medication', ?, 'must', 1)`
      )
      .run(profileId, name, condition).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 tab', 'Morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  const born = `${shiftDateStr(today(profileId), -ageDays)}T00:00:00Z`;
  db.prepare("UPDATE intake_items SET created_at = ? WHERE id = ?").run(
    born,
    itemId
  );
  db.prepare("UPDATE intake_item_doses SET created_at = ? WHERE id = ?").run(
    born,
    doseId
  );
  return doseId;
}

// A DRAFT HUSK (#3189): create-at-start writes the row at the session's first second,
// so a session opened and abandoned carries a date like any real one. `getActivityDates`
// drops it; `getActivitiesByDate` does not.
function seedHusk(profileId: number, date: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, start_time)
     VALUES (?, ?, 'strength', 'Session', ?)`
  ).run(profileId, date, `${date}T09:00:00Z`);
}

// A real session — it has a duration, so it is not a husk.
function seedSession(profileId: number, date: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, start_time, duration_min)
     VALUES (?, ?, 'strength', 'Session', ?, 45)`
  ).run(profileId, date, `${date}T09:00:00Z`);
}

// The two seams' answer for one day's Morning window, as names. The sheet is filtered
// to the same bucket the gather is scoped to, so the comparison is like for like.
function bothSeams(profileId: number, date: string): [string[], string[]] {
  return [
    collectWindowDoses(profileId, "Morning", date)
      .map((e) => e.item.name)
      .sort(),
    pendingDayDoses(profileId, date)
      .filter((d) => d.bucket === "Morning")
      .map((d) => d.name)
      .sort(),
  ];
}

describe("a past day's Morning window, both seams (#4019/#4011)", () => {
  it.each([
    {
      what: "a draft husk is not a training session",
      seed: (p: number, y: string) => {
        seedItem(p, "Rest day med", "rest_day", 30);
        seedItem(p, "Pre workout med", "pre_workout", 30);
        seedHusk(p, y);
      },
      owed: ["Rest day med"],
    },
    {
      // The CONVERSE of the row above: the husk-free reader still SEES a real session,
      // so the fix is "drop husks", not "stop reading activity on a closed day".
      what: "a real session is",
      seed: (p: number, y: string) => {
        seedItem(p, "Rest day med", "rest_day", 30);
        seedItem(p, "Pre workout med", "pre_workout", 30);
        seedSession(p, y);
      },
      owed: ["Pre workout med"],
    },
    {
      what: "a rhythm inferred today does not overrule yesterday's logged session",
      seed: (p: number, y: string) => {
        seedItem(p, "Rest day med", "rest_day", 30);
        seedItem(p, "Pre workout med", "pre_workout", 30);
        // A habitual weekday: four dates sharing TODAY's weekday, inside the 8-week
        // inference window, so yesterday's weekday is NOT a predicted training day.
        for (const back of [7, 14, 21, 28])
          seedSession(p, shiftDateStr(today(p), -back));
        // …and yesterday they actually trained. On the record, not a guess.
        seedSession(p, y);
      },
      owed: ["Pre workout med"],
    },
    {
      what: "an item created this morning was owed nothing yesterday",
      seed: (p: number) => {
        seedItem(p, "Long standing med", "daily", 30);
        seedItem(p, "Added today", "daily", 0);
      },
      owed: ["Long standing med"],
    },
  ])("$what", ({ seed, owed }) => {
    const p = newProfile();
    const yesterday = shiftDateStr(today(p), -1);
    seed(p, yesterday);
    // One assertion carrying both halves: the seams agree, AND they agree on what the
    // day really owed rather than on a shared blank.
    expect(bothSeams(p, yesterday)).toEqual([owed, owed]);
  });
});

// ── WHICH GATE A LOG OVERRULES, settled (#3997) ──────────────────────────────
//
// Two gates in `gatherWindowDoses` sit twelve lines apart and treat a resolved row
// differently, and the divergence is deliberate. The TRAVEL gate is a claim about the
// CLOCK — "this hour never happened on your day" — which a log on that date directly
// falsifies, so the log wins and the row stays as done. The DUENESS gate is a claim
// about the SCHEDULE, which a log does not falsify: taking a dose the day never owed is
// an extra, not evidence the day owed it, and re-admitting it would put rows that are
// never scheduled-due into the unfiltered set the missed-dose escalation reads.
//
// Both directions are pinned here because a change that "reconciled" the two gates
// would satisfy either one alone.
describe("a past-day log overrules the clock, not the schedule (#3997)", () => {
  afterEach(() => {
    delete process.env.ALLOS_TEST_NOW;
  });

  it("does not re-admit a dose the schedule says the day never owed", () => {
    const p = newProfile();
    const yesterday = shiftDateStr(today(p), -1);
    const doseId = seedItem(p, "Rest day med", "rest_day", 30);
    seedSession(p, yesterday); // a training day, so a rest-day dose was not due
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, date, status) VALUES (?, ?, 'taken')`
    ).run(doseId, yesterday);

    expect(
      collectWindowDoses(p, "Morning", yesterday).map((e) => e.item.name)
    ).toEqual([]);
  });

  it("does re-admit a dose whose slot the wall clock jumped over", () => {
    // 14:00 UTC is 10:00 in New York and 23:00 in Tokyo — the same calendar date in
    // both, so flying east erases the 20:00 Evening slot without moving the day.
    process.env.ALLOS_TEST_NOW = "2026-05-01T14:00:00Z";
    const p = newProfile("America/New_York");
    const switchDay = today(p);
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, condition, obligation, active, created_at)
           VALUES (?, 'Evening med', 'medication', 'daily', 'must', 1, '2026-04-01 09:00:00')`
        )
        .run(p).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
           VALUES (?, '1 tab', 'Evening', 'any', 0, '2026-04-01 09:00:00')`
        )
        .run(itemId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, date, status) VALUES (?, ?, 'taken')`
    ).run(doseId, switchDay);
    switchProfileTimezone(p, "Asia/Tokyo", "America/New_York");

    // The next day, rebuilding the switch day's message — the late-tap shape.
    process.env.ALLOS_TEST_NOW = "2026-05-02T11:00:00Z";
    const rebuilt = collectWindowDoses(p, "Evening", switchDay);
    expect(rebuilt.map((e) => [e.item.name, e.taken])).toEqual([
      ["Evening med", true],
    ]);
  });
});
