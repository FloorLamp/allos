// DB INTEGRATION TIER (#2019, #2020) — eating-time and dose-time correction, end to end
// against the real schema, the real builders, the real callback dispatcher and the real
// hourly sweep, with ONLY the raw Telegram transport stubbed (the #454 guarded boundary).
//
// The harm this pins shut, twice:
//
//   • FOOD. The food ledger had no eating time at all. Two features needed one and both
//     routed around it, because `logged_at` is TAP time and says so in migration 056.
//   • DOSES. `given_at` DOES have consumers — the PRN redose window arms off it — and a
//     late tap wrote the tap moment into it with no way to correct. Take a painkiller at
//     22:00, confirm at 07:00, and the window believes you are nine hours fresher.
//
// Every case here goes through a REAL send (so the pointer is recorded exactly as
// production records it), a REAL callback dispatch, and where relevant the REAL sweep.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  let nextMessageId = 7000;
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    sendMessageRaw: vi.fn(async () => nextMessageId++),
  };
});

import { db, today } from "@/lib/db";
import { setTelegramBotConfig, setTimezone } from "@/lib/settings";
import { dispatch } from "@/lib/notifications";
import { buildFoodNudge } from "@/lib/notifications/food";
import { buildIntakeReminderForSlots } from "@/lib/notifications/supplements";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import { liveMessagePointers } from "@/lib/notifications/message-pointers";
import { keyboardTokens } from "@/lib/notifications/reconcile-core";
import { messageKeyboard } from "@/lib/notifications/telegram-render";
import {
  answerCallbackQuery,
  editMessageTextRaw,
} from "@/lib/notifications/telegram-api";
import {
  logFoodServingCore,
  restampFoodEventsCore,
} from "@/lib/food-log-write";
import { markDoseTaken } from "@/lib/queries";
import { restampDoseLogsCore } from "@/lib/queries/intake/adherence";
import { now as clockNow } from "@/lib/clock";
import { burstLabel } from "@/lib/correction-time";
import { getFoodCorrectionBursts } from "@/lib/queries";
import { getDoseCorrectionBursts } from "@/lib/queries/intake/adherence";
import { getMedicationFamilyStates } from "@/lib/queries/intake/prn-family";
import { seedLoginTelegram } from "./fixtures";

const answer = vi.mocked(answerCallbackQuery);
const editText = vi.mocked(editMessageTextRaw);

// The whole file runs at a fixed instant so "within the past hour" is a fact rather
// than a race. Berlin (UTC+2 in August) makes the local-vs-UTC distinction visible.
const NOW_ISO = "2026-08-05T19:30:00Z"; // 21:30 local
let priorNow: string | undefined;

beforeEach(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = NOW_ISO;
  setTelegramBotConfig({
    telegramBotToken: "bot-for-tests",
    telegramMode: "poll",
  });
  answer.mockClear();
  editText.mockClear();
});

afterEach(() => {
  if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorNow;
});

function setNow(iso: string): void {
  process.env.ALLOS_TEST_NOW = iso;
}

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "Europe/Berlin");
  return id;
}

// A callback query shaped like the one Telegram delivers, carrying the keyboard the
// handlers read their context back off.
function cq(chatId: string, data: string, keyboard: unknown) {
  return {
    id: `cb-${data}`,
    data,
    message: {
      message_id: 4242,
      chat: { id: Number(chatId) },
      text: "🍽️ Evening food log",
      reply_markup: { inline_keyboard: keyboard },
    },
  } as never;
}

function foodEvents(profileId: number) {
  return db
    .prepare(
      `SELECT id, group_key, date, logged_at, eaten_at, time_source, meal_slot
         FROM food_log_events WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    group_key: string;
    date: string;
    logged_at: string;
    eaten_at: string | null;
    time_source: string | null;
    meal_slot: string | null;
  }[];
}

// The correction row as the chat renders it, read back off a live keyboard: what the row
// CLAIMS about the burst (#2206 item 2), and which chips it is still offering.
function correctionRowLabel(keyboard: unknown): string | null {
  for (const row of keyboard as { text: string; callback_data?: string }[][])
    for (const btn of row)
      if (String(btn.callback_data ?? "").endsWith(":open")) return btn.text;
  return null;
}

// The keyboard the CHAT actually received on the last edit — the claim a phone is looking
// at, as opposed to what a fresh build would produce. #2206 item 2 is about the message,
// so the assertion has to read the message.
function lastEditedKeyboard(): unknown {
  const calls = editText.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return (calls[calls.length - 1][3] as { keyboard?: unknown }).keyboard;
}

function chipTokensOf(keyboard: unknown): string[] {
  return (keyboard as { text: string; callback_data?: string }[][])
    .flat()
    .map((b) => String(b.callback_data ?? ""))
    .filter((d) => d.startsWith("foodtime:") || d.startsWith("dosetime:"));
}

function dayCount(profileId: number, date: string, group: string): number {
  const row = db
    .prepare(
      `SELECT servings FROM food_log
        WHERE profile_id = ? AND date = ? AND group_key = ?`
    )
    .get(profileId, date, group) as { servings: number } | undefined;
  return row?.servings ?? 0;
}

// Tap a food quick-log button through the REAL dispatcher, at a stated instant.
async function tapFood(
  profileId: number,
  chatId: string,
  group: string,
  at: string
): Promise<void> {
  setNow(at);
  const date = today(profileId);
  const nudge = buildFoodNudge(profileId, "Evening", date)!;
  await handleCallbackQuery(
    cq(
      chatId,
      `food:${profileId}:Evening:${date}:${group}`,
      messageKeyboard(nudge)
    )
  );
}

// ---- #2019: the tap IS the capture -----------------------------------------

describe("a Telegram food tap records WHEN it was eaten (#2019)", () => {
  it("stamps eaten_at from the tap and marks it tap-sourced, asserting no meal", async () => {
    const pid = newProfile("Capture Cass");
    seedLoginTelegram(pid, "5552019");
    await tapFood(pid, "5552019", "leafy_greens", NOW_ISO);

    const [row] = foodEvents(pid);
    expect(row.group_key).toBe("leafy_greens");
    // The button's own contract — "I'm eating NOW" — recorded as the measurement it is.
    expect(row.eaten_at).toBe("2026-08-05T19:30:00Z");
    expect(row.time_source).toBe("tap");
    // `logged_at` stays the audit stamp migration 056 froze, and equals the tap here.
    expect(row.logged_at).toBe("2026-08-05T19:30:00Z");
    // #1704 REVERSED: the nudge's window is the nudge naming itself, not the user
    // declaring a meal. With a real instant on the row, the meal is derived from it.
    expect(row.meal_slot).toBeNull();
  });

  it("a write with nothing to state leaves eaten_at NULL rather than defaulting to now", () => {
    const pid = newProfile("Backfill Bea");
    // The web bar's backfill shape: a day, no stated time. Defaulting to now would
    // reintroduce the guess under a more authoritative name.
    logFoodServingCore(pid, "berries", "2026-08-01", NOW_ISO, "Morning");
    const [row] = foodEvents(pid);
    expect(row.eaten_at).toBeNull();
    expect(row.time_source).toBeNull();
    expect(row.meal_slot).toBe("Morning");
  });
});

describe("the correction rows are a QUERY over ledger state (#2019)", () => {
  it("ride whichever food keyboard is live, and collapse a burst into one row", async () => {
    const pid = newProfile("Burst Bo");
    seedLoginTelegram(pid, "5552020");
    await tapFood(pid, "5552020", "leafy_greens", "2026-08-05T19:02:00Z");
    await tapFood(pid, "5552020", "berries", "2026-08-05T19:05:00Z");
    await tapFood(pid, "5552020", "nuts_seeds", "2026-08-05T19:08:00Z");
    setNow(NOW_ISO);

    // A FRESH build — no memory of any earlier message — carries the row.
    const nudge = buildFoodNudge(pid, "Evening", today(pid))!;
    const tokens = keyboardTokens(messageKeyboard(nudge));
    const chips = tokens.filter((t) => t.startsWith("foodtime:"));
    const picker = tokens.filter((t) => t.startsWith("foodtimeat:"));
    // Three taps, ONE row: burst-mates share one error, so they share one correction.
    expect(chips).toHaveLength(2); // −30m, −1h (#2206)
    expect(picker).toHaveLength(1); // the 🕐 opener
    const anchor = foodEvents(pid)[0].id;
    expect(chips[0]).toBe(`foodtime:${pid}:${anchor}:30`);
    expect(chips[1]).toBe(`foodtime:${pid}:${anchor}:60`);
    // And the buttons state the TIMES they set, not the offsets (#2206 item 1). The
    // burst's earliest tap is 21:02 Berlin, so −30m reads 20:32.
    const labels = messageKeyboard(nudge)
      .flat()
      .filter((b) => String(b.callback_data ?? "").startsWith("foodtime:"))
      .map((b) => b.text);
    expect(labels).toEqual(["20:32 · −30m", "20:02 · −1h"]);
  });

  it("stop being offered once the burst is over an hour old", async () => {
    const pid = newProfile("Lapse Lou");
    seedLoginTelegram(pid, "5552021");
    await tapFood(pid, "5552021", "leafy_greens", "2026-08-05T19:00:00Z");

    setNow("2026-08-05T19:45:00Z");
    expect(getFoodCorrectionBursts(pid, clockNow())).toHaveLength(1);
    setNow("2026-08-05T20:15:00Z");
    expect(getFoodCorrectionBursts(pid, clockNow())).toEqual([]);
  });
});

describe("a chip re-stamps the whole burst in one transaction (#2019)", () => {
  it("moves every row back from its own tap, flips the source, and answers honestly", async () => {
    const pid = newProfile("Chip Chris");
    seedLoginTelegram(pid, "5552022");
    await tapFood(pid, "5552022", "leafy_greens", "2026-08-05T19:02:00Z");
    await tapFood(pid, "5552022", "berries", "2026-08-05T19:08:00Z");
    setNow(NOW_ISO);

    const anchor = foodEvents(pid)[0].id;
    const nudge = buildFoodNudge(pid, "Evening", today(pid))!;
    answer.mockClear();
    await handleCallbackQuery(
      cq("5552022", `foodtime:${pid}:${anchor}:60`, messageKeyboard(nudge))
    );

    const rows = foodEvents(pid);
    expect(rows.map((r) => r.eaten_at)).toEqual([
      "2026-08-05T18:02:00Z",
      "2026-08-05T18:08:00Z",
    ]);
    // The burst keeps its internal spread: each row moved from its OWN tap.
    expect(rows.map((r) => r.time_source)).toEqual(["stated", "stated"]);
    // `logged_at` is untouched — it is the audit stamp, and it is what makes the chip
    // idempotent.
    expect(rows.map((r) => r.logged_at)).toEqual([
      "2026-08-05T19:02:00Z",
      "2026-08-05T19:08:00Z",
    ]);
    // Never an unconditional confirm: the toast states what the write actually did.
    expect(answer.mock.calls[0][1]).toContain("2 servings");
  });

  it("COMPOSES — a second tap counts back from the stored value, not the tap (#2206)", async () => {
    const pid = newProfile("Twice Tam");
    seedLoginTelegram(pid, "5552023");
    await tapFood(pid, "5552023", "leafy_greens", "2026-08-05T19:02:00Z");
    setNow(NOW_ISO);
    const anchor = foodEvents(pid)[0].id;
    const kb = messageKeyboard(buildFoodNudge(pid, "Evening", today(pid))!);

    await handleCallbackQuery(
      cq("5552023", `foodtime:${pid}:${anchor}:60`, kb)
    );
    expect(foodEvents(pid)[0].eaten_at).toBe("2026-08-05T18:02:00Z");
    // The same STALE keyboard, tapped again. The write reads its base inside its own
    // transaction, so the second tap starts where the first one landed: "tap again to go
    // further" is the only reading a row that now SHOWS its result supports.
    await handleCallbackQuery(
      cq("5552023", `foodtime:${pid}:${anchor}:60`, kb)
    );
    expect(foodEvents(pid)[0].eaten_at).toBe("2026-08-05T17:02:00Z");
    // A finer step composes onto the coarse ones just the same.
    await handleCallbackQuery(
      cq("5552023", `foodtime:${pid}:${anchor}:30`, kb)
    );
    expect(foodEvents(pid)[0].eaten_at).toBe("2026-08-05T16:32:00Z");
  });

  it("the row re-renders with the STORED time, marked, and never with the tap (#2206)", async () => {
    const pid = newProfile("Render Rhea");
    seedLoginTelegram(pid, "5552026");
    await tapFood(pid, "5552026", "leafy_greens", "2026-08-05T19:02:00Z");
    setNow(NOW_ISO);
    const anchor = foodEvents(pid)[0].id;
    const kb = messageKeyboard(buildFoodNudge(pid, "Evening", today(pid))!);
    // Before: the row names the burst by the time it was tapped, unmarked.
    expect(correctionRowLabel(kb)).toBe("🕐 Leafy greens 21:02");

    editText.mockClear();
    await handleCallbackQuery(
      cq("5552026", `foodtime:${pid}:${anchor}:60`, kb)
    );

    // THE MESSAGE THE CHAT NOW SHOWS states 20:02 — not the 21:02 it was tapped at, and
    // not a value only a fresh build would know about.
    const edited = lastEditedKeyboard();
    expect(correctionRowLabel(edited)).toBe(
      "🕐 Leafy greens 20:02 (corrected)"
    );
    // Reduced, never extended: the same three buttons, no new claim and no new token.
    expect(chipTokensOf(edited)).toEqual([
      `foodtime:${pid}:${anchor}:30`,
      `foodtime:${pid}:${anchor}:60`,
    ]);
    // And the next build from the ledger agrees, because both are the same query.
    const after = messageKeyboard(buildFoodNudge(pid, "Evening", today(pid))!);
    expect(correctionRowLabel(after)).toBe("🕐 Leafy greens 20:02 (corrected)");
  });

  it("drops the chips at the floor and refuses a tap that arrives anyway (#2206)", async () => {
    const pid = newProfile("Floor Flo");
    seedLoginTelegram(pid, "5552027");
    await tapFood(pid, "5552027", "leafy_greens", "2026-08-05T19:02:00Z");
    setNow(NOW_ISO);
    const anchor = foodEvents(pid)[0].id;
    const kb = messageKeyboard(buildFoodNudge(pid, "Evening", today(pid))!);
    // Already corrected to twenty minutes above the floor (NOW − 12h = 07:30Z).
    db.prepare(
      `UPDATE food_log_events SET eaten_at = ?, time_source = 'stated' WHERE id = ?`
    ).run("2026-08-05T07:50:00Z", anchor);

    const rebuilt = messageKeyboard(
      buildFoodNudge(pid, "Evening", today(pid))!
    );
    // The chips are gone; the picker — which is what an answer that far back is for —
    // is the only path left.
    expect(chipTokensOf(rebuilt)).toEqual([]);
    expect(correctionRowLabel(rebuilt)).toBe(
      "🕐 Leafy greens 09:50 (corrected)"
    );

    // A tap off the STALE keyboard still arrives. It is refused, not clamped, and the
    // refusal says where the answer belongs.
    answer.mockClear();
    await handleCallbackQuery(
      cq("5552027", `foodtime:${pid}:${anchor}:60`, kb)
    );
    expect(foodEvents(pid)[0].eaten_at).toBe("2026-08-05T07:50:00Z");
    expect(String(answer.mock.calls[0][1])).toContain(
      "as far back as the chips"
    );
  });

  it("serialises a double tap — the second reads what the first wrote (#2206)", async () => {
    const pid = newProfile("Race Rui");
    seedLoginTelegram(pid, "5552028");
    await tapFood(pid, "5552028", "leafy_greens", "2026-08-05T19:02:00Z");
    setNow(NOW_ISO);
    const anchor = foodEvents(pid)[0].id;
    const kb = messageKeyboard(buildFoodNudge(pid, "Evening", today(pid))!);
    answer.mockClear();

    // Two callbacks in flight against ONE burst. Each resolves its base inside its own
    // IMMEDIATE transaction, so they compose instead of collapsing — a silent no-op is
    // the worst possible answer when the user's model is "tap again to go further".
    await Promise.all([
      handleCallbackQuery(cq("5552028", `foodtime:${pid}:${anchor}:60`, kb)),
      handleCallbackQuery(cq("5552028", `foodtime:${pid}:${anchor}:60`, kb)),
    ]);
    expect(foodEvents(pid)[0].eaten_at).toBe("2026-08-05T17:02:00Z");
    // Both taps were answered, and neither claimed something that did not happen.
    expect(answer.mock.calls).toHaveLength(2);
    for (const call of answer.mock.calls)
      expect(String(call[1])).toContain("Eating time updated");
  });

  it("a correction session does not renew its own freshness window (#2206)", async () => {
    const pid = newProfile("Window Wim");
    seedLoginTelegram(pid, "5552029");
    await tapFood(pid, "5552029", "leafy_greens", "2026-08-05T19:00:00Z");
    const anchor = foodEvents(pid)[0].id;

    setNow("2026-08-05T19:50:00Z");
    const kb = messageKeyboard(buildFoodNudge(pid, "Evening", today(pid))!);
    await handleCallbackQuery(
      cq("5552029", `foodtime:${pid}:${anchor}:60`, kb)
    );
    expect(foodEvents(pid)[0].eaten_at).toBe("2026-08-05T18:00:00Z");
    // Freshness is keyed on the TAP, which the correction never touched — so correcting
    // at 19:50 does not buy the row another hour past 20:00.
    expect(getFoodCorrectionBursts(pid, clockNow())).toHaveLength(1);
    setNow("2026-08-05T20:05:00Z");
    expect(getFoodCorrectionBursts(pid, clockNow())).toEqual([]);
    // And nothing is stranded: the correction that DID land is committed, and a further
    // tap is refused in words rather than silently.
    answer.mockClear();
    await handleCallbackQuery(
      cq("5552029", `foodtime:${pid}:${anchor}:60`, kb)
    );
    expect(foodEvents(pid)[0].eaten_at).toBe("2026-08-05T18:00:00Z");
    expect(String(answer.mock.calls[0][1])).toMatch(
      /Too late|nothing was changed/
    );
  });

  it("refuses a lapsed burst and writes nothing", async () => {
    const pid = newProfile("Stale Sam");
    seedLoginTelegram(pid, "5552024");
    await tapFood(pid, "5552024", "leafy_greens", "2026-08-05T19:00:00Z");
    const anchor = foodEvents(pid)[0].id;
    const kb = messageKeyboard(buildFoodNudge(pid, "Evening", today(pid))!);

    setNow("2026-08-05T21:00:00Z");
    answer.mockClear();
    await handleCallbackQuery(
      cq("5552024", `foodtime:${pid}:${anchor}:60`, kb)
    );
    expect(foodEvents(pid)[0].eaten_at).toBe("2026-08-05T19:00:00Z");
    expect(String(answer.mock.calls[0][1])).toMatch(
      /nothing was changed|Too late/
    );
  });
});

describe("the picker's absolute hour, and the cross-midnight re-date (#2019)", () => {
  it("moves the serving's DAY and its counter row together", async () => {
    const pid = newProfile("Midnight Mo");
    seedLoginTelegram(pid, "5552025");
    // 00:30 local on the 6th — last night's dinner, tapped after midnight.
    await tapFood(pid, "5552025", "leafy_greens", "2026-08-05T22:30:00Z");
    const tapDate = foodEvents(pid)[0].date;
    expect(tapDate).toBe("2026-08-06");
    expect(dayCount(pid, "2026-08-06", "leafy_greens")).toBe(1);

    const anchor = foodEvents(pid)[0].id;
    const kb = messageKeyboard(buildFoodNudge(pid, "Evening", tapDate)!);
    // "20:00" is later than the current local hour, so it means YESTERDAY 20:00.
    await handleCallbackQuery(
      cq("5552025", `foodtimeat:${pid}:${anchor}:20:00`, kb)
    );

    const [row] = foodEvents(pid);
    expect(row.eaten_at).toBe("2026-08-05T18:00:00Z");
    expect(row.date).toBe("2026-08-05");
    // The ledger row and the day counter are ONE fact in two shapes: exactly one
    // serving exists throughout, and it moved with the correction.
    expect(dayCount(pid, "2026-08-06", "leafy_greens")).toBe(0);
    expect(dayCount(pid, "2026-08-05", "leafy_greens")).toBe(1);
  });

  it("refuses an hour the picker is no longer offering", async () => {
    const pid = newProfile("Unoffered Uma");
    seedLoginTelegram(pid, "5552026");
    await tapFood(pid, "5552026", "berries", "2026-08-05T19:10:00Z");
    setNow(NOW_ISO);
    const anchor = foodEvents(pid)[0].id;
    const kb = messageKeyboard(buildFoodNudge(pid, "Evening", today(pid))!);

    answer.mockClear();
    // 21:00 local is the hour just gone — the CHIPS cover it, so the picker never
    // offered it, and a token naming it must not stamp an arbitrary instant.
    await handleCallbackQuery(
      cq("5552026", `foodtimeat:${pid}:${anchor}:21:00`, kb)
    );
    expect(foodEvents(pid)[0].eaten_at).toBe("2026-08-05T19:10:00Z");
    expect(String(answer.mock.calls[0][1])).toContain("nothing was changed");
  });

  it("opens the drill-down without writing, and comes back unchanged", async () => {
    const pid = newProfile("Picker Pat");
    seedLoginTelegram(pid, "5552027");
    await tapFood(pid, "5552027", "berries", "2026-08-05T19:10:00Z");
    setNow(NOW_ISO);
    const anchor = foodEvents(pid)[0].id;
    const before = foodEvents(pid)[0];
    const nudge = buildFoodNudge(pid, "Evening", today(pid))!;

    await handleCallbackQuery(
      cq("5552027", `foodtimeat:${pid}:${anchor}:open`, messageKeyboard(nudge))
    );
    expect(foodEvents(pid)[0]).toEqual(before);

    // The opened picker still carries the quick-log buttons, which is what lets Back
    // rebuild the exact nudge instead of guessing at a window.
    const open = buildFoodNudge(pid, "Evening", today(pid), undefined, {
      now: new Date(NOW_ISO),
      picker: getFoodCorrectionBursts(pid, new Date(NOW_ISO))[0],
    })!;
    const tokens = keyboardTokens(messageKeyboard(open));
    expect(tokens.some((t) => t.startsWith("food:"))).toBe(true);
    expect(tokens).toContain(`foodtimeat:${pid}:${anchor}:back`);

    await handleCallbackQuery(
      cq("5552027", `foodtimeat:${pid}:${anchor}:back`, messageKeyboard(open))
    );
    expect(foodEvents(pid)[0]).toEqual(before);
  });
});

describe("the sweep strips a lapsed correction row, then reconciles to zero (#2019)", () => {
  it("edits once when the burst ages out and never again", async () => {
    const pid = newProfile("Sweep Sid");
    seedLoginTelegram(pid, "5552028");
    // A real send, so the pointer is recorded exactly as production records it.
    setNow("2026-08-05T19:00:00Z");
    await tapFood(pid, "5552028", "leafy_greens", "2026-08-05T19:00:00Z");
    const nudge = buildFoodNudge(pid, "Evening", today(pid))!;
    await dispatch(pid, nudge);
    expect(
      keyboardTokens(liveMessagePointers(pid)[0].keyboard).some((t) =>
        t.startsWith("foodtime:")
      )
    ).toBe(true);

    // Still fresh: the sweep has nothing to do, and does nothing.
    setNow("2026-08-05T19:30:00Z");
    expect((await reconcileProfileMessages(pid)).edited).toBe(0);

    // The burst ages out: ONE trailing edit removes the rows.
    setNow("2026-08-05T20:30:00Z");
    const first = await reconcileProfileMessages(pid);
    expect(first.edited).toBe(1);
    expect(
      keyboardTokens(liveMessagePointers(pid)[0].keyboard).some((t) =>
        t.startsWith("foodtime")
      )
    ).toBe(false);
    // The quick-log buttons never died — another serving is always loggable.
    expect(
      keyboardTokens(liveMessagePointers(pid)[0].keyboard).some((t) =>
        t.startsWith("food:")
      )
    ).toBe(true);

    // THE IDEMPOTENCE PIN: the steady state costs zero Telegram calls.
    setNow("2026-08-05T21:30:00Z");
    expect((await reconcileProfileMessages(pid)).edited).toBe(0);
  });

  it("closes an ABANDONED open picker by the same lapse rule", async () => {
    const pid = newProfile("Abandon Abe");
    seedLoginTelegram(pid, "5552029");
    setNow("2026-08-05T19:00:00Z");
    await tapFood(pid, "5552029", "berries", "2026-08-05T19:00:00Z");
    const burst = getFoodCorrectionBursts(pid, clockNow())[0];
    const open = buildFoodNudge(pid, "Evening", today(pid), undefined, {
      now: clockNow(),
      picker: burst,
    })!;
    await dispatch(pid, open);
    expect(
      keyboardTokens(liveMessagePointers(pid)[0].keyboard).some((t) =>
        t.endsWith(":back")
      )
    ).toBe(true);

    // Still fresh: the picker is the user's current view and the sweep leaves it alone.
    setNow("2026-08-05T19:30:00Z");
    expect((await reconcileProfileMessages(pid)).edited).toBe(0);

    // Lapsed: the drill-down goes, the nudge comes back — no stranded modal keyboard.
    setNow("2026-08-05T20:30:00Z");
    expect((await reconcileProfileMessages(pid)).edited).toBe(1);
    const after = keyboardTokens(liveMessagePointers(pid)[0].keyboard);
    expect(after.some((t) => t.startsWith("foodtimeat:"))).toBe(false);
    expect(after.some((t) => t.startsWith("food:"))).toBe(true);
  });
});

// ---- #2020: the dose twin --------------------------------------------------

function seedDose(
  profileId: number,
  name: string
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'medication', 'daily', 'must')`
      )
      .run(profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 tab', 'evening', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

// `taken_at` is an AUDIT/duration stamp written by SQL's real clock, which the
// ALLOS_TEST_NOW freeze deliberately does not reach (see lib/clock.ts). So a fixture
// that needs a confirmation to sit at a known instant says so explicitly, after the
// real write path has created the row.
function stampTap(logId: number, sqlUtc: string): void {
  db.prepare(
    `UPDATE intake_item_logs SET taken_at = ?, given_at = ? WHERE id = ?`
  ).run(sqlUtc, sqlUtc, logId);
}

function doseLogs(profileId: number) {
  return db
    .prepare(
      `SELECT l.id AS id, l.date AS date, l.taken_at AS takenAt,
              l.given_at AS givenAt
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? ORDER BY l.id`
    )
    .all(profileId) as {
    id: number;
    date: string;
    takenAt: string;
    givenAt: string | null;
  }[];
}

describe("a dose reminder carries correction chips after a confirm (#2020)", () => {
  it("appears on the rebuilt reminder and rides the same builder the sweep uses", async () => {
    const pid = newProfile("Ride Rae");
    const { itemId, doseId } = seedDose(pid, "Ride Ibuprofen");
    seedLoginTelegram(pid, "5552030");
    markDoseTaken(pid, doseId, itemId, today(pid));
    stampTap(doseLogs(pid)[0].id, "2026-08-05 19:20:00");

    const built = buildIntakeReminderForSlots(pid, ["Evening"]);
    // Everything is resolved, so there is no reminder to send — but the correction rows
    // still exist as ledger state, which is what the tap rebuild renders.
    expect(built).toBeNull();
    const bursts = getDoseCorrectionBursts(pid, clockNow());
    expect(bursts).toHaveLength(1);
    expect(bursts[0].label).toBe("Ride Ibuprofen");
    // The tap and the administration instant agree, so nothing claims a correction.
    expect(bursts[0].corrected).toBe(false);
    expect(burstLabel(bursts[0], "Europe/Berlin")).toBe("Ride Ibuprofen 21:20");
  });

  it("re-renders the dose row with the corrected instant, not the resolve-time one (#2206)", async () => {
    const pid = newProfile("Echo Elke");
    const { itemId, doseId } = seedDose(pid, "Echo Ibuprofen");
    seedLoginTelegram(pid, "5552034");
    markDoseTaken(pid, doseId, itemId, today(pid));
    const anchor = doseLogs(pid)[0].id;
    stampTap(anchor, "2026-08-05 19:20:00");

    answer.mockClear();
    editText.mockClear();
    await handleCallbackQuery(
      cq("5552034", `dosetime:${pid}:${anchor}:60`, [])
    );
    expect(doseLogs(pid)[0].givenAt).toBe("2026-08-05 18:20:00");

    // The burst the HANDLER resolved was read before the write; the row it rebuilds must
    // be read after it, or the chat re-asserts the value it was told to stop asserting.
    // Read off the EDIT itself, which is the claim the phone is looking at.
    expect(correctionRowLabel(lastEditedKeyboard())).toBe(
      "🕐 Echo Ibuprofen 20:20 (corrected)"
    );
    const bursts = getDoseCorrectionBursts(pid, clockNow());
    expect(bursts[0].corrected).toBe(true);
    expect(burstLabel(bursts[0], "Europe/Berlin")).toBe(
      "Echo Ibuprofen 20:20 (corrected)"
    );

    // Composition, on the dose ledger too — and `taken_at` never moves, which is what
    // keeps freshness keyed on the tap rather than on the correction session.
    await handleCallbackQuery(
      cq("5552034", `dosetime:${pid}:${anchor}:30`, [])
    );
    expect(doseLogs(pid)[0].givenAt).toBe("2026-08-05 17:50:00");
    expect(doseLogs(pid)[0].takenAt).toBe("2026-08-05 19:20:00");
    expect(getDoseCorrectionBursts(pid, clockNow())[0].endAt).toBe(
      "2026-08-05T19:20:00.000Z"
    );
  });

  it("re-stamps given_at, leaves the adherence DAY where the schedule put it", async () => {
    const pid = newProfile("Bedtime Bec");
    const { itemId, doseId } = seedDose(pid, "Bedtime Melatonin");
    seedLoginTelegram(pid, "5552031");
    // The failure the issue describes: confirmed hours after it was actually taken.
    setNow("2026-08-06T05:00:00Z"); // 07:00 local on the 6th
    const date = today(pid);
    markDoseTaken(pid, doseId, itemId, date);
    stampTap(doseLogs(pid)[0].id, "2026-08-06 05:00:00");
    const before = doseLogs(pid)[0];
    expect(before.date).toBe("2026-08-06");

    const anchor = before.id;
    const built = buildIntakeReminderForSlots(pid, ["Evening"]);
    const kb = built ? messageKeyboard(built.message) : [];
    // "22:00" is later than 07:00, so it resolves to yesterday 22:00 — the bedtime dose.
    await handleCallbackQuery(
      cq("5552031", `dosetimeat:${pid}:${anchor}:22:00`, kb)
    );

    const after = doseLogs(pid)[0];
    expect(after.givenAt).toBe("2026-08-05 20:00:00");
    // THE DELIBERATE CONTRAST WITH FOOD: a dose's day is schedule-owned (#614), so the
    // correction crossing midnight moves the instant and nothing else.
    expect(after.date).toBe("2026-08-06");
    // `taken_at` is the audit stamp and is never edited.
    expect(after.takenAt).toBe(before.takenAt);
  });

  it("the PRN redose read sees the corrected instant, and only ever gets MORE conservative", async () => {
    const pid = newProfile("Redose Ren");
    const { itemId, doseId } = seedDose(pid, "Redose Paracetamol");
    seedLoginTelegram(pid, "5552032");
    setNow(NOW_ISO);
    markDoseTaken(pid, doseId, itemId, today(pid));
    stampTap(doseLogs(pid)[0].id, "2026-08-05 19:20:00");

    const armedBefore = getMedicationFamilyStates(pid, today(pid)).get(
      itemId
    )!.latestGivenAt!;
    const anchor = doseLogs(pid)[0].id;
    await handleCallbackQuery(
      cq("5552032", `dosetime:${pid}:${anchor}:60`, [])
    );

    const armedAfter = getMedicationFamilyStates(pid, today(pid)).get(
      itemId
    )!.latestGivenAt!;
    // The arming dose the safety read consults is the corrected one …
    expect(armedAfter).not.toBe(armedBefore);
    // … and it is EARLIER, so the computed freshness can only shrink. A correction of a
    // late tap makes the window more conservative, never less.
    expect(new Date(`${armedAfter}Z`.replace(" ", "T")).getTime()).toBeLessThan(
      new Date(`${armedBefore}Z`.replace(" ", "T")).getTime()
    );
  });

  it("adjusts instants without merging or deleting rows, even into proximity", async () => {
    const pid = newProfile("Proximity Pru");
    const { itemId } = seedDose(pid, "Proximity Ibuprofen");
    seedLoginTelegram(pid, "5552033");
    // Two administrations, hours apart, both confirmed in one burst.
    const doseId = doseIdOf(itemId);
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status, taken_at, given_at)
       VALUES (?,?,?,?,'taken',?,?)`
    ).run(
      doseId,
      itemId,
      "2026-08-05",
      "1 tab",
      "2026-08-05 19:02:00",
      "2026-08-05 19:02:00"
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status, taken_at, given_at)
       VALUES (?,?,?,?,'taken',?,?)`
    ).run(
      doseId,
      itemId,
      "2026-08-05",
      "1 tab",
      "2026-08-05 19:04:00",
      "2026-08-05 19:04:00"
    );
    const before = doseLogs(pid);
    expect(before).toHaveLength(2);

    await handleCallbackQuery(
      cq("5552033", `dosetime:${pid}:${before[0].id}:60`, [])
    );
    const after = doseLogs(pid);
    // The phantom-dose proximity guard runs at INSERT time and is NOT re-evaluated: a
    // correction may legitimately move two administrations close together, and merging
    // or deleting one would destroy a real record of something that was taken.
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.givenAt)).toEqual([
      "2026-08-05 18:02:00",
      "2026-08-05 18:04:00",
    ]);
  });
});

// ---- #2059: the WRITE carries the scope, not only the read that fed it -----
//
// Both correction cores mint their burst from a profile-scoped SELECT, which is exactly
// why the UPDATE has to re-state the scope anyway: the ONE statement that mutates a row
// must not be correct only because a sibling query above it still is. The module
// comments on both cores promise "the anchor row is gone OR BELONGS TO ANOTHER PROFILE
// ⇒ no-burst"; until now nothing asserted the second half in either domain.
//
// In both cases the stranger's own ledger is seeded LAST, so its ids sit inside the
// `id >= anchor` window the cores scan — the rows really are in front of the writer, and
// only the scoping keeps them (and the owner's) still.
describe("a correction anchored on another profile's row writes nothing (#2059)", () => {
  const backAnHour = (row: { tapAt: string; statedAt: string | null }): Date =>
    new Date(Date.parse(row.statedAt ?? row.tapAt) - 3_600_000);

  it("food: a foreign anchor is no-burst, and neither ledger moves", () => {
    const owner = newProfile("Ledger Lena");
    const stranger = newProfile("Stranger Stig");
    setNow(NOW_ISO);
    logFoodServingCore(
      owner,
      "leafy_greens",
      today(owner),
      "2026-08-05T19:02:00Z"
    );
    logFoodServingCore(
      stranger,
      "nuts_seeds",
      today(stranger),
      "2026-08-05T19:04:00Z"
    );
    const ownerBefore = foodEvents(owner);
    const strangerBefore = foodEvents(stranger);

    expect(
      restampFoodEventsCore(stranger, ownerBefore[0].id, backAnHour)
    ).toEqual({ kind: "no-burst" });
    expect(foodEvents(owner)).toEqual(ownerBefore);
    // Not even the stranger's OWN row moves: an anchor he doesn't hold is not a burst,
    // so the write never runs at all rather than running over whatever came next.
    expect(foodEvents(stranger)).toEqual(strangerBefore);
  });

  it("dose: every log id in the database, swept as a stranger's anchor, moves only his own", () => {
    const owner = newProfile("Owner Odile");
    const stranger = newProfile("Stranger Sven");
    const ownerDose = seedDose(owner, "Owner's Amlodipine");
    const strangerDose = seedDose(stranger, "Stranger's Amlodipine");
    setNow(NOW_ISO);
    markDoseTaken(owner, ownerDose.doseId, ownerDose.itemId, today(owner));
    stampTap(doseLogs(owner)[0].id, "2026-08-05 19:02:00");
    markDoseTaken(
      stranger,
      strangerDose.doseId,
      strangerDose.itemId,
      today(stranger)
    );
    stampTap(doseLogs(stranger)[0].id, "2026-08-05 19:04:00");
    const ownerBefore = doseLogs(owner);
    const strangerBefore = doseLogs(stranger);

    // The property, not one case: whatever id the stranger names, the owner's ledger is
    // untouched. A later refactor that widened the burst selection would fail here.
    for (const row of [...ownerBefore, ...strangerBefore]) {
      restampDoseLogsCore(stranger, row.id, backAnHour);
    }
    expect(doseLogs(owner)).toEqual(ownerBefore);
    // His own anchor still works — the scoping refuses the stranger, not the feature.
    expect(doseLogs(stranger).map((r) => r.givenAt)).toEqual([
      "2026-08-05 18:04:00",
    ]);
    expect(doseLogs(stranger).map((r) => r.takenAt)).toEqual(
      strangerBefore.map((r) => r.takenAt)
    );
  });
});

function doseIdOf(itemId: number): number {
  return (
    db
      .prepare(`SELECT id FROM intake_item_doses WHERE item_id = ?`)
      .get(itemId) as { id: number }
  ).id;
}
