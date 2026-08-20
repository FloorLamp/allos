// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #3263 — the SWITCH DAY. The pure tier (lib/__tests__/travel-timezone.test.ts)
// pins the two spans over literals; these pin the halves only a real profile, a real
// settings store and a real dose ledger can show:
//
//   1. The one-tap switch answers in the NEW zone within one request — today(), the
//      minute the tick decides slots by, and the day window over it.
//   2. EASTWARD: the slot the wall clock jumped over is EXCUSED BY NAME in the
//      adherence strip, out of the denominator, and its reminder builds to nothing —
//      while a slot on the same day that really did happen still builds a send.
//   3. WESTWARD: the morning dose taken before the switch is not re-asked and not
//      re-counted when its hour comes round a second time.
//   4. The day after a switch is ordinary.
//
// Every instant here is frozen through the clock seam (ALLOS_TEST_NOW, lib/clock.ts),
// because the whole subject is which wall clock a fixed instant reads on.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db, today } from "@/lib/db";
import { lastNDates, minuteOfDayInTz } from "@/lib/date";
import { localDayRange } from "@/lib/local-day-window";
import {
  adherenceSummary,
  indexTakenByDose,
  intakeAdherenceStrip,
} from "@/lib/intake-adherence";
import { travelExcusalResolver } from "@/lib/travel-excusal";
import { isExcusedSlot, isRepeatedSlot } from "@/lib/travel-timezone";
import { buildIntakeReminderForSlots } from "@/lib/notifications/intake";
import { getIntakeItems, getIntakeDoses, getIntakeLogsInRange } from "@/lib/queries";
import {
  getHomeTimezone,
  getTimezone,
  getTravelSwitches,
  setTimezone,
  switchProfileTimezone,
  clearHomeTimezone,
} from "@/lib/settings";

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";
const HONOLULU = "Pacific/Honolulu";

// 2026-05-01T14:00:00Z reads 10:00 in New York (EDT), 23:00 in Tokyo and 04:00 in
// Honolulu — the SAME local calendar date on all three, which is what lets these
// tests watch a slot vanish (or repeat) without the date moving underneath the
// assertion.
const SWITCH_INSTANT = "2026-05-01T14:00:00Z";
const SWITCH_DAY = "2026-05-01";
// The doses exist from the switch instant onward, so the window each strip is scored
// over is the switch day itself (plus whatever follows) rather than a fortnight of
// pre-existence days — see doseWindowSince (#430/#1442).
const SEEDED_AT = "2026-05-01 14:00:00";

const MORNING_MINUTE = 8 * 60;
const EVENING_MINUTE = 20 * 60;

function freeze(instant: string): void {
  process.env.ALLOS_TEST_NOW = instant;
}

beforeEach(() => {
  freeze(SWITCH_INSTANT);
});

afterEach(() => {
  delete process.env.ALLOS_TEST_NOW;
});

function makeProfile(name: string, tz: string): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(profileId, tz);
  return profileId;
}

// One active daily MEDICATION with a single dose in one time bucket. A medication so
// the notification obligation floor (#1156) never filters it out of a send — the
// question here is travel, not obligation.
function seedDose(
  profileId: number,
  name: string,
  timeOfDay: string
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation, created_at)
         VALUES (?, ?, 1, 'medication', 'daily', 'must', ?)`
      )
      .run(profileId, name, SEEDED_AT).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, '1 tab', ?, 'any', 0, ?)`
      )
      .run(itemId, timeOfDay, SEEDED_AT).lastInsertRowid
  );
  return { itemId, doseId };
}

function logTaken(doseId: number, itemId: number, date: string): void {
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status, recorded_at)
     VALUES (?, ?, ?, 'taken', ?)`
  ).run(doseId, itemId, date, `${date} 12:00:00`);
}

// The item's own adherence strip over the trailing fortnight, travel excusal wired in
// exactly as every production caller wires it.
function stripFor(profileId: number, itemId: number) {
  const item = getIntakeItems(profileId).find((i) => i.id === itemId)!;
  const doses = getIntakeDoses(profileId).filter((d) => d.item_id === itemId);
  const dates = lastNDates(today(profileId), 14);
  return intakeAdherenceStrip(
    item,
    doses,
    dates,
    new Set<string>(),
    () => new Set<string>(),
    indexTakenByDose(getIntakeLogsInRange(profileId, 14)),
    getTimezone(profileId),
    travelExcusalResolver(profileId)
  );
}

function stateOn(
  strip: ReturnType<typeof stripFor>,
  date: string
): string | undefined {
  return strip.find((d) => d.date === date)?.state;
}

describe("the one-tap switch answers in the new zone (#3263 §2)", () => {
  it("moves today(), the tick's minute and the day window in one request", () => {
    const profileId = makeProfile("switch-answers", NY);
    // Before: 10:00 on 2026-05-01, New York.
    expect(today(profileId)).toBe(SWITCH_DAY);
    expect(minuteOfDayInTz(getTimezone(profileId), new Date(SWITCH_INSTANT))).toBe(
      10 * 60
    );
    const before = localDayRange(getTimezone(profileId), SWITCH_DAY);

    switchProfileTimezone(profileId, TOKYO, NY);

    // After: the same instant, read as 23:00 on the same date in Tokyo. No second
    // request, no cache to wait out.
    expect(getTimezone(profileId)).toBe(TOKYO);
    expect(today(profileId)).toBe(SWITCH_DAY);
    expect(minuteOfDayInTz(getTimezone(profileId), new Date(SWITCH_INSTANT))).toBe(
      23 * 60
    );
    const after = localDayRange(getTimezone(profileId), SWITCH_DAY);
    // The day itself moved 13 hours earlier in absolute terms.
    expect(after.startUtc).not.toBe(before.startUtc);
    expect(Date.parse(after.startUtc)).toBeLessThan(Date.parse(before.startUtc));
  });

  it("records the zone left behind as home, and the seam it left in the clock", () => {
    const profileId = makeProfile("switch-records", NY);
    switchProfileTimezone(profileId, TOKYO, NY);
    expect(getHomeTimezone(profileId)).toBe(NY);
    expect(getTravelSwitches(profileId)).toEqual([
      { at: "2026-05-01T14:00:00Z", from: NY, to: TOKYO },
    ]);
  });

  it("clears home and records the return leg when the day comes back", () => {
    const profileId = makeProfile("switch-return", NY);
    switchProfileTimezone(profileId, TOKYO, NY);
    switchProfileTimezone(profileId, NY, null);
    clearHomeTimezone(profileId);
    expect(getTimezone(profileId)).toBe(NY);
    expect(getHomeTimezone(profileId)).toBeNull();
    // The return leg is a switch like any other and joins the same history — it
    // leaves its own seam in the wall clock, westward this time.
    expect(getTravelSwitches(profileId)).toHaveLength(2);
    expect(getTravelSwitches(profileId)[1]).toEqual({
      at: "2026-05-01T14:00:00Z",
      from: TOKYO,
      to: NY,
    });
  });
});

describe("eastward: the vanished slot is excused, not missed (#3263 §4)", () => {
  it("names the slot EXCUSED and takes it out of the denominator", () => {
    const profileId = makeProfile("east-excused", NY);
    const evening = seedDose(profileId, "Evening med", "Evening");

    // Fly east at 10:00 New York, landing on a 23:00 Tokyo clock: the wall clock
    // between them — including this dose's 20:00 slot — never occurred.
    switchProfileTimezone(profileId, TOKYO, NY);
    expect(
      isExcusedSlot(getTravelSwitches(profileId), SWITCH_DAY, EVENING_MINUTE)
    ).toBe(true);

    const strip = stripFor(profileId, evening.itemId);
    // BY NAME. A percentage would read the same whether the slot was excused or
    // silently dropped, so the disposition is what is asserted.
    expect(stateOn(strip, SWITCH_DAY)).toBe("excused");
    expect(stateOn(strip, SWITCH_DAY)).not.toBe("missed");

    const summary = adherenceSummary(strip);
    expect(summary.excusedDays).toBe(1);
    // Out of the denominator entirely: the day contributes to neither half of the
    // fraction, exactly as a deliberate skip does.
    expect(summary.applicableDays).toBe(0);
    expect(summary.takenDays).toBe(0);
  });

  it("sends nothing for the vanished slot, while the day's real slot still sends", () => {
    const profileId = makeProfile("east-silent", NY);
    seedDose(profileId, "Evening med", "Evening");
    seedDose(profileId, "Morning med", "Morning");

    // CONTROL, before the switch: both slots build a send, so a null afterwards
    // means the travel gate fired and not that this profile can never be reminded.
    expect(buildIntakeReminderForSlots(profileId, ["Evening"])).not.toBeNull();
    expect(buildIntakeReminderForSlots(profileId, ["Morning"])).not.toBeNull();

    switchProfileTimezone(profileId, TOKYO, NY);

    // Silence over a false miss: the 20:00 slot never arrived on this profile's own
    // clock, so there is nothing to remind about.
    expect(buildIntakeReminderForSlots(profileId, ["Evening"])).toBeNull();
    // The 08:00 slot happened — it was before the jump — so it is still asked for.
    expect(buildIntakeReminderForSlots(profileId, ["Morning"])).not.toBeNull();
  });

  it("keeps a dose the person logged anyway, whatever the clock did to its slot", () => {
    const profileId = makeProfile("east-logged", NY);
    const evening = seedDose(profileId, "Evening med", "Evening");
    logTaken(evening.doseId, evening.itemId, SWITCH_DAY);

    switchProfileTimezone(profileId, TOKYO, NY);

    // The log outranks the clock: a dose somebody took is taken, and excusing it
    // would erase a day of real adherence.
    expect(stateOn(stripFor(profileId, evening.itemId), SWITCH_DAY)).toBe("taken");
    expect(adherenceSummary(stripFor(profileId, evening.itemId)).takenDays).toBe(1);
  });

  it("leaves the next day fully normal", () => {
    const profileId = makeProfile("east-next-day", NY);
    const evening = seedDose(profileId, "Evening med", "Evening");
    switchProfileTimezone(profileId, TOKYO, NY);

    // 2026-05-02T11:00:00Z is 20:00 on 2026-05-02 in Tokyo — the day after, at the
    // very slot that vanished yesterday.
    freeze("2026-05-02T11:00:00Z");
    expect(today(profileId)).toBe("2026-05-02");
    expect(
      isExcusedSlot(getTravelSwitches(profileId), "2026-05-02", EVENING_MINUTE)
    ).toBe(false);
    expect(buildIntakeReminderForSlots(profileId, ["Evening"])).not.toBeNull();
    // Yesterday keeps its excusal; today is judged like any other day.
    const strip = stripFor(profileId, evening.itemId);
    expect(stateOn(strip, SWITCH_DAY)).toBe("excused");
    expect(stateOn(strip, "2026-05-02")).toBe("missed");
  });
});

describe("westward: the repeated hour is not re-asked (#3263 §4)", () => {
  it("does not re-send a slot the date has already answered", () => {
    const profileId = makeProfile("west-repeat", TOKYO);
    const morning = seedDose(profileId, "Morning med", "Morning");
    const evening = seedDose(profileId, "Evening med", "Evening");
    logTaken(morning.doseId, morning.itemId, SWITCH_DAY);

    // 23:00 Tokyo → 04:00 Honolulu, same calendar date: every hour from 04:00 to
    // 23:00 comes round a second time today, the 08:00 slot among them.
    switchProfileTimezone(profileId, HONOLULU, TOKYO);
    expect(today(profileId)).toBe(SWITCH_DAY);
    const switches = getTravelSwitches(profileId);
    expect(isRepeatedSlot(switches, SWITCH_DAY, MORNING_MINUTE)).toBe(true);
    // A repeated hour is emphatically NOT an excused one — it happened twice, not
    // never, so it stays in the denominator and stays answerable.
    expect(isExcusedSlot(switches, SWITCH_DAY, MORNING_MINUTE)).toBe(false);

    // The dose is keyed by dose + profile-local DATE, and that date has answered.
    expect(buildIntakeReminderForSlots(profileId, ["Morning"])).toBeNull();
    // CONTROL: the unlogged evening dose on the same repeated day still sends, so
    // the null above is the log talking and not a blanket suppression.
    expect(buildIntakeReminderForSlots(profileId, ["Evening"])).not.toBeNull();
    void evening;
  });

  it("counts the repeated day once, as taken", () => {
    const profileId = makeProfile("west-count", TOKYO);
    const morning = seedDose(profileId, "Morning med", "Morning");
    logTaken(morning.doseId, morning.itemId, SWITCH_DAY);
    switchProfileTimezone(profileId, HONOLULU, TOKYO);

    const strip = stripFor(profileId, morning.itemId);
    expect(stateOn(strip, SWITCH_DAY)).toBe("taken");
    const summary = adherenceSummary(strip);
    expect(summary.takenDays).toBe(1);
    expect(summary.applicableDays).toBe(1);
    expect(summary.excusedDays).toBe(0);
    expect(summary.pct).toBe(100);
  });
});

describe("a profile that has never travelled", () => {
  it("excuses nothing and reads exactly as it did before", () => {
    const profileId = makeProfile("homebody", NY);
    const evening = seedDose(profileId, "Evening med", "Evening");
    expect(getTravelSwitches(profileId)).toEqual([]);
    expect(getHomeTimezone(profileId)).toBeNull();
    const strip = stripFor(profileId, evening.itemId);
    // Today, unlogged, still pending — the pre-#3263 answer, untouched.
    expect(stateOn(strip, SWITCH_DAY)).toBe("missed");
    expect(adherenceSummary(strip).excusedDays).toBe(0);
  });
});
