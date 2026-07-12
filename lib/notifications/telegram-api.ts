// Raw Telegram Bot API transport (native fetch, Node 20). This module holds the
// low-level primitives; the channel CHOKEPOINT (telegram.ts) is the ONLY module
// permitted to import the message-mutating ones — `sendMessageRaw`,
// `editMessageTextRaw`, `editMessageReplyMarkupRaw` — so every cross-cutting
// obligation (attribution prefix, length/keyboard limits, HTML escaping, delivery
// accounting) is owned in ONE place and a new sender or reply-handler physically
// cannot reach the wire without inheriting it (issue #454). That boundary is
// enforced by a source-scan test (lib/__tests__/telegram-chokepoint.test.ts).
//
// The INBOUND / config primitives here (`answerCallbackQuery`, `setWebhook`,
// `deleteWebhook`, `getUpdates`) carry no outbound-message obligations, so they are
// not guarded and may be imported anywhere. The pure size-guard policy lives in
// ./telegram-limits; the render helpers (`renderMessageHtml`, `messageKeyboard`)
// are pure and unguarded.

import { getTelegramBotConfig } from "../settings";
import type { NotificationMessage } from "./types";
import { splitTelegramHtml, capTelegramKeyboard } from "./telegram-limits";
import {
  esc,
  messageKeyboard,
  renderMessageHtml,
  type InlineKeyboard,
} from "./telegram-render";

// Re-export the pure render helpers + keyboard type so `./telegram-api` stays the
// one transport import surface for the chokepoint and the callback DB test's
// importActual keeps them real.
export {
  messageKeyboard,
  renderMessageHtml,
  type InlineKeyboard,
} from "./telegram-render";

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

// ---- GUARDED: outbound message send/edit primitives (chokepoint-only) ----

// Deliver a message to a chat id, guarding Telegram's 4096-char message cap and
// ~100-button keyboard cap in ONE place so every message builder is covered (#379).
// An oversized body is split on line boundaries into multiple sends with the
// keyboard riding the LAST chunk; a keyboard past the button cap keeps its leading
// rows and an explicit "+N more" overflow line replaces the dropped buttons. This
// never silently swallows a SAFETY-TIER dose reminder: the actionable buttons are
// preserved (on the final chunk), so the send succeeds and the slot marker can be
// set instead of the reminder refailing every hour. Counting is on the escaped
// HTML actually sent. GUARDED — import only from the chokepoint (telegram.ts).
export async function sendMessageRaw(
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

// A no-op edit — identical text/markup, as when a duplicate or redelivered
// callback recomputes the same final state — comes back as "message is not
// modified". The desired state already holds, so treat it as success instead of
// letting the error bubble up as spurious log noise; re-throw anything else.
function ignoreNotModified(e: unknown): void {
  if (e instanceof Error && /message is not modified/i.test(e.message)) return;
  throw e;
}

// GUARDED — import only from the chokepoint (telegram.ts).
export async function editMessageReplyMarkupRaw(
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

// GUARDED — import only from the chokepoint (telegram.ts).
export async function editMessageTextRaw(
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

// ---- UNGUARDED: inbound / config primitives (no outbound-message obligations) ----

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
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
