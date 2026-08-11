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
import { TelegramApiError } from "./telegram-error";
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
import { GLYPH } from "./glyphs";

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

// An inbound text message (a slash command like `/dose`, #797). We read only the
// chat id and text; commands carry no callback token, so the acting profile is
// resolved from the chat (getProfilesByTelegramChatId) like a callback tap.
export interface TelegramMessage {
  message_id?: number;
  chat?: { id?: number | string };
  text?: string;
  // The message this one replies to (Telegram populates it for a reply). Used by the
  // #859 temperature reply quick-log to attribute a "38.5" reply to its /temp prompt.
  reply_to_message?: { text?: string };
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
}

const apiBase = (token: string) => `https://api.telegram.org/bot${token}`;

// POST to a Bot API method; throw on transport or API error (Telegram returns
// 200 with { ok:false, description } for logical errors too). timeoutMs guards
// the fetch itself — long-poll calls need it above the server-side poll window.
//
// EVERY failure leaves here as a TelegramApiError (#1885) carrying the HTTP status and
// Telegram's own `description`, so a caller can tell "this message is gone forever"
// from "this attempt didn't land" without parsing a sentence. One chokepoint, so every
// caller inherits the distinction. The thrown `message` keeps its original wording —
// `ignoreNotModified` below and the tick's logs read it.
async function call(
  method: string,
  body: unknown,
  timeoutMs = 30_000
): Promise<{ ok?: boolean; description?: string; result?: unknown }> {
  const { telegramBotToken } = getTelegramBotConfig();
  if (!telegramBotToken)
    throw new Error("Telegram bot token is not configured");
  let res: Response;
  try {
    res = await fetch(`${apiBase(telegramBotToken)}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // The request never reached an answer: DNS, refused connection, or the timeout
    // signal firing. No status was ever received, which is the transient signature —
    // typed here rather than left as a raw TypeError/DOMException so the classifier
    // sees the same shape it sees for an API-level failure.
    throw new TelegramApiError({
      method,
      status: null,
      description: null,
      message: `Telegram ${method} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    });
  }
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
    result?: unknown;
  } | null;
  if (!res.ok || !json?.ok) {
    throw new TelegramApiError({
      method,
      status: res.status,
      description: json?.description ?? null,
      message: `Telegram ${method} failed: ${
        json?.description ?? `HTTP ${res.status}`
      }`,
    });
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
//
// Returns the message_id of the FINAL chunk — the one carrying the keyboard — so a
// caller that needs to close that keyboard later (the food-nudge close-previous, #947)
// has a handle to it. Undefined if Telegram didn't report an id (best-effort callers
// tolerate it).
export async function sendMessageRaw(
  chatId: string | number,
  msg: NotificationMessage
): Promise<number | undefined> {
  const rawKeyboard = msg.actions?.length ? messageKeyboard(msg) : [];
  const { keyboard, dropped } = capTelegramKeyboard(rawKeyboard);

  // Compute the overflow note BEFORE splitting so the note is included in the
  // limit accounting and can't push the final chunk back over the cap.
  let html = renderMessageHtml(msg);
  if (dropped > 0) {
    html += `\n${esc(
      `${GLYPH.caution} +${dropped} more — open the app to act on the rest.`
    )}`;
  }

  const chunks = splitTelegramHtml(html);
  let lastMessageId: number | undefined;
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
    const json = await call("sendMessage", body);
    const result = json.result as { message_id?: number } | undefined;
    if (typeof result?.message_id === "number")
      lastMessageId = result.message_id;
  }
  return lastMessageId;
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
//
// The button cap applies here too, and this is the one edit that CANNOT say so: there
// is no text to hang a "+N more" line on. Most callers shrink an already-capped keyboard
// (`removeButton` / `removeRowContaining`) and can never reach the limit, but the digest's
// offer tail and ⚙️ Tune BUILD a fresh keyboard from the profile's own items — the same
// thirty-plus-dose regimen the cap exists for — so the limit is reachable from here.
// Dropping the overflow silently is worse than a "+N more" line and better than the
// alternative, which is Telegram rejecting the edit and the message keeping the keyboard
// it had BEFORE the tap: a stale claim, which is the whole harm the sweep exists to end.
// The kept rows are the leading ones, so what survives is what the builder ranked first.
export async function editMessageReplyMarkupRaw(
  chatId: number | string,
  messageId: number,
  keyboard: InlineKeyboard
): Promise<void> {
  await call("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: capTelegramKeyboard(keyboard).keyboard },
  }).catch(ignoreNotModified);
}

// GUARDED — import only from the chokepoint (telegram.ts).
//
// THE BUTTON CAP IS THE SEND'S, APPLIED HERE TOO. `sendMessageRaw` says it guards the
// ~100-button limit "in ONE place so every message builder is covered" (#379), and that
// was true of sends only: an edit took a pre-built keyboard and passed it through. So a
// session big enough to be CAPPED on the way out — the regimen with thirty-odd scheduled
// doses, which is the archetype that cap exists for — had every later tap rebuild the
// same oversized keyboard and get the edit rejected outright, leaving the message frozen
// on the state before the tap. One rule, both directions: the same cap, and the same
// "+N more" line naming what it dropped, so a rebuild DEGRADES exactly as its send did
// instead of failing.
// AND SO IS THE LENGTH CAP, which an edit cannot honour the way a send does. A send
// SPLITS an oversized body across several messages and puts the keyboard on the last
// one; an edit has exactly one message to write and no way to grow it, so the only
// choices are to shorten it or to fail. Failing is the worse one by a distance: the
// message then keeps the keyboard it had before the tap, which is the #1779 harm — a
// chat still presenting a dose as outstanding after it was confirmed. So the body is
// cut on the SAME line boundaries the send splits on (never mid-tag, which would make
// Telegram reject the HTML anyway) and the tail says the message was shortened, which
// is the one thing a reader cannot otherwise tell. The buttons always survive: they are
// what the message is FOR, and they carry the state claim the sweep reconciles.
export async function editMessageTextRaw(
  chatId: number | string,
  messageId: number,
  text: string,
  opts?: { keyboard?: InlineKeyboard; parseMode?: "HTML" }
): Promise<void> {
  const { keyboard, dropped } = capTelegramKeyboard(opts?.keyboard ?? []);
  const notes: string[] = [];
  if (dropped > 0)
    notes.push(
      `${GLYPH.caution} +${dropped} more — open the app to act on the rest.`
    );

  // Cut BEFORE the notes are appended, then re-check: the notes are short and the split
  // limit sits below Telegram's real cap, so one pass leaves headroom by construction.
  const chunks = splitTelegramHtml(text);
  let body = chunks[0];
  if (chunks.length > 1)
    notes.push(`${GLYPH.caution} Shortened — open the app for the full list.`);
  // ESCAPED ONLY WHEN THE MESSAGE IS HTML. `closeMessage` edits in PLAIN text (no
  // parse_mode), where an escaped note would render its entities literally — `&amp;`
  // on screen. Nothing reaches that combination today (a close carries no keyboard and
  // no body long enough to cut), which is exactly why the coupling has to be written
  // down rather than left to hold by luck.
  for (const note of notes)
    body += `\n${opts?.parseMode === "HTML" ? esc(note) : note}`;

  await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: body,
    ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
    // Always set reply_markup so a completed session drops its buttons — Telegram
    // keeps the previous keyboard when reply_markup is omitted.
    reply_markup: { inline_keyboard: keyboard },
  }).catch(ignoreNotModified);
}

// ---- UNGUARDED: inbound / config primitives (no outbound-message obligations) ----

// `alert` renders the answer as a modal the reader must DISMISS instead of a banner
// that fades. It is for one thing only: a tap on the intake safety tier that wrote
// NOTHING the button named — a stale reminder, a paused item, a ✅ on a dose already
// marked skipped, a correction whose hour has run out.
//
// The module's contract has always been that every refusal is spoken, because a silent
// ack reads as success and on the dose side "success" means the redose window has been
// told something about a controlled medication. A transient toast under-delivers on
// that: it is a top banner on a phone, but on Telegram Desktop a small tooltip near the
// message that fades on its own and is easy to miss entirely — so the refusal was
// spoken and not heard, which lands the reader in exactly the state the contract exists
// to prevent, believing a dose is logged when it is not.
//
// Deliberately NOT everywhere. A modal costs a dismissal, and spending one on "Logged
// ✅" or on a food quick-log would train people to swipe it away unread, which is how
// the one that matters stops being seen. Coaching-tier taps keep their toasts.
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  opts?: { alert?: boolean }
): Promise<void> {
  await call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
    ...(opts?.alert ? { show_alert: true } : {}),
  });
}

// Register the inbound webhook with Telegram; the secret is echoed back on every
// callback as the x-telegram-bot-api-secret-token header.
export async function setWebhook(url: string, secret: string): Promise<void> {
  await call("setWebhook", {
    url,
    secret_token: secret,
    // "message" delivers the /dose slash command (#797) alongside button taps. A
    // webhook picks it up on the next register (Settings → Server → Register
    // webhook); polling picks it up immediately.
    allowed_updates: ["callback_query", "message"],
  });
}

// Register the bot's command list, which is what populates Telegram's own `/`
// autocomplete menu (#1895). Without it the commands exist but are invisible: the only
// way to learn a verb is to be told one out of band.
//
// INSTANCE-LEVEL BY NECESSITY. Telegram scopes this per bot (or per chat, via a scope
// argument the self-hosted instance has no cheap way to keep current for every chat it
// joins), while relevance is per chat. So the registered list stays GENERIC — every verb
// this build ships — and the handlers keep owning per-chat gating; `/help` is the
// per-chat-honest answer.
export async function setMyCommands(
  commands: readonly { command: string; description: string }[]
): Promise<void> {
  await call("setMyCommands", { commands });
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
      // "message" delivers the /dose slash command (#797) alongside button taps. A
      // webhook picks it up on the next register (Settings → Server → Register
      // webhook); polling picks it up immediately.
      allowed_updates: ["callback_query", "message"],
    },
    (timeoutSec + 15) * 1000
  );
  return Array.isArray(json.result) ? (json.result as TelegramUpdate[]) : [];
}
