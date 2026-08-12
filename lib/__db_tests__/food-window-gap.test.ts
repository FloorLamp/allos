// DB INTEGRATION TIER — the empty-window notice's GATHER (issue #2376). The pure
// decision is covered in lib/__tests__/food-window-gap.test.ts; what needs a database is
// the ledger read behind it (getLoggedFoodWindows, deriving each day's windows through
// the ONE existing precedence) and the end-to-end claim that buildFoodNudge states the
// gap on the nudge that was already going to fire — without becoming a second send.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { logFoodServingCore } from "@/lib/food-log-write";
import { addProteinGramsCore } from "@/lib/protein-daily-totals-write";
import { getLoggedFoodWindows } from "@/lib/queries";
import { buildFoodNudge } from "@/lib/notifications/food";
import { getNotifySchedule } from "@/lib/settings/notifications";
import { plainBody } from "@/lib/notifications/rich-text";
import { FOOD_WINDOW_HABIT_DAYS } from "@/lib/food-window-gap";
import { seedProfile, type SeededProfile } from "./fixtures";

// Default profile timezone is UTC and the profile configures no notify slots, so the
// food boundaries are the fixed 11:00 / 15:00 defaults: 08:00Z is Morning, 12:30Z is
// Midday, 19:00Z is Evening.
const MORNING = "08:00:00Z";
const MIDDAY = "12:30:00Z";
const EVENING = "19:00:00Z";

// Late enough in the day that Morning and Midday have both closed.
function at(date: string, time: string): Date {
  return new Date(`${date}T${time}`);
}

// A profile that logs breakfast and lunch on every one of the trailing evidence days,
// and has logged NOTHING at all today.
function seedHabitualLogger(tag: string): SeededProfile {
  const p = seedProfile(tag);
  const t = today(p.profileId);
  for (let i = 1; i <= FOOD_WINDOW_HABIT_DAYS; i++) {
    const d = shiftDateStr(t, -i);
    logFoodServingCore(p.profileId, "leafy_greens", d, `${d}T${MORNING}`);
    logFoodServingCore(p.profileId, "fatty_fish", d, `${d}T${MIDDAY}`);
  }
  return p;
}

describe("getLoggedFoodWindows", () => {
  let p: SeededProfile;
  let t: string;

  beforeAll(() => {
    p = seedProfile("food-window-ledger");
    t = today(p.profileId);
    logFoodServingCore(p.profileId, "leafy_greens", t, `${t}T${MORNING}`);
    logFoodServingCore(p.profileId, "berries", t, `${t}T${MORNING}`);
    // A shake, under the reserved key — eating, and it must count.
    addProteinGramsCore(p.profileId, t, 30, `${t}T${EVENING}`);
    // A stated eating time wins over the tap stamp, so this evening tap is a MIDDAY
    // serving — the same precedence every other food surface reads.
    const y = shiftDateStr(t, -1);
    logFoodServingCore(
      p.profileId,
      "nuts_seeds",
      y,
      `${y}T${EVENING}`,
      undefined,
      {
        eatenAt: `${y}T${MIDDAY}`,
        source: "stated",
      }
    );
  });

  it("derives each day's windows, counting a protein tap as logged", () => {
    const got = getLoggedFoodWindows(p.profileId, shiftDateStr(t, -1), t);
    expect([...(got.get(t) ?? [])].sort()).toEqual(["Evening", "Morning"]);
  });

  it("files an event by the time it was EATEN, not the time it was tapped", () => {
    const y = shiftDateStr(t, -1);
    expect([...(getLoggedFoodWindows(p.profileId, y, y).get(y) ?? [])]).toEqual(
      ["Midday"]
    );
  });

  it("omits a day the ledger derives nothing for", () => {
    const older = shiftDateStr(t, -9);
    expect(getLoggedFoodWindows(p.profileId, older, older).has(older)).toBe(
      false
    );
  });

  it("is profile-scoped", () => {
    const other = seedProfile("food-window-ledger-other");
    expect(
      getLoggedFoodWindows(other.profileId, shiftDateStr(t, -1), t).size
    ).toBe(0);
  });
});

describe("buildFoodNudge — the empty-window clause", () => {
  it("states the gap on the next window's nudge, with no new send", () => {
    const p = seedHabitualLogger("food-window-gap-states");
    const t = today(p.profileId);
    const msg = buildFoodNudge(p.profileId, "Midday", t, undefined, {
      now: at(t, MIDDAY),
    })!;
    expect(plainBody(msg.body)).toContain(
      "📋 Nothing logged for Morning today."
    );
    // It rides the message that was already firing: same kind, no extra button, and
    // nothing anywhere near a notify_* marker of its own.
    expect(msg.kind).toBe("food");
    expect(
      (msg.actions ?? []).filter((a) => !a.data?.startsWith("food"))
    ).toEqual([]);
  });

  it("reports yesterday's Evening on the Morning nudge", () => {
    const p = seedProfile("food-window-gap-evening");
    const t = today(p.profileId);
    // Dinner every evening for the whole evidence window, then a blank yesterday.
    for (let i = 2; i <= FOOD_WINDOW_HABIT_DAYS + 1; i++) {
      const d = shiftDateStr(t, -i);
      logFoodServingCore(p.profileId, "leafy_greens", d, `${d}T${EVENING}`);
    }
    const msg = buildFoodNudge(p.profileId, "Morning", t, undefined, {
      now: at(t, MORNING),
    })!;
    expect(plainBody(msg.body)).toContain(
      "📋 Nothing logged for Evening yesterday."
    );
  });

  it("goes quiet once the window has something in it", () => {
    const p = seedHabitualLogger("food-window-gap-recovers");
    const t = today(p.profileId);
    const now = at(t, MIDDAY);
    expect(
      plainBody(
        buildFoodNudge(p.profileId, "Midday", t, undefined, { now })!.body
      )
    ).toContain("Nothing logged for Morning");
    // A backfilled breakfast — the "recovery clears it" property, with no stored state
    // to clear: a rebuild of the same message simply stops saying it.
    logFoodServingCore(p.profileId, "berries", t, `${t}T${MORNING}`);
    expect(
      plainBody(
        buildFoodNudge(p.profileId, "Midday", t, undefined, { now })!.body
      )
    ).not.toContain("Nothing logged");
  });

  it("says nothing while the window is still open", () => {
    const p = seedHabitualLogger("food-window-gap-open");
    const t = today(p.profileId);
    // 10:30Z is before the 11:00 Morning/Midday boundary, so Morning has not closed.
    const msg = buildFoodNudge(p.profileId, "Midday", t, undefined, {
      now: at(t, "10:30:00Z"),
    })!;
    expect(plainBody(msg.body)).not.toContain("Nothing logged");
  });

  it("says nothing to a profile that has never logged food", () => {
    const p = seedProfile("food-window-gap-never");
    const t = today(p.profileId);
    for (const w of ["Morning", "Midday", "Evening"] as const) {
      const msg = buildFoodNudge(p.profileId, w, t, undefined, {
        now: at(t, EVENING),
      })!;
      expect(plainBody(msg.body)).not.toContain("Nothing logged");
    }
  });

  it("says nothing about a window the profile does not habitually log", () => {
    const p = seedProfile("food-window-gap-nonhabit");
    const t = today(p.profileId);
    // Lunch every day; breakfast twice in the fortnight. Telling this person daily that
    // breakfast is missing is exactly what the habit gate exists to prevent.
    for (let i = 1; i <= FOOD_WINDOW_HABIT_DAYS; i++) {
      const d = shiftDateStr(t, -i);
      logFoodServingCore(p.profileId, "fatty_fish", d, `${d}T${MIDDAY}`);
      if (i <= 2)
        logFoodServingCore(p.profileId, "berries", d, `${d}T${MORNING}`);
    }
    const msg = buildFoodNudge(p.profileId, "Midday", t, undefined, {
      now: at(t, MIDDAY),
    })!;
    expect(plainBody(msg.body)).not.toContain("Nothing logged");
    // The window they DO log is still reportable on the same day's evening nudge.
    expect(
      plainBody(
        buildFoodNudge(p.profileId, "Evening", t, undefined, {
          now: at(t, EVENING),
        })!.body
      )
    ).toContain("Nothing logged for Midday today.");
  });

  it("says nothing to a profile with no windows configured", () => {
    // A profile that turned every intake slot off gets no food nudge at all — the tick
    // only builds one for a slot with a minute (scripts/notify.ts), so there is no
    // message for the clause to ride. Asserted at the schedule, because that is where
    // the silence actually comes from.
    const p = seedHabitualLogger("food-window-gap-noslots");
    for (const key of [
      "notify_supp_morning_hour",
      "notify_supp_midday_hour",
      "notify_supp_evening_hour",
    ])
      db.prepare(
        `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, '')
           ON CONFLICT(profile_id, key) DO UPDATE SET value = ''`
      ).run(p.profileId, key);
    const sched = getNotifySchedule(p.profileId);
    for (const w of ["Morning", "Midday", "Evening"] as const)
      expect(sched.supplementMinutes[w]).toBeNull();
  });
});
