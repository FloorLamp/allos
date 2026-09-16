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

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import { setProfileSetting } from "@/lib/settings";
import { handleIncomingMessage } from "@/lib/notifications/telegram-quick-log";
import {
  editMessageReplyMarkupRaw,
  editMessageTextRaw,
  sendMessageRaw,
  setMessageReaction,
} from "@/lib/notifications/telegram-api";
import { TELEGRAM_COMMANDS } from "@/lib/notifications/telegram-commands";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";
import { liveMessagePointersForKind } from "@/lib/notifications/message-pointers";

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
// The shared stub hands out a FRESH id per send, which is what Telegram does. This
// file used to pin a CONSTANT one (#2747 kept it deliberately, #2749 removed it),
// and four "one live keyboard" assertions below were passing because of it:
// `notify_messages` is UNIQUE on `(chat_id, message_id)`, so two sends sharing an id
// collided into ONE row and every `COUNT(*) = 1` held whether or not the supersede
// had happened. Distinct ids are what make those counts mean anything at all.
beforeAll(() => stubTelegramSends());

const sendMock = vi.mocked(sendMessageRaw);
const editMock = vi.mocked(editMessageTextRaw);
const reactMock = vi.mocked(setMessageReaction);
const stripMock = vi.mocked(editMessageReplyMarkupRaw);

// The id Telegram answered the most recent send with. Read off the stub's own result
// rather than guessed, so the test never re-states the numbering it is testing against.
async function sentMessageId(): Promise<number> {
  const results = sendMock.mock.results;
  expect(results.length).toBeGreaterThan(0);
  return (await results[results.length - 1].value) as number;
}

const CHAT = "5550520";
const UNLINKED_CHAT = "5559999";
// A second chat mapping to TWO profiles — the family case every command has to answer
// without guessing whose data it is (#1995).
const SHARED_CHAT = "5550521";
const PRACTICE_NAME = "Sauna";
let p: SeededProfile;
let ada: SeededProfile;
let ben: SeededProfile;

function say(text: string, chatId: string = CHAT) {
  return handleIncomingMessage({
    message_id: 1,
    chat: { id: chatId },
    text,
  });
}

// Send a real `/weight` and hand back the id the wire assigned its prompt — the id the
// send chokepoint recorded a pointer under. Under pointer-only (#5650) that pointer IS
// the prompt: a reply quotes its id and the registry says which family and whose profile.
async function openWeightPrompt(chatId: string = CHAT): Promise<number> {
  await say("/weight", chatId);
  return sentMessageId();
}

// The body of the single message the dispatcher sent.
function replyBody(): string {
  expect(sendMock).toHaveBeenCalledTimes(1);
  const msg = sendMock.mock.calls[0][1] as { title: string; body: unknown };
  return `${msg.title}\n${String(msg.body)}`;
}

// One tracked wellness practice — the frequency target `/practice` logs against.
function seedPractice(profileId: number, name: string): void {
  db.prepare(
    `INSERT INTO frequency_targets
       (profile_id, scope_kind, scope_value, scope_identity, per_week)
     VALUES (?, 'practice', ?, ?, 3)`
  ).run(profileId, name, name.toLowerCase());
}

beforeAll(() => {
  p = seedProfile("commands");
  seedLoginTelegram(p.profileId, CHAT);
  setProfileSetting(p.profileId, "mood_checkin_enabled", "1");
  setProfileSetting(p.profileId, "food_telegram_enabled", "1");
  seedPractice(p.profileId, PRACTICE_NAME);
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, kind, obligation, active)
     VALUES (?, 'Ibuprofen', 'medication', 'may', 1)`
  ).run(p.profileId);

  ada = seedProfile("Ada");
  ben = seedProfile("Ben");
  seedLoginTelegram(ada.profileId, SHARED_CHAT);
  seedLoginTelegram(ben.profileId, SHARED_CHAT);
});

beforeEach(() => {
  sendMock.mockClear();
  stripMock.mockClear();
  for (const pid of [p.profileId, ada.profileId, ben.profileId]) {
    db.prepare("DELETE FROM notify_messages WHERE profile_id = ?").run(pid);
    db.prepare("DELETE FROM mood_logs WHERE profile_id = ?").run(pid);
  }
  db.prepare("DELETE FROM practice_logs WHERE profile_id = ?").run(p.profileId);
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

// ── The three verbs #2130 decided IN and #1895 built ────────────────────────
//
// Each is a RE-RENDER of an existing builder or a re-use of an existing write core
// (#221) reached through the ONE dispatcher — never a second engine, and never a new
// send: every message below is a reply to something the user typed one second earlier.

describe("/food on demand (#1895)", () => {
  it("renders the food keyboard from the SAME builder the tick uses", async () => {
    await say("/food");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0][1] as {
      actions?: { data?: string }[];
      kind?: string;
    };
    expect(msg.kind).toBe("food");
    const tokens = (msg.actions ?? []).map((a) => a.data ?? "");
    expect(tokens.length).toBeGreaterThan(0);
    // The send renderer's own token shape, with the ORIGIN MARKER this reply mints
    // (#3087): food:c:<pid>:<window>:<date>:<group>. `c` is what tells `handleFoodLog`
    // that a tap on this keyboard is a slash-command tap and not a nudge tap — the two
    // are otherwise byte-identical, because `/food` re-renders the nudge's own builder.
    expect(
      tokens.some((t) =>
        new RegExp(
          `^food:c:${p.profileId}:(Morning|Midday|Evening):${today(p.profileId)}:`
        ).test(t)
      )
    ).toBe(true);
  });

  it("does NOT require the food-nudge opt-in — a typed verb is access, not contact", async () => {
    // The opt-in decides whether the TICK may send; this message exists because the
    // user asked for it.
    setProfileSetting(p.profileId, "food_telegram_enabled", "");
    await say("/food");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(
      (sendMock.mock.calls[0][1] as { actions?: unknown[] }).actions?.length
    ).toBeGreaterThan(0);
  });

  it("a second /food strips the first — one live food keyboard (#947/#1898)", async () => {
    await say("/food");
    const first = await sentMessageId();
    await say("/food");
    const second = await sentMessageId();
    // Distinct ids, or the rest of this test is theatre: two sends sharing one id
    // collide on `notify_messages`' UNIQUE (chat_id, message_id) and leave a single
    // row no matter what the strip did (#2749).
    expect(second).not.toBe(first);

    // The CHAT: the predecessor's keyboard was taken away.
    const stripCall = stripMock.mock.calls.find((c) => c[1] === first);
    expect(stripCall).toBeDefined();
    expect(String(stripCall![0])).toBe(CHAT);
    expect(stripCall![2]).toEqual([]);

    // The POINTER TABLE, which is what the hourly sweep reasons from. A row here is a
    // live keyboard by construction — the store holds only keyboard-bearing (or prose)
    // messages, and every close in the system DELETES the row rather than blanking a
    // column — so counting rows IS the liveness question. It is deliberately not
    // scoped by date: "one live keyboard per (chat, kind)" (#1898) spans days, and a
    // yesterday-dated food keyboard left live is precisely the wrong-day tap #947
    // exists to prevent.
    const live = db
      .prepare(
        `SELECT message_id FROM notify_messages
          WHERE profile_id = ? AND chat_id = ? AND kind = 'food'`
      )
      .all(p.profileId, CHAT) as { message_id: number }[];
    // WHICH one survives, not just how many: keeping the stripped message and closing
    // the live one is also "exactly one row".
    expect(live.map((r) => r.message_id)).toEqual([second]);
  });
});

describe("/practice on demand (#1895)", () => {
  it("lists the tracked practices with the shared line and an inert log button", async () => {
    await say("/practice");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0][1] as {
      body: unknown;
      actions?: { data?: string; label?: string }[];
      kind?: string;
    };
    expect(msg.kind).toBe("practice-list");
    expect(String(msg.body)).toContain(PRACTICE_NAME);
    const tokens = (msg.actions ?? []).map((a) => a.data ?? "");
    expect(
      tokens.some((t) => new RegExp(`^plog:${p.profileId}:\\d+:`).test(t))
    ).toBe(true);
  });

  it("offers a practice that is ON TRACK too — it is a logger, not a nudge", async () => {
    // The pace nudge only names what is behind. A verb the user typed answers with
    // everything they track, met or not.
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date) VALUES (?, ?, ?)`
    ).run(p.profileId, PRACTICE_NAME, today(p.profileId));
    await say("/practice");
    const msg = sendMock.mock.calls[0][1] as {
      actions?: { label?: string }[];
    };
    expect(
      (msg.actions ?? []).some((a) => a.label?.includes(PRACTICE_NAME))
    ).toBe(true);
  });

  it("a repeated /practice supersedes its predecessor (#1898)", async () => {
    await say("/practice");
    await say("/practice");
    const live = db
      .prepare(
        `SELECT COUNT(*) AS n FROM notify_messages
          WHERE profile_id = ? AND chat_id = ? AND kind = 'practice-list'`
      )
      .get(p.profileId, CHAT) as { n: number };
    expect(live.n).toBe(1);
  });
});

describe("/weight on demand (#1895)", () => {
  it("prompts with a kind that records the pointer the reply resolves against", async () => {
    await say("/weight");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0][1] as { body: unknown; kind?: string };
    // The KIND is what makes the send chokepoint record a pointer for this message
    // (`awaitsTypedReply`), and that pointer is the whole of the prompt's identity now.
    expect(msg.kind).toBe("weight");
    // NO MARKER. `(#weight:<pid>)` used to end this body and carry the attribution; it is
    // retired, because the body also renders a profile NAME a person types in-app and a
    // reader that trusts one has to trust the other.
    expect(String(msg.body)).not.toMatch(/\((#)?(temp|weight|refill):/);
    const pointer = liveMessagePointersForKind(p.profileId, CHAT, "weight");
    expect(pointer.map((ptr) => ptr.messageId)).toContain(
      await sentMessageId()
    );
  });

  it("the REPLY lands through the shared core, in canonical kg", async () => {
    const before = db
      .prepare(
        "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND date = ?"
      )
      .get(p.profileId, today(p.profileId)) as { n: number };

    const promptId = await openWeightPrompt();
    editMock.mockClear();
    reactMock.mockClear();
    sendMock.mockClear();
    await handleIncomingMessage({
      message_id: 2,
      chat: { id: CHAT },
      from: { id: 71 },
      text: "82.5",
      reply_to_message: { message_id: promptId },
    });

    const row = db
      .prepare(
        `SELECT weight_kg, occurred_at FROM body_metrics
          WHERE profile_id = ? AND date = ? ORDER BY id DESC LIMIT 1`
      )
      .get(p.profileId, today(p.profileId)) as {
      weight_kg: number;
      occurred_at: string | null;
    };
    expect(row.weight_kg).toBeCloseTo(82.5, 5);
    const after = db
      .prepare(
        "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND date = ?"
      )
      .get(p.profileId, today(p.profileId)) as { n: number };
    // EDITED DELIBERATELY by #2235 (decision 6): the fixture already seeds
    // today's manual weigh-in, and the manual core is find-then-write now, so
    // the reply CORRECTS that day row instead of stacking a second one. And the
    // bot is a TIME-BLIND caller — it states nothing about when, so it neither
    // invents an occurred_at nor clears a stated one.
    expect(after.n).toBe(before.n);
    expect(row.occurred_at).toBeNull();
    // #5650 ruling 1: the answer is the PROMPT, edited where it already sits, plus a 👍
    // on the reading. The `⚖️ Weight logged: …` message this used to send is gone.
    expect(sendMock).not.toHaveBeenCalled();
    const edit = editMock.mock.calls.at(-1)!;
    expect(edit[1]).toBe(promptId);
    expect(String(edit[2])).toContain("82.5 kg");
    expect(reactMock.mock.calls.at(-1)).toEqual([CHAT, 2, "👍"]);
  });

  // THERE IS NO MARKER LEFT TO COPY (#5650, pointer-only). This case used to quote a
  // marker naming a profile the chat cannot write and assert the arm refused it. A reply
  // carries only the quoted message's ID now, and every id the registry resolves belongs
  // to a profile of this chat — so the forgery is unreachable rather than refused, and
  // what a reply to a message the store holds no prompt for gets is the thing to pin.
  it("answers a number replied to a message it holds no prompt for, and writes nothing", async () => {
    const foreign = seedProfile("Weight marker foreign");
    const before = db
      .prepare(
        `SELECT id, date, weight_kg FROM body_metrics
          WHERE profile_id = ? ORDER BY id`
      )
      .all(foreign.profileId);

    await handleIncomingMessage({
      message_id: 6,
      chat: { id: CHAT },
      text: "82.5",
      // A pre-#5650 prompt, or one whose pointer has been pruned. Either way: no record.
      reply_to_message: { message_id: 999999 },
    });

    const after = db
      .prepare(
        `SELECT id, date, weight_kg FROM body_metrics
          WHERE profile_id = ? ORDER BY id`
      )
      .all(foreign.profileId);
    expect(after).toEqual(before);
    expect(replyBody()).toMatch(/isn't open/i);
    expect(replyBody()).toMatch(/Reply to the prompt you mean/i);
  });

  it("an explicit lb reply converts at the boundary", async () => {
    await handleIncomingMessage({
      message_id: 3,
      chat: { id: CHAT },
      text: "180 lb",
      reply_to_message: { message_id: await openWeightPrompt() },
    });
    const row = db
      .prepare(
        `SELECT weight_kg FROM body_metrics
          WHERE profile_id = ? AND date = ? ORDER BY id DESC LIMIT 1`
      )
      .get(p.profileId, today(p.profileId)) as { weight_kg: number };
    expect(row.weight_kg).toBeCloseTo(81.6, 1);
  });

  it("an unreadable reply is REFUSED, never confirmed", async () => {
    const promptId = await openWeightPrompt();
    // The prompt's own send is not the answer under test — `replyBody` reads the ONE
    // message the reply produced.
    sendMock.mockClear();
    await handleIncomingMessage({
      message_id: 4,
      chat: { id: CHAT },
      text: "quite heavy today",
      reply_to_message: { message_id: promptId },
    });
    expect(replyBody()).toMatch(/not logged/i);
  });

  it("an implausible number is refused with the FORM's own message", async () => {
    const promptId = await openWeightPrompt();
    // The prompt's own send is not the answer under test — `replyBody` reads the ONE
    // message the reply produced.
    sendMock.mockClear();
    await handleIncomingMessage({
      message_id: 5,
      chat: { id: CHAT },
      text: "9000",
      reply_to_message: { message_id: promptId },
    });
    expect(replyBody()).toMatch(/too high to be real/i);
  });
});

describe("a multi-profile chat never guesses (#1995)", () => {
  it("/weight prompts each profile by name, each with its own pointer", async () => {
    await say("/weight", SHARED_CHAT);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const bodies = sendMock.mock.calls.map((c) =>
      String((c[1] as { body: unknown }).body)
    );
    expect(bodies.some((b) => b.includes("Ada"))).toBe(true);
    expect(bodies.some((b) => b.includes("Ben"))).toBe(true);
    // ONE PROMPT PER PROFILE, each findable on its OWN record (#5650 pointer-only). The
    // attribution used to be a marker in the body, printed right after the name — which
    // is exactly the adjacency that let a profile named like a marker steer a reply.
    for (const who of [ada, ben]) {
      const live = liveMessagePointersForKind(who.profileId, SHARED_CHAT, "weight");
      expect(live).toHaveLength(1);
      expect(live[0].chatId).toBe(SHARED_CHAT);
    }
    expect(bodies.every((b) => !/\((#)?(temp|weight|refill):/.test(b))).toBe(true);
  });

  it("/food sends one keyboard PER profile — the food rebuild reads one subject", async () => {
    await say("/food", SHARED_CHAT);
    expect(sendMock).toHaveBeenCalledTimes(2);
    for (const call of sendMock.mock.calls) {
      const msg = call[1] as { actions?: { data?: string }[] };
      const owners = new Set(
        (msg.actions ?? [])
          // Field 1 is the origin marker on a `/food` token (#3087); the profile id
          // is the first ALL-DIGITS field, which is what this is asking about.
          .map((a) => a.data?.split(":").find((f) => /^\d+$/.test(f)))
          .filter((x): x is string => x != null)
      );
      // Exactly one profile's tokens per message.
      expect(owners.size).toBe(1);
    }
  });
});

describe("legacy /mood re-issue", () => {
  it("stays one live keyboard", async () => {
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
