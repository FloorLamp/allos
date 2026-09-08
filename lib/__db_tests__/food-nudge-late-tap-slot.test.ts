// A late Telegram tap records its eating instant without asserting the nudge's meal slot.
// Real callbacks and rendering run against the database; only Telegram transport is stubbed.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import { utcInstant } from "@/lib/date";
import {
  currentFoodSlot,
  getFoodMealDays,
  getFoodServingsOnDate,
  getFoodBarOrder,
} from "@/lib/queries";
import { type FoodSlot } from "@/lib/food-slot";

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

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
beforeAll(() => stubTelegramSends());

// Per-window tallies through the meal grouping the web surface renders
// (getFoodMealDays.slotCounts) — the live consumer of the window derivation, standing
// where the retired slot-count query (getFoodSlotServingsOnDate, #2019/#2227) used to.
function slotServingsOnDate(
  profileId: number,
  window: FoodSlot,
  date: string
): Map<string, number> {
  const [day] = getFoodMealDays(profileId, [date]);
  return new Map(Object.entries(day.slotCounts[window]));
}

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

// The stored occurred_at values for one group on one day, in insert order.
function storedEatenAt(
  profileId: number,
  date: string,
  group: string
): (string | null)[] {
  return (
    db
      .prepare(
        `SELECT occurred_at FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = ?
          ORDER BY id`
      )
      .all(profileId, date, group) as { occurred_at: string | null }[]
  ).map((r) => r.occurred_at);
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

  it("records the eating instant and keeps the serving button available", async () => {
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
    expect(slotServingsOnDate(p.profileId, "Midday", t).get("berries")).toBe(1);
    expect(
      slotServingsOnDate(p.profileId, NUDGE_WINDOW, t).get("berries")
    ).toBeUndefined();

    // The button continues to offer one serving.
    expect(rebuiltFoodButtonLabel("berries")).toBe("🫐 Berries");
  });

  it("leaves the DAY tally alone — logging was always right, only the count disagreed", () => {
    // One serving on the day, regardless of which window it belongs to.
    expect(getFoodServingsOnDate(p.profileId, t).get("berries")).toBe(1);
  });

  it("the #950 ranking ranks it by PROXIMITY to when it was eaten (#2019)", () => {
    // A control serving eaten at 07:00 — right on the Morning anchor, far from Midday.
    logFoodServingCore(p.profileId, "eggs", t, "page", `${t}T07:00:00Z`, {
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

  it("a second tap on the same stale nudge records another serving", async () => {
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
    expect(rebuiltFoodButtonLabel("berries")).toBe("🫐 Berries");
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
    // computable from this ledger.
    expect(storedSlots(p.profileId, t, PROTEIN_NUDGE_KEY)).toEqual([null]);
    expect(storedEatenAt(p.profileId, t, PROTEIN_NUDGE_KEY)).toEqual([
      utcInstant(new Date(FROZEN)),
    ]);
  });
});
