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
import { getProfileSetting } from "@/lib/settings";
import { preventiveSignalKey } from "@/lib/preventive-upcoming";
import { refillSignalKey } from "@/lib/refill-nudge";
import { escalationMarkerKey } from "@/lib/notifications/escalate";
import {
  CALLBACK_REGISTRY,
  handleCallbackQuery,
} from "@/lib/notifications/telegram-callbacks";
import {
  HOST_INHERITED,
  RECONCILE_DATE_GUARD,
  reconcileEntryFor,
  type ReconcileDateGuard,
} from "@/lib/notifications/reconcile-registry";
import { stackOfferToken } from "@/lib/notifications/intake";
import { DOSE_LOG_DATE_WINDOW_DAYS } from "@/lib/dose-log-window";
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

  // ONE TAP, ONE BUNDLE (#4328) — the chat's bulk take is a composed action exactly as
  // the ledger's Take-all is, so the rows it writes say so instead of leaving the Day
  // ledger to infer it from the minute they share. Both rows are written by THIS tap
  // (the pre-logged row above is cleared first), which is what makes the DISTINCT a
  // claim about sharing rather than about one row.
  it("stamps one bundle across every dose the bulk tap wrote", async () => {
    const date = today(hp.profileId);
    db.prepare(`DELETE FROM intake_item_logs WHERE dose_id IN (?, ?)`).run(
      doseA,
      doseB
    );

    await handleCallbackQuery(
      cq(`all:${hp.profileId}:Morning:${date}`, ALL_CHAT)
    );

    const rows = db
      .prepare(
        `SELECT dose_id, bundle_id FROM intake_item_logs
          WHERE dose_id IN (?, ?) AND date = ? ORDER BY dose_id`
      )
      .all(doseA, doseB, date) as {
      dose_id: number;
      bundle_id: string | null;
    }[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.bundle_id)).size).toBe(1);
    expect(rows[0].bundle_id).not.toBeNull();
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
    // AGED PAST THE DAY WINDOW (#4011). The day-routing case below taps day−1 and
    // day−2, and the reminder gather now clamps a past day to the dose's lifetime the
    // way the quick-log sheet always has — an item created this morning was owed
    // nothing yesterday. Without this the block would go green for the lifetime reason
    // while claiming to pin which DAY the offer writes to.
    const born = `${shiftDateStr(today(sp.profileId), -30)} 09:00:00`;
    db.prepare(
      `UPDATE intake_items SET created_at = ? WHERE profile_id IN (?, ?)`
    ).run(born, sp.profileId, other.profileId);
    db.prepare(
      `UPDATE intake_item_doses SET created_at = ?
        WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id IN (?, ?))`
    ).run(born, sp.profileId, other.profileId);
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
    // ONE TAP, ONE BUNDLE (#4328). The per-stack one-tap is the composed write the Day
    // ledger's stack row exists for, so it records itself rather than being inferred
    // from the minute its rows landed in. Asserted DISTINCT over the two rows that were
    // actually written — a single row would satisfy "one bundle" without composing.
    const bundles = (
      db
        .prepare(
          `SELECT DISTINCT bundle_id FROM intake_item_logs
            WHERE dose_id IN (?, ?) AND date = ?`
        )
        .all(doseA, doseB, date) as { bundle_id: string | null }[]
    ).map((r) => r.bundle_id);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).not.toBeNull();
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

  // NO OFFER, NO WRITE (#3282), and the refusal must be SEEN. All four answer with the
  // same text, so a forged token cannot learn whether an offer id exists — but not with
  // the same urgency. A refusal `handleStackTaken` speaks gets the intake tier's modal
  // (telegram-api.ts: a Desktop toast "fades on its own and is easy to miss entirely").
  // The retired ids-in-token shape never reaches the handler — it fails the 3-field
  // parse and lands on the dispatcher's bare answer — so it is only a toast. A row
  // rather than a smoothing-over: it lasts one reminder cycle, and the alternative is
  // a parser that recognises the old shape.
  it.each([
    [
      "an offer id that was never minted",
      true,
      () => `stacktake:${sp.profileId}:99999`,
    ],
    [
      "an offer older than the dose-log window",
      true,
      () =>
        stackOfferToken(
          sp.profileId,
          shiftDateStr(today(sp.profileId), -(DOSE_LOG_DATE_WINDOW_DAYS + 1))
        )([doseA, doseB]),
    ],
    [
      "another profile's offer",
      true,
      () =>
        stackOfferToken(
          other.profileId,
          today(other.profileId)
        )([doseA, doseB]),
    ],
    [
      "a pre-#3282 ids-in-token button still on the phone",
      false,
      () =>
        `stacktake:${sp.profileId}:${today(sp.profileId)}:${doseA},${doseB}`,
    ],
    // THE ID IS THE WHOLE TOKEN, so a reissued id is a different button. `notify_offers`
    // is pruned on the same 3-day horizon that retires the message pointer, so without
    // AUTOINCREMENT the freed rowid went to the next offer on exactly the day the sweep
    // could no longer retire the button — and the scroll-back tap redeemed a bundle it
    // never named, IN FULL, because the upper-bound rule bounds how much is written and
    // not what. This row mints a harmless offer, prunes it, then mints a writable one:
    // under the old schema the stale token resolves to `doseA`/`doseB` and logs them.
    [
      "an offer id whose row was pruned and reissued to another bundle",
      true,
      () => {
        const mint = stackOfferToken(sp.profileId, today(sp.profileId));
        const stale = mint([retiredDose]);
        db.prepare(`DELETE FROM notify_offers WHERE profile_id = ?`).run(
          sp.profileId
        );
        mint([doseA, doseB]);
        return stale;
      },
    ],
  ])("writes nothing for %s", async (_why, alerts, mkToken) => {
    const date = today(sp.profileId);
    db.prepare(`DELETE FROM intake_item_logs WHERE dose_id IN (?, ?)`).run(
      doseA,
      doseB
    );
    await handleCallbackQuery(cq(mkToken(), STACK_CHAT));
    expect(logsFor(doseA, date)).toEqual([]);
    expect(logsFor(doseB, date)).toEqual([]);
    expect(lastAnswerText()).toBe(OUTDATED_MESSAGE_TEXT);
    expect(answerMock.mock.calls.at(-1)?.[2]?.alert).toBe(alerts || undefined);
  });

  // THE DAY IS THE SESSION'S, NOT THE TAP'S (#3282 fix). A reminder sent at 21:00 and
  // tapped at 00:05 confirms the day it was sent for, like the `take:` and `all:`
  // buttons beside it and through the same ±DOSE_LOG_DATE_WINDOW_DAYS predicate —
  // RECONCILE_DATE_GUARD["intake-dose"] rules that deleting it at midnight is pure
  // loss. Dies the moment the handler scopes the offer to `today` instead.
  it.each([0, -1, -DOSE_LOG_DATE_WINDOW_DAYS])(
    "logs to the offer's own day, %s days back",
    async (shift) => {
      const day = shiftDateStr(today(sp.profileId), shift);
      db.prepare(`DELETE FROM intake_item_logs WHERE dose_id IN (?, ?)`).run(
        doseA,
        doseB
      );
      await handleCallbackQuery(
        cq(stackOfferToken(sp.profileId, day)([doseA, doseB]), STACK_CHAT)
      );
      expect(logsFor(doseA, day).map((r) => r.status)).toEqual(["taken"]);
      expect(logsFor(doseB, day).map((r) => r.status)).toEqual(["taken"]);
      expect(lastAnswerText()).toBe("Logged ✅");
    }
  );
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

// ---- The PAST-DAY bulk write (#4019/#4011) ---------------------------------
//
// Every `all:` case above taps `today(...)`, which is the day these gates cannot
// change. The harm those two issues describe is a WRITE: "✅ All" on a message a day
// or two old feeds `collectWindowDoses(profileId, window, all.date)` straight into
// `markDoseTaken`, so a dose the day never owed becomes a `taken` row and a stock
// decrement. Asserting the rendered names is not enough — these drive the real
// handler and read the ledger back.
describe("✅ All on a past day writes what the day owed, and nothing else", () => {
  const PAST_CHAT = "5554019";
  let pp: SeededProfile;
  let restDose: number;
  let preDose: number;
  let bornTodayDose: number;
  let yesterday: string;

  const mkItem = (name: string, condition: string, ageDays: number) => {
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
           VALUES (?, ?, 1, 'medication', ?, 'must')`
        )
        .run(pp.profileId, name, condition).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 tab', 'Morning', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    const born = `${shiftDateStr(today(pp.profileId), -ageDays)} 09:00:00`;
    db.prepare(`UPDATE intake_items SET created_at = ? WHERE id = ?`).run(
      born,
      itemId
    );
    db.prepare(`UPDATE intake_item_doses SET created_at = ? WHERE id = ?`).run(
      born,
      doseId
    );
    return doseId;
  };

  beforeAll(() => {
    pp = seedProfile("TG4019");
    seedLoginTelegram(pp.profileId, PAST_CHAT);
    yesterday = shiftDateStr(today(pp.profileId), -1);
    restDose = mkItem("TG4019 Rest day med", "rest_day", 30);
    preDose = mkItem("TG4019 Pre workout med", "pre_workout", 30);
    // Created THIS MORNING: it owed nothing yesterday (#4011).
    bornTodayDose = mkItem("TG4019 Added today", "daily", 0);
    // A DRAFT HUSK on yesterday (#3189): no duration, nothing logged against it. The
    // raw dated read counts it as training; the husk-free list does not.
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, start_time)
       VALUES (?, ?, 'strength', 'Session', ?)`
    ).run(pp.profileId, yesterday, `${yesterday}T09:00:00Z`);
    // The seeded profile brings its own morning doses; this block is about these three.
    db.prepare(
      `UPDATE intake_items SET active = 0
        WHERE profile_id = ? AND id NOT IN
          (SELECT item_id FROM intake_item_doses WHERE id IN (?, ?, ?))`
    ).run(pp.profileId, restDose, preDose, bornTodayDose);
  });

  it("logs the rest-day dose, and neither the husk's pre-workout nor today's newcomer", async () => {
    db.prepare(`DELETE FROM intake_item_logs WHERE dose_id IN (?, ?, ?)`).run(
      restDose,
      preDose,
      bornTodayDose
    );

    await handleCallbackQuery(
      cq(`all:${pp.profileId}:Morning:${yesterday}`, PAST_CHAT)
    );

    // The ledger, read back BY NAME so a red says which dose was written rather than
    // printing two opaque ids — the inversion is the whole point of this case.
    const rows = db
      .prepare(
        `SELECT s.name, l.status FROM intake_item_logs l
           JOIN intake_item_doses d ON d.id = l.dose_id
           JOIN intake_items s ON s.id = d.item_id
          WHERE l.dose_id IN (?, ?, ?) AND l.date = ? ORDER BY s.name`
      )
      .all(restDose, preDose, bornTodayDose, yesterday);
    expect(rows).toEqual([{ name: "TG4019 Rest day med", status: "taken" }]);
    expect(lastAnswerText()).toBe("All logged ✅");
  });
});

// ── THE REGISTRY'S TWO DECLARATIONS ABOUT A DATE, PAIRED (#4544) ─────────────
//
// `CALLBACK_REGISTRY` says what the HANDLER does with a token's date;
// `RECONCILE_DATE_GUARD` says how late the SWEEP will leave that message tappable. They
// are allowed to differ — `mood` differs on purpose — but only in ONE direction, and the
// direction is the whole content of the rule: reconciliation may only ever REDUCE what a
// chat claims, so a sweep that is MORE GENEROUS than its handler leaves a button standing
// that the tap would refuse. That is the #614 defect with its sign flipped, and nothing
// was watching for it.
//
// Strictness is a total order over the three answers, so this is a comparison rather than
// a table of pairs: exact-day (today only) is stricter than dose-window (±2 days), which
// is stricter than none.
describe("the sweep is never more generous than the handler (#4544)", () => {
  const STRICTNESS: Record<ReconcileDateGuard, number> = {
    none: 0,
    "dose-window": 1,
    "exact-day": 2,
  };

  // Every registry entry that BOTH declares a handler guard and elects a family — the
  // pairs the rule is about. An inert or host-inherited prefix elects no family, so the
  // sweep has no answer of its own to compare against.
  const pairs = CALLBACK_REGISTRY.flatMap((entry) => {
    const handler = entry.dateGuard;
    if (handler == null) return [];
    return entry.prefixes.flatMap((prefix) => {
      const family = reconcileEntryFor(prefix)?.family;
      return family == null || family === HOST_INHERITED
        ? []
        : [{ prefix, family, handler }];
    });
  });

  it("finds the pairs (it would pass vacuously otherwise)", () => {
    expect(pairs.map((p) => p.prefix).sort()).toEqual([
      "all",
      "demote",
      "escack",
      "escskip",
      "esctake",
      "food",
      "foodprotein",
      "hh",
      "medstop",
      "mood",
      "moodkeep",
      "skip",
      "take",
    ]);
  });

  it.each(pairs)(
    "$prefix: the $family sweep is at least as strict as its handler",
    ({ family, handler }) => {
      expect(
        STRICTNESS[RECONCILE_DATE_GUARD[family].guard]
      ).toBeGreaterThanOrEqual(STRICTNESS[handler]);
    }
  );

  it("CONTROL: the comparison fails when the sweep is the looser of the two", () => {
    // `hh` is the strict pair — handler and sweep both exact-day. Forge the sweep's
    // answer down to `none` THROUGH THE SAME LOOKUP the assertion above runs through,
    // and the same expression must go red.
    const forged: ReconcileDateGuard = "none";
    expect(STRICTNESS[forged]).toBeLessThan(
      STRICTNESS[pairs.find((p) => p.prefix === "hh")?.handler ?? "none"]
    );
  });
});
