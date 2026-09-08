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

import Database from "better-sqlite3";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore } from "@/lib/migrations/versions";
import { dispatch } from "@/lib/notifications";
import { renderRefillMessage } from "@/lib/notifications/refill";
import { renderEscalationMessage } from "@/lib/notifications/escalation";
import { renderFollowUpNudgeMessage } from "@/lib/notifications/followup";
import { renderEaseBackMessage } from "@/lib/notifications/ease-back";
import { renderIllnessCareMessage } from "@/lib/notifications/illness-care";
import { renderTempRedFlagMessage } from "@/lib/notifications/temp-red-flag";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, rawDb, today } from "@/lib/db";
import { getProfilesByTelegramChatId, setSetting } from "@/lib/settings";
import {
  CHAT_WIDE,
  rebuildMessage,
  renderMessageHtml,
  sendTelegramMessage,
} from "@/lib/notifications/telegram";
import { handleIncomingMessage } from "@/lib/notifications/telegram-quick-log";
import {
  editMessageTextRaw,
  sendMessageRaw,
} from "@/lib/notifications/telegram-api";
import {
  liveMessagePointersForKind,
  messagePointerAt,
  recordMessagePointer,
  claimMessagePointerClose,
  restoreMessagePointer,
} from "@/lib/notifications/message-pointers";
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

describe("delivered subject survives a rebuild (#4789)", () => {
  it.each(["representative", "other member"])(
    "keeps a shared send unprefixed for the %s",
    async (actor) => {
      const message = checkIn(basil.profileId);
      await sendTelegramMessage(CHAT, message, CHAT_WIDE);
      const pointer = liveMessagePointersForKind(
        ada.profileId,
        CHAT,
        "mood"
      )[0];
      const delivered = sendMock.mock.calls[0][1];
      await rebuildMessage(
        actor === "representative" ? ada.profileId : basil.profileId,
        CHAT,
        pointer.messageId,
        delivered
      );
      expect(closeMock.mock.lastCall?.[2]).toBe(renderMessageHtml(delivered));
      // Rebuilding as another member updates the actual stored owner, too.
      await rebuildMessage(basil.profileId, CHAT, pointer.messageId, {
        ...message,
        actions: [],
      });
      expect(
        messagePointerAt(ada.profileId, CHAT, pointer.messageId)?.keyboard
      ).toEqual([]);
    }
  );

  it("keeps a declared profile's attribution through send and rebuild", async () => {
    const message = checkIn(basil.profileId);
    await sendTelegramMessage(CHAT, message, basil.profileId);
    const pointer = liveMessagePointersForKind(
      basil.profileId,
      CHAT,
      "mood"
    )[0];
    await rebuildMessage(basil.profileId, CHAT, pointer.messageId, message);
    expect(closeMock.mock.lastCall?.[2]).toBe(
      renderMessageHtml(sendMock.mock.calls[0][1])
    );
    expect(closeMock.mock.lastCall?.[2]).toContain("[subject-basil]");
  });

  it("restores the delivered shared subject after a failed close claim", async () => {
    await sendTelegramMessage(CHAT, checkIn(ada.profileId), CHAT_WIDE);
    const pointer = liveMessagePointersForKind(ada.profileId, CHAT, "mood")[0];
    expect(
      claimMessagePointerClose(ada.profileId, pointer.id, pointer.version)
    ).toBe(true);
    expect(restoreMessagePointer(pointer)).toBe(true);
    await rebuildMessage(
      basil.profileId,
      CHAT,
      pointer.messageId,
      checkIn(basil.profileId)
    );
    expect(closeMock.mock.lastCall?.[2]).not.toContain("[subject-");
  });

  it.each([
    "foreign chat",
    "inaccessible owner",
    "other profile subject",
    "legacy subject",
  ])("does not borrow a pointer for %s", async (boundary) => {
    const foreign = seedProfile(`subject-foreign-${boundary}`);
    const ownerId =
      boundary === "inaccessible owner"
        ? foreign.profileId
        : boundary === "legacy subject"
          ? basil.profileId
          : ada.profileId;
    const chatId = boundary === "foreign chat" ? UNLINKED_CHAT : CHAT;
    recordMessagePointer({
      profileId: ownerId,
      chatId,
      messageId: 777,
      kind: "mood",
      date: today(ownerId),
      keyboard: [],
      ...(boundary === "foreign chat" || boundary === "inaccessible owner"
        ? { chatWide: true }
        : {}),
    });
    await rebuildMessage(basil.profileId, CHAT, 777, checkIn(basil.profileId));
    expect(closeMock.mock.lastCall?.[2]).toContain("[subject-basil]");
  });
});

it("upgrades existing pointers without inventing a shared subject", () => {
  const legacy = new Database(":memory:");
  try {
    runMigrations(
      legacy,
      migrationsBefore("20260908-notify-message-chat-subject")
    );
    const profileId = Number(
      legacy.prepare("INSERT INTO profiles (name) VALUES ('Legacy')").run()
        .lastInsertRowid
    );
    legacy
      .prepare(
        "INSERT INTO notify_messages (profile_id, chat_id, message_id, kind, date, keyboard, title, sent_at) VALUES (?, 'legacy-chat', 1, 'mood', '2026-09-08', '[]', 'Original title', '2026-09-08 12:00:00')"
      )
      .run(profileId);
    const before = legacy.prepare("SELECT * FROM notify_messages").get();
    runMigrations(legacy);
    expect(legacy.prepare("SELECT * FROM notify_messages").get()).toEqual({
      ...(before as object),
      chat_wide: 0,
    });
  } finally {
    legacy.close();
  }
});

const attributedBuilders = [
  {
    label: "refill",
    build: (id: number) =>
      renderRefillMessage([{ id: 1, name: "Vitamin D", daysLeft: 3, generation: "fixture0001" }], id),
    title: "🔄 Refill due: Vitamin D",
  },
  {
    label: "escalation",
    build: (id: number) =>
      renderEscalationMessage(
        {
          doseId: 1,
          itemId: 1,
          itemName: "Medicine",
          amount: "1 mg",
          window: "Morning",
          kind: "medication",
          unconfirmedMinutes: 120,
          escalateChatId: null,
        },
        id,
        today(id)
      ),
    title: "⚠️ Missed dose: Medicine",
  },
  {
    label: "followup",
    build: () =>
      renderFollowUpNudgeMessage(
        {
          title: "Review",
          detail: "Recorded finding",
          dueDate: null,
          reasons: [],
        },
        "first"
      ),
    title: "🩺 Overdue follow-up: Review",
  },
  {
    label: "ease-back",
    build: () => renderEaseBackMessage(),
    title: "🌤️ Ease back in",
  },
  {
    label: "illness-care",
    build: () =>
      renderIllnessCareMessage(
        {
          symptom: "fever",
          label: "Fever",
          variant: "duration",
          runDays: 4,
          dedupeKey: "illness-care:test",
          title: "Fever",
          detail: "Recorded fever",
          source: "Synthetic source",
        },
        null
      ),
    title: "🌡️ Illness check: Fever",
  },
  {
    label: "temperature",
    build: () =>
      renderTempRedFlagMessage("High temperature", "Recorded reading", null),
    title: "🌡️ High temperature",
  },
];

it.each(attributedBuilders)(
  "dispatch names the subject once for $label, preserving single-profile output",
  async ({ build, title }) => {
    const message = build(ada.profileId);
    await dispatch(ada.profileId, message);
    expect(sendMock.mock.lastCall?.[1].title).toBe(`[subject-ada] ${title}`);
    // Keep a real one-profile database for the second dispatch, then restore this
    // file's shared fixtures. The whole database is synthetic and the savepoint is local.
    rawDb.exec("SAVEPOINT single_subject");
    rawDb.pragma("defer_foreign_keys = ON");
    try {
      db.prepare("DELETE FROM profiles WHERE id <> ?").run(ada.profileId);
      await dispatch(ada.profileId, message);
      expect(sendMock.mock.lastCall?.[1].title).toBe(title);
    } finally {
      rawDb.exec("ROLLBACK TO single_subject; RELEASE single_subject");
    }
  }
);
