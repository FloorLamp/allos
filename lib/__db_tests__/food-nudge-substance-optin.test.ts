// DB INTEGRATION TIER — the per-profile SUBSTANCE-content gate on Telegram (#3330,
// #3279 ruling 4), driven through the real senders.
//
// THE DEFECT, AND WHY THE PROOF HAS TO SEND. Alcohol is the one food group whose
// `food_daily_totals` counter IS the substance ledger, so it reaches the food nudge
// through the ordinary ranking — a "🍷 Alcohol" button and a "🍷 Alcohol ×2" tally line
// in a chat message, off-device, with no per-profile choice anywhere. Every case below
// therefore renders through a REAL sender (the proactive tick, the `/food` reply) or
// through the builder each of those calls, rather than asserting a predicate: the
// question is what leaves, not what a helper returns.
//
// Ported to origin/main with the opt-in read removed, the `false` rows of the table
// below FAIL — which is the statement that the ungated send is reachable today.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  setTimezone,
  setProfileSetting,
  setTelegramBotConfig,
} from "@/lib/settings";
import { setProfileSubstanceTelegram } from "@/lib/settings/notifications";
import { buildFoodNudge } from "@/lib/notifications/food";
import { buildIntakeReminder } from "@/lib/notifications/intake";
import { tickProfile } from "@/lib/notifications/tick";
import { handleIncomingMessage } from "@/lib/notifications/telegram-quick-log";
import { sendMessageRaw } from "@/lib/notifications/telegram-api";
import { plainBody } from "@/lib/notifications/rich-text";
import { ALCOHOL_FOOD_GROUP } from "@/lib/substance-use";
import { seedLoginTelegram, seedProfile } from "./fixtures";
import type { NotificationMessage } from "@/lib/notifications/types";

beforeAll(() => stubTelegramSends());
const sendMock = vi.mocked(sendMessageRaw);

// A day's tap on a group, on both ledgers the ranking reads.
function pastTap(profileId: number, group: string, date: string) {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at, logged_via)
     VALUES (?, ?, ?, ?, 'page')`
  ).run(profileId, group, date, `${date}T08:00:00Z`);
}

// A profile that drinks: three weeks of alcohol beside one ordinary staple, so alcohol
// ranks INSIDE the compact six buttons rather than in the tail, and two servings today
// so it also earns a tally entry. Telegram is fully wired and food logging is on — the
// consent this issue is about is the one that is NOT yet given.
function seedDrinker(tag: string, chatId: string): number {
  const { profileId } = seedProfile(tag);
  setTimezone(profileId, "UTC");
  seedLoginTelegram(profileId, chatId);
  setTelegramBotConfig({
    telegramBotToken: "bot token 33301",
    telegramMode: "poll",
  });
  setProfileSetting(profileId, "food_telegram_enabled", "1");
  setProfileSetting(profileId, "notify_supp_morning_hour", "08:00");
  for (const k of [
    "notify_supp_midday_hour",
    "notify_supp_evening_hour",
    "notify_supp_bedtime_hour",
    "notify_digest_hour",
  ])
    setProfileSetting(profileId, k, "");
  const anchor = today(profileId);
  for (let d = 1; d <= 21; d++)
    for (const g of [ALCOHOL_FOOD_GROUP, "leafy_greens"])
      pastTap(profileId, g, shiftDateStr(anchor, -d));
  pastTap(profileId, ALCOHOL_FOOD_GROUP, anchor);
  pastTap(profileId, ALCOHOL_FOOD_GROUP, anchor);
  pastTap(profileId, "leafy_greens", anchor);
  return profileId;
}

// What a delivered message says about substances: a button that logs one, and the tally
// line that names one. Both are reach; either one alone would make "off" a redaction.
function alcoholReach(msg: NotificationMessage | null) {
  const actions = msg?.actions ?? [];
  return {
    button: actions.some((a) => a.data?.endsWith(`:${ALCOHOL_FOOD_GROUP}`)),
    tally: plainBody(msg?.body ?? "").includes("Alcohol"),
    otherFood: actions.some((a) => a.data?.includes(":leafy_greens")),
  };
}

function foodMessagesTo(chatId: string): NotificationMessage[] {
  return sendMock.mock.calls
    .filter((c) => String(c[0]) === chatId)
    .map((c) => c[1] as NotificationMessage)
    .filter((m) => m.kind === "food");
}

describe("substance content reaches Telegram only after this profile opts in (#3330)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T08:00:00Z"));
    sendMock.mockClear();
  });

  // THE TABLE: every Telegram surface that can carry the substance ledger × the two
  // states of the opt-in. The three surfaces are three different senders — the
  // unbidden tick, the user-typed `/food`, and a fully expanded keyboard (a rebuild
  // asks for more buttons than the compact six, so a gate that only trimmed the
  // visible head would leak here) — and they agree because they share one gather.
  const SURFACES = [
    "proactive tick send",
    "/food command reply",
    "fully expanded keyboard",
  ] as const;
  type Surface = (typeof SURFACES)[number];

  async function render(
    surface: Surface,
    profileId: number,
    chatId: string
  ): Promise<NotificationMessage | null> {
    switch (surface) {
      case "proactive tick send":
        await tickProfile(profileId, `p${profileId}`, 5, Date.now());
        return foodMessagesTo(chatId).at(-1) ?? null;
      case "/food command reply":
        await handleIncomingMessage({
          message_id: 1,
          chat: { id: chatId },
          text: "/food",
        });
        return foodMessagesTo(chatId).at(-1) ?? null;
      case "fully expanded keyboard":
        // Past the catalog size on purpose: every ranked key renders.
        return buildFoodNudge(profileId, "Morning", today(profileId), 99);
    }
  }

  it.each(
    SURFACES.flatMap((surface, s) =>
      [false, true].map((optIn, o) => ({
        surface,
        optIn,
        chatId: `55933${s}${o}`,
      }))
    )
  )(
    "$surface with the opt-in $optIn carries alcohol: $optIn",
    async ({ surface, optIn, chatId }) => {
      const profileId = seedDrinker(`SUB3330-${surface}-${optIn}`, chatId);
      setProfileSubstanceTelegram(profileId, optIn);

      const msg = await render(surface, profileId, chatId);
      expect(msg, "no food nudge was produced at all").not.toBeNull();
      const reach = alcoholReach(msg);
      expect(reach.button).toBe(optIn);
      expect(reach.tally).toBe(optIn);
      // NOT A SUPPRESSION: the message still goes, and still carries the food this
      // profile logs. An opt-out that silenced the nudge would be a different bug.
      expect(reach.otherFood).toBe(true);
    }
  );

  it("is per PROFILE, not per chat: one login's two subjects answer separately", async () => {
    const chatId = "5593390";
    const drinkerOptedIn = seedDrinker("SUB3330-house-A", chatId);
    const drinkerOptedOut = seedDrinker("SUB3330-house-B", chatId);
    setProfileSubstanceTelegram(drinkerOptedIn, true);
    // drinkerOptedOut is left at the default, which is the state that matters.

    await tickProfile(drinkerOptedIn, "house-A", 5, Date.now());
    await tickProfile(drinkerOptedOut, "house-B", 5, Date.now());

    const [first, second] = foodMessagesTo(chatId);
    expect(alcoholReach(first).button).toBe(true);
    expect(alcoholReach(second).button).toBe(false);
    expect(alcoholReach(second).tally).toBe(false);
  });

  // THE OTHER FAILURE. A gate on a notification path can silence a safety signal as
  // easily as it can stop a leak, so the dose reminder — which shares this profile, this
  // chat and this slot — is rendered in BOTH states and compared. It is not merely
  // "still sent": it is identical, tail and all, so the medication food-interaction
  // guidance that legitimately names alcohol survives a substance opt-out.
  it.each([
    ["dose reminder", (p: number) => buildIntakeReminder(p, "Morning")],
  ])("%s is byte-identical either side of the opt-in", (_label, build) => {
    const profileId = seedDrinker("SUB3330-safety", "5593391");
    setProfileSubstanceTelegram(profileId, false);
    const off = build(profileId);
    setProfileSubstanceTelegram(profileId, true);
    const on = build(profileId);
    expect(off).not.toBeNull();
    expect(off).toEqual(on);
  });
});
