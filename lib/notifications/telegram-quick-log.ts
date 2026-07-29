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
      const dose = formatMedicationDoseProduct(m.amount, m.product);
      actions.push({
        label: `💊 ${prefix}${m.name}${dose ? ` · ${dose}` : ""}${m.count > 0 ? ` (${m.count} today)` : ""}`,
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
export async function handlePrnLogTap(
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

// A practice "Done ✓" tap (#1259): log one session NOW for the tapped target's practice,
// scoped to the profile resolved from the chat (never the token's profile id alone).
// Answers from the typed PracticeLogOutcome — never an unconditional confirm (a session
// log is not idempotent) — and CONSUMES the tapped button so a stale message can't
// double-log; sibling practice buttons survive so the nudge stays usable.
export async function handlePracticeDoneTap(
  cq: TelegramCallbackQuery,
  token: PracticeDoneCallback
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
  const outcome = logPracticeByTargetId(profileId, token.targetId);
  await answerCallbackQuery(cq.id, practiceDoneAnswerText(outcome));

  const messageId = cq.message?.message_id;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (chatId == null || messageId == null || rows.length === 0) return;
  const remaining = removeButton(rows, cq.data as string);
  if (remaining.length === 0) {
    await closeMessage(
      chatId,
      messageId,
      replacementWithTitle(
        cq.message?.text,
        outcome.kind === "logged" ? "Logged ✅" : OUTDATED_MESSAGE_TEXT
      )
    );
  } else {
    await updateMessageKeyboard(chatId, messageId, remaining);
  }
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
export async function handleSymptomPick(
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
// A mood check-in face tap (#992). Runs the SAME upsertMoodLog core as the
// dashboard card and the offline replay (idempotent per profile+date — which also
// resets the reminder's ignored counter, re-arming an auto-paused check-in), and
// answers from the write's actual outcome — never an unconditional confirm. A tap
// on a day that ALREADY has a check-in (e.g. an old message tapped after logging
// in-app) carries the stored expand fields along so it only changes the valence.
export async function handleMoodTap(
  cq: TelegramCallbackQuery,
  token: MoodCheckinCallback
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
  const existing = getMoodOnDate(profileId, token.date);
  const ok = upsertMoodLog(profileId, token.date, {
    valence: token.valence,
    energy: existing?.energy ?? null,
    anxiety: existing?.anxiety ?? null,
    factors: existing?.factors ?? [],
    note: existing?.notes ?? null,
  });
  if (!ok) {
    await answerCallbackQuery(cq.id, "Couldn't log that check-in.");
    return;
  }
  const label = moodLabel(token.valence);
  await answerCallbackQuery(cq.id, `Logged: ${label}`);
  await closeMessage(
    chatId,
    messageId,
    `${moodFace(token.valence)} Logged — ${label}. Thanks for checking in.`
  );
}

export async function handleSymptomSeverity(
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
  // Event-driven red-flag push (#1025): a crossing reading dispatches the
  // co-caregiver nudge NOW (fire-and-forget, quiet-hours exempt like redose); the
  // per-finding marker + bus own dedup, so the logger's own toast below and the
  // push can't double-nag.
  queueTempRedFlagDispatch(markedProfile, outcome.degF);
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
import crypto from "node:crypto";
import { collapsedOfferAction, expandedOfferActions } from "./offer-tail";
import type { DemoteCallback, OfferTailCallback } from "./callback-data";
import { demoteIntakeObligation } from "../intake-obligation-write";
import { DEMOTION_OUTCOME_TEXT } from "../supplement-demotion";
import { getOfferedIntakeForSlot } from "../queries/intake";
import { messageKeyboard } from "./telegram-render";
import { zonedDateParts } from "../date";

import {
  getCustomSymptomNames,
  getDoseEscalateChatId,
  getIntakeItemName,
  getPrnMedicationsForQuickLog,
  getSymptomLogOrder,
  logAdministration,
  logPracticeByTargetId,
} from "../queries";
import { today } from "../db";
import {
  getProfilesByTelegramChatId,
  getTimezone,
  getUserAge,
} from "../settings";
import { getProfileNameById } from "../profile-summary-load";
import { administrationOutcomeText } from "../administration-format";
import { logSymptomCore } from "../symptom-log-write";
import { upsertMoodLog } from "../offline/writes";
import { getMoodOnDate } from "../queries/mood";
import { moodFace, moodLabel } from "../mood";
import { logTemperatureCore } from "../temperature-log";
import { symptomLabel, symptomSlugs, SYMPTOMS } from "../symptoms";
import { currentEpisodeForProfile } from "../illness-episode";
import { isTaskConfigured } from "../ai-resolve";
import { mapSymptomText } from "../symptom-text-map";
import { profileAgeMonths } from "../settings";
import { inlineTempRedFlagNote } from "../temp-red-flag";
import { fmtTemp } from "../units";
import { formatMedicationDoseProduct } from "../medication-dose-format";
import { queueTempRedFlagDispatch } from "./temp-red-flag";
import {
  parseMoodCheckinCallback,
  parsePrnLogCallback,
  parseSymptomPickCallback,
  parseSymptomSeverityCallback,
  parseTempReply,
  parseTempReplyMarker,
  practiceDoneAnswerText,
  removeButton,
  replacementWithTitle,
  resolveTapProfile,
  SYMPTOM_SEVERITY_LABELS,
  tempReplyMarker,
  OUTDATED_MESSAGE_TEXT,
  type MoodCheckinCallback,
  type PracticeDoneCallback,
  type PrnLogCallback,
  type SymptomPickCallback,
  type SymptomSeverityCallback,
} from "./callback-data";
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

// An offer-tail tap (#1505): expand the digest's "Log other…" button IN PLACE into
// one-tap log buttons for the `may` items on offer RIGHT NOW, or collapse it back.
//
// Nothing is sent and nothing is written — both directions are a single
// editMessageReplyMarkup on a message that already exists. That is the mechanism
// behind the contact-consent rule: the system may give the user more ways to reach
// their own data without ever spending another notification on them.
//
// SLOT SCOPING HAPPENS HERE, at tap time, against the PROFILE-LOCAL clock — not
// against the slot the digest was built in. A morning digest tapped at bedtime must
// offer bedtime items; anything else would be answering a question the user asked now
// with data from eight hours ago.
//
// A tap on a message from a PREVIOUS day is refused rather than silently re-scoped:
// the keyboard belongs to that day's message, and logging "now" from it would attach
// today's administration to yesterday's context.
export async function handleOfferTailTap(
  cq: TelegramCallbackQuery,
  token: OfferTailCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null || messageId == null || chatId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const date = today(profileId);
  if (token.date !== date) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const nowHhmm = zonedDateParts(getTimezone(profileId), new Date()).hhmm;
  const offered = getOfferedIntakeForSlot(profileId, nowHhmm);

  if (token.action === "collapse") {
    await updateMessageKeyboard(
      chatId,
      messageId,
      messageKeyboard({
        title: "",
        body: "",
        actions: [
          collapsedOfferAction(profileId, date, nowHhmm, offered.length),
        ],
      })
    );
    await answerCallbackQuery(cq.id);
    return;
  }

  if (offered.length === 0) {
    // The slot turned over (or the items were paused) since the label was rendered.
    // Say so plainly instead of opening an empty list.
    await answerCallbackQuery(
      cq.id,
      "Nothing available in this slot right now."
    );
    return;
  }
  await updateMessageKeyboard(
    chatId,
    messageId,
    messageKeyboard({
      title: "",
      body: "",
      actions: expandedOfferActions(profileId, date, offered, prnLogToken),
    })
  );
  await answerCallbackQuery(cq.id);
}

// A ⤓ May tap on a dose reminder (#1505 part 2): accept the demotion suggestion for
// the named item.
//
// This is the ONLY obligation write the notification layer can perform, and it is a
// downward one initiated by the user — the two properties that make it safe. It goes
// through the SAME compare-and-swap core the in-app card uses, so the two surfaces
// cannot diverge on outcomes, and it answers from the typed result rather than
// confirming unconditionally: a stale button on a paused or already-may item
// legitimately refuses.
//
// The tapped ROW is consumed on success — take/skip/demote all become meaningless for
// an item that no longer has a scheduled dose — while the rest of the reminder's
// buttons survive so the session stays usable.
export async function handleDemoteTap(
  cq: TelegramCallbackQuery,
  token: DemoteCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const outcome = demoteIntakeObligation(profileId, token.itemId);
  await answerCallbackQuery(cq.id, DEMOTION_OUTCOME_TEXT[outcome]);
  if (outcome !== "demoted" || chatId == null || messageId == null) return;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (rows.length === 0) return;
  await updateMessageKeyboard(
    chatId,
    messageId,
    removeButton(rows, cq.data as string)
  );
}
