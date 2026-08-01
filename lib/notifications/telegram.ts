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
  getFoodNudgePointer,
  getHouseholdRoundPointer,
  setHouseholdRoundPointer,
  getLoginTelegramDisabledKinds,
  getProfilesByTelegramChatId,
  getTelegramBotConfig,
  getTimezone,
  setDigestTailPointer,
  setFoodNudgePointer,
} from "../settings";
import { today } from "../db";
import { zonedDateParts } from "../date";
import { createLogger } from "../log";
import type {
  DispatchOptions,
  NotificationChannel,
  NotificationMessage,
} from "./types";
import { prefixMessage } from "./types";
import { prefixForProfile } from "./attribution";
import { isKindEnabled } from "./home-assistant-core";
import { resolveTelegramRecipients } from "./fan-out";
import { foodNudgePointerFromMessage } from "./food-nudge-pointer";
import { householdRoundPointerFromMessage } from "./household-round-pointer";
import {
  editMessageReplyMarkupRaw,
  editMessageTextRaw,
  messageKeyboard,
  renderMessageHtml,
  sendMessageRaw,
  type InlineKeyboard,
} from "./telegram-api";
import { capTelegramKeyboard } from "./telegram-limits";
import { recordMessagePointer } from "./message-pointers";

const log = createLogger("telegram");

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
  isConfigured(profileId: number, opts?: DispatchOptions) {
    // Login-scoped channel fan-out (issue #1072): a message ABOUT this profile is
    // deliverable when the bot is configured AND at least one MANAGING login has an
    // enabled Telegram chat (and hasn't muted this profile). The channel resolves N
    // recipients now, not one profile chat.
    const { telegramBotToken } = getTelegramBotConfig();
    if (!telegramBotToken) return false;
    // An EXPLICIT chat override (#615's escalate_chat_id, routed through dispatch by
    // #1716) is deliverable on its own: the caregiver chat was configured for this
    // item and does not depend on the profile having any managing-login recipient.
    if (opts?.telegramChatIds?.length) return true;
    return resolveTelegramRecipients(profileId).length > 0;
  },
  async send(
    profileId: number,
    msg: NotificationMessage,
    opts?: DispatchOptions
  ) {
    // Fan the message out to every managing login's chat (deduped by chat id, so a
    // shared family group gets ONE copy). Each recipient is gated by ITS login's
    // Telegram disabled-kinds set (#928, now login-scoped per #1072) — a kind a
    // login turned off is a deliberate non-send for that login, not a failure (no
    // throw, so dispatch() counts the channel healthy and never sets
    // notify_last_error, mirroring the HA/push disabled-kind no-op). `test` is
    // always allowed. Enforced HERE, inside the chokepoint, so the gate can't be
    // bypassed by a raw-primitive send. A send throw for ANY recipient propagates so
    // dispatch() marks the channel failed and the slot can retry.
    // An explicit chat override REPLACES the fan-out for this send (#615/#1716): the
    // targets are raw chat ids, not logins, so the per-login disabled-kinds gate below
    // does not apply to them — the chat was named for exactly this item, and a
    // per-login mute of a chat that isn't a login's is meaningless. Deduped so a
    // repeated id can't double-send. A throw still propagates, so dispatch() records
    // the delivery outcome for an override send exactly as for a fan-out send.
    const override = opts?.telegramChatIds;
    if (override?.length) {
      for (const chatId of Array.from(new Set(override))) {
        const messageId = await sendMessageRaw(chatId, msg);
        // An override chat is not a login, but the MESSAGE still goes stale exactly
        // like a fan-out copy — a caregiver's escalation chat is the last place a
        // false "still outstanding" belongs (#1779).
        recordPointer(profileId, chatId, messageId, msg);
      }
      return;
    }
    const recipients = resolveTelegramRecipients(profileId);
    for (const { loginId, chatId } of recipients) {
      if (!isKindEnabled(msg.kind, getLoginTelegramDisabledKinds(loginId)))
        continue;
      const messageId = await sendMessageRaw(chatId, msg);
      // A food nudge closes the PREVIOUS food nudge's still-live keyboard (#947):
      // each slot sends a fresh message with live serving buttons, and a stale
      // keyboard from a previous day would silently log to the WRONG date on tap.
      // Done HERE, in the chokepoint, because this is the only place with both the
      // just-sent message id and the guarded keyboard-edit primitive. STRICTLY
      // best-effort — the send already succeeded, so a failed strip must never
      // surface as a channel failure; rotateFoodNudgePointer swallows. The pointer
      // is stored per-profile (last chat wins on a multi-chat fan-out — a food nudge
      // is gated on Telegram deliverability and is overwhelmingly single-chat).
      if (msg.kind === "food" && messageId != null)
        await rotateFoodNudgePointer(profileId, chatId, messageId, msg);
      // The HOUSEHOLD ROUND needs the identical rotation (#1719) and never had it:
      // its confirm tokens carry each member's SEND-TIME date, so a surviving round
      // keyboard from an earlier day logs a dose to YESTERDAY — for someone else's
      // medication. It shares `kind: "dose"` with the ordinary slot reminder, so the
      // round is identified by its `hh:` tokens, never by kind (which would strip a
      // plain dose reminder's keyboard too). Same strictly-best-effort posture.
      if (messageId != null)
        await rotateHouseholdRoundPointer(profileId, chatId, messageId, msg);
      // A DIGEST carrying the offer tail (#1505) records its message id for the same
      // class of reason: the tail's label names the slot it opens into, so the tick
      // has to re-label it at each boundary — which needs the message to edit. Same
      // chokepoint placement and same strictly-best-effort posture as the food
      // pointer above; a bookkeeping failure must never turn a delivered digest into
      // a failed one.
      if (msg.kind === "digest" && messageId != null && msg.actions?.length)
        recordDigestTailPointer(profileId, chatId, messageId);
      // The UNIVERSAL live-message pointer (#1779). Recorded HERE, in the chokepoint,
      // for the same reason the two special-purpose pointers above are: this is the
      // only place that has both the delivered message id and the message it was
      // rendered from — and it is per RECIPIENT, so a dose confirmed from a family
      // group's copy can correct the copies in every other subscriber's chat.
      recordPointer(profileId, chatId, messageId, msg);
    }
  },
};

// Store the pointer for one delivered message, or do nothing when there is nothing to
// reconcile later (no message id, or no keyboard — a button-less message can never
// display a stale claim).
//
// THE KEYBOARD IS RE-DERIVED, NOT PASSED BACK. sendMessageRaw applies the pure
// `capTelegramKeyboard(messageKeyboard(msg))` pair internally to decide what rides the
// wire; calling the same pure pair here reproduces it exactly rather than widening the
// guarded primitive's return type, which every test that stubs the transport would
// then have to know about. Both are total functions of `msg`.
function recordPointer(
  profileId: number,
  chatId: string | number,
  messageId: number | undefined,
  msg: NotificationMessage
): void {
  if (messageId == null || !msg.actions?.length) return;
  // No resolvable subject (an explicit-chat send to a chat that maps to no profile):
  // there is nobody for the sweep to reconcile on behalf of, so store nothing rather
  // than invent an owner.
  if (!profileId) return;
  const { keyboard } = capTelegramKeyboard(messageKeyboard(msg));
  if (keyboard.length === 0) return;
  recordMessagePointer({
    profileId,
    chatId,
    messageId,
    kind: msg.kind ?? "other",
    date: today(profileId),
    keyboard,
    // The TITLE AS DELIVERED, attribution prefix and all (#1822 item 7). Recorded for
    // exactly the reason the keyboard is: this is the only moment anyone holds it, and
    // a reconcile close that replaces the whole text must be able to say what it closed
    // — in a shared chat, whose message it closed.
    title: msg.title,
  });
}

// After a food nudge sends, strip the PREVIOUS nudge's keyboard and record the new
// message as the pointer (#947). Best-effort throughout: Telegram refuses edits on
// messages older than ~48 h and the message may be gone, so a strip failure is
// swallowed at log level and NEVER re-thrown — delivery already succeeded, and the
// notify_last_error marker means delivery is broken, which it isn't. The pointer is
// overwritten every send (id-keyed, no cleanup class, #203).
async function rotateFoodNudgePointer(
  profileId: number,
  chatId: string | number,
  messageId: number,
  msg: NotificationMessage
): Promise<void> {
  try {
    const prev = getFoodNudgePointer(profileId);
    if (
      prev &&
      !(String(prev.chatId) === String(chatId) && prev.messageId === messageId)
    ) {
      // Strip the old keyboard in place (text untouched) through the guarded
      // primitive. A "message is not modified" is already swallowed inside it; a
      // "message to edit not found" / "message can't be edited" (too old) throws and
      // is caught here — the point is that a fresh keyboard now exists.
      await editMessageReplyMarkupRaw(prev.chatId, prev.messageId, []).catch(
        (e) => {
          log.info("food nudge: previous keyboard strip failed (ignored)", {
            profile: profileId,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      );
    }
    const pointer = foodNudgePointerFromMessage(msg, chatId, messageId);
    if (pointer) setFoodNudgePointer(profileId, pointer);
  } catch (e) {
    // Any unexpected error (a settings write throw, etc.) stays swallowed — the send
    // succeeded and this bookkeeping must never turn a delivery into a failure.
    log.info("food nudge: pointer rotation failed (ignored)", {
      profile: profileId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

// After a household round sends, strip the PREVIOUS round's keyboard and record the
// new message as the pointer (#1719) — the #947 mechanism, one message class over. A
// no-op for any message that isn't a round. Best-effort throughout for the same
// reasons as the food rotation: Telegram refuses edits on old messages, the delivery
// already succeeded, and a bookkeeping failure must never look like a broken channel.
async function rotateHouseholdRoundPointer(
  profileId: number,
  chatId: string | number,
  messageId: number,
  msg: NotificationMessage
): Promise<void> {
  const pointer = householdRoundPointerFromMessage(
    msg,
    chatId,
    messageId,
    today(profileId)
  );
  if (!pointer) return;
  try {
    const prev = getHouseholdRoundPointer(profileId);
    if (
      prev &&
      !(String(prev.chatId) === String(chatId) && prev.messageId === messageId)
    ) {
      await editMessageReplyMarkupRaw(prev.chatId, prev.messageId, []).catch(
        (e) => {
          log.info(
            "household round: previous keyboard strip failed (ignored)",
            {
              profile: profileId,
              err: e instanceof Error ? e.message : String(e),
            }
          );
        }
      );
    }
    setHouseholdRoundPointer(profileId, pointer);
  } catch (e) {
    log.info("household round: pointer rotation failed (ignored)", {
      profile: profileId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

// Store the just-sent digest's message id so the tick can re-label its offer tail at
// the next slot boundary (#1505). Best-effort: a settings-write throw is swallowed —
// the digest was delivered, and the worst case of a missing pointer is a tail whose
// label goes stale until tomorrow's digest.
function recordDigestTailPointer(
  profileId: number,
  chatId: string | number,
  messageId: number
): void {
  try {
    setDigestTailPointer(profileId, {
      chatId,
      messageId,
      date: today(profileId),
      renderedAt: zonedDateParts(getTimezone(profileId), new Date()).hhmm,
    });
  } catch (e) {
    log.info("digest tail: pointer store failed (ignored)", {
      profile: profileId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

// Send a message to an EXPLICIT chat id, bypassing the profile's configured
// delivery target. Used by missed-dose escalation, which may route to a
// second chat (a caregiver) via escalate_chat_id. Reads the bot token internally
// like the channel send, so callers never pass creds.
export async function sendTelegramMessage(
  chatId: string | number,
  msg: NotificationMessage
): Promise<void> {
  const messageId = await sendMessageRaw(chatId, msg);
  recordPointer(profileIdForExplicitSend(chatId), chatId, messageId, msg);
}

// The subject a chat-addressed send is ABOUT, for the pointer's profile scope. An
// explicit-chat send names a CHAT, not a profile, so the subject is resolved the same
// way an inbound tap from that chat resolves one — the lowest profile the chat can act
// as. Zero when the chat maps to nothing, which suppresses the pointer entirely rather
// than inventing a subject for it.
function profileIdForExplicitSend(chatId: string | number): number {
  return getProfilesByTelegramChatId(String(chatId))[0] ?? 0;
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
