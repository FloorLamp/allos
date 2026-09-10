// Part of the lib/queries/intake barrel (#319), split out of adherence.ts under
// #2960 / rule #5670. The profile-scoping guard walks all of lib/, so this module
// stays covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
//
// THE ONE PRN / HISTORICAL ADMINISTRATION WRITE PATH (#797, #1933, #2228). Four doors
// — the live PRN log, the redose-window consume, the historical backfill and the amend
// of a row already written — over one `logAdministrationTx`, one dedupe window
// (`ADMIN_DEDUP_WINDOW_SEC`) and one supply discipline.
//
// It is a SEPARATE core from the scheduled-dose resolution next door, and deliberately
// so. A scheduled dose has a daily log row whose STATUS transitions — taken ↔ skipped ↔
// clear, one row per (dose, date) — while an administration is an event that can happen
// many times a day and is never "cleared", only deleted. Collapsing them would have to
// give one of the two the other's semantics. What they DO share is the table and the
// supply counter, which is why both stay registered as `intake_item_logs` cores and why
// every door here runs inside one BEGIN IMMEDIATE with a typed refusal.
//
// The no-rearm rule is imported rather than restated: an amend that moves a row onto
// another date un-marks the dose for the day it left, so that day is stamped handled.
import { suppressEscalationRearm } from "./no-rearm";
import { db, today, writeTx } from "../../db";
import type { LoggedVia } from "../../logged-via";
import type { BundleId } from "../../bundle";
import { doseScheduleAsOf, type DoseCadence } from "../../intake-cadence";
import { instantNow, now as clockNow } from "../../clock";
import { dateStrInTz, utcInstant } from "../../date";
import { getTimezone } from "../../settings";
import {
  isGivenAtAccepted,
  isHistoricalDoseDateAccepted,
  isHistoricalDoseTimeAccepted,
} from "../../dose-log-window";
import { judgeStatedAt } from "../../stated-time";
import { decrementSupply } from "./refill";
import { setCourseStartDate } from "./medications";
import { redoseWindowState } from "./prn-family";
import type {
  AdministrationOutcome,
  DoseStatus,
  HistoricalDoseOutcome,
  RedoseWindowAdministrationOutcome,
} from "../../types";
import type { IntakeObligation } from "../../types";
import { getDoseScheduleVersions } from "./schedule";
import { DOSE_RESOLUTION } from "@/lib/log-manifest";

// ---- PRN (as-needed) administrations ledger (#797) ----

// Short window within which a second administration of the SAME dose is treated as
// a double-tap (a re-tapped widget button, a retried Telegram callback, a double
// click) rather than a second real intake. PRN logging is deliberately NOT
// idempotent — multiple/day is the whole point (#797) — so this replaces the
// dropped UNIQUE(dose_id,date) as the accidental-repeat guard, keeping a stray tap
// from inventing a phantom dose (and burning supply). Both capture and administration
// proximity must match: a retry collapses, while two retro entries filed together for
// genuinely different times both land.
export const ADMIN_DEDUP_WINDOW_SEC = 120;

function logAdministrationTx(
  profileId: number,
  itemId: number,
  date: string,
  recordedAtStr: string,
  occurredAtStr: string,
  expectedRedoseAdministrationId: null,
  loggedVia: LoggedVia,
  notifyMessageId?: number | null
): AdministrationOutcome;
function logAdministrationTx(
  profileId: number,
  itemId: number,
  date: string,
  recordedAtStr: string,
  occurredAtStr: string,
  expectedRedoseAdministrationId: number,
  loggedVia: LoggedVia,
  notifyMessageId?: number | null
): RedoseWindowAdministrationOutcome;
function logAdministrationTx(
  profileId: number,
  itemId: number,
  date: string,
  recordedAtStr: string,
  occurredAtStr: string,
  expectedRedoseAdministrationId: number | null,
  loggedVia: LoggedVia,
  notifyMessageId?: number | null
): RedoseWindowAdministrationOutcome {
  // Resolve the item's primary loggable (non-retired) dose + live state, scoped to
  // the profile through the parent item. A PRN med always has at least one dose row
  // (the item form guarantees it); its amount rides onto the log so history survives
  // a later dosage edit.
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

  if (expectedRedoseAdministrationId != null) {
    const state = redoseWindowState(
      profileId,
      itemId,
      expectedRedoseAdministrationId
    );
    if (state !== "current") {
      return { kind: "stale-window", reason: state };
    }
  }

  // Double-tap guard: an existing taken administration of this dose within the dedup
  // window is the same intent — no new row, no supply move.
  const dup = db
    .prepare(
      `SELECT id FROM intake_item_logs
        WHERE dose_id = ? AND status = 'taken'
          AND ABS(strftime('%s', recorded_at) - strftime('%s', ?)) <= ?
          AND ABS(strftime('%s', occurred_at) - strftime('%s', ?)) <= ?
        LIMIT 1`
    )
    .get(
      dose.dose_id,
      recordedAtStr,
      ADMIN_DEDUP_WINDOW_SEC,
      occurredAtStr,
      ADMIN_DEDUP_WINDOW_SEC
    ) as { id: number } | undefined;
  if (!dup) {
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, amount, recorded_at, occurred_at,
          notify_message_id, logged_via)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      dose.dose_id,
      itemId,
      date,
      dose.amount,
      recordedAtStr,
      occurredAtStr,
      notifyMessageId ?? null,
      loggedVia
    );
    decrementSupply(profileId, itemId);
  }
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM intake_item_logs
        WHERE item_id = ? AND date = ? AND status = 'taken'`
    )
    .get(itemId, date) as { count: number };
  return {
    kind: dup ? "duplicate" : "logged",
    count: summary.count,
    date,
  };
}

// Log one PRN administration of an intake item — auth-blind, profileId-first (the
// lib-write-core convention, mirroring logFoodServingCore): both the
// logMedicationAdministration Server Action (dashboard quick-log) and the Telegram
// /dose tap call this, so the ingestion path is one computation regardless of
// surface, and the auth gate stays entirely in the action. `occurredAt` is the real
// intake time (undefined = now), bounded by isGivenAtAccepted (#614). Each accepted,
// non-duplicate administration is a NEW intake_item_logs row (the per-administration
// ledger) that decrements on-hand supply once. One IMMEDIATE transaction (#468) so
// the dedup read + insert + supply move see one consistent state under a concurrent
// web/Telegram tap. Returns a typed outcome so the caller answers from what actually
// happened rather than unconditionally confirming.
export function logAdministration(
  profileId: number,
  itemId: number,
  // Which surface this administration was logged from (#3087) — required, no default.
  loggedVia: LoggedVia,
  occurredAt?: Date,
  // Which message's tap this is (#2264) — Telegram handlers only, exactly as
  // markDoseTaken takes it. Without it a chat-logged administration produces an
  // UNATTRIBUTED correction burst, which may then ride the newest live dose message in
  // the chat rather than the message it came from (#2418 part 2): the digest's offer
  // list is not a dose reminder, so its taps have to say where they happened or their
  // 🕐 chips surface on an unrelated reminder.
  notifyMessageId?: number | null
): AdministrationOutcome {
  const tz = getTimezone(profileId);
  const capturedAt = clockNow();
  const when = occurredAt ?? capturedAt;
  const todayStr = today(profileId);
  if (occurredAt && !isGivenAtAccepted(tz, todayStr, when, capturedAt)) {
    return { kind: "invalid-time" };
  }
  const date = dateStrInTz(tz, when);
  const recordedAtStr = utcInstant(capturedAt);
  const occurredAtStr = utcInstant(when);
  return writeTx(() =>
    logAdministrationTx(
      profileId,
      itemId,
      date,
      recordedAtStr,
      occurredAtStr,
      null,
      loggedVia,
      notifyMessageId
    )
  );
}

// Consume one specific administration-armed redose window. The current-window check
// and the new administration happen in the SAME IMMEDIATE transaction, so an app log
// racing this Telegram tap can win or lose, but can never leave two doses recorded.
export function logRedoseWindowAdministration(
  profileId: number,
  itemId: number,
  armingAdministrationId: number,
  loggedVia: LoggedVia
): RedoseWindowAdministrationOutcome {
  const tz = getTimezone(profileId);
  const when = clockNow();
  const date = dateStrInTz(tz, when);
  const recordedAtStr = utcInstant(when);
  const occurredAtStr = recordedAtStr;
  return writeTx(() =>
    logAdministrationTx(
      profileId,
      itemId,
      date,
      recordedAtStr,
      occurredAtStr,
      armingAdministrationId,
      loggedVia
    )
  );
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
  occurredAt: Date,
  amountOverride: string | null,
  adjustSupply: boolean,
  loggedVia: LoggedVia,
  // The composed action this backfill is one row of (#4328). The composed one-tap
  // reaches this writer instead of `markDoseTaken` once the day is past the ±2 window
  // (#4305), and one tap is one tap whichever writer it lands in.
  bundleId?: BundleId
): HistoricalDoseOutcome {
  const tz = getTimezone(profileId);
  const todayStr = today(profileId);
  // The app clock, not the wall clock (#2031): `todayStr` above is seam-derived and
  // so is the stored occurred_at this may be re-validating, so all three must agree.
  if (!isHistoricalDoseTimeAccepted(tz, todayStr, occurredAt, clockNow())) {
    return { kind: "invalid-time" };
  }
  const date = dateStrInTz(tz, occurredAt);
  const occurredAtStr = utcInstant(occurredAt);

  return writeTx((tx): HistoricalDoseOutcome => {
    const dose = db
      .prepare(
        `SELECT d.item_id, d.amount, d.time_of_day, d.weekdays,
                d.start_date, d.end_date, s.obligation
           FROM intake_item_doses d
           JOIN intake_items s ON s.id = d.item_id
          WHERE d.id = ? AND d.item_id = ? AND d.retired = 0
            AND s.profile_id = ?`
      )
      .get(doseId, itemId, profileId) as
      | ({ item_id: number; obligation: IntakeObligation } & DoseCadence)
      | undefined;
    if (!dose) return { kind: "stale-dose" };
    dose.versions = getDoseScheduleVersions(profileId).get(doseId);

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
              AND s.profile_id = ? AND l.occurred_at IS NOT NULL
              AND ABS(strftime('%s', l.occurred_at) - strftime('%s', ?)) <= ?
            LIMIT 1`
        )
        .get(doseId, profileId, occurredAtStr, ADMIN_DEDUP_WINDOW_SEC);
      if (duplicate) return { kind: "duplicate" };
    }

    const amount =
      amountOverride?.trim() || doseScheduleAsOf(dose, date).amount || null;
    if (courseToExtend) {
      // Backdate the course's start through the course core (#2132) — the same
      // transaction (Tx token), the DML lives with the invariant's owner.
      //
      // THE OUTCOME IS THE REFUSAL, NOT A LOG (#4909). The CAS carries one predicate
      // the read above does not — `kind = 'medication'` — and this core is
      // kind-neutral (#1933), so an item that HAS courses but is no longer a
      // medication misses and writes nothing. Discarding that committed half the
      // intent, under a form that had just said "start date will move back to
      // match". `outside-course` is the honest kind rather than a new one: the
      // extension was the only thing that would have put this day inside a course.
      // And returning is a whole abort — a miss wrote nothing, and this is
      // deliberately the transaction's first write.
      if (
        setCourseStartDate(tx, profileId, itemId, courseToExtend.id, date) ===
        "not-found"
      ) {
        return { kind: "outside-course" };
      }
    }
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, amount, recorded_at, occurred_at,
          supply_adjusted, logged_via, bundle_id)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      doseId,
      itemId,
      date,
      amount,
      instantNow(),
      occurredAtStr,
      adjustSupply ? 1 : 0,
      loggedVia,
      bundleId ?? null
    );
    if (adjustSupply) decrementSupply(profileId, itemId);
    return { kind: "logged", date };
  });
}
export const logHistoricalDoseDeclares = DOSE_RESOLUTION;

// Edit one existing taken ledger row (kind-neutral since #1933, for the same reasons
// as logHistoricalDose above). Date/course rules mirror it, including moving a PRN
// course start backward only after uniqueness checks pass. Scheduled edits retain one
// status row per dose/date; PRN edits retain the per-administration time dedup.
//
// THE ONE AMEND CORE (#2228 decision 6): the illness-episode timeline's dose edit
// (updateEpisodeDoseAction) routes here too — its predecessor updateAdministrationLog
// enforced none of the course/uniqueness/proximity rules, so the same clinical
// amendment was strict from a medication card and loose from an episode. Callers keep
// their own surface predicates (the episode scopes its read to `may` items inside the
// episode window); the shared rules live here once.
//
// IT WRITES `occurred_at`, NEVER `recorded_at` (#2228, #2876). The latter is immutable
// capture; the former is the administration instant this amendment states.
//
// `date` IS PASSED EXPLICITLY, not derived from the instant (#2228 decision 3): a
// present instant must AGREE with it (`judgeStatedAt` — the pair rule) or the whole
// amendment is refused, never silently re-dated; a null instant means "no intake time
// stated" — the amendment changes what it names and NOTHING else, and the date-only
// path still validates the day against the same any-past-day window
// (isHistoricalDoseDateAccepted) instead of skipping validation.
//
// RETIRED DOSES AND PAUSED ITEMS STAY EDITABLE — deliberately, and unlike the create
// path. `d.retired = 0` answers "may this dose still be scheduled onto a new day",
// which is the wrong question for a row that already exists: the schedule was retired,
// but the dose was really taken and the ledger entry is still a fact. Same for a paused
// item — pausing stops future dueness, it does not make past history unamendable. So
// this SELECT still joins the row to its dose WITHOUT a retired predicate and never
// looks at `s.active`.
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
  date: string,
  occurredAt: Date | null,
  amountOverride: string | null
): HistoricalDoseOutcome {
  const tz = getTimezone(profileId);
  const todayStr = today(profileId);
  if (occurredAt) {
    // The app clock, not the wall clock (#2031): `todayStr` above is seam-derived
    // and so is any stored instant this may be re-validating, so all must agree.
    if (!isHistoricalDoseTimeAccepted(tz, todayStr, occurredAt, clockNow())) {
      return { kind: "invalid-time" };
    }
    // The pair rule (#2236's acceptance gate, reused rather than re-derived): the
    // stated instant's profile-local date IS the submitted `date`, or the amendment
    // is refused — never silently re-dated onto the instant's own day. Already NOT
    // silent (#2296): a correction's statement is its whole submission, so the typed
    // `invalid-time` refusal is what the surface renders.
    if (judgeStatedAt(occurredAt, tz, date, clockNow()).kind !== "accepted") {
      return { kind: "invalid-time" };
    }
  } else if (!isHistoricalDoseDateAccepted(todayStr, date)) {
    return { kind: "invalid-time" };
  }

  return writeTx((tx): HistoricalDoseOutcome => {
    const row = db
      .prepare(
        `SELECT l.dose_id, l.date AS old_date, l.amount,
                s.obligation
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
    } else if (occurredAt) {
      // Historical administration proximity is an event-time question. An
      // amendment that clears the time states nothing to be near, so it has no
      // proximity to check and lands as an ordinary `logged` outcome.
      const duplicate = db
        .prepare(
          `SELECT l.id
             FROM intake_item_logs l
             JOIN intake_items s ON s.id = l.item_id
            WHERE l.dose_id = ? AND l.id <> ? AND l.status = 'taken'
              AND s.profile_id = ? AND l.occurred_at IS NOT NULL
              AND ABS(strftime('%s', l.occurred_at) - strftime('%s', ?)) <= ?
            LIMIT 1`
        )
        .get(
          row.dose_id,
          logId,
          profileId,
          utcInstant(occurredAt),
          ADMIN_DEDUP_WINDOW_SEC
        );
      if (duplicate) return { kind: "duplicate" };
    }

    if (courseToExtend) {
      // Backdate the course's start through the course core (#2132) — the same
      // transaction (Tx token), the DML lives with the invariant's owner. The
      // outcome is the refusal (#4909) for the reason logHistoricalDose gives, and
      // this is likewise the amendment's first write.
      if (
        setCourseStartDate(tx, profileId, itemId, courseToExtend.id, date) ===
        "not-found"
      ) {
        return { kind: "outside-course" };
      }
    }
    // Amendment starts from the administration snapshot, including a meaningful
    // null; only a stated nonempty override replaces it.
    const amount = amountOverride?.trim() || row.amount;
    db.prepare(
      `UPDATE intake_item_logs
          SET date = ?, occurred_at = ?, amount = ?
        WHERE id = ? AND item_id = ?
          AND EXISTS (
            SELECT 1 FROM intake_items s
             WHERE s.id = intake_item_logs.item_id AND s.profile_id = ?
          )`
    ).run(
      date,
      occurredAt ? utcInstant(occurredAt) : null,
      amount,
      logId,
      itemId,
      profileId
    );
    // Moving the row off its old date un-marks the dose for that day, so the day it
    // vacated is stamped handled and can never be chased (see suppressEscalationRearm).
    if (row.old_date !== date) {
      suppressEscalationRearm(profileId, row.dose_id, row.old_date);
    }
    return { kind: "logged", date };
  });
}
