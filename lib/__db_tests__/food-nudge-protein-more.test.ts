// DB INTEGRATION TIER — the food-nudge protein "+Xg" button (#1073) and the "Show more"
// progressive expansion (#1075) driven end-to-end through handleCallbackQuery against the
// REAL query layer, with only the raw Telegram network surface stubbed (the #454 guarded
// boundary). Proves a protein tap writes BOTH protein_log grams (via addProteinGramsCore)
// and a __protein__ food_log_events ranking row and rebuilds with the refreshed total; a
// non-protein-tracker's nudge omits the key; "Show more" bumps the visible count by 6 and a
// food tap AFTER expansion preserves it (rebuilds at the expanded count, not 6).
//
// #1807 extends the same harness to the collapse direction ("➖ Show less" steps back one
// page and clamps at the compact default, and a more→less round-trip restores the original
// button set with its counts intact) and pins that the nudge mints NO url button even with a
// public app URL configured — the "＋ More…" deep link is retired, not conditional.

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
import { setProfileSetting, setPublicUrl } from "@/lib/settings";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { buildFoodNudge } from "@/lib/notifications/food";
import { getFoodNudgeRankedKeys } from "@/lib/queries";
import { logFoodServingCore } from "@/lib/food-log-write";
import { foodGroupSlugs } from "@/lib/food-groups";
import { messageKeyboard } from "@/lib/notifications/telegram-render";
import {
  countVisibleFoodButtons,
  foodLogCallbackData,
  foodProteinCallbackData,
  foodMoreCallbackData,
  foodLessCallbackData,
  FOOD_NUDGE_BUTTON_COUNT,
} from "@/lib/notifications/food-format";
import {
  answerCallbackQuery,
  editMessageTextRaw,
} from "@/lib/notifications/telegram-api";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

const answerMock = vi.mocked(answerCallbackQuery);
const editTextMock = vi.mocked(editMessageTextRaw);

// The keyboard the last rebuild produced (rebuildMessage → editMessageTextRaw(…, {keyboard})).
type RebuiltButton = { text?: string; callback_data?: string };
function lastRebuiltKeyboard(): RebuiltButton[][] | undefined {
  const call = editTextMock.mock.calls.at(-1);
  const opts = call?.[3] as { keyboard?: RebuiltButton[][] };
  return opts?.keyboard;
}
function lastRebuiltText(): string | undefined {
  return editTextMock.mock.calls.at(-1)?.[2] as string | undefined;
}
function lastAnswerText(): string | undefined {
  return answerMock.mock.calls.at(-1)?.[1];
}

// A cq with a keyboard carrying `foodButtonCount` food-log buttons (so the stateless
// count-from-keyboard derivation has something to read). Slugs come from the real catalog
// and cycle once it runs out — only the COUNT of ranked buttons is what the derivation
// reads, and a request past the catalog size still has to be representable here.
function cqWithFoodButtons(
  data: string,
  chatId: string,
  profileId: number,
  window: "Morning" | "Midday" | "Evening",
  date: string,
  foodButtonCount: number
) {
  const catalog = foodGroupSlugs();
  const rows = Array.from(
    { length: foodButtonCount },
    (_, i) => catalog[i % catalog.length]
  ).map((s) => [
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
  seedLoginTelegram(p.profileId, CHAT);
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
    // The figure is emphasized and the status stated (#1710) — and the rendered HTML
    // proves the emphasis is real markup around ESCAPED text, not a raw tag from a
    // builder.
    expect(lastRebuiltText()).toMatch(
      /Protein · <b>at least 30 g<\/b> of ~\d+–\d+ g/
    );
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

// ---- #1807: the collapse direction, through the real dispatcher ----

// The labels of the expansion controls on the last rebuilt keyboard, in keyboard order.
function lastRebuiltExpandLabels(): string[] {
  return (lastRebuiltKeyboard() ?? [])
    .flat()
    .filter(
      (b) =>
        b.callback_data?.startsWith("foodmore:") ||
        b.callback_data?.startsWith("foodless:")
    )
    .map((b) => b.text ?? "");
}

describe("'Show less' collapse (#1807)", () => {
  it("collapses one page and clamps at the compact default on a second tap", async () => {
    answerMock.mockClear();
    editTextMock.mockClear();
    // 18 shown → one tap back to 12.
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodLessCallbackData(p.profileId, "Morning", t),
        CHAT,
        p.profileId,
        "Morning",
        t,
        18
      )
    );
    expect(countVisibleFoodButtons(lastRebuiltKeyboard())).toBe(12);
    // A view change → answered quietly, same as "Show more".
    expect(lastAnswerText()).toBeUndefined();

    // 8 shown → the step would land at 2, so the clamp holds it at the default 6.
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodLessCallbackData(p.profileId, "Morning", t),
        CHAT,
        p.profileId,
        "Morning",
        t,
        8
      )
    );
    expect(countVisibleFoodButtons(lastRebuiltKeyboard())).toBe(6);

    // Already at the default → the clamp makes a stray tap a no-op, not an empty keyboard.
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodLessCallbackData(p.profileId, "Morning", t),
        CHAT,
        p.profileId,
        "Morning",
        t,
        6
      )
    );
    expect(countVisibleFoodButtons(lastRebuiltKeyboard())).toBe(6);
  });

  it("is absent on a compact keyboard and alone at full expansion", async () => {
    editTextMock.mockClear();
    // A compact keyboard: expanding produces 12, which offers BOTH directions.
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodMoreCallbackData(p.profileId, "Morning", t),
        CHAT,
        p.profileId,
        "Morning",
        t,
        6
      )
    );
    expect(lastRebuiltExpandLabels()).toEqual(["➕ Show more", "➖ Show less"]);

    // Collapsing back to the default drops the collapse control entirely.
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodLessCallbackData(p.profileId, "Morning", t),
        CHAT,
        p.profileId,
        "Morning",
        t,
        12
      )
    );
    expect(lastRebuiltExpandLabels()).toEqual(["➕ Show more"]);

    // Expanding past every ranked key drops "Show more" and leaves "Show less" alone.
    const ranked = getFoodNudgeRankedKeys(p.profileId, "Morning").length;
    expect(ranked).toBeGreaterThan(FOOD_NUDGE_BUTTON_COUNT);
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodMoreCallbackData(p.profileId, "Morning", t),
        CHAT,
        p.profileId,
        "Morning",
        t,
        ranked
      )
    );
    expect(lastRebuiltExpandLabels()).toEqual(["➖ Show less"]);
  });

  it("more → less restores the original button set, counts intact", async () => {
    // Log a serving first, so the "(n)" suffixes are non-trivial and a lost count would
    // show up as a different label rather than only a different length.
    logFoodServingCore(
      p.profileId,
      "leafy_greens",
      t,
      new Date().toISOString(),
      "Midday"
    );
    const labelsAt = (kb: RebuiltButton[][] | undefined) =>
      (kb ?? []).flat().map((b) => b.text ?? "");

    editTextMock.mockClear();
    // Establish the compact baseline by rebuilding through a real tap path.
    await handleCallbackQuery(
      cqWithFoodButtons(
        foodLessCallbackData(p.profileId, "Midday", t),
        CHAT,
        p.profileId,
        "Midday",
        t,
        6
      )
    );
    const before = labelsAt(lastRebuiltKeyboard());
    expect(before.some((l) => l.includes("(1)"))).toBe(true);

    await handleCallbackQuery(
      cqWithFoodButtons(
        foodMoreCallbackData(p.profileId, "Midday", t),
        CHAT,
        p.profileId,
        "Midday",
        t,
        6
      )
    );
    expect(countVisibleFoodButtons(lastRebuiltKeyboard())).toBe(12);

    await handleCallbackQuery(
      cqWithFoodButtons(
        foodLessCallbackData(p.profileId, "Midday", t),
        CHAT,
        p.profileId,
        "Midday",
        t,
        12
      )
    );
    expect(labelsAt(lastRebuiltKeyboard())).toEqual(before);
  });
});

// The #1807 pin for the retired deep link: the renderer no longer takes a base URL, so a
// configured public URL — the condition that used to mint "＋ More…" — changes nothing.
describe("no deep link on the food nudge (#1807)", () => {
  it("renders no url button even with a public app URL configured", () => {
    setPublicUrl("https://allos.example.test");
    try {
      for (const visibleCount of [undefined, 12]) {
        const msg = buildFoodNudge(p.profileId, "Evening", t, visibleCount);
        expect(msg).not.toBeNull();
        expect((msg!.actions ?? []).some((a) => a.url)).toBe(false);
        expect(
          messageKeyboard(msg!)
            .flat()
            .some((b) => b.url)
        ).toBe(false);
      }
    } finally {
      setPublicUrl("");
    }
  });
});
