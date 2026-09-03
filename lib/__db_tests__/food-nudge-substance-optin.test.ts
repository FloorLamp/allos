// DB INTEGRATION TIER — alcohol rides the Telegram food nudge under the FOOD-buttons
// consent, whatever the substance flag says (owner ruling 2026-09-02, narrowing #3330).
//
// THE HISTORY. Alcohol is the one substance whose `food_daily_totals` counter IS the
// substance ledger, so it reaches the food nudge through the ordinary ranking — a
// "🍷 Alcohol" button, an "🍷 Alcohol ×2" tally line, a "🕐 Alcohol 07:40 · −30m"
// eating-time correction row, and a "🕐 Recorded: Alcohol 18:20 (corrected)" statement in
// the prose. #3330 put every one of those behind `substance_telegram_enabled`, which read
// "off" for every existing profile: the 🍷 button vanished from the nudge that logs most
// drinks and the drinks went unlogged. The owner ruled alcohol a food group for reach —
// the profile-scoped food-buttons consent is the choice — and the substance flag now
// governs only the substance-log ledger, on the recap (recap-substance-optin.test.ts).
//
// WHY THE PREDICATE IS THE WHOLE TRANSPORT. `chatText()` below reads every string the
// transport was asked to put in front of a reader — sent bodies, sent and edited button
// labels, edited text, and callback toasts — and every row asserts over all of it, so a
// gate reintroduced on ANY of the five surfaces (a rebuild, the reconcile sweep editing an
// already-delivered message, the eating-time picker resolved outside the nudge builder)
// fails here rather than silently dropping the drink from one of them.

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
import { setProfileSubstanceTelegram } from "@/lib/settings/notifications";
import { buildFoodNudge } from "@/lib/notifications/food";
import { buildIntakeReminder } from "@/lib/notifications/intake";
import { tickProfile } from "@/lib/notifications/tick";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import { handleIncomingMessage } from "@/lib/notifications/telegram-quick-log";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { FOOD_TIME_PREFIXES } from "@/lib/notifications/correction-rows";
import { correctionAtToken } from "@/lib/correction-time";
import {
  answerCallbackQuery,
  editMessageTextRaw,
  sendMessageRaw,
} from "@/lib/notifications/telegram-api";
import { plainBody } from "@/lib/notifications/rich-text";
import { ALCOHOL_FOOD_GROUP } from "@/lib/substance-use";
import { seedLoginTelegram, seedProfile } from "./fixtures";
import type { NotificationMessage } from "@/lib/notifications/types";

beforeAll(() => stubTelegramSends());
const sendMock = vi.mocked(sendMessageRaw);
const editMock = vi.mocked(editMessageTextRaw);
const answerMock = vi.mocked(answerCallbackQuery);

const NOW = "2026-06-17T08:00:00Z";

// A day's tap on a group, on both ledgers the ranking and the correction offer read.
// `at` is the TAP instant; `stated` (when it differs) is what the row was corrected TO,
// which is what makes a burst read as `corrected`.
function tap(
  profileId: number,
  group: string,
  date: string,
  at: string,
  stated?: string
) {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  return Number(
    db
      .prepare(
        `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at, occurred_at, logged_via)
         VALUES (?, ?, ?, ?, ?, 'page')`
      )
      .run(profileId, group, date, at, stated ?? null).lastInsertRowid
  );
}

// A profile that drinks: three weeks of alcohol beside one ordinary staple, so alcohol
// ranks INSIDE the compact six buttons, and two servings logged ON THE WEB in the last
// half hour, so it also earns a tally entry and a fresh eating-time correction burst.
// Telegram is fully wired and food logging is on — the food-buttons consent is the one
// that governs the drink. A metronidazole course rides along; see the safety row.
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
      tap(
        profileId,
        g,
        shiftDateStr(anchor, -d),
        `${shiftDateStr(anchor, -d)}T08:00:00Z`
      );
  // TODAY'S TAPS ARE SPACED ON PURPOSE, and the spacing is the difference between a
  // fixture that reproduces the defect and one that only looks like it does.
  // `collapseBursts` names a burst ONLY when it has exactly one member (a multi-row burst
  // renders as a count), and BURST_GAP_MIN is 15 minutes — so an earlier version of this
  // fixture, with its two drinks a minute apart beside a serving of greens, produced ONE
  // three-row burst that named nothing, and its correction rows could not have leaked at
  // all. The lone 07:10 drink is the row the eating-time surfaces actually name.
  // ORDER MATTERS TOO: MAX_CORRECTION_ROWS is 2 and the rows render NEWEST FIRST, so the
  // lone drink has to be the newest burst or the cap hides the very row under test.
  //   07:10 greens                 — alone; an ordinary named neighbour
  //   07:30 alcohol + 07:32 greens — MIXED, so the filter meets a burst it must not
  //         delete: dropping the drink leaves a lone greens row, never a gap
  //   07:50 alcohol                — alone and NEWEST, so it is the row the eating-time
  //         surfaces name: "🕐 Alcohol 07:50 · −30m", and the one the picker opens on
  tap(profileId, "leafy_greens", anchor, `${anchor}T07:10:00Z`);
  tap(profileId, ALCOHOL_FOOD_GROUP, anchor, `${anchor}T07:30:00Z`);
  tap(profileId, "leafy_greens", anchor, `${anchor}T07:32:00Z`);
  tap(profileId, ALCOHOL_FOOD_GROUP, anchor, `${anchor}T07:50:00Z`);
  // A drug whose food rule NAMES alcohol, so the safety row below has a tail to protect
  // rather than an absent one it would pass vacuously against (the first version of this
  // spec asserted equality over a reminder that carried no alcohol line at all).
  const medId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Metronidazole', 1, 'medication', 'daily', 'should')`
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '500 mg', 'morning', 'any', 0)`
  ).run(medId);
  return profileId;
}

// The anchor row id of the LONE newest drink — the `fromId` its correction token carries.
// Read off the ledger, ungated, exactly as a keyboard minted before the opt-out still
// holds it, so the picker row fires the token a real stale tap would.
function alcoholFromId(profileId: number): number {
  return (
    db
      .prepare(
        `SELECT MAX(id) AS id FROM food_log_events
          WHERE profile_id = ? AND group_key = ? AND recorded_at >= ?`
      )
      .get(profileId, ALCOHOL_FOOD_GROUP, "2026-06-17T00:00:00Z") as {
      id: number;
    }
  ).id;
}

function textsOf(msg: NotificationMessage): string[] {
  return [plainBody(msg.body), ...(msg.actions ?? []).map((a) => a.label)];
}

// EVERY string this surface put in front of a reader. Sent messages, edited text and its
// keyboard, and callback toasts — the three ways this app speaks into a chat.
function chatText(): string[] {
  const out: string[] = [];
  for (const c of sendMock.mock.calls)
    out.push(...textsOf(c[1] as NotificationMessage));
  for (const c of editMock.mock.calls) {
    out.push(String(c[2] ?? ""));
    const kb = (c[3] as { keyboard?: { text?: string }[][] })?.keyboard ?? [];
    for (const row of kb) for (const b of row) out.push(String(b.text ?? ""));
  }
  for (const c of answerMock.mock.calls) out.push(String(c[1] ?? ""));
  return out;
}

describe("alcohol rides the food nudge under the food-buttons consent, whatever the substance flag says", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    sendMock.mockClear();
    editMock.mockClear();
    answerMock.mockClear();
  });
  // The db tier shares one process: a fake clock left installed here reaches every
  // spec that runs after it.
  afterEach(() => vi.useRealTimers());

  // THE TABLE: every Telegram surface that can name the drink × both states of the
  // substance flag. Five different senders, and they agree because they share one gather —
  // the unbidden tick, the user-typed `/food`, a fully expanded keyboard (a rebuild asks
  // for more buttons than the compact six), the reconcile sweep editing an
  // already-delivered message, and the eating-time picker, whose subject is resolved in
  // `telegram-time-correction.ts` and never passed through the nudge builder at all.
  const SURFACES = [
    "proactive tick send",
    "/food command reply",
    "fully expanded keyboard",
    "reconcile sweep after a web correction",
    "eating-time picker on the drink",
  ] as const;
  type Surface = (typeof SURFACES)[number];

  async function act(
    surface: Surface,
    profileId: number,
    chatId: string
  ): Promise<void> {
    switch (surface) {
      case "proactive tick send":
        await tickProfile(profileId, `p${profileId}`, 5, Date.now());
        return;
      case "/food command reply":
        await handleIncomingMessage({
          message_id: 1,
          chat: { id: chatId },
          text: "/food",
        });
        return;
      case "fully expanded keyboard": {
        // Past the catalog size on purpose: every ranked key renders.
        const msg = buildFoodNudge(profileId, "Morning", today(profileId), 99);
        // Fed through the same transport predicate as every other row.
        if (msg) await sendMock(chatId, msg);
        return;
      }
      case "reconcile sweep after a web correction": {
        await tickProfile(profileId, `p${profileId}`, 5, Date.now());
        // The drink's time is fixed on the Nutrition page — a WEB act, no chat involved.
        // The burst now reads `corrected`, which is what puts it in the message PROSE.
        db.prepare(
          `UPDATE food_log_events SET occurred_at = ?
            WHERE profile_id = ? AND group_key = ? AND occurred_at IS NULL
              AND recorded_at >= ?`
        ).run(
          "2026-06-17T06:20:00Z",
          profileId,
          ALCOHOL_FOOD_GROUP,
          "2026-06-17T00:00:00Z"
        );
        sendMock.mockClear();
        editMock.mockClear();
        answerMock.mockClear();
        await reconcileProfileMessages(profileId);
        return;
      }
      case "eating-time picker on the drink": {
        db.prepare(
          "UPDATE food_log_events SET logged_via = 'telegram-nudge' WHERE id = ?"
        ).run(alcoholFromId(profileId));
        await tickProfile(profileId, `p${profileId}`, 5, Date.now());
        const at = sendMock.mock.calls.findIndex(
          (c) => (c[1] as NotificationMessage).kind === "food"
        );
        const msg = sendMock.mock.calls[at]?.[1] as NotificationMessage;
        // The id the transport actually handed back for THAT send. An unattributed burst
        // rides only the newest live food message in the chat (#2264), so a made-up id
        // would be refused by the binding rather than by anything under test.
        const messageId = (await sendMock.mock.results[at]?.value) as number;
        const open = correctionAtToken(
          FOOD_TIME_PREFIXES.at,
          profileId,
          alcoholFromId(profileId),
          { kind: "open" }
        );
        sendMock.mockClear();
        editMock.mockClear();
        answerMock.mockClear();
        await handleCallbackQuery({
          id: "cbq-3330-picker",
          data: open,
          message: {
            message_id: messageId,
            chat: { id: chatId },
            reply_markup: {
              inline_keyboard: [
                ...(msg?.actions ?? []).map((a) => [
                  { text: a.label, callback_data: a.data },
                ]),
                [{ text: "🕐 Alcohol", callback_data: open }],
              ],
            },
          },
        });
        return;
      }
    }
  }

  it.each(
    SURFACES.flatMap((surface, i) =>
      [false, true].map((substanceFlag, o) => ({
        surface,
        substanceFlag,
        chatId: `55933${i}${o}`,
      }))
    )
  )(
    "$surface names the drink with the substance flag $substanceFlag",
    async ({ surface, substanceFlag, chatId }) => {
      const profileId = seedDrinker(
        `SUB3330-${tag(surface)}-${substanceFlag}`,
        chatId
      );
      setProfileSubstanceTelegram(profileId, substanceFlag);

      await act(surface, profileId, chatId);

      const shown = chatText();
      // The whole claim, over everything the reader can see: the drink is named on this
      // surface under the food consent alone.
      expect(shown.length, "the surface said nothing at all").toBeGreaterThan(
        0
      );
      expect(shown.some((t) => t.includes("Alcohol"))).toBe(true);
    }
  );

  // A stable, safe fragment of the surface name for the seeded profile's tag.
  function tag(surface: Surface): string {
    return surface.replace(/[^a-z]+/gi, "-");
  }

  // The consent that governs is the FOOD one, and it is per profile: a subject with food
  // buttons off contributes nothing to the shared chat, drink or otherwise.
  it("the food-buttons consent is the gate, per profile", async () => {
    const chatId = "5593390";
    const drinking = seedDrinker("SUB3330-house-A", chatId);
    const foodOff = seedDrinker("SUB3330-house-B", chatId);
    setProfileSetting(foodOff, "food_telegram_enabled", "0");

    await tickProfile(drinking, "house-A", 5, Date.now());
    const afterFirst = chatText().filter((t) => t.includes("Alcohol")).length;
    await tickProfile(foodOff, "house-B", 5, Date.now());
    const afterSecond = chatText().filter((t) => t.includes("Alcohol")).length;

    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBe(afterFirst);
  });

  // THE OTHER FAILURE. A gate on a notification path can silence a safety signal as
  // easily as it can stop a leak, so the dose reminder — same profile, same chat, same
  // slot, and carrying a metronidazole course whose food rule NAMES alcohol — is rendered
  // in both states and compared. The positive assertion is what makes the equality mean
  // something: without it the two would match just as well if the tail were gated away.
  it.each([
    [
      "dose reminder's alcohol food-interaction tail",
      (p: number) => buildIntakeReminder(p, "Morning"),
    ],
  ])("%s survives a substance opt-out, byte for byte", (_label, build) => {
    const profileId = seedDrinker("SUB3330-safety", "5593391");
    setProfileSubstanceTelegram(profileId, false);
    const off = build(profileId);
    setProfileSubstanceTelegram(profileId, true);
    const on = build(profileId);
    expect(off).not.toBeNull();
    expect(plainBody(off!.body)).toMatch(/Avoid all alcohol/);
    expect(off).toEqual(on);
  });
});
