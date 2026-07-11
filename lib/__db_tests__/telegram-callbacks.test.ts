// DB INTEGRATION TIER — the two-way Telegram action buttons (issue #233) driven
// end-to-end through handleCallbackQuery against the REAL query layer, with only
// the Telegram network surface (answer/edit/send) stubbed. Proves each button's
// token routes to the SAME server function the app uses and writes the expected
// row — and that stale/duplicate/foreign-chat taps write NOTHING and answer
// honestly (the outcome-typed contract). The pure parse/decide half is covered in
// lib/__tests__/callback-data.test.ts.

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Stub the Telegram Bot API calls; keep the pure helpers (messageKeyboard,
// renderMessageHtml) real via importActual so keyboard rebuilds still run.
vi.mock("@/lib/notifications/telegram", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram")>();
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageText: vi.fn(async () => {}),
    editMessageReplyMarkup: vi.fn(async () => {}),
    sendTelegramMessage: vi.fn(async () => {}),
  };
});

import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setProfileSetting, getProfileSetting } from "@/lib/settings";
import { preventiveSignalKey } from "@/lib/preventive-upcoming";
import { refillSignalKey } from "@/lib/refill-nudge";
import { escalationMarkerKey } from "@/lib/notifications/escalate";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  answerCallbackQuery,
  editMessageText,
} from "@/lib/notifications/telegram";
import { seedProfile, type SeededProfile } from "./fixtures";

const answerMock = vi.mocked(answerCallbackQuery);
const editTextMock = vi.mocked(editMessageText);

const OWN_CHAT = "5550100";
const CARE_CHAT = "5550199";
const OTHER_CHAT = "5550299";

// A minimal callback_query as Telegram delivers it: a tapped button carrying
// `data`, in a message with `chatId` and a one-button keyboard so the rebuild path
// has something to consume.
function cq(data: string, chatId: string, text?: string) {
  return {
    id: "cbq-1",
    data,
    message: {
      message_id: 42,
      chat: { id: chatId },
      ...(text != null ? { text } : {}),
      reply_markup: { inline_keyboard: [[{ text: "x", callback_data: data }]] },
    },
  };
}

function lastAnswerText(): string | undefined {
  const call = answerMock.mock.calls.at(-1);
  return call?.[1];
}

function lastEditedText(): string | undefined {
  const call = editTextMock.mock.calls.at(-1);
  return call?.[2] as string | undefined;
}

let p: SeededProfile;
let criticalSuppId: number;
let criticalDoseId: number;

beforeAll(() => {
  p = seedProfile("TG233");
  setProfileSetting(p.profileId, "telegram_chat_id", OWN_CHAT);
  setProfileSetting(p.profileId, "telegram_enabled", "1");

  // A critical med with a caregiver escalate chat + one dose, for the escalation
  // buttons. Synthetic chat id, obviously-fictional name.
  criticalSuppId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, critical, escalate_chat_id)
         VALUES (?, 'TG233 Warfarin', 1, 'medication', 'daily', 'mandatory', 1, ?)`
      )
      .run(p.profileId, CARE_CHAT).lastInsertRowid
  );
  criticalDoseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '5 mg', 'morning', 'any', 0)`
      )
      .run(criticalSuppId).lastInsertRowid
  );
});

beforeEach(() => {
  answerMock.mockClear();
  editTextMock.mockClear();
});

// ---- Phase 1: preventive ----
describe("preventive buttons route to the shared server functions", () => {
  const RULE = "colorectal_cancer"; // a screening in the static catalog

  it("✅ Done records a preventive satisfaction for today", async () => {
    await handleCallbackQuery(cq(`pvdone:${p.profileId}:${RULE}`, OWN_CHAT));
    const row = db
      .prepare(
        `SELECT 1 FROM preventive_events
          WHERE profile_id = ? AND rule_key = ? AND date = ?`
      )
      .get(p.profileId, RULE, today(p.profileId));
    expect(row).toBeTruthy();
    expect(lastAnswerText()).toMatch(/done/i);
  });

  it("🚫 Not applicable sets a not_applicable override", async () => {
    await handleCallbackQuery(cq(`pvna:${p.profileId}:${RULE}`, OWN_CHAT));
    const row = db
      .prepare(
        `SELECT kind FROM preventive_overrides
          WHERE profile_id = ? AND rule_key = ?`
      )
      .get(p.profileId, RULE) as { kind: string } | undefined;
    expect(row?.kind).toBe("not_applicable");
  });

  it("⏰ Remind later snoozes on the findings bus by the shared signal key", async () => {
    await handleCallbackQuery(cq(`pvlater:${p.profileId}:${RULE}`, OWN_CHAT));
    const key = preventiveSignalKey("screening", RULE);
    const row = db
      .prepare(
        `SELECT snooze_until FROM upcoming_dismissals
          WHERE profile_id = ? AND signal_key = ?`
      )
      .get(p.profileId, key) as { snooze_until: string | null } | undefined;
    expect(row?.snooze_until).toBe(shiftDateStr(today(p.profileId), 7));
  });

  it("a tampered rule key writes nothing and is answered as out-of-date", async () => {
    await handleCallbackQuery(cq(`pvdone:${p.profileId}:not_a_rule`, OWN_CHAT));
    const row = db
      .prepare(
        `SELECT 1 FROM preventive_events WHERE profile_id = ? AND rule_key = 'not_a_rule'`
      )
      .get(p.profileId);
    expect(row).toBeFalsy();
    expect(lastAnswerText()).toMatch(/^Not recorded/);
  });

  it("a tap from an unrelated chat resolves no profile and writes nothing", async () => {
    db.prepare("DELETE FROM preventive_events WHERE profile_id = ?").run(
      p.profileId
    );
    await handleCallbackQuery(
      cq(`pvdone:${p.profileId}:adult_physical`, OTHER_CHAT)
    );
    const row = db
      .prepare(
        `SELECT 1 FROM preventive_events WHERE profile_id = ? AND rule_key = 'adult_physical'`
      )
      .get(p.profileId);
    expect(row).toBeFalsy();
    // Answered with a bare ack (no text) — the tap wasn't authorized.
    expect(lastAnswerText()).toBeUndefined();
  });
});

// ---- Phase 3: refill ----
describe("refill snooze button routes to the findings bus", () => {
  it("📦 Ordered snoozes the refill:<id> finding 3 days out", async () => {
    await handleCallbackQuery(
      cq(`rfsnooze:${p.profileId}:${p.supplementId}`, OWN_CHAT)
    );
    const row = db
      .prepare(
        `SELECT snooze_until FROM upcoming_dismissals
          WHERE profile_id = ? AND signal_key = ?`
      )
      .get(p.profileId, refillSignalKey(p.supplementId)) as
      { snooze_until: string | null } | undefined;
    expect(row?.snooze_until).toBe(shiftDateStr(today(p.profileId), 3));
    expect(lastAnswerText()).toMatch(/3 days/);
  });

  it("a forged supplement id writes nothing (stale-item)", async () => {
    await handleCallbackQuery(cq(`rfsnooze:${p.profileId}:999999`, OWN_CHAT));
    const row = db
      .prepare(
        `SELECT 1 FROM upcoming_dismissals
          WHERE profile_id = ? AND signal_key = 'refill:999999'`
      )
      .get(p.profileId);
    expect(row).toBeFalsy();
    expect(lastAnswerText()).toMatch(/^Not recorded/);
  });
});

// ---- Phase 2: escalation ----
describe("escalation buttons (caregiver two-way)", () => {
  function clearDoseLogs() {
    db.prepare("DELETE FROM intake_item_logs WHERE dose_id = ?").run(
      criticalDoseId
    );
    db.prepare(
      "DELETE FROM profile_settings WHERE profile_id = ? AND key = ?"
    ).run(p.profileId, escalationMarkerKey(criticalDoseId));
  }

  it("✅ Confirmed taken logs the dose (from the profile's own chat)", async () => {
    clearDoseLogs();
    const date = today(p.profileId);
    await handleCallbackQuery(
      cq(
        `esctake:${p.profileId}:${criticalDoseId}:${criticalSuppId}:${date}`,
        OWN_CHAT
      )
    );
    const row = db
      .prepare(
        `SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?`
      )
      .get(criticalDoseId, date) as { status: string } | undefined;
    expect(row?.status).toBe("taken");
    expect(lastAnswerText()).toBe("Logged ✅");
  });

  it("👍 I'm on it (from the caregiver escalate chat) acks WITHOUT logging the dose", async () => {
    clearDoseLogs();
    const date = today(p.profileId);
    await handleCallbackQuery(
      cq(
        `escack:${p.profileId}:${criticalDoseId}:${criticalSuppId}:${date}`,
        CARE_CHAT
      )
    );
    // No dose log written…
    const log = db
      .prepare(`SELECT 1 FROM intake_item_logs WHERE dose_id = ? AND date = ?`)
      .get(criticalDoseId, date);
    expect(log).toBeFalsy();
    // …but the per-episode escalation marker is set (suppresses re-nudge).
    expect(
      getProfileSetting(p.profileId, escalationMarkerKey(criticalDoseId))
    ).toBe(date);
    expect(lastAnswerText()).toMatch(/not marked taken/i);
  });

  it("👍 on an already-taken dose reports it confirmed, not a fresh ack", async () => {
    clearDoseLogs();
    const date = today(p.profileId);
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?,?,?,'taken')`
    ).run(criticalDoseId, criticalSuppId, date);
    await handleCallbackQuery(
      cq(
        `escack:${p.profileId}:${criticalDoseId}:${criticalSuppId}:${date}`,
        CARE_CHAT
      )
    );
    // No marker written for an already-resolved dose.
    expect(
      getProfileSetting(p.profileId, escalationMarkerKey(criticalDoseId))
    ).toBeFalsy();
    expect(lastAnswerText()).toMatch(/taken ✅/);
  });

  it("👍 on an already-SKIPPED dose reports the skip, never a fresh ack (#280)", async () => {
    clearDoseLogs();
    const date = today(p.profileId);
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?,?,?,'skipped')`
    ).run(criticalDoseId, criticalSuppId, date);
    await handleCallbackQuery(
      cq(
        `escack:${p.profileId}:${criticalDoseId}:${criticalSuppId}:${date}`,
        CARE_CHAT
      )
    );
    // The chase is over (resolved by a deliberate skip): no marker, and the
    // answer names the skip — not "we'll hold off" and not "taken".
    expect(
      getProfileSetting(p.profileId, escalationMarkerKey(criticalDoseId))
    ).toBeFalsy();
    expect(lastAnswerText()).toMatch(/skipped/i);
    expect(lastAnswerText()).not.toMatch(/hold off|taken ✅/i);
    // The replacement body agrees with the toast.
    expect(lastEditedText()).toMatch(/skipped/i);
  });

  it("✅ Confirmed-taken on an already-SKIPPED dose never answers 'Logged' (#280)", async () => {
    clearDoseLogs();
    const date = today(p.profileId);
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?,?,?,'skipped')`
    ).run(criticalDoseId, criticalSuppId, date);
    await handleCallbackQuery(
      cq(
        `esctake:${p.profileId}:${criticalDoseId}:${criticalSuppId}:${date}`,
        OWN_CHAT
      )
    );
    // The skip stands (never overwritten), and both the toast and the rebuilt
    // message say so instead of "Logged ✅"/"Confirmed taken ✅".
    const row = db
      .prepare(
        `SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?`
      )
      .get(criticalDoseId, date) as { status: string } | undefined;
    expect(row?.status).toBe("skipped");
    expect(lastAnswerText()).toMatch(/^Not logged/);
    expect(lastAnswerText()).toMatch(/skipped/i);
    expect(lastEditedText()).toMatch(/skipped/i);
    expect(lastEditedText()).not.toContain("Confirmed taken");
  });

  it("a tap from an unrelated chat is refused (no log, bare ack)", async () => {
    clearDoseLogs();
    const date = today(p.profileId);
    await handleCallbackQuery(
      cq(
        `esctake:${p.profileId}:${criticalDoseId}:${criticalSuppId}:${date}`,
        OTHER_CHAT
      )
    );
    const log = db
      .prepare(`SELECT 1 FROM intake_item_logs WHERE dose_id = ? AND date = ?`)
      .get(criticalDoseId, date);
    expect(log).toBeFalsy();
    expect(lastAnswerText()).toBeUndefined();
  });

  it("✅ on a retired dose logs nothing and answers stale (never falsely confirms)", async () => {
    clearDoseLogs();
    const date = today(p.profileId);
    db.prepare("UPDATE intake_item_doses SET retired = 1 WHERE id = ?").run(
      criticalDoseId
    );
    await handleCallbackQuery(
      cq(
        `esctake:${p.profileId}:${criticalDoseId}:${criticalSuppId}:${date}`,
        OWN_CHAT
      )
    );
    const log = db
      .prepare(`SELECT 1 FROM intake_item_logs WHERE dose_id = ? AND date = ?`)
      .get(criticalDoseId, date);
    expect(log).toBeFalsy();
    expect(lastAnswerText()).toMatch(/out of date/i);
    db.prepare("UPDATE intake_item_doses SET retired = 0 WHERE id = ?").run(
      criticalDoseId
    );
  });
});

// ---- Dose reminder ✅/⏭ buttons: stale cross-action taps (#280) ----
// A reminder message is a frozen snapshot, so its button pair survives an
// out-of-band resolution (web UI, another device). The stale tap writes nothing
// — and the toast must name the status that actually stands, not confirm the
// tapped action.
describe("stale dose-button taps answer with the standing status (#280)", () => {
  it("⏭ Skip on a dose already TAKEN never answers 'Skipped'", async () => {
    // The fixture already logged the supplement dose as taken today.
    const date = today(p.profileId);
    await handleCallbackQuery(
      cq(
        `skip:${p.profileId}:${p.supplementDoseId}:${p.supplementId}:${date}`,
        OWN_CHAT
      )
    );
    const row = db
      .prepare(
        `SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?`
      )
      .get(p.supplementDoseId, date) as { status: string } | undefined;
    expect(row?.status).toBe("taken");
    expect(lastAnswerText()).toMatch(/^Not skipped/);
    expect(lastAnswerText()).toMatch(/taken/i);
    expect(lastAnswerText()).not.toContain("Skipped ⏭");
  });

  it("✅ Take on a dose already SKIPPED never answers 'Logged'", async () => {
    const date = today(p.profileId);
    // A second dose on the same item, resolved as skipped out-of-band.
    const doseB = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 cap', 'evening', 'any', 1)`
        )
        .run(p.supplementId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?,?,?,'skipped')`
    ).run(doseB, p.supplementId, date);
    await handleCallbackQuery(
      cq(`take:${p.profileId}:${doseB}:${p.supplementId}:${date}`, OWN_CHAT)
    );
    const row = db
      .prepare(
        `SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?`
      )
      .get(doseB, date) as { status: string } | undefined;
    expect(row?.status).toBe("skipped");
    expect(lastAnswerText()).toMatch(/^Not logged/);
    expect(lastAnswerText()).toMatch(/skipped/i);
    expect(lastAnswerText()).not.toContain("Logged ✅");
  });
});

// ---- Shared-chat attribution: the [ProfileName] prefix survives a tap (#377) ----
// The tick prefixes a slot send with "[Name] " when the instance tracks more than
// one profile, so a family chat can tell two kids' identical "💊 Morning
// supplements" apart. The tap-rebuild paths re-render from scratch and must
// re-apply the SAME prefix (prefixForProfile — one computation) or the message
// collapses to an unattributable title with live ✅/⏭/✅-All buttons — a parent
// could then confirm the WRONG child's remaining doses (the safety-tier worst case).
describe("shared-chat attribution survives a tap (#377)", () => {
  // A sibling profile so the instance has >1 profile → the prefix applies. Both
  // profiles share the same family chat, matching the issue's scenario.
  beforeAll(() => {
    const sib = seedProfile("TG377sib");
    setProfileSetting(sib.profileId, "telegram_chat_id", OWN_CHAT);
    setProfileSetting(sib.profileId, "telegram_enabled", "1");
  });

  it("a dose ✅ rebuild keeps the [Name] label on the rebuilt title", async () => {
    const date = today(p.profileId);
    await handleCallbackQuery(
      cq(
        `take:${p.profileId}:${p.supplementDoseId}:${p.supplementId}:${date}`,
        OWN_CHAT
      )
    );
    // The rebuilt (HTML) message keeps the profile label so it stays attributable.
    expect(lastEditedText()).toContain("[TG233]");
  });

  it("a ✅-All rebuild keeps the [Name] label too", async () => {
    const date = today(p.profileId);
    await handleCallbackQuery(
      cq(`all:${p.profileId}:Morning:${date}`, OWN_CHAT)
    );
    expect(lastEditedText()).toContain("[TG233]");
  });

  it("a consumed escalation retains the original title line above the closing", async () => {
    const date = today(p.profileId);
    db.prepare("DELETE FROM intake_item_logs WHERE dose_id = ?").run(
      criticalDoseId
    );
    await handleCallbackQuery(
      cq(
        `esctake:${p.profileId}:${criticalDoseId}:${criticalSuppId}:${date}`,
        OWN_CHAT,
        "[TG233] ⚠️ Missed dose: Warfarin\nTake it when you can."
      )
    );
    // The replacement keeps WHO/WHICH med the tap resolved (chat-history context),
    // not a bare "Confirmed taken ✅" identical across family members.
    const edited = lastEditedText() ?? "";
    expect(edited).toContain("[TG233] ⚠️ Missed dose: Warfarin");
    expect(edited).toContain("Confirmed taken ✅");
  });
});
