import { describe, expect, it } from "vitest";
import {
  keyboardChatOrigin,
  markToken,
  originFromToken,
  withChatOrigin,
} from "@/lib/notifications/chat-origin";

// The pure half of the chat origin marker (#3087). The round trip — a real send, a
// real tap, a real rebuild — is lib/__db_tests__/logged-via-chat-origin.test.ts;
// what is pinned here is the wire format and the one rule whose absence caused a
// measured regression: a rebuild of an unmarked keyboard must stay unmarked.

describe("the marker on the wire", () => {
  it("puts itself in a segment of its own, ahead of the greedy slug", () => {
    expect(
      markToken("food:5:Midday:2026-07-13:leafy_greens", "telegram-command")
    ).toBe("food:c:5:Midday:2026-07-13:leafy_greens");
    expect(
      markToken("foodprotein:5:Evening:2026-07-13:30", "telegram-nudge")
    ).toBe("foodprotein:n:5:Evening:2026-07-13:30");
  });

  it("REPLACES a marker rather than stacking one, so a rebuild is idempotent", () => {
    const once = markToken("food:5:Midday:2026-07-13:x", "telegram-nudge");
    const twice = markToken(once, "telegram-nudge");
    expect(twice).toBe(once);
    expect(markToken(once, "telegram-command")).toBe(
      "food:c:5:Midday:2026-07-13:x"
    );
  });

  it("leaves every other token family alone", () => {
    // Rewriting a prefix nothing parses back would mint a button whose tap is
    // silently refused — a worse bug than the one the marker fixes.
    for (const token of [
      "take:5:1:2:2026-07-13",
      "prn:5:9:ab12",
      "foodmore:5:Midday:2026-07-13",
      "foodoptin:5:yes",
      "pdone:5:7:n1",
    ]) {
      expect(markToken(token, "telegram-command")).toBe(token);
    }
  });

  it("stays under Telegram's 64-byte callback cap on a long real token", () => {
    // A food token runs to about 45 bytes; the marker costs two.
    const longest = markToken(
      "food:107080001001:Evening:2026-08-22:sugary_foods_desserts",
      "telegram-command"
    );
    expect(Buffer.byteLength(longest, "utf8")).toBeLessThanOrEqual(64);
  });
});

describe("reading it back", () => {
  it("reads an UNMARKED token as the nudge, at the tap", () => {
    // A handler must produce a value, and a keyboard minted before this shipped is
    // almost always a proactive send.
    expect(originFromToken("food:5:Midday:2026-07-13:x")).toBe(
      "telegram-nudge"
    );
    expect(originFromToken("food:c:5:Midday:2026-07-13:x")).toBe(
      "telegram-command"
    );
    expect(originFromToken(undefined)).toBe("telegram-nudge");
  });

  it("answers NULL for an unmarked KEYBOARD, which is not the same question", () => {
    // THE RULE A REGRESSION TAUGHT. A rebuild preserves what the delivered keyboard
    // says. A legacy keyboard says nothing — so the rebuild must say nothing, or it
    // differs from what is on screen by exactly the marker and the hourly sweep
    // spends one Telegram edit per live food message adding it.
    expect(
      keyboardChatOrigin([[{ callback_data: "food:5:Midday:2026-07-13:x" }]])
    ).toBeNull();
    expect(keyboardChatOrigin(undefined)).toBeNull();
    expect(
      keyboardChatOrigin([[{ callback_data: "take:5:1:2:2026-07-13" }]])
    ).toBeNull();
    expect(
      keyboardChatOrigin([
        [{ callback_data: "foodmore:5:Midday:2026-07-13" }],
        [{ callback_data: "food:c:5:Midday:2026-07-13:x" }],
      ])
    ).toBe("telegram-command");
  });

  it("leaves a message untouched when the origin is null", () => {
    const msg = {
      title: "t",
      body: "b",
      actions: [{ label: "x", data: "food:5:Midday:2026-07-13:x" }],
    };
    expect(withChatOrigin(msg, null)).toBe(msg);
    expect(withChatOrigin(null, "telegram-command")).toBeNull();
    expect(withChatOrigin(msg, "telegram-command").actions[0].data).toBe(
      "food:c:5:Midday:2026-07-13:x"
    );
    // …and the original is not mutated: a builder's output is re-rendered elsewhere.
    expect(msg.actions[0].data).toBe("food:5:Midday:2026-07-13:x");
  });
});
