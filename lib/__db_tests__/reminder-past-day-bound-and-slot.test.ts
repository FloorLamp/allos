// DB INTEGRATION TIER — two ways TODAY reaches back into a CLOSED day on the reminder
// write path (`collectWindowDoses` → `gatherWindowDoses`), reached with a date that is
// not today the way a stale Telegram keyboard, the `✅ All` bulk tap and the
// button-liveness reconcile all reach it.
//
//   #4025 — the dose LIFETIME bound is a UTC `created_at` resolved through the
//           profile's zone. Move the zone eastward and the bound walks forward past a
//           day the dose demonstrably existed on, so the rebuilt reminder drops it and
//           `✅ All` writes nothing the day owed.
//   #4026 — the PreWorkout slot membership is `inferWorkoutSchedule(profileId)`, a
//           trailing window ending NOW. A cadence that becomes inferable today moves
//           yesterday's dose into a different send slot, so the slot the message named
//           rebuilds EMPTY — which reconcile cannot tell from "nothing to do"
//           (reconcile.ts's `entries.length > 0` death check), so the button never
//           retires.
//
// BOTH ARE ASSERTED AS AN EQUALITY BETWEEN TWO SEAMS, never against a literal: the
// reminder gather against the adherence strip the same bound clamps (#221 — one bound,
// one answer), and the day's own gather against itself across a change that happened
// after the day closed. A literal can be wrong on both sides and still agree.
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone, switchProfileTimezone } from "@/lib/settings";
import {
  collectWindowDoses,
  slotSessionForKeyboard,
} from "@/lib/notifications/intake";
import { getIntakeHistory } from "@/lib/intake-history";

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";

// 2026-04-26T14:00:00Z reads 10:00 in New York and 23:00 in Tokyo — the SAME local
// calendar day in both, so `today()` does not move when the zone does and the day
// under test stays day−1 either side of the switch.
const NOW = "2026-04-26T14:00:00Z";
// 19:30 on 2026-04-25 in New York; 08:30 on 2026-04-26 in Tokyo. The whole defect is
// that this one instant names two different profile-local days.
const CREATED_AT = "2026-04-25 23:30:00";
const CREATION_DAY_IN_NY = "2026-04-25";

let seq = 0;

beforeEach(() => {
  process.env.ALLOS_TEST_NOW = NOW;
});
afterEach(() => {
  delete process.env.ALLOS_TEST_NOW;
});

function newProfile(tz: string): number {
  const id = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`Bound And Slot ${seq++}`).lastInsertRowid
  );
  setTimezone(id, tz);
  return id;
}

// One active `must` MEDICATION with a single dose — a medication so the #1156
// obligation floor is never what decides membership.
function seedDose(
  profileId: number,
  name: string,
  timeOfDay: string,
  condition: string,
  createdAt: string
): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, active, created_at)
         VALUES (?, ?, 'medication', ?, 'must', 1, ?)`
      )
      .run(profileId, name, condition, createdAt).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, '1 tab', ?, 'any', 0, ?)`
      )
      .run(itemId, timeOfDay, createdAt).lastInsertRowid
  );
}

function seedRetimedDose(profileId: number, movedOn: string): number {
  const doseId = seedDose(
    profileId,
    "Re-timed med",
    "Morning",
    "daily",
    "2026-04-01 09:00:00"
  );
  const addVersion = db.prepare(
    `INSERT INTO intake_dose_schedule_versions
       (dose_id, effective_from, time_of_day, created_at)
     VALUES (?, ?, ?, ?)`
  );
  addVersion.run(doseId, "2026-04-01", "Evening", "2026-04-01 09:00:00");
  addVersion.run(doseId, movedOn, "Morning", `${movedOn} 09:00:00`);
  return doseId;
}

function names(
  profileId: number,
  slot: "Morning" | "Evening" | "PreWorkout",
  date: string
) {
  return collectWindowDoses(profileId, slot, date).map((e) => e.item.name);
}

// The adherence strip's own answer for `date`, through the production reader every
// history surface uses. "na" is the strip spelling of "this dose did not exist then".
function stripState(
  profileId: number,
  name: string,
  date: string
): string | undefined {
  const entry = getIntakeHistory(profileId, today(profileId), 14).find(
    (e) => e.item.name === name
  );
  return entry?.strip.find((d) => d.date === date)?.state;
}

describe("#4025 — an eastward zone change must not walk the dose lifetime bound", () => {
  it("keeps the day's dose in the reminder, and the strip agrees, across the move", () => {
    const profileId = newProfile(NY);
    seedDose(profileId, "Evening med", "Evening", "daily", CREATED_AT);

    const before = names(profileId, "Evening", CREATION_DAY_IN_NY);
    const beforeDot = stripState(profileId, "Evening med", CREATION_DAY_IN_NY);
    // The two seams answer the same question about the same day, so they agree that
    // the dose existed on it. Asserted as an equality — either could be wrong alone.
    expect(before.length > 0).toBe(beforeDot !== "na");
    expect(before).toEqual(["Evening med"]);

    switchProfileTimezone(profileId, TOKYO, NY);
    // `today()` must not have moved, or the day under test is no longer day−1 and the
    // assertions below would be about a different question.
    expect(today(profileId)).toBe("2026-04-26");

    const after = names(profileId, "Evening", CREATION_DAY_IN_NY);
    const afterDot = stripState(profileId, "Evening med", CREATION_DAY_IN_NY);
    expect(after.length > 0).toBe(afterDot !== "na");
    // A closed day's membership is a fact about that day. Moving the profile's zone
    // afterwards cannot un-owe a dose — and `✅ All` writes exactly this set.
    expect(after).toEqual(before);
    expect(afterDot).toBe(beforeDot);
  });
});

// Yesterday's send slot for the one dose, as the two slots a rebuild could name.
// The `all:` token carries exactly this slot, so a rebuild in the OTHER one is the
// empty rebuild reconcile cannot tell from "nothing to do".
function slotOfYesterdayDose(
  profileId: number,
  yesterday: string
): "Morning" | "PreWorkout" | "nowhere" {
  if (names(profileId, "PreWorkout", yesterday).length > 0) return "PreWorkout";
  if (names(profileId, "Morning", yesterday).length > 0) return "Morning";
  return "nowhere";
}

describe("#4026 — a cadence inferable today must not move a closed day's send slot", () => {
  // Both rows seed a session YESTERDAY (so the pre_workout dose is due on the closed
  // day at all) plus three more on ONE weekday — `rhythmMinDates(8)` is 4 distinct
  // dates, so where those three sit decides what was inferable WHEN.
  //
  //   "no cadence yet"  — the other three sit on TODAY's weekday, so the fourth is the
  //                       session logged today: inferable now, not yesterday.
  //   "cadence lapsing" — the other three sit on YESTERDAY's weekday, the oldest at
  //                       yesterday−56: inside yesterday's trailing window and outside
  //                       today's. Inferable yesterday, not now.
  //
  // The two rows face opposite ways on purpose. A fix that simply refused the
  // PreWorkout slot on every past day would satisfy the first and fail the second —
  // and would be the same defect wearing the other sign, because a message SENT into
  // the PreWorkout slot would then rebuild empty forever.
  it.each([
    { name: "no cadence yet", offsets: [7, 14, 21], expected: "Morning" },
    { name: "cadence lapsing", offsets: [8, 15, 57], expected: "PreWorkout" },
  ])(
    "$name: yesterday keeps the slot it was sent in",
    ({ offsets, expected }) => {
      const profileId = newProfile("UTC");
      const todayStr = today(profileId);
      const yesterday = shiftDateStr(todayStr, -1);
      const doseId = seedDose(
        profileId,
        "Pre workout anytime",
        "Anytime",
        "pre_workout",
        `${shiftDateStr(todayStr, -90)} 00:00:00`
      );
      const logActivity = (date: string) =>
        db
          .prepare(
            `INSERT INTO activities (profile_id, date, type, title, duration_min, start_time)
           VALUES (?, ?, 'strength', 'Session', 45, '17:00')`
          )
          .run(profileId, date);

      logActivity(yesterday);
      for (const back of offsets) logActivity(shiftDateStr(todayStr, -back));

      const before = slotOfYesterdayDose(profileId, yesterday);
      // TODAY's session — the event that made the cadence inferable now, long after the
      // day below closed.
      logActivity(todayStr);
      const after = slotOfYesterdayDose(profileId, yesterday);

      // The slot a closed day's dose sits in is a fact about that day: it must not move
      // when today's cadence does, and it must be the slot that day's own record implies.
      expect(after).toBe(before);
      expect(after).toBe(expected);
      // THE TAP REBUILD IS THE SAME QUESTION on a second seam: `slotSessionForKeyboard`
      // re-derives the slots of a message that may be a day or two old from its surviving
      // buttons. Asserted against the gather's answer, not against a literal — two
      // resolvers disagreeing about one day's filing is what leaves a live button
      // rebuilding an empty slot.
      expect(
        slotSessionForKeyboard(profileId, [doseId], [], yesterday).map(
          (s) => s.slot
        )
      ).toEqual([after]);
    }
  );
});

describe("#3990 — a re-timed dose keeps its closed-day send slot", () => {
  it("rebuilds an ordinary prior day in the slot its schedule held then", () => {
    const profileId = newProfile("UTC");
    const pastDay = "2026-04-25";
    const doseId = seedRetimedDose(profileId, "2026-04-26");

    expect(names(profileId, "Evening", pastDay)).toEqual(["Re-timed med"]);
    expect(names(profileId, "Morning", pastDay)).toEqual([]);
    expect(
      slotSessionForKeyboard(profileId, [doseId], [], pastDay).map(
        (part) => part.slot
      )
    ).toEqual(["Evening"]);
  });

  it("also judges travel excusal against that historical slot", () => {
    process.env.ALLOS_TEST_NOW = "2026-04-25T14:00:00Z";
    const profileId = newProfile(NY);
    const switchDay = today(profileId);
    seedRetimedDose(profileId, "2026-04-26");
    switchProfileTimezone(profileId, TOKYO, NY);
    process.env.ALLOS_TEST_NOW = "2026-04-26T11:00:00Z";

    // The eastward switch skipped the old Evening slot. The current Morning slot
    // must neither re-file the dose nor erase that historical excusal.
    expect(names(profileId, "Evening", switchDay)).toEqual([]);
    expect(names(profileId, "Morning", switchDay)).toEqual([]);
    expect(
      collectWindowDoses(profileId, "Morning", "2026-04-26")[0].adherence
        .excusedDays
    ).toBe(1);
  });
});
