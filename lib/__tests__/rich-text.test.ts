// PURE tier — the message-body rich-text seam (issue #1720) and the rendering /
// splitting guarantees that make it safe. The escaping of interpolated values stays
// the chokepoint's job; what's new is that a BUILDER can declare emphasis without
// ever writing a tag, and that everything downstream (plain channels, the transport
// splitter) stays correct under markup.

import { describe, it, expect } from "vitest";
import {
  bodySpans,
  bold,
  code,
  isRichText,
  italic,
  joinBody,
  plainBody,
  rich,
  richFrom,
} from "@/lib/notifications/rich-text";
import {
  esc,
  renderBodyHtml,
  renderMessageHtml,
} from "@/lib/notifications/telegram-render";
import {
  splitTelegramHtml,
  TELEGRAM_MESSAGE_LIMIT,
} from "@/lib/notifications/telegram-limits";

describe("rich-text seam (#1720)", () => {
  it("a plain-string body renders byte-identically to the old escape-everything path", () => {
    const body = "Vitamin D3 · 2000 IU\nMagnesium & zinc <after food>";
    const msg = { title: "💊 Morning", body };
    expect(renderMessageHtml(msg)).toBe(`<b>${esc("💊 Morning")}</b>\n${esc(body)}`);
    expect(renderBodyHtml(body)).toBe(esc(body));
  });

  it("builder-declared emphasis renders as markup", () => {
    const body = rich`Protein · ${bold("at least 107 g")} of ~80–105 g — goal reached`;
    expect(renderBodyHtml(body)).toBe(
      "Protein · <b>at least 107 g</b> of ~80–105 g — goal reached"
    );
  });

  it("interpolated user text is escaped even when it looks like markup", () => {
    const userName = "<b>Ada</b> & co";
    const body = rich`${bold("Due")} for ${userName}`;
    expect(renderBodyHtml(body)).toBe(
      "<b>Due</b> for &lt;b&gt;Ada&lt;/b&gt; &amp; co"
    );
    // The declared run's own text is escaped too — a builder cannot smuggle a tag
    // through the emphasis helper.
    expect(renderBodyHtml(rich`${bold("<i>x</i>")}`)).toBe(
      "<b>&lt;i&gt;x&lt;/i&gt;</b>"
    );
  });

  it("italic and code render, and code nests outside emphasis", () => {
    expect(renderBodyHtml(rich`${italic("soon")}`)).toBe("<i>soon</i>");
    expect(renderBodyHtml(rich`${code("5 mg")}`)).toBe("<code>5 mg</code>");
    expect(renderBodyHtml(richFrom([{ text: "x", bold: true, code: true }]))).toBe(
      "<code><b>x</b></code>"
    );
  });

  it("plain channels get the same words with the markup stripped", () => {
    const body = rich`Last night: ${bold("7h 25m")} ▲ 41m above typical`;
    expect(plainBody(body)).toBe("Last night: 7h 25m ▲ 41m above typical");
    expect(plainBody("already plain")).toBe("already plain");
  });

  it("a tag never spans a newline, so line-boundary splitting stays tag-safe", () => {
    const html = renderBodyHtml(rich`${bold("line one\nline two")}`);
    expect(html).toBe("<b>line one</b>\n<b>line two</b>");
    for (const line of html.split("\n")) {
      expect(openTagsOf(line)).toEqual([]);
    }
  });

  it("adjacent same-style runs merge and empty runs drop", () => {
    const body = richFrom([bold("a"), bold("b"), "", null, "c"]);
    expect(body.spans).toEqual([{ text: "ab", bold: true }, { text: "c" }]);
  });

  it("joinBody stays plain when every part is plain, and goes rich when one isn't", () => {
    expect(joinBody(["a", "b"], "\n")).toBe("a\nb");
    expect(joinBody(["a", null, "", "b"])).toBe("a\nb");
    const mixed = joinBody(["lead", rich`x ${bold("y")}`], "\n\n");
    expect(isRichText(mixed)).toBe(true);
    expect(plainBody(mixed)).toBe("lead\n\nx y");
    expect(joinBody([])).toBe("");
  });

  it("bodySpans normalizes a string to one unstyled run", () => {
    expect(bodySpans("hi")).toEqual([{ text: "hi" }]);
    expect(bodySpans("")).toEqual([]);
  });

  it("a hard split of one huge marked-up line never bisects a tag and balances each chunk", () => {
    // One pathological line: a single bold run far longer than the split limit.
    const html = renderBodyHtml(rich`${bold("x".repeat(9000))}`);
    const chunks = splitTelegramHtml(html);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThan(TELEGRAM_MESSAGE_LIMIT);
      // Well-formed on its own: no dangling open tag, no severed "<b" fragment.
      expect(openTagsOf(chunk)).toEqual([]);
      expect(/<[a-z]*$/.test(chunk)).toBe(false);
    }
    // Content is preserved: the visible x's survive across the chunks.
    const visible = chunks.join("").replace(/<\/?(?:b|i|code)>/g, "");
    expect(visible).toBe("x".repeat(9000));
  });

  it("a hard split never cuts through an escaped entity", () => {
    const body = `${"y".repeat(3998)}&amp;${"z".repeat(200)}`;
    const chunks = splitTelegramHtml(body);
    for (const chunk of chunks) {
      expect(/&[a-z]*$/.test(chunk)).toBe(false);
    }
    expect(chunks.join("")).toBe(body);
  });
});

// The tags left open at the end of a fragment (the splitter's own invariant, asserted
// independently here rather than imported, so the test can't pass by construction).
function openTagsOf(html: string): string[] {
  const stack: string[] = [];
  const re = /<(\/?)(b|i|code)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      if (stack[stack.length - 1] === m[2]) stack.pop();
    } else {
      stack.push(m[2]);
    }
  }
  return stack;
}
