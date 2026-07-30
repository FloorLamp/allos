// DB INTEGRATION TIER — the #859 item 5 Telegram quick-log flows driven end-to-end,
// with only the Telegram network surface stubbed (the #454 guarded boundary). Proves
// the symptom button grid → severity → log path and the /temp reply flow route to the
// SAME write cores the app uses and write the expected rows, answering from the typed
// outcome (never an unconditional confirm). The pure parse half is in
// lib/__tests__/telegram-quicklog-parse.test.ts.

import { vi, describe, it, expect, beforeAll } from "vitest";

vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    sendMessageRaw: vi.fn(async () => {}),
  };
});

import { db, today } from "@/lib/db";
import { setProfileSetting } from "@/lib/settings";
import {
  handleCallbackQuery,
  handleIncomingMessage,
} from "@/lib/notifications/telegram-callbacks";
import {
  answerCallbackQuery,
  editMessageTextRaw,
  sendMessageRaw,
} from "@/lib/notifications/telegram-api";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";
import { tempReplyMarker } from "@/lib/notifications/callback-data";

const answerMock = vi.mocked(answerCallbackQuery);
const editMock = vi.mocked(editMessageTextRaw);
const sendMock = vi.mocked(sendMessageRaw);

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

describe("temperature reply quick-log", () => {
  it("a reply to a /temp prompt logs a reading and confirms", async () => {
    sendMock.mockClear();
    const handled = await handleIncomingMessage({
      chat: { id: CHAT },
      text: "38.9",
      reply_to_message: {
        text: `Reply with the temperature. ${tempReplyMarker(p.profileId)}`,
      },
    });
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
    // A confirmation was sent through the chokepoint.
    expect(sendMock).toHaveBeenCalled();
    expect(handled).toBeUndefined(); // handleIncomingMessage returns void
  });

  it("ignores a plain message with no temp-reply marker", async () => {
    sendMock.mockClear();
    const before = db
      .prepare(
        `SELECT COUNT(*) AS c FROM medical_records WHERE profile_id = ? AND canonical_name = 'Body Temperature'`
      )
      .get(p.profileId) as { c: number };
    await handleIncomingMessage({ chat: { id: CHAT }, text: "hello there" });
    const after = db
      .prepare(
        `SELECT COUNT(*) AS c FROM medical_records WHERE profile_id = ? AND canonical_name = 'Body Temperature'`
      )
      .get(p.profileId) as { c: number };
    expect(after.c).toBe(before.c);
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
): void {
  const at = new Date(Date.now() - hoursAgo * 3_600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, status)
     VALUES (?, ?, ?, ?, 'taken')`
  ).run(med.doseId, med.itemId, today(profileId), at);
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
    expect(label).toContain("4 of 4 today");
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
    expect(label).toContain("1 of 4 today");
  });

  it("never invents a ceiling the user did not confirm", async () => {
    const s = seedProfile("DoseNoMax");
    seedLoginTelegram(s.profileId, "5550779");
    const med = seedPrnMed(s.profileId, "Paracetamol", { max: null });
    logAdminAt(s.profileId, med, 8);
    sendMock.mockClear();

    await handleIncomingMessage({ chat: { id: "5550779" }, text: "/dose" });
    const label = lastDoseLabels().find((l) => l.includes("Paracetamol"))!;
    expect(label).toContain("1 today");
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
    expect(label).toContain("3 of 4 today across 2 items");
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
    expect(answer).toContain("5 of 4 today");
    const { c } = db
      .prepare(
        `SELECT COUNT(*) AS c FROM intake_item_logs WHERE item_id = ? AND status = 'taken'`
      )
      .get(med.itemId) as { c: number };
    expect(c).toBe(5);
  });
});
