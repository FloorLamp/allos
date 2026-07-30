// Pure Telegram wire-format rendering — HTML escaping + message/keyboard shape. No
// DB, no network, so it's unit-testable in lib/__tests__ and importable without
// standing up a database. Extracted from the transport module (issue #454) so the
// ESCAPING obligation lives in one pure place that both the raw send
// (telegram-api.sendMessageRaw) and the callback rebuild (telegram.rebuildMessage)
// render through — making escaping genuinely unbypassable rather than re-derivable.

import type { NotificationMessage } from "./types";
import { bodySpans, type MessageBody, type RichSpan } from "./rich-text";

// A button carries EITHER a callback token (`callback_data`) or a deep-link
// (`url`) — Telegram rejects a button with both, so exactly one is set.
export type InlineKeyboard = {
  text: string;
  callback_data?: string;
  url?: string;
}[][];

// HTML special chars must be escaped because messages are sent with parse_mode HTML.
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The HTML tags a declared run maps to, outermost first. `code` wraps outside the
// emphasis tags so a monospaced fragment can still be bold.
const SPAN_TAGS: readonly { flag: keyof RichSpan; tag: string }[] = [
  { flag: "code", tag: "code" },
  { flag: "bold", tag: "b" },
  { flag: "italic", tag: "i" },
];

// Render one already-escaped line with the run's declared tags around it.
function wrapLine(escaped: string, span: RichSpan): string {
  let out = escaped;
  for (let i = SPAN_TAGS.length - 1; i >= 0; i--) {
    const { flag, tag } = SPAN_TAGS[i];
    if (span[flag]) out = `<${tag}>${out}</${tag}>`;
  }
  return out;
}

// Render one run: escape its text, then apply the declared tags PER LINE so a tag
// never spans a "\n" (issue #1720). That invariant is what makes the transport's
// line-boundary splitting tag-safe — every chunk it can produce has balanced tags.
function renderSpanHtml(span: RichSpan): string {
  return span.text
    .split("\n")
    .map((line) => (line === "" ? "" : wrapLine(esc(line), span)))
    .join("\n");
}

// Render a message BODY (plain string or builder-declared runs, #1720) to the HTML
// Telegram receives. A plain string normalizes to a single unstyled run, so the
// output is byte-identical to the former `esc(body)`.
export function renderBodyHtml(body: MessageBody): string {
  return bodySpans(body).map(renderSpanHtml).join("");
}

// Render a NotificationMessage to the HTML text Telegram sends/edits — shared by
// the initial send and the callback rebuild so both look identical.
export function renderMessageHtml(msg: NotificationMessage): string {
  return `<b>${esc(msg.title)}</b>\n${renderBodyHtml(msg.body)}`;
}

// One button per row keeps long labels readable, EXCEPT that consecutive actions
// sharing a `row` group key sit side by side on one row (#232 — a dose's ✅ take +
// ⏭ skip). Empty when the message has no actions (e.g. a completed session).
export function messageKeyboard(msg: NotificationMessage): InlineKeyboard {
  const rows: InlineKeyboard = [];
  let prevRow: string | undefined;
  for (const a of msg.actions ?? []) {
    // A deep-link action renders as a url button; otherwise a callback button.
    // Telegram rejects a button carrying both, so pick exactly one.
    const btn: InlineKeyboard[number][number] = a.url
      ? { text: a.label, url: a.url }
      : { text: a.label, callback_data: a.data ?? "" };
    // Merge into the previous row only when both carry the SAME defined group
    // key; an undefined `row` always starts its own row.
    if (a.row !== undefined && a.row === prevRow && rows.length > 0) {
      rows[rows.length - 1].push(btn);
    } else {
      rows.push([btn]);
    }
    prevRow = a.row;
  }
  return rows;
}
