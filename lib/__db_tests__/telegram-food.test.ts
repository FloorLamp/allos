// DB INTEGRATION TIER — the food-logging Telegram buttons (issue #682) driven end-
// to-end through handleCallbackQuery against the REAL query/write layer, with only
// the Telegram network surface stubbed. Proves a quick-log tap logs one serving via
// the shared write core, an opt-in tap flips the per-profile flag, and a tap from an
// unmapped chat writes NOTHING. The pure parse/render half is covered in
// lib/__tests__/food-callback.test.ts + food-nudge.test.ts.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today, yesterday } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getProfileFoodTelegram,
  getProfilesByTelegramChatId,
} from "@/lib/settings";
import {
  getFoodRegularity,
  getFoodServingsOnDate,
  getUsualFoodOffer,
} from "@/lib/queries";
import { logFoodServingCore } from "@/lib/food-log-write";
import { USUAL_BACKFILL } from "@/lib/logged-via";
import { FOOD_REGULARITY_MIN_WINDOW_DAYS } from "@/lib/food-regularity";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { answerCallbackQuery } from "@/lib/notifications/telegram-api";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
beforeAll(() => stubTelegramSends());

const answerMock = vi.mocked(answerCallbackQuery);
const OWN_CHAT = "5550100";
const OTHER_CHAT = "5550299";

function cq(data: string, chatId: string) {
  return {
    id: "cbq-food",
    data,
    message: {
      message_id: 77,
      chat: { id: chatId },
      text: "🍽️ Morning food log",
      reply_markup: { inline_keyboard: [[{ text: "x", callback_data: data }]] },
    },
  };
}

function lastAnswer(): string | undefined {
  return answerMock.mock.calls.at(-1)?.[1];
}

let p: SeededProfile;
let t: string;

beforeAll(() => {
  p = seedProfile("tg-food");
  t = today(p.profileId);
  // Map the profile to a Telegram chat so inbound taps resolve to it.
  seedLoginTelegram(p.profileId, OWN_CHAT);
});

beforeEach(() => {
  answerMock.mockClear();
});

describe("food quick-log tap", () => {
  it("logs one serving and answers with the running count", async () => {
    expect(getProfilesByTelegramChatId(OWN_CHAT)).toContain(p.profileId);

    await handleCallbackQuery(
      cq(`food:${p.profileId}:Morning:${t}:leafy_greens`, OWN_CHAT)
    );
    await handleCallbackQuery(
      cq(`food:${p.profileId}:Morning:${t}:leafy_greens`, OWN_CHAT)
    );

    expect(getFoodServingsOnDate(p.profileId, t).get("leafy_greens")).toBe(2);
    expect(lastAnswer()).toContain("Leafy greens ×2");
  });

  it("writes nothing for a tap from an unmapped chat", async () => {
    await handleCallbackQuery(
      cq(`food:${p.profileId}:Midday:${t}:berries`, OTHER_CHAT)
    );
    expect(
      getFoodServingsOnDate(p.profileId, t).get("berries")
    ).toBeUndefined();
  });
});

describe("food quick-log cross-date guard (#947, windowed by #4118)", () => {
  // THE OWNER'S REPORTED PAIN, END TO END: "I can only update the morning supplement
  // times, not food." On a stale morning message the ✅ dose buttons kept working and
  // the food buttons did not. All three states are asserted here — in-window, the last
  // day in, the first day out — because the middle one is the whole fix and the outer
  // two are what keep it bounded.
  it("logs a tap on YESTERDAY's nudge ONTO YESTERDAY, with no invented eating time", async () => {
    const y = yesterday(p.profileId);
    await handleCallbackQuery(
      cq(`food:${p.profileId}:Evening:${y}:berries`, OWN_CHAT)
    );
    // The serving lands on the MESSAGE's day, not on today.
    expect(getFoodServingsOnDate(p.profileId, y).get("berries")).toBe(1);
    expect(
      getFoodServingsOnDate(p.profileId, t).get("berries")
    ).toBeUndefined();
    // …and the toast says WHICH day, so "×2 today" can never describe a day the
    // person is not standing in.
    expect(lastAnswer()).toContain("Logged ✅");
    expect(lastAnswer()).toContain(y);

    // NO EATING INSTANT WAS INVENTED. "I'm eating now" is false about a day that has
    // ended, so the row carries the nudge's declared window and a NULL occurred_at —
    // the same shape the `/history` door and the usual bundle write. A row stamped
    // `now` here would have had a day and an instant contradicting each other, and the
    // slot derivation would have filed it under whatever window the tap fell in.
    const row = db
      .prepare(
        `SELECT meal_slot, occurred_at, time_source FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = 'berries'`
      )
      .get(p.profileId, y) as {
      meal_slot: string | null;
      occurred_at: string | null;
      time_source: string | null;
    };
    expect(row).toEqual({
      meal_slot: "Evening",
      occurred_at: null,
      time_source: null,
    });
  });

  it("refuses a tap from OUTSIDE the window — writes nothing, answers honestly", async () => {
    // Three days back: the first day past `DOSE_LOG_DATE_WINDOW_DAYS`, so the pre-#4118
    // refusal still stands here and this is what the old yesterday-case became.
    const old = shiftDateStr(t, -3);
    await handleCallbackQuery(
      cq(`food:${p.profileId}:Evening:${old}:whole_grains`, OWN_CHAT)
    );
    expect(
      getFoodServingsOnDate(p.profileId, old).get("whole_grains")
    ).toBeUndefined();
    expect(
      getFoodServingsOnDate(p.profileId, t).get("whole_grains")
    ).toBeUndefined();
    // Honest answer, never a false confirm.
    expect(lastAnswer()).toContain(old);
    expect(lastAnswer()).not.toContain("Logged ✅");
  });

  it("still logs a same-day tap from an OLDER window, and STILL captures its instant", async () => {
    // A Morning-window token whose date is TODAY logs normally even if tapped later
    // in the day — only cross-DATE taps are re-dated, not cross-window. THE CONVERSE
    // OF THE BACKFILL ASSERTION ABOVE, and the reason it is here: a guard that only
    // proved "no instant on a backfill" would pass just as well if #2019's tap capture
    // had been dropped for every tap. The same-day tap must still record one.
    await handleCallbackQuery(
      cq(`food:${p.profileId}:Morning:${t}:legumes`, OWN_CHAT)
    );
    expect(getFoodServingsOnDate(p.profileId, t).get("legumes")).toBe(1);
    expect(lastAnswer()).toContain("Logged ✅");
    const row = db
      .prepare(
        `SELECT meal_slot, occurred_at, time_source FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = 'legumes'`
      )
      .get(p.profileId, t) as {
      meal_slot: string | null;
      occurred_at: string | null;
      time_source: string | null;
    };
    expect(row.time_source).toBe("tap");
    expect(row.occurred_at).not.toBeNull();
    expect(row.meal_slot).toBeNull();
  });
});

describe("food opt-in prompt tap", () => {
  it("Enable flips the flag on; No thanks flips it off", async () => {
    await handleCallbackQuery(cq(`foodoptin:${p.profileId}:yes`, OWN_CHAT));
    expect(getProfileFoodTelegram(p.profileId)).toBe(true);

    await handleCallbackQuery(cq(`foodoptin:${p.profileId}:no`, OWN_CHAT));
    expect(getProfileFoodTelegram(p.profileId)).toBe(false);
  });

  it("ignores an opt-in tap from an unmapped chat", async () => {
    await handleCallbackQuery(cq(`foodoptin:${p.profileId}:yes`, OTHER_CHAT));
    expect(getProfileFoodTelegram(p.profileId)).toBe(false);
  });
});

// ── A BACKFILLED TAP IS NOT EVIDENCE (#4118) ─────────────────────────────────
//
// The evidence guard exists so the composed `usual:` bundle cannot become the reason it
// is offered again. The food buttons sit on the SAME keyboard as that bundle and write
// the same ledger, so once #4118 let them land on a past day they became a second route
// into the loop: two taps on a stale keyboard, stamped with their surface, would count as
// a morning nobody logged and manufacture the offer.
//
// So the handler substitutes `usual-backfill` from the same date comparison the write
// core makes. Asserted end to end through the real dispatcher, in both directions and
// with the CONSEQUENCE — the offer — as the subject, because a stamp assertion alone
// would not show what the stamp is for.
describe("a food tap onto a past day cannot manufacture the habit it would offer", () => {
  // One morning short of the gate, with the target day empty: the only thing between
  // this profile and a standing usual offer is one more observed morning.
  //
  // EVERY WINDOW IS SEEDED, not just Morning, and the reason is the same-day case below.
  // A contemporaneous tap records its own instant as the eating time (#2019), so the
  // window it lands in is whatever the profile's clock says NOW is — which for a db test
  // is the hour the suite happens to run. Seeding one short in all three makes the
  // converse assertion deterministic at every run hour instead of green for eleven hours
  // a day, which is the shape #3260 was.
  function seedOneShort(tag: string, chat: string) {
    const sp = seedProfile(tag);
    seedLoginTelegram(sp.profileId, chat);
    const anchor = today(sp.profileId);
    for (let d = 2; d <= FOOD_REGULARITY_MIN_WINDOW_DAYS; d++) {
      const date = shiftDateStr(anchor, -d);
      for (const at of ["08:00:00", "12:00:00", "19:00:00"])
        for (const g of ["berries", "fermented"])
          logFoodServingCore(sp.profileId, g, date, "page", `${date}T${at}Z`);
    }
    return { profileId: sp.profileId, anchor };
  }

  /** The windows the measure can currently speak about, and how many days each saw. */
  function observed(profileId: number): Record<string, number> {
    const measure = getFoodRegularity(profileId);
    return Object.fromEntries(
      Object.entries(measure)
        .filter(([, m]) => m != null)
        .map(([w, m]) => [w, m!.observedDays])
    );
  }

  it("stamps usual-backfill, and the offer it would have created does not appear", async () => {
    const chat = "5550401";
    const { profileId, anchor } = seedOneShort("tg-food-backfill", chat);
    const y = shiftDateStr(anchor, -1);
    // Every window is one morning short of the gate, so NOTHING can be offered yet.
    expect(observed(profileId)).toEqual({});

    for (const group of ["berries", "fermented"])
      await handleCallbackQuery(
        cq(`food:${profileId}:Morning:${y}:${group}`, chat)
      );

    // The servings really landed on that day — the guard must not be data loss.
    expect(getFoodServingsOnDate(profileId, y).get("berries")).toBe(1);
    expect(
      db
        .prepare(
          `SELECT DISTINCT logged_via FROM food_log_events
            WHERE profile_id = ? AND date = ?`
        )
        .all(profileId, y)
    ).toEqual([{ logged_via: USUAL_BACKFILL }]);
    // …and the measure cannot see them, so the seventh morning was never observed and
    // no offer stands anywhere. THIS is the assertion the stamp exists for.
    expect(observed(profileId)).toEqual({});
    for (const window of ["Morning", "Midday", "Evening"] as const)
      expect(getUsualFoodOffer(profileId, window, anchor)).toEqual([]);
  });

  it("a SAME-DAY tap still stamps its surface and still counts", async () => {
    // The converse on the same shape. A guard that stamped every Telegram tap
    // `usual-backfill` would satisfy the test above and would silently delete the
    // proactive nudge — the app's main food surface — from the evidence entirely.
    const chat = "5550402";
    const { profileId, anchor } = seedOneShort("tg-food-sameday", chat);
    for (const group of ["berries", "fermented"])
      await handleCallbackQuery(
        cq(`food:${profileId}:Morning:${anchor}:${group}`, chat)
      );

    expect(
      db
        .prepare(
          `SELECT DISTINCT logged_via FROM food_log_events
            WHERE profile_id = ? AND date = ?`
        )
        .all(profileId, anchor)
    ).toEqual([{ logged_via: "telegram-nudge" }]);
    // Exactly one window crossed the gate — whichever one the tap's own instant fell in
    // — and it saw the full count. The measure counted the tap, which is the whole
    // claim; WHICH window it was is the run hour's business, not this test's.
    const seen = observed(profileId);
    expect(Object.values(seen)).toEqual([FOOD_REGULARITY_MIN_WINDOW_DAYS]);
  });

  it("the protein button follows the same rule", async () => {
    // `__protein__` rides `food_log_events` too, so a backfilled shake is a row the
    // regularity read would otherwise count as a morning that was logged.
    const chat = "5550403";
    const { profileId, anchor } = seedOneShort(
      "tg-food-protein-backfill",
      chat
    );
    const y = shiftDateStr(anchor, -1);
    await handleCallbackQuery(
      cq(`foodprotein:${profileId}:Morning:${y}:30`, chat)
    );
    expect(
      db
        .prepare(
          `SELECT DISTINCT logged_via FROM food_log_events
            WHERE profile_id = ? AND date = ?`
        )
        .all(profileId, y)
    ).toEqual([{ logged_via: USUAL_BACKFILL }]);
  });
});
