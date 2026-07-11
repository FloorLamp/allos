// Handles an inbound Telegram button tap ("✅ {name}") regardless of transport:
// the webhook route and the getUpdates poller both delegate here, so both paths
// get identical profile-scoping and verification.

import {
  markDoseTaken,
  markDoseSkipped,
  recordPreventiveDone,
  setPreventiveOverride,
  snoozeFinding,
  supplementExists,
  getSupplementEscalateChatId,
  escalationAckState,
} from "../queries";
import { today } from "../db";
import { shiftDateStr } from "../date";
import {
  getProfilesByTelegramChatId,
  getProfileTelegram,
  setProfileSetting,
} from "../settings";
import { preventiveRuleByKey } from "../preventive-catalog";
import { preventiveSignalKey } from "../preventive-upcoming";
import { refillSignalKey } from "../refill-nudge";
import { escalationMarkerKey } from "./escalate";
import {
  type AllCallback,
  type EscalationCallback,
  type PreventiveCallback,
  type PreventiveTapOutcome,
  type RefillCallback,
  type RefillTapOutcome,
  type TakeCallback,
  OUTDATED_MESSAGE_TEXT,
  escalationAckAnswerText,
  parseAllCallback,
  parseEscalationCallback,
  parsePreventiveCallback,
  parseRefillCallback,
  parseSkipCallback,
  parseTakeCallback,
  preventiveAnswerText,
  refillAnswerText,
  removeButton,
  removeRowContaining,
  resolveEscalationTap,
  resolveTapProfile,
  tapAnswerText,
  tapResolved,
  tapSkipAnswerText,
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

// "⏰ Remind later" on a preventive nudge snoozes the finding a week out — the item
// isn't urgent, so a short reprieve without losing it. Refill "📦 Ordered" snoozes
// 3 days (a reorder's typical lead time; matches the button label).
const PREVENTIVE_SNOOZE_DAYS = 7;
const REFILL_SNOOZE_DAYS = 3;

export async function handleCallbackQuery(
  cq: TelegramCallbackQuery
): Promise<void> {
  // "✅ All (N)" — mark every pending dose in the session's window taken.
  const all = parseAllCallback(cq.data);
  if (all) {
    await handleAllTaken(cq, all);
    return;
  }

  // A dose tap is either ✅ take or ⏭ skip (#232); both carry the same token
  // shape and share the rebuild path, differing only in which write they apply
  // and how they answer.
  const take = parseTakeCallback(cq.data);
  if (take) {
    await handleDoseTap(cq, take, "take");
    return;
  }
  const skip = parseSkipCallback(cq.data);
  if (skip) {
    await handleDoseTap(cq, skip, "skip");
    return;
  }

  // Phase 1 (#233): preventive-nudge buttons (✅ Done / 🚫 Not applicable /
  // ⏰ Remind later).
  const preventive = parsePreventiveCallback(cq.data);
  if (preventive) {
    await handlePreventiveTap(cq, preventive);
    return;
  }

  // Phase 3 (#233): refill-nudge "📦 Ordered — remind me in 3 days".
  const refill = parseRefillCallback(cq.data);
  if (refill) {
    await handleRefillTap(cq, refill);
    return;
  }

  // Phase 2 (#233): missed-dose escalation (✅ Confirmed taken / 👍 I'm on it).
  const escalation = parseEscalationCallback(cq.data);
  if (escalation) {
    await handleEscalationTap(cq, escalation);
    return;
  }

  // Unknown/malformed token: ack so the client stops the spinner, do nothing.
  await answerCallbackQuery(cq.id);
}

// Drop the tapped button's WHOLE row and, when it was the last row, replace the
// message text with a closing line (buttons gone). Shared by the preventive and
// refill handlers, whose per-item rows each resolve one item. Mirrors the dose
// handler's keyboard-rebuild discipline: only act when the message actually had
// buttons, so an absent keyboard can't overwrite the text.
async function consumeRow(
  cq: TelegramCallbackQuery,
  closingText: string
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (chatId == null || messageId == null || rows.length === 0) return;
  const remaining = removeRowContaining(rows, cq.data as string);
  if (remaining.length === 0) {
    await editMessageText(chatId, messageId, closingText);
  } else {
    await editMessageReplyMarkup(chatId, messageId, remaining);
  }
}

// Replace a single-action message (its buttons consumed) with a closing line.
// Used by escalation, whose ✅/👍 pair resolves the whole message in one tap.
async function replaceMessage(
  cq: TelegramCallbackQuery,
  text: string
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (chatId == null || messageId == null || rows.length === 0) return;
  await editMessageText(chatId, messageId, text);
}

// Apply a preventive tap to the SAME server functions the Upcoming page uses, so
// a Telegram action and a page action are one fact. Validates the rule against the
// static catalog first (a tampered/stale token → unknown-rule, nothing written),
// then routes by action. The snooze writes `snooze_until` on the findings bus
// keyed by the identical `<kind>:<ruleKey>` signal the page and push share (#227).
function applyPreventiveTap(
  profileId: number,
  pv: PreventiveCallback
): PreventiveTapOutcome {
  const rule = preventiveRuleByKey(pv.ruleKey);
  if (!rule) return "unknown-rule";
  if (pv.action === "done") {
    recordPreventiveDone(profileId, pv.ruleKey, today(profileId));
    return "done";
  }
  if (pv.action === "na") {
    setPreventiveOverride(profileId, pv.ruleKey, "not_applicable");
    return "not-applicable";
  }
  snoozeFinding(
    profileId,
    preventiveSignalKey(rule.kind, pv.ruleKey),
    shiftDateStr(today(profileId), PREVENTIVE_SNOOZE_DAYS)
  );
  return "reminded";
}

// Handle a preventive-nudge button. Resolve WHO tapped from the chat (a family
// chat may map to several profiles; the token's profile id disambiguates), apply
// the write, answer honestly from the outcome, then consume the item's row.
async function handlePreventiveTap(
  cq: TelegramCallbackQuery,
  pv: PreventiveCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(pv, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id);
    return;
  }
  const outcome = applyPreventiveTap(profileId, pv);
  await answerCallbackQuery(cq.id, preventiveAnswerText(outcome));
  await consumeRow(
    cq,
    outcome === "unknown-rule"
      ? OUTDATED_MESSAGE_TEXT
      : "Preventive reminder handled ✅"
  );
}

// Apply a refill tap: verify the item is still the profile's (a forged id →
// stale-item, nothing written), else snooze its `refill:<id>` finding on the
// shared bus (#227), the same fact a page snooze writes.
function applyRefillTap(
  profileId: number,
  rf: RefillCallback
): RefillTapOutcome {
  if (!supplementExists(profileId, rf.suppId)) return "stale-item";
  snoozeFinding(
    profileId,
    refillSignalKey(rf.suppId),
    shiftDateStr(today(profileId), REFILL_SNOOZE_DAYS)
  );
  return "snoozed";
}

// Handle a refill-nudge "📦 Ordered" tap. Same profile resolution + row-consume
// discipline as the preventive handler.
async function handleRefillTap(
  cq: TelegramCallbackQuery,
  rf: RefillCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(rf, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id);
    return;
  }
  const outcome = applyRefillTap(profileId, rf);
  await answerCallbackQuery(cq.id, refillAnswerText(outcome));
  await consumeRow(
    cq,
    outcome === "snoozed" ? "Refill reminder snoozed 📦" : OUTDATED_MESSAGE_TEXT
  );
}

// Handle a missed-dose escalation button (#233's caregiver two-way). AUTHORIZE by
// chat id: the tap must come from a chat the escalation could have reached for
// this profile — the profile's own Telegram chat, OR the supplement's
// escalate_chat_id (a caregiver chat). This is the recorded design decision:
// chat-id auth means anyone in that chat can confirm/ack on the profile's behalf
// (household caregiving), consistent with the dose-button model; the escalate
// chat isn't a login, so there's no finer identity to check.
async function handleEscalationTap(
  cq: TelegramCallbackQuery,
  esc: EscalationCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  if (chatId == null) {
    await answerCallbackQuery(cq.id);
    return;
  }
  // The chats authorized to act on this escalation for this profile: the
  // profile's own delivery chat and the supplement's escalate override (both
  // read profile-scoped, so a forged supp id can't widen the auth set).
  const authorizedChats = [
    getProfileTelegram(esc.profileId).telegramChatId,
    esc.suppId != null
      ? getSupplementEscalateChatId(esc.profileId, esc.suppId)
      : null,
  ];
  const profileId = resolveEscalationTap(esc, String(chatId), authorizedChats);
  if (profileId == null) {
    await answerCallbackQuery(cq.id);
    return;
  }

  if (esc.action === "take") {
    // ✅ Confirmed taken → the outcome-typed markDoseTaken; a stale/paused tap
    // logs NOTHING and is answered as such (never falsely confirms a critical med).
    const outcome = markDoseTaken(profileId, esc.doseId, esc.suppId, esc.date);
    await answerCallbackQuery(cq.id, tapAnswerText(outcome));
    await replaceMessage(
      cq,
      tapResolved(outcome) ? "Confirmed taken ✅" : OUTDATED_MESSAGE_TEXT
    );
    return;
  }

  // 👍 I'm on it → acknowledge WITHOUT logging the dose. On a real ack, write the
  // per-episode escalation marker (the same key the tick sets on send), so the
  // episode isn't re-nudged; a taken/stale/paused dose is answered honestly and
  // nothing is written.
  const ack = escalationAckState(profileId, esc.doseId, esc.date);
  if (ack === "acknowledged") {
    setProfileSetting(profileId, escalationMarkerKey(esc.doseId), esc.date);
  }
  await answerCallbackQuery(cq.id, escalationAckAnswerText(ack));
  await replaceMessage(
    cq,
    ack === "acknowledged"
      ? "Acknowledged 👍 — we'll hold off."
      : ack === "already-taken"
        ? "Already confirmed taken ✅"
        : OUTDATED_MESSAGE_TEXT
  );
}

// Apply a single ✅ take or ⏭ skip tap: resolve the acting profile from the chat,
// run the verified write, answer honestly from the outcome union, then rebuild
// the session message so resolved doses drop their buttons.
async function handleDoseTap(
  cq: TelegramCallbackQuery,
  tap: TakeCallback,
  kind: "take" | "skip"
): Promise<void> {
  // Resolve WHO tapped from the chat id. A chat can be shared by several profiles
  // (a family group), so pull every profile mapped to it and let the button
  // token disambiguate — the token's profile id is trusted only when it's one of
  // the profiles that actually share this chat.
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(tap, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    // A chat that maps to no configured profile (or a token minted for a
    // profile that doesn't share this chat): ack to stop Telegram retrying,
    // then do nothing.
    await answerCallbackQuery(cq.id);
    return;
  }

  // markDoseTaken/markDoseSkipped independently verify the dose → supplement →
  // profile chain before writing, so a forged dose id from another profile is
  // rejected there. The message the button lives in is a frozen snapshot — the
  // dose may have been deleted/retired by an edit, or its item paused, since it
  // was sent — so answer with what ACTUALLY happened, never unconditionally.
  const outcome =
    kind === "take"
      ? markDoseTaken(profileId, tap.doseId, tap.suppId, tap.date)
      : markDoseSkipped(profileId, tap.doseId, tap.suppId, tap.date);
  await answerCallbackQuery(
    cq.id,
    kind === "take" ? tapAnswerText(outcome) : tapSkipAnswerText(outcome)
  );

  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  const messageId = cq.message?.message_id;
  // Only act when the message actually had buttons — otherwise an absent
  // keyboard would look "empty" and wrongly overwrite the message text.
  if (chatId == null || messageId == null || rows.length === 0) return;

  // Rebuild the whole message from current state so it reflects what's now been
  // taken/skipped this session; the final tap yields a completion summary (no
  // buttons).
  const session = windowSessionForDose(profileId, tap.doseId, tap.date);
  if (session && session.entries.length > 0) {
    const msg = renderWindowMessage(
      profileId,
      session.window,
      tap.date,
      session.entries
    );
    await editMessageText(chatId, messageId, renderMessageHtml(msg), {
      keyboard: messageKeyboard(msg),
      parseMode: "HTML",
    });
    return;
  }

  // Fallback: the tapped dose is gone (deleted/retired) or no longer due
  // (paused supplement / ended situation), so there's no session view to
  // rebuild — just drop the tapped button. Once none remain, the closing text
  // must match the truth: "All done" only when this tap actually resolved the
  // dose; otherwise say the reminder is stale so the user knows nothing changed.
  const remaining = removeButton(rows, cq.data as string);
  if (remaining.length === 0) {
    await editMessageText(
      chatId,
      messageId,
      tapResolved(outcome) ? "All done 💊✅" : OUTDATED_MESSAGE_TEXT
    );
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

  // The window's doses are re-collected from CURRENT state (active, non-retired,
  // due today), so this tolerates schedule edits made after the message was
  // sent. Count only real inserts; when the whole window has since emptied
  // (schedule restructured / items paused), say so instead of "Logged ✅".
  const entries = collectWindowDoses(profileId, all.window, all.date);
  let logged = 0;
  for (const e of entries) {
    // A deliberately-skipped dose (#232) is already resolved — "✅ All" marks the
    // remaining PENDING doses taken and leaves skips alone.
    if (
      !e.taken &&
      !e.skipped &&
      markDoseTaken(profileId, e.dose.id, e.supp.id, all.date) === "logged"
    ) {
      logged++;
    }
  }
  await answerCallbackQuery(
    cq.id,
    entries.length === 0
      ? "Not logged — this reminder is out of date. Open the app."
      : logged > 0
        ? "All logged ✅"
        : "Logged ✅"
  );

  const messageId = cq.message?.message_id;
  if (chatId == null || messageId == null) return;

  // Rebuild from current state — everything's now taken, so this renders the
  // completion summary (no buttons). With nothing due in the window anymore
  // there is no session to render; replace the stale message (it had buttons —
  // this tap came from one) so it stops advertising doses that no longer exist.
  const refreshed = collectWindowDoses(profileId, all.window, all.date);
  if (refreshed.length === 0) {
    await editMessageText(chatId, messageId, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const msg = renderWindowMessage(profileId, all.window, all.date, refreshed);
  await editMessageText(chatId, messageId, renderMessageHtml(msg), {
    keyboard: messageKeyboard(msg),
    parseMode: "HTML",
  });
}
