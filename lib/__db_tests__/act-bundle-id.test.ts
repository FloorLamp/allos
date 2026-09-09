// DB INTEGRATION TIER — one act id across every table a composed write touches (#5082).
//
// The pair below is the whole criterion, and BOTH halves are load-bearing. A test that
// only asserted the stamp would pass against a writer that stamps everything — and a
// writer that stamps everything destroys the reading the Day ledger depends on, where a
// row with NO bundle means "stated on its own" (lib/day-ledger.ts). So the null case is
// not a completeness nicety; it is the other half of the same claim.
//
// The stamped assertion counts DISTINCT ids across the tap's rows rather than checking
// that each row has some id: "they were one act" is a statement about the SET, and four
// rows each carrying their own fresh bundle would satisfy the per-row form.
//
// Fixtures are synthetic throwaway rows (per-file temp DB via setup.ts). No PHI.

import { beforeEach, describe, it, expect, vi } from "vitest";
import { db, rawDb, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  setTimezone,
  setTelegramBotConfig,
  setProfileFoodTelegram,
  setProfileMutedForLogin,
} from "@/lib/settings";
import { logFoodServingCore } from "@/lib/food-log-write";
import { logUsualRoutineCore } from "@/lib/usual-routine-write";
import { markDoseTaken } from "@/lib/queries/intake/adherence";
import {
  getRecentCorrectionBundles,
  readCorrectionBundle,
  restampCorrectionBundle,
} from "@/lib/bundle-time-correction";
import {
  correctionBundleBinding,
  dropMessagePointer,
  messagePointerAt,
  recordMessagePointer,
  syncMessagePointerKeyboard,
} from "@/lib/notifications/message-pointers";
import { slotSessionForKeyboard } from "@/lib/notifications/intake";
import { mintOffer } from "@/lib/notifications/offer-store";
import { getRecentFoodTaps } from "@/lib/queries/nutrition";
import { seedLoginTelegram } from "./fixtures";
import {
  stubTelegramSends,
  answerCallbackQuery as answerSpy,
  editMessageTextRaw as editSpy,
} from "./telegram-spies";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  handleFoodTimeChip,
  handleDoseTimeChip,
} from "@/lib/notifications/telegram-time-correction";
import { parseCorrectionChipToken } from "@/lib/correction-time";
import type { TelegramCallbackQuery } from "@/lib/notifications/telegram-api";
import type { MessagePointer } from "@/lib/notifications/message-pointers";
import { newBundle } from "@/lib/bundle";

beforeEach(() => {
  answerSpy.mockReset();
  editSpy.mockReset();
  stubTelegramSends();
  setTelegramBotConfig({
    telegramBotToken: "bot-for-tests",
    telegramMode: "poll",
  });
});

// A prior day's serving, seeded straight into the two stores the offer reads, so the
// habit exists without going through the writer under test.
function priorTap(profileId: number, group: string, date: string, at: string) {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, group, date, `${date}T${at}Z`);
}

function seedDose(profileId: number, name: string): number {
  // SQLite defaults keep real time; both lifetime bounds must cover the frozen day
  // and the prior day reached by the midnight correction case.
  const createdAt = `${shiftDateStr(today(profileId), -1)} 00:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition, created_at)
         VALUES (?, ?, 'supplement', 1, 'should', 'daily', ?)`
      )
      .run(profileId, name, createdAt).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, '1 scoop', 'morning', 'any', 0, ?)`
      )
      .run(itemId, createdAt).lastInsertRowid
  );
}

// Twelve mornings of fermented + berries, two Morning-declared doses, today empty — the
// #2458 ledger shape in miniature, UTC so the profile's local day IS the frozen one.
function seedMorning(tag: string) {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(tag)
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  const anchor = today(profileId);
  for (let d = 1; d <= 12; d++) {
    const date = shiftDateStr(anchor, -d);
    priorTap(profileId, "fermented", date, "08:00:00");
    priorTap(profileId, "berries", date, "08:05:00");
  }
  return {
    profileId,
    anchor,
    creatine: seedDose(profileId, `${tag} Creatine`),
    collagen: seedDose(profileId, `${tag} Collagen`),
  };
}

// Every bundle id the day's rows carry, one row per table so a half that wrote nothing
// is visible as a zero rather than hidden inside a distinct-count of one.
function bundlesOn(profileId: number, date: string) {
  const food = db
    .prepare(
      `SELECT bundle_id FROM food_log_events WHERE profile_id = ? AND date = ?`
    )
    .all(profileId, date) as { bundle_id: string | null }[];
  const doses = db
    .prepare(
      `SELECT l.bundle_id FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date = ?`
    )
    .all(profileId, date) as { bundle_id: string | null }[];
  return {
    food: food.map((r) => r.bundle_id),
    doses: doses.map((r) => r.bundle_id),
  };
}

// The real usual writer receives the original pointer; the other host has its
// own initial footprint and never receives a second usual token. No scoop is
// present to accidentally join the two hosts through a separate protein tap.
function seedChatOffer(
  sourceKind: "food" | "dose",
  complete = false,
  protein = false
) {
  const seeded = seedMorning(`act-${sourceKind}-source`);
  const { profileId, anchor, creatine, collagen } = seeded;
  const chatId = String(5415000 + profileId);
  const groups = ["berries", "fermented"];
  const doseIds = [creatine, collagen];
  if (complete) {
    if (protein) {
      for (let d = 1; d <= 12; d++) {
        const date = shiftDateStr(anchor, -d);
        db.prepare(
          `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
          VALUES (?, '__protein__', ?, ?)`
        ).run(profileId, date, `${date}T08:10:00Z`);
      }
    } else {
      groups.push("nuts_seeds");
      for (let d = 1; d <= 12; d++)
        priorTap(profileId, "nuts_seeds", shiftDateStr(anchor, -d), "08:10:00");
    }
    for (let d = 0; d < 4; d++)
      doseIds.push(seedDose(profileId, `Act dose ${d}`));
    db.prepare(
      "UPDATE intake_items SET quantity_on_hand = 12, qty_per_dose = 1 WHERE profile_id = ?"
    ).run(profileId);
  }
  setProfileFoodTelegram(profileId, true);
  const offerId = mintOffer(profileId, "usual-routine", anchor, {
    window: "Morning",
    groups,
    doseIds,
    ...(protein ? { proteinGrams: 30 } : {}),
  });
  const footprint = (kind: "food" | "dose") => [
    [
      {
        text: kind,
        callback_data:
          kind === "food"
            ? `food:${profileId}:Morning:${anchor}:berries`
            : `all:${profileId}:Morning:${anchor}`,
      },
    ],
  ];
  const targetKind: "food" | "dose" = sourceKind === "food" ? "dose" : "food";
  recordMessagePointer({
    profileId,
    chatId,
    messageId: 54151,
    kind: sourceKind,
    date: anchor,
    keyboard: [
      [{ text: "Your usual", callback_data: `usual:${profileId}:${offerId}` }],
      ...footprint(sourceKind),
    ],
  });
  recordMessagePointer({
    profileId,
    chatId,
    messageId: 54152,
    kind: targetKind,
    date: anchor,
    keyboard: footprint(targetKind),
  });
  const source = messagePointerAt(profileId, chatId, 54151)!;
  return {
    ...seeded,
    chatId,
    source,
    targetKind,
    footprint,
    groups,
    doseIds,
    offerId,
  };
}

function seedChatAct(sourceKind: "food" | "dose") {
  const seeded = seedChatOffer(sourceKind);
  const { profileId, anchor, groups, doseIds, source, targetKind, chatId } =
    seeded;
  expect(
    logUsualRoutineCore(
      profileId,
      "Morning",
      anchor,
      groups,
      doseIds,
      "telegram-nudge",
      source.id
    ).kind
  ).toBe("logged");
  const bundle = getRecentCorrectionBundles(
    profileId,
    targetKind,
    new Date()
  )[0];
  const token = `${targetKind}time:${profileId}:${bundle.burst.fromId}:30`;
  // Both initial sets can now be consumed; only receipt_keyboard retains them.
  syncMessagePointerKeyboard(profileId, chatId, 54151, []);
  syncMessagePointerKeyboard(profileId, chatId, 54152, [
    [{ text: "−30m", callback_data: token }],
  ]);
  return { ...seeded, bundle, token };
}

function callbackAt(
  pointer: MessagePointer,
  data: string
): TelegramCallbackQuery {
  return {
    id: `bundle-${pointer.messageId}`,
    data,
    message: {
      message_id: pointer.messageId,
      chat: { id: Number(pointer.chatId) },
      text: "Daily log",
      reply_markup: { inline_keyboard: pointer.keyboard },
    },
  };
}

function timeToken(
  pointer: MessagePointer,
  minutes: number,
  fromId: number
): string {
  return pointer.keyboard
    .flat()
    .find(
      (button) =>
        button.callback_data ===
        `${pointer.kind}time:${pointer.profileId}:${fromId}:${minutes}`
    )!.callback_data!;
}

describe("complete usual acts through Telegram correction callbacks (#5415)", () => {
  it("a neighboring unbundled food chip leaves the same-minute usual act unchanged", async () => {
    vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
    const { profileId, chatId, source, offerId } = seedChatOffer("food");
    seedLoginTelegram(profileId, chatId);
    await handleCallbackQuery(
      callbackAt(source, `usual:${profileId}:${offerId}`)
    );
    const [bundle] = getRecentCorrectionBundles(profileId, "food", new Date());
    const current = messagePointerAt(profileId, chatId, source.messageId)!;
    const food = current.keyboard
      .flat()
      .find((button) =>
        button.callback_data?.startsWith("food:")
      )!.callback_data!;
    await handleCallbackQuery(callbackAt(current, food));
    const independent = db
      .prepare(
        `SELECT id, occurred_at FROM food_log_events
      WHERE profile_id = ? AND notify_message_id = ? AND bundle_id IS NULL ORDER BY id DESC LIMIT 1`
      )
      .get(profileId, source.id) as { id: number; occurred_at: string | null };
    const afterFood = messagePointerAt(profileId, chatId, source.messageId)!;
    await handleCallbackQuery(
      callbackAt(afterFood, timeToken(afterFood, 30, independent.id))
    );
    expect(
      db
        .prepare(
          "SELECT occurred_at FROM food_log_events WHERE profile_id = ? AND id = ?"
        )
        .get(profileId, independent.id)
    ).toEqual({ occurred_at: "2026-08-18T09:12:17Z" });
    expect(
      readCorrectionBundle(profileId, {
        domain: "food",
        id: bundle.burst.fromId,
      })
    ).toEqual(bundle);
  });

  it.each(["all", "stack"] as const)(
    "keeps the original host's complete %s confirmation correctable without a usual offer",
    async (kind) => {
      vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
      const { profileId, anchor, creatine, collagen } = seedMorning(
        `native-${kind}`
      );
      const chatId = String(5415000 + profileId);
      seedLoginTelegram(profileId, chatId);
      const all = `all:${profileId}:Morning:${anchor}`;
      const action =
        kind === "all"
          ? all
          : `stacktake:${profileId}:${mintOffer(profileId, "stack-take", anchor, { doseIds: [creatine, collagen] })}`;
      recordMessagePointer({
        profileId,
        chatId,
        messageId: 54151,
        kind: "dose",
        date: anchor,
        keyboard: [
          [{ text: kind, callback_data: action }],
          ...(kind === "stack" ? [[{ text: "All", callback_data: all }]] : []),
        ],
      });
      const source = messagePointerAt(profileId, chatId, 54151)!;
      await handleCallbackQuery(callbackAt(source, action));
      const [bundle] = getRecentCorrectionBundles(
        profileId,
        "dose",
        new Date()
      );
      expect(bundle.members).toHaveLength(2);
      const current = messagePointerAt(profileId, chatId, 54151)!;
      await handleCallbackQuery(
        callbackAt(current, timeToken(current, 30, bundle.burst.fromId))
      );
      expect(
        new Set(
          readCorrectionBundle(profileId, {
            domain: "dose",
            id: bundle.burst.fromId,
          })!.members.map((member) => member.statedAt)
        )
      ).toEqual(new Set(["2026-08-18T09:12:17Z"]));
      // A matching newer reminder has no bridge authority merely because the
      // native act now has a bundle id and its original buttons were consumed.
      recordMessagePointer({
        profileId,
        chatId,
        messageId: 54152,
        kind: "dose",
        date: anchor,
        keyboard: [[{ text: "All", callback_data: all }]],
      });
      expect(
        correctionBundleBinding(
          profileId,
          "dose",
          bundle,
          { chatId, messageId: 54152 },
          slotSessionForKeyboard
        )
      ).toBeNull();
    }
  );

  it("confirms the actual food destination when the picker returns a whole act from yesterday to today", async () => {
    vi.setSystemTime(new Date("2026-08-18T02:10:17Z"));
    const { profileId, anchor, chatId, source, offerId } =
      seedChatOffer("food");
    seedLoginTelegram(profileId, chatId);
    await handleCallbackQuery(
      callbackAt(source, `usual:${profileId}:${offerId}`)
    );
    const [bundle] = getRecentCorrectionBundles(profileId, "food", new Date());
    const pick = async (hour: string) => {
      const current = messagePointerAt(profileId, chatId, source.messageId)!;
      const open = `foodtimeat:${profileId}:${bundle.burst.fromId}:open`;
      expect(
        current.keyboard.flat().some((button) => button.callback_data === open)
      ).toBe(true);
      await handleCallbackQuery(callbackAt(current, open));
      const picker = messagePointerAt(profileId, chatId, source.messageId)!;
      const at = `foodtimeat:${profileId}:${bundle.burst.fromId}:${hour}`;
      expect(
        picker.keyboard.flat().some((button) => button.callback_data === at)
      ).toBe(true);
      await handleCallbackQuery(callbackAt(picker, at));
    };
    await pick("23:00");
    const read = () =>
      readCorrectionBundle(profileId, {
        domain: "food",
        id: bundle.burst.fromId,
      })!;
    expect(new Set(read().members.map((member) => member.statedAt))).toEqual(
      new Set(["2026-08-17T23:00:00Z"])
    );
    await pick("00:00");
    expect(new Set(read().members.map((member) => member.statedAt))).toEqual(
      new Set(["2026-08-18T00:00:00Z"])
    );
    expect(
      read()
        .members.filter((member) => member.domain === "food")
        .map((member) => member.date)
    ).toEqual([anchor, anchor]);
    expect(answerSpy.mock.calls.at(-1)?.[1]).toContain(
      "2 servings moved to today"
    );
  });

  it.each([
    ["food", false, false],
    ["dose", false, false],
    ["dose", true, false],
    ["food", true, true],
  ] as const)(
    "corrects three servings and six doses from the %s host (scoop %s, midnight %s), then its sibling host",
    async (sourceKind, protein, midnight) => {
      vi.setSystemTime(
        new Date(midnight ? "2026-08-18T00:10:17Z" : "2026-08-18T09:42:17Z")
      );
      const setup = seedChatOffer(sourceKind, true, protein);
      const { profileId, anchor, chatId, source, targetKind, offerId } = setup;
      seedLoginTelegram(profileId, chatId);
      await handleCallbackQuery(
        callbackAt(source, `usual:${profileId}:${offerId}`)
      );
      const [initial] = getRecentCorrectionBundles(
        profileId,
        sourceKind,
        new Date()
      );
      expect(initial.members).toHaveLength(9);
      const stock = () =>
        db
          .prepare(
            "SELECT quantity_on_hand FROM intake_items WHERE profile_id = ? ORDER BY id"
          )
          .all(profileId);
      expect(stock()).toEqual(
        Array.from({ length: 6 }, () => ({ quantity_on_hand: 11 }))
      );
      // Separate actions beside this act must not become members through time or
      // a shared source pointer. Both use the actual existing food writer.
      logFoodServingCore(
        profileId,
        "berries",
        anchor,
        "telegram-nudge",
        undefined,
        undefined,
        { notifyMessageId: source.id, bundleId: newBundle() }
      );
      logFoodServingCore(
        profileId,
        "fermented",
        anchor,
        "telegram-nudge",
        undefined,
        undefined,
        { notifyMessageId: source.id }
      );
      const independent = db
        .prepare(
          "SELECT id, occurred_at FROM food_log_events WHERE profile_id = ? AND date = ? AND (bundle_id IS NULL OR bundle_id != ?) ORDER BY id"
        )
        .all(profileId, anchor, initial.id);
      const tapped = messagePointerAt(profileId, chatId, source.messageId)!;
      await handleCallbackQuery(
        callbackAt(tapped, timeToken(tapped, 60, initial.burst.fromId))
      );
      const other = messagePointerAt(profileId, chatId, 54152)!;
      expect(other.kind).toBe(targetKind);
      const otherAnchor = Math.min(
        ...initial.members
          .filter((member) => member.domain === targetKind)
          .map((member) => member.id)
      );
      await handleCallbackQuery(
        callbackAt(other, timeToken(other, 30, otherAnchor))
      );
      const final = readCorrectionBundle(profileId, {
        domain: sourceKind,
        id: initial.burst.fromId,
      })!;
      expect(new Set(final.members.map((member) => member.statedAt))).toEqual(
        new Set([midnight ? "2026-08-17T22:40:17Z" : "2026-08-18T08:12:17Z"])
      );
      expect(
        final.members
          .filter((member) => member.domain === "dose")
          .every((member) => member.date === anchor)
      ).toBe(true);
      expect(
        db
          .prepare(
            "SELECT id, occurred_at FROM food_log_events WHERE profile_id = ? AND date = ? AND (bundle_id IS NULL OR bundle_id != ?) ORDER BY id"
          )
          .all(profileId, anchor, initial.id)
      ).toEqual(independent);
      expect(
        db
          .prepare(
            "SELECT SUM(servings) AS n FROM food_daily_totals WHERE profile_id = ? AND date = ?"
          )
          .get(profileId, anchor)
      ).toEqual({ n: midnight ? 2 : protein ? 4 : 5 });
      if (midnight)
        expect(
          db
            .prepare(
              "SELECT SUM(servings) AS n FROM food_daily_totals WHERE profile_id = ? AND date = ?"
            )
            .get(profileId, shiftDateStr(anchor, -1))
        ).toEqual({ n: 4 });
      if (protein)
        expect(
          db
            .prepare(
              "SELECT SUM(grams) AS n FROM protein_daily_totals WHERE profile_id = ? AND date = ?"
            )
            .get(profileId, anchor)
        ).toEqual({ n: 30 });
      expect(
        answerSpy.mock.calls.some(([, text]) =>
          String(text).includes("3 servings, 6 doses")
        )
      ).toBe(true);
      const currentOther = messagePointerAt(profileId, chatId, 54152)!;
      const open = currentOther.keyboard
        .flat()
        .find(
          (b) =>
            b.callback_data ===
            `${targetKind}timeat:${profileId}:${otherAnchor}:open`
        )!.callback_data!;
      await handleCallbackQuery(callbackAt(currentOther, open));
      const picker = messagePointerAt(profileId, chatId, 54152)!;
      expect(picker.kind).toBe(targetKind);
      const back = picker.keyboard
        .flat()
        .find(
          (b) =>
            b.callback_data ===
            `${targetKind}timeat:${profileId}:${otherAnchor}:back`
        )!.callback_data!;
      await handleCallbackQuery(callbackAt(picker, back));
      expect(
        readCorrectionBundle(profileId, {
          domain: sourceKind,
          id: initial.burst.fromId,
        })
      ).toEqual(final);
      const afterBack = messagePointerAt(profileId, chatId, 54152)!;
      await handleCallbackQuery(callbackAt(afterBack, open));
      const exactPicker = messagePointerAt(profileId, chatId, 54152)!;
      const exact = `${targetKind}timeat:${profileId}:${otherAnchor}:${midnight ? "21:00" : "06:00"}`;
      expect(
        exactPicker.keyboard
          .flat()
          .some((button) => button.callback_data === exact)
      ).toBe(true);
      await handleCallbackQuery(callbackAt(exactPicker, exact));
      expect(
        new Set(
          readCorrectionBundle(profileId, {
            domain: sourceKind,
            id: initial.burst.fromId,
          })!.members.map((member) => member.statedAt)
        )
      ).toEqual(
        new Set([midnight ? "2026-08-17T21:00:00Z" : "2026-08-18T06:00:00Z"])
      );
      expect(stock()).toEqual(
        Array.from({ length: 6 }, () => ({ quantity_on_hand: 11 }))
      );
    }
  );

  it.each([false, true])(
    "applies the practice member's minute precision and day boundary (midnight %s)",
    async (midnight) => {
      vi.setSystemTime(
        new Date(midnight ? "2026-08-18T00:10:17Z" : "2026-08-18T09:42:17Z")
      );
      const { profileId, anchor, chatId, source, bundle, token, creatine } =
        seedChatAct("dose");
      seedLoginTelegram(profileId, chatId);
      db.prepare(
        `INSERT INTO practice_logs
      (profile_id, practice, date, start_time, created_at, logged_via, notify_message_id, bundle_id)
      VALUES (?, 'Stretching', ?, ?, ?, 'telegram-nudge', ?, ?)`
      ).run(
        profileId,
        anchor,
        midnight ? "00:10" : "09:42",
        new Date().toISOString(),
        source.id,
        bundle.id
      );
      if (!midnight)
        db.prepare(
          "UPDATE intake_item_logs SET occurred_at = '2026-08-18T09:40:17Z' WHERE dose_id = ?"
        ).run(creatine);
      const before = readCorrectionBundle(profileId, {
        domain: "food",
        id: bundle.burst.fromId,
      })!;
      const target = messagePointerAt(profileId, chatId, 54152)!;
      const wrote = await handleFoodTimeChip(
        callbackAt(target, token),
        parseCorrectionChipToken(token, "foodtime")!
      );
      const after = readCorrectionBundle(profileId, {
        domain: "food",
        id: bundle.burst.fromId,
      })!;
      if (midnight) {
        expect(wrote).toBeUndefined();
        expect(after).toEqual(before);
      } else {
        expect(wrote).toBe(profileId);
        expect(new Set(after.members.map((member) => member.statedAt))).toEqual(
          new Set(["2026-08-18T09:10:00Z"])
        );
        expect(
          db
            .prepare(
              "SELECT start_time FROM practice_logs WHERE profile_id = ? AND bundle_id = ?"
            )
            .get(profileId, bundle.id)
        ).toEqual({ start_time: "09:10" });
      }
    }
  );

  it.each(["mute", "source", "token"] as const)(
    "refuses a %s change in the actual resolve-to-write await gap",
    async (change) => {
      vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
      const { profileId, chatId, source, bundle, token } = seedChatAct("dose");
      const loginId = seedLoginTelegram(profileId, chatId);
      const target = messagePointerAt(profileId, chatId, 54152)!;
      const before = bundle.members.map((member) => member.statedAt);
      const pending = handleFoodTimeChip(
        callbackAt(target, token),
        parseCorrectionChipToken(token, "foodtime")!
      );
      if (change === "mute") setProfileMutedForLogin(loginId, profileId, true);
      else if (change === "source") dropMessagePointer(profileId, source.id);
      else syncMessagePointerKeyboard(profileId, chatId, 54152, []);
      expect(await pending).toBeUndefined();
      expect(
        readCorrectionBundle(profileId, {
          domain: "food",
          id: bundle.burst.fromId,
        })!.members.map((member) => member.statedAt)
      ).toEqual(before);
      expect(answerSpy.mock.calls.at(-1)?.[1]).toContain("nothing was changed");
    }
  );

  it("returns the one written profile even when acknowledgement and native edit fail after commit", async () => {
    vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
    const { profileId, chatId, bundle, token } = seedChatAct("food");
    seedLoginTelegram(profileId, chatId);
    const target = messagePointerAt(profileId, chatId, 54152)!;
    answerSpy.mockRejectedValueOnce(
      new Error("temporary acknowledgement failure")
    );
    editSpy.mockRejectedValueOnce(new Error("temporary edit failure"));
    expect(
      await handleDoseTimeChip(
        callbackAt(target, token),
        parseCorrectionChipToken(token, "dosetime")!
      )
    ).toBe(profileId);
    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(
      new Set(
        readCorrectionBundle(profileId, {
          domain: "dose",
          id: bundle.burst.fromId,
        })!.members.map((member) => member.statedAt)
      )
    ).toEqual(new Set(["2026-08-18T09:12:17Z"]));
  });
});

describe("the usual act's captured correction hosts (#5415)", () => {
  it.each(["food", "dose"] as const)(
    "binds a no-scoop act from its %s source to the other consumed host",
    (sourceKind) => {
      vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
      const { profileId, chatId, source, targetKind, bundle, token } =
        seedChatAct(sourceKind);
      const proof = correctionBundleBinding(
        profileId,
        targetKind,
        bundle,
        { chatId, messageId: 54152 },
        slotSessionForKeyboard,
        token
      )!;
      expect(proof.source.id).toBe(source.id);
      expect(bundle.members).toHaveLength(4);
      expect(proof.stillBound(bundle)).toBe(true);
      // The current exact token is required even though the underlying act exists.
      syncMessagePointerKeyboard(profileId, chatId, 54152, []);
      expect(proof.stillBound(bundle)).toBe(false);
      syncMessagePointerKeyboard(profileId, chatId, 54152, [
        [{ text: "−30m", callback_data: token }],
      ]);
      expect(proof.stillBound(bundle)).toBe(true);
      // A source prune cannot be replaced by a same-location, same-offer pointer.
      dropMessagePointer(profileId, source.id);
      recordMessagePointer({
        profileId,
        chatId,
        messageId: source.messageId,
        kind: source.kind,
        date: source.date,
        keyboard: source.receiptKeyboard,
      });
      expect(proof.stillBound(bundle)).toBe(false);
      const current = readCorrectionBundle(profileId, {
        domain: targetKind,
        id: bundle.burst.fromId,
      })!;
      expect(
        correctionBundleBinding(
          profileId,
          targetKind,
          current,
          { chatId, messageId: 54152 },
          slotSessionForKeyboard,
          token
        )
      ).toBeNull();
    }
  );

  it("selects only the newest matching food context and refuses a missing initial receipt", () => {
    vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
    const { profileId, anchor, chatId, bundle, token, footprint } =
      seedChatAct("dose");
    const ref = { chatId, messageId: 54152 };
    const proof = correctionBundleBinding(
      profileId,
      "food",
      bundle,
      ref,
      slotSessionForKeyboard,
      token
    )!;
    recordMessagePointer({
      profileId,
      chatId,
      messageId: 54153,
      kind: "food",
      date: anchor,
      keyboard: [
        [
          {
            text: "Evening",
            callback_data: `food:${profileId}:Evening:${anchor}:berries`,
          },
        ],
      ],
    });
    expect(proof.stillBound(bundle)).toBe(true);
    recordMessagePointer({
      profileId,
      chatId,
      messageId: 54154,
      kind: "food",
      date: anchor,
      keyboard: footprint("food"),
    });
    expect(proof.stillBound(bundle)).toBe(false);
    const next = { chatId, messageId: 54154 };
    expect(
      correctionBundleBinding(
        profileId,
        "food",
        bundle,
        next,
        slotSessionForKeyboard
      )
    ).not.toBeNull();
    // The legacy fallback to live keyboard is not an immutable initial receipt.
    for (const receipt of [null, "invalid-json"]) {
      db.prepare(
        "UPDATE notify_messages SET receipt_keyboard = ? WHERE profile_id = ? AND message_id = ?"
      ).run(receipt, profileId, 54154);
      expect(
        correctionBundleBinding(
          profileId,
          "food",
          bundle,
          next,
          slotSessionForKeyboard
        )
      ).toBeNull();
      expect(proof.stillBound(bundle)).toBe(true);
    }
  });

  it("keeps both host anchors discoverable while the latest member keeps the whole act fresh", () => {
    vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
    const { profileId, bundle } = seedChatAct("dose");
    // The real usual writer calls the food and dose writers in sequence. Pin that
    // one-second gap so the food stamp is outside the floor and the dose inside.
    db.prepare(
      `UPDATE intake_item_logs SET recorded_at = '2026-08-18T09:42:18Z'
      WHERE bundle_id = ? AND dose_id IN (
        SELECT d.id FROM intake_item_doses d JOIN intake_items i ON i.id = d.item_id
        WHERE i.profile_id = ?)`
    ).run(bundle.id, profileId);
    vi.setSystemTime(new Date("2026-08-18T10:42:17.500Z"));
    for (const domain of ["food", "dose"] as const) {
      const candidates = getRecentCorrectionBundles(
        profileId,
        domain,
        new Date()
      );
      expect(candidates.map((candidate) => candidate.id)).toEqual([bundle.id]);
      expect(candidates[0].members).toHaveLength(4);
    }
  });

  it("discovers complete acts beyond the recent-row cap and refuses a current ineligible sibling", () => {
    vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
    const { profileId, anchor, creatine, collagen } =
      seedMorning("act-candidate-cap");
    const unrelated = db.prepare(`INSERT INTO food_log_events
      (profile_id, group_key, date, recorded_at, logged_via)
      VALUES (?, 'dark_leafy_greens', ?, '2026-08-18T09:41:00Z', 'telegram-nudge')`);
    for (let i = 0; i < 101; i++) unrelated.run(profileId, anchor);
    expect(
      logUsualRoutineCore(
        profileId,
        "Morning",
        anchor,
        ["berries", "fermented"],
        [creatine, collagen],
        "telegram-nudge"
      ).kind
    ).toBe("logged");
    expect(
      getRecentFoodTaps(profileId, new Date()).some(
        (tap) => tap.bundleId != null
      )
    ).toBe(false);
    const [bundle] = getRecentCorrectionBundles(profileId, "food", new Date());
    expect(bundle.members).toHaveLength(4);
    db.prepare(
      "UPDATE intake_item_logs SET status = 'skipped' WHERE dose_id = ?"
    ).run(creatine);
    expect(getRecentCorrectionBundles(profileId, "food", new Date())).toEqual(
      []
    );
  });
});

describe("one usual tap, one act id (#5082)", () => {
  it("scopes identical bundle strings to their profile across all member stores", () => {
    vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
    const owner = seedMorning("act-owner");
    const foreign = seedMorning("act-foreign");
    // Deliberate identity collision: profile ownership must remain authoritative.
    const bundleId = newBundle();
    for (const subject of [owner, foreign]) {
      logFoodServingCore(
        subject.profileId,
        "berries",
        subject.anchor,
        "page",
        undefined,
        undefined,
        { bundleId }
      );
      markDoseTaken(
        subject.profileId,
        subject.creatine,
        null,
        subject.anchor,
        "page",
        { bundleId }
      );
    }
    db.prepare(
      `INSERT INTO practice_logs
      (profile_id, practice, date, start_time, created_at, logged_via, bundle_id)
      VALUES (?, 'Stretching', ?, '09:42', ?, 'page', ?)`
    ).run(
      foreign.profileId,
      foreign.anchor,
      new Date().toISOString(),
      bundleId
    );
    const [selected] = getRecentCorrectionBundles(
      owner.profileId,
      "food",
      new Date()
    );
    const [stranger] = getRecentCorrectionBundles(
      foreign.profileId,
      "dose",
      new Date()
    );
    expect(selected.members).toHaveLength(2);
    expect(stranger.members).toHaveLength(3);
    expect(
      restampCorrectionBundle(
        owner.profileId,
        { domain: "dose", id: stranger.burst.fromId },
        bundleId,
        { kind: "chip", minutesBack: 30 },
        new Date(),
        () => true
      )
    ).toEqual({ kind: "no-burst" });
    expect(
      restampCorrectionBundle(
        owner.profileId,
        { domain: "food", id: selected.burst.fromId },
        bundleId,
        { kind: "chip", minutesBack: 30 },
        new Date(),
        () => true
      )
    ).toMatchObject({
      kind: "restamped",
      foodCount: 1,
      doseCount: 1,
      practiceCount: 0,
    });
    expect(
      new Set(
        readCorrectionBundle(owner.profileId, {
          domain: "food",
          id: selected.burst.fromId,
        })!.members.map((member) => member.statedAt)
      )
    ).toEqual(new Set(["2026-08-18T09:12:17Z"]));
    expect(
      readCorrectionBundle(foreign.profileId, {
        domain: "dose",
        id: stranger.burst.fromId,
      })
    ).toEqual(stranger);
  });

  it("corrects every member of an act larger than the old 200-row writer limit", () => {
    vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
    const { profileId, anchor } = seedMorning("act-large");
    const bundleId = newBundle();
    for (let i = 0; i < 201; i++)
      logFoodServingCore(
        profileId,
        "berries",
        anchor,
        "page",
        undefined,
        undefined,
        { bundleId }
      );
    const [bundle] = getRecentCorrectionBundles(profileId, "food", new Date());
    expect(bundle.members).toHaveLength(201);
    expect(
      restampCorrectionBundle(
        profileId,
        { domain: "food", id: bundle.burst.fromId },
        bundleId,
        { kind: "chip", minutesBack: 30 },
        new Date(),
        () => true
      )
    ).toMatchObject({ kind: "restamped", foodCount: 201 });
    expect(
      readCorrectionBundle(profileId, {
        domain: "food",
        id: bundle.burst.fromId,
      })!.members.map((member) => member.statedAt)
    ).toEqual(Array(201).fill("2026-08-18T09:12:17Z"));
  });

  it.each(["food", "dose"] as const)(
    "corrects the complete usual act from its %s anchor",
    (domain) => {
      vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
      const { profileId, anchor, creatine, collagen } = seedMorning(
        `act-${domain}`
      );
      expect(
        logUsualRoutineCore(
          profileId,
          "Morning",
          anchor,
          ["berries", "fermented"],
          [creatine, collagen],
          "page"
        ).kind
      ).toBe("logged");
      const food = db
        .prepare(
          "SELECT id FROM food_log_events WHERE profile_id = ? AND date = ? ORDER BY id"
        )
        .all(profileId, anchor) as { id: number }[];
      const dose = db
        .prepare("SELECT id FROM intake_item_logs WHERE dose_id = ?")
        .get(creatine) as { id: number };
      // Reproduce the split current clocks, rather than correcting equal tap stamps.
      db.prepare(
        "UPDATE intake_item_logs SET occurred_at = ? WHERE id = ?"
      ).run("2026-08-18T07:42:17Z", dose.id);
      logFoodServingCore(profileId, "berries", anchor, "page");
      const selected = { domain, id: domain === "food" ? food[0].id : dose.id };
      const before = readCorrectionBundle(profileId, selected)!;
      const outcome = restampCorrectionBundle(
        profileId,
        selected,
        before.id,
        { kind: "chip", minutesBack: 30 },
        new Date(),
        () => true
      );
      expect(outcome).toMatchObject({
        kind: "restamped",
        foodCount: 2,
        doseCount: 2,
      });
      const after = readCorrectionBundle(profileId, selected)!;
      expect(after.members.map((m) => m.statedAt)).toEqual(
        Array(4).fill("2026-08-18T07:12:17Z")
      );
      const servings = db
        .prepare(
          "SELECT occurred_at, meal_slot, time_source FROM food_log_events WHERE profile_id = ? AND bundle_id = ?"
        )
        .all(profileId, before.id);
      expect(servings).toEqual(
        Array(2).fill({
          occurred_at: "2026-08-18T07:12:17Z",
          meal_slot: null,
          time_source: "stated",
        })
      );
      const independent = db
        .prepare(
          "SELECT occurred_at FROM food_log_events WHERE profile_id = ? AND date = ? AND bundle_id IS NULL"
        )
        .all(profileId, anchor);
      expect(independent).toEqual([{ occurred_at: null }]);
    }
  );

  it("rolls back food day counters and rows when a later domain refuses", () => {
    vi.setSystemTime(new Date("2026-08-18T00:10:17Z"));
    const { profileId, anchor, creatine, collagen } =
      seedMorning("act-rollback");
    expect(
      logUsualRoutineCore(
        profileId,
        "Morning",
        anchor,
        ["berries", "fermented"],
        [creatine, collagen],
        "page"
      ).kind
    ).toBe("logged");
    const food = db
      .prepare(
        "SELECT id FROM food_log_events WHERE profile_id = ? AND date = ? ORDER BY id"
      )
      .all(profileId, anchor) as { id: number }[];
    const selected = { domain: "food" as const, id: food[0].id };
    const before = readCorrectionBundle(profileId, selected)!;
    const counters = () =>
      db
        .prepare(
          "SELECT date, group_key, servings FROM food_daily_totals WHERE profile_id = ? ORDER BY date, group_key"
        )
        .all(profileId);
    const originalCounters = counters();
    // A later refusal must escape the outer transaction, not commit its earlier
    // food work. The trigger supplies that race at a synchronous DB boundary.
    rawDb.exec(`CREATE TEMP TRIGGER refuse_act_dose AFTER UPDATE OF occurred_at ON food_log_events
      WHEN NEW.id = ${food[0].id}
      BEGIN UPDATE intake_item_logs SET status = 'skipped' WHERE dose_id = ${creatine}; END`);
    try {
      expect(
        restampCorrectionBundle(
          profileId,
          selected,
          before.id,
          { kind: "chip", minutesBack: 30 },
          new Date(),
          () => true
        )
      ).toEqual({ kind: "no-burst" });
      expect(readCorrectionBundle(profileId, selected)).toEqual(before);
      expect(counters()).toEqual(originalCounters);
    } finally {
      rawDb.exec("DROP TRIGGER refuse_act_dose");
    }
  });

  it("stamps the same bundle on its food rows and its dose rows", () => {
    const { profileId, anchor, creatine, collagen } = seedMorning("act-stamp");

    const outcome = logUsualRoutineCore(
      profileId,
      "Morning",
      anchor,
      ["berries", "fermented"],
      [creatine, collagen],
      "page"
    );
    expect(outcome.kind).toBe("logged");

    const { food, doses } = bundlesOn(profileId, anchor);
    // BOTH HALVES ACTUALLY WROTE. Without this the distinct-count below would be
    // satisfied by a tap that logged doses and no servings at all — the exact shape
    // this issue exists to fix, passing its own test.
    expect([food.length, doses.length]).toEqual([2, 2]);
    const ids = new Set([...food, ...doses]);
    expect(ids.size).toBe(1);
    // Sixteen hex characters, because that is what `newBundle` mints (lib/bundle.ts)
    // and what the ledger's collapse key relies on being true of every bundle.
    expect([...ids][0]).toMatch(/^[0-9a-f]{16}$/);
  });

  // A single write composed nothing, so it records nothing — which is what keeps
  // "no bundle" readable as "stated on its own" rather than as "written before the
  // column existed".
  it("writes NULL for a single serving add and a single dose confirm", () => {
    const { profileId, anchor, creatine } = seedMorning("act-null");

    expect(logFoodServingCore(profileId, "berries", anchor, "page").kind).toBe(
      "logged"
    );
    expect(markDoseTaken(profileId, creatine, null, anchor, "page")).toBe(
      "logged"
    );

    expect(bundlesOn(profileId, anchor)).toEqual({
      food: [null],
      doses: [null],
    });
  });
});
