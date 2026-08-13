// DB INTEGRATION TIER — a chat-addressed send names its own SUBJECT (issue #1995).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// `sendTelegramMessage` addresses a CHAT; a live-message pointer is owned by a
// PROFILE. The chokepoint used to bridge that by guessing — the lowest profile the
// chat could act as — whatever the message actually said. In a family chat that means
// Basil's reply records its pointer under Ada, so:
//
//   • Ada's live keyboard is stripped because Basil logged something;
//   • the pointer names Basil's message but belongs to Ada, so Ada's next send closes
//     Basil's buttons;
//   • the two trade one (chat, kind) slot back and forth forever, and neither ever
//     holds the single live keyboard #1898 exists to guarantee.
//
// Nothing lands on the wrong person — callback tokens carry their own profile id and
// `resolveTapProfile` re-checks it on tap (#797) — so what these cases are about is
// the AFFORDANCE: whose buttons get taken away.
//
// ── WHAT IS PINNED ───────────────────────────────────────────────────────────
//
// A two-profile chat, driven through the REAL chokepoint with only the Telegram
// network surface stubbed:
//
//   (1) a send made FOR one profile records its pointer under that profile — the case
//       the guess got wrong, and the one every per-profile verb depends on;
//   (2) two profiles' per-profile sends of the same kind leave two pointers and close
//       NOTHING, so neither member's keyboard is taken by the other's send;
//   (3) a CHAT_WIDE send still takes the chat's stable representative, so `/dose` and
//       `/mood` keep re-issuing onto one slot instead of stacking;
//   (4) a chat that maps to no profile records nothing rather than inventing an owner.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import { getProfilesByTelegramChatId, setSetting } from "@/lib/settings";
import { CHAT_WIDE, sendTelegramMessage } from "@/lib/notifications/telegram";
import { handleIncomingMessage } from "@/lib/notifications/telegram-quick-log";
import {
  editMessageTextRaw,
  sendMessageRaw,
} from "@/lib/notifications/telegram-api";
import { liveMessagePointersForKind } from "@/lib/notifications/message-pointers";
import type { NotificationMessage } from "@/lib/notifications/types";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
beforeAll(() => stubTelegramSends());

const sendMock = vi.mocked(sendMessageRaw);
const closeMock = vi.mocked(editMessageTextRaw);

const CHAT = "5550995";
const UNLINKED_CHAT = "5550996";

// Ada is seeded first, so she is the LOWEST profile id in the chat — the owner the
// old guess handed every pointer to.
let ada: SeededProfile;
let basil: SeededProfile;

// A check-in, which is re-issuable (KIND_REISSUE) and so actually exercises the
// supersede arm. One button is enough: what matters is that a keyboard exists.
function checkIn(profileId: number): NotificationMessage {
  return {
    title: "🙂 How are you today?",
    body: "One tap logs your day.",
    kind: "mood",
    actions: [
      { label: "🙂 Good", data: `mood:${profileId}:4:${today(profileId)}` },
    ],
  };
}

// Who owns the live `mood` pointers in this chat, oldest first.
function moodOwners(): number[] {
  return (
    db
      .prepare(
        `SELECT profile_id FROM notify_messages
          WHERE chat_id = ? AND kind = 'mood' ORDER BY sent_at, id`
      )
      .all(CHAT) as { profile_id: number }[]
  ).map((r) => r.profile_id);
}

beforeAll(() => {
  ada = seedProfile("subject-ada");
  basil = seedProfile("subject-basil");
  setSetting("telegram_bot_token", "test-bot-token");
  // ONE chat, two data subjects — the household shape the guess could not express.
  seedLoginTelegram(ada.profileId, CHAT);
  seedLoginTelegram(basil.profileId, CHAT);
  // One as-needed medication, so `/dose` yields a button-carrying list.
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, kind, obligation, active)
     VALUES (?, 'Ibuprofen', 'medication', 'may', 1)`
  ).run(ada.profileId);
});

beforeEach(() => {
  sendMock.mockClear();
  closeMock.mockClear();
  db.prepare("DELETE FROM notify_messages WHERE chat_id IN (?, ?)").run(
    CHAT,
    UNLINKED_CHAT
  );
});

describe("the subject of a chat-addressed send (#1995)", () => {
  it("the chat really does map to both profiles, Ada first", () => {
    // The premise the defect rode on: `getProfilesByTelegramChatId` is sorted, so
    // "the first one" was always the same person regardless of the message.
    expect(getProfilesByTelegramChatId(CHAT)).toEqual([
      ada.profileId,
      basil.profileId,
    ]);
  });

  it("a send made FOR a profile records ITS pointer, not the chat's lowest", async () => {
    await sendTelegramMessage(CHAT, checkIn(basil.profileId), basil.profileId);

    expect(moodOwners()).toEqual([basil.profileId]);
    expect(liveMessagePointersForKind(ada.profileId, CHAT, "mood")).toEqual([]);
  });

  it("two members' per-profile sends do not close each other's keyboard", async () => {
    // The household case from the issue, verbatim. Under the guess both pointers
    // landed on Ada, so Basil's send superseded — and stripped — hers.
    await sendTelegramMessage(CHAT, checkIn(ada.profileId), ada.profileId);
    await sendTelegramMessage(CHAT, checkIn(basil.profileId), basil.profileId);

    expect(moodOwners()).toEqual([ada.profileId, basil.profileId]);
    // Two live keyboards, one per subject — and nothing was closed to get there.
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("each member's OWN re-issue still supersedes only their own copy", async () => {
    // The invariant is per subject, not abandoned: Ada asking twice leaves Ada with
    // one keyboard, and does not touch Basil's.
    await sendTelegramMessage(CHAT, checkIn(ada.profileId), ada.profileId);
    await sendTelegramMessage(CHAT, checkIn(basil.profileId), basil.profileId);
    closeMock.mockClear();

    await sendTelegramMessage(CHAT, checkIn(ada.profileId), ada.profileId);

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(moodOwners()).toEqual([basil.profileId, ada.profileId]);
    expect(
      liveMessagePointersForKind(ada.profileId, CHAT, "mood")
    ).toHaveLength(1);
    expect(
      liveMessagePointersForKind(basil.profileId, CHAT, "mood")
    ).toHaveLength(1);
  });

  it("a CHAT_WIDE send takes the chat's STABLE representative", async () => {
    // A message that covers the whole chat has no one subject, and the representative
    // must be the same one every time or the (chat, kind) slot cannot re-issue.
    await sendTelegramMessage(CHAT, checkIn(ada.profileId), CHAT_WIDE);
    await sendTelegramMessage(CHAT, checkIn(basil.profileId), CHAT_WIDE);

    expect(moodOwners()).toEqual([ada.profileId]);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("a chat that maps to NO profile records nothing rather than guessing", async () => {
    await sendTelegramMessage(UNLINKED_CHAT, checkIn(ada.profileId), CHAT_WIDE);

    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM notify_messages WHERE chat_id = ?`)
      .get(UNLINKED_CHAT) as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("the real commands keep their subjects (#1995)", () => {
  it("`/dose` re-issues onto ONE slot in a two-profile chat", async () => {
    // The chat-wide verb: one message, per-profile prefixed buttons. Its subject must
    // stay stable across calls, which is what makes the second call a re-issue.
    await handleIncomingMessage({
      message_id: 1,
      chat: { id: CHAT },
      text: "/dose",
    });
    await handleIncomingMessage({
      message_id: 2,
      chat: { id: CHAT },
      text: "/dose",
    });

    const owners = (
      db
        .prepare(
          `SELECT profile_id FROM notify_messages
            WHERE chat_id = ? AND kind = 'prn-list'`
        )
        .all(CHAT) as { profile_id: number }[]
    ).map((r) => r.profile_id);
    expect(owners).toEqual([ada.profileId]);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("`/temp` prompts each member SEPARATELY — the per-profile shape", async () => {
    // Two messages, each carrying its own subject's reply marker. This is the send
    // shape the guess could not attribute; the prompts are button-less today, so what
    // the fix buys here is that the attribution is right the moment one gains a
    // keyboard rather than the day someone notices.
    await handleIncomingMessage({
      message_id: 3,
      chat: { id: CHAT },
      text: "/temp",
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    const bodies = sendMock.mock.calls.map((c) =>
      String((c[1] as NotificationMessage).body)
    );
    expect(bodies[0]).toContain(`#temp:${ada.profileId}`);
    expect(bodies[1]).toContain(`#temp:${basil.profileId}`);
  });
});
