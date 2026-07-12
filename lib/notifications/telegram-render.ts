// Pure Telegram wire-format rendering — HTML escaping + message/keyboard shape. No
// DB, no network, so it's unit-testable in lib/__tests__ and importable without
// standing up a database. Extracted from the transport module (issue #454) so the
// ESCAPING obligation lives in one pure place that both the raw send
// (telegram-api.sendMessageRaw) and the callback rebuild (telegram.rebuildMessage)
// render through — making escaping genuinely unbypassable rather than re-derivable.

import type { NotificationMessage } from "./types";

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

// Render a NotificationMessage to the HTML text Telegram sends/edits — shared by
// the initial send and the callback rebuild so both look identical.
export function renderMessageHtml(msg: NotificationMessage): string {
  return `<b>${esc(msg.title)}</b>\n${esc(msg.body)}`;
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
