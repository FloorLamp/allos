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
  getTravelSwitches,
  setProfileHouseholdRound,
  setProfileSetting,
  setTelegramBotConfig,
  setTimezone,
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
import { isReminderSlotExcused } from "@/lib/travel-excusal";
import { isRepeatedSlot } from "@/lib/travel-timezone";

const HONOLULU = "Pacific/Honolulu";
const LOS_ANGELES = "America/Los_Angeles";
const MIDDAY_MINUTE = 12 * 60;
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
    const switches = getTravelSwitches(east.receiver);
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
    const switches = getTravelSwitches(west.receiver);
    expect(isRepeatedSlot(switches, DAY, MIDDAY_MINUTE)).toBe(true);
    expect(isReminderSlotExcused(switches, DAY, MIDDAY_MINUTE)).toBe(false);

    vi.setSystemTime(new Date("2026-06-17T22:00:00Z")); // Honolulu 12:00
    await tickProfile(west.receiver, "west", 5, Date.now());
    expectThreeSlotMessages(sentTo(west.chatId));
    await tickProfile(west.receiver, "west", 5, Date.now());
    expectThreeSlotMessages(sentTo(west.chatId));
  });
});
