// Handles an inbound Telegram button tap ("✅ {name}") regardless of transport:
// the webhook route and the getUpdates poller both delegate here, so both paths
// get identical profile-scoping and verification.

import { markDoseTaken } from "../queries";
import { getProfilesByTelegramChatId } from "../settings";
import {
  type AllCallback,
  parseAllCallback,
  parseTakeCallback,
  removeButton,
  resolveTapProfile,
} from "./callback-data";
import { collectWindowDoses, windowSessionForDose } from "./supplements";
import { renderWindowMessage } from "./supplement-format";
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  editMessageText,
  messageKeyboard,
  renderMessageHtml,
  type TelegramCallbackQuery,
} from "./telegram";

export async function handleCallbackQuery(
  cq: TelegramCallbackQuery
): Promise<void> {
  // "✅ All (N)" — mark every pending dose in the session's window taken.
  const all = parseAllCallback(cq.data);
  if (all) {
    await handleAllTaken(cq, all);
    return;
  }

  const take = parseTakeCallback(cq.data);
  if (!take) {
    // Unknown/malformed token: ack so the client stops the spinner, do nothing.
    await answerCallbackQuery(cq.id);
    return;
  }

  // Resolve WHO tapped from the chat id. A chat can be shared by several profiles
  // (a family group), so pull every profile mapped to it and let the button
  // token disambiguate — the token's profile id is trusted only when it's one of
  // the profiles that actually share this chat.
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(take, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    // A chat that maps to no configured profile (or a token minted for a
    // profile that doesn't share this chat): ack to stop Telegram retrying,
    // then do nothing.
    await answerCallbackQuery(cq.id);
    return;
  }

  // markDoseTaken independently verifies the dose → supplement → profile chain
  // before logging, so a forged dose id from another profile is rejected there.
  markDoseTaken(profileId, take.doseId, take.suppId, take.date);
  await answerCallbackQuery(cq.id, "Logged ✅");

  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  const messageId = cq.message?.message_id;
  // Only act when the message actually had buttons — otherwise an absent
  // keyboard would look "empty" and wrongly overwrite the message text.
  if (chatId == null || messageId == null || rows.length === 0) return;

  // Rebuild the whole message from current state so it reflects what's now been
  // taken this session; the final tap yields a completion summary (no buttons).
  const session = windowSessionForDose(profileId, take.doseId, take.date);
  if (session && session.entries.length > 0) {
    const msg = renderWindowMessage(
      profileId,
      session.window,
      take.date,
      session.entries
    );
    await editMessageText(chatId, messageId, renderMessageHtml(msg), {
      keyboard: messageKeyboard(msg),
      parseMode: "HTML",
    });
    return;
  }

  // Fallback: the tapped dose is gone (deleted) or no longer due (deactivated
  // supplement / ended situation), so there's no session view to rebuild — just
  // drop the tapped button, replacing the text once none remain.
  const remaining = removeButton(rows, cq.data as string);
  if (remaining.length === 0) {
    await editMessageText(chatId, messageId, "All done 💊✅");
  } else {
    await editMessageReplyMarkup(chatId, messageId, remaining);
  }
}

// Mark every pending dose in the tapped session's window taken in one tap. The
// window + date are baked into the token, so a late tap still logs to the right
// day. Profile resolution and the per-dose verification mirror a single "taken"
// tap (markDoseTaken re-checks each dose → supplement → profile chain and is
// idempotent, so a dose already logged individually is a safe no-op).
async function handleAllTaken(
  cq: TelegramCallbackQuery,
  all: AllCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(all, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id);
    return;
  }

  const entries = collectWindowDoses(profileId, all.window, all.date);
  let logged = 0;
  for (const e of entries) {
    if (!e.taken) {
      markDoseTaken(profileId, e.dose.id, e.supp.id, all.date);
      logged++;
    }
  }
  await answerCallbackQuery(cq.id, logged > 0 ? "All logged ✅" : "Logged ✅");

  const messageId = cq.message?.message_id;
  if (chatId == null || messageId == null) return;

  // Rebuild from current state — everything's now taken, so this renders the
  // completion summary (no buttons).
  const refreshed = collectWindowDoses(profileId, all.window, all.date);
  if (refreshed.length === 0) return;
  const msg = renderWindowMessage(profileId, all.window, all.date, refreshed);
  await editMessageText(chatId, messageId, renderMessageHtml(msg), {
    keyboard: messageKeyboard(msg),
    parseMode: "HTML",
  });
}
