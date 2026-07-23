// PURE TIER — the login-scoped notification fan-out dedup (issue #1072). Proves the
// chat-id collapse a shared family-group chat depends on: several managing logins
// pointing at ONE chat must yield ONE delivery, deterministically (first login wins),
// with empty chats dropped. The DB resolution (grants → logins → chats) is covered in
// the DB tier; this pins the pure collapse the whole fan-out rests on.

import { describe, it, expect } from "vitest";
import { dedupeRecipientsByChat } from "@/lib/notifications/fan-out";

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
