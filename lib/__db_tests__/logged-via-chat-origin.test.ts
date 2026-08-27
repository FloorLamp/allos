// DB INTEGRATION TIER — the NUDGE-vs-COMMAND axis of `logged_via` (#3087), driven
// through the real senders and the real callback dispatcher.
//
// WHY THIS FILE EXISTS SEPARATELY FROM logged-via-provenance.test.ts. That file taps
// tokens it writes itself, which is the right shape for a token family whose PREFIX
// carries the answer (`pdone:` vs `plog:`) — the handler cannot be fooled there. It is
// the wrong shape for the three families where it cannot:
//
//   • `food:` — `/food` re-renders `buildFoodNudge`, the same builder the proactive
//     tick sends, so the two keyboards are byte-identical apart from the origin marker
//     the MINT SITE writes. A test that hands the handler a token it composed itself
//     would assert the marker convention and nothing about whether either sender
//     applies it.
//   • `prn:` — minted by the `/dose` list AND by the digest's "+ Doses" expansion, on
//     purpose. The discriminator is the delivered keyboard, so the keyboard has to be
//     the one that was actually delivered.
//   • `redose:` — one proactive minter, and the stamp beside it claimed the opposite.
//
// So every case below SENDS first and taps what came out. Only the Telegram transport
// is stubbed.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { stubTelegramSends } from "./telegram-spies";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  setTimezone,
  setProfileSetting,
  setTelegramBotConfig,
} from "@/lib/settings";
import { tickProfile } from "@/lib/notifications/tick";
import { runRedoseNotices } from "@/lib/notifications/redose";
import {
  editMessageTextRaw,
  sendMessageRaw,
} from "@/lib/notifications/telegram-api";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import { PROTEIN_QUICKADD_LAST_KEY } from "@/lib/protein-daily-totals-write";
import { PROTEIN_NUDGE_KEY } from "@/lib/protein-nudge";
import { handleIncomingMessage } from "@/lib/notifications/telegram-quick-log";
import { seedLoginTelegram } from "./fixtures";
import type { NotificationMessage } from "@/lib/notifications/types";

beforeAll(() => stubTelegramSends());

const sendMock = vi.mocked(sendMessageRaw);
const editMock = vi.mocked(editMessageTextRaw);

type Button = { text: string; callback_data?: string };

function makeProfile(tag: string): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(tag)
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  return profileId;
}

/** One food tap in the past, so a group ranks onto the nudge's keyboard. */
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

function seedHabit(profileId: number, groups: readonly string[]) {
  const anchor = today(profileId);
  for (let d = 1; d <= 21; d++)
    for (const g of groups) pastTap(profileId, g, shiftDateStr(anchor, -d));
}

/** The messages that went to one chat, newest last, with their keyboards. */
function sentTo(chatId: string): { msg: NotificationMessage; id: number }[] {
  return (
    sendMock.mock.calls
      .map((c, i) => ({
        chat: String(c[0]),
        msg: c[1] as NotificationMessage,
        i,
      }))
      .filter((s) => s.chat === chatId)
      // The stub hands out a fresh message id per send, in call order.
      .map((s) => ({ msg: s.msg, id: 900 + s.i }))
  );
}

/** A callback query as Telegram delivers one: the token, on its own keyboard. */
function cq(data: string, chatId: string, keyboard: Button[][], messageId = 1) {
  return {
    id: `cbq-${data}`,
    data,
    message: {
      message_id: messageId,
      chat: { id: chatId },
      reply_markup: { inline_keyboard: keyboard },
    },
  };
}

function keyboardOf(msg: NotificationMessage): Button[][] {
  return (msg.actions ?? []).map((a) => [
    { text: a.label, callback_data: a.data },
  ]);
}

function foodOrigin(
  profileId: number,
  group: string
): string | null | undefined {
  return (
    db
      .prepare(
        `SELECT logged_via FROM food_log_events
          WHERE profile_id = ? AND group_key = ? AND date = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(profileId, group, today(profileId)) as
      { logged_via: string | null } | undefined
  )?.logged_via;
}

function itemOrigin(itemId: number): string | null | undefined {
  return (
    db
      .prepare(
        `SELECT logged_via FROM intake_item_logs
          WHERE item_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(itemId) as { logged_via: string | null } | undefined
  )?.logged_via;
}

// ── the food family: one builder, two senders ─────────────────────────────────

describe("a food tap records the KEYBOARD it came from, not the file it is handled in", () => {
  const NUDGE_CHAT = "5559101";
  const CMD_CHAT = "5559102";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T08:00:00Z"));
    sendMock.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  function seedChat(
    tag: string,
    chatId: string,
    groups: readonly string[] = ["leafy_greens"]
  ): number {
    const profileId = makeProfile(tag);
    seedLoginTelegram(profileId, chatId);
    setTelegramBotConfig({
      telegramBotToken: "bot token 30871",
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
    seedHabit(profileId, groups);
    return profileId;
  }

  it("stores telegram-nudge for a tap on the PROACTIVE send, through the real tick", async () => {
    const profileId = seedChat("LV3087-nudge", NUDGE_CHAT);
    await tickProfile(profileId, "LV3087-nudge", 5, Date.now());
    const food = sentTo(NUDGE_CHAT).find((s) => s.msg.kind === "food");
    expect(food, "the tick sent no food nudge").toBeDefined();
    const token = (food!.msg.actions ?? [])
      .map((a) => a.data ?? "")
      .find((d) => d.startsWith("food:") && d.endsWith(":leafy_greens"));
    expect(token, "no leafy-greens button on the nudge").toBeDefined();

    await handleCallbackQuery(
      cq(token!, NUDGE_CHAT, keyboardOf(food!.msg), food!.id)
    );
    expect(foodOrigin(profileId, "leafy_greens")).toBe("telegram-nudge");
  });

  it("stores telegram-command for a tap on the /food reply — SAME builder, same tokens", async () => {
    // THE INVERSION THIS FIXES. `handleFoodCommand` re-renders `buildFoodNudge`, so
    // before the origin rode the token there was nothing at the handler to read and
    // every slash-command tap recorded as a proactive nudge.
    const profileId = seedChat("LV3087-cmd", CMD_CHAT);
    await handleIncomingMessage({
      message_id: 1,
      chat: { id: CMD_CHAT },
      text: "/food",
    });
    const reply = sentTo(CMD_CHAT).find((s) => s.msg.kind === "food");
    expect(reply, "/food sent nothing").toBeDefined();
    const token = (reply!.msg.actions ?? [])
      .map((a) => a.data ?? "")
      .find((d) => d.startsWith("food:") && d.endsWith(":leafy_greens"));
    expect(token).toBeDefined();

    await handleCallbackQuery(
      cq(token!, CMD_CHAT, keyboardOf(reply!.msg), reply!.id)
    );
    expect(foodOrigin(profileId, "leafy_greens")).toBe("telegram-command");
  });

  it("keeps the answer across a REBUILD — the second tap on a /food list still says command", async () => {
    // A tap re-renders the whole nudge from the builder, so a rebuild that dropped
    // the marker would report `telegram-command` once and `telegram-nudge` for ever
    // after. The round trip is where a provenance mechanism quietly loses.
    const chat = "5559103";
    const profileId = seedChat("LV3087-rebuild", chat);
    await handleIncomingMessage({
      message_id: 1,
      chat: { id: chat },
      text: "/food",
    });
    const reply = sentTo(chat).find((s) => s.msg.kind === "food")!;
    const token = (reply.msg.actions ?? [])
      .map((a) => a.data ?? "")
      .find((d) => d.startsWith("food:") && d.endsWith(":leafy_greens"))!;

    editMock.mockClear();
    await handleCallbackQuery(cq(token, chat, keyboardOf(reply.msg), reply.id));
    // The keyboard Telegram now holds is the one the rebuild wrote — read off the
    // edit that actually went out, never re-derived here.
    const rebuilt = (
      editMock.mock.calls.at(-1)?.[3] as { keyboard?: Button[][] } | undefined
    )?.keyboard;
    expect(rebuilt, "the tap did not rebuild the keyboard").toBeDefined();
    const again = rebuilt!
      .flat()
      .map((b) => b.callback_data ?? "")
      .find((d) => d.startsWith("food:") && d.endsWith(":leafy_greens"));
    expect(again).toBeDefined();

    await handleCallbackQuery(cq(again!, chat, rebuilt!, reply.id));
    const rows = db
      .prepare(
        `SELECT logged_via FROM food_log_events
          WHERE profile_id = ? AND group_key = 'leafy_greens' AND date = ?`
      )
      .all(profileId, today(profileId)) as { logged_via: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.logged_via)).toEqual([
      "telegram-command",
      "telegram-command",
    ]);
  });

  it("keeps the answer across a PROTEIN rebuild, and leaves the sweep nothing to edit", async () => {
    // ONE FIXTURE PER REBUILD PATH IS WHAT LET A REGRESSION THROUGH. The test above
    // drives the second tap through the food-GROUP button; `handleFoodProtein` is a
    // separate rebuild site sixty lines further down the same file, and it shipped
    // unwrapped. One tap on "+30 g" rewrote all seven buttons UNMARKED, so
    // `keyboardChatOrigin` answered null for that keyboard for ever and every later
    // tap on the message recorded `telegram-nudge` — a permanent, one-directional
    // inflation of the nudge count.
    //
    // Three assertions, because the failure had three separable halves: the marker on
    // the whole rebuilt keyboard, the value a FOLLOWING food-group tap stores, and the
    // hourly sweep finding nothing to edit (a rebuild whose marker disagrees with the
    // live keyboard spends one Telegram edit per live food message, which is the
    // regression the null-preserving rule was written for).
    const chat = "5559104";
    const profileId = seedChat("LV3087-protein", chat, [
      "leafy_greens",
      PROTEIN_NUDGE_KEY,
    ]);
    // A protein tracker, so `buildFoodNudge` ranks the reserved __protein__
    // pseudo-group onto the keyboard at all and the "+Xg" button exists to tap; the
    // seeded history above is what carries it into the COMPACT window.
    setProfileSetting(profileId, PROTEIN_QUICKADD_LAST_KEY, "30");
    await handleIncomingMessage({
      message_id: 1,
      chat: { id: chat },
      text: "/food",
    });
    const reply = sentTo(chat).find((s) => s.msg.kind === "food")!;
    const delivered = keyboardOf(reply.msg);
    const protein = (reply.msg.actions ?? [])
      .map((a) => a.data ?? "")
      .find((d) => d.startsWith("foodprotein:"));
    expect(protein, "the /food reply carried no protein button").toBeDefined();
    // The delivered keyboard is marked end to end — the premise the rest rests on.
    expect(
      delivered
        .flat()
        .filter((b) => /^food(?:protein)?:c:/.test(b.callback_data ?? ""))
        .length
    ).toBe(
      delivered
        .flat()
        .filter((b) => /^food(?:protein)?:/.test(b.callback_data ?? "")).length
    );

    editMock.mockClear();
    await handleCallbackQuery(cq(protein!, chat, delivered, reply.id));
    const rebuilt = (
      editMock.mock.calls.at(-1)?.[3] as { keyboard?: Button[][] } | undefined
    )?.keyboard;
    expect(
      rebuilt,
      "the protein tap did not rebuild the keyboard"
    ).toBeDefined();
    const markable = rebuilt!
      .flat()
      .map((b) => b.callback_data ?? "")
      .filter((d) => /^food(?:protein)?:/.test(d));
    expect(markable.length).toBeGreaterThan(0);
    expect(markable.filter((d) => /^food(?:protein)?:c:/.test(d))).toEqual(
      markable
    );

    // The half that reaches the ledger: a food-group tap on the REBUILT keyboard.
    const group = markable.find(
      (d) => d.startsWith("food:") && d.endsWith(":leafy_greens")
    );
    expect(group).toBeDefined();
    await handleCallbackQuery(cq(group!, chat, rebuilt!, reply.id));
    expect(foodOrigin(profileId, "leafy_greens")).toBe("telegram-command");

    // AND THE HOURLY SWEEP SETTLES. It re-renders from the live keyboard and edits
    // only on a difference, so a marker that disagreed with what is on screen would
    // cost one Telegram edit per live food message EVERY hour — the regression shape
    // `keyboardChatOrigin`'s null answer exists to prevent. The first pass may edit
    // for reasons of its own (the tap opened a fresh time-correction chip row, which
    // a tap's own rebuild does not carry); the SECOND must find nothing, and whatever
    // it renders must still be marked end to end.
    editMock.mockClear();
    await reconcileProfileMessages(profileId);
    const swept = (
      editMock.mock.calls.at(-1)?.[3] as { keyboard?: Button[][] } | undefined
    )?.keyboard;
    if (swept) {
      const sweptMarkable = swept
        .flat()
        .map((b) => b.callback_data ?? "")
        .filter((d) => /^food(?:protein)?:/.test(d));
      expect(sweptMarkable.length).toBeGreaterThan(0);
      expect(
        sweptMarkable.filter((d) => /^food(?:protein)?:c:/.test(d))
      ).toEqual(sweptMarkable);
    }
    editMock.mockClear();
    const settled = await reconcileProfileMessages(profileId);
    expect(
      editMock.mock.calls.map((c) => JSON.stringify(c[3])),
      "the sweep is still editing a keyboard it has already settled"
    ).toEqual([]);
    expect(settled.edited).toBe(0);
  });
});

// ── the PRN family: one token, two keyboards ──────────────────────────────────

describe("a prn: tap records which KEYBOARD offered it", () => {
  const CHAT = "5559110";
  let itemId: number;

  beforeEach(() => {
    sendMock.mockClear();
    editMock.mockClear();
  });

  function seedMayMed(tag: string): { profileId: number; itemId: number } {
    const pid = makeProfile(tag);
    seedLoginTelegram(pid, CHAT);
    setTelegramBotConfig({
      telegramBotToken: "bot token 30872",
      telegramMode: "poll",
    });
    const item = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, kind, active, obligation, condition)
           VALUES (?, ?, 'medication', 1, 'may', 'daily')`
        )
        .run(pid, `${tag} Ibuprofen`).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '200 mg', 'anytime', 'any', 0)`
    ).run(item);
    return { profileId: pid, itemId: item };
  }

  it("stores telegram-command for the /dose list, which carries no collapse token", async () => {
    ({ itemId } = seedMayMed("LV3087-dose"));
    await handleIncomingMessage({
      message_id: 1,
      chat: { id: CHAT },
      text: "/dose",
    });
    const list = sentTo(CHAT).at(-1);
    expect(list).toBeDefined();
    const keyboard = keyboardOf(list!.msg);
    const token = keyboard
      .flat()
      .map((b) => b.callback_data ?? "")
      .find((d) => d.startsWith("prn:"));
    expect(token, "the /dose list offered no button").toBeDefined();
    // The tell, asserted directly: this keyboard has nothing to collapse.
    expect(
      keyboard.flat().some((b) => b.callback_data?.startsWith("offerc:"))
    ).toBe(false);

    await handleCallbackQuery(cq(token!, CHAT, keyboard, list!.id));
    expect(itemOrigin(itemId)).toBe("telegram-command");
  });

  it("stores telegram-nudge for the same token on an EXPANDED offer list", async () => {
    // The digest's and the dose reminder's "+ Doses" expansion mints `prn:` through
    // the very same helper the `/dose` list uses (one administration path on
    // Telegram, deliberately). What differs is the keyboard: an expanded offer list
    // is the only one carrying a collapse token, and the stamp now asks that.
    const seeded = seedMayMed("LV3087-offer");
    const keyboard: Button[][] = [
      [
        {
          text: "💊 Ibuprofen",
          callback_data: `prn:${seeded.profileId}:${seeded.itemId}:lv1`,
        },
      ],
      [
        {
          text: "▲ Collapse",
          callback_data: `offerc:${seeded.profileId}:${today(seeded.profileId)}`,
        },
      ],
    ];
    await handleCallbackQuery(
      cq(`prn:${seeded.profileId}:${seeded.itemId}:lv1`, CHAT, keyboard, 4242)
    );
    expect(itemOrigin(seeded.itemId)).toBe("telegram-nudge");
  });
});

// ── the redose notice: one minter, and it is proactive ────────────────────────

describe("a redose notice tap records telegram-nudge", () => {
  const CHAT = "5559120";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T14:00:00Z"));
    sendMock.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("fires the real orchestrator and taps the button it sent", async () => {
    // `redose:` is minted in exactly one place — the safety-tier dispatch that tells
    // someone their redose window has opened. Nothing anybody typed asked for it, and
    // the handler used to stamp `telegram-command` anyway.
    const profileId = makeProfile("LV3087-redose");
    seedLoginTelegram(profileId, CHAT);
    setTelegramBotConfig({
      telegramBotToken: "bot token 30873",
      telegramMode: "poll",
    });
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation,
              redose_notice, min_interval_hours, max_daily_count)
           VALUES (?, 'LV3087 Ibuprofen', 1, 'medication', 'daily', 'may', 1, 6, 4)`
        )
        .run(profileId).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '200 mg', 'anytime', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    // One administration seven hours ago: the window is open.
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, recorded_at, status, logged_via)
       VALUES (?, ?, ?, ?, 'taken', 'page')`
    ).run(doseId, itemId, today(profileId), "2026-06-17 07:00:00");

    await runRedoseNotices(
      profileId,
      "LV3087-redose",
      today(profileId),
      new Date()
    );
    const notice = sentTo(CHAT).find((s) =>
      (s.msg.actions ?? []).some((a) => a.data?.startsWith("redose:"))
    );
    expect(notice, "the orchestrator sent no redose notice").toBeDefined();
    const token = (notice!.msg.actions ?? [])
      .map((a) => a.data ?? "")
      .find((d) => d.startsWith("redose:"))!;

    await handleCallbackQuery(
      cq(token, CHAT, keyboardOf(notice!.msg), notice!.id)
    );
    expect(itemOrigin(itemId)).toBe("telegram-nudge");
  });
});
