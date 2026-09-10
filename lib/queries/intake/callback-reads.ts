// Part of the lib/queries/intake barrel (#319), split out of adherence.ts under
// #2960 / rule #5670. The profile-scoping guard walks all of lib/, so this module
// stays covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
//
// THE LOOKUPS A NOTIFICATION CALLBACK CHECKS A CLIENT-SUPPLIED ID AGAINST. Every
// read here answers a question a Telegram tap raises before anything is written: is
// this item the profile's, what is it called, what does it oblige, which caregiver
// chat may act for it, and is the dose this ack names already resolved. They are
// grouped because they share ONE discipline rather than one caller — each is scoped
// by profile so a forged or stale id from a callback token reads nothing instead of
// leaking (or writing against) another profile's row.
//
// They write nothing. `escalationAckState` is the sharpest case: it mirrors the
// resolution core's chain check exactly and still records NOTHING, because an ack
// must never log the dose as taken.
import { db } from "../../db";
import type { DoseStatus, EscalationAckOutcome } from "../../types";

// The name of an intake item this profile owns, or null — for the Telegram /dose
// tap toast ("Logged ✅ Ibuprofen"), derived from the id the callback names.
// Profile-scoped (WHERE id AND profile_id) so a forged id can't leak another
// profile's med name.
export function getIntakeItemName(
  profileId: number,
  itemId: number
): string | null {
  const row = db
    .prepare("SELECT name FROM intake_items WHERE id = ? AND profile_id = ?")
    .get(itemId, profileId) as { name: string } | undefined;
  return row?.name ?? null;
}

// Whether an intake item (supplement/med) exists for this profile — a scoped
// existence check for the Telegram refill-snooze button (issue #233), so a forged
// item id from a callback can't write a suppression for a row that isn't the
// profile's. Profile-scoped (WHERE id AND profile_id).
export function intakeItemExists(profileId: number, itemId: number): boolean {
  return !!db
    .prepare("SELECT 1 FROM intake_items WHERE id = ? AND profile_id = ?")
    .get(itemId, profileId);
}

// One item's declared obligation, or null when the item isn't this profile's (#1779).
// Profile-scoped, so a forged item id from a stale callback token reads nothing. Used
// by the message reconcile to decide whether a ⤓ May suggestion still has anything to
// offer — the same already-`may` refusal the tap's own typed outcome would answer with.
export function getIntakeItemObligation(
  profileId: number,
  itemId: number
): string | null {
  const row = db
    .prepare(
      "SELECT obligation FROM intake_items WHERE id = ? AND profile_id = ?"
    )
    .get(itemId, profileId) as { obligation: string | null } | undefined;
  return row?.obligation ?? null;
}

// The escalate_chat_id (caregiver chat) configured on one of the profile's
// intake items, or null. Used to AUTHORIZE an escalation-button tap (issue #233):
// a tap from this chat may confirm/ack on the profile's behalf. Profile-scoped, so
// a forged item id can't leak another profile's escalation chat.
export function getIntakeEscalateChatId(
  profileId: number,
  itemId: number
): string | null {
  const row = db
    .prepare(
      "SELECT escalate_chat_id FROM intake_items WHERE id = ? AND profile_id = ?"
    )
    .get(itemId, profileId) as { escalate_chat_id: string | null } | undefined;
  return row?.escalate_chat_id ?? null;
}

// The escalate_chat_id (caregiver chat) of the intake item a specific DOSE belongs
// to, or null. This is the authorization anchor for an escalation tap (issue #615):
// the caregiver chat that authorizes a tap must be the one routed to the ITEM
// the tapped dose actually belongs to — NOT whatever item id the client-supplied
// token names. Deriving the chat from the dose row (profile-scoped through the
// parent item) closes the widening where a token could pair one item's escalation
// chat with a different item's dose. Returns null for a dose that
// isn't this profile's (so only the profile's own chat can then authorize).
export function getDoseEscalateChatId(
  profileId: number,
  doseId: number
): string | null {
  const row = db
    .prepare(
      `SELECT s.escalate_chat_id AS escalate_chat_id
         FROM intake_item_doses d
         JOIN intake_items s ON s.id = d.item_id
        WHERE d.id = ? AND s.profile_id = ?`
    )
    .get(doseId, profileId) as { escalate_chat_id: string | null } | undefined;
  return row?.escalate_chat_id ?? null;
}

// Verify a missed-dose escalation ACK (issue #233's "👍 I'm on it") without
// writing anything: does the dose still belong to this profile, is its item
// active, and is it already resolved for the day? Mirrors markDoseTaken's chain
// check (dose→item→profile, retired/paused refused) so a stale ack answers
// honestly, but records NOTHING — an ack must never log the dose as taken. Any
// existing log ends the chase and is reported by its ACTUAL status (issue
// #280): a dose deliberately skipped before the caregiver tapped must not be
// answered as a fresh "we'll hold off". The caller sets the per-episode
// escalation marker only on "acknowledged". Fully profile-scoped.
export function escalationAckState(
  profileId: number,
  doseId: number,
  date: string
): EscalationAckOutcome {
  const owned = db
    .prepare(
      `SELECT s.active AS active
         FROM intake_item_doses d
         JOIN intake_items s ON s.id = d.item_id
        WHERE d.id = ? AND s.profile_id = ? AND d.retired = 0`
    )
    .get(doseId, profileId) as { active: number } | undefined;
  if (!owned) return "stale-dose";
  if (!owned.active) return "inactive";
  // Any log (taken OR skipped) already resolves it — tell the caregiver how it
  // was resolved rather than acknowledging a chase that's already over. Joined
  // through the dose's parent so the read stays profile-scoped.
  const existing = db
    .prepare(
      `SELECT l.status AS status
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE l.dose_id = ? AND l.date = ? AND s.profile_id = ?`
    )
    .get(doseId, date, profileId) as { status: DoseStatus } | undefined;
  if (existing) {
    return existing.status === "skipped" ? "already-skipped" : "already-taken";
  }
  return "acknowledged";
}
