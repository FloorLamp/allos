// Pure helpers for Telegram callback payloads — no DB/network, so they can be
// unit-tested (lib/__tests__). Consumed by telegram-callbacks.ts.

import type {
  DoseTakenOutcome,
  EscalationAckOutcome,
  PracticeLogOutcome,
} from "../types";
import type { FoodLogOutcome } from "../food-log-write";
import type { ProteinAddOutcome } from "../protein-log-write";
import { formatRecordDate } from "../record-format";
import { foodGroupName } from "../food-groups";
import { INTAKE_SEND_SLOTS, type IntakeSendSlot } from "./supplement-format";
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
  window: IntakeSendSlot;
  date: string;
}

// Parse an "all:<profileId>:<slot>:<date>" button token — the "mark every
// pending dose in this session taken" action. `slot` must be one of the fixed
// send-slot labels (the four windows, or the PreWorkout pseudo-slot — #1154).
// Like parseTakeCallback, the profile id is a cross-check (the handler
// re-resolves the acting profile from the chat). Anything malformed (unknown
// prefix, bad slot, missing date) returns null.
export function parseAllCallback(data: unknown): AllCallback | null {
  if (typeof data !== "string" || !data.startsWith("all:")) return null;
  const [, profStr, window, date] = data.split(":");
  const profileId = Number(profStr);
  if (!profileId || !date) return null;
  if (!INTAKE_SEND_SLOTS.includes(window as IntakeSendSlot)) return null;
  return { profileId, window: window as IntakeSendSlot, date };
}

// Harvest the dose-session footprint out of a (possibly merged, #1154) reminder
// keyboard: every dose id a surviving take/skip button carries, plus every slot a
// per-slot "✅ All" token names. The rebuild paths feed these to
// slotSessionForKeyboard so a tap on a merged message re-renders EVERY slot the
// message covered, not just the tapped dose's. Pure; unknown tokens are ignored.
export function keyboardDoseFootprint(rows: InlineKeyboard): {
  doseIds: number[];
  slots: IntakeSendSlot[];
} {
  const doseIds = new Set<number>();
  const slots = new Set<IntakeSendSlot>();
  for (const row of rows) {
    for (const b of row) {
      const tap =
        parseTakeCallback(b.callback_data) ??
        parseSkipCallback(b.callback_data);
      if (tap) doseIds.add(tap.doseId);
      const all = parseAllCallback(b.callback_data);
      if (all) slots.add(all.window);
    }
  }
  return { doseIds: [...doseIds], slots: [...slots] };
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

// ---- PRN administration logging over Telegram (/dose command, #797) ----
// A "prn:<profileId>:<itemId>:<token>" button logs one PRN (as-needed)
// administration NOW. Like a dose tap, the profile id is a cross-check (the handler
// re-resolves the acting profile from the chat and logAdministration re-verifies the
// item is that profile's), and the handler answers from the typed
// AdministrationOutcome — never unconditionally, because a PRN log is NOT idempotent
// (multiple/day is the point). `token` is a per-render nonce (the "dedup token"): a
// redelivered identical callback carries the same token, and the actual double-log
// guard is logAdministration's short-window dedup, so a re-tap doesn't invent a
// phantom dose. The button is NOT consumed on tap (you can log again later).

export interface PrnLogCallback {
  profileId: number;
  itemId: number;
  token: string;
}

// Parse a "prn:<profileId>:<itemId>:<token>" token. The token is the greedy tail (a
// nonce with no colons). Malformed (wrong prefix, bad ids, missing token) → null.
export function parsePrnLogCallback(data: unknown): PrnLogCallback | null {
  if (typeof data !== "string" || !data.startsWith("prn:")) return null;
  const [, profStr, itemStr, token] = data.split(":");
  const profileId = Number(profStr);
  const itemId = Number(itemStr);
  if (!profileId || !itemId || !token) return null;
  return { profileId, itemId, token };
}

// ---- Wellness-practice "Done ✓" logging over Telegram (#1259 phase 2) ----
// A "pdone:<profileId>:<targetId>:<token>" button logs one practice session NOW for the
// target's practice. Like a dose/PRN tap the profile id is a cross-check (the handler
// re-resolves the acting profile from the chat, and logPracticeByTargetId re-verifies the
// target is that profile's practice), and the handler answers from the typed
// PracticeLogOutcome — never unconditionally, because a session log is NOT idempotent
// (multi-session days are supported). `token` is a per-render nonce keeping a redelivered
// callback distinguishable; the button IS consumed on tap (the keyboard is edited away),
// so a stale message can't double-log.
export interface PracticeDoneCallback {
  profileId: number;
  targetId: number;
  token: string;
}

// Encode the "pdone:<profileId>:<targetId>:<token>" button token. The single source of
// truth for the shape (the builder mints it, the parser reads it).
export function practiceDoneCallback(
  profileId: number,
  targetId: number,
  token: string
): string {
  return `pdone:${profileId}:${targetId}:${token}`;
}

// Parse a "pdone:<profileId>:<targetId>:<token>" token. The token is the greedy tail (a
// nonce with no colons). Malformed (wrong prefix, bad ids, missing token) → null.
export function parsePracticeDoneCallback(
  data: unknown
): PracticeDoneCallback | null {
  if (typeof data !== "string" || !data.startsWith("pdone:")) return null;
  const [, profStr, targStr, token] = data.split(":");
  const profileId = Number(profStr);
  const targetId = Number(targStr);
  if (!profileId || !targetId || !token) return null;
  return { profileId, targetId, token };
}

// The toast answer for a practice Done tap, from the typed write outcome. Honest per
// outcome (the markDoseTaken contract): the running count on a fresh log, an honest
// "couldn't log" otherwise — never an unconditional confirm.
export function practiceDoneAnswerText(outcome: PracticeLogOutcome): string {
  if (outcome.kind === "logged") {
    return outcome.count === 1
      ? "Logged today's session"
      : `Logged — ${outcome.count} sessions today`;
  }
  return "Couldn't log that session.";
}

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

// A protein "+Xg" quick-log tap (#1073): "foodprotein:<profileId>:<window>:<date>:<grams>".
// Same profile cross-check + window/date as a food-log tap; grams is the scoop preset baked
// in at send time. Distinct prefix so it never collides with a food-log token.
export interface FoodProteinCallback {
  profileId: number;
  window: FoodNudgeWindow;
  date: string;
  grams: number;
}

export function parseFoodProteinCallback(
  data: unknown
): FoodProteinCallback | null {
  if (typeof data !== "string") return null;
  const m = /^foodprotein:(\d+):([A-Za-z]+):(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(
    data
  );
  if (!m) return null;
  const profileId = Number(m[1]);
  const window = m[2] as FoodNudgeWindow;
  const grams = Number(m[4]);
  if (!profileId || !FOOD_NUDGE_WINDOWS.includes(window) || !grams) return null;
  return { profileId, window, date: m[3], grams };
}

// The Telegram toast for a protein "+Xg" tap, from the typed addProteinGramsCore outcome.
// A logged add names the grams added + the day's running protein total; an invalid amount
// (a forged/over-cap token) is answered honestly, never a false confirm (#1073).
export function foodProteinAnswerText(
  outcome: ProteinAddOutcome,
  grams: number
): string {
  if (outcome.kind === "invalid") {
    return "Not logged — that entry is out of date. Open the app.";
  }
  return `Logged ✅ ＋${grams} g protein — ${outcome.grams} g today`;
}

// A "➕ Show more" tap (#1075): "foodmore:<profileId>:<window>:<date>". Carries no count —
// the handler derives the current visible count from the keyboard and rebuilds at +6.
export interface FoodMoreCallback {
  profileId: number;
  window: FoodNudgeWindow;
  date: string;
}

export function parseFoodMoreCallback(data: unknown): FoodMoreCallback | null {
  if (typeof data !== "string") return null;
  const m = /^foodmore:(\d+):([A-Za-z]+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (!m) return null;
  const profileId = Number(m[1]);
  const window = m[2] as FoodNudgeWindow;
  if (!profileId || !FOOD_NUDGE_WINDOWS.includes(window)) return null;
  return { profileId, window, date: m[3] };
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

// A food quick-log tap is date-guarded (#947): the token carries its SEND date, and
// tapping a stale keyboard from a previous day would silently log a serving to that
// old date. For a dose reminder the date-carrying token is deliberately right — a
// late tap marks that dose on that day — but for a counter nudge it's WRONG: a tap
// means "I'm eating NOW". So a cross-date tap writes NOTHING and answers honestly
// (the #232 never-unconditionally-confirm discipline); only a current-day tap logs.
// A same-day tap from an older window keeps working (the date is right; only the
// button counts on the old message are stale, which the rebuild refreshes).
export type FoodTapDateGuard = { kind: "current-day" } | { kind: "stale-date" };

// Decide whether a food tap's token date is today in the profile's timezone. Pure so
// the tz-midnight boundary (a 23:59 tap on yesterday's nudge vs a 00:01 tap on
// today's) is unit-pinnable; the handler passes today(profileId).
export function foodTapDateGuard(
  tokenDate: string,
  todayDate: string
): FoodTapDateGuard {
  return tokenDate === todayDate
    ? { kind: "current-day" }
    : { kind: "stale-date" };
}

// The honest Telegram toast for a refused cross-date tap: name the stale date so the
// user understands why nothing was logged and where the live buttons are.
export function foodStaleDateAnswerText(tokenDate: string): string {
  return `That nudge was from ${tokenDate} — today's buttons are below.`;
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

// ---- Symptom quick-log (#859 item 5) --------------------------------------------
//
// `/symptom` renders a grid of the profile's ranked symptoms; tapping one edits the
// message to a severity picker; tapping a severity logs it. The slug is the greedy
// TAIL of every token (it can carry underscores but never a colon — resolveSymptomKey
// normalizes), so the ids/severity parse cleanly ahead of it.

export interface SymptomPickCallback {
  profileId: number;
  slug: string;
}

// Parse a "symp:<profileId>:<slug>" token. Malformed → null.
export function parseSymptomPickCallback(
  data: unknown
): SymptomPickCallback | null {
  if (typeof data !== "string" || !data.startsWith("symp:")) return null;
  const rest = data.slice("symp:".length);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const profileId = Number(rest.slice(0, colon));
  const slug = rest.slice(colon + 1);
  if (!profileId || !slug) return null;
  return { profileId, slug };
}

export interface SymptomSeverityCallback {
  profileId: number;
  severity: number;
  slug: string;
}

// Parse a "symsev:<profileId>:<severity>:<slug>" token (severity 1..4). Malformed → null.
export function parseSymptomSeverityCallback(
  data: unknown
): SymptomSeverityCallback | null {
  if (typeof data !== "string" || !data.startsWith("symsev:")) return null;
  const rest = data.slice("symsev:".length);
  const m = /^(\d+):([1-4]):(.+)$/.exec(rest);
  if (!m) return null;
  const profileId = Number(m[1]);
  const severity = Number(m[2]);
  if (!profileId) return null;
  return { profileId, severity, slug: m[3] };
}

// ---- Daily mood check-in (#992) -------------------------------------------------

export interface MoodCheckinCallback {
  profileId: number;
  valence: number;
  date: string;
}

// Parse a "mood:<profileId>:<valence>:<date>" face-button token (valence 1..5).
// The profile id is a cross-check — the handler re-resolves the acting profile
// from the chat id (resolveTapProfile), never trusting the token alone. Malformed
// (unknown prefix, out-of-range valence, missing date) → null.
export function parseMoodCheckinCallback(
  data: unknown
): MoodCheckinCallback | null {
  if (typeof data !== "string" || !data.startsWith("mood:")) return null;
  const m = /^mood:(\d+):([1-5]):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (!m) return null;
  const profileId = Number(m[1]);
  if (!profileId) return null;
  return { profileId, valence: Number(m[2]), date: m[3] };
}

// The 1..4 severity button labels (mirrors the symptom-log bar's scale).
export const SYMPTOM_SEVERITY_LABELS: Record<number, string> = {
  1: "Mild",
  2: "Moderate",
  3: "Severe",
  4: "Very severe",
};

// ---- Temperature reply quick-log (#859 item 5) ----------------------------------
//
// `/temp` sends a prompt whose body carries a "(#temp:<profileId>)" marker; the user
// REPLIES to it with a reading. The reply handler extracts the profile from the marker
// (in reply_to_message.text) and the value from the reply body. No server-side pending
// state — the marker rides the prompt message, so the flow is stateless like every
// other inbound Telegram flow.

// The marker embedded in a `/temp` prompt body so a reply can be attributed.
export function tempReplyMarker(profileId: number): string {
  return `(#temp:${profileId})`;
}

// Extract the profile id a reply targets from the prompted message text, or null.
export function parseTempReplyMarker(
  replyToText: string | null | undefined
): number | null {
  if (!replyToText) return null;
  const m = /\(#temp:(\d+)\)/.exec(replyToText);
  if (!m) return null;
  const id = Number(m[1]);
  return id > 0 ? id : null;
}

// Parse a temperature reply body ("38.5", "101F", "38,5 c") into a value + unit. An
// explicit C/F suffix wins; a bare number auto-detects (human body temps never overlap
// across scales below 45° — °C readings sit ~35–42, °F ~95–108), since a Telegram chat
// carries no #857 login unit preference. Returns null when there's no parseable number.
export function parseTempReply(
  body: string | null | undefined
): { value: number; unit: "C" | "F" } | null {
  if (!body) return null;
  const m = /(-?\d+(?:[.,]\d+)?)\s*(°?\s*[cCfF])?/.exec(body.trim());
  if (!m) return null;
  const value = Number(m[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const suffix = (m[2] ?? "").replace(/[^cCfF]/g, "").toUpperCase();
  const unit: "C" | "F" =
    suffix === "C" || suffix === "F"
      ? (suffix as "C" | "F")
      : value < 45
        ? "C"
        : "F";
  return { value, unit };
}
