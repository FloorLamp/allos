// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Adherence / dose-log reads and writes: taken/skipped dose sets, the idempotent
// mark-taken/skipped log writers (the notification-webhook counterparts), the
// escalation-authorization helpers, and the adherence-strip range read.
import { db, today, writeTx } from "../../db";
import {
  cadenceOn,
  doseOnDay,
  type DoseCadence,
  type ItemCadence,
} from "../../intake-cadence";
import { now as clockNow, sqlNow } from "../../clock";
import {
  shiftDateStr,
  dateStrInTz,
  utcSqlString,
  parseUtcSql,
} from "../../date";
import { getTimezone, setProfileSetting } from "../../settings";
import { escalationMarkerKey } from "../../notifications/escalation-keys";
import {
  isDoseDateAccepted as isDoseDateInWindow,
  isGivenAtAccepted,
  isHistoricalDoseTimeAccepted,
  resolveQueuedTakenAt,
} from "../../dose-log-window";
import {
  burstFrom,
  correctionBursts,
  CORRECTION_FRESH_MIN,
  type CorrectionBurst,
} from "../../correction-time";
import { decrementSupply, incrementSupply } from "./refill";
import { getMedicationFamilyStates } from "./prn-family";
import type { PrnDayExposure, PrnExposureBasis } from "../../prn-redose";
import type {
  AdministrationOutcome,
  DoseStatus,
  DoseTakenOutcome,
  EscalationAckOutcome,
  HistoricalDoseOutcome,
} from "../../types";
import type { IntakeObligation } from "../../types";
import { isOfferedOn, slotHintCoversNow } from "../../supplement-schedule";
import { formatMedicationDoseProduct } from "../../medication-dose-format";
import { getSituations } from "../../settings";
import { getEffectiveActiveSituations } from "../derived-situations";
import { getActivitiesByDate, isPredictedWorkoutDay } from "../training";
import type { SupplementCondition, SupplementKind } from "../../types";

// A Telegram dose token carries the day the reminder was sent so a late tap still
// logs to the right calendar date — but the token is client-supplied, so an
// arbitrary past/future date must not be honored (the web path pins today()). The
// accepted-window decision lives in lib/dose-log-window (pure, unit-tested); this
// binds it to the profile's today.
function isDoseDateAccepted(profileId: number, date: string): boolean {
  return isDoseDateInWindow(today(profileId), date);
}

// ---- The no-rearm rule (#1933 × #328 × the attention doctrine) --------------
//
// A historical write may UN-MARK a dose for a day: deleting its taken ledger row, or
// moving that row onto a different date. The dose then reads unconfirmed for the day
// it left behind — and the hourly missed-dose escalation would be free to chase it.
//
// That is the one thing a history correction must never do. The attention doctrine's
// contact-consent rule is asymmetric: the system may reduce contact unilaterally, but
// it may never INCREASE it off its own reading of state. Un-marking yesterday's (or
// this morning's) dose is a bookkeeping correction, not a request to be chased.
//
// So every un-marking write stamps the dose's date-keyed escalation marker (#328) for
// the day it vacated, exactly as a real escalation or a caregiver's "👍 I'm on it" ack
// would. The tick's `escalatedDoseIds` check then treats that day as already handled
// and fires nothing. The marker only ever suppresses, and only for the ONE date it
// names, so a genuine miss on any other day still escalates normally.
//
// The inverse write (restoreAdministrationLog) deliberately does NOT clear the marker:
// the restored row re-confirms the dose anyway, and clearing would be the system
// re-arming contact — the direction the rule forbids.
function suppressEscalationRearm(
  profileId: number,
  doseId: number,
  date: string
): void {
  setProfileSetting(profileId, escalationMarkerKey(doseId), date);
}

// Intake item ids with at least one dose actually TAKEN on `date` (item-level view for
// the dashboard / AI summary). Kind-neutral: supplements and medications share one
// ledger, so this serves both (it was named getIntakeLogsForDate until #1933 —
// a shared read named for one of its two subjects invites a caller to go looking for
// "the other one"). A skipped dose (issue #232) is not "taken", so it's excluded.
export function getIntakeLogsForDate(
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

// Actual administration timestamp for each scheduled dose taken on `date`, scoped
// through the dose's parent item. Scheduled doses have at most one taken row per
// (dose,date); ordering newest-first also makes this safe for older data that predates
// that invariant. The UI formats the stored UTC value in the profile timezone.
export function getTakenDoseTimes(
  profileId: number,
  date: string
): Map<number, string> {
  const rows = db
    .prepare(
      `SELECT l.dose_id, COALESCE(l.given_at, l.taken_at) AS taken_at
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date = ? AND l.status = 'taken'
        ORDER BY COALESCE(l.given_at, l.taken_at) DESC, l.id DESC`
    )
    .all(profileId, date) as { dose_id: number; taken_at: string }[];
  const out = new Map<number, string>();
  for (const row of rows) {
    if (!out.has(row.dose_id)) out.set(row.dose_id, row.taken_at);
  }
  return out;
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
//
// `takenAt` (#1427) is an OPTIONAL captured intake instant, supplied only by the
// offline write queue's replay: the tap happened when the user actually took the
// dose, possibly hours before the connection came back, so the log is stamped with
// that moment instead of the replay one. It is validated (never trusted) by the pure
// resolveQueuedTakenAt and silently falls back to the server's own now when unusable
// — a skewed phone clock must cost the precise minute, never the dose log. Every
// other caller omits it and behaves byte-identically to before.
export function markDoseTaken(
  profileId: number,
  doseId: number,
  supplementId: number | null,
  date: string,
  takenAt?: Date
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
                d.weekdays AS weekdays, d.start_date AS start_date,
                d.end_date AS end_date,
                s.active AS active, s.cadence_kind AS cadence_kind,
                s.cadence_weekdays AS cadence_weekdays,
                s.cadence_interval_days AS cadence_interval_days,
                s.cadence_anchor_date AS cadence_anchor_date
           FROM intake_item_doses d
           JOIN intake_items s ON s.id = d.item_id
          WHERE d.id = ? AND s.profile_id = ? AND d.retired = 0`
      )
      .get(doseId, profileId) as
      | ({
          item_id: number;
          amount: string | null;
          active: number;
        } & ItemCadence &
          DoseCadence)
      | undefined;
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
    // the tap moment for a scheduled confirm: the schedule dictates WHEN, so a
    // precise intake time isn't captured here (the PRN path is what makes given_at
    // user-suppliable) — EXCEPT for a replayed offline confirm, whose tap moment was
    // captured on the client and validated above (#1427). An unusable/absent stamp
    // COALESCEs to the server's own now, exactly as before — but from the CLOCK SEAM
    // (sqlNow, #1534), not SQL's `datetime('now')`: `date` above came from `today()`,
    // so a real-clock fallback would write a self-contradicting row (a given_at whose
    // profile-local date isn't the row's own date) on any run that crosses midnight.
    // The exists-check above already guaranteed no row stands for (dose,date), so
    // this insert can't duplicate.
    const stamp = resolveQueuedTakenAt(
      takenAt,
      getTimezone(profileId),
      date,
      // Real time on purpose: a clock-skew comparison, not a date derivation.
      new Date()
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, given_at)
       VALUES (?,?,?,?, COALESCE(?, ?))`
    ).run(
      doseId,
      owned.item_id,
      date,
      owned.amount,
      stamp ? utcSqlString(stamp) : null,
      sqlNow()
    );
    // Only the taken insert above (reached once, under the write lock) decrements
    // on-hand supply, once.
    decrementSupply(profileId, owned.item_id);
    // The log is written either way — reality is reality. What changes is the ANSWER
    // (#1602): an off-cadence confirm reports itself so the handler can say which days
    // the dose was meant for instead of a bare ✓. Evaluated on the LOG'S date, not
    // today: a late tap on yesterday's reminder is judged against yesterday.
    const onDay =
      cadenceOn(owned, date) && doseOnDay(owned, date)
        ? "logged"
        : ("logged-off-day" as const);
    return onDay;
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
  const when = givenAt ?? clockNow();
  const todayStr = today(profileId);
  if (givenAt && !isGivenAtAccepted(tz, todayStr, when, clockNow())) {
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

// Whether this item keeps a medication-course timeline at all (#1933). A medication
// is given one at add time, so its historical writes stay bounded by its courses; a
// supplement has none, so there is no course for its history to fall outside of. The
// question is asked of the DATA, never of `kind`: the bound is "this item's recorded
// courses", and an item with no courses is unbounded rather than un-editable — which
// is also why a course-less legacy medication stops answering `outside-course` to
// every backfill. Profile-scoped through the parent item.
function itemHasCourses(profileId: number, itemId: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM medication_courses c
         JOIN intake_items s ON s.id = c.item_id
        WHERE c.item_id = ? AND s.profile_id = ? LIMIT 1`
    )
    .get(itemId, profileId);
}

// Backfill one taken dose at an explicit profile-local date/time. This is
// intentionally separate from reminder/quick-log ingestion: a deliberate history edit
// may reach any past date inside a medication course, including a stopped course,
// while stale buttons keep their tighter two-day bound.
//
// KIND-NEUTRAL since #1933 (it was logHistoricalMedicationDose, with `s.kind =
// 'medication'` in its ownership SELECT). Historical dose correction IS adherence
// machinery, which supplements and medications share by rule, and `kind` decides
// clinical identity — which safety engine, which surface, passport inclusion — not
// what a user may do (#1664). The kind predicate also made the refusal LIE: a
// supplement dose came back `stale-dose` ("that dose doesn't exist") when the truth
// was "this core refuses your kind".
//
// What replaces it is a data question, not a kind question: the medication-course
// window applies to an item that HAS courses. Every medication gets one at add time;
// a supplement has none and therefore has no course to fall outside of. A PRN dose is
// also evidence that its course had already begun: when it predates the next
// applicable course, that course's start moves back to the administration date in the
// SAME transaction as the log. Scheduled courses retain strict boundaries.
//
// `d.retired = 0` stays, and is correct HERE and only here: a backfill CREATES a log
// against a dose row, so that row must still be part of the schedule. Editing a log
// whose dose was since retired is a different question, answered in updateHistoricalDose.
//
// The selected live dose anchors scheduled-day identity; amountOverride is snapshotted
// onto the row exactly as a live confirm snapshots it, so history keeps showing what
// was actually taken after a later dosage edit — and without touching the schedule.
// Supply movement is explicit because an older dose may predate a later refill or
// inventory reconciliation; when requested it runs through the shared decrementSupply,
// so a pooled item (#1374) draws the household bottle down, identically for both kinds.
export function logHistoricalDose(
  profileId: number,
  itemId: number,
  doseId: number,
  givenAt: Date,
  amountOverride: string | null,
  adjustSupply: boolean
): HistoricalDoseOutcome {
  const tz = getTimezone(profileId);
  const todayStr = today(profileId);
  if (!isHistoricalDoseTimeAccepted(tz, todayStr, givenAt)) {
    return { kind: "invalid-time" };
  }
  const date = dateStrInTz(tz, givenAt);
  const givenAtStr = utcSqlString(givenAt);

  return writeTx((): HistoricalDoseOutcome => {
    const dose = db
      .prepare(
        `SELECT d.item_id, d.amount, s.obligation
           FROM intake_item_doses d
           JOIN intake_items s ON s.id = d.item_id
          WHERE d.id = ? AND d.item_id = ? AND d.retired = 0
            AND s.profile_id = ?`
      )
      .get(doseId, itemId, profileId) as
      | { item_id: number; amount: string | null; obligation: IntakeObligation }
      | undefined;
    if (!dose) return { kind: "stale-dose" };

    const inCourse =
      !itemHasCourses(profileId, itemId) ||
      !!db
        .prepare(
          `SELECT 1
             FROM medication_courses c
             JOIN intake_items s ON s.id = c.item_id
            WHERE c.item_id = ? AND s.profile_id = ?
              AND (c.started_on IS NULL OR c.started_on <= ?)
              AND (c.stopped_on IS NULL OR c.stopped_on >= ?)
            LIMIT 1`
        )
        .get(itemId, profileId, date, date);

    // PRN use can legitimately predate the date first entered in the app. Find the
    // next course that this administration can extend backward; stopped courses are
    // eligible only when the chosen date is on/before their stop. The update waits
    // until duplicate/status validation succeeds so a rejected log never mutates the
    // course. Profile ownership is enforced through the parent on both statements.
    const courseToExtend =
      !inCourse && dose.obligation === "may"
        ? (db
            .prepare(
              `SELECT c.id
                 FROM medication_courses c
                 JOIN intake_items s ON s.id = c.item_id
                WHERE c.item_id = ? AND s.profile_id = ?
                  AND c.started_on IS NOT NULL AND c.started_on > ?
                  AND (c.stopped_on IS NULL OR c.stopped_on >= ?)
                ORDER BY c.started_on ASC, c.id ASC
                LIMIT 1`
            )
            .get(itemId, profileId, date, date) as { id: number } | undefined)
        : undefined;
    if (!inCourse && !courseToExtend) return { kind: "outside-course" };

    if (dose.obligation !== "may") {
      const existing = db
        .prepare(
          `SELECT l.status
             FROM intake_item_logs l
             JOIN intake_items s ON s.id = l.item_id
            WHERE l.dose_id = ? AND l.date = ? AND s.profile_id = ?
            ORDER BY l.id LIMIT 1`
        )
        .get(doseId, date, profileId) as { status: DoseStatus } | undefined;
      if (existing) {
        return {
          kind:
            existing.status === "skipped" ? "already-skipped" : "already-taken",
        };
      }
    } else {
      const duplicate = db
        .prepare(
          `SELECT l.id
             FROM intake_item_logs l
             JOIN intake_items s ON s.id = l.item_id
            WHERE l.dose_id = ? AND l.status = 'taken'
              AND s.profile_id = ? AND l.given_at IS NOT NULL
              AND ABS(strftime('%s', l.given_at) - strftime('%s', ?)) <= ?
            LIMIT 1`
        )
        .get(doseId, profileId, givenAtStr, ADMIN_DEDUP_WINDOW_SEC);
      if (duplicate) return { kind: "duplicate" };
    }

    const amount = amountOverride?.trim() || dose.amount;
    if (courseToExtend) {
      db.prepare(
        `UPDATE medication_courses
            SET started_on = ?
          WHERE id = ? AND item_id = ?
            AND EXISTS (
              SELECT 1 FROM intake_items s
               WHERE s.id = medication_courses.item_id
                 AND s.profile_id = ? AND s.kind = 'medication'
            )`
      ).run(date, courseToExtend.id, itemId, profileId);
    }
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, amount, given_at, supply_adjusted)
       VALUES (?,?,?,?,?,?)`
    ).run(doseId, itemId, date, amount, givenAtStr, adjustSupply ? 1 : 0);
    if (adjustSupply) decrementSupply(profileId, itemId);
    return { kind: "logged", date };
  });
}

// Edit one existing taken ledger row (kind-neutral since #1933, for the same reasons
// as logHistoricalDose above). Date/course rules mirror it, including moving a PRN
// course start backward only after uniqueness checks pass. Scheduled edits retain one
// status row per dose/date; PRN edits retain the per-administration time dedup.
//
// RETIRED DOSES AND PAUSED ITEMS STAY EDITABLE — deliberately, and unlike the create
// path. `d.retired = 0` answers "may this dose still be scheduled onto a new day",
// which is the wrong question for a row that already exists: the schedule was retired,
// but the dose was really taken and the ledger entry is still a fact. Same for a paused
// item — pausing stops future dueness, it does not make past history unamendable. So
// this SELECT joins intake_item_doses for its amount WITHOUT a retired predicate and
// never looks at `s.active`.
//
// THE SCHEDULE IS NEVER TOUCHED. The only rows this writes are the ledger row itself
// and (for a `may` medication reaching back before its course) medication_courses.
// started_on — the course's own timeline, not the dose schedule. intake_item_doses is
// read-only here, so correcting when or how much was taken can never rewrite what is
// scheduled, in either direction.
//
// SUPPLY IS UNCHANGED, which is the correct re-diff and not an omission: the counter
// moves in UNITS (the item's qty_per_dose), while `amount` is the free-text label
// snapshotted onto the row ("500 mg"). One administration stays one administration
// however its label or wall time is corrected, so the diff between old and new state
// is zero units and applying anything would be a second, invented movement. The
// non-zero supply diffs live where the ROW's existence changes — deleteAdministrationLog
// credits its decrement back, restoreAdministrationLog re-applies it — and those two
// are exact inverses.
export function updateHistoricalDose(
  profileId: number,
  itemId: number,
  logId: number,
  givenAt: Date,
  amountOverride: string | null
): HistoricalDoseOutcome {
  const tz = getTimezone(profileId);
  const todayStr = today(profileId);
  if (!isHistoricalDoseTimeAccepted(tz, todayStr, givenAt)) {
    return { kind: "invalid-time" };
  }
  const date = dateStrInTz(tz, givenAt);
  const givenAtStr = utcSqlString(givenAt);

  return writeTx((): HistoricalDoseOutcome => {
    const row = db
      .prepare(
        `SELECT l.dose_id, l.date AS old_date, l.amount,
                d.amount AS dose_amount, s.obligation
           FROM intake_item_logs l
           JOIN intake_item_doses d ON d.id = l.dose_id
           JOIN intake_items s ON s.id = l.item_id
          WHERE l.id = ? AND l.item_id = ? AND l.status = 'taken'
            AND s.profile_id = ?`
      )
      .get(logId, itemId, profileId) as
      | {
          dose_id: number;
          old_date: string;
          amount: string | null;
          dose_amount: string | null;
          obligation: IntakeObligation;
        }
      | undefined;
    if (!row) return { kind: "stale-dose" };

    const inCourse =
      !itemHasCourses(profileId, itemId) ||
      !!db
        .prepare(
          `SELECT 1
             FROM medication_courses c
             JOIN intake_items s ON s.id = c.item_id
            WHERE c.item_id = ? AND s.profile_id = ?
              AND (c.started_on IS NULL OR c.started_on <= ?)
              AND (c.stopped_on IS NULL OR c.stopped_on >= ?)
            LIMIT 1`
        )
        .get(itemId, profileId, date, date);
    const courseToExtend =
      !inCourse && row.obligation === "may"
        ? (db
            .prepare(
              `SELECT c.id
                 FROM medication_courses c
                 JOIN intake_items s ON s.id = c.item_id
                WHERE c.item_id = ? AND s.profile_id = ?
                  AND c.started_on IS NOT NULL AND c.started_on > ?
                  AND (c.stopped_on IS NULL OR c.stopped_on >= ?)
                ORDER BY c.started_on ASC, c.id ASC
                LIMIT 1`
            )
            .get(itemId, profileId, date, date) as { id: number } | undefined)
        : undefined;
    if (!inCourse && !courseToExtend) return { kind: "outside-course" };

    if (row.obligation !== "may") {
      const existing = db
        .prepare(
          `SELECT l.status
             FROM intake_item_logs l
             JOIN intake_items s ON s.id = l.item_id
            WHERE l.dose_id = ? AND l.date = ? AND l.id <> ?
              AND s.profile_id = ?
            ORDER BY l.id LIMIT 1`
        )
        .get(row.dose_id, date, logId, profileId) as
        { status: DoseStatus } | undefined;
      if (existing) {
        return {
          kind:
            existing.status === "skipped" ? "already-skipped" : "already-taken",
        };
      }
    } else {
      const duplicate = db
        .prepare(
          `SELECT l.id
             FROM intake_item_logs l
             JOIN intake_items s ON s.id = l.item_id
            WHERE l.dose_id = ? AND l.id <> ? AND l.status = 'taken'
              AND s.profile_id = ? AND l.given_at IS NOT NULL
              AND ABS(strftime('%s', l.given_at) - strftime('%s', ?)) <= ?
            LIMIT 1`
        )
        .get(row.dose_id, logId, profileId, givenAtStr, ADMIN_DEDUP_WINDOW_SEC);
      if (duplicate) return { kind: "duplicate" };
    }

    if (courseToExtend) {
      db.prepare(
        `UPDATE medication_courses
            SET started_on = ?
          WHERE id = ? AND item_id = ?
            AND EXISTS (
              SELECT 1 FROM intake_items s
               WHERE s.id = medication_courses.item_id
                 AND s.profile_id = ? AND s.kind = 'medication'
            )`
      ).run(date, courseToExtend.id, itemId, profileId);
    }
    const amount = amountOverride?.trim() || row.dose_amount;
    db.prepare(
      `UPDATE intake_item_logs
          SET date = ?, given_at = ?, amount = ?
        WHERE id = ? AND item_id = ?
          AND EXISTS (
            SELECT 1 FROM intake_items s
             WHERE s.id = intake_item_logs.item_id AND s.profile_id = ?
          )`
    ).run(date, givenAtStr, amount, logId, itemId, profileId);
    // Moving the row off its old date un-marks the dose for that day, so the day it
    // vacated is stamped handled and can never be chased (see suppressEscalationRearm).
    if (row.old_date !== date) {
      suppressEscalationRearm(profileId, row.dose_id, row.old_date);
    }
    return { kind: "logged", date };
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
  product: string | null;
}[] {
  return db
    .prepare(
      `SELECT l.id, l.given_at, l.taken_at, l.amount, l.product
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
    product: string | null;
  }[];
}

// Batched form of getAdministrationsForItemOnDate for the medications Today panel
// (#885): the day's PRN administrations for a SET of items in one query, grouped into a
// Map<itemId, admins[]>, so the card builder derives each PRN med's day-summary in JS
// instead of issuing one query per PRN item (an N+1 over the append-only, un-purged
// intake_item_logs ledger). Same per-item ordering (most-recent intake first) and same
// profile-scoping via the parent item as the single-item version. Empty ids → empty map.
export function getAdministrationsForItemsOnDate(
  profileId: number,
  itemIds: number[],
  date: string
): Map<
  number,
  {
    id: number;
    given_at: string | null;
    taken_at: string;
    amount: string | null;
    product: string | null;
  }[]
> {
  const out = new Map<
    number,
    {
      id: number;
      given_at: string | null;
      taken_at: string;
      amount: string | null;
      product: string | null;
    }[]
  >();
  if (itemIds.length === 0) return out;
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT l.item_id, l.id, l.given_at, l.taken_at, l.amount, l.product
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id IN (${placeholders}) AND l.date = ?
          AND l.status = 'taken'
        ORDER BY COALESCE(l.given_at, l.taken_at) DESC, l.id DESC`
    )
    .all(profileId, ...itemIds, date) as {
    item_id: number;
    id: number;
    given_at: string | null;
    taken_at: string;
    amount: string | null;
    product: string | null;
  }[];
  for (const r of rows) {
    const arr = out.get(r.item_id) ?? [];
    arr.push({
      id: r.id,
      given_at: r.given_at,
      taken_at: r.taken_at,
      amount: r.amount,
      product: r.product,
    });
    out.set(r.item_id, arr);
  }
  return out;
}

// One taken ledger row as the dose-history surfaces render it.
export interface IntakeDoseHistoryRow {
  id: number;
  dose_id: number;
  date: string;
  given_at: string | null;
  taken_at: string;
  amount: string | null;
  product: string | null;
}

// Taken-dose history for one item's history surface: scheduled and PRN ledger rows
// on/after `sinceDate`, most recent first. The medication detail page passes its
// earliest course date for bounded scheduled courses and the ISO floor for
// open-ended/PRN history. Returns exact intake time + snapshotted amount for
// formatting at the call site. Kind-neutral (it was getIntakeDoseHistory until
// #1933, when the supplements surface gained the same history panel).
export function getIntakeDoseHistory(
  profileId: number,
  itemId: number,
  sinceDate: string
): IntakeDoseHistoryRow[] {
  return db
    .prepare(
      `SELECT l.id, l.dose_id, l.date, l.given_at, l.taken_at, l.amount, l.product
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ? AND l.status = 'taken'
          AND l.date >= ?
        ORDER BY l.date DESC, COALESCE(l.given_at, l.taken_at) DESC, l.id DESC`
    )
    .all(profileId, itemId, sinceDate) as IntakeDoseHistoryRow[];
}

// Batched form of getIntakeDoseHistory for the supplements tab (#1933): every listed
// item's recent taken rows in ONE query, grouped into a Map<itemId, rows[]>, so a page
// rendering dozens of supplement rows doesn't issue one history query per item (the
// #885 treatment of the same N+1 over this append-only ledger). Same ordering and same
// profile-scoping through the parent item as the single-item read. Empty ids → empty map.
export function getIntakeDoseHistoryForItems(
  profileId: number,
  itemIds: number[],
  sinceDate: string
): Map<number, IntakeDoseHistoryRow[]> {
  const out = new Map<number, IntakeDoseHistoryRow[]>();
  if (itemIds.length === 0) return out;
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT l.id, l.dose_id, l.item_id, l.date, l.given_at, l.taken_at,
              l.amount, l.product
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id IN (${placeholders})
          AND l.status = 'taken' AND l.date >= ?
        ORDER BY l.date DESC, COALESCE(l.given_at, l.taken_at) DESC, l.id DESC`
    )
    .all(profileId, ...itemIds, sinceDate) as (IntakeDoseHistoryRow & {
    item_id: number;
  })[];
  for (const r of rows) {
    const arr = out.get(r.item_id) ?? [];
    arr.push({
      id: r.id,
      dose_id: r.dose_id,
      date: r.date,
      given_at: r.given_at,
      taken_at: r.taken_at,
      amount: r.amount,
      product: r.product,
    });
    out.set(r.item_id, arr);
  }
  return out;
}

// ---- Undoable medication administration delete (issue #851 item 11) ----
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
  product: string | null;
  status: string;
  supply_adjusted: number;
}

// Delete one taken administration (an intake_item_logs row) with capture-for-undo, and
// invert its supply decrement only when that row originally changed supply. Auth-blind,
// profileId-first. Ownership is verified via the parent item's profile_id (the ledger
// has no profile_id column). Returns the undo token (deleted_rows id) or null when the
// row isn't the profile's / is gone. One IMMEDIATE transaction so the capture + delete
// + any supply re-credit commit together.
//
// Kind-neutral since #1933 (`s.kind = 'medication'` is gone from the ownership SELECT);
// a retired dose or a paused item is no bar, because the row being removed is history,
// not schedule. The supply re-credit is the counter-like half: it runs through the
// shared incrementSupply, so a pooled item (#1374) hands the units back to the
// household bottle rather than to a private counter it doesn't keep — and it is the
// exact inverse of the decrement restoreAdministrationLog re-applies.
// What a successful delete removed: the undo token plus the identifiers the action
// boundary audits the correction by (#1933). Never the amount, product, or name — an
// audit row records that history changed and for which item/date, not the content.
export interface AdministrationDeleteOutcome {
  undoId: number;
  itemId: number;
  date: string;
}

export function deleteAdministrationLog(
  profileId: number,
  logId: number
): AdministrationDeleteOutcome | null {
  return writeTx((): AdministrationDeleteOutcome | null => {
    const row = db
      .prepare(
        `SELECT l.id, l.dose_id, l.item_id, l.date, l.taken_at, l.given_at,
                l.amount, l.product, l.status, l.supply_adjusted
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE l.id = ? AND s.profile_id = ?
            AND l.status = 'taken'`
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
      product: row.product,
      status: row.status,
      supply_adjusted: row.supply_adjusted,
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
    if (row.status === "taken" && row.supply_adjusted === 1) {
      incrementSupply(profileId, row.item_id);
    }
    // The dose is now unconfirmed for the day this row covered — stamp that day handled
    // so removing a mis-tap can never resurrect its missed-dose escalation.
    suppressEscalationRearm(profileId, row.dose_id, row.date);
    return {
      undoId: Number(info.lastInsertRowid),
      itemId: row.item_id,
      date: row.date,
    };
  });
}

// Correct the wall time or snapshotted amount of one recorded administration.
// This remains one consumed administration, so supply is deliberately unchanged (the
// same zero re-diff updateHistoricalDose explains at length).
//
// Ungated since #1933: it carried `s.obligation = 'may'`, which meant a SCHEDULED
// dose log could not be corrected at all — obligation decides dueness and pushability,
// never whether a recorded fact may be amended. A retired dose and a paused item are
// likewise no bar; the row is history. Callers keep their own surface predicates (the
// illness-episode timeline gathers `may` dose events and still scopes its own read to
// them), but the shared core no longer refuses on the item's shape.
export function updateAdministrationLog(
  profileId: number,
  logId: number,
  date: string,
  givenAt: Date,
  amount: string | null
): boolean {
  return writeTx(() => {
    const owned = db
      .prepare(
        `SELECT l.dose_id AS dose_id, l.date AS old_date
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE l.id = ? AND s.profile_id = ?
            AND l.status = 'taken'`
      )
      .get(logId, profileId) as
      { dose_id: number; old_date: string } | undefined;
    if (!owned) return false;
    const info = db
      .prepare(
        `UPDATE intake_item_logs
            SET date = ?, given_at = ?, amount = ?
          WHERE id = ? AND item_id IN
            (SELECT id FROM intake_items WHERE profile_id = ?)`
      )
      .run(date, utcSqlString(givenAt), amount, logId, profileId);
    if (info.changes !== 1) return false;
    if (owned.old_date !== date) {
      suppressEscalationRearm(profileId, owned.dose_id, owned.old_date);
    }
    return true;
  });
}

// Restore a captured medication administration from its undo token (routed here by
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

    // Undo tokens captured before the supply flag was introduced represent ordinary
    // logs, all of which consumed supply. Default those legacy payloads to 1.
    const supplyAdjusted = captured.supply_adjusted ?? 1;
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, taken_at, given_at, amount, product, status,
          supply_adjusted)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      captured.dose_id,
      captured.item_id,
      captured.date,
      captured.taken_at,
      captured.given_at,
      captured.amount,
      captured.product ?? null,
      captured.status,
      supplyAdjusted
    );
    if (captured.status === "taken" && supplyAdjusted === 1) {
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
  product: string | null;
  amount: string | null;
  minIntervalHours: number;
  maxDailyCount: number;
}

export function getRedoseNoticeItems(profileId: number): RedoseNoticeItem[] {
  return db
    .prepare(
      `SELECT id, name, product,
              (SELECT d.amount FROM intake_item_doses d
                WHERE d.item_id = intake_items.id AND d.retired = 0
                ORDER BY d.sort, d.id LIMIT 1) AS amount,
              min_interval_hours AS minIntervalHours,
              max_daily_count AS maxDailyCount
         FROM intake_items
        WHERE profile_id = ? AND active = 1 AND kind = 'medication'
          AND obligation = 'may' AND redose_notice = 1
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

// A PRN med (or ingredient FAMILY, #1027) whose today's administration count has
// EXCEEDED the confirmed daily max (#798) — the input to the over-max care finding
// (the #148 UL-warning shape applied per-day). "Over" is strictly greater than the
// max (you've logged MORE than the label allows today).
//
// FAMILY-AWARE (#1027 ask 2): the exposure is the ingredient family's COMBINED
// taken administrations (OTC ibuprofen + Rx ibuprofen 800 together), compared
// against the most conservative confirmed ceiling among members. The finding is
// anchored to the member holding the binding max (lowest id on a tie), so its
// dedupeKey stays `prn-max:<itemId>` — identical to the pre-family key for a
// single-item family (#203: keys stable where possible). Members with unconfirmed
// fields still contribute their logged administrations (a logged dose is a fact
// regardless of config); a family with NO confirmed ceiling produces nothing (the
// #798 liability gate).
//
// AMOUNT-AWARE (#1854): basis/total/max come straight from the family state's
// prnDayExposure verdict — summed snapshotted MILLIGRAMS against a confirmed
// mg/day max when every administration's amount parses (3 × 800 mg is 2400 mg,
// not a calm "3 of 6"), the administration COUNT as the fallback for unparseable
// amounts. `basis` tells the copy which one was used.
export interface PrnOverMaxItem {
  id: number;
  name: string;
  // The basis the day was judged on, its total and confirmed ceiling — mg for the
  // amount-aware path, administrations for the count fallback (prnDayExposure).
  basis: PrnExposureBasis;
  total: number;
  max: number;
  // mg basis only: administrations with no parseable snapshotted amount (the
  // lower-bound path — copy must read "at least"). Always 0 on the count basis.
  unknownAmounts: number;
  // Every family member's name, when the exposure spans MORE than one item (the
  // #531 label-by-what-differs rule for the finding copy); absent for a solo item.
  memberNames?: string[];
}

export function getPrnOverMaxItems(
  profileId: number,
  date: string
): PrnOverMaxItem[] {
  const out: PrnOverMaxItem[] = [];
  const seenFamilies = new Set<string>();
  const states = getMedicationFamilyStates(profileId, date);
  // Anchor selection needs each member's own confirmed maxes + PRN flag; re-read
  // the active PRN-configured meds once (profile-scoped). Either ceiling form
  // (count or mg/day, #1854) makes an item "configured".
  const configured = db
    .prepare(
      `SELECT id, name, max_daily_count AS maxDailyCount,
              max_daily_amount_mg AS maxDailyAmountMg
         FROM intake_items
        WHERE profile_id = ? AND active = 1
          AND obligation = 'may' AND kind = 'medication'
          AND ((max_daily_count IS NOT NULL AND max_daily_count > 0)
            OR (max_daily_amount_mg IS NOT NULL AND max_daily_amount_mg > 0))
        ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    name: string;
    maxDailyCount: number | null;
    maxDailyAmountMg: number | null;
  }[];
  for (const item of configured) {
    const state = states.get(item.id);
    if (!state || seenFamilies.has(state.familyKey)) continue;
    seenFamilies.add(state.familyKey);
    const exposure = state.exposure;
    if (!exposure || !exposure.over) continue;
    // Anchor: the configured member holding the binding most-conservative max on
    // the basis actually used (lowest id on a tie) — `configured` is id-ordered,
    // so the first match wins.
    const anchor =
      configured.find(
        (c) =>
          state.memberIds.includes(c.id) &&
          (exposure.basis === "mg"
            ? c.maxDailyAmountMg === exposure.max
            : c.maxDailyCount === exposure.max)
      ) ?? item;
    out.push({
      id: anchor.id,
      name: anchor.name,
      basis: exposure.basis,
      total: exposure.total,
      max: exposure.max,
      unknownAmounts: exposure.unknownAmounts,
      ...(state.memberIds.length > 1 ? { memberNames: state.memberNames } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// One PRN med surfaced for one-tap logging (dashboard widget + med card): its id,
// name, and today's administration count + latest intake time. Since #798 it also
// carries the confirmed redose interval/max (null when not configured) so the widget
// can render a marker-agnostic "redose open / next in ~Xh" status line without a
// second query (the same window math the notice uses, via redoseWindowStatus).
// Since #1027 it ALSO carries the ingredient-FAMILY counters — the combined count,
// latest administration, and most conservative confirmed max across every active med
// sharing the ingredient — which are what the redose window math must consume (an
// OTC ibuprofen dose an hour ago holds the Rx item's "redose OK"). For a solo item
// the family values equal the per-item ones. The per-item count/lastGivenAt stay for
// the "N today · last 4:02pm" day label (the item's own administrations).
export interface PrnMedForQuickLog {
  id: number;
  name: string;
  product: string | null;
  amount: string | null;
  count: number;
  lastGivenAt: string | null;
  minIntervalHours: number | null;
  maxDailyCount: number | null;
  familyCount: number;
  familyLastGivenAt: string | null;
  // min confirmed max across the family; falls back to the item's own max.
  familyMaxDailyCount: number | null;
  // The family's amount-aware day exposure (#1854) from the ONE family gather —
  // null when no ceiling is confirmed. Feeds prnQuickLogRedoseStatus so the
  // widget/card/Telegram "N of M" line reads milligrams when they're known.
  familyExposure: PrnDayExposure | null;
  // Number of active items in the ingredient family (1 for a solo item) — lets the
  // widget note that the counters span sibling items.
  familyMemberCount: number;
}

// Active PRN (as-needed) medications for the quick-log widget, each with today's
// administration count + latest intake time. Recently-used float to the top (most
// recent last-administration first — the widget's "recently-used" ordering), then
// alphabetical. One profile-scoped read so the widget and any other surface agree;
// the #1027 family counters are overlaid from the ONE getMedicationFamilyStates
// gather so every redose surface widens identically.
export function getPrnMedicationsForQuickLog(
  profileId: number
): PrnMedForQuickLog[] {
  const date = today(profileId);
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.name AS name, s.product AS product,
              (SELECT d.amount FROM intake_item_doses d
                WHERE d.item_id = s.id AND d.retired = 0
                ORDER BY d.sort, d.id LIMIT 1) AS amount,
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
          AND s.obligation = 'may' AND s.kind = 'medication'
        ORDER BY (lastGivenAt IS NULL), lastGivenAt DESC, s.name`
    )
    .all(date, profileId) as Omit<
    PrnMedForQuickLog,
    | "familyCount"
    | "familyLastGivenAt"
    | "familyMaxDailyCount"
    | "familyExposure"
    | "familyMemberCount"
  >[];
  const families = getMedicationFamilyStates(profileId, date);
  return rows.map((r) => {
    const fam = families.get(r.id);
    return {
      ...r,
      familyCount: fam?.countToday ?? r.count,
      familyLastGivenAt: fam?.latestGivenAt ?? r.lastGivenAt,
      familyMaxDailyCount: fam?.minConfirmedMax ?? r.maxDailyCount,
      familyExposure: fam?.exposure ?? null,
      familyMemberCount: fam?.memberIds.length ?? 1,
    };
  });
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
// window could drop a dose on the oldest column. Kind-neutral (it was
// getIntakeLogsInRange until #1933): supplements and medications share one ledger
// and one strip.
export function getIntakeLogsInRange(
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

// ---- The offer tail's gather (issue #1505) --------------------------------

// The `may` items this profile may be OFFERED right now, scoped by their slot hint
// against the profile-local wall clock — the DB half of the "Log other…" tail.
//
// Two filters, both load-bearing and both evaluated at CALL time (which is TAP time
// for the tail): the item's day CONDITION must apply today (a rest-day magnesium is
// not offered on a training day), and its slot HINT must cover the current bucket (a
// bedtime item is not offered at breakfast). A hint-less item passes the second
// filter always — no hint means no opinion, and refusing to show it anywhere would
// make "may with no slot" unreachable, defeating the guaranteed-access rule.
//
// Unlike getPrnMedicationsForQuickLog this is NOT medication-only: `may` is a shape,
// not a kind, so a may supplement (magnesium, a preworkout) is offered on exactly the
// same terms as a PRN med. That is the whole point of the collapse — the two were
// always the same thing wearing different flags.
export function getOfferedIntakeForSlot(
  profileId: number,
  nowHhmm: string
): {
  itemId: number;
  name: string;
  detail: string | null;
  countToday: number;
}[] {
  const date = today(profileId);
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.name AS name, s.kind AS kind, s.product AS product,
              s.condition AS condition, s.situation AS situation,
              s.pause_situation_id AS pauseSituationId,
              (SELECT d.amount FROM intake_item_doses d
                WHERE d.item_id = s.id AND d.retired = 0
                ORDER BY d.sort, d.id LIMIT 1) AS amount,
              (SELECT d.time_of_day FROM intake_item_doses d
                WHERE d.item_id = s.id AND d.retired = 0
                ORDER BY d.sort, d.id LIMIT 1) AS timeOfDay,
              (SELECT COUNT(*) FROM intake_item_logs l
                WHERE l.item_id = s.id AND l.date = ? AND l.status = 'taken')
                AS countToday
         FROM intake_items s
        WHERE s.profile_id = ? AND s.active = 1 AND s.obligation = 'may'
        ORDER BY s.name, s.id`
    )
    .all(date, profileId) as {
    id: number;
    name: string;
    kind: SupplementKind;
    product: string | null;
    condition: SupplementCondition;
    situation: string | null;
    pauseSituationId: number | null;
    amount: string | null;
    timeOfDay: string | null;
    countToday: number;
  }[];
  if (rows.length === 0) return [];

  // The day context, resolved ONCE per call — the same effective situation set every
  // other dueness surface reads (declared ∪ derived), so an offer can't disagree with
  // the page about whether a situational item applies today.
  const ctx = {
    date,
    isWorkoutDay: getActivitiesByDate(profileId, date).length > 0,
    activeSituations: getEffectiveActiveSituations(profileId, date),
    predictedWorkoutDay: isPredictedWorkoutDay(profileId, date),
  };
  const pauseNames = new Map(
    getSituations(profileId).map((s) => [s.id, s.name])
  );

  return rows
    .filter((r) =>
      isOfferedOn(
        {
          obligation: "may",
          condition: r.condition,
          situation: r.situation,
          pause_situation:
            r.pauseSituationId != null
              ? (pauseNames.get(r.pauseSituationId) ?? null)
              : null,
        },
        ctx
      )
    )
    .filter((r) => slotHintCoversNow(r.timeOfDay, nowHhmm))
    .map((r) => ({
      itemId: r.id,
      name: r.name,
      detail:
        r.kind === "medication"
          ? formatMedicationDoseProduct(r.amount, r.product)
          : r.amount,
      countToday: r.countToday,
    }));
}

// ---- Administration-time correction (issue #2020) ----

// One recent dose confirmation as the correction offer reads it. `tapAt` is `taken_at`,
// the IMMUTABLE audit stamp — burst identity, freshness and every chip offset key on it,
// never on `given_at`, which is the thing being corrected. That separation is what makes
// a chip idempotent: tapping −2h twice lands on the same instant instead of walking a
// dose four hours into the past.
export interface DoseTapRow {
  id: number;
  tapAt: string;
  label: string;
  doseId: number;
  date: string;
}

// The profile's dose confirmations tapped within the correction window, oldest first.
// Bounded by that window, so the read is a handful of rows. Profile-scoped through the
// dose → item JOIN.
//
// SCHEDULED CONFIRMS ONLY IS NOT THE RULE — a PRN administration is exactly the case
// #2020 is about (the redose window arms off `given_at`), so both are here. What IS
// excluded is a row with no `given_at` at all: there is no administration instant to
// correct, and inventing one would be the guess this feature exists to end.
export function getRecentDoseTaps(
  profileId: number,
  now: Date = new Date()
): DoseTapRow[] {
  const since = utcSqlString(
    new Date(now.getTime() - CORRECTION_FRESH_MIN * 60_000)
  );
  const rows = db
    .prepare(
      `SELECT l.id AS id, l.dose_id AS doseId, l.date AS date,
              l.taken_at AS takenAt, s.name AS name
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.status = 'taken'
          AND l.given_at IS NOT NULL AND l.taken_at >= ?
        ORDER BY l.taken_at, l.id
        LIMIT 100`
    )
    .all(profileId, since) as {
    id: number;
    doseId: number;
    date: string;
    takenAt: string;
    name: string;
  }[];
  const out: DoseTapRow[] = [];
  for (const r of rows) {
    // Stored datetimes carry no zone, so they are parsed as UTC rather than handed to
    // `new Date`, which would read them in the process-local zone.
    const tap = parseUtcSql(r.takenAt);
    if (!tap) continue;
    out.push({
      id: r.id,
      tapAt: tap.toISOString(),
      label: r.name,
      doseId: r.doseId,
      date: r.date,
    });
  }
  return out;
}

// The correction rows a dose keyboard should carry right now. Same computation as the
// food side (#221), over the ledger the dose reminder itself writes to.
export function getDoseCorrectionBursts(
  profileId: number,
  now: Date = new Date()
): CorrectionBurst[] {
  return correctionBursts(getRecentDoseTaps(profileId, now), now);
}

// The typed result of a dose-time correction:
//   restamped — `count` log rows now carry a corrected `given_at`; `crossedMidnight`
//               says whether any of them landed on a different calendar day, which the
//               toast has to mention because the row's DAY deliberately does not move.
//               `anchor` names the dose + day the message can be rebuilt from once the
//               session's own buttons are gone.
//   no-burst  — the anchor row is gone or belongs to another profile. Nothing written.
export type DoseRestampOutcome =
  | {
      kind: "restamped";
      count: number;
      crossedMidnight: boolean;
      anchor: { doseId: number; date: string };
    }
  | { kind: "no-burst" };

// Correct a burst of administration instants (issue #2020).
//
// THE ROW'S `date` DOES NOT MOVE, and this is the deliberate contrast with the food
// side. A serving's day is a fact about the serving, so #2019's correction re-dates it;
// a dose's day is SCHEDULE-OWNED (#614 — the token's date is the day the reminder was
// asking about), so a correction that crosses midnight moves only `given_at` and leaves
// the adherence day where the schedule put it. A bedtime dose confirmed at 07:00 and
// corrected to 22:00 was still last night's bedtime dose.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//
//   • It does not re-evaluate the phantom-dose PROXIMITY GUARD (see logAdministration).
//     That guard runs at INSERT time and decides whether a new row is the same intent as
//     an existing one. A correction can legitimately move two administrations within its
//     window, and merging or deleting a row on that basis would destroy a real record of
//     something that was taken. The instant is adjusted; the rows stay.
//   • It does not RE-ARM anything (#1933). A corrected instant is a correction of
//     history, not a new event, so no escalation reopens and no reminder returns.
//   • It only ever moves an instant EARLIER (chips are −Nh, picker hours are all past),
//     so the PRN redose window can only become MORE conservative — the safe direction
//     for the one consumer that is safety-relevant.
export function restampDoseLogsCore(
  profileId: number,
  fromLogId: number,
  resolve: (tapAt: string) => Date
): DoseRestampOutcome {
  return writeTx(() => {
    const rows = db
      .prepare(
        `SELECT l.id AS id, l.dose_id AS doseId, l.date AS date,
                l.taken_at AS takenAt, s.name AS name
           FROM intake_item_logs l
           JOIN intake_item_doses d ON d.id = l.dose_id
           JOIN intake_items s ON s.id = d.item_id
          WHERE s.profile_id = ? AND l.id >= ? AND l.status = 'taken'
            AND l.given_at IS NOT NULL
          ORDER BY l.taken_at, l.id
          LIMIT 200`
      )
      .all(profileId, fromLogId) as {
      id: number;
      doseId: number;
      date: string;
      takenAt: string;
      name: string;
    }[];
    const taps: { row: (typeof rows)[number]; tapAt: string }[] = [];
    for (const r of rows) {
      const tap = parseUtcSql(r.takenAt);
      if (tap) taps.push({ row: r, tapAt: tap.toISOString() });
    }
    const byId = new Map(taps.map((t) => [t.row.id, t]));
    const burst = burstFrom(
      taps.map((t) => ({ id: t.row.id, tapAt: t.tapAt, label: t.row.name })),
      fromLogId
    );
    if (!burst) return { kind: "no-burst" as const };

    const tz = getTimezone(profileId);
    let crossedMidnight = false;
    for (const id of burst.ids) {
      const t = byId.get(id);
      if (!t) continue;
      const instant = resolve(t.tapAt);
      if (dateStrInTz(tz, instant) !== t.row.date) crossedMidnight = true;
      db.prepare(
        `UPDATE intake_item_logs SET given_at = ? WHERE id = ?`
      ).run(utcSqlString(instant), id);
    }
    const anchorRow = byId.get(burst.fromId)?.row;
    return {
      kind: "restamped" as const,
      count: burst.ids.length,
      crossedMidnight,
      anchor: anchorRow
        ? { doseId: anchorRow.doseId, date: anchorRow.date }
        : { doseId: 0, date: today(profileId) },
    };
  });
}
