// DB INTEGRATION TIER — #1704: a Telegram food tap keeps its slot-scoped "(n)" button
// count even when the tap lands OUTSIDE the nudge's own window.
//
// The nudge bakes its window into every callback token at SEND time, and the rebuild asks
// getFoodSlotServingsOnDate for THAT window. The handler used to log without the optional
// meal_slot, so the event's window was re-derived from the tap instant (foodEventWindow):
// open the morning nudge at lunch and the serving landed in Midday while the rebuild
// counted Morning — n = 0, no suffix, even though the serving logged correctly and showed
// in the day tally. The handler now passes the token's window as the explicit slot.
//
// Driven end-to-end through handleCallbackQuery against the REAL query layer, with only
// the raw Telegram transport stubbed (the #454 guarded boundary), so the rebuilt keyboard
// asserted here is the genuine rendered output. The clock is FROZEN so the tap instant
// derives a deterministic window, and the nudge's window is chosen to be a DIFFERENT one —
// that mismatch is the whole bug.

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
import {
  currentFoodSlot,
  getFoodServingsOnDate,
  getFoodSlotServingsOnDate,
  getFoodGroupLogOrder,
} from "@/lib/queries";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  foodLogCallbackData,
  foodProteinCallbackData,
  type FoodNudgeWindow,
} from "@/lib/notifications/food-format";
import { editMessageTextRaw } from "@/lib/notifications/telegram-api";
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

  it("counts the serving for the NUDGE's window and renders (1) on the tapped button", async () => {
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

    // The event carries the nudge's window explicitly, not a null the reader would
    // re-derive from the tap instant.
    expect(storedSlots(p.profileId, t, "berries")).toEqual([NUDGE_WINDOW]);

    // The slot count the rebuild reads is for the tapped window …
    expect(
      getFoodSlotServingsOnDate(p.profileId, NUDGE_WINDOW, t).get("berries")
    ).toBe(1);
    // … and NOT for the window the tap instant fell in.
    expect(
      getFoodSlotServingsOnDate(p.profileId, "Midday", t).get("berries")
    ).toBeUndefined();

    // The rendered button therefore carries its count again — the reported symptom.
    expect(rebuiltFoodButtonLabel("berries")).toBe("🫐 Berries (1)");
  });

  it("leaves the DAY tally alone — logging was always right, only the count disagreed", () => {
    // One serving on the day, regardless of which window it belongs to.
    expect(getFoodServingsOnDate(p.profileId, t).get("berries")).toBe(1);
  });

  it("the #950 ranking sees the same slot as the count (one derivation, #221)", () => {
    // The slot-frecency ranking reads foodEventWindow over the same rows, so the tap
    // ranks in the window it counted in.
    const ranked = getFoodGroupLogOrder(p.profileId, NUDGE_WINDOW).map(
      (g) => g.slug
    );
    expect(ranked).toContain("berries");
    // The tap leads the nudge's own window — the slot-frecency signal it just fed.
    expect(ranked[0]).toBe("berries");
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
    expect(storedSlots(p.profileId, t, "berries")).toEqual([
      NUDGE_WINDOW,
      NUDGE_WINDOW,
    ]);
  });

  it("the protein sibling behaves identically (#1073/#1379)", async () => {
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
    expect(storedSlots(p.profileId, t, PROTEIN_NUDGE_KEY)).toEqual([
      NUDGE_WINDOW,
    ]);
    expect(rebuiltProteinButtonLabel()).toBe("＋30g protein (1)");
  });
});
