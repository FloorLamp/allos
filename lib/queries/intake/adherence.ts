// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Adherence / dose-log reads and writes: taken/skipped dose sets, the idempotent
// mark-taken/skipped log writers (the notification-webhook counterparts), the
// escalation-authorization helpers, and the adherence-strip range read.
import { db, today, writeTx } from "../../db";
import {
  shiftDateStr,
  daysBetweenDateStr,
  dateStrInTz,
  utcSqlString,
  parseUtcSql,
} from "../../date";
import { getTimezone } from "../../settings";
import {
  DOSE_LOG_DATE_WINDOW_DAYS,
  isGivenAtAccepted,
} from "../../dose-log-window";
import { decrementSupply, incrementSupply } from "./refill";
import type {
  AdministrationOutcome,
  DoseStatus,
  DoseTakenOutcome,
  EscalationAckOutcome,
} from "../../types";

// A Telegram dose token carries the day the reminder was sent so a late tap still
// logs to the right calendar date — but the token is client-supplied, so an
// arbitrary past/future date must not be honored (the web path pins today()). The
// accepted-window decision lives in lib/dose-log-window (pure, unit-tested); this
// binds it to the profile's today.
function isDoseDateAccepted(profileId: number, date: string): boolean {
  const diff = daysBetweenDateStr(today(profileId), date);
  return diff != null && Math.abs(diff) <= DOSE_LOG_DATE_WINDOW_DAYS;
}

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
  // A far-off (forged) date can't land a misdated row (issue #614); a legitimate
  // late tap within the window still logs to the reminder's own day.
  if (!isDoseDateAccepted(profileId, date)) return "stale-dose";
  // The check + insert + supply decrement run as one IMMEDIATE transaction (issue
  // #616 / #468). This is now what enforces one-taken-row-per-(dose,date) for a
  // SCHEDULED dose: since #797 dropped UNIQUE(dose_id, date) to allow PRN multiples,
  // the exists-check below IS the idempotency guard. BEGIN IMMEDIATE serializes all
  // writers up front (three processes write this DB), so the SELECT-then-INSERT is
  // atomic against a concurrent web replica / notify sidecar — a double-tap or
  // Telegram retry reads the committed row and no-ops instead of inserting a second.
  return writeTx((): DoseTakenOutcome => {
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
    // The callback token's supplement id is client-supplied and NEVER trusted for
    // the write (issue #613/#614): the item is always derived from the dose row. A
    // token whose supp id contradicts the dose's real item is a forged/stale token,
    // so answer stale rather than logging (the write below uses owned.item_id).
    if (supplementId != null && supplementId !== owned.item_id) {
      return "stale-dose";
    }
    // An existing log resolves the day; report its ACTUAL status (issue #280) so
    // a ✅ tap on a dose meanwhile marked skipped is never answered "Logged".
    const existing = db
      .prepare(
        "SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as { status: DoseStatus } | undefined;
    if (existing) {
      // Don't re-decrement supply, and never overwrite a deliberate skip.
      return existing.status === "skipped"
        ? "already-skipped"
        : "already-taken";
    }
    // Snapshot the dose amount at confirm time: history must keep showing what
    // was actually taken even after a later dosage edit rewrites the dose row.
    // Always write the dose's OWN item id — never the callback token's. given_at is
    // set to now (the tap moment) for a scheduled confirm: the schedule dictates
    // WHEN, so a precise intake time isn't captured here (the PRN path is what makes
    // given_at user-suppliable). The exists-check above already guaranteed no row
    // stands for (dose,date), so this insert can't duplicate.
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, given_at)
       VALUES (?,?,?,?, datetime('now'))`
    ).run(doseId, owned.item_id, date, owned.amount);
    // Only the taken insert above (reached once, under the write lock) decrements
    // on-hand supply, once.
    decrementSupply(profileId, owned.item_id);
    return "logged";
  });
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
  supplementId: number | null,
  date: string
): DoseTakenOutcome {
  // Same forged-date guard as markDoseTaken (issue #614).
  if (!isDoseDateAccepted(profileId, date)) return "stale-dose";
  return writeTx((): DoseTakenOutcome => {
    const owned = db
      .prepare(
        `SELECT d.item_id AS item_id, s.active AS active
           FROM intake_item_doses d
           JOIN intake_items s ON s.id = d.item_id
          WHERE d.id = ? AND s.profile_id = ? AND d.retired = 0`
      )
      .get(doseId, profileId) as
      { item_id: number; active: number } | undefined;
    if (!owned) return "stale-dose";
    if (!owned.active) return "inactive";
    // The token's supp id is never trusted for the write (issue #613/#614): a
    // token contradicting the dose's real item is forged/stale.
    if (supplementId != null && supplementId !== owned.item_id) {
      return "stale-dose";
    }
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
      return existing.status === "skipped"
        ? "already-skipped"
        : "already-taken";
    }
    // Write the dose's OWN item id (never the callback token's). The exists-check
    // above (under the IMMEDIATE write lock, #797's replacement for the dropped
    // UNIQUE) guaranteed no row stands for (dose,date), so this can't duplicate.
    db.prepare(
      "INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status) VALUES (?,?,?,NULL,'skipped')"
    ).run(doseId, owned.item_id, date);
    // Deliberately no decrementSupply: a skipped dose consumes nothing.
    return "skipped";
  });
}

// ---- PRN (as-needed) administrations ledger (#797) ----

// Short window within which a second administration of the SAME dose is treated as
// a double-tap (a re-tapped widget button, a retried Telegram callback, a double
// click) rather than a second real intake. PRN logging is deliberately NOT
// idempotent — multiple/day is the whole point (#797) — so this replaces the
// dropped UNIQUE(dose_id,date) as the accidental-repeat guard, keeping a stray tap
// from inventing a phantom dose (and burning supply). Keyed on given_at PROXIMITY,
// so two retro entries at genuinely different times (4:00 and 4:30) both land while
// two taps within ~2 min collapse to one.
export const ADMIN_DEDUP_WINDOW_SEC = 120;

// Log one PRN administration of an intake item — auth-blind, profileId-first (the
// lib-write-core convention, mirroring logFoodServingCore): both the
// logMedicationAdministration Server Action (dashboard quick-log) and the Telegram
// /dose tap call this, so the ingestion path is one computation regardless of
// surface, and the auth gate stays entirely in the action. `givenAt` is the real
// intake time (undefined = now), bounded by isGivenAtAccepted (#614). Each accepted,
// non-duplicate administration is a NEW intake_item_logs row (the per-administration
// ledger) that decrements on-hand supply once. One IMMEDIATE transaction (#468) so
// the dedup read + insert + supply move see one consistent state under a concurrent
// web/Telegram tap. Returns a typed outcome so the caller answers from what actually
// happened rather than unconditionally confirming.
export function logAdministration(
  profileId: number,
  itemId: number,
  givenAt?: Date
): AdministrationOutcome {
  const tz = getTimezone(profileId);
  const when = givenAt ?? new Date();
  const todayStr = today(profileId);
  if (givenAt && !isGivenAtAccepted(tz, todayStr, when)) {
    return { kind: "invalid-time" };
  }
  const date = dateStrInTz(tz, when);
  const givenAtStr = utcSqlString(when);
  return writeTx((): AdministrationOutcome => {
    // Resolve the item's primary loggable (non-retired) dose + live state, scoped to
    // the profile through the parent item. A PRN med always has at least one dose row
    // (the item form guarantees it); its amount rides onto the log so history
    // survives a later dosage edit. Never trust the caller's itemId beyond this scope
    // check — the write uses the resolved dose's own ids.
    const dose = db
      .prepare(
        `SELECT d.id AS dose_id, d.amount AS amount, s.active AS active
           FROM intake_item_doses d
           JOIN intake_items s ON s.id = d.item_id
          WHERE s.id = ? AND s.profile_id = ? AND d.retired = 0
          ORDER BY d.sort, d.id
          LIMIT 1`
      )
      .get(itemId, profileId) as
      { dose_id: number; amount: string | null; active: number } | undefined;
    if (!dose) return { kind: "stale-item" };
    if (!dose.active) return { kind: "inactive" };

    // Double-tap guard: an existing taken administration of this dose within the
    // dedup window of the new given time is the same intent — no new row, no supply
    // move. strftime('%s') compares the stored UTC datetimes numerically.
    const dup = db
      .prepare(
        `SELECT id FROM intake_item_logs
          WHERE dose_id = ? AND status = 'taken' AND given_at IS NOT NULL
            AND ABS(strftime('%s', given_at) - strftime('%s', ?)) <= ?
          LIMIT 1`
      )
      .get(dose.dose_id, givenAtStr, ADMIN_DEDUP_WINDOW_SEC) as
      { id: number } | undefined;
    if (!dup) {
      db.prepare(
        `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, given_at)
         VALUES (?,?,?,?,?)`
      ).run(dose.dose_id, itemId, date, dose.amount, givenAtStr);
      decrementSupply(profileId, itemId);
    }
    // The item's running total + latest intake time for the day it landed on.
    const summary = db
      .prepare(
        `SELECT COUNT(*) AS count, MAX(given_at) AS last
           FROM intake_item_logs
          WHERE item_id = ? AND date = ? AND status = 'taken'`
      )
      .get(itemId, date) as { count: number; last: string | null };
    return {
      kind: dup ? "duplicate" : "logged",
      count: summary.count,
      lastGivenAt: summary.last ?? givenAtStr,
      date,
    };
  });
}

// The day's PRN administrations for one item, most-recent first — for the med
// card's "2 today · last 4:02pm" line. given_at is the real intake time; taken_at
// is when it was recorded. Profile-scoped via the parent item (the denormalized
// item_id, kept consistent by migration 011).
export function getAdministrationsForItemOnDate(
  profileId: number,
  itemId: number,
  date: string
): {
  id: number;
  given_at: string | null;
  taken_at: string;
  amount: string | null;
}[] {
  return db
    .prepare(
      `SELECT l.id, l.given_at, l.taken_at, l.amount
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ? AND l.date = ?
          AND l.status = 'taken'
        ORDER BY COALESCE(l.given_at, l.taken_at) DESC, l.id DESC`
    )
    .all(profileId, itemId, date) as {
    id: number;
    given_at: string | null;
    taken_at: string;
    amount: string | null;
  }[];
}

// PRN administration history for the med's OWN detail page (#851 item 13): every
// administration on/after `sinceDate`, most recent first, so the page can answer "how
// often last month" — the card alone shows only TODAY. Profile-scoped via the parent
// item. Returns the intake time (given_at ?? taken_at) + amount for grouping/formatting
// in the profile's timezone at the call site.
export function getPrnAdministrationHistory(
  profileId: number,
  itemId: number,
  sinceDate: string
): {
  date: string;
  given_at: string | null;
  taken_at: string;
  amount: string | null;
}[] {
  return db
    .prepare(
      `SELECT l.date, l.given_at, l.taken_at, l.amount
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ? AND l.status = 'taken'
          AND l.date >= ?
        ORDER BY l.date DESC, COALESCE(l.given_at, l.taken_at) DESC, l.id DESC`
    )
    .all(profileId, itemId, sinceDate) as {
    date: string;
    given_at: string | null;
    taken_at: string;
    amount: string | null;
  }[];
}

// ---- Undoable PRN administration delete (issue #851 item 11) ----
//
// A fat-fingered PRN Log tap is otherwise PERMANENT and NOT cosmetic: the phantom
// administration decremented on-hand supply, ADVANCED the redose window (the next real
// dose shows "wait 6h" off a dose never given — a safety-relevant inversion), and
// counted toward the daily max. Removing it must invert EVERY side effect (the row-ops
// discipline). Because the window/count are DERIVED from the ledger rows (see
// prn-redose.ts / med-data.ts), deleting the row auto-recomputes them — the only stored
// side effect to invert is supply. The notify one-shot marker (notify_last_redose_*) is
// id-keyed and never recycles, so a stale marker after a delete is a harmless dead ref.
//
// Kind 'administration' in deleted_rows (the shared 24h-purged holding table); restore
// re-inserts the ledger row (NEW id) and RE-decrements supply. The undo toast +
// undoDelete action route restore back here via restoreDeletedRow's kind branch.

// The captured shape of one administration row (the deleted_rows payload for kind
// 'administration'). item_id + the log's own columns, enough to re-insert it verbatim.
interface CapturedAdministration {
  dose_id: number;
  item_id: number;
  date: string;
  taken_at: string;
  given_at: string | null;
  amount: string | null;
  status: string;
}

// Delete one PRN administration (an intake_item_logs row) with capture-for-undo, and
// invert its supply decrement. Auth-blind, profileId-first. Ownership is verified via
// the parent item's profile_id (the ledger has no profile_id column). Returns the undo
// token (deleted_rows id) or null when the row isn't the profile's / is gone. One
// IMMEDIATE transaction so the capture + delete + supply re-credit commit together.
export function deleteAdministrationLog(
  profileId: number,
  logId: number
): number | null {
  return writeTx((): number | null => {
    const row = db
      .prepare(
        `SELECT l.id, l.dose_id, l.item_id, l.date, l.taken_at, l.given_at,
                l.amount, l.status
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE l.id = ? AND s.profile_id = ?`
      )
      .get(logId, profileId) as
      (CapturedAdministration & { id: number }) | undefined;
    if (!row) return null;

    const captured: CapturedAdministration = {
      dose_id: row.dose_id,
      item_id: row.item_id,
      date: row.date,
      taken_at: row.taken_at,
      given_at: row.given_at,
      amount: row.amount,
      status: row.status,
    };
    const info = db
      .prepare(
        `INSERT INTO deleted_rows (profile_id, kind, label, payload)
         VALUES (?, 'administration', 'administration', ?)`
      )
      .run(profileId, JSON.stringify({ administration: captured }));

    db.prepare(`DELETE FROM intake_item_logs WHERE id = ?`).run(logId);
    // Invert the supply decrement the administration applied (a 'taken' row consumed
    // supply). incrementSupply is a no-op when quantity_on_hand IS NULL (untracked).
    if (row.status === "taken") incrementSupply(profileId, row.item_id);
    return Number(info.lastInsertRowid);
  });
}

// Restore a captured PRN administration from its undo token (routed here by
// restoreDeletedRow's kind branch). Re-inserts the ledger row (NEW id) and RE-applies
// the supply decrement (the inverse of the delete's re-credit), then drops the holding
// row — all in one IMMEDIATE transaction. Returns false when the token is gone (already
// restored / swept / another profile's) or the parent dose no longer exists (the med
// was deleted since), so a stale undo can't resurrect a dangling ledger row.
export function restoreAdministrationLog(
  profileId: number,
  undoId: number
): boolean {
  return writeTx((): boolean => {
    const holding = db
      .prepare(
        `SELECT payload FROM deleted_rows
          WHERE id = ? AND profile_id = ? AND kind = 'administration'`
      )
      .get(undoId, profileId) as { payload: string } | undefined;
    if (!holding) return false;

    let captured: CapturedAdministration;
    try {
      captured = (JSON.parse(holding.payload) as { administration: unknown })
        .administration as CapturedAdministration;
    } catch {
      return false;
    }
    // The parent dose must still exist and belong to this profile (the med may have
    // been deleted since the capture — its ledger rows would have cascaded away).
    const dose = db
      .prepare(
        `SELECT 1 FROM intake_item_doses d
           JOIN intake_items s ON s.id = d.item_id
          WHERE d.id = ? AND d.item_id = ? AND s.profile_id = ?`
      )
      .get(captured.dose_id, captured.item_id, profileId);
    if (!dose) return false;

    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, taken_at, given_at, amount, status)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      captured.dose_id,
      captured.item_id,
      captured.date,
      captured.taken_at,
      captured.given_at,
      captured.amount,
      captured.status
    );
    if (captured.status === "taken") {
      decrementSupply(profileId, captured.item_id);
    }
    db.prepare(`DELETE FROM deleted_rows WHERE id = ? AND profile_id = ?`).run(
      undoId,
      profileId
    );
    return true;
  });
}

// ---- PRN redose notice (#798) ----

// An opted-in PRN med with CONFIRMED redose fields, for the notify tick's one-shot
// redose notice. Only items with redose_notice=1 AND both min_interval_hours and
// max_daily_count set are returned — an unconfirmed/empty field means no notice, ever
// (the liability gate lives HERE, in the gather, so the pure decision can assume
// valid positives). Active PRN medications only.
export interface RedoseNoticeItem {
  id: number;
  name: string;
  minIntervalHours: number;
  maxDailyCount: number;
}

export function getRedoseNoticeItems(profileId: number): RedoseNoticeItem[] {
  return db
    .prepare(
      `SELECT id, name,
              min_interval_hours AS minIntervalHours,
              max_daily_count AS maxDailyCount
         FROM intake_items
        WHERE profile_id = ? AND active = 1 AND kind = 'medication'
          AND as_needed = 1 AND redose_notice = 1
          AND min_interval_hours IS NOT NULL AND min_interval_hours > 0
          AND max_daily_count IS NOT NULL AND max_daily_count > 0
        ORDER BY name`
    )
    .all(profileId) as RedoseNoticeItem[];
}

// The arming state for one PRN item's redose one-shot: the latest administration's id
// + its intake time (arms/re-arms the timer, keyed by id per the notify_last_*
// discipline) and today's administration count (drives the "N of M" + max
// suppression). Profile-scoped via the parent item. `date` is the profile-local day.
export interface RedoseArmingState {
  latestId: number | null;
  latestGivenAt: string | null;
  countToday: number;
}

export function getRedoseArmingState(
  profileId: number,
  itemId: number,
  date: string
): RedoseArmingState {
  // The most-recent administration (by intake time, id as tiebreak) that arms the
  // one-shot. Scoped through the parent item so a forged itemId can't read across
  // profiles.
  const latest = db
    .prepare(
      `SELECT l.id AS id, l.given_at AS givenAt
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ? AND l.status = 'taken'
          AND l.given_at IS NOT NULL
        ORDER BY l.given_at DESC, l.id DESC
        LIMIT 1`
    )
    .get(profileId, itemId) as { id: number; givenAt: string } | undefined;
  const count = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ? AND l.date = ?
          AND l.status = 'taken'`
    )
    .get(profileId, itemId, date) as { n: number };
  return {
    latestId: latest?.id ?? null,
    latestGivenAt: latest?.givenAt ?? null,
    countToday: count.n,
  };
}

// A PRN med whose today's administration count has EXCEEDED its confirmed daily max
// (#798) — the input to the over-max care finding (the #148 UL-warning shape applied
// per-day). Only items with a confirmed max_daily_count are considered; "over" is
// strictly greater than the max (you've logged MORE than the label allows today).
// Amount-aware mg accounting (sum of administered mg vs a mg ceiling) is a noted
// follow-up; the confirmed COUNT is the reliable signal and what the finding uses.
export interface PrnOverMaxItem {
  id: number;
  name: string;
  count: number;
  maxDailyCount: number;
}

export function getPrnOverMaxItems(
  profileId: number,
  date: string
): PrnOverMaxItem[] {
  return db
    .prepare(
      `SELECT id, name, count, maxDailyCount FROM (
         SELECT s.id AS id, s.name AS name,
                (SELECT COUNT(*) FROM intake_item_logs l
                  WHERE l.item_id = s.id AND l.date = ? AND l.status = 'taken')
                  AS count,
                s.max_daily_count AS maxDailyCount
           FROM intake_items s
          WHERE s.profile_id = ? AND s.active = 1
            AND s.as_needed = 1 AND s.kind = 'medication'
            AND s.max_daily_count IS NOT NULL AND s.max_daily_count > 0
       )
       WHERE count > maxDailyCount
       ORDER BY name`
    )
    .all(date, profileId) as PrnOverMaxItem[];
}

// One PRN med surfaced for one-tap logging (dashboard widget + med card): its id,
// name, and today's administration count + latest intake time. Since #798 it also
// carries the confirmed redose interval/max (null when not configured) so the widget
// can render a marker-agnostic "redose open / next in ~Xh" status line without a
// second query (the same window math the notice uses, via redoseWindowStatus).
export interface PrnMedForQuickLog {
  id: number;
  name: string;
  count: number;
  lastGivenAt: string | null;
  minIntervalHours: number | null;
  maxDailyCount: number | null;
}

// Active PRN (as-needed) medications for the quick-log widget, each with today's
// administration count + latest intake time. Recently-used float to the top (most
// recent last-administration first — the widget's "recently-used" ordering), then
// alphabetical. One profile-scoped read so the widget and any other surface agree.
export function getPrnMedicationsForQuickLog(
  profileId: number
): PrnMedForQuickLog[] {
  const date = today(profileId);
  return db
    .prepare(
      `SELECT s.id AS id, s.name AS name,
              (SELECT COUNT(*) FROM intake_item_logs l
                WHERE l.item_id = s.id AND l.date = ? AND l.status = 'taken')
                AS count,
              (SELECT MAX(COALESCE(l.given_at, l.taken_at)) FROM intake_item_logs l
                WHERE l.item_id = s.id AND l.status = 'taken')
                AS lastGivenAt,
              s.min_interval_hours AS minIntervalHours,
              s.max_daily_count AS maxDailyCount
         FROM intake_items s
        WHERE s.profile_id = ? AND s.active = 1
          AND s.as_needed = 1 AND s.kind = 'medication'
        ORDER BY (lastGivenAt IS NULL), lastGivenAt DESC, s.name`
    )
    .all(date, profileId) as PrnMedForQuickLog[];
}

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

// The escalate_chat_id (caregiver chat) of the supplement a specific DOSE belongs
// to, or null. This is the authorization anchor for an escalation tap (issue #615):
// the caregiver chat that authorizes a tap must be the one routed to the SUPPLEMENT
// the tapped dose actually belongs to — NOT whatever supp id the client-supplied
// token names. Deriving the chat from the dose row (profile-scoped through the
// parent item) closes the widening where a token could pair one supplement's
// escalate chat with a different supplement's dose. Returns null for a dose that
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
