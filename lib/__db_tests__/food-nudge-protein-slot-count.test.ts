// DB INTEGRATION TIER — #1379: the food-nudge protein "+Xg" button carries the same "(n)"
// suffix as every food-group sibling (REVERSING the original #1073 no-suffix decision).
// Driven end-to-end through handleCallbackQuery against the REAL query layer, with only the
// raw Telegram transport stubbed (the #454 guarded boundary), so the REBUILT keyboard this
// test inspects is the genuine rendered output.
//
// #2019 changed what the number MEANS — every button's suffix is now the DAY total, since
// a Telegram tap no longer asserts a meal and "this slot" would have to be re-derived — but
// not that the protein button carries one. The count still comes off food_log_events, where
// the reserved __protein__ key lives (it never reaches the food_log day counter), so it is
// taps rather than grams; the day's grams stay on the nudge's protein line. The clock is
// FROZEN (ALLOS_TEST_NOW) so the tap lands on a deterministic day.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

// Stub the RAW transport, keeping the chokepoint (rebuildMessage) + render helpers REAL so
// the edited keyboard this test inspects is the genuine rendered output.

import { today } from "@/lib/db";
import { currentFoodSlot } from "@/lib/queries";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  foodLogCallbackData,
  foodProteinCallbackData,
  type FoodNudgeWindow,
} from "@/lib/notifications/food-format";
import { editMessageTextRaw } from "@/lib/notifications/telegram-api";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
beforeAll(() => stubTelegramSends());

const editTextMock = vi.mocked(editMessageTextRaw);

// The keyboard the last rebuild produced (rebuildMessage → editMessageTextRaw(…, {keyboard})),
// carrying each button's text + callback_data.
function lastRebuiltKeyboard():
  { text?: string; callback_data?: string }[][] | undefined {
  const call = editTextMock.mock.calls.at(-1);
  const opts = call?.[3] as {
    keyboard?: { text?: string; callback_data?: string }[][];
  };
  return opts?.keyboard;
}

// The rendered TEXT of the rebuilt protein "+Xg" button (its callback_data starts
// foodprotein:), or undefined when the button isn't on the keyboard.
function rebuiltProteinButtonLabel(): string | undefined {
  for (const row of lastRebuiltKeyboard() ?? []) {
    for (const b of row) {
      if (b.callback_data?.startsWith("foodprotein:")) return b.text;
    }
  }
  return undefined;
}

// A cq carrying `foodButtonCount` food-log buttons so the stateless count-from-keyboard
// derivation (#1075) reads the visible count off the incoming keyboard.
function cqWithFoodButtons(
  data: string,
  chatId: string,
  profileId: number,
  window: FoodNudgeWindow,
  date: string,
  foodButtonCount: number
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
  const rows = slugs.slice(0, foodButtonCount).map((s) => [
    {
      text: s,
      callback_data: foodLogCallbackData(profileId, window, date, s),
    },
  ]);
  return {
    id: "cbq-slot",
    data,
    message: {
      message_id: 91,
      chat: { id: chatId },
      reply_markup: { inline_keyboard: rows },
    },
  };
}

const CHAT = "5550780";
// A fixed instant so the tap's recorded_at buckets deterministically; the asserted window is
// derived from it, so the exact hour/timezone doesn't matter (see the file header).
const FROZEN = "2026-07-15T20:30:00Z";
let p: SeededProfile;
let t: string;
let slot: FoodNudgeWindow;
let priorTestNow: string | undefined;

beforeAll(() => {
  priorTestNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = FROZEN;
  p = seedProfile("food-nudge-slot");
  t = today(p.profileId);
  slot = currentFoodSlot(p.profileId) as FoodNudgeWindow;
  seedLoginTelegram(p.profileId, CHAT);
});

afterAll(() => {
  if (priorTestNow === undefined) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorTestNow;
});

describe("protein '+Xg' button (n) suffix (#1379, day-scoped since #2019)", () => {
  it("a protein tap → the rebuilt button carries (1); a second tap → (2)", async () => {
    editTextMock.mockClear();
    // First tap: log 30 g in this slot, then rebuild.
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodProteinCallbackData(p.profileId, slot, t, 30),
        CHAT,
        p.profileId,
        slot,
        t,
        12
      )
    );
    // The protein button is now on the rebuilt keyboard (the tap made the profile a protein
    // tracker) and carries the day count (1) — the exact sibling suffix, not a bare button.
    expect(rebuiltProteinButtonLabel()).toBe("💪 ＋30g protein (1)");

    // A second tap the same day → the count ticks to (2) immediately (the rebuild re-reads
    // the ledger, so a tap always acknowledges its own log).
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodProteinCallbackData(p.profileId, slot, t, 30),
        CHAT,
        p.profileId,
        slot,
        t,
        12
      )
    );
    expect(rebuiltProteinButtonLabel()).toBe("💪 ＋30g protein (2)");
  });
});
