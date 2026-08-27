// DB INTEGRATION TIER — the composed "your usual <window>" one-tap on Telegram (#2460).
//
// The pure half (the token, the byte cliff, what the attachment says, the two ways a
// message carrying it is unfit to send) is lib/__tests__/callback-data.test.ts and
// lib/__tests__/usual-routine-attach.test.ts. What needs a database is everything that
// makes the button HONEST:
//
//   • the stored offer is an UPPER BOUND — a forged, replayed or stale offer id writes
//     only what the offer named AND what still stands;
//   • the composed answer never claims more than was written, partials included;
//   • the placement rule: the dose reminder takes it, the food nudge otherwise, never
//     both, nowhere when neither sends;
//   • the re-render REDUCES and then removes.

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
import { sendMessageRaw } from "@/lib/notifications/telegram-api";
import { plainBody } from "@/lib/notifications/rich-text";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  answerCallbackQuery,
  editMessageTextRaw,
} from "@/lib/notifications/telegram-api";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import { buildFoodNudge } from "@/lib/notifications/food";
import { deliveredKeyboard } from "@/lib/notifications/delivered-keyboard";
import { attachUsualRoutine } from "@/lib/notifications/usual-routine-attach";
import {
  messagePointerAt,
  recordMessagePointer,
} from "@/lib/notifications/message-pointers";
import { seedLoginTelegram } from "./fixtures";
import {
  mintUsualRoutineAttachment,
  standingUsualOffer,
  USUAL_OFFER_FAMILY,
} from "@/lib/notifications/usual-routine-attach";
import {
  attachUsualForSlots,
  planUsualRoutine,
} from "@/lib/notifications/usual-routine-plan";
import {
  offerCallback,
  parseOfferCallback,
} from "@/lib/notifications/callback-data";
import { mintOffer, readOffer } from "@/lib/notifications/offer-store";
import { getUsualRoutineOffer } from "@/lib/queries/usual-routine";
import type { NotificationMessage } from "@/lib/notifications/types";

beforeAll(() => stubTelegramSends());

const answerMock = vi.mocked(answerCallbackQuery);
const editTextMock = vi.mocked(editMessageTextRaw);
const sendMock = vi.mocked(sendMessageRaw);

// What the chat is showing NOW, read back off the pointer the chokepoint syncs — the
// only record of a delivered keyboard there is.
function deliveredKeyboardNow(profileId: number, messageId: number) {
  return messagePointerAt(profileId, "5552470", messageId)?.keyboard ?? [];
}
const CHAT = "5552460";
const OTHER_CHAT = "5552461";

function lastAnswerText(): string | undefined {
  return answerMock.mock.calls.at(-1)?.[1];
}

// A BARE profile — no seeded intake items, so every dose in a bundle below is one this
// spec put there. UTC with the default 11:00/15:00 boundaries, so an 08:00Z tap is
// unambiguously Morning.
function makeProfile(tag: string): { profileId: number } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(tag)
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  return { profileId };
}

// One food tap: the day counter plus its ledger event, at a fixed UTC wall time.
function tap(profileId: number, group: string, date: string, hhmmss: string) {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key)
       DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, group, date, `${date}T${hhmmss}Z`);
}

function mkItem(profileId: number, name: string, obligation = "should") {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'supplement', 'daily', ?)`
      )
      .run(profileId, name, obligation).lastInsertRowid
  );
}

function mkDose(itemId: number, retired = 0) {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, retired)
         VALUES (?, '1 cap', 'morning', 'any', 0, ?)`
      )
      .run(itemId, retired).lastInsertRowid
  );
}

// A habitual Morning pair — the #2380 shape: two groups on every one of the last
// 21 mornings, which is what makes `usualFoodOffer` stand at all.
function seedHabitualMornings(profileId: number, groups: readonly string[]) {
  const anchor = today(profileId);
  for (let d = 1; d <= 21; d++) {
    const date = shiftDateStr(anchor, -d);
    for (const g of groups) tap(profileId, g, date, "08:00:00");
  }
}

function servingsToday(profileId: number, group: string): number {
  const row = db
    .prepare(
      `SELECT servings FROM food_daily_totals
        WHERE profile_id = ? AND date = ? AND group_key = ?`
    )
    .get(profileId, today(profileId), group) as
    { servings: number } | undefined;
  return row?.servings ?? 0;
}

function doseLogs(doseId: number, date: string) {
  return db
    .prepare(
      `SELECT status, notify_message_id FROM intake_item_logs
        WHERE dose_id = ? AND date = ?`
    )
    .all(doseId, date) as {
    status: string;
    notify_message_id: number | null;
  }[];
}

// A callback_query as Telegram delivers it, on a keyboard that names its HOST family —
// which is what the handler reads to decide how to rebuild (#2460's host inheritance).
function cq(
  data: string,
  chatId: string,
  host: "dose" | "food" | "none" = "dose"
) {
  const hostToken =
    host === "dose"
      ? "all:1:Morning:2026-08-19"
      : host === "food"
        ? "food:1:Morning:2026-08-19:berries"
        : null;
  return {
    id: "cbq-2460",
    data,
    message: {
      message_id: 4242,
      chat: { id: chatId },
      text: "Morning",
      reply_markup: {
        inline_keyboard: [
          [{ text: "usual", callback_data: data }],
          ...(hostToken ? [[{ text: "host", callback_data: hostToken }]] : []),
        ],
      },
    },
  };
}

describe("the composed one-tap's offer and write (#2460)", () => {
  let sp: { profileId: number };
  let doseA: number;
  let doseB: number;
  let retiredDose: number;
  let foreign: { profileId: number };
  let foreignDose: number;

  beforeAll(() => {
    sp = makeProfile("TG2460");
    setTimezone(sp.profileId, "UTC");
    seedLoginTelegram(sp.profileId, CHAT);
    setProfileSetting(sp.profileId, "food_telegram_enabled", "1");
    seedHabitualMornings(sp.profileId, ["fermented", "berries"]);
    doseA = mkDose(mkItem(sp.profileId, "TG2460 Creatine"));
    doseB = mkDose(mkItem(sp.profileId, "TG2460 Collagen"));
    retiredDose = mkDose(mkItem(sp.profileId, "TG2460 Retired"), 1);
    foreign = makeProfile("TG2460B");
    setTimezone(foreign.profileId, "UTC");
    seedLoginTelegram(foreign.profileId, OTHER_CHAT);
    foreignDose = mkDose(mkItem(foreign.profileId, "TG2460 Foreign"));
  });

  it("the standing offer is both halves, and the token names it in constant size", () => {
    const offer = getUsualRoutineOffer(
      sp.profileId,
      "Morning",
      today(sp.profileId)
    );
    expect([...(offer?.groups ?? [])].sort()).toEqual(["berries", "fermented"]);
    expect(offer?.doses.map((d) => d.doseId).sort()).toEqual(
      [doseA, doseB].sort()
    );
    const attachment = mintUsualRoutineAttachment(
      sp.profileId,
      "Morning",
      today(sp.profileId)
    );
    // The whole point of the stored offer: the token names an id, not the sets, so its
    // size does not move when the routine grows.
    expect(attachment?.token).toMatch(/^usual:\d+:\d+$/);
    expect(attachment?.line).toContain("Fermented foods");
    expect(attachment?.line).toContain("TG2460 Creatine");
    expect(attachment?.label).toContain("(4)");
  });

  it("stores the bundle as IDS, and the payload is exactly what the offer named", () => {
    const date = today(sp.profileId);
    const a = mintUsualRoutineAttachment(sp.profileId, "Morning", date)!;
    const offerId = parseOfferCallback(a.token, "usual")!.offerId;
    expect(
      readOffer<{ window: string; groups: string[]; doseIds: number[] }>(
        sp.profileId,
        USUAL_OFFER_FAMILY,
        offerId,
        date
      )
    ).toEqual({
      window: "Morning",
      groups: expect.arrayContaining(["fermented", "berries"]),
      doseIds: [doseA, doseB],
    });
  });

  it("an offer is unreadable for another profile, another family, or another day", () => {
    const date = today(sp.profileId);
    const a = mintUsualRoutineAttachment(sp.profileId, "Morning", date)!;
    const offerId = parseOfferCallback(a.token, "usual")!.offerId;
    expect(
      readOffer(foreign.profileId, USUAL_OFFER_FAMILY, offerId, date)
    ).toBeNull();
    expect(
      readOffer(
        sp.profileId,
        USUAL_OFFER_FAMILY,
        offerId,
        shiftDateStr(date, -1)
      )
    ).toBeNull();
    // And the same id in another family is not this family's payload.
    expect(
      readOffer(sp.profileId, "usual-routine", offerId + 999999, date)
    ).toBeNull();
  });

  it("one tap writes BOTH halves and answers with what was written", async () => {
    const date = today(sp.profileId);
    const a = mintUsualRoutineAttachment(sp.profileId, "Morning", date)!;
    await handleCallbackQuery(cq(a.token, CHAT));
    expect(servingsToday(sp.profileId, "fermented")).toBe(1);
    expect(servingsToday(sp.profileId, "berries")).toBe(1);
    expect(doseLogs(doseA, date).map((r) => r.status)).toEqual(["taken"]);
    expect(doseLogs(doseB, date).map((r) => r.status)).toEqual(["taken"]);
    const answer = lastAnswerText() ?? "";
    // Both group names, in the words the line promised them in.
    expect(answer).toContain("Fermented foods");
    expect(answer).toContain("Berries");
    expect(answer).toContain("2 doses taken");
  });

  it("a second tap answers nothing-to-log and writes nothing more", async () => {
    const date = today(sp.profileId);
    const a = mintUsualRoutineAttachment(sp.profileId, "Morning", date);
    // The offer no longer stands at all — everything it would name is logged.
    expect(a).toBeNull();
    // …and replaying the ORIGINAL token is the same refusal, with no second serving.
    const stale = db
      .prepare(
        `SELECT id FROM notify_offers WHERE profile_id = ? ORDER BY id LIMIT 1`
      )
      .get(sp.profileId) as { id: number };
    await handleCallbackQuery(
      cq(offerCallback("usual", sp.profileId, stale.id), CHAT)
    );
    expect(servingsToday(sp.profileId, "fermented")).toBe(1);
    expect(doseLogs(doseA, date)).toHaveLength(1);
    expect(lastAnswerText()).toBe("Nothing left to log");
  });
});

describe("the stored offer is an upper bound, never an instruction (#2460)", () => {
  let sp: { profileId: number };
  let doseA: number;
  let retiredDose: number;
  let foreign: { profileId: number };
  let foreignDose: number;

  beforeAll(() => {
    sp = makeProfile("TG2460C");
    setTimezone(sp.profileId, "UTC");
    seedLoginTelegram(sp.profileId, "5552462");
    setProfileSetting(sp.profileId, "food_telegram_enabled", "1");
    seedHabitualMornings(sp.profileId, ["fermented", "berries"]);
    doseA = mkDose(mkItem(sp.profileId, "TG2460C Creatine"));
    retiredDose = mkDose(mkItem(sp.profileId, "TG2460C Retired"), 1);
    foreign = makeProfile("TG2460D");
    setTimezone(foreign.profileId, "UTC");
    foreignDose = mkDose(mkItem(foreign.profileId, "TG2460D Foreign"));
  });

  it("a FORGED offer — another profile's dose, a retired dose, an unhabitual group — writes only the standing bundle", async () => {
    const date = today(sp.profileId);
    // The upper bound a tampered store (or a bug) could hold: two ids outside the
    // profile's standing set and a group it has never eaten in this window.
    const offerId = mintOffer(sp.profileId, USUAL_OFFER_FAMILY, date, {
      window: "Morning",
      groups: ["fermented", "berries", "red_meat"],
      doseIds: [doseA, retiredDose, foreignDose],
    });
    await handleCallbackQuery(
      cq(offerCallback("usual", sp.profileId, offerId), "5552462")
    );
    expect(servingsToday(sp.profileId, "fermented")).toBe(1);
    expect(servingsToday(sp.profileId, "berries")).toBe(1);
    // Outside the re-derived offer: nothing written, and nothing said about it —
    // naming it would leak whether the id exists.
    expect(servingsToday(sp.profileId, "red_meat")).toBe(0);
    expect(doseLogs(doseA, date).map((r) => r.status)).toEqual(["taken"]);
    expect(doseLogs(retiredDose, date)).toEqual([]);
    expect(doseLogs(foreignDose, date)).toEqual([]);
    expect(lastAnswerText()).not.toContain("Red meat");
  });

  it("a tap from a chat the offer's profile does not share writes nothing", async () => {
    const sp2 = makeProfile("TG2460E");
    setTimezone(sp2.profileId, "UTC");
    setProfileSetting(sp2.profileId, "food_telegram_enabled", "1");
    seedHabitualMornings(sp2.profileId, ["fermented", "berries"]);
    const date = today(sp2.profileId);
    const offerId = mintOffer(sp2.profileId, USUAL_OFFER_FAMILY, date, {
      window: "Morning",
      groups: ["fermented", "berries"],
      doseIds: [],
    });
    // The token names sp2, but it arrives from a chat sp2 has no login on.
    await handleCallbackQuery(
      cq(offerCallback("usual", sp2.profileId, offerId), "5552462")
    );
    expect(servingsToday(sp2.profileId, "fermented")).toBe(0);
  });

  it("an offer minted YESTERDAY refuses and writes nothing — no date crosses the wire", async () => {
    const sp3 = makeProfile("TG2460F");
    setTimezone(sp3.profileId, "UTC");
    seedLoginTelegram(sp3.profileId, "5552463");
    setProfileSetting(sp3.profileId, "food_telegram_enabled", "1");
    seedHabitualMornings(sp3.profileId, ["fermented", "berries"]);
    const yesterday = shiftDateStr(today(sp3.profileId), -1);
    const offerId = mintOffer(sp3.profileId, USUAL_OFFER_FAMILY, yesterday, {
      window: "Morning",
      groups: ["fermented", "berries"],
      doseIds: [],
    });
    await handleCallbackQuery(
      cq(offerCallback("usual", sp3.profileId, offerId), "5552463")
    );
    // The whole point of the day-scoped row: the bundle cannot be backfilled into
    // today, and it cannot be written to yesterday either.
    expect(servingsToday(sp3.profileId, "fermented")).toBe(0);
    // The seeded history for that day is untouched: one row per group, one serving
    // each — nothing was appended to yesterday either.
    expect(
      db
        .prepare(
          `SELECT SUM(servings) AS n FROM food_daily_totals
            WHERE profile_id = ? AND date = ?`
        )
        .get(sp3.profileId, yesterday) as { n: number }
    ).toEqual({ n: 2 });
  });
});

describe("a dose refusing mid-bundle leaves the food set committed (#2460)", () => {
  it("names the partial truth and keeps the servings", async () => {
    const sp = makeProfile("TG2460G");
    setTimezone(sp.profileId, "UTC");
    seedLoginTelegram(sp.profileId, "5552464");
    setProfileSetting(sp.profileId, "food_telegram_enabled", "1");
    seedHabitualMornings(sp.profileId, ["fermented", "berries"]);
    const itemA = mkItem(sp.profileId, "TG2460G Creatine");
    const doseA = mkDose(itemA);
    const itemB = mkItem(sp.profileId, "TG2460G Magnesium");
    const doseB = mkDose(itemB);
    const date = today(sp.profileId);
    const a = mintUsualRoutineAttachment(sp.profileId, "Morning", date)!;
    // Between render and tap, one item is PAUSED — the honest partial: the food that
    // was genuinely eaten stays logged and the answer says which dose did not land.
    db.prepare(`UPDATE intake_items SET active = 0 WHERE id = ?`).run(itemB);
    await handleCallbackQuery(cq(a.token, "5552464"));
    expect(servingsToday(sp.profileId, "fermented")).toBe(1);
    expect(servingsToday(sp.profileId, "berries")).toBe(1);
    expect(doseLogs(doseA, date).map((r) => r.status)).toEqual(["taken"]);
    expect(doseLogs(doseB, date)).toEqual([]);
    const answer = lastAnswerText() ?? "";
    expect(answer).toContain("Fermented foods");
    expect(answer).toContain("Berries");
    expect(answer).toContain("1 dose taken");
    // It may never claim the paused dose was taken, and it may never round the count
    // up to the offer's.
    expect(answer).not.toContain("2 doses");
  });
});

describe("both halves stamp the message they were tapped from (#2264/#2460)", () => {
  it("records notify_message_id on the food row and the dose row alike", async () => {
    const sp = makeProfile("TG2460H");
    setTimezone(sp.profileId, "UTC");
    seedLoginTelegram(sp.profileId, "5552465");
    setProfileSetting(sp.profileId, "food_telegram_enabled", "1");
    seedHabitualMornings(sp.profileId, ["fermented", "berries"]);
    const doseA = mkDose(mkItem(sp.profileId, "TG2460H Creatine"));
    const date = today(sp.profileId);
    // The pointer the tap arrives from.
    const pointerId = Number(
      db
        .prepare(
          `INSERT INTO notify_messages
             (profile_id, chat_id, message_id, kind, date, keyboard, sent_at)
           VALUES (?, ?, ?, 'dose', ?, '[]', datetime('now'))`
        )
        .run(sp.profileId, "5552465", 4242, date).lastInsertRowid
    );
    const a = mintUsualRoutineAttachment(sp.profileId, "Morning", date)!;
    await handleCallbackQuery(cq(a.token, "5552465"));
    expect(doseLogs(doseA, date)[0]?.notify_message_id).toBe(pointerId);
    const foodRows = db
      .prepare(
        `SELECT notify_message_id FROM food_log_events
          WHERE profile_id = ? AND date = ?`
      )
      .all(sp.profileId, date) as { notify_message_id: number | null }[];
    expect(foodRows).toHaveLength(2);
    for (const r of foodRows) expect(r.notify_message_id).toBe(pointerId);
  });
});

describe("the placement rule is the slot send-plan's (#2460)", () => {
  let sp: { profileId: number };

  beforeAll(() => {
    sp = makeProfile("TG2460I");
    setTimezone(sp.profileId, "UTC");
    setProfileSetting(sp.profileId, "food_telegram_enabled", "1");
    seedHabitualMornings(sp.profileId, ["fermented", "berries"]);
  });

  const message = (): NotificationMessage => ({
    title: "Morning",
    body: "body",
    actions: [{ label: "All", data: "all:1:Morning:2026-08-19" }],
    kind: "dose",
  });

  it("the dose reminder takes it when it sends, and the food nudge then gets nothing", () => {
    const plan = planUsualRoutine(
      sp.profileId,
      "Morning",
      today(sp.profileId),
      true
    )!;
    const dose = attachUsualForSlots(
      message(),
      ["Morning"],
      new Map([["Morning", plan]])
    );
    expect(plan.claimedBy).toBe("dose");
    expect(dose.actions?.[0]?.data).toMatch(/^usual:/);
    // The SAME plan, offered to the food nudge second: there is nothing left to give.
    expect(plan.claim("food")).toBeNull();
  });

  it("the food nudge gets it when the dose reminder does not send", () => {
    const plan = planUsualRoutine(
      sp.profileId,
      "Morning",
      today(sp.profileId),
      true
    )!;
    // No dose reminder was built, so nothing claimed for the dose host.
    expect(plan.claimedBy).toBeNull();
    expect(plan.claim("food")).not.toBeNull();
    expect(plan.claimedBy).toBe("food");
  });

  it("a merged reminder that does NOT cover the window leaves the bundle unclaimed", () => {
    const plan = planUsualRoutine(
      sp.profileId,
      "Morning",
      today(sp.profileId),
      true
    )!;
    // A Bedtime-only reminder must not carry the Morning bundle.
    const out = attachUsualForSlots(
      message(),
      ["Bedtime"],
      new Map([["Morning", plan]])
    );
    expect(out).toEqual(message());
    expect(plan.claimedBy).toBeNull();
  });

  it("is absent for a profile that has not opted into food buttons in chat", () => {
    // The bundle always contains food writes, and food-buttons-in-chat is an
    // expressed opt-in — so the gate removes the whole button, on both hosts.
    expect(
      planUsualRoutine(sp.profileId, "Morning", today(sp.profileId), false)
    ).toBeNull();
  });

  it("is absent for a window with no standing habitual set", () => {
    expect(
      planUsualRoutine(sp.profileId, "Evening", today(sp.profileId), true)
    ).toBeNull();
  });
});

describe("the re-render reduces, then removes (#2460)", () => {
  it("names only what still stands, and nothing at all once the food half falls below its floor", () => {
    const sp = makeProfile("TG2460J");
    setProfileSetting(sp.profileId, "food_telegram_enabled", "1");
    // THREE habitual groups, so the reduction has somewhere to land: the food offer's
    // own floor is FOOD_USUAL_MIN_GROUPS (2), and at two groups a single log takes the
    // whole offer away rather than shrinking it.
    seedHabitualMornings(sp.profileId, ["fermented", "berries", "eggs"]);
    const itemA = mkItem(sp.profileId, "TG2460J Creatine");
    const doseA = mkDose(itemA);
    const itemB = mkItem(sp.profileId, "TG2460J Collagen");
    const doseB = mkDose(itemB);
    const date = today(sp.profileId);
    const a = mintUsualRoutineAttachment(sp.profileId, "Morning", date)!;
    const offerId = parseOfferCallback(a.token, "usual")!.offerId;
    expect(
      [
        ...(standingUsualOffer(sp.profileId, offerId, date)?.groups ?? []),
      ].sort()
    ).toEqual(["berries", "eggs", "fermented"]);

    // One group and one dose logged ELSEWHERE (the web bar, another chat): the
    // re-render REDUCES — each falls out of the named set, the rest still stands.
    tap(sp.profileId, "fermented", date, "08:00:00");
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, 'taken')`
    ).run(doseA, itemA, date);
    const reduced = standingUsualOffer(sp.profileId, offerId, date);
    expect([...(reduced?.groups ?? [])].sort()).toEqual(["berries", "eggs"]);
    expect(reduced?.doses.map((d) => d.doseId)).toEqual([doseB]);

    // …and it can never GROW past what was offered. `red_meat` becomes habitual after
    // the offer was minted; the stored offer is the upper bound, so it is not in it.
    for (let d = 1; d <= 21; d++) {
      tap(sp.profileId, "red_meat", shiftDateStr(date, -d), "08:10:00");
    }
    expect(
      standingUsualOffer(sp.profileId, offerId, date)?.groups
    ).not.toContain("red_meat");

    // Down to one group and one dose: still TWO writes, so the bundle still saves a
    // tap and still stands.
    tap(sp.profileId, "berries", date, "08:05:00");
    const twoLeft = standingUsualOffer(sp.profileId, offerId, date);
    expect(twoLeft?.groups).toEqual(["eggs"]);
    expect(twoLeft?.doses.map((d) => d.doseId)).toEqual([doseB]);

    // One write left is one tap either way — the row beneath it is the faster path —
    // so the button goes rather than shrinking to a rename of a button already there.
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, 'taken')`
    ).run(doseB, itemB, date);
    expect(standingUsualOffer(sp.profileId, offerId, date)).toBeNull();
  });

  // THE FOOD HALF IS THE GATE, NOT MERELY A CONTRIBUTOR (#2460). The floor above is a
  // COUNT, and a count alone would let a stale offer degrade into a dose-only bundle:
  // the groups it named have all been logged, other groups have since become habitual
  // so the food offer still stands, and the intersection is empty while two doses
  // remain. There has never been a dose-only shape of this offer — the rows beneath it
  // already are the dose one-taps — so the answer is no bundle, not a smaller one.
  it("is null once NONE of the offered groups still stands, however many doses remain", () => {
    const sp = makeProfile("TG2460R");
    setProfileSetting(sp.profileId, "food_telegram_enabled", "1");
    seedHabitualMornings(sp.profileId, ["fermented", "berries"]);
    const itemA = mkItem(sp.profileId, "TG2460R Creatine");
    const doseA = mkDose(itemA);
    const itemB = mkItem(sp.profileId, "TG2460R Collagen");
    const doseB = mkDose(itemB);
    const date = today(sp.profileId);
    const a = mintUsualRoutineAttachment(sp.profileId, "Morning", date)!;
    const offerId = parseOfferCallback(a.token, "usual")!.offerId;
    expect(
      standingUsualOffer(sp.profileId, offerId, date)?.groups
    ).toHaveLength(2);

    // Both offered groups logged today, and two OTHER groups become habitual — so the
    // food offer still stands for this window, but none of what THIS offer named does.
    tap(sp.profileId, "fermented", date, "08:00:00");
    tap(sp.profileId, "berries", date, "08:01:00");
    for (let d = 1; d <= 21; d++) {
      tap(sp.profileId, "eggs", shiftDateStr(date, -d), "08:10:00");
      tap(sp.profileId, "red_meat", shiftDateStr(date, -d), "08:11:00");
    }
    // The window's own offer is alive — otherwise this test would pass for the wrong
    // reason, on the `!fresh` return one line earlier.
    const fresh = getUsualRoutineOffer(sp.profileId, "Morning", date);
    expect(fresh?.groups.length).toBeGreaterThanOrEqual(2);
    // Both doses are still owed, so the COUNT floor is comfortably satisfied…
    expect(fresh?.doses.map((d) => d.doseId).sort()).toEqual(
      [doseA, doseB].sort()
    );
    // …and the answer is still nothing, because the gate is the food half itself.
    expect(standingUsualOffer(sp.profileId, offerId, date)).toBeNull();
  });
});

// THE SWEEP (#2460). The bundle is host-inherited, so the families rebuild through
// builders that know nothing about it. Two properties have to hold anyway, and they
// pull in opposite directions: the sweep must NOT drop a bundle that still stands, and
// it must NOT edit a message on which nothing has changed. Both are pinned here because
// the natural implementation — attach at the send chokepoint only — satisfies the first
// and breaks the second: the plan's keyboard would differ from the delivered one on
// every single tick.
describe("the reconcile sweep keeps the bundle honest (#2460)", () => {
  const SWEEP_CHAT = "5552470";

  function setup(tag: string) {
    const sp = makeProfile(tag);
    seedLoginTelegram(sp.profileId, SWEEP_CHAT);
    setProfileSetting(sp.profileId, "food_telegram_enabled", "1");
    seedHabitualMornings(sp.profileId, ["fermented", "berries", "eggs"]);
    const date = today(sp.profileId);
    const a = mintUsualRoutineAttachment(sp.profileId, "Morning", date)!;
    // The food nudge AS DELIVERED — built by the real builder and decorated by the real
    // attachment, so the pointer holds what a genuine send would have left behind. A
    // hand-written keyboard would make the zero-call pin below vacuous: the sweep would
    // differ from it for reasons that have nothing to do with the bundle.
    const nudge = attachUsualRoutine(
      buildFoodNudge(sp.profileId, "Morning", date)!,
      a
    );
    recordMessagePointer({
      profileId: sp.profileId,
      chatId: SWEEP_CHAT,
      messageId: 2470,
      kind: "food",
      date,
      title: "🍽️ Morning food log",
      keyboard: deliveredKeyboard(nudge),
    });
    return { sp, date, a };
  }

  it("leaves a message alone when nothing about the bundle has changed", async () => {
    const { sp } = setup("TG2460K");
    const before = editTextMock.mock.calls.length;
    const out = await reconcileProfileMessages(sp.profileId);
    // The zero-call steady state. A sweep that re-planned the keyboard WITHOUT the
    // bundle would see a difference here on every tick and edit forever.
    expect(out.edited).toBe(0);
    expect(editTextMock.mock.calls.length).toBe(before);
  });

  it("re-renders REDUCED rather than dropping a bundle that still stands", async () => {
    const { sp, date, a } = setup("TG2460L");
    // One half logged elsewhere: the bundle shrinks but does not go.
    tap(sp.profileId, "fermented", date, "08:00:00");
    await reconcileProfileMessages(sp.profileId);
    const keyboard = deliveredKeyboardNow(sp.profileId, 2470);
    const tokens = keyboard.flat().map((b) => b.callback_data);
    expect(tokens).toContain(a.token);
    // …and what it now promises is the smaller set.
    const text = String(editTextMock.mock.calls.at(-1)?.[2] ?? "");
    expect(text).not.toContain("Fermented foods");
    expect(text).toContain("Berries");
  });

  it("removes the button once the bundle no longer stands, keeping the host's rows", async () => {
    const { sp, date, a } = setup("TG2460M");
    tap(sp.profileId, "fermented", date, "08:00:00");
    tap(sp.profileId, "berries", date, "08:01:00");
    tap(sp.profileId, "eggs", date, "08:02:00");
    await reconcileProfileMessages(sp.profileId);
    const tokens = deliveredKeyboardNow(sp.profileId, 2470)
      .flat()
      .map((b) => b.callback_data);
    expect(tokens).not.toContain(a.token);
    // The food nudge itself is untouched — its quick-log rows never resolve.
    expect(tokens.some((t) => t?.startsWith("food:"))).toBe(true);
  });
});

// NEVER BOTH, THROUGH THE REAL TICK (#2460). The plan's one-shot claim makes two
// buttons structurally impossible, but only if the two call sites are wired the way the
// priority rule says. That wiring is what this drives: the whole per-profile tick, with
// only the Telegram transport stubbed, asserting on what actually went on the wire.
describe("the composed one-tap rides exactly one of the window's sends (#2460)", () => {
  const TICK_CHAT = "5552480";

  function setupTick(tag: string, opts: { pendingDose: boolean }) {
    const sp = makeProfile(tag);
    seedLoginTelegram(sp.profileId, TICK_CHAT);
    setTelegramBotConfig({
      telegramBotToken: "bot token 24601",
      telegramMode: "poll",
    });
    setProfileSetting(sp.profileId, "food_telegram_enabled", "1");
    // Morning at 08:00, every other window off, so exactly one slot is due.
    setProfileSetting(sp.profileId, "notify_supp_morning_hour", "08:00");
    for (const k of [
      "notify_supp_midday_hour",
      "notify_supp_evening_hour",
      "notify_supp_bedtime_hour",
      "notify_digest_hour",
    ])
      setProfileSetting(sp.profileId, k, "");
    seedHabitualMornings(sp.profileId, ["fermented", "berries", "eggs"]);
    if (opts.pendingDose) mkDose(mkItem(sp.profileId, `${tag} Creatine`));
    return sp;
  }

  // Every message that actually went to this chat on the last tick, with its tokens.
  function sentMessages() {
    return sendMock.mock.calls
      .filter((c) => String(c[0]) === TICK_CHAT)
      .map((c) => c[1] as NotificationMessage)
      .map((m) => ({
        kind: m.kind,
        tokens: (m.actions ?? []).map((a) => a.data).filter(Boolean),
        body: plainBody(m.body),
      }));
  }

  const usualCount = (msgs: ReturnType<typeof sentMessages>) =>
    msgs.filter((m) =>
      m.tokens.some((t) => parseOfferCallback(t, "usual") != null)
    );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T08:00:00Z"));
    sendMock.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("the DOSE REMINDER takes it when both messages fire", async () => {
    const sp = setupTick("TG2460N", { pendingDose: true });
    await tickProfile(sp.profileId, "TG2460N", 5, Date.now());
    const msgs = sentMessages();
    // Both hosts really did send — otherwise "never both" would be vacuous here.
    expect(msgs.map((m) => m.kind).sort()).toEqual(["dose", "food"]);
    const carrying = usualCount(msgs);
    expect(carrying).toHaveLength(1);
    expect(carrying[0].kind).toBe("dose");
    // The message NAMES the full composed set on a line of its own.
    expect(carrying[0].body).toContain("Your usual Morning");
    expect(carrying[0].body).toContain("TG2460N Creatine");
  });

  it("the FOOD NUDGE takes it when the dose reminder has nothing to send", async () => {
    const sp = setupTick("TG2460O", { pendingDose: false });
    await tickProfile(sp.profileId, "TG2460O", 5, Date.now());
    const msgs = sentMessages();
    expect(msgs.map((m) => m.kind)).toEqual(["food"]);
    const carrying = usualCount(msgs);
    expect(carrying).toHaveLength(1);
    expect(carrying[0].kind).toBe("food");
  });

  it("nowhere for a profile that has not opted into food buttons in chat", async () => {
    const sp = setupTick("TG2460P", { pendingDose: true });
    setProfileSetting(sp.profileId, "food_telegram_enabled", "0");
    await tickProfile(sp.profileId, "TG2460P", 5, Date.now());
    const msgs = sentMessages();
    // The dose reminder still goes out — it is not gated on the food opt-in — and it
    // carries no bundle, because the bundle always contains food writes.
    expect(msgs.map((m) => m.kind)).toEqual(["dose"]);
    expect(usualCount(msgs)).toHaveLength(0);
  });
});
