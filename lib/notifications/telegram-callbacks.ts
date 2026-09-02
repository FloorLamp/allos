// Handles an inbound Telegram button tap ("✅ {name}") regardless of transport:
// the webhook route and the getUpdates poller both delegate here, so both paths
// get identical profile-scoping and verification.

import type { LoggedVia } from "../logged-via";
import {
  getDoseCadenceLabel,
  markDoseTaken,
  markDoseSkipped,
  recordPreventiveDone,
  setPreventiveOverride,
  snoozeFinding,
  intakeItemExists,
  getDoseEscalateChatId,
  escalationAckState,
} from "../queries";
import { today } from "../db";
import { instantNow } from "../clock";
import {
  parseCorrectionAtToken,
  parseCorrectionChipToken,
} from "../correction-time";
import {
  DOSE_TIME_PREFIXES,
  FOOD_TIME_PREFIXES,
  PRACTICE_TIME_PREFIXES,
} from "./correction-rows";
import {
  handleDoseTimeAt,
  handleDoseTimeChip,
  handleFoodTimeAt,
  handleFoodTimeChip,
  handlePracticeTimeAt,
  handlePracticeTimeChip,
} from "./telegram-time-correction";
import { shiftDateStr } from "../date";
import {
  getProfilesByTelegramChatId,
  loginIdForTelegramChatProfile,
  setProfileSetting,
  setProfileFoodTelegram,
  setFoodTelegramPrompted,
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
  type TapWrote,
  OUTDATED_MESSAGE_TEXT,
  STALE_TOKEN_REFUSAL,
  householdStaleDateAnswerText,
  householdTapAnswerText,
  householdTapRefusalText,
  parseHouseholdDoseCallback,
  escalationAckAnswerText,
  escalationAckCloseText,
  escalationSkipCloseText,
  escalationTakeCloseText,
  foodLogAnswerText,
  BULK_ALL_SKIPPED_TEXT,
  foodOptInAnswerText,
  foodOptInCloseText,
  foodProteinAnswerText,
  foodStaleDateAnswerText,
  foodTapDateGuard,
  tapDateGuard,
  keyboardDoseFootprint,
  parseAllCallback,
  parseOfferCallback,
  type OfferCallback,
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
  parseMedStopCallback,
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
  parseWorkoutFinishCallback,
  workoutDiscardAnswerText,
  workoutFinishAnswerText,
  parseActivityTypeAskCallback,
  activityTypeAskAnswerText,
  type ActivityTypeAskCallback,
  type WorkoutFinishCallback,
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
import {
  logUsualRoutineCore,
  recordUsualBackfillAudit,
  usualRoutineDoseLogged,
} from "../usual-routine-write";
import {
  usualRoutineAnswerText,
  usualRoutineFoodMembers,
  usualRoutineWriteAnswer,
} from "../usual-routine";
import { foodGroupName } from "../food-groups";
import { readOfferRow } from "./offer-store";
import { isDoseDateAccepted } from "../dose-log-window";
import { USUAL_BACKFILL } from "../logged-via";
import {
  USUAL_OFFER_FAMILY,
  type StoredUsualOffer,
} from "./usual-routine-attach";
import { keyboardTokens, tokenPrefix } from "./reconcile-core";
import { owningFamily } from "./reconcile-registry";
import { finishWorkoutSession, discardWorkoutSession } from "../workout-finish";
import { classifyActivityType } from "../activity-type-write";
import {
  buildPostWorkoutFinishReminder,
  postWorkoutFinishMarkerKey,
} from "./workout-presence";
import {
  collectWindowDoses,
  renderDoseSession,
  slotSessionForKeyboard,
  standingStackOffer,
  withDoseCorrections,
} from "./intake";
import {
  INTAKE_SEND_SLOTS,
  notifiableWindowDoses,
  type IntakeSlotPart,
} from "./intake-format";
import { buildFoodNudge } from "./food";
import { keyboardChatOrigin, withChatOrigin } from "./chat-origin";
import { countVisibleFoodButtons } from "./food-format";
import { FOOD_QUICK_COUNT } from "../food-rank";
import { messagePointerIdAt } from "./message-pointers";
import { reconcileProfileMessages } from "./reconcile";
import { createLogger } from "../log";
import {
  answerCallbackQuery,
  closeMessage,
  rebuildMessage,
  TELEGRAM_CALL_TIMEOUT_MS,
  updateMessageKeyboard,
  type TelegramCallbackQuery,
} from "./telegram";
import { resolveTelegramRecipients } from "./fan-out";
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
  handleMedStopTap,
  handleSymptomPick,
  handleSymptomSeverity,
} from "./telegram-quick-log";
import { GLYPH } from "./glyphs";

// EVERY write in this module is a tap on a button this app SENT (#3087) — a dose
// reminder, an escalation, a digest offer, the household round, the usual-routine
// offer. The on-demand lists behind the slash commands live in telegram-quick-log.ts
// and stamp `telegram-command` instead; a free-text intake stamps `telegram-text`.
// Named once here so the three chat surfaces stay legibly distinct at every call site.
const NUDGE: LoggedVia = "telegram-nudge";
const log = createLogger("notify");
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

// ── ONE TAP, ONE SWEEP (#3933) ───────────────────────────────────────────────
//
// Every button in the app arrives here, so this is where the profile's OTHER live
// keyboards are brought up to date — not in each handler, where a new button could
// forget it. The hourly tick still runs the same sweep for everything no tap reaches
// (an app write, an expired claim); this adds a trigger, it does not replace one.
//
// THE ORDER IS THE POINT. `dispatchTap` has already answered the callback by the time
// it returns — Telegram wants that ack promptly and it must not wait on another
// message's edits — and it reports WHETHER it wrote, so a tap that only navigated or
// refused a stale token costs nothing.
//
// HOW LONG THE SWEEP MAY TAKE (#3951 F5). This runs on the webhook's synchronous 200
// path, which the route's own contract says returns quickly, and #3933 made it
// O(live pointers) — pointers live MESSAGE_POINTER_RETENTION_DAYS and each edit is
// capped at TELEGRAM_CALL_TIMEOUT_MS, with nothing bounding the sweep as a whole.
// `NOTIFICATION_DISPATCH_TIMEOUT_MS` does not apply: it bounds a dispatch fan-out, and
// reconcile never reads it. Two hung edits therefore exceed Telegram's webhook timeout,
// Telegram re-delivers the update, and the WHOLE TAP re-runs including its write. Dose
// taps are idempotent; `handleFoodLog`, `handlePracticeDoneTap` and `logAdministration`
// are guarded only by their own short-window rules, so a re-delivery can put a second
// serving or a second administration into a person's health record. That is the harm
// this budget exists to prevent, and it is worse than an hour of stale keyboards.
//
// THE CONSTANT IS ONE CALL'S WORTH, and it is derived rather than guessed: a figure for
// Telegram's retry window would be a claim about someone else's infrastructure wearing
// a comment, while TELEGRAM_CALL_TIMEOUT_MS is a number this repo owns and can change
// in one place. One call's budget gives a worst case of two — one started just before
// the deadline plus the one already in flight. Steady state is genuinely zero calls
// (the idempotence pin in ReconcileResult.edited), so this only ever binds when the
// chat is already degraded, which is exactly the case that threatens the timeout.
export const TAP_SWEEP_BUDGET_MS = TELEGRAM_CALL_TIMEOUT_MS;

export async function handleCallbackQuery(
  cq: TelegramCallbackQuery
): Promise<void> {
  let wrote: TapWrote;
  try {
    wrote = await dispatchTap(cq);
  } catch (e) {
    // ── A WRITE THAT LANDS WITH A FAILED REBUILD KEEPS ITS SWEEP (#3951 F4) ───
    //
    // Writing handlers run write -> answer -> `rebuildMessage`, and `rebuildMessage`
    // ends in `editMessageTextRaw`, which throws on ANY Bot API failure. That throw
    // used to exit `dispatchTap` before the sweep ran, and the webhook swallowed it —
    // leaving precisely the state the sweep exists for: the ledger moved, the person
    // was told it moved, and now EVERY live message is stale rather than one. A gap in
    // new coverage rather than a regression; before #3933 a rebuild throw lost nothing
    // because there was no sweep to lose.
    //
    // The thrown value cannot name the profile — the handler that computed it is gone —
    // so the target is resolved the way an inbound tap resolves one whose token does
    // not name a profile: the profiles this chat can act as. That is a SUPERSET for a
    // single-subject write and costs nothing (a swept profile with nothing stale edits
    // zero times), and it is INCOMPLETE for the household round, which writes under a
    // member whose own chat this may not be. Sweeping the wrong-but-adjacent set beats
    // sweeping none, and the tick still reaches the member within the hour.
    //
    // F5's budget had to land first: this adds a sweep on exactly the degraded path
    // that already threatened the webhook's timeout.
    log.info("tap threw after answering; sweeping anyway", {
      err: e instanceof Error ? e.message : String(e),
    });
    const chatId = cq.message?.chat?.id;
    await sweepAfterTap(
      chatId == null ? [] : getProfilesByTelegramChatId(String(chatId))
    );
    throw e;
  }
  if (wrote != null) await sweepAfterTap([wrote]);
}

// The profile's live messages, reconciled against the ledger this tap just moved.
// Wrapped exactly as the tick wraps it (tick.ts): a reconcile error is logged and
// swallowed, because the write has landed and the person has been answered — the same
// failure isolation, without the hour's wait.
//
// THE TAPPED MESSAGE IS SWEPT TOO, and excluding it was tried and retracted. "Its
// handler just rebuilt it" holds only for handlers that re-render through a domain
// builder; `handleDigestTimeTap` and `handleTuneTap` edit the KEYBOARD only, and
// `syncMessagePointerKeyboard` never touches `body_hash` — so the digest's own
// sentences were the one thing no path could correct until the next tick, the hour
// this hook exists to remove. A message that WAS rebuilt costs nothing here: its
// pointer is in sync, so the sweep computes the same render and edits zero times. The
// exactly-once counts in usual-routine-telegram.test.ts are that idempotence's guard.
async function sweepAfterTap(profileIds: readonly number[]): Promise<void> {
  // ONE budget for the whole call, not one per profile: the caller is holding the
  // webhook's connection open, and the error path above can hand this several
  // profiles. Sharing the deadline is what keeps the bound a property of the RESPONSE
  // rather than of each profile.
  const until = Date.now() + TAP_SWEEP_BUDGET_MS;
  for (const profileId of profileIds) {
    try {
      const rc = await reconcileProfileMessages(
        profileId,
        Math.max(0, until - Date.now())
      );
      if (
        rc.edited > 0 ||
        rc.closed > 0 ||
        rc.dropped > 0 ||
        rc.deferred > 0 ||
        rc.failed > 0 ||
        rc.unswept > 0
      ) {
        log.info("messages reconciled after tap", {
          profile: profileId,
          ...rc,
        });
      }
    } catch (e) {
      log.info("tap reconcile failed (ignored)", {
        profile: profileId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

async function dispatchTap(cq: TelegramCallbackQuery): Promise<TapWrote> {
  // "✅ All (N)" — mark every pending dose in the session's window taken.
  const all = parseAllCallback(cq.data);
  if (all) {
    return handleAllTaken(cq, all);
  }

  // "✅ <Stack> (n)" — mark one stack's still-pending doses taken (#3098).
  const stackTake = parseOfferCallback(cq.data, "stacktake");
  if (stackTake) {
    return handleStackTaken(cq, stackTake);
  }

  // "✅ Your usual <window> (n)" — the composed one-tap (#2460). The token names a
  // STORED offer; the handler re-derives what stands and writes only the intersection.
  const usual = parseOfferCallback(cq.data, "usual");
  if (usual) {
    return handleUsualRoutineTap(cq, usual);
  }

  // A dose tap is either ✅ take or ⏭️ skip (#232); both carry the same token
  // shape and share the rebuild path, differing only in which write they apply
  // and how they answer.
  const take = parseTakeCallback(cq.data);
  if (take) {
    return handleDoseTap(cq, take, "take");
  }
  const skip = parseSkipCallback(cq.data);
  if (skip) {
    return handleDoseTap(cq, skip, "skip");
  }

  // Phase 1 (#233): preventive-nudge buttons (✅ Done / 🚫 Not applicable /
  // ⏰ Remind later).
  const preventive = parsePreventiveCallback(cq.data);
  if (preventive) {
    return handlePreventiveTap(cq, preventive);
  }

  // Phase 3 (#233): refill-nudge "📦 Ordered — remind me in 3 days".
  const refill = parseRefillCallback(cq.data);
  if (refill) {
    return handleRefillTap(cq, refill);
  }

  // Phase 2 (#233): missed-dose escalation (✅ Confirmed taken / 👍 I'm on it).
  const escalation = parseEscalationCallback(cq.data);
  if (escalation) {
    return handleEscalationTap(cq, escalation);
  }

  // Household dose round (#1459): a caregiver's cross-profile confirm. Parsed BEFORE
  // the generic paths because its token names two profiles and resolves its own
  // access edge (chat → receiving profile → member write grant), not the shared
  // chat→profile resolution a single-subject tap uses.
  const household = parseHouseholdDoseCallback(cq.data);
  if (household) {
    return handleHouseholdDoseTap(cq, household);
  }

  // Stale-workout nudge (#1205): 🏁 Finish workout / 🗑️ Discard — resolve a quiet
  // live draft in place through the shared finish/discard cores.
  const workoutFinish = parseWorkoutFinishCallback(cq.data);
  if (workoutFinish) {
    return handleWorkoutFinishTap(cq, workoutFinish);
  }

  // The post-workout TYPE ask (#2272): the source recorded a workout but declined to
  // say what kind, so the recap that was already going out asked. The tap is the write.
  const typeAsk = parseActivityTypeAskCallback(cq.data);
  if (typeAsk) {
    return handleActivityTypeAskTap(cq, typeAsk);
  }

  // Food logging (#682): a quick-log button logs one serving of a group; the
  // first-connection opt-in prompt flips the per-profile food-logging flag.
  const foodLog = parseFoodLogCallback(cq.data);
  if (foodLog) {
    return handleFoodLog(cq, foodLog);
  }
  // Protein "+Xg" quick-log (#1073): the reserved pseudo-group button logs grams via
  // addProteinGramsCore (writing the __protein__ ranking event too), then rebuilds the nudge.
  const foodProtein = parseFoodProteinCallback(cq.data);
  if (foodProtein) {
    return handleFoodProtein(cq, foodProtein);
  }
  // "➕ Show more" (#1075) / "➖ Show less" (#1807): page the ranked buttons up or down in
  // place — a stateless view change, answered quietly.
  const foodExpand = parseFoodExpandCallback(cq.data);
  if (foodExpand) {
    return handleFoodExpand(cq, foodExpand);
  }
  const foodOptIn = parseFoodOptInCallback(cq.data);
  if (foodOptIn) {
    return handleFoodOptIn(cq, foodOptIn);
  }
  // Eating-time correction (#2019): a −Nh chip, or the 🕐 absolute-hour drill-down.
  // Both ride the food nudge's own keyboard and re-stamp `occurred_at` for a whole burst.
  const foodTimeChip = parseCorrectionChipToken(
    cq.data,
    FOOD_TIME_PREFIXES.chip
  );
  if (foodTimeChip) {
    return handleFoodTimeChip(cq, foodTimeChip);
  }
  const foodTimeAt = parseCorrectionAtToken(cq.data, FOOD_TIME_PREFIXES.at);
  if (foodTimeAt) {
    return handleFoodTimeAt(cq, foodTimeAt);
  }
  // The dose twin (#2020), over `recorded_at` — the safety-relevant one, because the PRN
  // redose window arms off exactly the instant these buttons correct.
  const doseTimeChip = parseCorrectionChipToken(
    cq.data,
    DOSE_TIME_PREFIXES.chip
  );
  if (doseTimeChip) {
    return handleDoseTimeChip(cq, doseTimeChip);
  }
  const doseTimeAt = parseCorrectionAtToken(cq.data, DOSE_TIME_PREFIXES.at);
  if (doseTimeAt) {
    return handleDoseTimeAt(cq, doseTimeAt);
  }
  // The practice twin (#2875), over `practice_logs.start_time` — the one whose column feeds
  // the scheduler that produced the tap: `modalHour()` reads it to pick each practice's
  // typical hour, and #2188's retimed pace nudge fires at that hour, so an uncorrectable
  // late acknowledgement compounds into a later and later nudge.
  const practiceTimeChip = parseCorrectionChipToken(
    cq.data,
    PRACTICE_TIME_PREFIXES.chip
  );
  if (practiceTimeChip) {
    return handlePracticeTimeChip(cq, practiceTimeChip);
  }
  const practiceTimeAt = parseCorrectionAtToken(
    cq.data,
    PRACTICE_TIME_PREFIXES.at
  );
  if (practiceTimeAt) {
    return handlePracticeTimeAt(cq, practiceTimeAt);
  }

  // ⤓ May (#1505 part 2): accept the demotion suggestion riding this reminder. The
  // one obligation write the notification layer can make — user-initiated, downward,
  // and through the same compare-and-swap core the in-app card uses.
  const demote = parseDemoteCallback(cq.data);
  if (demote) {
    return handleDemoteTap(cq, demote);
  }

  // Stop (#2574): end an unconfirmed imported medication from the reminder that is
  // interrupting about it. Its own token namespace, parsed beside the demotion tap
  // because they ride the same row and are complements on `kind` — never both present,
  // and never mistakable for one another.
  const medStop = parseMedStopCallback(cq.data);
  if (medStop) {
    return handleMedStopTap(cq, medStop);
  }

  // The digest's offer tail (#1505): expand/collapse the "➕ Doses" button in
  // place. Checked BEFORE the prn: log tokens because the expanded keyboard is made
  // of those, and a tail tap must never be mistaken for a log.
  const offerTail = parseOfferTailCallback(cq.data);
  if (offerTail) {
    return handleOfferTailTap(cq, offerTail);
  }

  // The digest's ⚙️ Tune control (#1714): expand/collapse the per-category toggles in
  // place, or flip one category's demotion. Parsed here — before the log tokens —
  // for the same reason the offer tail is: an expanded Tune keyboard is made of
  // `tunet:` buttons and a tune tap must never be mistaken for anything that writes
  // to the profile's records.
  const tune = parseTuneCallback(cq.data);
  if (tune) {
    return handleTuneTap(cq, tune);
  }

  // The digest time suggestion's exits (#2217): Use HH:MM / As soon as it's ready /
  // Not now. Parsed alongside the other digest-riding controls, and before the log
  // tokens, for the same reason they are: these buttons write a SETTING, and a tap on
  // one must never be mistaken for anything that writes to the profile's records.
  const digestTime = parseDigestTimeCallback(cq.data);
  if (digestTime) {
    return handleDigestTimeTap(cq, digestTime);
  }

  // One administration-armed redose window. Parsed before the reusable `/dose` token:
  // this button is consumed and refuses after an app log supersedes its window.
  const redose = parseRedoseLogCallback(cq.data);
  if (redose) {
    return handleRedoseLogTap(cq, redose);
  }

  // PRN administration logging (#797): a "💊 <med>" button from the /dose command
  // logs one as-needed administration NOW.
  const prn = parsePrnLogCallback(cq.data);
  if (prn) {
    return handlePrnLogTap(cq, prn);
  }

  // Wellness-practice "Done ✅" (#1259): a button from the pace-aware practice nudge
  // logs one session NOW for the target's practice, and is consumed on tap.
  const practiceDone = parsePracticeDoneCallback(cq.data);
  if (practiceDone) {
    return handlePracticeDoneTap(cq, practiceDone);
  }

  // The same tap from the on-demand `/practice` list (#1895). A different PREFIX,
  // because the two messages claim different things to the sweep (see callback-data),
  // and deliberately the SAME handler and write core — a second logging path for one
  // button is how two answers to "did that log?" come about.
  const practiceLog = parsePracticeLogCallback(cq.data);
  if (practiceLog) {
    return handlePracticeDoneTap(cq, practiceLog);
  }

  // Right-sizing ride-along (#1670): the same practice nudge's ⤓ button lowers the
  // weekly floor to the cadence actually kept — the floor is re-derived from the live
  // detector on tap, never read off the button.
  const rightSize = parseRightSizeLowerCallback(cq.data);
  if (rightSize) {
    return handleRightSizeLowerTap(cq, rightSize);
  }

  // Daily mood check-in (#992): a face button logs the day's mood — the same
  // idempotent per-day upsert the dashboard card and offline replay run.
  const moodTap = parseMoodCheckinCallback(cq.data);
  if (moodTap) {
    return handleMoodTap(cq, moodTap);
  }

  // "Keep daily check-ins" (#1668): the confirm-to-KEEP affordance the final reminder
  // carries before the auto-pause takes effect.
  const moodKeep = parseMoodKeepCallback(cq.data);
  if (moodKeep) {
    return handleMoodKeepTap(cq, moodKeep);
  }

  // Symptom quick-log (#859 item 5): a "<symptom>" button opens a severity picker;
  // a severity button logs the symptom-day.
  const symPick = parseSymptomPickCallback(cq.data);
  if (symPick) {
    return handleSymptomPick(cq, symPick);
  }
  const symSev = parseSymptomSeverityCallback(cq.data);
  if (symSev) {
    return handleSymptomSeverity(cq, symSev);
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
): Promise<TapWrote> {
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
  // A rule the catalog no longer knows wrote nothing; the other three arms each
  // recorded one (a done, an override, a snooze).
  return outcome.kind === "unknown-rule" ? undefined : profileId;
}

// Apply a refill tap: verify the item is still the profile's (a forged id →
// stale-item, nothing written), else snooze its `refill:<id>` finding on the
// shared bus (#227), the same fact a page snooze writes.
function applyRefillTap(
  profileId: number,
  rf: RefillCallback
): RefillTapOutcome {
  if (!intakeItemExists(profileId, rf.itemId)) return "stale-item";
  snoozeFinding(
    profileId,
    refillSignalKey(rf.itemId),
    shiftDateStr(today(profileId), REFILL_SNOOZE_DAYS)
  );
  return "snoozed";
}

// Handle a refill-nudge "📦 Ordered" tap. Same profile resolution + row-consume
// discipline as the preventive handler.
async function handleRefillTap(
  cq: TelegramCallbackQuery,
  rf: RefillCallback
): Promise<TapWrote> {
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
  return outcome === "snoozed" ? profileId : undefined;
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
): Promise<TapWrote> {
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
  // from the token's item id — otherwise a token could pair supplement X's escalate
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
      esc.itemId,
      esc.date,
      NUDGE
    );
    await answerCallbackQuery(cq.id, tapSkipAnswerText(outcome), {
      alert: tapAnswerNeedsDismissal(outcome, "skip"),
    });
    await replaceMessage(profileId, cq, escalationSkipCloseText(outcome));
    return outcome === "skipped" ? profileId : undefined;
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
    const outcome = markDoseTaken(
      profileId,
      esc.doseId,
      esc.itemId,
      esc.date,
      NUDGE
    );
    await answerCallbackQuery(
      cq.id,
      tapAnswerText(outcome, offDayCadence(profileId, esc.doseId, outcome)),
      { alert: tapAnswerNeedsDismissal(outcome, "take") }
    );
    await replaceMessage(profileId, cq, escalationTakeCloseText(outcome));
    return usualRoutineDoseLogged(outcome) ? profileId : undefined;
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
  // Only a real ack wrote the per-episode marker; every other state answered honestly
  // and recorded nothing.
  return ack === "acknowledged" ? profileId : undefined;
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
): Promise<TapWrote> {
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
    return outcome.kind === "discarded" ? profileId : undefined;
  }

  const outcome = finishWorkoutSession(profileId, token.activityId);
  await answerCallbackQuery(cq.id, workoutFinishAnswerText(outcome));
  // Only a REAL finish transforms the message + suppresses the separate dispatch. An
  // already-finished re-tap is a no-op (no re-edit surprise); an empty draft keeps its
  // Finish/Discard buttons so the user can Discard; a not-found is left as-is.
  if (outcome.kind !== "finished") return;
  if (chatId == null || messageId == null) return profileId;

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
  return profileId;
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
): Promise<TapWrote> {
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
  return outcome.kind === "classified" ? profileId : undefined;
}

// Apply a single ✅ take or ⏭️ skip tap: resolve the acting profile from the chat,
// run the verified write, answer honestly from the outcome union, then rebuild
// the session message so resolved doses drop their buttons.
// Re-render a dose session onto the message that carried it. Every dose-tier rebuild
// goes through here — take, skip, ✅ All, a stack tap, the composed one-tap — so they
// cannot drift: correction chips ride along (#2020) and `rebuildMessage` re-applies the
// send-time "[Name] " prefix (#377/#454) a handler rendering its own text would lose.
async function rebuildDoseSession(
  profileId: number,
  chatId: number | string,
  messageId: number,
  parts: IntakeSlotPart[],
  date: string
): Promise<void> {
  await rebuildMessage(
    profileId,
    chatId,
    messageId,
    withDoseCorrections(profileId, renderDoseSession(profileId, parts, date), {
      ref: { chatId, messageId },
    })
  );
}

async function handleDoseTap(
  cq: TelegramCallbackQuery,
  tap: TakeCallback,
  kind: "take" | "skip"
): Promise<TapWrote> {
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

  // markDoseTaken/markDoseSkipped independently verify the dose → item →
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
          tap.itemId,
          tap.date,
          NUDGE,
          undefined,
          chatId != null && messageId != null
            ? messagePointerIdAt(profileId, chatId, messageId)
            : null
        )
      : markDoseSkipped(profileId, tap.doseId, tap.itemId, tap.date, NUDGE);
  // A dose ALREADY resolved (#280) moved nothing, and neither did a stale or inactive
  // one — only these three outcomes wrote a row.
  const wrote =
    usualRoutineDoseLogged(outcome) || outcome === "skipped"
      ? profileId
      : undefined;
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
  if (chatId == null || messageId == null || rows.length === 0) return wrote;

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
    await rebuildDoseSession(profileId, chatId, messageId, parts, tap.date);
    return wrote;
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
  return wrote;
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
): Promise<TapWrote> {
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
    tap.date,
    NUDGE
  );
  await answerCallbackQuery(
    cq.id,
    householdTapAnswerText(
      householdMemberLabel(tap.receiverProfileId, tap.memberProfileId),
      outcome
    )
  );

  // THE MEMBER'S LEDGER MOVED, not the receiver's, so the member is who the sweep is
  // for: their own chat is where a sibling nudge is now offering a dose that stands
  // logged. This message belongs to the receiver and is left to its own rebuild below.
  const wrote = usualRoutineDoseLogged(outcome)
    ? tap.memberProfileId
    : undefined;

  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  const messageId = cq.message?.message_id;
  if (messageId == null || rows.length === 0) return wrote;
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
  return wrote;
}

// Mark every pending dose in the tapped session's window taken in one tap. The
// window + date are baked into the token, so a late tap still logs to the right
// day. Profile resolution and the per-dose verification mirror a single "taken"
// tap (markDoseTaken re-checks each dose → supplement → profile chain and is
// idempotent, so a dose already logged individually is a safe no-op).
async function handleAllTaken(
  cq: TelegramCallbackQuery,
  all: AllCallback
): Promise<TapWrote> {
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

  // The slot's doses are re-collected from CURRENT state (active, non-retired) for
  // the message's OWN day — `all.date`, which on a late tap may be a day or two back,
  // never assumed to be today (#3973). So this tolerates schedule edits made after the
  // message was sent, and what this bulk tap WRITES matches what the message listed.
  // Floor-filtered (#1156): "✅ All" marks only the doses the reminder actually
  // listed — a `may` supplement the send excluded is never silently logged by a
  // bulk tap. Count only real inserts; when the whole slot
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
        e.item.id,
        all.date,
        NUDGE,
        undefined,
        notifyMessageId
      ) === "logged"
    ) {
      logged++;
    }
  }
  // Every resolved dose was deliberately skipped (#232): a skip is a recorded
  // refusal, not a log, so the answer must not read "Already logged" (#3120).
  const allSkipped = entries.length > 0 && entries.every((e) => e.skipped);
  await answerCallbackQuery(
    cq.id,
    entries.length === 0
      ? STALE_TOKEN_REFUSAL
      : logged > 0
        ? `All logged ${GLYPH.done}`
        : allSkipped
          ? BULK_ALL_SKIPPED_TEXT
          : // Everything due was already resolved (e.g. two caregivers race-tapping
            // ✅ All) — nothing was inserted, so don't claim "Logged ✅" (#280
            // outcome-honesty; #380).
            `Already logged ${GLYPH.done}`,
    // The arms that contradict the button demand a dismissal: an empty slot, and a
    // fully-skipped set — "skipped" is not the state ✅ All asked for, and the reader
    // has to know nothing was taken. "Already logged" IS that state, reached by
    // someone else, so it stays a glance.
    { alert: entries.length === 0 || allSkipped }
  );

  const wrote = logged > 0 ? profileId : undefined;
  const messageId = cq.message?.message_id;
  if (chatId == null || messageId == null) return wrote;

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
    return wrote;
  }
  await rebuildDoseSession(profileId, chatId, messageId, parts, all.date);
  return wrote;
}

// Mark one STACK's still-pending doses taken in one tap (#3098). The token names a
// STORED offer (#3282) whose dose ids are an UPPER BOUND, exactly the parseAllCallback
// → handler posture one button over: the pending, notifiable set is re-derived fresh
// from current state and the write is the INTERSECTION of that set with the ids the
// offer named — so a stale, forged, or replayed token cannot write outside what
// currently stands. Another profile's dose id or a retired dose is not in the
// re-derived set (and markDoseTaken independently re-verifies the dose → item →
// profile chain besides); a dose meanwhile resolved is left alone; a second tap finds
// an empty intersection and answers nothing-to-log rather than confirming.
//
// NO DATE CROSSES THE WIRE, AND THE DAY IS STILL THE SESSION'S — it comes off the
// stored offer, gated by the predicate `markDoseTaken` applies (see
// `standingStackOffer`), so this path can neither backfill nor die at midnight.
async function handleStackTaken(
  cq: TelegramCallbackQuery,
  token: OfferCallback
): Promise<TapWrote> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT, {
      alert: true,
    });
    return;
  }
  const offer = standingStackOffer(profileId, token.offerId, today(profileId));
  if (!offer) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT, { alert: true });
    return;
  }
  const { doseIds: offered, date } = offer;

  // Re-derive the day's notifiable dose session from CURRENT state, across every
  // send slot — the offer deliberately carries no slot, and a dose lives in exactly
  // one slot, so the union is the same floored set the slot sends listed.
  // Floor-filtered (#1156) like the All tap: a `may` supplement the send excluded is
  // never logged by a bulk tap.
  const listed = new Set(offered);
  const current = INTAKE_SEND_SLOTS.flatMap((slot) =>
    notifiableWindowDoses(collectWindowDoses(profileId, slot, date))
  ).filter((e) => listed.has(e.dose.id));
  const messageId = cq.message?.message_id;
  const notifyMessageId =
    chatId != null && messageId != null
      ? messagePointerIdAt(profileId, chatId, messageId)
      : null;
  let logged = 0;
  let alreadyResolved = 0;
  for (const e of current) {
    // A resolved dose (taken, or deliberately skipped — #232) is left alone.
    if (e.taken || e.skipped) {
      alreadyResolved++;
      continue;
    }
    if (
      markDoseTaken(
        profileId,
        e.dose.id,
        e.item.id,
        date,
        NUDGE,
        undefined,
        notifyMessageId
      ) === "logged"
    ) {
      logged++;
    }
  }
  // Every resolved dose was deliberately skipped (#232): a skip is a recorded
  // refusal, not a log, so the answer must not read "Already logged" (#3120).
  const allSkipped = current.length > 0 && current.every((e) => e.skipped);
  await answerCallbackQuery(
    cq.id,
    current.length === 0
      ? STALE_TOKEN_REFUSAL
      : logged > 0
        ? `Logged ${GLYPH.done}`
        : allSkipped
          ? BULK_ALL_SKIPPED_TEXT
          : alreadyResolved > 0
            ? // Everything the button named is already resolved (a race, or a second
              // tap) — nothing was inserted, so don't claim a fresh log (#280).
              `Already logged ${GLYPH.done}`
            : STALE_TOKEN_REFUSAL,
    // The arms that contradict the button demand a dismissal — a fully-skipped set
    // included: "skipped" is not the state the ✅ asked for, and the reader has to
    // know nothing was taken.
    { alert: (logged === 0 && alreadyResolved === 0) || allSkipped }
  );

  const wrote = logged > 0 ? profileId : undefined;
  if (chatId == null || messageId == null) return wrote;

  // Rebuild from current state through the same path every dose tap uses, so the
  // stack's rows show as taken (and the message collapses to the completion
  // summary once nothing is pending).
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  const footprint = keyboardDoseFootprint(rows);
  const parts = slotSessionForKeyboard(
    profileId,
    [...footprint.doseIds, ...offered],
    footprint.slots,
    date
  );
  if (parts.length === 0) {
    if (rows.length === 0) return wrote;
    await closeMessage(
      profileId,
      chatId,
      messageId,
      replacementWithTitle(cq.message?.text, OUTDATED_MESSAGE_TEXT)
    );
    return wrote;
  }
  await rebuildDoseSession(profileId, chatId, messageId, parts, date);
  return wrote;
}

// THE COMPOSED ONE-TAP (#2460): one button, the whole morning — the habitual food
// groups AND the doses declared for the window and still owed today, through the
// shared write core the dashboard control uses (`logUsualRoutineCore`, #2458).
//
// ── NOTHING ON THE WIRE IS TRUSTED ───────────────────────────────────────────
//
// The token carries a profile id (a cross-check, like every other tap token) and an
// OFFER ID. The offer row is read scoped by the CHAT-RESOLVED profile and by family, so
// another profile's offer and another family's payload are the same single refusal, and
// neither can be told apart by a forged token.
//
// ── THE DAY IS THE OFFER'S OWN, NOT `today` (#4118) ──────────────────────────
//
// This read used to demand `row.date === today(profileId)`, which deleted the button at
// midnight while the ✅ dose buttons on the SAME message kept working — the owner's
// "I can only update the morning supplement times, not food". Now the offer's minted day
// is gated by `isDoseDateAccepted`, exactly as `standingStackOffer` gates the `stacktake:`
// button beside it, and that day is what the write, the answer and the rebuild all use.
// Still no date on the wire: it comes off the stored row, which only this app writes.
//
// ── AND THE OFFER IS AN UPPER BOUND, NOT AN INSTRUCTION ──────────────────────
//
// The stored sets are handed to the core exactly as the dashboard hands it the sets
// its label named, and the core re-derives BOTH halves from fresh state inside its own
// transaction and writes only the intersection. A replayed tap therefore writes
// nothing the offer did not name AND nothing that no longer stands — strictly stronger
// than the `all:` button one row down, which re-derives but was never bounded by an
// offer at all.
//
// ── THE ANSWER NAMES WHAT WAS WRITTEN, NEVER WHAT WAS OFFERED ────────────────
//
// Every half is reported from the core's RETURN: a group the offer had already lost is
// simply absent, and a dose that refused mid-bundle is named as not logged rather than
// folded into a count — with the food set it did not unwind still committed. That is
// the acceptance bar of this issue, and it is `usualRoutineAnswerText`'s contract, so
// the toast on the dashboard and this ack cannot round the same outcome differently.
async function handleUsualRoutineTap(
  cq: TelegramCallbackQuery,
  token: OfferCallback
): Promise<TapWrote> {
  // Narrowed to a string ONCE: the rebuilds below and the audit's binding lookup are
  // the same chat, and `String(...)` at each site is how they drift apart.
  const chatId =
    cq.message?.chat?.id == null ? null : String(cq.message.chat.id);
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(chatId))
      : null;
  if (profileId == null || chatId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT, { alert: true });
    return;
  }
  const t = today(profileId);
  const row = readOfferRow<StoredUsualOffer>(
    profileId,
    USUAL_OFFER_FAMILY,
    token.offerId
  );
  if (!row || !isDoseDateAccepted(t, row.date)) {
    // Forged, another profile's, or minted further back than the window reaches. The
    // honest refusal, and nothing is written — day 3+ still answers the outdated text.
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT, { alert: true });
    return;
  }
  const { payload: offer, date } = row;
  const messageId = cq.message?.message_id;
  const notifyMessageId =
    messageId != null ? messagePointerIdAt(profileId, chatId, messageId) : null;
  // THIS TAP STATES NO EATING TIME, AND #4438 ITEM 3 ASKED IT TO — LEFT UNDONE ON
  // PURPOSE, because doing it moves the servings out of the window the button promised.
  //
  // The sibling `food:` and protein buttons on this keyboard do stamp
  // `{ eatenAt: tapAt, source: "tap" }`, and item 3 asks for parity. But their label
  // names a GROUP; this one names a WINDOW — "Your usual Morning" — and
  // `logFoodServingCore`'s one chokepoint (#2269) stores no `meal_slot` beside a stated
  // instant and derives the window FROM it. Measured on the DB tier, whose clock sits at
  // 23:45: a Morning bundle tapped then wrote both servings into EVENING, the Morning
  // offer still stood afterwards, and the label had promised something the ledger did
  // not hold. In production that is hour-of-day dependent — right for a nudge tapped
  // inside its own window, wrong for one tapped late.
  //
  // Which way that resolves is an owner question (does the bundle's window follow the
  // tap, or does the bundle keep stating no hour?), not a lane's, so the WEB half of
  // item 3 landed — the bar's sticky statement, where the person names the time and the
  // surface says out loud which window it lands in — and this half waits for the ruling.
  const outcome = logUsualRoutineCore(
    profileId,
    offer.window,
    date,
    offer.groups,
    offer.doseIds,
    NUDGE,
    notifyMessageId,
    // The grams THIS MESSAGE promised (#4379) — the stored offer's, not the preset as it
    // stands now, so a scoop changed since the send does not move a promise already read.
    offer.proteinGrams ?? undefined
  );
  // THE DATED-WRITE TRAIL HAS NO HOLE ON THE MOST-USED SURFACE (#4306, owner ruling
  // 2026-08-31). A backfill from a nudge writes the rows the web backfill writes, so it
  // writes the same audit row. The ACTOR comes off the chat binding, which is already
  // what decided which profile this tap may write — naming it in the log is that same
  // trust made explicit, and nothing else about the profile/login split moves.
  recordUsualBackfillAudit(
    loginIdForTelegramChatProfile(chatId, profileId),
    profileId,
    outcome,
    t
  );
  const wrote = outcome.kind === "logged";
  await answerCallbackQuery(
    cq.id,
    // ONE ANSWER FOR EVERY HOST OF THIS BUNDLE (#4438 item 5, #4379). This ack used to
    // build its own sentence from `outcome.groups` alone, which made it the one host
    // that could not name the protein member — and in one reachable composition it said
    // "Nothing left to log" over a write. The stored offer names the SAME members the
    // line and the label promised, and the helper reports only what the core says landed.
    wrote
      ? usualRoutineWriteAnswer(
          // `proteinGrams` is optional on the STORED shape — a row minted before #4379
          // simply has no field — and absent means the same as null here: that send
          // promised no scoop, so its ack may not name one.
          usualRoutineFoodMembers(
            { groups: offer.groups, proteinGrams: offer.proteinGrams ?? null },
            foodGroupName
          ),
          outcome
        )
      : usualRoutineAnswerText([], [], []),
    // An outcome that contradicts the ✅ demands a dismissal; a partial does not —
    // it says what landed, and what landed is on the screen behind it.
    { alert: !wrote }
  );

  // THE CASE THIS ISSUE WAS FILED FROM (#3933). `usual:` is host-inherited: one offer
  // rendered into the window's dose reminder AND its food nudge. The rebuild below
  // fixes whichever host was tapped; the sweep the dispatcher runs on this answer is
  // what fixes the other one, in the same request cycle.
  const swept = wrote ? profileId : undefined;
  if (messageId == null) return swept;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (rows.length === 0) return swept;
  // WHICH MESSAGE THIS IS, asked of the keyboard rather than of the token — the whole
  // point of the host-inherited classification (#2460). `usual:` elects no family, so
  // `owningFamily` answers with the HOST's, and the rebuild runs the host's own path.
  // Each rebuild goes through `rebuildMessage`, which re-applies the bundle reduced to
  // what still stands (usually: gone, since the tap just wrote it).
  const family = owningFamily(keyboardTokens(rows), tokenPrefix);
  if (family === "intake-dose") {
    const footprint = keyboardDoseFootprint(rows);
    const parts = slotSessionForKeyboard(
      profileId,
      footprint.doseIds,
      footprint.slots,
      date
    );
    if (parts.length === 0) {
      await closeMessage(
        profileId,
        chatId,
        messageId,
        replacementWithTitle(cq.message?.text, OUTDATED_MESSAGE_TEXT)
      );
      return swept;
    }
    await rebuildDoseSession(profileId, chatId, messageId, parts, date);
    return swept;
  }
  if (family === "food") {
    // EVERY REBUILD PRESERVES THE ORIGIN (#3087) — read off the live keyboard, which
    // is the only record of which builder call minted this message.
    const rebuilt = withChatOrigin(
      buildFoodNudge(
        profileId,
        offer.window,
        date,
        countVisibleFoodButtons(rows) || undefined,
        { ref: { chatId, messageId } }
      ),
      keyboardChatOrigin(rows)
    );
    if (rebuilt) await rebuildMessage(profileId, chatId, messageId, rebuilt);
  }
  return swept;
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
): Promise<TapWrote> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(food, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  // The cross-date guard (#947, widened by #4118): the token carries its SEND date, and
  // a keyboard from a previous day can survive (the close-previous strip failed, or the
  // bot restarted between sends). Inside the message-date window the tap is honoured ON
  // THE MESSAGE'S OWN DAY, exactly as the ✅ dose buttons on the same message are;
  // outside it nothing is written and the refusal says so (#232).
  const dateGuard = foodTapDateGuard(food.date, today(profileId));
  if (dateGuard.kind === "stale-date") {
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
  //
  // ON A RECENT-DAY TAP THE INSTANT IS NOT A MEASUREMENT ANY MORE, and that is the one
  // thing the widening had to get right. "I'm eating NOW" is false about a day that has
  // already ended, so the tap instant is NOT written as an eating time there; the row
  // takes the nudge's own window as a declared `meal_slot` and a NULL `occurred_at` —
  // the same "no time was stated" shape the usual bundle and the `/history` door write.
  // Stamping `now` would have produced a row whose day and whose eating instant
  // contradict each other, and `foodSlotForProfileEvent` would then have filed a
  // breakfast under whatever window the tap happened to land in.
  const backfilling = dateGuard.kind === "recent-day";
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
    // NOT the module-level NUDGE (#3087) — the token carries which keyboard minted the
    // button, because `/food` re-renders the same builder the tick sends and the two are
    // otherwise indistinguishable here.
    //
    // …EXCEPT ON A BACKFILL, WHERE THE DAY OUTRANKS THE SURFACE (#4118). A tap onto a
    // day that has ended is evidence of nothing: `getFoodRegularity` excludes exactly
    // `usual-backfill`, and stamping the surface here would let these buttons
    // manufacture the very habit the `usual:` bundle one row up is derived from —
    // backfill two mornings from a stale keyboard and the third is offered because of
    // them. The core makes the same substitution from the same comparison; this path
    // does not go through it, so it makes it here. A same-day tap is untouched.
    backfilling ? USUAL_BACKFILL : food.origin,
    tapAt,
    // A backfill DECLARES the nudge's window; a same-day tap STATES its instant. One
    // argument says which (#4729); the two ternaries it replaces were a caller
    // remembering that only one of them may be filled in.
    backfilling ? food.window : { eatenAt: tapAt, source: "tap" },
    origin
  );
  await answerCallbackQuery(
    cq.id,
    foodLogAnswerText(outcome, food.group, backfilling ? food.date : undefined)
  );
  const wrote = outcome.kind === "logged" ? profileId : undefined;

  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  // Only rebuild when the message actually had buttons — an absent keyboard would
  // otherwise wrongly overwrite the message text.
  if (chatId == null || messageId == null || rows.length === 0) return wrote;
  // Re-render the whole nudge from current state (same builder as the send, so the
  // ranking + tally stay one computation) and edit in place through the chokepoint,
  // which re-applies the "[Name] " prefix for a shared chat. Preserve the current
  // expansion (#1075): rebuild at the visible count read off the keyboard, so a tap after
  // "Show more" keeps the expanded window rather than collapsing to the compact default.
  const visibleCount = countVisibleFoodButtons(rows) || undefined;
  // The re-render carries the origin forward, or the SECOND tap on a `/food` list
  // would report a nudge (#3087).
  const rebuilt = withChatOrigin(
    buildFoodNudge(profileId, food.window, food.date, visibleCount, {
      ref: { chatId, messageId },
    }),
    food.origin
  );
  if (rebuilt) await rebuildMessage(profileId, chatId, messageId, rebuilt);
  return wrote;
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
): Promise<TapWrote> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const dateGuard = foodTapDateGuard(token.date, today(profileId));
  if (dateGuard.kind === "stale-date") {
    await answerCallbackQuery(cq.id, foodStaleDateAnswerText(token.date));
    return;
  }
  // Same rule as its food-group neighbour sixty lines up (#4118): inside the window the
  // grams land on the MESSAGE'S day, and no eating instant is invented for a day that
  // has ended. The nudge's window still rides along as the asserted slot — that is what
  // `mealSlot` on this core has always been for (#1704).
  const backfilling = dateGuard.kind === "recent-day";
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
    // Same axis, same token marker as the food-group button beside it (#3087), and the
    // same backfill substitution for the same reason (#4118): `__protein__` rides
    // `food_log_events`, so a backfilled shake is a row the regularity read would
    // otherwise count as evidence about a day nobody was living.
    backfilling ? USUAL_BACKFILL : token.origin,
    tapAt,
    // The same one placement its food-group sibling above passes (#4729).
    backfilling ? token.window : { eatenAt: tapAt, source: "tap" },
    origin
  );
  await answerCallbackQuery(
    cq.id,
    foodProteinAnswerText(
      outcome,
      token.grams,
      backfilling ? token.date : undefined
    )
  );
  const wrote = outcome.kind === "logged" ? profileId : undefined;

  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (chatId == null || messageId == null || rows.length === 0) return wrote;
  const visibleCount = countVisibleFoodButtons(rows) || undefined;
  // The re-render carries the origin forward, exactly as the food-group tap sixty
  // lines above does (#3087). Without it ONE "+30 g" tap rewrites all seven buttons
  // UNMARKED, `keyboardChatOrigin` answers null for that keyboard for ever, the hourly
  // sweep re-renders it unmarked too, and every later tap on the message records
  // `telegram-nudge` — a permanent, one-directional inflation of the nudge count on
  // the exact axis this column exists to measure.
  const rebuilt = withChatOrigin(
    buildFoodNudge(profileId, token.window, token.date, visibleCount, {
      ref: { chatId, messageId },
    }),
    token.origin
  );
  if (rebuilt) await rebuildMessage(profileId, chatId, messageId, rebuilt);
  return wrote;
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
): Promise<TapWrote> {
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
  if (foodTapDateGuard(token.date, today(profileId)).kind === "stale-date") {
    await answerCallbackQuery(cq.id, foodStaleDateAnswerText(token.date));
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
  const rebuilt = withChatOrigin(
    buildFoodNudge(profileId, token.window, token.date, next, {
      ref: { chatId, messageId },
    }),
    keyboardChatOrigin(rows)
  );
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
): Promise<TapWrote> {
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
  // The flag flip changes what a live food nudge may claim, so it earns a sweep.
  return profileId;
}
