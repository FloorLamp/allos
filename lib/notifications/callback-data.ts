// Pure helpers for Telegram callback payloads — no DB/network, so they can be
// unit-tested (lib/__tests__). Consumed by telegram-callbacks.ts.

import type { DoseTakenOutcome } from "../types";
import type { ReminderWindow } from "./supplement-format";

export type InlineKeyboard = { text: string; callback_data: string }[][];

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

// Parse a "take:<profileId>:<doseId>:<suppId>:<date>" button token. The profile
// id names who the button was sent to; the handler still resolves the acting
// profile from the chat id and re-checks the dose→supplement→profile chain, so
// this id is a cross-check, never trusted on its own. Forward-compatible:
// anything else (unknown prefix, malformed ids, missing date) returns null.
export function parseTakeCallback(data: unknown): TakeCallback | null {
  if (typeof data !== "string" || !data.startsWith("take:")) return null;
  const [, profStr, doseStr, suppStr, date] = data.split(":");
  const profileId = Number(profStr);
  const doseId = Number(doseStr);
  if (!profileId || !doseId || !date) return null;
  return { profileId, doseId, suppId: Number(suppStr) || null, date };
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

// True when a tap actually resulted in a confirmed dose (new or idempotent
// repeat) — the only outcomes a "Logged ✅" acknowledgement is honest for.
export function tapLogged(outcome: DoseTakenOutcome): boolean {
  return outcome === "logged" || outcome === "already-logged";
}

// The Telegram callback-answer toast for a tap, per markDoseTaken outcome.
// A reminder message is a frozen snapshot: by the time a button is tapped the
// dose may have been deleted/retired by an edit, or its item paused — those
// taps log NOTHING and must say so instead of claiming "Logged ✅" (the old
// behavior, which falsely confirmed doses of possibly-critical medications).
export function tapAnswerText(outcome: DoseTakenOutcome): string {
  switch (outcome) {
    case "logged":
    case "already-logged":
      return "Logged ✅";
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
