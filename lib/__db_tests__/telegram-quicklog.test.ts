// DB INTEGRATION TIER — the #859 item 5 Telegram quick-log flows driven end-to-end,
// with only the Telegram network surface stubbed (the #454 guarded boundary). Proves
// the symptom button grid → severity → log path and the /temp reply flow route to the
// SAME write cores the app uses and write the expected rows, answering from the typed
// outcome (never an unconditional confirm). The pure parse half is in
// lib/__tests__/telegram-quicklog-parse.test.ts.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import {
  handleCallbackQuery,
  handleIncomingMessage,
} from "@/lib/notifications/telegram-callbacks";
import {
  answerCallbackQuery,
  editMessageTextRaw,
  sendMessageRaw,
  setMessageReaction,
} from "@/lib/notifications/telegram-api";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";
import { typedReplyMarker } from "@/lib/notifications/typed-reply";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import { liveMessagePointersForKind } from "@/lib/notifications/message-pointers";

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
beforeAll(() => stubTelegramSends());

const answerMock = vi.mocked(answerCallbackQuery);
const editMock = vi.mocked(editMessageTextRaw);
const sendMock = vi.mocked(sendMessageRaw);
const reactMock = vi.mocked(setMessageReaction);

// A typed reply to a prompt already sitting in the chat: the prompt's own id is what the
// acknowledgement edits, and the reply's own id is what wears the reaction (#5650).
const PROMPT_ID = 700;
function tempReply(text: string, profileId: number, messageId = 801) {
  return {
    message_id: messageId,
    chat: { id: CHAT },
    from: { id: 71 },
    text,
    reply_to_message: {
      message_id: PROMPT_ID,
      text: `Reply with the temperature. ${typedReplyMarker("temp", profileId)}`,
    },
  };
}

const CHAT = "5550150";

function cq(data: string) {
  return {
    id: "cbq-1",
    data,
    message: {
      message_id: 7,
      chat: { id: CHAT },
      reply_markup: { inline_keyboard: [[{ text: "x", callback_data: data }]] },
    },
  };
}

let p: SeededProfile;

beforeAll(() => {
  p = seedProfile("TG859");
  seedLoginTelegram(p.profileId, CHAT);
});

describe("symptom quick-log (button grid → severity → log)", () => {
  it("a symptom pick opens a severity picker; a severity logs the symptom-day", async () => {
    answerMock.mockClear();
    editMock.mockClear();

    // Pick "cough" → the message is edited to a severity picker.
    await handleCallbackQuery(cq(`symp:${p.profileId}:cough`));
    expect(editMock).toHaveBeenCalled();
    const editedText = editMock.mock.calls.at(-1)?.[2] as string;
    expect(editedText).toMatch(/How bad is it/i);

    // Tap "moderate" (severity 2) → logged, answered from the typed outcome.
    await handleCallbackQuery(cq(`symsev:${p.profileId}:2:cough`));
    const row = db
      .prepare(
        `SELECT severity FROM symptom_logs WHERE profile_id = ? AND date = ? AND symptom = 'cough'`
      )
      .get(p.profileId, today(p.profileId)) as { severity: number } | undefined;
    expect(row?.severity).toBe(2);
    expect(answerMock.mock.calls.at(-1)?.[1]).toMatch(/Logged: Cough/i);
  });

  it("a foreign-chat tap writes nothing and answers with the outdated message", async () => {
    answerMock.mockClear();
    await handleCallbackQuery({
      id: "cbq-2",
      data: `symsev:${p.profileId}:3:fever`,
      message: {
        message_id: 9,
        chat: { id: "5559999" }, // not linked to the profile
        reply_markup: { inline_keyboard: [[{ text: "x" }]] },
      },
    });
    const row = db
      .prepare(
        `SELECT 1 FROM symptom_logs WHERE profile_id = ? AND symptom = 'fever'`
      )
      .get(p.profileId);
    expect(row).toBeUndefined();
  });
});

function tempCount(profileId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM medical_records
          WHERE profile_id = ? AND canonical_name = 'Body Temperature'`
      )
      .get(profileId) as { c: number }
  ).c;
}

describe("temperature reply quick-log", () => {
  // #5650 ruling 1: an applied reply is a REACTION and an IN-PLACE EDIT of the prompt.
  // The `🌡 Temperature logged: …` message this flow used to send is now the prompt's own
  // text, so a successful reading costs the chat no new line at all.
  it("a reply to a /temp prompt logs a reading, wears 👍 and edits its prompt", async () => {
    sendMock.mockClear();
    editMock.mockClear();
    reactMock.mockClear();
    const handled = await handleIncomingMessage(tempReply("38.9", p.profileId));
    // 38.9°C ≈ 102.0°F canonical.
    const row = db
      .prepare(
        `SELECT value_num FROM medical_records
          WHERE profile_id = ? AND canonical_name = 'Body Temperature'
          ORDER BY id DESC LIMIT 1`
      )
      .get(p.profileId) as { value_num: number } | undefined;
    expect(row).toBeTruthy();
    expect(row!.value_num).toBeGreaterThan(101);
    expect(row!.value_num).toBeLessThan(103);
    expect(reactMock.mock.calls.at(-1)).toEqual([CHAT, 801, "👍"]);
    const edit = editMock.mock.calls.at(-1)!;
    expect(edit[1]).toBe(PROMPT_ID);
    expect(edit[2]).toMatch(/Temperature logged/);
    // The marker stays: an explicit Reply to the settled prompt still attributes.
    expect(edit[2]).toContain(`(#temp:${p.profileId})`);
    expect(sendMock).not.toHaveBeenCalled();
    expect(handled).toBeUndefined(); // handleIncomingMessage returns void
  });

  it("refuses a copied marker for a profile not linked to the replying chat", async () => {
    const foreign = seedProfile("TG temp marker foreign");
    sendMock.mockClear();
    reactMock.mockClear();

    await handleIncomingMessage(tempReply("38.2", foreign.profileId, 802));

    expect(tempCount(foreign.profileId)).toBe(0);
    // A refusal is the ONE case that still costs a message — and it is spoken, never
    // swallowed. No reaction: nothing was applied.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const reply = sendMock.mock.calls[0][1] as { body: string };
    expect(reply.body).toMatch(/isn't linked to this chat/i);
    expect(reactMock).not.toHaveBeenCalled();
  });

  it("refuses an unreadable reading with one message and no reaction", async () => {
    sendMock.mockClear();
    reactMock.mockClear();
    const before = tempCount(p.profileId);
    await handleIncomingMessage(tempReply("no idea", p.profileId, 803));
    expect(tempCount(p.profileId)).toBe(before);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((sendMock.mock.calls[0][1] as { body: string }).body).toMatch(
      /Couldn't read a temperature/i
    );
    expect(reactMock).not.toHaveBeenCalled();
  });

  // #5650 ruling 2: the obvious thing to type after the bot asks a question.
  it("resolves a BARE number to the chat's one open /temp prompt, then stops", async () => {
    sendMock.mockClear();
    reactMock.mockClear();
    await handleIncomingMessage({
      message_id: 810,
      chat: { id: CHAT },
      from: { id: 71 },
      text: "/temp",
    });
    const promptId = (await sendMock.mock.results.at(-1)!.value) as number;
    const before = tempCount(p.profileId);
    sendMock.mockClear();
    editMock.mockClear();

    await handleIncomingMessage({
      message_id: 811,
      chat: { id: CHAT },
      from: { id: 71 },
      text: "38.4",
    });
    expect(tempCount(p.profileId)).toBe(before + 1);
    expect(reactMock.mock.calls.at(-1)).toEqual([CHAT, 811, "👍"]);
    expect(editMock.mock.calls.at(-1)![1]).toBe(promptId);
    expect(sendMock).not.toHaveBeenCalled();

    // The prompt is answered, so it is no longer open: the next bare number in the same
    // chat is ordinary text again and reaches nothing.
    reactMock.mockClear();
    await handleIncomingMessage({
      message_id: 812,
      chat: { id: CHAT },
      from: { id: 71 },
      text: "120",
    });
    expect(tempCount(p.profileId)).toBe(before + 1);
    expect(reactMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  // #5650 put `temp` and `weight` pointers into the hourly reconcile sweep for the
  // FIRST time — the send chokepoint records one now, and `reconcileProfileMessages`
  // walks every live pointer a profile holds. A `/temp` prompt reaches the generic arm
  // with no keyboard, no prose reconciler and `family === null`, and is left alone
  // because `planEdit` returns null for a family with no rebuilder
  // (lib/notifications/reconcile.ts's `if (!reconciler?.rebuild) return null;` under
  // `decision.action === "none"`), so `reconcilePointer` exits at its `if (!plan)`
  // guard without claiming, editing, closing or dropping anything.
  //
  // THAT IS A READING OF SOMEBODY ELSE'S CONTROL FLOW, WHICH IS WHY IT IS PINNED HERE.
  // Both ways it could go wrong are silent: a DROPPED pointer stops bare-number
  // resolution from the first tick onward, and an EDITED one rewrites an open question
  // under the person who was about to answer it. Neither shows up in a reply-flow
  // drive, because none of those runs a sweep.
  it("survives the reconcile sweep, and still answers a bare number after it", async () => {
    sendMock.mockClear();
    editMock.mockClear();
    reactMock.mockClear();
    await handleIncomingMessage({
      message_id: 820,
      chat: { id: CHAT },
      from: { id: 71 },
      text: "/temp",
    });
    const promptId = (await sendMock.mock.results.at(-1)!.value) as number;
    const before = tempCount(p.profileId);

    const live = () =>
      liveMessagePointersForKind(p.profileId, CHAT, "temp").filter(
        (ptr) => ptr.messageId === promptId
      );
    expect(live()).toHaveLength(1);
    expect(live()[0].date).toBe(today(p.profileId));

    editMock.mockClear();
    sendMock.mockClear();
    const swept = await reconcileProfileMessages(p.profileId);
    // The sweep really did look at it — a vacuous pass would prove nothing.
    expect(swept.examined).toBeGreaterThan(0);

    // (a) still live, same date; (b) the sweep sent and edited NOTHING for it.
    expect(live()).toHaveLength(1);
    expect(live()[0].date).toBe(today(p.profileId));
    expect(editMock.mock.calls.filter((call) => call[1] === promptId)).toEqual(
      []
    );
    expect(sendMock).not.toHaveBeenCalled();

    // (c) THE PROPERTY THAT MATTERS: the prompt is still answerable. This fails
    // whichever way the sweep could have gone wrong.
    await handleIncomingMessage({
      message_id: 821,
      chat: { id: CHAT },
      from: { id: 71 },
      text: "37.2",
    });
    expect(tempCount(p.profileId)).toBe(before + 1);
    expect(reactMock.mock.calls.at(-1)).toEqual([CHAT, 821, "👍"]);
    expect(editMock.mock.calls.at(-1)![1]).toBe(promptId);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("ignores a plain message with no open prompt and no marker", async () => {
    sendMock.mockClear();
    const before = tempCount(p.profileId);
    await handleIncomingMessage({ chat: { id: CHAT }, text: "hello there" });
    expect(tempCount(p.profileId)).toBe(before);
  });
});

// ---- `/dose` renders the safety verdicts it already fetches (issue #1717) ----
//
// The list used to render `💊 Ibuprofen · 200 mg (2 today)` — a bare item-only count —
// while getPrnMedicationsForQuickLog already returned the interval, the confirmed max
// and the ingredient-family counters, and the in-app card rendered the verdict from
// exactly those fields. Two consequences, both pinned here: a tap could pass the
// confirmed daily max with no warning, and the count was family-blind.

// A PRN med with a confirmed 6h interval and a 4/day max. Returns its id.
// A PRN med — `obligation = 'may'` is what makes it as-needed for the quick-log
// gather — with a confirmed 6h interval and 4/day max unless overridden.
function seedPrnMed(
  profileId: number,
  name: string,
  opts: { interval?: number | null; max?: number | null } = {}
): { itemId: number; doseId: number } {
  const { interval = 6, max = 4 } = opts;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            min_interval_hours, max_daily_count, redose_notice)
         VALUES (?, ?, 1, 'medication', 'daily', 'may', ?, ?, 0)`
      )
      .run(profileId, name, interval, max).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', 'anytime', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

// Log one administration `hoursAgo` before now, on the profile's local date.
function logAdminAt(
  profileId: number,
  med: { itemId: number; doseId: number },
  hoursAgo: number
): number {
  const at = new Date(Date.now() - hoursAgo * 3_600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  return Number(
    db
      .prepare(
        // States the administration instant, as the real PRN writer always does; a row
        // with only a capture stamp is an UNPLACED dose since #4686 and arms no window.
        `INSERT INTO intake_item_logs
           (dose_id, item_id, date, recorded_at, occurred_at, status)
         VALUES (?, ?, ?, ?, ?, 'taken')`
      )
      .run(med.doseId, med.itemId, today(profileId), at, at).lastInsertRowid
  );
}

// The labels of the buttons the last /dose send carried.
function lastDoseLabels(): string[] {
  const call = sendMock.mock.calls[sendMock.mock.calls.length - 1];
  const msg = call[1] as {
    actions?: { label: string }[];
  };
  return (msg.actions ?? []).map((a) => a.label);
}

describe("/dose renders its safety verdicts (#1717)", () => {
  it("states 'Max reached' at the confirmed daily max instead of a bare count", async () => {
    const s = seedProfile("DoseMax");
    seedLoginTelegram(s.profileId, "5550777");
    const med = seedPrnMed(s.profileId, "Ibuprofen");
    for (let i = 0; i < 4; i++) logAdminAt(s.profileId, med, 5 - i * 0.5);
    sendMock.mockClear();

    await handleIncomingMessage({ chat: { id: "5550777" }, text: "/dose" });
    const label = lastDoseLabels().find((l) => l.includes("Ibuprofen"))!;
    expect(label).toContain("Max reached");
    expect(label).toContain("4 of 4 in 24h");
  });

  it("names the wait while the minimum interval is still open", async () => {
    const s = seedProfile("DoseWait");
    seedLoginTelegram(s.profileId, "5550778");
    const med = seedPrnMed(s.profileId, "Naproxen");
    logAdminAt(s.profileId, med, 4); // 4h ago against a 6h interval
    sendMock.mockClear();

    await handleIncomingMessage({ chat: { id: "5550778" }, text: "/dose" });
    const label = lastDoseLabels().find((l) => l.includes("Naproxen"))!;
    expect(label).toContain("Next dose in ~2h");
    expect(label).toContain("1 of 4 in 24h");
  });

  it("never invents a ceiling the user did not confirm", async () => {
    const s = seedProfile("DoseNoMax");
    seedLoginTelegram(s.profileId, "5550779");
    const med = seedPrnMed(s.profileId, "Paracetamol", { max: null });
    logAdminAt(s.profileId, med, 8);
    sendMock.mockClear();

    await handleIncomingMessage({ chat: { id: "5550779" }, text: "/dose" });
    const label = lastDoseLabels().find((l) => l.includes("Paracetamol"))!;
    expect(label).toContain("1 in 24h");
    expect(label).not.toContain("Max reached");
    expect(label).not.toContain("of ");
  });

  it("counts the ingredient FAMILY, so the list can't disagree with the card (#1027)", async () => {
    const s = seedProfile("DoseFamily");
    seedLoginTelegram(s.profileId, "5550780");
    // Two items sharing an ingredient family (the #1027 name-derived pair).
    const rx = seedPrnMed(s.profileId, "Ibuprofen 800 mg");
    const otc = seedPrnMed(s.profileId, "Ibuprofen");
    logAdminAt(s.profileId, rx, 9);
    logAdminAt(s.profileId, otc, 8);
    logAdminAt(s.profileId, otc, 7);
    sendMock.mockClear();

    await handleIncomingMessage({ chat: { id: "5550780" }, text: "/dose" });
    const label = lastDoseLabels().find((l) => l.includes("Ibuprofen 800 mg"))!;
    // Family-wide: 3 across 2 items — the item-only count would have said "1 today".
    expect(label).toContain("3 of 4 in 24h across 2 items");
  });

  it("an at-max tap logs (the app treats the window as guidance) but SAYS the verdict", async () => {
    const s = seedProfile("DoseTapMax");
    seedLoginTelegram(s.profileId, "5550781");
    const med = seedPrnMed(s.profileId, "Ibuprofen");
    for (let i = 0; i < 4; i++) logAdminAt(s.profileId, med, 5 - i * 0.5);
    answerMock.mockClear();

    await handleCallbackQuery({
      id: "cbq-max",
      data: `prn:${s.profileId}:${med.itemId}:abcd1234`,
      message: { message_id: 9, chat: { id: "5550781" } },
    });

    const answer = String(answerMock.mock.calls.at(-1)?.[1] ?? "");
    expect(answer).toContain("Logged");
    // The warning is present and the LEDGER agrees with what the answer claims.
    expect(answer).toContain("Max reached");
    expect(answer).toContain("5 of 4 in 24h");
    const { c } = db
      .prepare(
        `SELECT COUNT(*) AS c FROM intake_item_logs WHERE item_id = ? AND status = 'taken'`
      )
      .get(med.itemId) as { c: number };
    expect(c).toBe(5);
  });

  it("a redose-window tap consumes that window and a repeat cannot double-log", async () => {
    const s = seedProfile("RedoseTap");
    seedLoginTelegram(s.profileId, "5550782");
    const med = seedPrnMed(s.profileId, "Redose Ibuprofen");
    const armingId = logAdminAt(s.profileId, med, 7);
    const data = `redose:${s.profileId}:${med.itemId}:${armingId}:abcd1234`;
    const callback = {
      id: "cbq-redose",
      data,
      message: {
        message_id: 10,
        chat: { id: "5550782" },
        text: "💊 Redose window open: Redose Ibuprofen\nWindow open.",
        reply_markup: {
          inline_keyboard: [[{ text: "💊 Log dose", callback_data: data }]],
        },
      },
    };

    answerMock.mockClear();
    editMock.mockClear();
    await handleCallbackQuery(callback);
    expect(String(answerMock.mock.calls.at(-1)?.[1])).toContain("Logged");
    expect(editMock).toHaveBeenCalledTimes(1);

    await handleCallbackQuery({ ...callback, id: "cbq-redose-repeat" });
    expect(String(answerMock.mock.calls.at(-1)?.[1])).toContain(
      "newer dose already closed"
    );
    expect(answerMock.mock.calls.at(-1)?.[2]).toEqual({ alert: true });
    const { c } = db
      .prepare(
        `SELECT COUNT(*) AS c FROM intake_item_logs
          WHERE item_id = ? AND status = 'taken'`
      )
      .get(med.itemId) as { c: number };
    expect(c).toBe(2);
  });

  it("reports a cancelled window when its opening dose was undone", async () => {
    const s = seedProfile("RedoseUndoTap");
    seedLoginTelegram(s.profileId, "5550784");
    const med = seedPrnMed(s.profileId, "Undo Ibuprofen");
    const armingId = logAdminAt(s.profileId, med, 7);
    const data = `redose:${s.profileId}:${med.itemId}:${armingId}:undo1234`;
    db.prepare("DELETE FROM intake_item_logs WHERE id = ?").run(armingId);

    answerMock.mockClear();
    editMock.mockClear();
    await handleCallbackQuery({
      id: "cbq-redose-undone",
      data,
      message: {
        message_id: 12,
        chat: { id: "5550784" },
        text: "💊 Redose window open: Undo Ibuprofen\nWindow open.",
        reply_markup: {
          inline_keyboard: [[{ text: "💊 Log dose", callback_data: data }]],
        },
      },
    });

    expect(String(answerMock.mock.calls.at(-1)?.[1])).toContain(
      "dose that opened this redose window is no longer logged"
    );
    expect(answerMock.mock.calls.at(-1)?.[2]).toEqual({ alert: true });
    expect(String(editMock.mock.calls.at(-1)?.[2])).toContain(
      "Opening dose no longer logged."
    );
    const { c } = db
      .prepare(
        `SELECT COUNT(*) AS c FROM intake_item_logs
          WHERE item_id = ? AND status = 'taken'`
      )
      .get(med.itemId) as { c: number };
    expect(c).toBe(0);
  });

  it("refuses a legacy redose notice instead of treating it as reusable /dose", async () => {
    const s = seedProfile("LegacyRedoseTap");
    seedLoginTelegram(s.profileId, "5550783");
    const med = seedPrnMed(s.profileId, "Legacy Ibuprofen");
    const data = `prn:${s.profileId}:${med.itemId}:legacy`;
    answerMock.mockClear();
    editMock.mockClear();

    await handleCallbackQuery({
      id: "cbq-legacy-redose",
      data,
      message: {
        message_id: 11,
        chat: { id: "5550783" },
        text: "💊 Redose window open: Legacy Ibuprofen\nWindow open.",
        reply_markup: {
          inline_keyboard: [[{ text: "💊 Log dose", callback_data: data }]],
        },
      },
    });

    expect(String(answerMock.mock.calls.at(-1)?.[1])).toContain(
      "old redose action expired"
    );
    expect(answerMock.mock.calls.at(-1)?.[2]).toEqual({ alert: true });
    expect(editMock).toHaveBeenCalledTimes(1);
    const { c } = db
      .prepare("SELECT COUNT(*) AS c FROM intake_item_logs WHERE item_id = ?")
      .get(med.itemId) as { c: number };
    expect(c).toBe(0);
  });
});
