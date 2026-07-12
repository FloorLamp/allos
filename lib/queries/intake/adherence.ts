// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Adherence / dose-log reads and writes: taken/skipped dose sets, the idempotent
// mark-taken/skipped log writers (the notification-webhook counterparts), the
// escalation-authorization helpers, and the adherence-strip range read.
import { db, today } from "../../db";
import { shiftDateStr } from "../../date";
import { decrementSupply } from "./refill";
import type {
  DoseStatus,
  DoseTakenOutcome,
  EscalationAckOutcome,
} from "../../types";

// Supplement ids with at least one dose actually TAKEN on `date` (supplement-
// level view for the dashboard / AI summary). A skipped dose (issue #232) is not
// "taken", so it's excluded.
export function getSupplementLogsForDate(
  profileId: number,
  date: string
): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT l.item_id FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.date = ? AND l.status = 'taken'
          AND l.item_id IS NOT NULL`
    )
    .all(profileId, date) as { item_id: number }[];
  return new Set(rows.map((r) => r.item_id));
}

// Dose ids TAKEN on `date` (per-dose view for the schedule check-offs), scoped to
// the profile through the dose's parent supplement. Skipped doses are NOT taken —
// getSkippedDoseIds surfaces those separately for the tri-state (issue #232).
export function getTakenDoseIds(profileId: number, date: string): Set<number> {
  const rows = db
    .prepare(
      `SELECT l.dose_id FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date = ? AND l.status = 'taken'`
    )
    .all(profileId, date) as { dose_id: number }[];
  return new Set(rows.map((r) => r.dose_id));
}

// Dose ids deliberately SKIPPED on `date` (issue #232) — the other half of the
// web tri-state and, together with getTakenDoseIds, the "resolved" set that
// suppresses escalation and re-nudging. Scoped through the parent supplement.
export function getSkippedDoseIds(
  profileId: number,
  date: string
): Set<number> {
  const rows = db
    .prepare(
      `SELECT l.dose_id FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date = ? AND l.status = 'skipped'`
    )
    .all(profileId, date) as { dose_id: number }[];
  return new Set(rows.map((r) => r.dose_id));
}

// Log a single dose as taken on `date`, idempotently — the non-React-context
// counterpart to the toggleTaken server action, callable from the notification
// webhook. Mirrors toggleTaken's insert (dose_id + item_id + date +
// amount snapshot) so the supplements page's per-dose adherence reflects it;
// never deletes. Returns what actually happened so the caller (the Telegram
// tap handler) can answer honestly: a tap on a button whose dose was since
// deleted/retired by an edit, or whose item was paused, logs NOTHING and must
// not be acknowledged as "Logged".
export function markDoseTaken(
  profileId: number,
  doseId: number,
  supplementId: number | null,
  date: string
): DoseTakenOutcome {
  // The dose id arrives from a Telegram callback, so verify it belongs to this
  // profile (via its parent supplement) before logging anything against it. Read
  // the supplement id from the row rather than trusting the callback token. A
  // retired dose is no longer part of the schedule — treat it like a deleted one.
  const owned = db
    .prepare(
      `SELECT d.item_id AS item_id, d.amount AS amount,
              s.active AS active
         FROM intake_item_doses d
         JOIN intake_items s ON s.id = d.item_id
        WHERE d.id = ? AND s.profile_id = ? AND d.retired = 0`
    )
    .get(doseId, profileId) as
    { item_id: number; amount: string | null; active: number } | undefined;
  if (!owned) return "stale-dose";
  // A paused/stopped item keeps its buttons in old messages; refuse the tap so
  // a lingering reminder can't silently log doses (and burn supply) for an item
  // the user has deliberately paused.
  if (!owned.active) return "inactive";
  // An existing log resolves the day; report its ACTUAL status (issue #280) so
  // a ✅ tap on a dose meanwhile marked skipped is never answered "Logged".
  const existing = db
    .prepare(
      "SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
    )
    .get(doseId, date) as { status: DoseStatus } | undefined;
  if (existing) {
    // Don't re-decrement supply, and never overwrite a deliberate skip.
    return existing.status === "skipped" ? "already-skipped" : "already-taken";
  }
  // Snapshot the dose amount at confirm time: history must keep showing what
  // was actually taken even after a later dosage edit rewrites the dose row.
  db.prepare(
    "INSERT INTO intake_item_logs (dose_id, item_id, date, amount) VALUES (?,?,?,?)"
  ).run(doseId, supplementId ?? owned.item_id, date, owned.amount);
  // Guarded by the dedup above: a confirmed dose decrements on-hand supply once.
  decrementSupply(profileId, owned.item_id);
  return "logged";
}

// Log a single dose as SKIPPED on `date` (issue #232) — the sibling of
// markDoseTaken for the Telegram ⏭ button. A skip is a deliberate "chose not to
// take it" decision, so it writes a status='skipped' log row (amount NULL:
// nothing was consumed) and NEVER decrements on-hand supply. Same staleness
// contract as markDoseTaken: refuses a retired/deleted/cross-profile dose
// (stale-dose) or a paused item (inactive). Idempotent, and — because a
// taken→skipped change must be an explicit UI toggle, never a stale-button
// overwrite — it does NOT flip an already-resolved dose: any existing log row
// for (dose,date) is left untouched and reported by its ACTUAL status
// ("already-taken" / "already-skipped", issue #280), so a stale ⏭ tap on a
// taken dose is never answered "Skipped". Returns what actually happened so
// the tap handler answers honestly.
export function markDoseSkipped(
  profileId: number,
  doseId: number,
  _supplementId: number | null,
  date: string
): DoseTakenOutcome {
  const owned = db
    .prepare(
      `SELECT d.item_id AS item_id, s.active AS active
         FROM intake_item_doses d
         JOIN intake_items s ON s.id = d.item_id
        WHERE d.id = ? AND s.profile_id = ? AND d.retired = 0`
    )
    .get(doseId, profileId) as { item_id: number; active: number } | undefined;
  if (!owned) return "stale-dose";
  if (!owned.active) return "inactive";
  // Any existing log (taken OR skipped) means this dose is already resolved for
  // the day. A stale ⏭ tap must not overwrite a taken dose (the explicit
  // taken→skipped toggle lives in the web setDoseStatus action); an already-
  // skipped dose is an idempotent no-op. Either way: leave it, and report the
  // status that actually stands (issue #280).
  const existing = db
    .prepare(
      "SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
    )
    .get(doseId, date) as { status: DoseStatus } | undefined;
  if (existing) {
    return existing.status === "skipped" ? "already-skipped" : "already-taken";
  }
  db.prepare(
    "INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status) VALUES (?,?,?,NULL,'skipped')"
  ).run(doseId, _supplementId ?? owned.item_id, date);
  // Deliberately no decrementSupply: a skipped dose consumes nothing.
  return "skipped";
}

// Whether an intake item (supplement/med) exists for this profile — a scoped
// existence check for the Telegram refill-snooze button (issue #233), so a forged
// supplement id from a callback can't write a suppression for a row that isn't the
// profile's. Profile-scoped (WHERE id AND profile_id).
export function supplementExists(
  profileId: number,
  supplementId: number
): boolean {
  return !!db
    .prepare("SELECT 1 FROM intake_items WHERE id = ? AND profile_id = ?")
    .get(supplementId, profileId);
}

// The escalate_chat_id (caregiver chat) configured on one of the profile's
// intake items, or null. Used to AUTHORIZE an escalation-button tap (issue #233):
// a tap from this chat may confirm/ack on the profile's behalf. Profile-scoped, so
// a forged supplement id can't leak another profile's escalation chat.
export function getSupplementEscalateChatId(
  profileId: number,
  supplementId: number
): string | null {
  const row = db
    .prepare(
      "SELECT escalate_chat_id FROM intake_items WHERE id = ? AND profile_id = ?"
    )
    .get(supplementId, profileId) as
    { escalate_chat_id: string | null } | undefined;
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

// Per-dose log rows over the last `days` days, for the adherence strip. Each row
// carries its status ('taken' | 'skipped') so the strip can render a deliberate
// skip (issue #232) distinctly from a taken dose or a real miss. `since` is
// computed in the configured app timezone so it matches the strip's displayed
// columns (app/medicine lastDates() uses the same today()-based window); a UTC
// window could drop a dose on the oldest column.
export function getSupplementLogsInRange(
  profileId: number,
  days = 14
): { dose_id: number; date: string; status: DoseStatus }[] {
  const since = shiftDateStr(today(profileId), -(days - 1));
  return db
    .prepare(
      `SELECT l.dose_id, l.date, l.status FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date >= ? ORDER BY l.date`
    )
    .all(profileId, since) as {
    dose_id: number;
    date: string;
    status: DoseStatus;
  }[];
}
