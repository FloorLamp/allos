// DB INTEGRATION TIER — issue #3265: the composed one-tap's own window versus the one
// the dashboard placed it in.
//
// The composed usual-routine offer (#2458) is FOOD-SLOT anchored: `getUsualRoutineOffer`
// is asked about `currentFoodSlot`, and the Evening food window runs to local midnight
// (lib/food-slot.ts — there is deliberately no bedtime cut in food space). The dashboard
// then gave the candidate `mealTimeWindows(nowMealAnchors)` timing — the intake REMINDER
// anchors +/- 60 minutes, whose last window closes at 21:00. Two windows for one fact.
//
// So between 21:00 and local midnight the dashboard computed the offer, paid the reads to
// do it, and `resolveDashboardTiming` called it `expired` — which drops a candidate from
// EVERY lane, not just from Now. Not demoted to "Show everything": absent.
//
// This fixture stands at 22:30 local, inside those three hours. `mealTimeWindows` at the
// same minute is asserted `expired` in the same test, so the fixture names what shipped
// rather than only what should happen.
//
// Fixtures are synthetic throwaway rows (per-file temp DB via setup.ts). No PHI.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { getNotifySchedule } from "@/lib/settings/notifications";
import { currentFoodSlotWindow } from "@/lib/queries/nutrition";
import { getUsualRoutineOffer } from "@/lib/queries/usual-routine";
import {
  localTimeWindow,
  mealTimeWindows,
  resolveDashboardTiming,
} from "@/lib/dashboard-relevance";

// 22:30 UTC read by a UTC profile is 22:30 local: past every meal window's close, with
// ninety minutes of the Evening food window still to run.
const LATE_EVENING = "2026-08-19T22:30:00.000Z";
const LATE_EVENING_MINUTE = 22 * 60 + 30;

let priorNow: string | undefined;

beforeEach(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = LATE_EVENING;
});

afterEach(() => {
  if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorNow;
});

function tap(profileId: number, group: string, date: string, hhmmss: string) {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, group, date, `${date}T${hhmmss}Z`);
}

// Twelve evenings of the same two groups, with today deliberately empty so the offer
// stands on arrival. UTC so the profile's local clock IS the frozen instant's.
function seedEveningHabit(name: string): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  const anchor = today(profileId);
  for (let d = 1; d <= 12; d++) {
    const date = shiftDateStr(anchor, -d);
    tap(profileId, "fermented", date, "19:00:00");
    tap(profileId, "berries", date, "19:05:00");
  }
  return profileId;
}

describe("the usual-routine offer's window and its placement window (#3265)", () => {
  it("stands at 22:30 and is PLACED at 22:30, where the meal windows had expired", () => {
    const p = seedEveningHabit("LateEvening");

    // 1. The offer is computed and it stands — the DB reads the dashboard pays.
    const slot = currentFoodSlotWindow(p);
    const offer = getUsualRoutineOffer(p, slot.slot, today(p));
    expect(offer?.groups).toEqual(["berries", "fermented"]);

    // 2. The window the offer is about holds this minute, with room to spare.
    expect(slot).toEqual({ slot: "Evening", opensAt: 900, endsBefore: 1440 });
    expect(
      resolveDashboardTiming(
        localTimeWindow(slot.opensAt, slot.endsBefore - 1),
        LATE_EVENING_MINUTE
      )
    ).toEqual({ kind: "active" });

    // 3. WHAT SHIPPED. The reminder anchors are 08:00 / 13:00 / 20:00, so the last
    //    window closed at 21:00 and the candidate was dropped before any lane was built.
    const schedule = getNotifySchedule(p).supplementMinutes;
    const anchors = [
      schedule.Morning,
      schedule.Midday,
      schedule.Evening,
    ].filter((m): m is number => m != null);
    expect(anchors).toEqual([8 * 60, 13 * 60, 20 * 60]);
    expect(
      resolveDashboardTiming(mealTimeWindows(anchors), LATE_EVENING_MINUTE)
    ).toEqual({ kind: "expired" });
  });

  // The fix is not "always active" — it is "active for the window it is about". Both
  // edges of the Evening span are named, because a window that quietly ran past midnight
  // would be a different bug in the same place; and 14:59 is Midday's last minute, so the
  // Evening offer is still AHEAD there rather than gone.
  it.each([
    [15 * 60, { kind: "active" }],
    [1439, { kind: "active" }],
    [15 * 60 - 1, { kind: "future-today", opensAt: 900 }],
  ])("resolves minute %i as %o", (minute, expected) => {
    const p = seedEveningHabit(`EveningEdge${minute}`);
    const slot = currentFoodSlotWindow(p);
    expect(
      resolveDashboardTiming(
        localTimeWindow(slot.opensAt, slot.endsBefore - 1),
        minute
      )
    ).toEqual(expected);
  });

  // THE HOURS WHERE THE DEFECT IS INVISIBLE, stated so the fixture above is not read as a
  // claim that the two windows never agreed. Inside a meal window they say the same
  // thing, which is why this stood for as long as it did.
  it("agrees with the meal windows at 20:00, inside the Evening reminder window", () => {
    const p = seedEveningHabit("EveningAgreement");
    const slot = currentFoodSlotWindow(p);
    const atEight = 20 * 60;
    expect(
      resolveDashboardTiming(
        localTimeWindow(slot.opensAt, slot.endsBefore - 1),
        atEight
      )
    ).toEqual({ kind: "active" });
    expect(
      resolveDashboardTiming(mealTimeWindows([8 * 60, 13 * 60, 20 * 60]), atEight)
    ).toEqual({ kind: "active" });
  });
});
