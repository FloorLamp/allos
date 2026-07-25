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
  getDoseEscalateChatId,
  escalationAckState,
  logAdministration,
} from "../queries";
import { today } from "../db";
import { shiftDateStr } from "../date";
import {
  getProfilesByTelegramChatId,
  setProfileSetting,
  setProfileFoodTelegram,
  setFoodTelegramPrompted,
  getUserAge,
} from "../settings";
import { logFoodServingCore } from "../food-log-write";
import { addProteinGramsCore } from "../protein-log-write";
import { preventiveRuleByKey } from "../preventive-catalog";
import { preventiveSignalKey } from "../preventive-upcoming";
import { refillSignalKey } from "../refill-nudge";
import { escalationMarkerKey } from "./escalate";
import { resolveHouseholdTapAccess } from "./household-round-access";
import { householdMemberLabel } from "./household-round";
import {
  type AllCallback,
  type EscalationCallback,
  type FoodLogCallback,
  type FoodMoreCallback,
  type FoodOptInCallback,
  type FoodProteinCallback,
  type PreventiveCallback,
  type PreventiveTapOutcome,
  type RefillCallback,
  type RefillTapOutcome,
  type HouseholdDoseCallback,
  type TakeCallback,
  OUTDATED_MESSAGE_TEXT,
  householdTapAnswerText,
  householdTapRefusalText,
  parseHouseholdDoseCallback,
  escalationAckAnswerText,
  escalationAckCloseText,
  escalationTakeCloseText,
  foodLogAnswerText,
  foodOptInAnswerText,
  foodOptInCloseText,
  foodProteinAnswerText,
  foodStaleDateAnswerText,
  foodTapDateGuard,
  keyboardDoseFootprint,
  parseAllCallback,
  parseEscalationCallback,
  parseFoodLogCallback,
  parseFoodMoreCallback,
  parseFoodOptInCallback,
  parseFoodProteinCallback,
  parsePreventiveCallback,
  parsePrnLogCallback,
  parsePracticeDoneCallback,
  practiceDoneAnswerText,
  parseRefillCallback,
  parseSkipCallback,
  parseTakeCallback,
  parseMoodCheckinCallback,
  parseSymptomPickCallback,
  parseSymptomSeverityCallback,
  parseTempReply,
  parseTempReplyMarker,
  parseWorkoutFinishCallback,
  workoutDiscardAnswerText,
  workoutFinishAnswerText,
  type WorkoutFinishCallback,
  tempReplyMarker,
  SYMPTOM_SEVERITY_LABELS,
  type MoodCheckinCallback,
  type PrnLogCallback,
  type PracticeDoneCallback,
  type SymptomPickCallback,
  type SymptomSeverityCallback,
  preventiveAnswerText,
  preventiveCloseText,
  refillAnswerText,
  removeButton,
  removeRowContaining,
  replacementWithTitle,
  resolveEscalationTap,
  resolveTapProfile,
  tapAnswerText,
  tapResolved,
  tapSkipAnswerText,
} from "./callback-data";
import { finishWorkoutSession, discardWorkoutSession } from "../workout-finish";
import {
  buildPostWorkoutFinishReminder,
  postWorkoutFinishMarkerKey,
} from "./workout-presence";
import { collectWindowDoses, slotSessionForKeyboard } from "./supplements";
import {
  notifiableWindowDoses,
  renderMergedIntakeMessage,
} from "./supplement-format";
import { buildFoodNudge } from "./food";
import {
  countVisibleFoodButtons,
  FOOD_NUDGE_BUTTON_COUNT,
} from "./food-format";
import {
  answerCallbackQuery,
  closeMessage,
  rebuildMessage,
  sendTelegramMessage,
  updateMessageKeyboard,
  type TelegramCallbackQuery,
} from "./telegram";
import type { TelegramMessage } from "./telegram-api";
import { resolveTelegramRecipients } from "./fan-out";
import type { NotificationAction } from "./types";
export {
  handleDoseCommand,
  handleIncomingMessage,
  handleSymptomCommand,
  handleSymptomTextIntake,
  handleTempCommand,
  handleTempReply,
} from "./telegram-quick-log";
import {
  handleMoodTap,
  handlePracticeDoneTap,
  handlePrnLogTap,
  handleSymptomPick,
  handleSymptomSeverity,
} from "./telegram-quick-log";

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

  // Household dose round (#1459): a caregiver's cross-profile confirm. Parsed BEFORE
  // the generic paths because its token names two profiles and resolves its own
  // access edge (chat → receiving profile → member write grant), not the shared
  // chat→profile resolution a single-subject tap uses.
  const household = parseHouseholdDoseCallback(cq.data);
  if (household) {
    await handleHouseholdDoseTap(cq, household);
    return;
  }

  // Stale-workout nudge (#1205): 🏁 Finish workout / 🗑 Discard — resolve a quiet
  // live draft in place through the shared finish/discard cores.
  const workoutFinish = parseWorkoutFinishCallback(cq.data);
  if (workoutFinish) {
    await handleWorkoutFinishTap(cq, workoutFinish);
    return;
  }

  // Food logging (#682): a quick-log button logs one serving of a group; the
  // first-connection opt-in prompt flips the per-profile food-logging flag.
  const foodLog = parseFoodLogCallback(cq.data);
  if (foodLog) {
    await handleFoodLog(cq, foodLog);
    return;
  }
  // Protein "+Xg" quick-log (#1073): the reserved pseudo-group button logs grams via
  // addProteinGramsCore (writing the __protein__ ranking event too), then rebuilds the nudge.
  const foodProtein = parseFoodProteinCallback(cq.data);
  if (foodProtein) {
    await handleFoodProtein(cq, foodProtein);
    return;
  }
  // "➕ Show more" (#1075): reveal the next FOOD_NUDGE_BUTTON_COUNT ranked buttons in place —
  // a stateless view change, answered quietly.
  const foodMore = parseFoodMoreCallback(cq.data);
  if (foodMore) {
    await handleFoodMore(cq, foodMore);
    return;
  }
  const foodOptIn = parseFoodOptInCallback(cq.data);
  if (foodOptIn) {
    await handleFoodOptIn(cq, foodOptIn);
    return;
  }

  // PRN administration logging (#797): a "💊 <med>" button from the /dose command
  // logs one as-needed administration NOW.
  const prn = parsePrnLogCallback(cq.data);
  if (prn) {
    await handlePrnLogTap(cq, prn);
    return;
  }

  // Wellness-practice "Done ✓" (#1259): a button from the pace-aware practice nudge
  // logs one session NOW for the target's practice, and is consumed on tap.
  const practiceDone = parsePracticeDoneCallback(cq.data);
  if (practiceDone) {
    await handlePracticeDoneTap(cq, practiceDone);
    return;
  }

  // Daily mood check-in (#992): a face button logs the day's mood — the same
  // idempotent per-day upsert the dashboard card and offline replay run.
  const moodTap = parseMoodCheckinCallback(cq.data);
  if (moodTap) {
    await handleMoodTap(cq, moodTap);
    return;
  }

  // Symptom quick-log (#859 item 5): a "<symptom>" button opens a severity picker;
  // a severity button logs the symptom-day.
  const symPick = parseSymptomPickCallback(cq.data);
  if (symPick) {
    await handleSymptomPick(cq, symPick);
    return;
  }
  const symSev = parseSymptomSeverityCallback(cq.data);
  if (symSev) {
    await handleSymptomSeverity(cq, symSev);
    return;
  }

  // Unknown/malformed token: ack so the client stops the spinner, do nothing.
  await answerCallbackQuery(cq.id);
}

// A per-render nonce carried in a PRN log button's callback_data — the "dedup
// token". It doesn't itself enforce dedup (logAdministration's short-window guard
// does that, since a PRN log is not idempotent); it keeps a redelivered identical
// callback distinguishable and each rendered button unique.
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
    // Retain the original title line so a shared-chat message stays attributable
    // once its buttons are gone (#377).
    await closeMessage(
      chatId,
      messageId,
      replacementWithTitle(cq.message?.text, closingText)
    );
  } else {
    await updateMessageKeyboard(chatId, messageId, remaining);
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
  // Retain the original title line (which med / whose escalation) above the
  // closing so a shared-chat escalation stays attributable once consumed (#377).
  await closeMessage(
    chatId,
    messageId,
    replacementWithTitle(cq.message?.text, text)
  );
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
  if (!rule) return { kind: "unknown-rule" };
  if (pv.action === "done") {
    recordPreventiveDone(profileId, pv.ruleKey, today(profileId));
    return { kind: "done" };
  }
  if (pv.action === "na") {
    setPreventiveOverride(profileId, pv.ruleKey, "not_applicable");
    return { kind: "not-applicable" };
  }
  // The snooze-until date rides the outcome so the toast + closing text can say
  // when the reminder resumes — the same one-applied-write the bus row records.
  const snoozeUntil = shiftDateStr(today(profileId), PREVENTIVE_SNOOZE_DAYS);
  snoozeFinding(
    profileId,
    preventiveSignalKey(rule.kind, pv.ruleKey),
    snoozeUntil
  );
  return { kind: "reminded", snoozeUntil };
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
  // The closing line states the resolved state in detail (done / not applicable /
  // snoozed-until-when) — toast and body come from the same outcome, so they
  // can't disagree.
  await consumeRow(cq, preventiveCloseText(outcome));
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
  // The chats authorized to act on this escalation: every chat the escalation could
  // have FANNED OUT to for this profile (issue #1072 — each managing login's chat,
  // deduped) plus the escalate override of the supplement the tapped DOSE actually
  // belongs to (issue #615). The caregiver chat is derived from the dose row, NOT
  // from the token's supp id — otherwise a token could pair supplement X's escalate
  // chat with a dose of supplement Y, letting X's caregiver confirm/silence Y's
  // doses. The fan-out set resolves through grants, so a forged id can't widen it.
  const authorizedChats = [
    ...resolveTelegramRecipients(esc.profileId).map((r) => r.chatId),
    getDoseEscalateChatId(esc.profileId, esc.doseId),
  ];
  const profileId = resolveEscalationTap(esc, String(chatId), authorizedChats);
  if (profileId == null) {
    await answerCallbackQuery(cq.id);
    return;
  }

  if (esc.action === "take") {
    // ✅ Confirmed taken → the outcome-typed markDoseTaken; a stale/paused tap
    // logs NOTHING and is answered as such (never falsely confirms a critical
    // med), and a dose meanwhile resolved as skipped (#280) is answered by the
    // status that actually stands — the toast and the replacement body come from
    // the same outcome so they can't disagree.
    const outcome = markDoseTaken(profileId, esc.doseId, esc.suppId, esc.date);
    await answerCallbackQuery(cq.id, tapAnswerText(outcome));
    await replaceMessage(cq, escalationTakeCloseText(outcome));
    return;
  }

  // 👍 I'm on it → acknowledge WITHOUT logging the dose. On a real ack, write the
  // per-episode escalation marker (the same key the tick sets on send), so the
  // episode isn't re-nudged; a taken/skipped/stale/paused dose is answered
  // honestly and nothing is written.
  const ack = escalationAckState(profileId, esc.doseId, esc.date);
  if (ack === "acknowledged") {
    setProfileSetting(profileId, escalationMarkerKey(esc.doseId), esc.date);
  }
  await answerCallbackQuery(cq.id, escalationAckAnswerText(ack));
  await replaceMessage(cq, escalationAckCloseText(ack));
}

// Handle a stale-workout nudge "🏁 Finish workout" / "🗑 Discard" tap (#1205). Resolve
// WHO the session belongs to from the chat (a family chat may map to several profiles;
// the token's profile id disambiguates, cross-checked against the chat like every other
// button), run the shared finishWorkoutSession/discardWorkoutSession core (which
// re-verifies the activity is that profile's), and answer honestly from the typed
// outcome — never an unconditional confirm (a re-tap on an already-finished session
// says so). On a real finish: TRANSFORM this message in place into the #924
// post-workout-dose summary (the SAME renderPostWorkoutFinishMessage the tick sends,
// so the button- and tick-driven finishes can't disagree — #221), and set the #924
// finish marker as delivered so the hourly tick sends no SECOND notification. With no
// pending doses the message becomes a plain "Workout finished ✓". Rebuild rides the one
// chokepoint (rebuildMessage), which re-applies the shared-chat "[Name] " prefix.
async function handleWorkoutFinishTap(
  cq: TelegramCallbackQuery,
  token: WorkoutFinishCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const messageId = cq.message?.message_id;

  if (token.action === "discard") {
    const outcome = discardWorkoutSession(profileId, token.activityId);
    await answerCallbackQuery(cq.id, workoutDiscardAnswerText(outcome));
    if (chatId != null && messageId != null) {
      await closeMessage(
        chatId,
        messageId,
        replacementWithTitle(
          cq.message?.text,
          outcome.kind === "discarded"
            ? "Draft discarded 🗑"
            : OUTDATED_MESSAGE_TEXT
        )
      );
    }
    return;
  }

  const outcome = finishWorkoutSession(profileId, token.activityId);
  await answerCallbackQuery(cq.id, workoutFinishAnswerText(outcome));
  // Only a REAL finish transforms the message + suppresses the separate dispatch. An
  // already-finished re-tap is a no-op (no re-edit surprise); an empty draft keeps its
  // Finish/Discard buttons so the user can Discard; a not-found is left as-is.
  if (outcome.kind !== "finished") return;
  if (chatId == null || messageId == null) return;

  const date = today(profileId);
  // Mark the #924 finish nudge as already delivered (via THIS edit) so the hourly
  // tick's separate post-workout dispatch doesn't fire a duplicate.
  setProfileSetting(
    profileId,
    postWorkoutFinishMarkerKey(token.activityId),
    date
  );

  // Transform into the finish summary: the pending post-workout doses with take/skip
  // buttons, or — when nothing is pending — a plain finished confirmation (no dangling
  // prompt). The dose buttons are the SAME tokens the scheduled reminder uses, handled
  // by handleDoseTap.
  const summary = buildPostWorkoutFinishReminder(profileId, date);
  if (summary) {
    await rebuildMessage(profileId, chatId, messageId, summary);
  } else {
    await closeMessage(
      chatId,
      messageId,
      replacementWithTitle(cq.message?.text, "Workout finished ✅")
    );
  }
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
  // buttons). A coalesced reminder (#1154) can span several slots, so the rebuild
  // re-renders every slot the message's keyboard covered (harvested from the
  // surviving buttons + the tapped dose), not just the tapped dose's slot.
  const footprint = keyboardDoseFootprint(rows);
  const parts = slotSessionForKeyboard(
    profileId,
    [...footprint.doseIds, tap.doseId],
    footprint.slots,
    tap.date
  );
  if (parts.length > 0) {
    // Rebuild through the channel chokepoint, which re-applies the SAME send-time
    // "[Name] " prefix (prefixForProfile — one computation, #377/#454), so a
    // shared-chat rebuild keeps the profile label instead of collapsing to an
    // unattributable title. The handler hands over the un-prefixed message and
    // cannot render the wire text itself.
    await rebuildMessage(
      profileId,
      chatId,
      messageId,
      renderMergedIntakeMessage(
        profileId,
        parts,
        tap.date,
        getUserAge(profileId)
      )
    );
    return;
  }

  // Fallback: the tapped dose is gone (deleted/retired) or no longer due
  // (paused supplement / ended situation), so there's no session view to
  // rebuild — just drop the tapped button. Once none remain, the closing text
  // must match the truth: "All done" only when this tap actually resolved the
  // dose; otherwise say the reminder is stale so the user knows nothing changed.
  // Retain the original title line so the collapsed message stays attributable.
  const remaining = removeButton(rows, cq.data as string);
  if (remaining.length === 0) {
    await closeMessage(
      chatId,
      messageId,
      replacementWithTitle(
        cq.message?.text,
        tapResolved(outcome) ? "All done 💊✅" : OUTDATED_MESSAGE_TEXT
      )
    );
  } else {
    await updateMessageKeyboard(chatId, messageId, remaining);
  }
}

// A household-round confirm (#1459): a caregiver taps "✓ Ada · Vitamin D3" in their
// OWN chat to log a dose for ANOTHER profile. The two-way principle's qualifying case
// exactly — one idempotent, low-risk state change through an existing server function
// (markDoseTaken) — so it earns a button rather than a deep link.
//
// The access edge is re-resolved HERE, at tap time, never trusted from send time: the
// stored subscription is data, the live grants are the authority. A refusal answers
// honestly and writes nothing; a permitted tap answers from markDoseTaken's typed
// outcome, so a retired dose, a paused item or an already-taken dose each get their
// own truthful toast instead of a reflexive ✓.
async function handleHouseholdDoseTap(
  cq: TelegramCallbackQuery,
  tap: HouseholdDoseCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  if (chatId == null) {
    await answerCallbackQuery(cq.id);
    return;
  }
  const access = resolveHouseholdTapAccess(String(chatId), tap);
  if (access.kind !== "allowed") {
    // Nothing was written. Say which of the three gates closed, and leave the
    // keyboard alone — the button may become valid again (a re-granted member), and
    // silently consuming it would strand the caregiver with no way to confirm.
    await answerCallbackQuery(cq.id, householdTapRefusalText(access));
    return;
  }

  // The write runs under the MEMBER's profile id — the same scope the in-app
  // cross-profile confirm uses (requireProfileWriteAccess(targetProfile) →
  // applyDoseStatus) — and markDoseTaken independently re-verifies the
  // dose → item → profile chain, so a forged id cannot cross profiles here.
  // `tap.date` is the MEMBER's own profile-local day, stamped at send time.
  const outcome = markDoseTaken(
    tap.memberProfileId,
    tap.doseId,
    tap.itemId,
    tap.date
  );
  await answerCallbackQuery(
    cq.id,
    householdTapAnswerText(
      householdMemberLabel(tap.receiverProfileId, tap.memberProfileId),
      outcome
    )
  );

  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  const messageId = cq.message?.message_id;
  if (messageId == null || rows.length === 0) return;
  // Consume ONLY the tapped button — a row here is one MEMBER, so dropping the row
  // would take that member's other doses down with it. When the last one goes, close
  // the message with text that matches the truth: "All done" only if this tap actually
  // resolved its dose.
  const remaining = removeButton(rows, cq.data as string);
  if (remaining.length === 0) {
    await closeMessage(
      chatId,
      messageId,
      replacementWithTitle(
        cq.message?.text,
        tapResolved(outcome)
          ? "Household round done 💊✅"
          : OUTDATED_MESSAGE_TEXT
      )
    );
  } else {
    await updateMessageKeyboard(chatId, messageId, remaining);
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

  // The slot's doses are re-collected from CURRENT state (active, non-retired,
  // due today), so this tolerates schedule edits made after the message was
  // sent. Floor-filtered (#1156): "✅ All" marks only the doses the reminder
  // actually listed — a low-priority supplement the send excluded is never
  // silently logged by a bulk tap. Count only real inserts; when the whole slot
  // has since emptied (schedule restructured / items paused), say so instead of
  // "Logged ✅".
  const entries = notifiableWindowDoses(
    collectWindowDoses(profileId, all.window, all.date)
  );
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
        : // Everything due was already resolved (e.g. two caregivers race-tapping
          // ✅ All) — nothing was inserted, so don't claim "Logged ✅" (#280
          // outcome-honesty; #380).
          "Already logged ✓"
  );

  const messageId = cq.message?.message_id;
  if (chatId == null || messageId == null) return;

  // Rebuild from current state — everything's now taken, so this renders the
  // completion summary (no buttons). A coalesced reminder (#1154) can span
  // several slots, so the rebuild covers every slot the keyboard named (the
  // tapped All token's slot plus any sibling buttons). With nothing due anymore
  // there is no session to render; replace the stale message (it had buttons —
  // this tap came from one) so it stops advertising doses that no longer exist.
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  const footprint = keyboardDoseFootprint(rows);
  const parts = slotSessionForKeyboard(
    profileId,
    footprint.doseIds,
    [...footprint.slots, all.window],
    all.date
  );
  if (parts.length === 0) {
    await closeMessage(
      chatId,
      messageId,
      replacementWithTitle(cq.message?.text, OUTDATED_MESSAGE_TEXT)
    );
    return;
  }
  // Rebuild through the chokepoint, which re-applies the send-time "[Name] "
  // prefix (one computation, #377/#454) so the rebuilt completion summary stays
  // attributable in a shared chat.
  await rebuildMessage(
    profileId,
    chatId,
    messageId,
    renderMergedIntakeMessage(profileId, parts, all.date, getUserAge(profileId))
  );
}

// Handle a food quick-log button (#682): resolve the acting profile from the chat,
// log one serving through the shared auth-blind write core (the SAME core the web
// one-tap bar uses), answer honestly from the typed outcome, then rebuild the nudge
// so the tapped group's running count updates. Unlike a dose tap the buttons are NOT
// consumed — a meal is several servings/groups — so the whole nudge is re-rendered
// with every button intact rather than the tapped one removed.
async function handleFoodLog(
  cq: TelegramCallbackQuery,
  food: FoodLogCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(food, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id);
    return;
  }
  // Belt-and-suspenders cross-date guard (#947): a stale keyboard from a previous day
  // can survive (the close-previous strip failed, or the bot restarted between
  // sends). The token carries its SEND date and handleFoodLog would otherwise write to
  // it — logging TODAY's tap to yesterday. When the token's date isn't today in the
  // profile's timezone, log NOTHING and answer honestly (never unconditionally
  // confirm, #232); a same-day tap from an older window still logs (the date is right).
  if (foodTapDateGuard(food.date, today(profileId)).kind === "stale-date") {
    await answerCallbackQuery(cq.id, foodStaleDateAnswerText(food.date));
    return;
  }
  const outcome = logFoodServingCore(profileId, food.group, food.date);
  await answerCallbackQuery(cq.id, foodLogAnswerText(outcome, food.group));

  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  const messageId = cq.message?.message_id;
  // Only rebuild when the message actually had buttons — an absent keyboard would
  // otherwise wrongly overwrite the message text.
  if (chatId == null || messageId == null || rows.length === 0) return;
  // Re-render the whole nudge from current state (same builder as the send, so the
  // ranking + tally stay one computation) and edit in place through the chokepoint,
  // which re-applies the "[Name] " prefix for a shared chat. Preserve the current
  // expansion (#1075): rebuild at the visible count read off the keyboard, so a tap after
  // "Show more" keeps the expanded window rather than collapsing to the compact default.
  const visibleCount = countVisibleFoodButtons(rows) || undefined;
  const rebuilt = buildFoodNudge(
    profileId,
    food.window,
    food.date,
    visibleCount
  );
  if (rebuilt) await rebuildMessage(profileId, chatId, messageId, rebuilt);
}

// Handle a protein "+Xg" quick-log button (#1073): resolve the acting profile from the
// chat, apply the SAME cross-date guard as a food tap (#947 — a stale keyboard would log
// to the wrong day), log the grams through addProteinGramsCore (which also records the
// __protein__ ranking event), answer honestly from the typed outcome (never an
// unconditional confirm), then rebuild the nudge at the current expansion so the refreshed
// protein total shows. Buttons are NOT consumed — a second scoop is one more tap.
async function handleFoodProtein(
  cq: TelegramCallbackQuery,
  token: FoodProteinCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id);
    return;
  }
  if (foodTapDateGuard(token.date, today(profileId)).kind === "stale-date") {
    await answerCallbackQuery(cq.id, foodStaleDateAnswerText(token.date));
    return;
  }
  const outcome = addProteinGramsCore(profileId, token.date, token.grams);
  await answerCallbackQuery(cq.id, foodProteinAnswerText(outcome, token.grams));

  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  const messageId = cq.message?.message_id;
  if (chatId == null || messageId == null || rows.length === 0) return;
  const visibleCount = countVisibleFoodButtons(rows) || undefined;
  const rebuilt = buildFoodNudge(
    profileId,
    token.window,
    token.date,
    visibleCount
  );
  if (rebuilt) await rebuildMessage(profileId, chatId, messageId, rebuilt);
}

// Handle a "➕ Show more" tap (#1075): reveal the next FOOD_NUDGE_BUTTON_COUNT ranked
// buttons in place. STATELESS — the current visible count is derived by counting the ranked
// buttons already in the keyboard, so no token field / stored count is needed; a double-tap
// is harmless (it re-resolves to the next window). A view change, so answer QUIETLY (no
// toast). Rebuilds through the chokepoint, which re-applies the shared-chat "[Name] " prefix.
async function handleFoodMore(
  cq: TelegramCallbackQuery,
  token: FoodMoreCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  const messageId = cq.message?.message_id;
  if (
    profileId == null ||
    chatId == null ||
    messageId == null ||
    rows.length === 0
  ) {
    await answerCallbackQuery(cq.id);
    return;
  }
  const current = countVisibleFoodButtons(rows);
  const rebuilt = buildFoodNudge(
    profileId,
    token.window,
    token.date,
    current + FOOD_NUDGE_BUTTON_COUNT
  );
  if (rebuilt) await rebuildMessage(profileId, chatId, messageId, rebuilt);
  await answerCallbackQuery(cq.id);
}

// Handle the first-connection food opt-in prompt (#682): flip the per-profile
// food-logging flag from the tapped choice and collapse the prompt to a closing
// line. Profile resolved from the chat like every other tap; the prompted marker was
// already set when the prompt was sent, but set it again defensively so a manual
// re-send can't reopen the loop.
async function handleFoodOptIn(
  cq: TelegramCallbackQuery,
  opt: FoodOptInCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(opt, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id);
    return;
  }
  setProfileFoodTelegram(profileId, opt.enable);
  setFoodTelegramPrompted(profileId);
  await answerCallbackQuery(cq.id, foodOptInAnswerText(opt.enable));
  await replaceMessage(cq, foodOptInCloseText(opt.enable));
}
