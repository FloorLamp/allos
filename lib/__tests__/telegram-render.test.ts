import { describe, it, expect } from "vitest";
import {
  esc,
  renderMessageHtml,
  messageKeyboard,
} from "../notifications/telegram-render";
import {
  prefixMessage,
  profileMessagePrefix,
  type NotificationMessage,
} from "../notifications/types";

// The pure wire-format half of the Telegram channel chokepoint (issue #454). These
// pin that the render the chokepoint's rebuild performs — prefix → escape → HTML,
// keyboard unaffected by the prefix — is byte-identical to the former inline
// composition, so routing rebuilds through the chokepoint changed nothing on the
// wire. Reuses the #377 rebuild fixture.

describe("renderMessageHtml (escaping is centralized + unbypassable)", () => {
  it("wraps the title in <b> and escapes HTML specials in title and body", () => {
    const msg: NotificationMessage = {
      title: "A & B <tag>",
      body: "1 < 2 & 3 > 0",
    };
    expect(renderMessageHtml(msg)).toBe(
      "<b>A &amp; B &lt;tag&gt;</b>\n1 &lt; 2 &amp; 3 &gt; 0"
    );
  });

  it("esc handles the ampersand-first ordering (no double-escape)", () => {
    expect(esc("<a & b>")).toBe("&lt;a &amp; b&gt;");
  });
});

describe("chokepoint rebuild composition is byte-identical (#377/#454)", () => {
  const rebuilt: NotificationMessage = {
    title: "💊 Morning supplements",
    body: "D3 · Magnesium",
    actions: [
      { label: "✅ D3", data: "take:2:12:34:2026-07-03", row: "d12" },
      { label: "⏭", data: "skip:2:12:34:2026-07-03", row: "d12" },
      { label: "✅ All (2)", data: "all:2:Morning:2026-07-03" },
    ],
  };

  it("rebuildMessage would render the SAME HTML the old inline path produced", () => {
    // The chokepoint does: prefixMessage(msg, prefixForProfile(id)) → renderMessageHtml.
    const attributed = prefixMessage(rebuilt, profileMessagePrefix("Ada", 2));
    // Former inline path rendered exactly this string.
    expect(renderMessageHtml(attributed)).toBe(
      "<b>[Ada] 💊 Morning supplements</b>\nD3 · Magnesium"
    );
  });

  it("the prefix changes only the title — the keyboard is unaffected", () => {
    const attributed = prefixMessage(rebuilt, profileMessagePrefix("Ada", 2));
    // messageKeyboard on the prefixed message equals messageKeyboard on the raw
    // message (prefix touches the title only), so a rebuild's buttons don't drift.
    expect(messageKeyboard(attributed)).toEqual(messageKeyboard(rebuilt));
    // And the ✅/⏭ pair sharing row "d12" sits on one row; ✅ All on its own.
    expect(messageKeyboard(rebuilt)).toEqual([
      [
        { text: "✅ D3", callback_data: "take:2:12:34:2026-07-03" },
        { text: "⏭", callback_data: "skip:2:12:34:2026-07-03" },
      ],
      [{ text: "✅ All (2)", callback_data: "all:2:Morning:2026-07-03" }],
    ]);
  });

  it("a single-profile rebuild renders no label (unchanged)", () => {
    const attributed = prefixMessage(rebuilt, profileMessagePrefix("Ada", 1));
    expect(renderMessageHtml(attributed)).toBe(
      "<b>💊 Morning supplements</b>\nD3 · Magnesium"
    );
  });
});
