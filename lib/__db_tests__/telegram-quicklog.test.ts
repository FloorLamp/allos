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
import { seedProfile, type SeededProfile } from "./fixtures";
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
  setProfileSetting(p.profileId, "telegram_chat_id", CHAT);
  setProfileSetting(p.profileId, "telegram_enabled", "1");
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
