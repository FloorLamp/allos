// Pure helpers for Telegram callback payloads — no DB/network, so they can be
// unit-tested (lib/__tests__). Consumed by telegram-callbacks.ts.

import type { DoseTakenOutcome, EscalationAckOutcome } from "../types";
import type { FoodLogOutcome } from "../food-log-write";
import { formatRecordDate } from "../record-format";
import { foodGroupName } from "../food-groups";
import type { ReminderWindow } from "./supplement-format";
import { FOOD_NUDGE_WINDOWS, type FoodNudgeWindow } from "./food-format";

// A keyboard button carries EITHER a callback token or a deep-link url (issue
// #233's refill "Open form"); mirrors telegram.ts's InlineKeyboard.
export type InlineKeyboard = {
  text: string;
  callback_data?: string;
  url?: string;
}[][];

export interface TakeCallback {
  profileId: number;
  doseId: number;
  suppId: number | null;
  date: string;
}

export interface AllCallback {
  profileId: number;
  window: ReminderWindow;
  date: string;
}

const REMINDER_WINDOWS: readonly ReminderWindow[] = [
  "Morning",
  "Midday",
  "Evening",
  "Bedtime",
];

// Parse an "all:<profileId>:<window>:<date>" button token — the "mark every
// pending dose in this session taken" action. `window` must be one of the fixed
// ReminderWindow labels. Like parseTakeCallback, the profile id is a cross-check
// (the handler re-resolves the acting profile from the chat). Anything malformed
// (unknown prefix, bad window, missing date) returns null.
export function parseAllCallback(data: unknown): AllCallback | null {
  if (typeof data !== "string" || !data.startsWith("all:")) return null;
  const [, profStr, window, date] = data.split(":");
  const profileId = Number(profStr);
  if (!profileId || !date) return null;
  if (!REMINDER_WINDOWS.includes(window as ReminderWindow)) return null;
  return { profileId, window: window as ReminderWindow, date };
}

// Parse a "<prefix>:<profileId>:<doseId>:<suppId>:<date>" dose button token for a
// given prefix ("take" or "skip"). The profile id names who the button was sent
// to; the handler still resolves the acting profile from the chat id and
// re-checks the dose→supplement→profile chain, so this id is a cross-check, never
// trusted on its own. Anything malformed (wrong prefix, bad ids, missing date)
// returns null.
function parseDoseCallback(
  data: unknown,
  prefix: "take" | "skip"
): TakeCallback | null {
  if (typeof data !== "string" || !data.startsWith(`${prefix}:`)) return null;
  const [, profStr, doseStr, suppStr, date] = data.split(":");
  const profileId = Number(profStr);
  const doseId = Number(doseStr);
  if (!profileId || !doseId || !date) return null;
  return { profileId, doseId, suppId: Number(suppStr) || null, date };
}

export function parseTakeCallback(data: unknown): TakeCallback | null {
  return parseDoseCallback(data, "take");
}

// Parse a "skip:<profileId>:<doseId>:<suppId>:<date>" button token — the ⏭ Skip
// action (#232), mirroring parseTakeCallback exactly (same shape, "skip" prefix).
export function parseSkipCallback(data: unknown): TakeCallback | null {
  return parseDoseCallback(data, "skip");
}

// True when a parsed token's profile id matches the profile resolved from the
// callback's chat id. A belt-and-suspenders guard: the handler passes the
// chat-resolved profile (not this one) to markDoseTaken, which independently
// verifies the dose chain — but a mismatch here means the token isn't for this
// chat's profile, so we refuse it.
export function takeMatchesProfile(
  take: { profileId: number },
  resolvedProfileId: number
): boolean {
  return take.profileId === resolvedProfileId;
}

// Resolve which profile an inbound tap acts on, given every profile that shares
// the tapped chat. A family chat can map to several profiles, so a bare "pick
// one" would silently drop taps for the others; instead pick the profile the
// button token was minted for — but only when that profile actually shares this
// chat (else the token belongs to a different chat's profile: refuse). Returns
// null when no chat profile matches the token. The caller still passes the
// resolved id to markDoseTaken, which re-verifies the dose→supplement→profile
// chain, so this only decides which profile to scope to.
export function resolveTapProfile(
  take: { profileId: number },
  chatProfileIds: number[]
): number | null {
  return chatProfileIds.some((id) => takeMatchesProfile(take, id))
    ? take.profileId
    : null;
}

// True when a tap actually resulted in a confirmed TAKEN dose (new or idempotent
// repeat) — the only outcomes a "Logged ✅" acknowledgement is honest for. An
// "already-skipped" dose is resolved, but NOT as taken (issue #280).
export function tapLogged(outcome: DoseTakenOutcome): boolean {
  return outcome === "logged" || outcome === "already-taken";
}

// True when a tap left the dose RESOLVED (taken, skipped, or an already-standing
// resolution of either kind) — used to pick honest closing text once a message
// runs out of buttons, regardless of which resolution it was.
export function tapResolved(outcome: DoseTakenOutcome): boolean {
  return (
    outcome === "logged" ||
    outcome === "skipped" ||
    outcome === "already-taken" ||
    outcome === "already-skipped"
  );
}

// The Telegram callback-answer toast for a tap, per markDoseTaken outcome.
// A reminder message is a frozen snapshot: by the time a button is tapped the
// dose may have been deleted/retired by an edit, or its item paused — those
// taps log NOTHING and must say so instead of claiming "Logged ✅" (the old
// behavior, which falsely confirmed doses of possibly-critical medications).
// Likewise a dose meanwhile resolved as SKIPPED (issue #280): the ✅ tap wrote
// nothing, so the answer names the status that actually stands.
export function tapAnswerText(outcome: DoseTakenOutcome): string {
  switch (outcome) {
    case "logged":
    case "already-taken": // idempotent repeat of a taken log — honest
      return "Logged ✅";
    case "already-skipped":
      return "Not logged — already marked skipped ⏭. Open the app to change it.";
    case "inactive":
      return "Not logged — this item is paused. Open the app to log it.";
    case "stale-dose":
    default:
      return "Not logged — this reminder is out of date. Open the app.";
  }
}

// The Telegram callback-answer toast for a ⏭ Skip tap (#232), per markDoseSkipped
// outcome. "Skipped ⏭" is honest for a fresh skip or an idempotent repeat of one
// ("already-skipped"); a dose meanwhile resolved as TAKEN (issue #280) was NOT
// overwritten, so the answer says the taken log stands instead of falsely
// confirming a skip. The paused/stale cases mirror tapAnswerText.
export function tapSkipAnswerText(outcome: DoseTakenOutcome): string {
  switch (outcome) {
    case "skipped":
    case "already-skipped": // idempotent repeat of a skip — honest
      return "Skipped ⏭";
    case "already-taken":
      return "Not skipped — already logged as taken ✅. Open the app to change it.";
    case "inactive":
      return "Not logged — this item is paused. Open the app to log it.";
    case "stale-dose":
    default:
      return "Not logged — this reminder is out of date. Open the app.";
  }
}

// Replacement body when a message can't be rebuilt from current state and a
// FAILED tap consumed its last button — "All done 💊✅" would be a lie.
export const OUTDATED_MESSAGE_TEXT =
  "This reminder is out of date — check the app for your current schedule.";

// Compose a consumed-tap REPLACEMENT body that keeps the original message's title
// line above the closing line (issue #377). When a shared-chat reminder was sent
// with a "[Name] " prefix (or just a "💊 …" / "⚠️ Missed dose: …" title naming the
// med), a bare closing line like "Confirmed taken ✅" erases WHO/WHICH med the tap
// resolved — visually identical across two family members. Retaining the first
// line (Telegram delivers the message text plain, HTML already stripped) keeps the
// chat history attributable. Falls back to the bare closing when no original text
// is available (an older client update, or a message with no text).
export function replacementWithTitle(
  originalText: string | null | undefined,
  closing: string
): string {
  const title = (originalText ?? "").split("\n")[0]?.trim() ?? "";
  return title ? `${title}\n${closing}` : closing;
}

// Drop the tapped button from an inline keyboard, removing rows that become
// empty. An empty result means the tap consumed the last button.
export function removeButton(
  rows: InlineKeyboard,
  data: string
): InlineKeyboard {
  return rows
    .map((r) => r.filter((b) => b.callback_data !== data))
    .filter((r) => r.length > 0);
}

// Drop the ENTIRE row that the tapped button sits in (issue #233). A preventive
// item's ✅/🚫/⏰ trio — or a refill item's snooze + deep-link pair — share one
// row, so consuming any one resolves the whole item: the sibling buttons (and any
// url button, which has no callback_data to match) go with it. An empty result
// means that was the last item's row.
export function removeRowContaining(
  rows: InlineKeyboard,
  data: string
): InlineKeyboard {
  return rows.filter((r) => !r.some((b) => b.callback_data === data));
}

// ---- Phase 1: preventive-nudge buttons (issue #233) ----
// ✅ Done → recordPreventiveDone; 🚫 Not applicable → setPreventiveOverride;
// ⏰ Remind later → findings-bus snooze (#227). The token carries the profile id
// (cross-checked against the chat like a dose tap) and the catalog RULE KEY — a
// stable machine key, never a name, and never recycled — so it fits Telegram's
// 64-byte limit and the handler re-derives the rule's kind from the catalog.

export type PreventiveAction = "done" | "na" | "later";

export interface PreventiveCallback {
  profileId: number;
  ruleKey: string;
  action: PreventiveAction;
}

// Parse a "pv<done|na|later>:<profileId>:<ruleKey>" token. Rule keys are the
// catalog's stable snake_case identifiers (no colons), so the greedy tail is the
// whole key. The handler still validates it against the catalog. Malformed →
// null.
export function parsePreventiveCallback(
  data: unknown
): PreventiveCallback | null {
  if (typeof data !== "string") return null;
  const m = /^pv(done|na|later):(\d+):(.+)$/.exec(data);
  if (!m) return null;
  const profileId = Number(m[2]);
  const ruleKey = m[3];
  if (!profileId || !ruleKey) return null;
  const action: PreventiveAction =
    m[1] === "done" ? "done" : m[1] === "na" ? "na" : "later";
  return { profileId, ruleKey, action };
}

// The outcome a preventive tap answers from. `unknown-rule` covers a tampered or
// stale token whose rule isn't in the catalog — nothing is written, so the tap is
// never falsely confirmed. `snoozeUntil` (the profile-local date the bus snooze
// runs to) rides along on a `reminded` outcome so both the toast and the closing
// text can say WHEN the reminder resumes — the dose handlers' outcome-honesty
// discipline: state what actually happened, from the one applied write.
export type PreventiveTapOutcome =
  | { kind: "done" }
  | { kind: "not-applicable" }
  | { kind: "reminded"; snoozeUntil: string }
  | { kind: "unknown-rule" };

export function preventiveAnswerText(outcome: PreventiveTapOutcome): string {
  switch (outcome.kind) {
    case "done":
      return "Marked done ✅";
    case "not-applicable":
      return "Marked not applicable 🚫";
    case "reminded":
      return `Snoozed until ${formatRecordDate(outcome.snoozeUntil)} ⏰`;
    case "unknown-rule":
    default:
      return "Not recorded — this reminder is out of date. Open the app.";
  }
}

// The closing line a resolved preventive message collapses to (its title — which
// names the screening — is retained above it by replacementWithTitle). Unlike the
// old generic "handled ✅", it states the suppressed/resolved state in detail:
// what was recorded, and for a snooze, until when and where to undo it.
export function preventiveCloseText(outcome: PreventiveTapOutcome): string {
  switch (outcome.kind) {
    case "done":
      return "Marked done ✅ — recorded to preventive care.";
    case "not-applicable":
      return "Marked not applicable 🚫 — it won't be suggested again.";
    case "reminded":
      return `Snoozed until ${formatRecordDate(
        outcome.snoozeUntil
      )} ⏰ — hidden from Upcoming and reminders until then (restore it on Upcoming any time).`;
    case "unknown-rule":
    default:
      return OUTDATED_MESSAGE_TEXT;
  }
}

// ---- Phase 3: refill-nudge snooze button (issue #233) ----
// 📦 Ordered — remind me in 3 days → bus snooze via refillSignalKey (#227). No
// "mark refilled" button: that needs an amount, which a button handles badly (a
// deep-link opens the form instead). The token carries the (integer, never-
// recycled) supplement id.

export interface RefillCallback {
  profileId: number;
  suppId: number;
}

// Parse a "rfsnooze:<profileId>:<suppId>" token. Malformed → null.
export function parseRefillCallback(data: unknown): RefillCallback | null {
  if (typeof data !== "string" || !data.startsWith("rfsnooze:")) return null;
  const [, profStr, suppStr] = data.split(":");
  const profileId = Number(profStr);
  const suppId = Number(suppStr);
  if (!profileId || !suppId) return null;
  return { profileId, suppId };
}

export type RefillTapOutcome = "snoozed" | "stale-item";

export function refillAnswerText(outcome: RefillTapOutcome): string {
  return outcome === "snoozed"
    ? "Got it 📦 — I'll remind you in 3 days."
    : "Not recorded — this reminder is out of date. Open the app.";
}

// ---- Phase 2: escalation buttons (issue #233) ----
// ✅ Confirmed taken → markDoseTaken (its DoseTakenOutcome answers honestly);
// 👍 I'm on it → an ack that suppresses re-nudge WITHOUT claiming the dose taken.
// The token mirrors a dose tap's shape (profile/dose/supp/date) under distinct
// "esctake"/"escack" prefixes.

export type EscalationAction = "take" | "ack";

export interface EscalationCallback {
  profileId: number;
  doseId: number;
  suppId: number | null;
  date: string;
  action: EscalationAction;
}

// Parse an "esctake:…" / "escack:…" token (same field layout as a dose token).
// Malformed (wrong prefix, bad ids, missing date) → null.
export function parseEscalationCallback(
  data: unknown
): EscalationCallback | null {
  if (typeof data !== "string") return null;
  let action: EscalationAction;
  if (data.startsWith("esctake:")) action = "take";
  else if (data.startsWith("escack:")) action = "ack";
  else return null;
  const [, profStr, doseStr, suppStr, date] = data.split(":");
  const profileId = Number(profStr);
  const doseId = Number(doseStr);
  if (!profileId || !doseId || !date) return null;
  return {
    profileId,
    doseId,
    suppId: Number(suppStr) || null,
    date,
    action,
  };
}

// AUTHORIZATION for an escalation tap (issue #233's recorded design decision).
// Chat-id auth: a tap is authorized when the chat it came from is one of the
// chats the escalation could have been delivered to for this profile — the
// profile's OWN Telegram chat, or the supplement's escalate_chat_id (a caregiver
// chat). This deliberately means ANYONE in that chat can confirm/ack on the
// profile's behalf, consistent with the existing dose-button model and intended
// for household caregiving. Returns the token's profile id when authorized, else
// null. `authorizedChatIds` must be built from the DOSE's own supplement (issue
// #615), never the token's supp id, so a caregiver chat can only act on the doses
// of the supplement actually routed to it. The caller still passes the resolved id
// to markDoseTaken, which re-verifies the dose→supplement→profile chain (and
// refuses a token whose supp id contradicts the dose), so a forged dose/supp id
// from an authorized chat is rejected there too.
export function resolveEscalationTap(
  token: { profileId: number },
  tappingChatId: string,
  authorizedChatIds: readonly (string | null | undefined)[]
): number | null {
  if (!tappingChatId) return null;
  const ok = authorizedChatIds.some(
    (c) => !!c && c.trim() !== "" && c.trim() === tappingChatId
  );
  return ok ? token.profileId : null;
}

export function escalationAckAnswerText(outcome: EscalationAckOutcome): string {
  switch (outcome) {
    case "acknowledged":
      return "Thanks 👍 — we'll hold off (dose not marked taken).";
    case "already-taken":
      return "Already confirmed taken ✅";
    case "already-skipped":
      return "Already resolved — this dose was marked skipped ⏭.";
    case "inactive":
      return "This item is paused — open the app.";
    case "stale-dose":
    default:
      return "This reminder is out of date. Open the app.";
  }
}

// Replacement message body after an escalation ✅ Confirmed-taken tap, per
// markDoseTaken outcome. "Confirmed taken ✅" is only honest when a taken log
// actually stands (fresh or idempotent repeat); a dose meanwhile resolved as
// SKIPPED (issue #280) is resolved-but-not-taken and must say so — the old
// tapResolved gate rendered "Confirmed taken ✅" over a skipped log.
export function escalationTakeCloseText(outcome: DoseTakenOutcome): string {
  if (tapLogged(outcome)) return "Confirmed taken ✅";
  if (outcome === "already-skipped") {
    return "This dose was marked skipped ⏭ — check the app.";
  }
  return OUTDATED_MESSAGE_TEXT;
}

// Replacement message body after an escalation 👍 I'm-on-it tap, per
// escalationAckState outcome. Kept alongside escalationAckAnswerText so the
// toast and the rebuilt message can never disagree about what stands.
export function escalationAckCloseText(outcome: EscalationAckOutcome): string {
  switch (outcome) {
    case "acknowledged":
      return "Acknowledged 👍 — we'll hold off.";
    case "already-taken":
      return "Already confirmed taken ✅";
    case "already-skipped":
      return "This dose was marked skipped ⏭ — check the app.";
    case "inactive":
    case "stale-dose":
    default:
      return OUTDATED_MESSAGE_TEXT;
  }
}

// ---- Food logging over Telegram (issue #682) ----
// A food quick-log button ("food:<profileId>:<window>:<date>:<slug>") logs one
// serving of a group; the opt-in prompt buttons ("foodoptin:<profileId>:<yes|no>")
// flip the per-profile food_telegram_enabled flag. Both mirror a dose tap: the
// profile id is a cross-check (the handler re-resolves the acting profile from the
// chat), and the handler answers from the typed write outcome, never unconditionally.
// The window allowlist is FOOD_NUDGE_WINDOWS, imported from the renderer so the parser
// and the send path can't drift on which windows are valid.

export interface FoodLogCallback {
  profileId: number;
  window: FoodNudgeWindow;
  date: string;
  group: string;
}

// Parse a "food:<profileId>:<window>:<date>:<slug>" token. The slug is the greedy
// tail (a food-group slug is snake_case with no colons, so this is robust even if a
// future slug grew unusual characters). Malformed (bad prefix/window/date, missing
// slug) → null; the handler still validates the slug against the catalog on write.
export function parseFoodLogCallback(data: unknown): FoodLogCallback | null {
  if (typeof data !== "string") return null;
  const m = /^food:(\d+):([A-Za-z]+):(\d{4}-\d{2}-\d{2}):(.+)$/.exec(data);
  if (!m) return null;
  const profileId = Number(m[1]);
  const window = m[2] as FoodNudgeWindow;
  if (!profileId || !FOOD_NUDGE_WINDOWS.includes(window)) return null;
  return { profileId, window, date: m[3], group: m[4] };
}

export interface FoodOptInCallback {
  profileId: number;
  enable: boolean;
}

// Parse a "foodoptin:<profileId>:<yes|no>" token. Malformed → null.
export function parseFoodOptInCallback(
  data: unknown
): FoodOptInCallback | null {
  if (typeof data !== "string") return null;
  const m = /^foodoptin:(\d+):(yes|no)$/.exec(data);
  if (!m) return null;
  const profileId = Number(m[1]);
  if (!profileId) return null;
  return { profileId, enable: m[2] === "yes" };
}

// The Telegram toast for a food quick-log tap, from the typed write outcome. A
// logged serving names the group and its running daily total; an unknown group (a
// stale/forged token, a retired slug) is answered honestly, never falsely confirmed.
export function foodLogAnswerText(
  outcome: FoodLogOutcome,
  group: string
): string {
  if (outcome.kind === "unknown-group") {
    return "Not logged — that food is out of date. Open the app.";
  }
  const name = foodGroupName(group);
  return outcome.servings > 1
    ? `Logged ✅ ${name} ×${outcome.servings} today`
    : `Logged ✅ ${name}`;
}

// The Telegram toast after an opt-in prompt tap.
export function foodOptInAnswerText(enable: boolean): string {
  return enable
    ? "Food logging on 🍽️ — you'll see it at your reminder times."
    : "No problem — enable it any time in Settings → Profile.";
}

// The closing line an opt-in prompt collapses to once answered (its title is
// retained above it by replacementWithTitle).
export function foodOptInCloseText(enable: boolean): string {
  return enable
    ? "Food logging enabled 🍽️ — tap your foods at your reminder times."
    : "No food logging — you can turn it on later in Settings → Profile.";
}
