// DB INTEGRATION TIER — #1704, as #2019 re-settled it: a Telegram food tap keeps its "(n)"
// button count even when the tap lands OUTSIDE the nudge's own window.
//
// THE SYMPTOM IS THE SAME; THE MECHANISM CHANGED, AND THE OLD ONE IS GONE. The nudge bakes
// its window into every callback token at SEND time. Originally the rebuild asked
// getFoodSlotServingsOnDate for THAT window while the event's own window was re-derived
// from the tap instant, so opening the morning nudge at lunch rendered n = 0. #1704 fixed
// that by writing the token's window onto the row as an explicit `meal_slot`.
//
// #2019 REVERSED that write: the nudge's window is the NUDGE naming itself, not the user
// declaring a meal, and with a real `eaten_at` on the row the meal is derived from when the
// serving was eaten (so a later correction MOVES it, which a frozen assertion would not).
// The suffix became the DAY total in the same change — a number the ledger can always
// answer, with no window derivation anywhere in it. So the reported symptom stays fixed,
// and this file pins the new mechanism as well as the guarantee.
//
// Driven end-to-end through handleCallbackQuery against the REAL query layer, with only
// the raw Telegram transport stubbed (the #454 guarded boundary), so the rebuilt keyboard
// asserted here is the genuine rendered output. The clock is FROZEN, and the nudge's window
// is chosen to DISAGREE with the tap instant's — that mismatch is the whole point.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    sendMessageRaw: vi.fn(async () => {}),
  };
});

import { db, today } from "@/lib/db";
import { utcInstant } from "@/lib/date";
import {
  currentFoodSlot,
  getFoodServingsOnDate,
  getFoodSlotServingsOnDate,
  getFoodBarOrder,
} from "@/lib/queries";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  foodLogCallbackData,
  foodProteinCallbackData,
  type FoodNudgeWindow,
} from "@/lib/notifications/food-format";
import { editMessageTextRaw } from "@/lib/notifications/telegram-api";
import { logFoodServingCore } from "@/lib/food-log-write";
import { PROTEIN_NUDGE_KEY } from "@/lib/protein-nudge";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

const editTextMock = vi.mocked(editMessageTextRaw);

function lastRebuiltKeyboard():
  { text?: string; callback_data?: string }[][] | undefined {
  const call = editTextMock.mock.calls.at(-1);
  const opts = call?.[3] as {
    keyboard?: { text?: string; callback_data?: string }[][];
  };
  return opts?.keyboard;
}

// The rendered TEXT of the rebuilt button whose callback_data names `slug`.
function rebuiltFoodButtonLabel(slug: string): string | undefined {
  for (const row of lastRebuiltKeyboard() ?? []) {
    for (const b of row) {
      if (
        b.callback_data?.startsWith("food:") &&
        b.callback_data.endsWith(`:${slug}`)
      )
        return b.text;
    }
  }
  return undefined;
}

function rebuiltProteinButtonLabel(): string | undefined {
  for (const row of lastRebuiltKeyboard() ?? []) {
    for (const b of row) {
      if (b.callback_data?.startsWith("foodprotein:")) return b.text;
    }
  }
  return undefined;
}

// A cq whose incoming keyboard carries food-log buttons for `window` — the stale nudge
// the user is tapping. Its window is the TOKEN's window, deliberately not the tap's.
function cqForWindow(
  data: string,
  chatId: string,
  profileId: number,
  window: FoodNudgeWindow,
  date: string
) {
  const slugs = [
    "leafy_greens",
    "berries",
    "fatty_fish",
    "poultry",
    "eggs",
    "nuts_seeds",
    "whole_grains",
    "legumes",
    "dairy",
    "tubers",
    "fruit",
    "other_vegetables",
  ];
  const rows = slugs.map((s) => [
    {
      text: s,
      callback_data: foodLogCallbackData(profileId, window, date, s),
    },
  ]);
  return {
    id: "cbq-late-tap",
    data,
    message: {
      message_id: 77,
      chat: { id: chatId },
      reply_markup: { inline_keyboard: rows },
    },
  };
}

// The stored eaten_at values for one group on one day, in insert order.
function storedEatenAt(
  profileId: number,
  date: string,
  group: string
): (string | null)[] {
  return (
    db
      .prepare(
        `SELECT eaten_at FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = ?
          ORDER BY id`
      )
      .all(profileId, date, group) as { eaten_at: string | null }[]
  ).map((r) => r.eaten_at);
}

// The stored meal_slot values for one group on one day, in insert order.
function storedSlots(
  profileId: number,
  date: string,
  group: string
): (string | null)[] {
  return (
    db
      .prepare(
        `SELECT meal_slot FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = ?
          ORDER BY id`
      )
      .all(profileId, date, group) as { meal_slot: string | null }[]
  ).map((r) => r.meal_slot);
}

const CHAT = "5550704";
// 12:30 UTC on a UTC profile → the tap derives MIDDAY under the default 11:00/15:00
// boundaries. The nudge under test carries MORNING, so the token's window and the tap's
// window genuinely disagree — the exact #1704 shape.
const FROZEN = "2026-07-15T12:30:00Z";
const NUDGE_WINDOW: FoodNudgeWindow = "Morning";

let p: SeededProfile;
let t: string;
let priorTestNow: string | undefined;

beforeAll(() => {
  priorTestNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = FROZEN;
  p = seedProfile("food-late-tap");
  t = today(p.profileId);
  seedLoginTelegram(p.profileId, CHAT);
});

afterAll(() => {
  if (priorTestNow === undefined) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorTestNow;
});

describe("a Telegram food tap outside the nudge's window (#1704)", () => {
  it("guards the premise: the tap instant derives a DIFFERENT window than the nudge", () => {
    expect(currentFoodSlot(p.profileId)).not.toBe(NUDGE_WINDOW);
  });

  it("renders (1) on the tapped button, from the DAY total rather than a window", async () => {
    editTextMock.mockClear();
    await handleCallbackQuery(
      cqForWindow(
        foodLogCallbackData(p.profileId, NUDGE_WINDOW, t, "berries"),
        CHAT,
        p.profileId,
        NUDGE_WINDOW,
        t
      )
    );

    // The event asserts NO meal (#2019): the nudge's window rides the token for message
    // identity only. What it carries instead is the eating instant the tap measured.
    expect(storedSlots(p.profileId, t, "berries")).toEqual([null]);
    expect(storedEatenAt(p.profileId, t, "berries")).toEqual([
      utcInstant(new Date(FROZEN)),
    ]);
    // The window a reader derives for it is the one it was EATEN in — Midday, honestly,
    // rather than the Morning the nudge happened to be titled.
    expect(
      getFoodSlotServingsOnDate(p.profileId, "Midday", t).get("berries")
    ).toBe(1);
    expect(
      getFoodSlotServingsOnDate(p.profileId, NUDGE_WINDOW, t).get("berries")
    ).toBeUndefined();

    // And the button carries its count regardless — the reported symptom, fixed by a
    // count that never asks which window the serving belongs to.
    expect(rebuiltFoodButtonLabel("berries")).toBe("🫐 Berries (1)");
  });

  it("leaves the DAY tally alone — logging was always right, only the count disagreed", () => {
    // One serving on the day, regardless of which window it belongs to.
    expect(getFoodServingsOnDate(p.profileId, t).get("berries")).toBe(1);
  });

  it("the #950 ranking ranks it by PROXIMITY to when it was eaten (#2019)", () => {
    // A control serving eaten at 07:00 — right on the Morning anchor, far from Midday.
    logFoodServingCore(p.profileId, "eggs", t, `${t}T07:00:00Z`, undefined, {
      eatenAt: `${t}T07:00:00Z`,
      source: "tap",
    });
    // Ranking no longer asks which bucket an event fell in; it weights every tap by how
    // near its EATING minute sits to the window's anchor. So the 12:30 berries lead the
    // midday nudge and the 07:00 eggs lead the morning one …
    expect(getFoodBarOrder(p.profileId, "Midday").groups[0].slug).toBe(
      "berries"
    );
    expect(getFoodBarOrder(p.profileId, "Morning").groups[0].slug).toBe("eggs");
    // … whereas under the retired mechanism the berries carried the nudge's own Morning
    // window on the row and would have led there instead.
  });

  it("a second tap on the same stale nudge ticks the count to (2)", async () => {
    editTextMock.mockClear();
    await handleCallbackQuery(
      cqForWindow(
        foodLogCallbackData(p.profileId, NUDGE_WINDOW, t, "berries"),
        CHAT,
        p.profileId,
        NUDGE_WINDOW,
        t
      )
    );
    expect(rebuiltFoodButtonLabel("berries")).toBe("🫐 Berries (2)");
    expect(storedSlots(p.profileId, t, "berries")).toEqual([null, null]);
  });

  it("the protein sibling records the same way (#1073/#1379)", async () => {
    editTextMock.mockClear();
    await handleCallbackQuery(
      cqForWindow(
        foodProteinCallbackData(p.profileId, NUDGE_WINDOW, t, 30),
        CHAT,
        p.profileId,
        NUDGE_WINDOW,
        t
      )
    );
    // The reserved __protein__ row rides the identical columns: no asserted meal, and the
    // tap's own instant as the eating time — which is what makes protein DISTRIBUTION
    // computable from this ledger. Its BUTTON count is covered by
    // food-nudge-protein-slot-count.test.ts, on a nudge whose window is the current one.
    expect(storedSlots(p.profileId, t, PROTEIN_NUDGE_KEY)).toEqual([null]);
    expect(storedEatenAt(p.profileId, t, PROTEIN_NUDGE_KEY)).toEqual([
      utcInstant(new Date(FROZEN)),
    ]);
  });
});
