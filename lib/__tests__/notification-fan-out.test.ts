// PURE TIER — the login-scoped notification fan-out dedup (issue #1072). Proves the
// chat-id collapse a shared family-group chat depends on: several managing logins
// pointing at ONE chat must yield ONE delivery, deterministically (first login wins),
// with empty chats dropped. The DB resolution (grants → logins → chats) is covered in
// the DB tier; this pins the pure collapse the whole fan-out rests on.

import { describe, it, expect } from "vitest";
import {
  dedupeRecipientsByChat,
  isLastUnmutedManagingLogin,
} from "@/lib/notifications/fan-out";

describe("dedupeRecipientsByChat (#1072)", () => {
  it("collapses several logins on ONE chat to a single recipient (shared family group)", () => {
    const out = dedupeRecipientsByChat([
      { loginId: 1, chatId: "family-chat" },
      { loginId: 2, chatId: "family-chat" },
      { loginId: 3, chatId: "family-chat" },
    ]);
    expect(out).toEqual([{ loginId: 1, chatId: "family-chat" }]);
  });

  it("keeps distinct chats, one per chat, in first-seen order", () => {
    const out = dedupeRecipientsByChat([
      { loginId: 5, chatId: "chat-a" },
      { loginId: 6, chatId: "chat-b" },
      { loginId: 7, chatId: "chat-a" },
    ]);
    expect(out).toEqual([
      { loginId: 5, chatId: "chat-a" },
      { loginId: 6, chatId: "chat-b" },
    ]);
  });

  it("the FIRST login owns a shared chat (deterministic tie-break)", () => {
    const out = dedupeRecipientsByChat([
      { loginId: 9, chatId: "shared" },
      { loginId: 2, chatId: "shared" },
    ]);
    // Input order is preserved (managingLoginIdsForProfile is id-ordered upstream),
    // so login 9 wins here because it appears first in this list.
    expect(out).toEqual([{ loginId: 9, chatId: "shared" }]);
  });

  it("drops empty / whitespace-only chats (an enabled login with no chat isn't deliverable)", () => {
    const out = dedupeRecipientsByChat([
      { loginId: 1, chatId: "" },
      { loginId: 2, chatId: "   " },
      { loginId: 3, chatId: "real" },
    ]);
    expect(out).toEqual([{ loginId: 3, chatId: "real" }]);
  });

  it("trims chat ids and dedups on the trimmed value", () => {
    const out = dedupeRecipientsByChat([
      { loginId: 1, chatId: " 123 " },
      { loginId: 2, chatId: "123" },
    ]);
    expect(out).toEqual([{ loginId: 1, chatId: "123" }]);
  });

  it("is empty for no recipients", () => {
    expect(dedupeRecipientsByChat([])).toEqual([]);
  });
});

describe("isLastUnmutedManagingLogin (#1324)", () => {
  it("sole managing login → muting silences the safety tier for everyone", () => {
    expect(isLastUnmutedManagingLogin([7], new Set(), 7)).toBe(true);
  });

  it("a co-caregiver is still unmuted → muting does NOT silence everyone", () => {
    // Login 7 mutes, but login 9 (the other managing login) is not muted.
    expect(isLastUnmutedManagingLogin([7, 9], new Set(), 7)).toBe(false);
  });

  it("every OTHER managing login already muted → this login is the last unmuted one", () => {
    expect(isLastUnmutedManagingLogin([7, 9], new Set([9]), 7)).toBe(true);
  });

  it("this login not among the managing set → never the last unmuted caregiver", () => {
    expect(isLastUnmutedManagingLogin([9, 12], new Set(), 7)).toBe(false);
  });

  it("this login's OWN mute state is irrelevant to the predicate", () => {
    // Even if login 7 is listed as muted, the question is what remains once it mutes;
    // login 9 stays unmuted, so it is not the last.
    expect(isLastUnmutedManagingLogin([7, 9], new Set([7]), 7)).toBe(false);
  });
});
