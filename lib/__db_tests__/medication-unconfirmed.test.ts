// DB INTEGRATION TIER — the unconfirmed imported MEDICATION escape hatch (#2574),
// end to end through the real gather, the real reminder formatter, the real callback
// dispatcher and the real course-stop core, with only the Telegram network stubbed.
//
// The thread under test:
//
//   getUnconfirmedMedicationIds → buildSupplementReminder's `stoppable` flag
//                               → the Stop button on the dose row
//                               → handleCallbackQuery → stopMedicationCourses
//
// What only this tier can prove, and each is a property the issue names:
//
//   • the flag comes from real provenance and a real EMPTY log ledger, not a fixture
//     boolean, and the reminder grows exactly ONE extra button;
//   • a single logged dose — taken OR skipped — removes it on the very next gather;
//   • the two dose-row flags are never both set on one row;
//   • the tap RE-DERIVES the offer, so a stale button on an item that has since been
//     logged refuses rather than silencing a medication with engagement history;
//   • the write renders its typed outcome — a second tap says "already stopped" rather
//     than claiming it did something;
//   • the reminder's WORDS never mention the button, so the channels that strip actions
//     (#1718) receive an honest message.
//
// Every value is synthetic.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { buildSupplementReminder } from "@/lib/notifications/supplements";
import { getUnconfirmedMedicationIds } from "@/lib/intake-history";
import {
  IMPORTED_SOURCE,
  UNCONFIRMED_STOP_TEXT,
} from "@/lib/medication-unconfirmed";
import { demotionCandidateItemIds } from "@/lib/rule-findings";
import { MED_STOP_PREFIX } from "@/lib/notifications/callback-data";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { answerCallbackQuery } from "@/lib/notifications/telegram-api";
import { GLYPH } from "@/lib/notifications/glyphs";
import { seedLoginTelegram } from "./fixtures";
import type { NotificationAction } from "@/lib/notifications/types";

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
beforeAll(() => stubTelegramSends());

const answerMock = vi.mocked(answerCallbackQuery);
const CHAT = "5550188";

function lastAnswerText(): string | undefined {
  return answerMock.mock.calls.at(-1)?.[1];
}

interface Fixture {
  profileId: number;
  itemId: number;
  doseId: number;
  today: string;
}

// A daily Morning medication that has existed for well over the detector's window, so
// its strip carries a month of real occasions rather than pre-existence days.
function seedMed(
  tag: string,
  opts: { source: string | null; kind?: string; ageDays?: number } = {
    source: IMPORTED_SOURCE,
  }
): Fixture {
  const profileId = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`Unconfirmed ${tag}`).lastInsertRowid
  );
  const t = today(profileId);
  const born = `${shiftDateStr(t, -(opts.ageDays ?? 60))} 08:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, source, created_at)
         VALUES (?, 'Fixture Inhaler (test)', 1, ?, 'daily', 'must', ?, ?)`
      )
      .run(profileId, opts.kind ?? "medication", opts.source, born)
      .lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, '2 puffs', 'Morning', 'any', 0, ?)`
      )
      .run(itemId, born).lastInsertRowid
  );
  return { profileId, itemId, doseId, today: t };
}

function logDose(f: Fixture, status: "taken" | "skipped"): void {
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
     VALUES (?, ?, ?, ?)`
  ).run(f.doseId, f.itemId, shiftDateStr(f.today, -3), status);
}

function reminderActions(profileId: number): NotificationAction[] {
  const msg = buildSupplementReminder(profileId, "Morning");
  expect(msg).not.toBeNull();
  return msg!.actions ?? [];
}

function stopToken(f: Fixture): string {
  return `${MED_STOP_PREFIX}:${f.profileId}:${f.itemId}:${f.today}`;
}

function cq(token: string, chatId: string) {
  return {
    id: "cbq-medstop",
    data: token,
    message: {
      message_id: 91,
      chat: { id: chatId },
      text: "Morning medications",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "take", callback_data: "take:1:1:1:x" },
            { text: `${GLYPH.finish} Stop`, callback_data: token },
          ],
        ],
      },
    },
  };
}

function itemState(itemId: number): { active: number } {
  return db
    .prepare("SELECT active FROM intake_items WHERE id = ?")
    .get(itemId) as { active: number };
}

beforeEach(() => {
  answerMock.mockClear();
});

describe("the offer's gate, over real provenance and a real log ledger (#2574)", () => {
  it("flags an imported medication nobody has ever logged", () => {
    const f = seedMed("flag");
    expect(getUnconfirmedMedicationIds(f.profileId, f.today)).toContain(
      f.itemId
    );
  });

  it("does not flag the same medication when a person created it", () => {
    const f = seedMed("manual", { source: "manual" });
    expect(getUnconfirmedMedicationIds(f.profileId, f.today).size).toBe(0);
  });

  it("stops flagging it the moment one dose is TAKEN", () => {
    const f = seedMed("taken");
    expect(getUnconfirmedMedicationIds(f.profileId, f.today).size).toBe(1);
    logDose(f, "taken");
    expect(getUnconfirmedMedicationIds(f.profileId, f.today).size).toBe(0);
  });

  it("stops flagging it the moment one dose is SKIPPED", () => {
    // The boundary the whole safety argument rests on: a skip is engagement.
    const f = seedMed("skipped");
    expect(getUnconfirmedMedicationIds(f.profileId, f.today).size).toBe(1);
    logDose(f, "skipped");
    expect(getUnconfirmedMedicationIds(f.profileId, f.today).size).toBe(0);
  });

  it("does not leak across profiles", () => {
    const mine = seedMed("scopeA");
    const other = seedMed("scopeB");
    expect(
      getUnconfirmedMedicationIds(mine.profileId, mine.today)
    ).not.toContain(other.itemId);
  });
});

describe("the button on the real reminder", () => {
  it("adds exactly one Stop button to the dose's row, and no words about it", () => {
    const f = seedMed("button");
    const msg = buildSupplementReminder(f.profileId, "Morning");
    expect(msg).not.toBeNull();
    const stops = (msg!.actions ?? []).filter((a) =>
      a.data?.startsWith(`${MED_STOP_PREFIX}:`)
    );
    expect(stops).toHaveLength(1);
    expect(stops[0].data).toBe(stopToken(f));
    // It rides the dose's own row rather than adding one.
    const take = (msg!.actions ?? []).find((a) => a.data?.startsWith("take:"));
    expect(stops[0].row).toBe(take?.row);
    // #1718: the message's WORDS never reference an affordance a channel may strip.
    // Web Push and the HA webhook deliver this body without any buttons at all.
    const words = `${msg!.title}\n${JSON.stringify(msg!.body)}`;
    expect(words.toLowerCase()).not.toContain("stop");
    expect(words).not.toContain(GLYPH.finish);
  });

  it("carries no Stop button once the item has been logged", () => {
    const f = seedMed("nobutton");
    logDose(f, "skipped");
    expect(
      reminderActions(f.profileId).some((a) =>
        a.data?.startsWith(`${MED_STOP_PREFIX}:`)
      )
    ).toBe(false);
  });

  it("never carries both extra buttons on one row", () => {
    // Disjointness over the real detectors, on the real fixture — the pure test proves
    // the predicates are complements, this proves nothing between them reintroduces an
    // overlap.
    const f = seedMed("disjoint");
    expect(getUnconfirmedMedicationIds(f.profileId, f.today).size).toBe(1);
    expect(demotionCandidateItemIds(f.profileId, f.today).size).toBe(0);
    const actions = reminderActions(f.profileId);
    expect(actions.filter((a) => a.data?.startsWith("demote:"))).toHaveLength(
      0
    );
  });

  it("offers nothing on a supplement, which the demotion engine owns", () => {
    const f = seedMed("supp", { source: IMPORTED_SOURCE, kind: "supplement" });
    expect(getUnconfirmedMedicationIds(f.profileId, f.today).size).toBe(0);
  });
});

describe("the tap: it writes through the one core, and renders its outcome", () => {
  it("stops the medication and says so", async () => {
    const f = seedMed("tap");
    seedLoginTelegram(f.profileId, CHAT);
    db.prepare(
      "INSERT INTO medication_courses (item_id, started_on) VALUES (?, ?)"
    ).run(f.itemId, shiftDateStr(f.today, -60));

    await handleCallbackQuery(cq(stopToken(f), CHAT));

    expect(lastAnswerText()).toBe(UNCONFIRMED_STOP_TEXT.stopped);
    expect(itemState(f.itemId).active).toBe(0);
    const course = db
      .prepare(
        "SELECT stopped_on, stop_reason FROM medication_courses WHERE item_id = ?"
      )
      .get(f.itemId) as { stopped_on: string; stop_reason: string };
    // Dated TODAY, never the reminder's day, and always carrying a reason.
    expect(course.stopped_on).toBe(f.today);
    expect(course.stop_reason).toBe("other");
  });

  it("refuses a second tap on a stale message rather than confirming again", async () => {
    const f = seedMed("retap");
    seedLoginTelegram(f.profileId, CHAT);
    db.prepare(
      "INSERT INTO medication_courses (item_id, started_on) VALUES (?, ?)"
    ).run(f.itemId, shiftDateStr(f.today, -60));

    await handleCallbackQuery(cq(stopToken(f), CHAT));
    expect(lastAnswerText()).toBe(UNCONFIRMED_STOP_TEXT.stopped);

    // The item is inactive now, so the offer is gone — the tap re-derives and refuses
    // BEFORE the write, which is what stops a stale button from being a loaded one.
    await handleCallbackQuery(cq(stopToken(f), CHAT));
    expect(lastAnswerText()).toBe(UNCONFIRMED_STOP_TEXT.withdrawn);
  });

  it("refuses when the medication has been logged since the message was sent", async () => {
    const f = seedMed("logged-since");
    seedLoginTelegram(f.profileId, CHAT);
    db.prepare(
      "INSERT INTO medication_courses (item_id, started_on) VALUES (?, ?)"
    ).run(f.itemId, shiftDateStr(f.today, -60));

    // The message went out this morning; a dose was taken before the tap landed.
    logDose(f, "taken");
    await handleCallbackQuery(cq(stopToken(f), CHAT));

    expect(lastAnswerText()).toBe(UNCONFIRMED_STOP_TEXT.withdrawn);
    expect(itemState(f.itemId).active).toBe(1);
  });

  it("refuses a token from another chat's profile", async () => {
    const mine = seedMed("xprofA");
    const other = seedMed("xprofB");
    seedLoginTelegram(mine.profileId, CHAT);

    await handleCallbackQuery(
      cq(
        `${MED_STOP_PREFIX}:${other.profileId}:${other.itemId}:${other.today}`,
        CHAT
      )
    );
    expect(itemState(other.itemId).active).toBe(1);
  });
});
