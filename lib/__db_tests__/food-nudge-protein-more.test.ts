// DB INTEGRATION TIER — the food-nudge protein "+Xg" button (#1073) and the "Show more"
// progressive expansion (#1075) driven end-to-end through handleCallbackQuery against the
// REAL query layer, with only the raw Telegram network surface stubbed (the #454 guarded
// boundary). Proves a protein tap writes BOTH protein_log grams (via addProteinGramsCore)
// and a __protein__ food_log_events ranking row and rebuilds with the refreshed total; a
// non-protein-tracker's nudge omits the key; "Show more" bumps the visible count by 6 and a
// food tap AFTER expansion preserves it (rebuilds at the expanded count, not 6).

import { vi, describe, it, expect, beforeAll } from "vitest";

// Stub the RAW transport, keeping the chokepoint (rebuildMessage) + render helpers REAL so
// the edited wire text/keyboard this test inspects is the genuine rendered output.
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
import { setProfileSetting } from "@/lib/settings";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  countVisibleFoodButtons,
  foodLogCallbackData,
  foodProteinCallbackData,
  foodMoreCallbackData,
} from "@/lib/notifications/food-format";
import {
  answerCallbackQuery,
  editMessageTextRaw,
} from "@/lib/notifications/telegram-api";
import { seedProfile, type SeededProfile } from "./fixtures";

const answerMock = vi.mocked(answerCallbackQuery);
const editTextMock = vi.mocked(editMessageTextRaw);

// The keyboard the last rebuild produced (rebuildMessage → editMessageTextRaw(…, {keyboard})).
function lastRebuiltKeyboard(): { callback_data?: string }[][] | undefined {
  const call = editTextMock.mock.calls.at(-1);
  const opts = call?.[3] as { keyboard?: { callback_data?: string }[][] };
  return opts?.keyboard;
}
function lastRebuiltText(): string | undefined {
  return editTextMock.mock.calls.at(-1)?.[2] as string | undefined;
}
function lastAnswerText(): string | undefined {
  return answerMock.mock.calls.at(-1)?.[1];
}

// A cq with a keyboard carrying `foodButtonCount` food-log buttons (so the stateless
// count-from-keyboard derivation has something to read).
function cqWithFoodButtons(
  data: string,
  chatId: string,
  profileId: number,
  window: "Morning" | "Midday" | "Evening",
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
    id: "cbq-1",
    data,
    message: {
      message_id: 77,
      chat: { id: chatId },
      reply_markup: { inline_keyboard: rows },
    },
  };
}

const CHAT = "5550700";
let p: SeededProfile;
let t: string;

beforeAll(() => {
  p = seedProfile("food-nudge-pm");
  t = today(p.profileId);
  setProfileSetting(p.profileId, "telegram_chat_id", CHAT);
  setProfileSetting(p.profileId, "telegram_enabled", "1");
});

describe("protein '+Xg' tap (#1073)", () => {
  it("writes protein_log grams AND a __protein__ food_log_events row, and rebuilds with the total", async () => {
    answerMock.mockClear();
    editTextMock.mockClear();
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodProteinCallbackData(p.profileId, "Evening", t, 30),
        CHAT,
        p.profileId,
        "Evening",
        t,
        6
      )
    );
    // protein_log grams recorded.
    const grams = db
      .prepare(
        `SELECT grams FROM protein_log WHERE profile_id = ? AND date = ?`
      )
      .get(p.profileId, t) as { grams: number } | undefined;
    expect(grams?.grams).toBe(30);
    // A __protein__ ranking event was appended (the frecency signal).
    const ev = db
      .prepare(
        `SELECT COUNT(*) AS n FROM food_log_events
          WHERE profile_id = ? AND group_key = '__protein__'`
      )
      .get(p.profileId) as { n: number };
    expect(ev.n).toBe(1);
    // Honest toast + the rebuild shows the refreshed protein total. This fixture has a
    // bodyweight → the #974 today-vs-goal line renders (the SAME getProteinToday gather,
    // #221), carrying today's 30 g; a target-less tracker would get the "Protein N g today"
    // fallback instead.
    expect(lastAnswerText()).toContain("30 g protein");
    expect(lastRebuiltText()).toMatch(/Protein today · at least 30 g/);
  });

  it("a second tap accrues the total and appends another ranking event (buttons not consumed)", async () => {
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodProteinCallbackData(p.profileId, "Evening", t, 30),
        CHAT,
        p.profileId,
        "Evening",
        t,
        6
      )
    );
    const grams = db
      .prepare(
        `SELECT grams FROM protein_log WHERE profile_id = ? AND date = ?`
      )
      .get(p.profileId, t) as { grams: number };
    expect(grams.grams).toBe(60);
    const ev = db
      .prepare(
        `SELECT COUNT(*) AS n FROM food_log_events WHERE profile_id = ? AND group_key='__protein__'`
      )
      .get(p.profileId) as { n: number };
    expect(ev.n).toBe(2);
  });

  it("a stale-date protein tap logs NOTHING and answers honestly (#947)", async () => {
    const before = db
      .prepare(
        `SELECT COUNT(*) AS n FROM food_log_events WHERE profile_id=? AND group_key='__protein__'`
      )
      .get(p.profileId) as { n: number };
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodProteinCallbackData(p.profileId, "Evening", "2020-01-01", 30),
        CHAT,
        p.profileId,
        "Evening",
        "2020-01-01",
        6
      )
    );
    const after = db
      .prepare(
        `SELECT COUNT(*) AS n FROM food_log_events WHERE profile_id=? AND group_key='__protein__'`
      )
      .get(p.profileId) as { n: number };
    expect(after.n).toBe(before.n); // nothing written
    expect(lastAnswerText()).not.toContain("Logged");
  });

  it("a non-protein-tracker's nudge omits the __protein__ button", async () => {
    // A fresh profile that has never logged protein → getFoodNudgeRankedKeys excludes it.
    const np = seedProfile("food-nudge-noprotein");
    const { buildFoodNudge } = await import("@/lib/notifications/food");
    const msg = buildFoodNudge(np.profileId, "Evening", today(np.profileId));
    expect(msg).not.toBeNull();
    expect(
      (msg!.actions ?? []).some((a) => a.data?.startsWith("foodprotein:"))
    ).toBe(false);
  });
});

describe("'Show more' expansion (#1075)", () => {
  it("bumps the visible count by 6 and edits in place, answering quietly", async () => {
    answerMock.mockClear();
    editTextMock.mockClear();
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodMoreCallbackData(p.profileId, "Morning", t),
        CHAT,
        p.profileId,
        "Morning",
        t,
        6 // currently showing 6
      )
    );
    // Rebuilt keyboard now shows 12 ranked buttons (6 → 12).
    expect(countVisibleFoodButtons(lastRebuiltKeyboard())).toBe(12);
    // A view change → answered quietly (no toast text).
    expect(lastAnswerText()).toBeUndefined();
  });

  it("a food tap AFTER expansion rebuilds at the expanded count, not 6", async () => {
    editTextMock.mockClear();
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodLogCallbackData(p.profileId, "Morning", t, "leafy_greens"),
        CHAT,
        p.profileId,
        "Morning",
        t,
        12 // the keyboard is currently expanded to 12
      )
    );
    // The per-tap rebuild preserves the 12-button expansion (doesn't collapse to 6).
    expect(countVisibleFoodButtons(lastRebuiltKeyboard())).toBe(12);
  });
});
