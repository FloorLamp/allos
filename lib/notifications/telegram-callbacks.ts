// Handles an inbound Telegram button tap ("✅ {name}") regardless of transport:
// the webhook route and the getUpdates poller both delegate here, so both paths
// get identical profile-scoping and verification.

import {
  getDoseCadenceLabel,
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
import { now as clockNow, instantNow } from "../clock";
import {
  parseCorrectionAtToken,
  parseCorrectionChipToken,
} from "../correction-time";
import { DOSE_TIME_PREFIXES, FOOD_TIME_PREFIXES } from "./correction-rows";
import {
  handleDoseTimeAt,
  handleDoseTimeChip,
  handleFoodTimeAt,
  handleFoodTimeChip,
} from "./telegram-time-correction";
import { shiftDateStr } from "../date";
import {
  getProfilesByTelegramChatId,
  setProfileSetting,
  setProfileFoodTelegram,
  setFoodTelegramPrompted,
  getProfileAge,
} from "../settings";
import { logFoodServingCore } from "../food-log-write";
import { addProteinGramsCore } from "../protein-daily-totals-write";
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
  type FoodExpandCallback,
  type FoodOptInCallback,
  type FoodProteinCallback,
  type PreventiveCallback,
  type PreventiveTapOutcome,
  type RefillCallback,
  type RefillTapOutcome,
  type HouseholdDoseCallback,
  type TakeCallback,
  OUTDATED_MESSAGE_TEXT,
  householdStaleDateAnswerText,
  householdTapAnswerText,
  householdTapRefusalText,
  parseHouseholdDoseCallback,
  escalationAckAnswerText,
  escalationAckCloseText,
  escalationSkipCloseText,
  escalationTakeCloseText,
  foodLogAnswerText,
  foodOptInAnswerText,
  foodOptInCloseText,
  foodProteinAnswerText,
  foodStaleDateAnswerText,
  foodTapDateGuard,
  tapDateGuard,
  keyboardDoseFootprint,
  parseAllCallback,
  parseEscalationCallback,
  parseFoodLogCallback,
  parseFoodExpandCallback,
  parseFoodOptInCallback,
  parseFoodProteinCallback,
  parsePreventiveCallback,
  parsePrnLogCallback,
  parseRedoseLogCallback,
  parseOfferTailCallback,
  parseTuneCallback,
  parseDigestTimeCallback,
  parseDemoteCallback,
  parsePracticeDoneCallback,
  parsePracticeLogCallback,
  parseRightSizeLowerCallback,
  parseRefillCallback,
  parseSkipCallback,
  parseTakeCallback,
  parseMoodCheckinCallback,
  parseMoodKeepCallback,
  parseSymptomPickCallback,
  parseSymptomSeverityCallback,
  parseTempReply,
  parseTempReplyMarker,
  parseWorkoutFinishCallback,
  workoutDiscardAnswerText,
  workoutFinishAnswerText,
  parseActivityTypeAskCallback,
  activityTypeAskAnswerText,
  type ActivityTypeAskCallback,
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
  tapAnswerNeedsDismissal,
  tapResolved,
  tapSkipAnswerText,
} from "./callback-data";
import { finishWorkoutSession, discardWorkoutSession } from "../workout-finish";
import { classifyActivityType } from "../activity-type-write";
import {
  buildPostWorkoutFinishReminder,
  postWorkoutFinishMarkerKey,
} from "./workout-presence";
import {
  collectWindowDoses,
  slotSessionForKeyboard,
  withDoseCorrections,
} from "./supplements";
import {
  notifiableWindowDoses,
  renderMergedIntakeMessage,
} from "./supplement-format";
import { buildFoodNudge } from "./food";
import { countVisibleFoodButtons } from "./food-format";
import { FOOD_QUICK_COUNT } from "../food-rank";
import { messagePointerIdAt } from "./message-pointers";
import {
  answerCallbackQuery,
  closeMessage,
  rebuildMessage,
  updateMessageKeyboard,
  type TelegramCallbackQuery,
} from "./telegram";
import type { TelegramMessage } from "./telegram-api";
import { resolveTelegramRecipients } from "./fan-out";
import type { NotificationAction } from "./types";
import type { DoseTakenOutcome } from "../types";
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
  handleMoodKeepTap,
  handlePracticeDoneTap,
  handleRightSizeLowerTap,
  handlePrnLogTap,
  handleRedoseLogTap,
  handleOfferTailTap,
  handleTuneTap,
  handleDigestTimeTap,
  handleDemoteTap,
  handleSymptomPick,
  handleSymptomSeverity,
} from "./telegram-quick-log";
import { GLYPH } from "./glyphs";

// The cadence phrase for an OFF-DAY confirm, or null on every other outcome (#1602).
// Gated on the outcome so the ordinary confirm path never pays for the lookup, and
// centralized here so both tap sites answer an off-cadence log identically.
function offDayCadence(
  profileId: number,
  doseId: number,
  outcome: DoseTakenOutcome
): string | null {
  return outcome === "logged-off-day"
    ? getDoseCadenceLabel(profileId, doseId)
    : null;
}

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

  // A dose tap is either ✅ take or ⏭️ skip (#232); both carry the same token
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

  // Stale-workout nudge (#1205): 🏁 Finish workout / 🗑️ Discard — resolve a quiet
  // live draft in place through the shared finish/discard cores.
  const workoutFinish = parseWorkoutFinishCallback(cq.data);
  if (workoutFinish) {
    await handleWorkoutFinishTap(cq, workoutFinish);
    return;
  }

  // The post-workout TYPE ask (#2272): the source recorded a workout but declined to
  // say what kind, so the recap that was already going out asked. The tap is the write.
  const typeAsk = parseActivityTypeAskCallback(cq.data);
  if (typeAsk) {
    await handleActivityTypeAskTap(cq, typeAsk);
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
  // "➕ Show more" (#1075) / "➖ Show less" (#1807): page the ranked buttons up or down in
  // place — a stateless view change, answered quietly.
  const foodExpand = parseFoodExpandCallback(cq.data);
  if (foodExpand) {
    await handleFoodExpand(cq, foodExpand);
    return;
  }
  const foodOptIn = parseFoodOptInCallback(cq.data);
  if (foodOptIn) {
    await handleFoodOptIn(cq, foodOptIn);
    return;
  }
  // Eating-time correction (#2019): a −Nh chip, or the 🕐 absolute-hour drill-down.
  // Both ride the food nudge's own keyboard and re-stamp `occurred_at` for a whole burst.
  const foodTimeChip = parseCorrectionChipToken(
    cq.data,
    FOOD_TIME_PREFIXES.chip
  );
  if (foodTimeChip) {
    await handleFoodTimeChip(cq, foodTimeChip);
    return;
  }
  const foodTimeAt = parseCorrectionAtToken(cq.data, FOOD_TIME_PREFIXES.at);
  if (foodTimeAt) {
    await handleFoodTimeAt(cq, foodTimeAt);
    return;
  }
  // The dose twin (#2020), over `recorded_at` — the safety-relevant one, because the PRN
  // redose window arms off exactly the instant these buttons correct.
  const doseTimeChip = parseCorrectionChipToken(
    cq.data,
    DOSE_TIME_PREFIXES.chip
  );
  if (doseTimeChip) {
    await handleDoseTimeChip(cq, doseTimeChip);
    return;
  }
  const doseTimeAt = parseCorrectionAtToken(cq.data, DOSE_TIME_PREFIXES.at);
  if (doseTimeAt) {
    await handleDoseTimeAt(cq, doseTimeAt);
    return;
  }

  // ⤓ May (#1505 part 2): accept the demotion suggestion riding this reminder. The
  // one obligation write the notification layer can make — user-initiated, downward,
  // and through the same compare-and-swap core the in-app card uses.
  const demote = parseDemoteCallback(cq.data);
  if (demote) {
    await handleDemoteTap(cq, demote);
    return;
  }

  // The digest's offer tail (#1505): expand/collapse the "Log other…" button in
  // place. Checked BEFORE the prn: log tokens because the expanded keyboard is made
  // of those, and a tail tap must never be mistaken for a log.
  const offerTail = parseOfferTailCallback(cq.data);
  if (offerTail) {
    await handleOfferTailTap(cq, offerTail);
    return;
  }

  // The digest's ⚙️ Tune control (#1714): expand/collapse the per-category toggles in
  // place, or flip one category's demotion. Parsed here — before the log tokens —
  // for the same reason the offer tail is: an expanded Tune keyboard is made of
  // `tunet:` buttons and a tune tap must never be mistaken for anything that writes
  // to the profile's records.
  const tune = parseTuneCallback(cq.data);
  if (tune) {
    await handleTuneTap(cq, tune);
    return;
  }

  // The digest time suggestion's exits (#2217): Use HH:MM / As soon as it's ready /
  // Not now. Parsed alongside the other digest-riding controls, and before the log
  // tokens, for the same reason they are: these buttons write a SETTING, and a tap on
  // one must never be mistaken for anything that writes to the profile's records.
  const digestTime = parseDigestTimeCallback(cq.data);
  if (digestTime) {
    await handleDigestTimeTap(cq, digestTime);
    return;
  }

  // One administration-armed redose window. Parsed before the reusable `/dose` token:
  // this button is consumed and refuses after an app log supersedes its window.
  const redose = parseRedoseLogCallback(cq.data);
  if (redose) {
    await handleRedoseLogTap(cq, redose);
    return;
  }

  // PRN administration logging (#797): a "💊 <med>" button from the /dose command
  // logs one as-needed administration NOW.
  const prn = parsePrnLogCallback(cq.data);
  if (prn) {
    await handlePrnLogTap(cq, prn);
    return;
  }

  // Wellness-practice "Done ✅" (#1259): a button from the pace-aware practice nudge
  // logs one session NOW for the target's practice, and is consumed on tap.
  const practiceDone = parsePracticeDoneCallback(cq.data);
  if (practiceDone) {
    await handlePracticeDoneTap(cq, practiceDone);
    return;
  }

  // The same tap from the on-demand `/practice` list (#1895). A different PREFIX,
  // because the two messages claim different things to the sweep (see callback-data),
  // and deliberately the SAME handler and write core — a second logging path for one
  // button is how two answers to "did that log?" come about.
  const practiceLog = parsePracticeLogCallback(cq.data);
  if (practiceLog) {
    await handlePracticeDoneTap(cq, practiceLog);
    return;
  }

  // Right-sizing ride-along (#1670): the same practice nudge's ⤓ button lowers the
  // weekly floor to the cadence actually kept — the floor is re-derived from the live
  // detector on tap, never read off the button.
  const rightSize = parseRightSizeLowerCallback(cq.data);
  if (rightSize) {
    await handleRightSizeLowerTap(cq, rightSize);
    return;
  }

  // Daily mood check-in (#992): a face button logs the day's mood — the same
  // idempotent per-day upsert the dashboard card and offline replay run.
  const moodTap = parseMoodCheckinCallback(cq.data);
  if (moodTap) {
    await handleMoodTap(cq, moodTap);
    return;
  }

  // "Keep daily check-ins" (#1668): the confirm-to-KEEP affordance the final reminder
  // carries before the auto-pause takes effect.
  const moodKeep = parseMoodKeepCallback(cq.data);
  if (moodKeep) {
    await handleMoodKeepTap(cq, moodKeep);
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

  // Unknown/malformed token — a button from a message whose token shape has since
  // been retired. Nothing is written, so answer honestly rather than silently (#1716).
  await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
}

// A per-render nonce carried in a PRN log button's callback_data — the "dedup
// token". It doesn't itself enforce dedup (logAdministration's short-window guard
// does that, since a PRN log is not idempotent); it keeps a redelivered identical
// callback distinguishable and each rendered button unique.
async function consumeRow(
  profileId: number,
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
      profileId,
      chatId,
      messageId,
      replacementWithTitle(cq.message?.text, closingText)
    );
  } else {
    await updateMessageKeyboard(profileId, chatId, messageId, remaining);
  }
}

// Replace a single-action message (its buttons consumed) with a closing line.
// Used by escalation, whose ✅/👍 pair resolves the whole message in one tap.
async function replaceMessage(
  profileId: number,
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
    profileId,
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
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const outcome = applyPreventiveTap(profileId, pv);
  await answerCallbackQuery(cq.id, preventiveAnswerText(outcome));
  // The closing line states the resolved state in detail (done / not applicable /
  // snoozed-until-when) — toast and body come from the same outcome, so they
  // can't disagree.
  await consumeRow(profileId, cq, preventiveCloseText(outcome));
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
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const outcome = applyRefillTap(profileId, rf);
  await answerCallbackQuery(cq.id, refillAnswerText(outcome));
  await consumeRow(
    profileId,
    cq,
    outcome === "snoozed"
      ? `Refill reminder snoozed ${GLYPH.ordered}`
      : OUTDATED_MESSAGE_TEXT
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
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT, {
      alert: true,
    });
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
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT, {
      alert: true,
    });
    return;
  }

  if (esc.action === "skip") {
    // ⏭️ Skip → markDoseSkipped, the SAME write the dose reminder's skip performs, so
    // the ledger cannot tell the two apart (#1716). A skip is a decision: it ends the
    // escalation loop through the existing skippedDoseIds gate rather than needing a
    // marker of its own. Never an unconditional confirm — an already-taken or stale
    // dose is answered by the status that actually stands.
    const outcome = markDoseSkipped(
      profileId,
      esc.doseId,
      esc.suppId,
      esc.date
    );
    await answerCallbackQuery(cq.id, tapSkipAnswerText(outcome), {
      alert: tapAnswerNeedsDismissal(outcome, "skip"),
    });
    await replaceMessage(profileId, cq, escalationSkipCloseText(outcome));
    return;
  }

  if (esc.action === "take") {
    // ✅ Confirmed taken → the outcome-typed markDoseTaken; a stale/paused tap
    // logs NOTHING and is answered as such (never falsely confirms a critical
    // med), and a dose meanwhile resolved as skipped (#280) is answered by the
    // status that actually stands — the toast and the replacement body come from
    // the same outcome so they can't disagree.
    //
    // DELIBERATELY NO #2264 MESSAGE PROVENANCE: the escalation closes itself on this
    // very tap (replaceMessage below), so a burst attributed to it could never render
    // anywhere. Left unattributed, it behaves like a web one-tap — its correction row
    // rides the newest live dose message — which keeps the chat-side correction
    // reachable instead of burying it on a closed message.
    const outcome = markDoseTaken(profileId, esc.doseId, esc.suppId, esc.date);
    await answerCallbackQuery(
      cq.id,
      tapAnswerText(outcome, offDayCadence(profileId, esc.doseId, outcome)),
      { alert: tapAnswerNeedsDismissal(outcome, "take") }
    );
    await replaceMessage(profileId, cq, escalationTakeCloseText(outcome));
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
  // Held to the same bar as the take/skip arms beside it, on the same line: the two
  // arms that leave the episode OUTSTANDING while recording nothing — a retired dose, a
  // paused item — must not let the caregiver who tapped 👍 walk away believing it is
  // handled. `already-taken` / `already-skipped` are not that: the dose IS resolved and
  // there was nothing to chase, which is reassurance, and spending a dismissal on
  // reassurance is how the alerts that matter stop being read.
  await answerCallbackQuery(cq.id, escalationAckAnswerText(ack), {
    alert: ack === "stale-dose" || ack === "inactive",
  });
  await replaceMessage(profileId, cq, escalationAckCloseText(ack));
}

// Handle a stale-workout nudge "🏁 Finish workout" / "🗑️ Discard" tap (#1205). Resolve
// WHO the session belongs to from the chat (a family chat may map to several profiles;
// the token's profile id disambiguates, cross-checked against the chat like every other
// button), run the shared finishWorkoutSession/discardWorkoutSession core (which
// re-verifies the activity is that profile's), and answer honestly from the typed
// outcome — never an unconditional confirm (a re-tap on an already-finished session
// says so). On a real finish: TRANSFORM this message in place into the #924
// post-workout-dose summary (the SAME renderPostWorkoutFinishMessage the tick sends,
// so the button- and tick-driven finishes can't disagree — #221), and set the #924
// finish marker as delivered so the hourly tick sends no SECOND notification. With no
// pending doses the message becomes a plain "Workout finished ✅". Rebuild rides the one
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
        profileId,
        chatId,
        messageId,
        replacementWithTitle(
          cq.message?.text,
          outcome.kind === "discarded"
            ? `Draft discarded ${GLYPH.discarded}`
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
      profileId,
      chatId,
      messageId,
      replacementWithTitle(cq.message?.text, `Workout finished ${GLYPH.done}`)
    );
  }
}

// The post-workout TYPE ask (#2272). The source recorded a session and declined to say
// what kind; the recap asked, and this is the answer. Detection SUGGESTS, the user's
// tap WRITES (#1670) — nothing classifies on its own, and the answer applies to THIS
// ROW only (no remembered per-profile inference rule, which would be a second engine
// silently mislabeling every session after it).
//
// The keyboard is consumed whatever the outcome, because the ask is asked ONCE: an
// answered row has its answer, and a row that was deleted or absorbed by the duplicate
// auto-merge (#2271) has nothing left to answer for. The toast says which of those
// happened rather than confirming a write that did not occur.
async function handleActivityTypeAskTap(
  cq: TelegramCallbackQuery,
  token: ActivityTypeAskCallback
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
  const outcome = classifyActivityType(profileId, token.activityId, token.type);
  await answerCallbackQuery(cq.id, activityTypeAskAnswerText(outcome));
  await consumeRow(profileId, cq, activityTypeAskAnswerText(outcome));
}

// Apply a single ✅ take or ⏭️ skip tap: resolve the acting profile from the chat,
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
    // profile that doesn't share this chat): write nothing and SAY SO (#1716). A
    // silent ack stops the spinner and reads as success — on the safety tier that
    // means a caregiver believing a critical dose is confirmed when nothing was
    // logged. Every refusal answers the same honest text the seven sibling handlers
    // already used.
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT, {
      alert: true,
    });
    return;
  }

  // markDoseTaken/markDoseSkipped independently verify the dose → supplement →
  // profile chain before writing, so a forged dose id from another profile is
  // rejected there. The message the button lives in is a frozen snapshot — the
  // dose may have been deleted/retired by an edit, or its item paused, since it
  // was sent — so answer with what ACTUALLY happened, never unconditionally.
  //
  // A take records WHICH MESSAGE it came from (#2264): the (chat, message) resolves to
  // its notify_messages pointer, so the dose-time correction burst this confirm joins
  // renders on THIS reminder and never on a sibling. A skip writes no `recorded_at` and
  // can never join a burst, so it carries none.
  const messageId = cq.message?.message_id;
  const outcome =
    kind === "take"
      ? markDoseTaken(
          profileId,
          tap.doseId,
          tap.suppId,
          tap.date,
          undefined,
          chatId != null && messageId != null
            ? messagePointerIdAt(profileId, chatId, messageId)
            : null
        )
      : markDoseSkipped(profileId, tap.doseId, tap.suppId, tap.date);
  await answerCallbackQuery(
    cq.id,
    kind === "take"
      ? tapAnswerText(outcome, offDayCadence(profileId, tap.doseId, outcome))
      : tapSkipAnswerText(outcome),
    { alert: tapAnswerNeedsDismissal(outcome, kind) }
  );

  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
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
      withDoseCorrections(
        profileId,
        renderMergedIntakeMessage(
          profileId,
          parts,
          tap.date,
          getProfileAge(profileId)
        ),
        { ref: { chatId, messageId } }
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
      profileId,
      chatId,
      messageId,
      replacementWithTitle(
        cq.message?.text,
        tapResolved(outcome)
          ? `All done ${GLYPH.dose}${GLYPH.done}`
          : OUTDATED_MESSAGE_TEXT
      )
    );
  } else {
    await updateMessageKeyboard(profileId, chatId, messageId, remaining);
  }
}

// A household-round confirm (#1459): a caregiver taps "✅ Ada · Vitamin D3" in their
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
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT, {
      alert: true,
    });
    return;
  }
  const access = resolveHouseholdTapAccess(String(chatId), tap);
  if (access.kind !== "allowed") {
    // Nothing was written. Say which of the three gates closed, and leave the
    // keyboard alone — the button may become valid again (a re-granted member), and
    // silently consuming it would strand the caregiver with no way to confirm.
    await answerCallbackQuery(cq.id, householdTapRefusalText(access), {
      alert: true,
    });
    return;
  }

  // DATE GUARD (#1719), belt-and-braces with the send-time keyboard rotation. The
  // token carries the member's SEND-TIME date, so a tap on a round that survived into
  // the next morning would confirm a dose against YESTERDAY — for someone else's
  // medication. Compared against the MEMBER's today, never the receiver's, because a
  // round can legitimately span two calendar dates in a mixed-timezone household.
  // Nothing is written and the keyboard is left alone (the same posture as an access
  // refusal: a stale button is not a forged one).
  if (
    tapDateGuard(tap.date, today(tap.memberProfileId)).kind === "stale-date"
  ) {
    await answerCallbackQuery(cq.id, householdStaleDateAnswerText(tap.date), {
      alert: true,
    });
    return;
  }

  // The write runs under the MEMBER's profile id — the same scope the in-app
  // cross-profile confirm uses (requireProfileWriteAccess(targetProfile) →
  // setDoseStatusCore) — and markDoseTaken independently re-verifies the
  // dose → item → profile chain, so a forged id cannot cross profiles here.
  // `tap.date` is the MEMBER's own profile-local day, stamped at send time.
  //
  // DELIBERATELY NO #2264 MESSAGE PROVENANCE: the round message belongs to the
  // RECEIVER's profile, so it could never render the member's correction rows anyway
  // (a pointer lookup under the member's id would miss it by construction). Left
  // unattributed, the member's burst rides the newest live dose message in the
  // member's own chat — where they can actually correct it.
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
  // The pointer's subject is the RECEIVER, not the member: this message was sent to the
  // caregiver's own chat for their own profile, and the write that just ran under the
  // member's id does not move who the message belongs to.
  const owner = tap.receiverProfileId;
  if (remaining.length === 0) {
    await closeMessage(
      owner,
      chatId,
      messageId,
      replacementWithTitle(
        cq.message?.text,
        tapResolved(outcome)
          ? `Household round done ${GLYPH.dose}${GLYPH.done}`
          : OUTDATED_MESSAGE_TEXT
      )
    );
  } else {
    await updateMessageKeyboard(owner, chatId, messageId, remaining);
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
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT, {
      alert: true,
    });
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
  // The originating message (#2264), stamped onto every log this bulk tap writes so
  // the burst it creates renders on THIS reminder and never on a sibling.
  const allMessageId = cq.message?.message_id;
  const notifyMessageId =
    chatId != null && allMessageId != null
      ? messagePointerIdAt(profileId, chatId, allMessageId)
      : null;
  let logged = 0;
  for (const e of entries) {
    // A deliberately-skipped dose (#232) is already resolved — "✅ All" marks the
    // remaining PENDING doses taken and leaves skips alone.
    if (
      !e.taken &&
      !e.skipped &&
      markDoseTaken(
        profileId,
        e.dose.id,
        e.supp.id,
        all.date,
        undefined,
        notifyMessageId
      ) === "logged"
    ) {
      logged++;
    }
  }
  await answerCallbackQuery(
    cq.id,
    entries.length === 0
      ? "Not logged — this reminder is out of date. Open the app."
      : logged > 0
        ? `All logged ${GLYPH.done}`
        : // Everything due was already resolved (e.g. two caregivers race-tapping
          // ✅ All) — nothing was inserted, so don't claim "Logged ✅" (#280
          // outcome-honesty; #380).
          `Already logged ${GLYPH.done}`,
    // An empty slot is the only arm that contradicts the button: "Already logged" is
    // the state ✅ All asked for, reached by someone else.
    { alert: entries.length === 0 }
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
      profileId,
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
    withDoseCorrections(
      profileId,
      renderMergedIntakeMessage(
        profileId,
        parts,
        all.date,
        getProfileAge(profileId)
      ),
      { ref: { chatId, messageId } }
    )
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
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
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
  // THE TAP IS THE EATING-TIME CAPTURE (#2019). This button's declared contract is "I'm
  // eating NOW" — it has been documented as that since #947 — so the tap instant is a
  // measurement of when the serving was eaten, with a known error, not a guess. It is
  // recorded as such (`time_source = 'tap'`) and the correction chips on this same
  // keyboard are how the error gets fixed when the contract was false.
  //
  // NO EXPLICIT `meal_slot` IS WRITTEN, reversing #1704. The nudge's window is the NUDGE
  // naming itself, not the user declaring a meal; it stays on the token for message
  // identity and rebuild only. With a real eating instant on the row, the window the
  // serving belongs to is DERIVED from when it was eaten — so a correction moves the
  // meal along with the time, which an asserted slot would have frozen in place.
  //
  // THE MESSAGE IS RECORDED ON THE ROW (#2264): the (chat, message) this tap arrived
  // from resolves to its notify_messages pointer, so the correction burst this serving
  // joins renders on THIS message and never on a sibling about some other meal.
  const tapAt = instantNow();
  const messageId = cq.message?.message_id;
  const origin =
    chatId != null && messageId != null
      ? { notifyMessageId: messagePointerIdAt(profileId, chatId, messageId) }
      : undefined;
  const outcome = logFoodServingCore(
    profileId,
    food.group,
    food.date,
    tapAt,
    undefined,
    { eatenAt: tapAt, source: "tap" },
    origin
  );
  await answerCallbackQuery(cq.id, foodLogAnswerText(outcome, food.group));

  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
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
    visibleCount,
    { ref: { chatId, messageId } }
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
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  if (foodTapDateGuard(token.date, today(profileId)).kind === "stale-date") {
    await answerCallbackQuery(cq.id, foodStaleDateAnswerText(token.date));
    return;
  }
  // The protein sibling of the food tap's #2019 capture: the same "I'm having this now"
  // contract, the same recorded instant, the same reason no explicit `meal_slot` is
  // written, and the same #2264 message provenance — a protein burst's correction row
  // renders on the message that produced it. The __protein__ ledger row rides the
  // identical columns, which is what makes protein DISTRIBUTION — the actual
  // recommendation — computable from this ledger.
  const tapAt = instantNow();
  const messageId = cq.message?.message_id;
  const origin =
    chatId != null && messageId != null
      ? { notifyMessageId: messagePointerIdAt(profileId, chatId, messageId) }
      : undefined;
  const outcome = addProteinGramsCore(
    profileId,
    token.date,
    token.grams,
    tapAt,
    undefined,
    { eatenAt: tapAt, source: "tap" },
    origin
  );
  await answerCallbackQuery(cq.id, foodProteinAnswerText(outcome, token.grams));

  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (chatId == null || messageId == null || rows.length === 0) return;
  const visibleCount = countVisibleFoodButtons(rows) || undefined;
  const rebuilt = buildFoodNudge(
    profileId,
    token.window,
    token.date,
    visibleCount,
    { ref: { chatId, messageId } }
  );
  if (rebuilt) await rebuildMessage(profileId, chatId, messageId, rebuilt);
}

// Handle a "➕ Show more" (#1075) / "➖ Show less" (#1807) tap: page the ranked buttons one
// FOOD_QUICK_COUNT step up or down in place. STATELESS in BOTH directions — the
// current visible count is derived by counting the ranked buttons already in the keyboard,
// so no token field / stored count is needed; a double-tap is harmless (expanding
// re-resolves to the next window, collapsing clamps at the compact default a fresh send
// uses). A view change, so answer QUIETLY (no toast). Rebuilds through `buildFoodNudge` —
// the same builder the send and every other rebuild call — so the slot-scoped "(n)"
// suffixes, the protein pseudo-group button, the tally and the protein line all survive a
// collapse exactly as they survive an expansion; and through the chokepoint, which
// re-applies the shared-chat "[Name] " prefix.
async function handleFoodExpand(
  cq: TelegramCallbackQuery,
  token: FoodExpandCallback
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
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const current = countVisibleFoodButtons(rows);
  // The clamp is the whole asymmetry between the two directions: expanding is unbounded
  // (the renderer drops "Show more" once every ranked key is out), collapsing bottoms out
  // at the compact default rather than at an empty keyboard.
  const next =
    token.action === "more"
      ? current + FOOD_QUICK_COUNT
      : Math.max(FOOD_QUICK_COUNT, current - FOOD_QUICK_COUNT);
  const rebuilt = buildFoodNudge(profileId, token.window, token.date, next, {
    ref: { chatId, messageId },
  });
  // Show more / show less writes nothing: the clamp above IS the outcome, so the ack
  // goes before the redraw (#2418).
  await answerCallbackQuery(cq.id);
  if (rebuilt) await rebuildMessage(profileId, chatId, messageId, rebuilt);
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
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  setProfileFoodTelegram(profileId, opt.enable);
  setFoodTelegramPrompted(profileId);
  await answerCallbackQuery(cq.id, foodOptInAnswerText(opt.enable));
  await replaceMessage(profileId, cq, foodOptInCloseText(opt.enable));
}
