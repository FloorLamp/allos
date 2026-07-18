// Telegram channel CHOKEPOINT (issue #454). Every outbound Telegram message — the
// tick's channel send, escalation's explicit-chat send, and the callback edit /
// rebuild paths — routes through THIS module, the sole importer of the guarded raw
// primitives in ./telegram-api (`sendMessageRaw` / `editMessageTextRaw` /
// `editMessageReplyMarkupRaw`). Owning that boundary here means the four
// cross-cutting obligations are applied in one place and can never diverge or be
// forgotten per call site again:
//
//   1. LIMITS — 4096-char split + 100-button cap, counted on escaped output
//      (owned by sendMessageRaw / telegram-limits, #379);
//   2. ATTRIBUTION — the multi-profile "[Name] " title prefix, derived from
//      profileId via prefixForProfile so a callback REBUILD re-applies the exact
//      send-time label instead of dropping it (#377/#429);
//   3. ESCAPING — renderMessageHtml, made unbypassable (only this module renders
//      the wire text for a send/rebuild);
//   4. DELIVERY ACCOUNTING — the send throws on failure so dispatch()'s per-channel
//      result feeds the notify_last_error marker (#131/#192).
//
// The boundary is enforced by lib/__tests__/telegram-chokepoint.test.ts, which fails
// CI if any module other than this one imports the guarded primitives.

import {
  getProfileTelegram,
  getProfileTelegramDisabledKinds,
  getTelegramBotConfig,
} from "../settings";
import type { NotificationChannel, NotificationMessage } from "./types";
import { prefixMessage } from "./types";
import { prefixForProfile } from "./attribution";
import { isKindEnabled } from "./home-assistant-core";
import {
  editMessageReplyMarkupRaw,
  editMessageTextRaw,
  messageKeyboard,
  renderMessageHtml,
  sendMessageRaw,
  type InlineKeyboard,
} from "./telegram-api";

// Re-export the unguarded transport + inbound helpers + render/types so existing
// import paths (`from "./telegram"`) keep working; only the guarded send/edit
// primitives above are withheld from re-export (callers use the chokepoint ops).
export {
  answerCallbackQuery,
  deleteWebhook,
  getUpdates,
  messageKeyboard,
  renderMessageHtml,
  setWebhook,
  type InlineKeyboard,
  type TelegramCallbackQuery,
  type TelegramUpdate,
} from "./telegram-api";

// ---- Chokepoint: outbound sends ----

export const telegramChannel: NotificationChannel = {
  id: "telegram",
  isConfigured(profileId: number) {
    const { telegramBotToken } = getTelegramBotConfig();
    const { telegramEnabled, telegramChatId } = getProfileTelegram(profileId);
    return telegramEnabled && !!telegramBotToken && !!telegramChatId;
  },
  async send(profileId: number, msg: NotificationMessage) {
    // Per-kind matrix gate (#928): a kind the profile turned off for the Telegram
    // column is a deliberate non-send, not a failure — no throw, so dispatch()
    // counts the channel healthy and never sets notify_last_error (mirrors the HA /
    // push channels' disabled-kind no-op). `test` is always allowed. Enforced HERE,
    // inside the chokepoint, so the gate can't be bypassed by a raw-primitive send.
    if (!isKindEnabled(msg.kind, getProfileTelegramDisabledKinds(profileId)))
      return;
    const { telegramChatId } = getProfileTelegram(profileId);
    await sendMessageRaw(telegramChatId, msg);
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
  await sendMessageRaw(chatId, msg);
}

// ---- Chokepoint: outbound edits (callback rebuilds/consumption) ----

// Rebuild an existing message from a freshly-built (UN-prefixed) NotificationMessage,
// re-applying the SAME send-time attribution prefix (prefixForProfile), escaping,
// and keyboard the initial send used. This is what closes the #377 class at the
// boundary: a callback handler hands over the raw rebuilt message + its profileId
// and CANNOT re-render without the "[Name] " label, because the chokepoint owns
// applying it. Byte-identical to the former hand-rolled
// editMessageText(renderMessageHtml(prefixMessage(msg, prefixForProfile(id))), …).
export async function rebuildMessage(
  profileId: number,
  chatId: number | string,
  messageId: number,
  msg: NotificationMessage
): Promise<void> {
  const attributed = prefixMessage(msg, prefixForProfile(profileId));
  await editMessageTextRaw(chatId, messageId, renderMessageHtml(attributed), {
    keyboard: messageKeyboard(attributed),
    parseMode: "HTML",
  });
}

// Replace a consumed message's text with a closing line and drop all buttons. The
// `text` is a pre-composed plain string (the callback layer's replacementWithTitle,
// which retains the already-attributed original title line from cq.message.text) —
// no re-render, so no prefix re-derivation is needed here.
export async function closeMessage(
  chatId: number | string,
  messageId: number,
  text: string
): Promise<void> {
  await editMessageTextRaw(chatId, messageId, text);
}

// Swap a message's inline keyboard in place (e.g. remove the tapped button's row
// while other rows remain). Text is untouched.
export async function updateMessageKeyboard(
  chatId: number | string,
  messageId: number,
  keyboard: InlineKeyboard
): Promise<void> {
  await editMessageReplyMarkupRaw(chatId, messageId, keyboard);
}
