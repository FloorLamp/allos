// DB INTEGRATION TIER — the notify tick's half of travel excusal (#3685).
//
// The dose/adherence readers already agree that an eastward-skipped slot is
// impossible. This drives the REAL per-profile tick to prove its retry band cannot
// resurrect that slot for the three independently dispatched messages that ride it:
// the person's dose reminder, food nudge, and caregiver household round.
//
// Every profile, item, and chat id below is synthetic.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db, today } from "@/lib/db";
import {
  getProfileSetting,
  getTimezone,
  getTravelSwitches,
  setProfileHouseholdRound,
  setProfileSetting,
  setTelegramBotConfig,
  setTimezone,
  setProfileTimezoneFromSettings,
  switchProfileTimezone,
} from "@/lib/settings";
import { tickProfile } from "@/lib/notifications/tick";
import { buildIntakeReminderForSlots } from "@/lib/notifications/intake";
import { buildFoodNudge } from "@/lib/notifications/food";
import {
  buildHouseholdRound,
  householdRoundMarkerKey,
} from "@/lib/notifications/household-round";
import {
  foodNudgeMarkerKey,
  intakeSlotMarkerKey,
} from "@/lib/notifications/send-markers";
import { sendMessageRaw } from "@/lib/notifications/telegram-api";
import type { NotificationMessage } from "@/lib/notifications/types";
import { seedLoginTelegram } from "./fixtures";
import { stubTelegramSends } from "./telegram-spies";
import {
  isReminderSlotExcused,
  travelExcusalResolver,
} from "@/lib/travel-excusal";
import { isRepeatedSlot, resolveSwitchHistory } from "@/lib/travel-timezone";

const HONOLULU = "Pacific/Honolulu";
const LOS_ANGELES = "America/Los_Angeles";
const NEW_YORK = "America/New_York";
const TOKYO = "Asia/Tokyo";
const ATHENS = "Europe/Athens";
const PARIS = "Europe/Paris";
const MIDDAY_MINUTE = 12 * 60;
const AFTERNOON_MINUTE = 15 * 60;
const DAY = "2026-06-17";

beforeAll(() => stubTelegramSends());

const sendMock = vi.mocked(sendMessageRaw);

function profile(name: string, timezone: string): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(profileId, timezone);
  return profileId;
}

function dose(profileId: number, name: string): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should')`
      )
      .run(profileId, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses
       (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'Midday', 'any', 0)`
  ).run(itemId);
}

interface Scenario {
  receiver: number;
  chatId: string;
}

function scenario(tag: string, timezone: string): Scenario {
  const receiver = profile(`${tag} Receiver`, timezone);
  const member = profile(`${tag} Member`, timezone);
  dose(receiver, `${tag} own dose`);
  dose(member, `${tag} member dose`);

  const chatId = `5553685${receiver}`;
  const loginId = seedLoginTelegram(receiver, chatId, {
    username: `travel_tick_${tag}_${receiver}`,
  });
  db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
    receiver,
    loginId
  );
  db.prepare(
    `INSERT INTO login_profiles (login_id, profile_id, access)
     VALUES (?, ?, 'write')`
  ).run(loginId, member);

  setTelegramBotConfig({
    telegramBotToken: "travel-tick-token",
    telegramMode: "poll",
  });
  setProfileSetting(receiver, "food_telegram_enabled", "1");
  setProfileSetting(receiver, "notify_supp_morning_hour", "");
  setProfileSetting(receiver, "notify_supp_midday_hour", "12:00");
  setProfileSetting(receiver, "notify_supp_evening_hour", "");
  setProfileSetting(receiver, "notify_supp_bedtime_hour", "");
  setProfileSetting(receiver, "notify_digest_hour", "");
  setProfileHouseholdRound(receiver, {
    enabled: true,
    memberIds: [member],
  });
  return { receiver, chatId };
}

function sentTo(chatId: string): NotificationMessage[] {
  return sendMock.mock.calls
    .filter((call) => String(call[0]) === chatId)
    .map((call) => call[1] as NotificationMessage)
    .filter((message) => message.kind === "dose" || message.kind === "food");
}

function expectThreeSlotMessages(messages: NotificationMessage[]): void {
  expect(messages.map((message) => message.kind).sort()).toEqual([
    "dose",
    "dose",
    "food",
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-17T18:00:00Z"));
  sendMock.mockClear();
});

afterEach(() => vi.useRealTimers());

describe("travel excusal at the real notification tick", () => {
  it("keeps an empty-history control live, then silences an eastward-skipped retry band", async () => {
    vi.setSystemTime(new Date("2026-06-16T22:00:00Z")); // Honolulu 12:00
    const east = scenario("east", HONOLULU);

    // Every builder is genuinely live for THIS profile before travel, and the
    // empty-history path goes through the production tick unchanged.
    expect(getTravelSwitches(east.receiver)).toEqual([]);
    expect(
      buildIntakeReminderForSlots(east.receiver, ["Midday"])
    ).not.toBeNull();
    expect(
      buildFoodNudge(east.receiver, "Midday", today(east.receiver))
    ).not.toBeNull();
    expect(buildHouseholdRound(east.receiver, ["Midday"])).not.toBeNull();
    await tickProfile(east.receiver, "east-control", 5, Date.now());
    expectThreeSlotMessages(sentTo(east.chatId));

    sendMock.mockClear();
    vi.setSystemTime(new Date("2026-06-17T19:45:00Z"));
    // Honolulu 09:45 → Los Angeles 12:45. Midday never occurred, but 13:00
    // remains `slotDue` through the retry band that used to resurrect it.
    switchProfileTimezone(east.receiver, LOS_ANGELES, HONOLULU);
    const switches = resolveSwitchHistory(getTravelSwitches(east.receiver));
    expect(isReminderSlotExcused(switches, DAY, MIDDAY_MINUTE)).toBe(true);

    vi.setSystemTime(new Date("2026-06-17T20:00:00Z")); // Los Angeles 13:00
    await tickProfile(east.receiver, "east", 5, Date.now());
    expect(sentTo(east.chatId)).toEqual([]);
    expect(
      getProfileSetting(east.receiver, intakeSlotMarkerKey("Midday"))
    ).toBe("2026-06-16");
    expect(getProfileSetting(east.receiver, foodNudgeMarkerKey("Midday"))).toBe(
      "2026-06-16"
    );
    expect(
      getProfileSetting(east.receiver, householdRoundMarkerKey("Midday"))
    ).toBe("2026-06-16");
  });

  it("keeps a westward-repeated slot due exactly once through its markers", async () => {
    vi.setSystemTime(new Date("2026-06-17T19:45:00Z"));
    const west = scenario("west", LOS_ANGELES);
    // Los Angeles 12:45 → Honolulu 09:45 repeats Midday instead of skipping it.
    switchProfileTimezone(west.receiver, HONOLULU, LOS_ANGELES);
    const switches = resolveSwitchHistory(getTravelSwitches(west.receiver));
    expect(isRepeatedSlot(switches, DAY, MIDDAY_MINUTE)).toBe(true);
    expect(isReminderSlotExcused(switches, DAY, MIDDAY_MINUTE)).toBe(false);

    vi.setSystemTime(new Date("2026-06-17T22:00:00Z")); // Honolulu 12:00
    await tickProfile(west.receiver, "west", 5, Date.now());
    expectThreeSlotMessages(sentTo(west.chatId));
    await tickProfile(west.receiver, "west", 5, Date.now());
    expectThreeSlotMessages(sentTo(west.chatId));
  });

  it("re-arms a skipped slot when a reverse switch makes it occur later that day", async () => {
    const roundTrip = scenario("round-trip", NEW_YORK);
    vi.setSystemTime(new Date("2026-05-01T14:00:00Z")); // New York 10:00
    switchProfileTimezone(roundTrip.receiver, TOKYO, NEW_YORK); // Tokyo 23:00
    vi.setSystemTime(new Date("2026-05-01T14:01:00Z")); // Tokyo 23:01
    switchProfileTimezone(roundTrip.receiver, NEW_YORK, null); // New York 10:01

    const switches = resolveSwitchHistory(
      getTravelSwitches(roundTrip.receiver)
    );
    expect(isReminderSlotExcused(switches, "2026-05-01", MIDDAY_MINUTE)).toBe(
      false
    );
    expect(isRepeatedSlot(switches, "2026-05-01", MIDDAY_MINUTE)).toBe(false);

    vi.setSystemTime(new Date("2026-05-01T16:00:00Z")); // New York 12:00
    await tickProfile(roundTrip.receiver, "round-trip", 5, Date.now());
    expectThreeSlotMessages(sentTo(roundTrip.chatId));
  });

  it("re-arms the real noon slot when Settings returns an active trip home", async () => {
    const settingsReturn = scenario("settings-return", NEW_YORK);
    vi.setSystemTime(new Date("2026-05-01T14:00:00Z")); // New York 10:00
    switchProfileTimezone(settingsReturn.receiver, TOKYO, NEW_YORK);
    vi.setSystemTime(new Date("2026-05-01T14:01:00Z")); // Tokyo 23:01
    setProfileTimezoneFromSettings(settingsReturn.receiver, NEW_YORK);

    const switches = resolveSwitchHistory(
      getTravelSwitches(settingsReturn.receiver)
    );
    expect(isReminderSlotExcused(switches, "2026-05-01", MIDDAY_MINUTE)).toBe(
      false
    );

    vi.setSystemTime(new Date("2026-05-01T16:00:00Z")); // New York 12:00
    await tickProfile(
      settingsReturn.receiver,
      "settings-return",
      5,
      Date.now()
    );
    expectThreeSlotMessages(sentTo(settingsReturn.chatId));
  });

  it("fails open when an unrecorded correction disconnects retained history", async () => {
    const disconnected = scenario("disconnected", NEW_YORK);
    setProfileSetting(
      disconnected.receiver,
      "notify_supp_midday_hour",
      "15:00"
    );

    vi.setSystemTime(new Date("2026-05-01T10:00:00Z")); // New York 06:00
    switchProfileTimezone(disconnected.receiver, ATHENS, NEW_YORK); // Athens 13:00
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z")); // Athens 15:00
    setTimezone(disconnected.receiver, PARIS); // legacy/bare correction: Paris 14:00
    vi.setSystemTime(new Date("2026-05-01T12:01:00Z")); // Paris 14:01
    switchProfileTimezone(disconnected.receiver, ATHENS, NEW_YORK); // Athens 15:01

    // The retained suffix alone appears to skip 15:00, but the unrecorded
    // Athens→Paris seam made it occur. Both production consumers must fail open.
    const switches = resolveSwitchHistory(
      getTravelSwitches(disconnected.receiver)
    );
    expect(
      isReminderSlotExcused(switches, "2026-05-01", AFTERNOON_MINUTE)
    ).toBe(false);
    expect(
      travelExcusalResolver(disconnected.receiver)("Midday", "2026-05-01")
    ).toBe(false);

    await tickProfile(disconnected.receiver, "disconnected", 5, Date.now());
    expectThreeSlotMessages(sentTo(disconnected.chatId));
  });

  it("anchors the retained history on the profile's CURRENT zone", async () => {
    const anchored = scenario("anchored", NEW_YORK);

    vi.setSystemTime(new Date("2026-05-01T10:00:00Z")); // New York 06:00
    switchProfileTimezone(anchored.receiver, ATHENS, NEW_YORK); // Athens 13:00
    vi.setSystemTime(new Date("2026-05-01T10:01:00Z")); // Athens 13:01
    setTimezone(anchored.receiver, PARIS); // bare correction: Paris 12:01

    // Read on its own, the single retained record anchors on its OWN destination and
    // reads as a clean 06:00 → 13:00 skip over Midday. But the profile's day is on
    // Paris, so that chain does not end where the profile is, and the seam that took
    // it to Paris was never recorded. The current zone is what both consumers anchor
    // on, and it is what rejects the history whole.
    expect(getTravelSwitches(anchored.receiver).at(-1)?.to).toBe(ATHENS);
    expect(getTimezone(anchored.receiver)).toBe(PARIS);
    expect(
      isReminderSlotExcused(
        resolveSwitchHistory(
          getTravelSwitches(anchored.receiver),
          getTimezone(anchored.receiver)
        ),
        "2026-05-01",
        MIDDAY_MINUTE
      )
    ).toBe(false);
    expect(
      travelExcusalResolver(anchored.receiver)("Midday", "2026-05-01")
    ).toBe(false);

    vi.setSystemTime(new Date("2026-05-01T10:03:00Z")); // Paris 12:03
    await tickProfile(anchored.receiver, "anchored", 5, Date.now());
    expectThreeSlotMessages(sentTo(anchored.chatId));
  });

  it("keeps malformed history quarantined through a later real switch", async () => {
    const malformed = scenario("malformed", ATHENS);
    setProfileSetting(malformed.receiver, "notify_supp_midday_hour", "15:00");
    const malformedHistory = JSON.stringify([
      { at: "2026-05-01T12:00:00Z", from: ATHENS },
    ]);
    setProfileSetting(
      malformed.receiver,
      "timezone_switches",
      malformedHistory
    );
    setTimezone(malformed.receiver, PARIS); // malformed seam landed here

    vi.setSystemTime(new Date("2026-05-01T12:01:00Z")); // Paris 14:01
    switchProfileTimezone(malformed.receiver, ATHENS, null); // Athens 15:01

    // Parsing malformed storage as [] and appending the real switch would leave a
    // trusted Paris 14:01 → Athens 15:01 crossing and falsely suppress 15:00.
    expect(getProfileSetting(malformed.receiver, "timezone_switches")).toBe(
      malformedHistory
    );
    expect(getTravelSwitches(malformed.receiver)).toEqual([]);
    expect(
      travelExcusalResolver(malformed.receiver)("Midday", "2026-05-01")
    ).toBe(false);

    await tickProfile(malformed.receiver, "malformed", 5, Date.now());
    expectThreeSlotMessages(sentTo(malformed.chatId));
  });

  it("does not launder a well-shaped invalid row while appending", async () => {
    const invalid = scenario("invalid-date", ATHENS);
    setProfileSetting(invalid.receiver, "notify_supp_midday_hour", "15:00");
    const invalidHistory = JSON.stringify([
      { at: "not-an-instant", from: ATHENS, to: PARIS },
    ]);
    setProfileSetting(invalid.receiver, "timezone_switches", invalidHistory);
    setTimezone(invalid.receiver, PARIS);

    vi.setSystemTime(new Date("2026-05-01T12:01:00Z")); // Paris 14:01
    switchProfileTimezone(invalid.receiver, ATHENS, null); // Athens 15:01

    // appendTimezoneSwitch prunes invalid instants. The writer must reject the
    // history before append or this becomes a clean Paris→Athens skip.
    expect(getProfileSetting(invalid.receiver, "timezone_switches")).toBe(
      invalidHistory
    );
    expect(
      isReminderSlotExcused(
        resolveSwitchHistory(getTravelSwitches(invalid.receiver)),
        "2026-05-01",
        AFTERNOON_MINUTE
      )
    ).toBe(false);
    expect(
      travelExcusalResolver(invalid.receiver)("Midday", "2026-05-01")
    ).toBe(false);

    await tickProfile(invalid.receiver, "invalid-date", 5, Date.now());
    expectThreeSlotMessages(sentTo(invalid.chatId));
  });
});
