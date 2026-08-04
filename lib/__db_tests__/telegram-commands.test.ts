// DB INTEGRATION TIER — the command vocabulary ROUTED (#1895), through the real
// dispatcher with only the Telegram network surface stubbed.
//
// The defect was silence. Every handler no-opped on non-matching text and nothing
// answered afterwards, so `/start` — the first thing Telegram shows a new user, before
// they have typed a word — `/help`, and a typo'd `/doze` all vanished. From the chat's
// side that is indistinguishable from a broken bot.
//
// THE RULE PINNED HERE: a slash command in a chat the bot is in gets an answer. Always.
// Plus the completeness pin — every verb in TELEGRAM_COMMANDS is actually routed, so a
// verb can never be advertised in Telegram's `/` menu and then answer with nothing.

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return {
    ...actual,
    sendMessageRaw: vi.fn(async () => 1),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => {}),
  };
});

import { db, today } from "@/lib/db";
import { setProfileSetting } from "@/lib/settings";
import { handleIncomingMessage } from "@/lib/notifications/telegram-quick-log";
import { sendMessageRaw } from "@/lib/notifications/telegram-api";
import { TELEGRAM_COMMANDS } from "@/lib/notifications/telegram-commands";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

const sendMock = vi.mocked(sendMessageRaw);

const CHAT = "5550520";
const UNLINKED_CHAT = "5559999";
let p: SeededProfile;

function say(text: string, chatId: string = CHAT) {
  return handleIncomingMessage({
    message_id: 1,
    chat: { id: chatId },
    text,
  });
}

// The body of the single message the dispatcher sent.
function replyBody(): string {
  expect(sendMock).toHaveBeenCalledTimes(1);
  const msg = sendMock.mock.calls[0][1] as { title: string; body: unknown };
  return `${msg.title}\n${String(msg.body)}`;
}

beforeAll(() => {
  p = seedProfile("commands");
  seedLoginTelegram(p.profileId, CHAT);
  setProfileSetting(p.profileId, "mood_checkin_enabled", "1");
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, kind, obligation, active)
     VALUES (?, 'Ibuprofen', 'medication', 'may', 1)`
  ).run(p.profileId);
});

beforeEach(() => {
  sendMock.mockClear();
  db.prepare("DELETE FROM notify_messages WHERE profile_id = ?").run(
    p.profileId
  );
  db.prepare("DELETE FROM mood_logs WHERE profile_id = ?").run(p.profileId);
});

describe("discoverability (#1895 half 1)", () => {
  it("/help lists the chat's verbs", async () => {
    await say("/help");
    const body = replyBody();
    expect(body).toContain("/dose");
    expect(body).toContain("/symptom");
    expect(body).toContain("/mood");
  });

  it("/help names only what THIS chat can do", async () => {
    setProfileSetting(p.profileId, "mood_checkin_enabled", "");
    await say("/help");
    expect(replyBody()).not.toContain("/mood");
    setProfileSetting(p.profileId, "mood_checkin_enabled", "1");
  });

  it("/start answers, and hands over to the verb list", async () => {
    // The first thing Telegram shows a new user. It used to vanish entirely.
    await say("/start");
    expect(replyBody()).toContain("/dose");
  });

  it("an unknown command answers instead of vanishing", async () => {
    await say("/doze");
    const body = replyBody();
    expect(body).toContain("/doze");
    expect(body).toContain("/help");
  });

  it("a REAL verb gated off for this chat gets a different answer from an unknown one", async () => {
    setProfileSetting(p.profileId, "mood_checkin_enabled", "");
    await say("/mood");
    const gated = replyBody();
    sendMock.mockClear();
    await say("/nonsense");
    const unknown = replyBody();
    expect(gated).not.toEqual(unknown);
    expect(gated).toContain("/mood");
    setProfileSetting(p.profileId, "mood_checkin_enabled", "1");
  });

  it("an UNLINKED chat is told what is actually wrong", async () => {
    await say("/dose", UNLINKED_CHAT);
    const body = replyBody();
    expect(body).toMatch(/isn't linked/i);
    expect(body).toContain("/help");
  });

  it("ordinary text is still NOT answered — the bot does not hijack chat", async () => {
    await say("just talking in the group");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("a command addressed by bot name routes the same", async () => {
    await say("/help@allosbot");
    expect(replyBody()).toContain("/dose");
  });

  it("EVERY verb in the vocabulary is routed — nothing is advertised and then silent", async () => {
    // The completeness pin. Telegram's `/` menu is registered from TELEGRAM_COMMANDS,
    // so a verb with no route would be offered by autocomplete and answer with nothing
    // — the exact defect, re-introduced through the fix for it.
    for (const c of TELEGRAM_COMMANDS) {
      sendMock.mockClear();
      await say(`/${c.name}`);
      expect(
        sendMock.mock.calls.length,
        `/${c.name} produced no reply`
      ).toBeGreaterThan(0);
    }
  });

  it("every ALIAS routes too", async () => {
    for (const c of TELEGRAM_COMMANDS) {
      for (const alias of c.aliases ?? []) {
        sendMock.mockClear();
        await say(`/${alias}`);
        expect(
          sendMock.mock.calls.length,
          `/${alias} produced no reply`
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("/mood on demand (#1895 half 2)", () => {
  it("renders the check-in keyboard from the SAME builder the tick uses", async () => {
    await say("/mood");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0][1] as {
      actions?: { data?: string }[];
      kind?: string;
    };
    expect(msg.kind).toBe("mood");
    // The token shape is the send renderer's, not a second one: mood:<pid>:<v>:<date>.
    const tokens = (msg.actions ?? []).map((a) => a.data ?? "");
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(t).toMatch(
        new RegExp(`^mood:${p.profileId}:\\d+:${today(p.profileId)}$`)
      );
    }
  });

  it("a day already logged is answered HONESTLY, not with an empty keyboard", async () => {
    // Never confirm what the write would refuse: a command that silently produced
    // nothing is the defect this issue exists to fix.
    db.prepare(
      `INSERT INTO mood_logs (profile_id, date, valence) VALUES (?, ?, 4)`
    ).run(p.profileId, today(p.profileId));

    await say("/mood");
    const msg = sendMock.mock.calls[0][1] as {
      body: unknown;
      actions?: unknown[];
    };
    expect(String(msg.body)).toMatch(/already checked in/i);
    expect(msg.actions ?? []).toHaveLength(0);
  });

  it("a repeated /mood supersedes its predecessor (one live keyboard, #1898)", async () => {
    await say("/mood");
    const live = db
      .prepare(
        `SELECT COUNT(*) AS n FROM notify_messages
          WHERE profile_id = ? AND chat_id = ? AND kind = 'mood'`
      )
      .get(p.profileId, CHAT) as { n: number };
    expect(live.n).toBe(1);

    await say("/mood");
    const after = db
      .prepare(
        `SELECT COUNT(*) AS n FROM notify_messages
          WHERE profile_id = ? AND chat_id = ? AND kind = 'mood'`
      )
      .get(p.profileId, CHAT) as { n: number };
    expect(after.n).toBe(1);
  });
});
