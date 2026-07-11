// Telegram channel + thin Bot API helpers (native fetch, Node 20). All read the
// bot token from the stored NotificationConfig, so callers never pass creds.

import { getProfileTelegram, getTelegramBotConfig } from "../settings";
import type { NotificationChannel, NotificationMessage } from "./types";
import { splitTelegramHtml, capTelegramKeyboard } from "./telegram-limits";

// A button carries EITHER a callback token (`callback_data`) or a deep-link
// (`url`) — Telegram rejects a button with both, so exactly one is set.
export type InlineKeyboard = {
  text: string;
  callback_data?: string;
  url?: string;
}[][];

// The subset of Telegram's Update / CallbackQuery shapes the app consumes —
// shared by the webhook route and the getUpdates poller.
export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: {
    message_id?: number;
    chat?: { id?: number | string };
    // The message's plain text (HTML already stripped by Telegram). Used to
    // retain the original title line in a consumed-tap replacement so shared-chat
    // reminders stay attributable (issue #377).
    text?: string;
    reply_markup?: { inline_keyboard?: InlineKeyboard };
  };
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
}

const apiBase = (token: string) => `https://api.telegram.org/bot${token}`;

// HTML special chars must be escaped because messages are sent with parse_mode HTML.
function esc(s: string): string {
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

// POST to a Bot API method; throw on transport or API error (Telegram returns
// 200 with { ok:false, description } for logical errors too). timeoutMs guards
// the fetch itself — long-poll calls need it above the server-side poll window.
async function call(
  method: string,
  body: unknown,
  timeoutMs = 30_000
): Promise<{ ok?: boolean; description?: string; result?: unknown }> {
  const { telegramBotToken } = getTelegramBotConfig();
  if (!telegramBotToken)
    throw new Error("Telegram bot token is not configured");
  const res = await fetch(`${apiBase(telegramBotToken)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
    result?: unknown;
  } | null;
  if (!res.ok || !json?.ok) {
    throw new Error(
      `Telegram ${method} failed: ${json?.description ?? `HTTP ${res.status}`}`
    );
  }
  return json;
}

// Deliver a message to a chat id, guarding Telegram's 4096-char message cap and
// ~100-button keyboard cap in ONE place so every message builder is covered (#379).
// An oversized body is split on line boundaries into multiple sends with the
// keyboard riding the LAST chunk; a keyboard past the button cap keeps its leading
// rows and an explicit "+N more" overflow line replaces the dropped buttons. This
// never silently swallows a SAFETY-TIER dose reminder: the actionable buttons are
// preserved (on the final chunk), so the send succeeds and the slot marker can be
// set instead of the reminder refailing every hour. Counting is on the escaped
// HTML actually sent.
async function deliver(
  chatId: string | number,
  msg: NotificationMessage
): Promise<void> {
  const rawKeyboard = msg.actions?.length ? messageKeyboard(msg) : [];
  const { keyboard, dropped } = capTelegramKeyboard(rawKeyboard);

  // Compute the overflow note BEFORE splitting so the note is included in the
  // limit accounting and can't push the final chunk back over the cap.
  let html = renderMessageHtml(msg);
  if (dropped > 0) {
    html += `\n${esc(
      `⚠️ +${dropped} more — open the app to act on the rest.`
    )}`;
  }

  const chunks = splitTelegramHtml(html);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: "HTML",
    };
    // The keyboard rides only the final chunk (Telegram attaches it to whichever
    // message carries it; the last one keeps the buttons next to the tail lines).
    if (isLast && keyboard.length > 0) {
      body.reply_markup = { inline_keyboard: keyboard };
    }
    await call("sendMessage", body);
  }
}

export const telegramChannel: NotificationChannel = {
  id: "telegram",
  isConfigured(profileId: number) {
    const { telegramBotToken } = getTelegramBotConfig();
    const { telegramEnabled, telegramChatId } = getProfileTelegram(profileId);
    return telegramEnabled && !!telegramBotToken && !!telegramChatId;
  },
  async send(profileId: number, msg: NotificationMessage) {
    const { telegramChatId } = getProfileTelegram(profileId);
    await deliver(telegramChatId, msg);
  },
};

// Send a message to an EXPLICIT chat id, bypassing the profile's configured
// delivery target. Used by missed-dose escalation, which may route to a
// second chat (a caregiver) via escalate_chat_id. Reads the bot token internally
// like the channel send, so callers never pass creds.
export async function sendTelegramMessage(
  chatId: string | number,
  msg: NotificationMessage
): Promise<void> {
  await deliver(chatId, msg);
}

// ---- Webhook helpers (inbound button taps) ----

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

// A no-op edit — identical text/markup, as when a duplicate or redelivered
// callback recomputes the same final state — comes back as "message is not
// modified". The desired state already holds, so treat it as success instead of
// letting the error bubble up as spurious log noise; re-throw anything else.
function ignoreNotModified(e: unknown): void {
  if (e instanceof Error && /message is not modified/i.test(e.message)) return;
  throw e;
}

export async function editMessageReplyMarkup(
  chatId: number | string,
  messageId: number,
  keyboard: InlineKeyboard
): Promise<void> {
  await call("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard },
  }).catch(ignoreNotModified);
}

export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  opts?: { keyboard?: InlineKeyboard; parseMode?: "HTML" }
): Promise<void> {
  await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
    // Always set reply_markup so a completed session drops its buttons — Telegram
    // keeps the previous keyboard when reply_markup is omitted.
    reply_markup: { inline_keyboard: opts?.keyboard ?? [] },
  }).catch(ignoreNotModified);
}

// Register the inbound webhook with Telegram; the secret is echoed back on every
// callback as the x-telegram-bot-api-secret-token header.
export async function setWebhook(url: string, secret: string): Promise<void> {
  await call("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["callback_query"],
  });
}

// Remove a registered webhook — required before getUpdates works (Telegram
// rejects polling with 409 while a webhook is set).
export async function deleteWebhook(): Promise<void> {
  await call("deleteWebhook", {});
}

// ---- Polling (inbound button taps without a public URL) ----

// Long-poll for updates. Blocks server-side up to timeoutSec; passing the last
// seen update_id + 1 as offset acknowledges everything before it.
export async function getUpdates(
  offset: number | undefined,
  timeoutSec: number
): Promise<TelegramUpdate[]> {
  const json = await call(
    "getUpdates",
    {
      ...(offset ? { offset } : {}),
      timeout: timeoutSec,
      allowed_updates: ["callback_query"],
    },
    (timeoutSec + 15) * 1000
  );
  return Array.isArray(json.result) ? (json.result as TelegramUpdate[]) : [];
}
