// Handles an inbound Telegram button tap ("✅ {name}") regardless of transport:
// the webhook route and the getUpdates poller both delegate here, so both paths
// get identical profile-scoping and verification.

import crypto from "node:crypto";
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
  getPrnMedicationsForQuickLog,
  getIntakeItemName,
} from "../queries";
import { today } from "../db";
import { shiftDateStr } from "../date";
import {
  getProfilesByTelegramChatId,
  getProfileTelegram,
  setProfileSetting,
  setProfileFoodTelegram,
  setFoodTelegramPrompted,
  getUserAge,
} from "../settings";
import { getProfileNameById } from "../profile-summary-load";
import { administrationOutcomeText } from "../administration-format";
import { logFoodServingCore } from "../food-log-write";
import { logSymptomCore } from "../symptom-log-write";
import { logTemperatureCore } from "../temperature-log";
import { getSymptomLogOrder, getCustomSymptomNames } from "../queries";
import { symptomLabel, symptomSlugs, SYMPTOMS } from "../symptoms";
import { currentEpisodeForProfile } from "../illness-episode";
import { isTaskConfigured } from "../ai-resolve";
import { mapSymptomText } from "../symptom-text-map";
import { profileAgeMonths } from "../settings";
import { inlineTempRedFlagNote } from "../temp-red-flag";
import { fmtTemp } from "../units";
import { preventiveRuleByKey } from "../preventive-catalog";
import { preventiveSignalKey } from "../preventive-upcoming";
import { refillSignalKey } from "../refill-nudge";
import { escalationMarkerKey } from "./escalate";
import {
  type AllCallback,
  type EscalationCallback,
  type FoodLogCallback,
  type FoodOptInCallback,
  type PreventiveCallback,
  type PreventiveTapOutcome,
  type RefillCallback,
  type RefillTapOutcome,
  type TakeCallback,
  OUTDATED_MESSAGE_TEXT,
  escalationAckAnswerText,
  escalationAckCloseText,
  escalationTakeCloseText,
  foodLogAnswerText,
  foodOptInAnswerText,
  foodOptInCloseText,
  foodStaleDateAnswerText,
  foodTapDateGuard,
  parseAllCallback,
  parseEscalationCallback,
  parseFoodLogCallback,
  parseFoodOptInCallback,
  parsePreventiveCallback,
  parsePrnLogCallback,
  parseRefillCallback,
  parseSkipCallback,
  parseTakeCallback,
  parseSymptomPickCallback,
  parseSymptomSeverityCallback,
  parseTempReply,
  parseTempReplyMarker,
  tempReplyMarker,
  SYMPTOM_SEVERITY_LABELS,
  type PrnLogCallback,
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
import { collectWindowDoses, windowSessionForDose } from "./supplements";
import { renderWindowMessage } from "./supplement-format";
import { buildFoodNudge } from "./food";
import {
  answerCallbackQuery,
  closeMessage,
  rebuildMessage,
  sendTelegramMessage,
  updateMessageKeyboard,
  type TelegramCallbackQuery,
} from "./telegram";
import type { TelegramMessage } from "./telegram-api";
import type { NotificationAction } from "./types";

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

  // Food logging (#682): a quick-log button logs one serving of a group; the
  // first-connection opt-in prompt flips the per-profile food-logging flag.
  const foodLog = parseFoodLogCallback(cq.data);
  if (foodLog) {
    await handleFoodLog(cq, foodLog);
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
function prnLogToken(): string {
  return crypto.randomBytes(4).toString("hex");
}

// `/dose` command (#797): list the chat's active PRN (as-needed) medications, each
// as a one-tap "💊 <med>" button that logs an administration now. A chat can map to
// several profiles (a family chat), so buttons for a multi-profile chat are prefixed
// with the profile name; the callback token carries the profile id (re-checked
// against the chat on tap). Sends through the chokepoint (sendTelegramMessage).
export async function handleDoseCommand(
  message: TelegramMessage
): Promise<void> {
  const text = (message.text ?? "").trim();
  // Match "/dose" or "/dose@botname" (any trailing args are ignored in v1).
  if (!/^\/dose(@\w+)?(\s|$)/i.test(text)) return;
  const chatId = message.chat?.id;
  if (chatId == null) return;

  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length === 0) {
    await sendTelegramMessage(chatId, {
      title: "Log a PRN dose",
      body: "This chat isn't linked to a profile yet — enable Telegram in Settings → Profile.",
    });
    return;
  }

  const multi = profileIds.length > 1;
  const actions: NotificationAction[] = [];
  for (const pid of profileIds) {
    const prefix = multi ? `${getProfileNameById(pid) ?? "Profile"}: ` : "";
    for (const m of getPrnMedicationsForQuickLog(pid)) {
      actions.push({
        label: `💊 ${prefix}${m.name}${m.count > 0 ? ` (${m.count} today)` : ""}`,
        data: `prn:${pid}:${m.id}:${prnLogToken()}`,
      });
    }
  }

  if (actions.length === 0) {
    await sendTelegramMessage(chatId, {
      title: "Log a PRN dose",
      body: "No as-needed medications are set up. Add one under Medications in the app.",
    });
    return;
  }

  await sendTelegramMessage(chatId, {
    title: "Log a PRN dose",
    body: "Tap a medication to record a dose now:",
    actions,
  });
}

// A PRN log button tap: log one administration NOW for the named item, scoped to the
// profile resolved from the chat (never the token's profile id on its own). Answers
// from the typed AdministrationOutcome — never an unconditional "Logged" (the
// markDoseTaken contract) — and deliberately leaves the /dose message + buttons in
// place so the user can log again later (a PRN med is given multiple times a day).
async function handlePrnLogTap(
  cq: TelegramCallbackQuery,
  token: PrnLogCallback
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
  const outcome = logAdministration(profileId, token.itemId);
  const name = getIntakeItemName(profileId, token.itemId) ?? "medication";
  await answerCallbackQuery(cq.id, administrationOutcomeText(outcome, name));
}

// The profile's top symptoms for the quick-log grid: its recency-ranked logged
// symptoms, falling back to a handful of common curated symptoms for a profile that
// hasn't logged any yet. Capped so the grid stays tappable.
const SYMPTOM_GRID_CAP = 8;
function symptomGridKeys(profileId: number): string[] {
  const ranked = getSymptomLogOrder(profileId).slice(0, SYMPTOM_GRID_CAP);
  if (ranked.length > 0) return ranked;
  return SYMPTOMS.slice(0, SYMPTOM_GRID_CAP).map((s) => s.slug);
}

// `/symptom` command (#859 item 5): list the chat's profiles' ranked symptoms, each a
// one-tap button that opens a severity picker. A multi-profile chat prefixes buttons
// with the profile name; the callback token carries the profile id (re-checked on tap).
export async function handleSymptomCommand(
  message: TelegramMessage
): Promise<void> {
  const text = (message.text ?? "").trim();
  if (!/^\/symptoms?(@\w+)?(\s|$)/i.test(text)) return;
  const chatId = message.chat?.id;
  if (chatId == null) return;

  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length === 0) {
    await sendTelegramMessage(chatId, {
      title: "Log a symptom",
      body: "This chat isn't linked to a profile yet — enable Telegram in Settings → Profile.",
    });
    return;
  }

  const multi = profileIds.length > 1;
  const actions: NotificationAction[] = [];
  for (const pid of profileIds) {
    const prefix = multi ? `${getProfileNameById(pid) ?? "Profile"}: ` : "";
    for (const slug of symptomGridKeys(pid)) {
      actions.push({
        label: `${prefix}${symptomLabel(slug)}`,
        data: `symp:${pid}:${slug}`,
      });
    }
  }

  await sendTelegramMessage(chatId, {
    title: "Log a symptom",
    body: "Tap a symptom, then choose how bad it is:",
    actions,
  });
}

// A symptom button tap: replace the grid with a severity picker for the chosen symptom.
async function handleSymptomPick(
  cq: TelegramCallbackQuery,
  token: SymptomPickCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null || chatId == null || messageId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const label = symptomLabel(token.slug);
  const actions: NotificationAction[] = [1, 2, 3, 4].map((sev) => ({
    label: SYMPTOM_SEVERITY_LABELS[sev],
    data: `symsev:${profileId}:${sev}:${token.slug}`,
    row: "sev",
  }));
  await rebuildMessage(profileId, chatId, messageId, {
    title: `Log a symptom: ${label}`,
    body: "How bad is it?",
    actions,
  });
  await answerCallbackQuery(cq.id);
}

// A severity button tap: log the symptom-day and answer from the typed outcome (never
// an unconditional confirm — the markDoseTaken contract). Closes the picker on success.
async function handleSymptomSeverity(
  cq: TelegramCallbackQuery,
  token: SymptomSeverityCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null || chatId == null || messageId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const outcome = logSymptomCore(
    profileId,
    token.slug,
    token.severity,
    today(profileId)
  );
  if (outcome.kind === "invalid") {
    await answerCallbackQuery(cq.id, "Couldn't log that symptom.");
    return;
  }
  const label = symptomLabel(outcome.symptom);
  const sevLabel =
    SYMPTOM_SEVERITY_LABELS[outcome.severity] ?? String(outcome.severity);
  await answerCallbackQuery(
    cq.id,
    `Logged: ${label} (${sevLabel.toLowerCase()})`
  );
  await closeMessage(chatId, messageId, `✅ Logged ${label} — ${sevLabel}.`);
}

// `/temp` command (#859 item 5): prompt the chat to REPLY with a reading. The prompt
// body carries a "(#temp:<profileId>)" marker per profile, so the reply
// (handleTempReply) attributes without any server-side pending state. A multi-profile
// chat gets one named prompt each.
export async function handleTempCommand(
  message: TelegramMessage
): Promise<void> {
  const text = (message.text ?? "").trim();
  if (!/^\/temp(erature)?(@\w+)?(\s|$)/i.test(text)) return;
  const chatId = message.chat?.id;
  if (chatId == null) return;

  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length === 0) {
    await sendTelegramMessage(chatId, {
      title: "Log a temperature",
      body: "This chat isn't linked to a profile yet — enable Telegram in Settings → Profile.",
    });
    return;
  }

  const multi = profileIds.length > 1;
  for (const pid of profileIds) {
    const who = multi ? `${getProfileNameById(pid) ?? "Profile"}'s ` : "";
    await sendTelegramMessage(chatId, {
      title: "Log a temperature",
      body:
        `Reply to this message with ${who}temperature — e.g. 38.5, or 101F ` +
        `(add C or F to be explicit). ${tempReplyMarker(pid)}`,
    });
  }
}

// A reply to a `/temp` prompt (#859 item 5): resolve the profile from the prompt's
// marker, parse the value + unit from the reply body, log it, and answer honestly from
// the typed TemperatureLogOutcome — with the single-reading red-flag note when the
// reading crosses one. Returns whether the message was a temp reply (so the message
// dispatcher can stop). Never unconditionally confirms.
export async function handleTempReply(
  message: TelegramMessage
): Promise<boolean> {
  const chatId = message.chat?.id;
  const replyText = message.reply_to_message?.text;
  const markedProfile = parseTempReplyMarker(replyText);
  if (chatId == null || markedProfile == null) return false;

  // Only honor the marker when the profile is actually reachable from this chat.
  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (!profileIds.includes(markedProfile)) {
    await sendTelegramMessage(chatId, {
      title: "Temperature not logged",
      body: "That profile isn't linked to this chat anymore.",
    });
    return true;
  }

  const parsed = parseTempReply(message.text);
  if (!parsed) {
    await sendTelegramMessage(chatId, {
      title: "Temperature not logged",
      body: "Couldn't read a temperature there — reply with a number like 38.5 or 101F.",
    });
    return true;
  }

  const date = today(markedProfile);
  const outcome = logTemperatureCore(
    markedProfile,
    parsed.value,
    parsed.unit,
    date
  );
  if (outcome.kind === "invalid") {
    await sendTelegramMessage(chatId, {
      title: "Temperature not logged",
      body: outcome.error,
    });
    return true;
  }
  const redFlag = inlineTempRedFlagNote(
    outcome.degF,
    profileAgeMonths(markedProfile, date)
  );
  const feverNote = outcome.flag === "high" ? " — fever" : "";
  await sendTelegramMessage(chatId, {
    title: `Temperature logged: ${fmtTemp(outcome.degF, parsed.unit)}${feverNote}`,
    body: redFlag ?? "Logged.",
  });
  return true;
}

// The ONE inbound text-message dispatcher (webhook + poller both call this): a reply to
// a temp prompt first, then the slash commands. Keeps routing in one place so both
// transports behave identically.
export async function handleIncomingMessage(
  message: TelegramMessage
): Promise<void> {
  if (await handleTempReply(message)) return;
  await handleSymptomCommand(message);
  await handleTempCommand(message);
  await handleDoseCommand(message);
  // Free-text symptom intake (#877): a plain sentence during an open episode maps onto
  // the vocabulary and replies with confirm buttons — runs AFTER the command handlers
  // (which no-op on non-command text) and only when a temp reply didn't claim it.
  await handleSymptomTextIntake(message);
}

// Free-text symptom intake (issue #877): map a plain-text message onto the symptom
// vocabulary via the Light tier and reply with per-symptom confirm buttons that reuse
// the existing severity handler (suggest-only — nothing logs until a button is tapped).
// Deliberately conservative so ordinary chat isn't hijacked: only fires for a
// SINGLE-profile chat with an OPEN illness episode, and only when the Light tier is
// configured. Returns true when it took over the message.
export async function handleSymptomTextIntake(
  message: TelegramMessage
): Promise<boolean> {
  const text = (message.text ?? "").trim();
  if (!text || text.startsWith("/")) return false;
  const chatId = message.chat?.id;
  if (chatId == null) return false;
  if (!isTaskConfigured("symptom-map")) return false;

  // One profile per chat only — a plain sentence carries no profile token, so a
  // multi-profile chat can't be safely attributed (never guess whose symptom it is).
  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length !== 1) return false;
  const profileId = profileIds[0];

  // Gate on an open illness episode so chit-chat isn't parsed as symptoms.
  if (!currentEpisodeForProfile(profileId)) return false;

  const outcome = await mapSymptomText(text, {
    slugs: symptomSlugs(),
    labels: Object.fromEntries(SYMPTOMS.map((s) => [s.slug, s.label])),
    customNames: getCustomSymptomNames(profileId),
  });
  if (outcome.status !== "ok") return false;

  // Confirm buttons only for CURATED slugs — their callback data is colon-safe. Custom
  // proposals + unmapped fragments are named in the body for the user to add in-app.
  const curated = outcome.mapping.symptoms.filter((s) => !s.isCustom);
  if (curated.length === 0) return false;
  const actions: NotificationAction[] = curated.map((s) => ({
    label: `${symptomLabel(s.slug)} — ${SYMPTOM_SEVERITY_LABELS[s.severity] ?? s.severity}`,
    data: `symsev:${profileId}:${s.severity}:${s.slug}`,
  }));

  const extras: string[] = [];
  if (outcome.mapping.temperature) {
    const t = outcome.mapping.temperature;
    extras.push(`🌡 Temperature ${t.value}°${t.unit} — log it with /temp.`);
  }
  const notMapped = [
    ...outcome.mapping.symptoms.filter((s) => s.isCustom).map((s) => s.label),
    ...outcome.mapping.unmapped,
  ];
  if (notMapped.length > 0) {
    extras.push(`Not mapped: ${notMapped.join(", ")} — add these in the app.`);
  }

  await sendTelegramMessage(chatId, {
    title: "Log these symptoms?",
    body:
      "Tap each to confirm — nothing is logged until you do." +
      (extras.length ? `\n${extras.join("\n")}` : ""),
    actions,
  });
  return true;
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
  // The chats authorized to act on this escalation: the profile's own delivery
  // chat and the escalate override of the supplement the tapped DOSE actually
  // belongs to (issue #615). The caregiver chat is derived from the dose row, NOT
  // from the token's supp id — otherwise a token could pair supplement X's
  // escalate chat with a dose of supplement Y, letting X's caregiver confirm/silence
  // Y's doses. Both reads are profile-scoped, so a forged id can't widen the set.
  const authorizedChats = [
    getProfileTelegram(esc.profileId).telegramChatId,
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
    // Rebuild through the channel chokepoint, which re-applies the SAME send-time
    // "[Name] " prefix (prefixForProfile — one computation, #377/#454), so a
    // shared-chat rebuild keeps the profile label instead of collapsing to an
    // unattributable title. The handler hands over the un-prefixed message and
    // cannot render the wire text itself.
    await rebuildMessage(
      profileId,
      chatId,
      messageId,
      renderWindowMessage(
        profileId,
        session.window,
        tap.date,
        session.entries,
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
        : // Everything due was already resolved (e.g. two caregivers race-tapping
          // ✅ All) — nothing was inserted, so don't claim "Logged ✅" (#280
          // outcome-honesty; #380).
          "Already logged ✓"
  );

  const messageId = cq.message?.message_id;
  if (chatId == null || messageId == null) return;

  // Rebuild from current state — everything's now taken, so this renders the
  // completion summary (no buttons). With nothing due in the window anymore
  // there is no session to render; replace the stale message (it had buttons —
  // this tap came from one) so it stops advertising doses that no longer exist.
  const refreshed = collectWindowDoses(profileId, all.window, all.date);
  if (refreshed.length === 0) {
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
    renderWindowMessage(
      profileId,
      all.window,
      all.date,
      refreshed,
      getUserAge(profileId)
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
  // which re-applies the "[Name] " prefix for a shared chat.
  const rebuilt = buildFoodNudge(profileId, food.window, food.date);
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
    await answerCallbackQuery(cq.id);
    return;
  }
  setProfileFoodTelegram(profileId, opt.enable);
  setFoodTelegramPrompted(profileId);
  await answerCallbackQuery(cq.id, foodOptInAnswerText(opt.enable));
  await replaceMessage(cq, foodOptInCloseText(opt.enable));
}
