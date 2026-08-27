// DB INTEGRATION TIER — the two-way Telegram action buttons (issue #233) driven
// end-to-end through handleCallbackQuery against the REAL query layer, with only
// the Telegram network surface (answer/edit/send) stubbed. Proves each button's
// token routes to the SAME server function the app uses and writes the expected
// row — and that stale/duplicate/foreign-chat taps write NOTHING and answer
// honestly (the outcome-typed contract). The pure parse/decide half is covered in
// lib/__tests__/callback-data.test.ts.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";
import {
  BULK_ALL_SKIPPED_TEXT,
  OUTDATED_MESSAGE_TEXT,
} from "@/lib/notifications/callback-data";

// Stub the RAW Telegram Bot API transport (issue #454's guarded boundary), keeping
// the chokepoint (telegram.ts: rebuildMessage/closeMessage/…) and the pure render
// helpers (messageKeyboard, renderMessageHtml) REAL via importActual — so the
// prefix/escaping the chokepoint applies is exercised and the edited wire text this
// test asserts on is the genuine rendered output, only the network hop is faked.

import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setProfileSetting, getProfileSetting } from "@/lib/settings";
import { preventiveSignalKey } from "@/lib/preventive-upcoming";
import { refillSignalKey } from "@/lib/refill-nudge";
import { escalationMarkerKey } from "@/lib/notifications/escalate";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { stackOfferToken } from "@/lib/notifications/intake";
import {
  answerCallbackQuery,
  editMessageTextRaw,
} from "@/lib/notifications/telegram-api";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
beforeAll(() => stubTelegramSends());

const answerMock = vi.mocked(answerCallbackQuery);
const editTextMock = vi.mocked(editMessageTextRaw);

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
  seedLoginTelegram(p.profileId, OWN_CHAT);
  // A critical med with a caregiver escalate chat + one dose, for the escalation
  // buttons. Synthetic chat id, obviously-fictional name.
  criticalSuppId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, critical, escalate_chat_id)
         VALUES (?, 'TG233 Warfarin', 1, 'medication', 'daily', 'must', 1, ?)`
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
    // The tap wasn't authorized, so nothing was written — and the answer SAYS SO
    // (#1716): a bare ack stops the spinner and reads as success.
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
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

  it("👍 carrying a forged non-date is refused before it can persist a garbage marker (#3120)", async () => {
    clearDoseLogs();
    db.prepare(
      `DELETE FROM profile_settings WHERE profile_id = ? AND key = ?`
    ).run(p.profileId, escalationMarkerKey(criticalDoseId));
    await handleCallbackQuery(
      cq(
        `escack:${p.profileId}:${criticalDoseId}:${criticalSuppId}:banana`,
        CARE_CHAT
      )
    );
    // The marker is compared to the dose's DAY by equality (escalate.ts), so a
    // stored "banana" would silently void the acknowledgement while the caregiver
    // was told the chase had stopped — and the escalation would keep re-firing.
    expect(
      getProfileSetting(p.profileId, escalationMarkerKey(criticalDoseId))
    ).toBeFalsy();
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
  });

  it("✅ Confirmed-taken carrying a forged non-date writes no dose log (#3120)", async () => {
    clearDoseLogs();
    await handleCallbackQuery(
      cq(
        `esctake:${p.profileId}:${criticalDoseId}:${criticalSuppId}:2026-02-30`,
        CARE_CHAT
      )
    );
    const rows = db
      .prepare(`SELECT 1 FROM intake_item_logs WHERE dose_id = ?`)
      .all(criticalDoseId);
    expect(rows).toEqual([]);
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
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
    // Refused and answered honestly (#1716) — never a silent, success-looking ack.
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
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

// ---- Dose reminder ✅/⏭️ buttons: stale cross-action taps (#280) ----
// A reminder message is a frozen snapshot, so its button pair survives an
// out-of-band resolution (web UI, another device). The stale tap writes nothing
// — and the toast must name the status that actually stands, not confirm the
// tapped action.
describe("stale dose-button taps answer with the standing status (#280)", () => {
  it("⏭️ Skip on a dose already TAKEN never answers 'Skipped'", async () => {
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
    expect(lastAnswerText()).not.toContain("Skipped ⏭️");
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
// collapses to an unattributable title with live ✅/⏭️/✅-All buttons — a parent
// could then confirm the WRONG child's remaining doses (the safety-tier worst case).
describe("shared-chat attribution survives a tap (#377)", () => {
  // A sibling profile so the instance has >1 profile → the prefix applies. Both
  // profiles share the same family chat, matching the issue's scenario.
  beforeAll(() => {
    const sib = seedProfile("TG377sib");
    seedLoginTelegram(sib.profileId, OWN_CHAT);
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

// ---- Escalation authz binds the caregiver chat to the DOSE's supplement (#615) ----
// A caregiver chat is authorized only for the doses of the supplement actually
// routed to it — not every dose of the profile. The token can't pair supplement
// X's escalate chat with a dose of a different, un-escalated supplement Y.
describe("escalation authz binds to the dose's own supplement (#615)", () => {
  // Med Y: same profile, its OWN dose, but NO caregiver escalate chat.
  let sensitiveSuppId: number;
  let sensitiveDoseId: number;
  beforeAll(() => {
    sensitiveSuppId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation, critical)
         VALUES (?, 'TG615 Sensitive Med', 1, 'medication', 'daily', 'must', 1)`
        )
        .run(p.profileId).lastInsertRowid
    );
    sensitiveDoseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '10 mg', 'morning', 'any', 0)`
        )
        .run(sensitiveSuppId).lastInsertRowid
    );
  });
  beforeEach(() => {
    db.prepare("DELETE FROM intake_item_logs WHERE dose_id = ?").run(
      sensitiveDoseId
    );
    db.prepare(
      "DELETE FROM profile_settings WHERE profile_id = ? AND key = ?"
    ).run(p.profileId, escalationMarkerKey(sensitiveDoseId));
  });

  it("med X's caregiver chat cannot ✅-confirm a dose of med Y (no log)", async () => {
    const date = today(p.profileId);
    // Forge: Y's dose, but naming X's suppId so the OLD code would authorize via
    // X's escalate chat. From X's caregiver chat.
    await handleCallbackQuery(
      cq(
        `esctake:${p.profileId}:${sensitiveDoseId}:${criticalSuppId}:${date}`,
        CARE_CHAT
      )
    );
    const log = db
      .prepare(`SELECT 1 FROM intake_item_logs WHERE dose_id = ? AND date = ?`)
      .get(sensitiveDoseId, date);
    expect(log).toBeFalsy();
    // Unauthorized → nothing written, and the toast says the tap didn't take (#1716).
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
  });

  it("med X's caregiver chat cannot escack-silence med Y's escalation (no marker)", async () => {
    const date = today(p.profileId);
    await handleCallbackQuery(
      cq(
        `escack:${p.profileId}:${sensitiveDoseId}:${criticalSuppId}:${date}`,
        CARE_CHAT
      )
    );
    expect(
      getProfileSetting(p.profileId, escalationMarkerKey(sensitiveDoseId))
    ).toBeFalsy();
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
  });

  it("the profile's OWN chat still confirms med Y with a correct token", async () => {
    const date = today(p.profileId);
    await handleCallbackQuery(
      cq(
        `esctake:${p.profileId}:${sensitiveDoseId}:${sensitiveSuppId}:${date}`,
        OWN_CHAT
      )
    );
    const row = db
      .prepare(
        `SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?`
      )
      .get(sensitiveDoseId, date) as { status: string } | undefined;
    expect(row?.status).toBe("taken");
    expect(lastAnswerText()).toBe("Logged ✅");
  });
});

// ---- ✅-All tolerates an already-logged dose in the window (#616) ----
// A tap racing/following a concurrent write of one dose must still log the rest;
// the unique-constraint guard means the loop no longer throws and abandons them.
describe("handleAllTaken tolerates an already-logged dose (#616)", () => {
  const ALL_CHAT = "5550616";
  let hp: SeededProfile;
  let itemA: number;
  let doseA: number;
  let itemB: number;
  let doseB: number;
  beforeAll(() => {
    hp = seedProfile("TG616");
    seedLoginTelegram(hp.profileId, ALL_CHAT);
    const mkItem = (name: string) =>
      Number(
        db
          .prepare(
            `INSERT INTO intake_items
               (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should')`
          )
          .run(hp.profileId, name).lastInsertRowid
      );
    const mkDose = (itemId: number) =>
      Number(
        db
          .prepare(
            `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
             VALUES (?, '1 cap', 'morning', 'any', 0)`
          )
          .run(itemId).lastInsertRowid
      );
    itemA = mkItem("TG616 Morning A");
    doseA = mkDose(itemA);
    itemB = mkItem("TG616 Morning B");
    doseB = mkDose(itemB);
  });

  it("logs the remaining pending dose when one is already logged, without throwing", async () => {
    const date = today(hp.profileId);
    // Pre-log dose A (as a concurrent writer would).
    db.prepare(
      "INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?,?,?,'taken')"
    ).run(doseA, itemA, date);

    await handleCallbackQuery(
      cq(`all:${hp.profileId}:Morning:${date}`, ALL_CHAT)
    );

    // Dose B (the remaining pending one) is now logged — the loop didn't abort.
    const rowB = db
      .prepare(
        `SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?`
      )
      .get(doseB, date) as { status: string } | undefined;
    expect(rowB?.status).toBe("taken");
    expect(lastAnswerText()).toBe("All logged ✅");
  });
});

// ---- The per-stack one-tap (#3098, on the offer substrate since #3282) ------
//
// `stacktake:` names a STORED offer whose dose ids are an UPPER BOUND. The handler
// re-derives the pending, notifiable set from current state and writes only the
// INTERSECTION through markDoseTaken — each guard below is red if that intersection
// rule is removed: a forged foreign id, a retired dose, a floored `may` dose and an
// already-resolved dose must all be refused or left alone, with the honest answer,
// while the still-pending listed doses log. The offers are minted through the
// production mint (`stackOfferToken`), so the token these taps carry is the token the
// reminder keyboard would have rendered.
describe("stacktake writes only the listed-and-still-pending intersection (#3098)", () => {
  const STACK_CHAT = "5553098";
  const FOREIGN_CHAT = "5553099";
  let sp: SeededProfile;
  let other: SeededProfile;
  let itemA: number;
  let doseA: number;
  let itemB: number;
  let doseB: number;
  let mayItem: number;
  let mayDose: number;
  let retiredItem: number;
  let retiredDose: number;
  let foreignItem: number;
  let foreignDose: number;

  const mkItem = (
    profileId: number,
    name: string,
    obligation: string,
    stack: string | null
  ) =>
    Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation, stack)
           VALUES (?, ?, 1, 'supplement', 'daily', ?, ?)`
        )
        .run(profileId, name, obligation, stack).lastInsertRowid
    );
  const mkDose = (itemId: number, retired = 0) =>
    Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, retired)
           VALUES (?, '1 cap', 'morning', 'any', 0, ?)`
        )
        .run(itemId, retired).lastInsertRowid
    );

  beforeAll(() => {
    sp = seedProfile("TG3098");
    seedLoginTelegram(sp.profileId, STACK_CHAT);
    other = seedProfile("TG3098B");
    seedLoginTelegram(other.profileId, FOREIGN_CHAT);
    itemA = mkItem(sp.profileId, "TG3098 Stack A", "should", "AM stack");
    doseA = mkDose(itemA);
    itemB = mkItem(sp.profileId, "TG3098 Stack B", "should", "AM stack");
    doseB = mkDose(itemB);
    // A `may` supplement is behind the #1156 floor: never listed, never bulk-logged.
    mayItem = mkItem(sp.profileId, "TG3098 May C", "may", "AM stack");
    mayDose = mkDose(mayItem);
    retiredItem = mkItem(
      sp.profileId,
      "TG3098 Retired D",
      "should",
      "AM stack"
    );
    retiredDose = mkDose(retiredItem, 1);
    foreignItem = mkItem(other.profileId, "TG3098 Foreign E", "should", null);
    foreignDose = mkDose(foreignItem);
  });

  // The reminder keyboard's own mint: a notify_offers row for these members, and the
  // constant-size token that names it.
  const offerToken = (date: string, doseIds: number[]) =>
    stackOfferToken(sp.profileId, date)(doseIds);

  const logsFor = (doseId: number, date: string) =>
    db
      .prepare(
        `SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?`
      )
      .all(doseId, date) as { status: string }[];

  it("writes the pending listed doses and refuses everything outside the fresh set", async () => {
    const date = today(sp.profileId);
    // The token lists the two real members PLUS a forged foreign id, a retired
    // dose, and a floored `may` dose — the upper bound a stale or forged token
    // could carry.
    const token = offerToken(date, [
      doseA,
      doseB,
      mayDose,
      retiredDose,
      foreignDose,
    ]);
    await handleCallbackQuery(cq(token, STACK_CHAT));
    expect(logsFor(doseA, date).map((r) => r.status)).toEqual(["taken"]);
    expect(logsFor(doseB, date).map((r) => r.status)).toEqual(["taken"]);
    // Outside the re-derived pending set: nothing written.
    expect(logsFor(mayDose, date)).toEqual([]);
    expect(logsFor(retiredDose, date)).toEqual([]);
    expect(logsFor(foreignDose, date)).toEqual([]);
    expect(lastAnswerText()).toBe("Logged ✅");
  });

  it("a second tap answers nothing-to-log instead of confirming again", async () => {
    const date = today(sp.profileId);
    await handleCallbackQuery(cq(offerToken(date, [doseA, doseB]), STACK_CHAT));
    // Still exactly one log per dose — idempotent, and answered as the standing
    // state rather than a fresh confirm (#280).
    expect(logsFor(doseA, date)).toHaveLength(1);
    expect(logsFor(doseB, date)).toHaveLength(1);
    expect(lastAnswerText()).toBe("Already logged ✅");
  });

  it("a token whose every id is outside the current session answers out-of-date", async () => {
    const date = today(sp.profileId);
    await handleCallbackQuery(
      cq(offerToken(date, [retiredDose, foreignDose]), STACK_CHAT)
    );
    expect(logsFor(retiredDose, date)).toEqual([]);
    expect(logsFor(foreignDose, date)).toEqual([]);
    expect(lastAnswerText()).toBe(
      "Not logged — this reminder is out of date. Open the app."
    );
  });

  it("a token minted for another chat's profile writes nothing", async () => {
    const date = today(sp.profileId);
    db.prepare(`DELETE FROM intake_item_logs WHERE dose_id IN (?, ?)`).run(
      doseA,
      doseB
    );
    await handleCallbackQuery(
      cq(offerToken(date, [doseA, doseB]), FOREIGN_CHAT)
    );
    expect(logsFor(doseA, date)).toEqual([]);
    expect(logsFor(doseB, date)).toEqual([]);
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
  });

  // NO OFFER, NO WRITE (#3282). Four ways a token can name nothing this profile is
  // owed today, and all four are the SAME refusal on purpose — distinguishing them
  // would tell a forged token whether an offer id exists. The last is the migration's
  // own case: a `stacktake:` button minted before this shipped spells its ids inline,
  // so it does not even parse, and the dispatcher's unknown-token fallback answers it.
  it.each([
    [
      "an offer id that was never minted",
      () => `stacktake:${sp.profileId}:99999`,
    ],
    [
      "an offer minted before the day rolled over",
      () =>
        stackOfferToken(
          sp.profileId,
          shiftDateStr(today(sp.profileId), -1)
        )([doseA, doseB]),
    ],
    [
      "another profile's offer",
      () =>
        stackOfferToken(
          other.profileId,
          today(other.profileId)
        )([doseA, doseB]),
    ],
    [
      "a pre-#3282 ids-in-token button still on the phone",
      () =>
        `stacktake:${sp.profileId}:${today(sp.profileId)}:${doseA},${doseB}`,
    ],
  ])("writes nothing for %s", async (_why, mkToken) => {
    const date = today(sp.profileId);
    db.prepare(`DELETE FROM intake_item_logs WHERE dose_id IN (?, ?)`).run(
      doseA,
      doseB
    );
    await handleCallbackQuery(cq(mkToken(), STACK_CHAT));
    expect(logsFor(doseA, date)).toEqual([]);
    expect(logsFor(doseB, date)).toEqual([]);
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
  });
});

// ---- Bulk dose-tap hardening (#3120) ---------------------------------------
//
// Two inherited gaps, both pre-existing in the `all:` posture and inherited by
// `stacktake:`; neither reachable from the official client:
//   1. callback dates were never format-validated, so a forged non-date threaded
//      through every re-minted keyboard token on the rebuild — now refused at
//      parse time (the dispatcher's unknown-token fallback answers out-of-date);
//   2. a fully-skipped resolved set answered "Already logged ✅" — a skip is a
//      recorded refusal (#232), not a log, so both handlers now share the
//      distinct BULK_ALL_SKIPPED_TEXT answer.
describe("bulk dose-tap hardening (#3120)", () => {
  const HARD_CHAT = "5553120";
  let bp: SeededProfile;
  let itemA: number;
  let doseA: number;
  let itemB: number;
  let doseB: number;

  const mkItem = (name: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
           VALUES (?, ?, 1, 'supplement', 'daily', 'should')`
        )
        .run(bp.profileId, name).lastInsertRowid
    );
  const mkDose = (itemId: number) =>
    Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 cap', 'morning', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );

  beforeAll(() => {
    bp = seedProfile("TG3120");
    seedLoginTelegram(bp.profileId, HARD_CHAT);
    itemA = mkItem("TG3120 Morning A");
    doseA = mkDose(itemA);
    itemB = mkItem("TG3120 Morning B");
    doseB = mkDose(itemB);
    // The fixture profile seeds its own morning doses (a pending Lisinopril would
    // make ✅ All log something); this block is about the A/B pair only.
    db.prepare(
      `UPDATE intake_items SET active = 0 WHERE profile_id = ? AND id NOT IN (?, ?)`
    ).run(bp.profileId, itemA, itemB);
  });

  const logsOn = (date: string) =>
    db
      .prepare(
        `SELECT status FROM intake_item_logs WHERE dose_id IN (?, ?) AND date = ?`
      )
      .all(doseA, doseB, date) as { status: string }[];

  const clearLogs = () =>
    db
      .prepare(`DELETE FROM intake_item_logs WHERE dose_id IN (?, ?)`)
      .run(doseA, doseB);

  it("a forged non-date `all:` token is refused at parse time — nothing written, nothing re-minted", async () => {
    await handleCallbackQuery(
      cq(`all:${bp.profileId}:Morning:banana`, HARD_CHAT)
    );
    expect(logsOn("banana")).toEqual([]);
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
    // The handler never ran, so no rebuild threads the forged date through a
    // re-minted keyboard.
    expect(editTextMock).not.toHaveBeenCalled();
  });

  it("a forged shape-only date (2026-13-45) is refused the same way", async () => {
    await handleCallbackQuery(
      cq(`all:${bp.profileId}:Morning:2026-13-45`, HARD_CHAT)
    );
    expect(logsOn("2026-13-45")).toEqual([]);
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
    expect(editTextMock).not.toHaveBeenCalled();
  });

  it("a forged non-numeric `stacktake:` offer id is refused at parse time", async () => {
    await handleCallbackQuery(
      cq(`stacktake:${bp.profileId}:banana`, HARD_CHAT)
    );
    expect(logsOn("banana")).toEqual([]);
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
    expect(editTextMock).not.toHaveBeenCalled();
  });

  it('✅ All on a fully-skipped session answers the skip, not "Already logged"', async () => {
    const date = today(bp.profileId);
    clearLogs();
    db.prepare(
      "INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?,?,?,'skipped'), (?,?,?,'skipped')"
    ).run(doseA, itemA, date, doseB, itemB, date);

    await handleCallbackQuery(
      cq(`all:${bp.profileId}:Morning:${date}`, HARD_CHAT)
    );
    // Nothing inserted — both skips stand untouched (#232).
    expect(logsOn(date).map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(lastAnswerText()).toBe(BULK_ALL_SKIPPED_TEXT);
    // The answer contradicts the ✅, so it must be dismissed, not glanced at.
    expect(answerMock.mock.calls.at(-1)?.[2]).toEqual({ alert: true });
  });

  it("a stack tap on a fully-skipped set shares the same answer string", async () => {
    const date = today(bp.profileId);
    await handleCallbackQuery(
      cq(stackOfferToken(bp.profileId, date)([doseA, doseB]), HARD_CHAT)
    );
    expect(logsOn(date).map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(lastAnswerText()).toBe(BULK_ALL_SKIPPED_TEXT);
    expect(answerMock.mock.calls.at(-1)?.[2]).toEqual({ alert: true });
  });

  it('a mixed taken+skipped resolved set keeps the standing "Already logged ✅" answer', async () => {
    const date = today(bp.profileId);
    clearLogs();
    db.prepare(
      "INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?,?,?,'taken'), (?,?,?,'skipped')"
    ).run(doseA, itemA, date, doseB, itemB, date);
    await handleCallbackQuery(
      cq(`all:${bp.profileId}:Morning:${date}`, HARD_CHAT)
    );
    expect(lastAnswerText()).toBe("Already logged ✅");
  });
});
