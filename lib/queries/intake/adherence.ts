// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Adherence / dose-log reads and writes: taken/skipped dose sets, the idempotent
// mark-taken/skipped log writers (the notification-webhook counterparts), the
// escalation-authorization helpers, and the adherence-strip range read.
import { db, today, writeTx } from "../../db";
import { clampPage, pageCount, pageOffset } from "../../pagination";
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
  utcInstant,
  utcSqlString,
  parseUtcSql,
} from "../../date";
import { getTimezone, setProfileSetting } from "../../settings";
import { escalationMarkerKey } from "../../notifications/escalation-keys";
import {
  isDoseDateAccepted as isDoseDateInWindow,
  isGivenAtAccepted,
  isHistoricalDoseDateAccepted,
  isHistoricalDoseTimeAccepted,
  resolveQueuedTakenAt,
} from "../../dose-log-window";
import { judgeStatedAt } from "../../stated-time";
import {
  burstFrom,
  correctionBursts,
  CORRECTION_FRESH_MIN,
  type CorrectionBurst,
  type CorrectionMessageBinding,
} from "../../correction-time";
import { decrementSupply, incrementSupply } from "./refill";
import { setCourseStartDate } from "./medications";
import { getMedicationFamilyStates, redoseWindowState } from "./prn-family";
import type { PrnDayExposure, PrnExposureBasis } from "../../prn-redose";
import type {
  AdministrationOutcome,
  DoseStatus,
  DoseStatusOutcome,
  DoseStatusTarget,
  DoseTakenOutcome,
  EscalationAckOutcome,
  HistoricalDoseOutcome,
  RedoseWindowAdministrationOutcome,
} from "../../types";
import type { IntakeObligation } from "../../types";
import { isOfferedOn, slotHintCoversNow } from "../../intake-schedule";
import { formatMedicationDoseProduct } from "../../medication-dose-format";
import { getSituations } from "../../settings";
import { getEffectiveActiveSituations } from "../derived-situations";
import { getActivitiesByDate, isPredictedWorkoutDay } from "../training";
import type { IntakeCondition, IntakeItemKind } from "../../types";

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
      `SELECT l.dose_id, COALESCE(l.recorded_at, l.taken_at) AS taken_at
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date = ? AND l.status = 'taken'
        ORDER BY COALESCE(l.recorded_at, l.taken_at) DESC, l.id DESC`
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

// ---- The ONE intake_item_logs resolution core (#2039) ---------------------------
//
// Every transition of a SCHEDULED dose's daily log row happens here: taken, skipped,
// and clear, with the on-hand supply coupling inside the same transaction. Until #2039
// there were two of these — this one (insert-only, typed, the #232 contract) and a
// tri-state twin living in app/(app)/nutrition/intake-actions.ts with its own
// DELETE/INSERT/UPDATE and its own supply crossings — maintained separately, carrying
// the same #468/#797 BEGIN-IMMEDIATE reasoning in near-identical prose. The repo had
// already paid for that shape once (lib/offline/writes.ts records a parallel offline
// dose writer that drifted and was deleted for it), and the twin had in fact drifted:
// it never refused a PAUSED item, so the one contract markDoseTaken exists to state
// held on the Telegram/offline path and not on the web one.
//
// `intake_item_logs` is now registered in STATEFUL_WRITE_TABLES (lib/stateful-writes.ts)
// so the scan fails the next parallel core instead of review having to catch it.
//
// TWO INTENTS, ONE CORE. `resolveOnly` is the difference and the only one:
//   • resolveOnly (markDoseTaken / markDoseSkipped — Telegram, offline replay, the
//     dashboard hero, the household cockpit): resolve an UNRESOLVED dose. ANY existing
//     row short-circuits and is reported by its ACTUAL status (#280), so a stale ✅ on a
//     dose meanwhile marked skipped is never answered "Logged" and never overwrites it.
//   • the explicit set (setDoseStatusCore — the web tri-state check-off): the user is
//     looking at the control and stating the target, so a flip or a clear is exactly
//     what they asked for.
//
// ONE IMMEDIATE TRANSACTION (#468/#616). Since #797 dropped UNIQUE(dose_id, date) to
// allow PRN multiples, the exists-check below IS the idempotency guard for a scheduled
// dose: BEGIN IMMEDIATE serializes all writers up front (three processes write this DB),
// so the SELECT-then-write is atomic against a concurrent web replica / notify sidecar —
// a double-tap or Telegram retry reads the committed row and no-ops instead of inserting
// a second row and double-decrementing supply.
interface DoseResolveOptions {
  // Resolve-only intent (above). Absent/false = the explicit web set.
  resolveOnly?: boolean;
  // The client-supplied item id riding on a Telegram callback token. NEVER trusted for
  // the write (#613/#614) — the write always uses the dose row's own item_id — but a
  // token whose item contradicts the dose's real one is forged/stale and is refused.
  supplementId?: number | null;
  // An OPTIONAL captured intake instant (#1427), supplied only by the offline write
  // queue's replay: the tap happened when the user actually took the dose, possibly
  // hours before the connection came back. Validated (never trusted) by the pure
  // resolveQueuedTakenAt and silently falling back to the server's own now when
  // unusable — a skewed phone clock must cost the precise minute, never the dose log.
  takenAt?: Date;
  // Which MESSAGE'S tap this confirm is (#2264): the `notify_messages` row id the
  // Telegram handler resolved from its (chat, message), or absent/null everywhere
  // else. Attribution for the dose-time correction ride-along only — the burst this
  // row joins renders on the message that produced it, never on a sibling.
  notifyMessageId?: number | null;
}

function applyDoseStatusCore(
  profileId: number,
  doseId: number,
  date: string,
  target: DoseStatusTarget,
  opts: DoseResolveOptions = {}
): DoseStatusOutcome {
  // A far-off (forged) date can't land a misdated row (#614); a legitimate late tap
  // within the window still logs to the reminder's own day. The web path always passes
  // today(), so this is free there.
  if (!isDoseDateAccepted(profileId, date)) return "stale-dose";
  return writeTx((): DoseStatusOutcome => {
    // The dose id can arrive from a Telegram callback, so verify it belongs to this
    // profile (via its parent item) before touching anything. Read the item id from the
    // row rather than trusting the caller. A retired dose is no longer part of the
    // schedule — treat it like a deleted one.
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
    // A paused/stopped item keeps its buttons in old messages; refuse the write so a
    // lingering reminder can't silently log doses (and burn supply) for an item the user
    // has deliberately paused. The web control is only RENDERED for an active item, so
    // this is the forged/stale-post case there — it is not a new refusal a real tap can
    // reach, it is the twin's missing half of the #232 contract.
    if (!owned.active) return "inactive";
    if (opts.supplementId != null && opts.supplementId !== owned.item_id) {
      return "stale-dose";
    }

    const existing = db
      .prepare(
        `SELECT status, supply_adjusted FROM intake_item_logs
          WHERE dose_id = ? AND date = ?`
      )
      .get(doseId, date) as
      { status: DoseStatus; supply_adjusted: number } | undefined;
    // An existing log resolves the day for a one-way tap; report its ACTUAL status
    // (#280) so a ✅ on a dose meanwhile marked skipped is never answered "Logged",
    // and never re-decrement supply.
    if (existing && opts.resolveOnly) {
      return existing.status === "skipped"
        ? "already-skipped"
        : "already-taken";
    }
    const current: DoseStatusTarget = existing ? existing.status : "clear";
    if (current === target) return "unchanged";

    // Whether the row that stands (or stood) actually consumed supply. A taken row
    // written by this core carries supply_adjusted = 1; a deliberately unadjusted
    // historical backfill (#1933) carries 0, and clearing THAT must not hand back units
    // it never took. Only a taken row's flag is meaningful — a skipped row consumed
    // nothing whatever the column says.
    const consumed = current === "taken" && existing?.supply_adjusted !== 0;

    if (target === "clear") {
      db.prepare(
        "DELETE FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      ).run(doseId, date);
      if (consumed) incrementSupply(profileId, owned.item_id);
      return "cleared";
    }

    // Snapshot the dose amount at confirm time: history must keep showing what was
    // actually taken even after a later dosage edit rewrites the dose row. A skip
    // records no amount — nothing was consumed.
    const amount = target === "taken" ? owned.amount : null;
    if (!existing) {
      // recorded_at is the tap moment for a scheduled confirm: the schedule dictates WHEN,
      // so a precise intake time isn't captured here (the PRN path is what makes recorded_at
      // user-suppliable) — EXCEPT for a replayed offline confirm, whose tap moment was
      // captured on the client and validated above (#1427). An unusable/absent stamp
      // COALESCEs to the server's own now, but from the CLOCK SEAM (sqlNow, #1534), not
      // SQL's `datetime('now')`: `date` came from `today()`, so a real-clock fallback
      // would write a self-contradicting row (a recorded_at whose profile-local date isn't
      // the row's own date) on any run that crosses midnight. A skip carries none.
      const stamp = opts.takenAt
        ? resolveQueuedTakenAt(
            opts.takenAt,
            getTimezone(profileId),
            date,
            // The APP's now (#2312), not a bare `new Date()`. This used to read
            // real time on the reasoning that a client capture and the server's
            // clock are two independent REAL clocks — the same reasoning the food
            // path carried until #2287 overturned it. The guard's OTHER half
            // already compares against `date`, which came from `today()`, i.e.
            // from this seam: a predicate whose two halves read two different
            // clocks is not one predicate. And under the e2e freeze the capture
            // and the seam are the same frozen instant, so real time refuses a
            // seconds-old stamp as hours in the future and the dose silently
            // loses its captured minute. Inert in production, where the seam IS
            // real time, so a genuinely fast device is still refused.
            clockNow()
          )
        : null;
      db.prepare(
        `INSERT INTO intake_item_logs
           (dose_id, item_id, date, amount, status, recorded_at, notify_message_id)
         VALUES (?,?,?,?,?, CASE WHEN ? = 'taken' THEN COALESCE(?, ?) ELSE NULL END, ?)`
      ).run(
        doseId,
        owned.item_id,
        date,
        amount,
        target,
        target,
        stamp ? utcSqlString(stamp) : null,
        sqlNow(),
        opts.notifyMessageId ?? null
      );
    } else {
      // A flip between the two resolved states. `recorded_at` is deliberately left alone:
      // it records when the dose was TAPPED, and a correction of the status is not a
      // second intake. supply_adjusted follows the write below, so the row always states
      // whether its decrement is currently applied.
      db.prepare(
        `UPDATE intake_item_logs SET status = ?, amount = ?, supply_adjusted = ?
          WHERE dose_id = ? AND date = ?`
      ).run(target, amount, target === "taken" ? 1 : 0, doseId, date);
    }

    // ONLY a taken row consumes supply, so crossing the taken boundary is the sole thing
    // that moves the count (the symmetric restore #232 calls for): clear/skipped → taken
    // decrements once, taken → clear/skipped gives back exactly what was taken, and a
    // skipped ↔ clear flip never touches it.
    if (target === "taken") decrementSupply(profileId, owned.item_id);
    else if (consumed) incrementSupply(profileId, owned.item_id);

    if (target === "skipped") return "skipped";
    // The log is written either way — reality is reality. What changes is the ANSWER
    // (#1602): an off-cadence confirm reports itself so the handler can say which days
    // the dose was meant for instead of a bare ✓. Evaluated on the LOG'S date, not
    // today: a late tap on yesterday's reminder is judged against yesterday.
    return cadenceOn(owned, date) && doseOnDay(owned, date)
      ? "logged"
      : "logged-off-day";
  });
}

// Narrow the shared core's outcome to the one-way resolvers' contract. The two
// tri-state-only members are unreachable from `resolveOnly` — ANY existing row
// short-circuits above, so the flip/clear branches are never entered — and answering a
// stale tap rather than inventing a confirmation is the safe reading if that ever
// changes.
function resolvedOutcome(outcome: DoseStatusOutcome): DoseTakenOutcome {
  return outcome === "cleared" || outcome === "unchanged"
    ? "stale-dose"
    : outcome;
}

// Log a single dose as taken on `date`, idempotently — the non-React-context write used
// by the dashboard hero, the Upcoming inline confirm, Telegram inline actions, the
// household cockpit and the offline replay. Never deletes, never overwrites a deliberate
// skip. Returns what actually happened so the caller can answer honestly: a tap on a
// button whose dose was since deleted/retired by an edit, or whose item was paused, logs
// NOTHING and must not be acknowledged as "Logged".
export function markDoseTaken(
  profileId: number,
  doseId: number,
  supplementId: number | null,
  date: string,
  takenAt?: Date,
  // Which message's tap this is (#2264) — Telegram reminder handlers only; see
  // DoseResolveOptions.notifyMessageId.
  notifyMessageId?: number | null
): DoseTakenOutcome {
  return resolvedOutcome(
    applyDoseStatusCore(profileId, doseId, date, "taken", {
      resolveOnly: true,
      supplementId,
      takenAt,
      notifyMessageId,
    })
  );
}

// Log a single dose as SKIPPED on `date` (#232) — the sibling of markDoseTaken for the
// Telegram ⏭️ button and the offline skip. A skip is a deliberate "chose not to take it"
// decision, so it writes a status='skipped' row (amount NULL: nothing was consumed) and
// NEVER decrements on-hand supply. Same staleness contract as markDoseTaken, and —
// because a taken→skipped change must be an explicit UI toggle, never a stale-button
// overwrite — it does NOT flip an already-resolved dose: any existing row for
// (dose,date) is left untouched and reported by its ACTUAL status (#280).
export function markDoseSkipped(
  profileId: number,
  doseId: number,
  supplementId: number | null,
  date: string
): DoseTakenOutcome {
  return resolvedOutcome(
    applyDoseStatusCore(profileId, doseId, date, "skipped", {
      resolveOnly: true,
      supplementId,
    })
  );
}

// Set one dose to an explicit target status for `date` — the web tri-state check-off's
// write (#232), auth-blind and profileId-first like every other lib write core. The
// Server Action (setDoseStatus) is the authorization + validation boundary over it and
// renders the outcome; it owns no SQL of its own.
export function setDoseStatusCore(
  profileId: number,
  doseId: number,
  date: string,
  target: DoseStatusTarget
): DoseStatusOutcome {
  return applyDoseStatusCore(profileId, doseId, date, target);
}

// ---- PRN (as-needed) administrations ledger (#797) ----

// Short window within which a second administration of the SAME dose is treated as
// a double-tap (a re-tapped widget button, a retried Telegram callback, a double
// click) rather than a second real intake. PRN logging is deliberately NOT
// idempotent — multiple/day is the whole point (#797) — so this replaces the
// dropped UNIQUE(dose_id,date) as the accidental-repeat guard, keeping a stray tap
// from inventing a phantom dose (and burning supply). Keyed on recorded_at PROXIMITY,
// so two retro entries at genuinely different times (4:00 and 4:30) both land while
// two taps within ~2 min collapse to one.
export const ADMIN_DEDUP_WINDOW_SEC = 120;

function logAdministrationTx(
  profileId: number,
  itemId: number,
  date: string,
  recordedAtStr: string,
  expectedRedoseAdministrationId: null,
  notifyMessageId?: number | null
): AdministrationOutcome;
function logAdministrationTx(
  profileId: number,
  itemId: number,
  date: string,
  recordedAtStr: string,
  expectedRedoseAdministrationId: number,
  notifyMessageId?: number | null
): RedoseWindowAdministrationOutcome;
function logAdministrationTx(
  profileId: number,
  itemId: number,
  date: string,
  recordedAtStr: string,
  expectedRedoseAdministrationId: number | null,
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
        WHERE dose_id = ? AND status = 'taken' AND recorded_at IS NOT NULL
          AND ABS(strftime('%s', recorded_at) - strftime('%s', ?)) <= ?
        LIMIT 1`
    )
    .get(dose.dose_id, recordedAtStr, ADMIN_DEDUP_WINDOW_SEC) as
    { id: number } | undefined;
  if (!dup) {
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, amount, recorded_at, notify_message_id)
       VALUES (?,?,?,?,?,?)`
    ).run(
      dose.dose_id,
      itemId,
      date,
      dose.amount,
      recordedAtStr,
      notifyMessageId ?? null
    );
    decrementSupply(profileId, itemId);
  }
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS count, MAX(recorded_at) AS last
         FROM intake_item_logs
        WHERE item_id = ? AND date = ? AND status = 'taken'`
    )
    .get(itemId, date) as { count: number; last: string | null };
  return {
    kind: dup ? "duplicate" : "logged",
    count: summary.count,
    lastGivenAt: summary.last ?? recordedAtStr,
    date,
  };
}

// Log one PRN administration of an intake item — auth-blind, profileId-first (the
// lib-write-core convention, mirroring logFoodServingCore): both the
// logMedicationAdministration Server Action (dashboard quick-log) and the Telegram
// /dose tap call this, so the ingestion path is one computation regardless of
// surface, and the auth gate stays entirely in the action. `recordedAt` is the real
// intake time (undefined = now), bounded by isGivenAtAccepted (#614). Each accepted,
// non-duplicate administration is a NEW intake_item_logs row (the per-administration
// ledger) that decrements on-hand supply once. One IMMEDIATE transaction (#468) so
// the dedup read + insert + supply move see one consistent state under a concurrent
// web/Telegram tap. Returns a typed outcome so the caller answers from what actually
// happened rather than unconditionally confirming.
export function logAdministration(
  profileId: number,
  itemId: number,
  recordedAt?: Date,
  // Which message's tap this is (#2264) — Telegram handlers only, exactly as
  // markDoseTaken takes it. Without it a chat-logged administration produces an
  // UNATTRIBUTED correction burst, which may then ride the newest live dose message in
  // the chat rather than the message it came from (#2418 part 2): the digest's offer
  // list is not a dose reminder, so its taps have to say where they happened or their
  // 🕐 chips surface on an unrelated reminder.
  notifyMessageId?: number | null
): AdministrationOutcome {
  const tz = getTimezone(profileId);
  const when = recordedAt ?? clockNow();
  const todayStr = today(profileId);
  if (recordedAt && !isGivenAtAccepted(tz, todayStr, when, clockNow())) {
    return { kind: "invalid-time" };
  }
  const date = dateStrInTz(tz, when);
  const recordedAtStr = utcSqlString(when);
  return writeTx(() =>
    logAdministrationTx(
      profileId,
      itemId,
      date,
      recordedAtStr,
      null,
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
  armingAdministrationId: number
): RedoseWindowAdministrationOutcome {
  const tz = getTimezone(profileId);
  const when = clockNow();
  const date = dateStrInTz(tz, when);
  const recordedAtStr = utcSqlString(when);
  return writeTx(() =>
    logAdministrationTx(
      profileId,
      itemId,
      date,
      recordedAtStr,
      armingAdministrationId
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
  recordedAt: Date,
  amountOverride: string | null,
  adjustSupply: boolean
): HistoricalDoseOutcome {
  const tz = getTimezone(profileId);
  const todayStr = today(profileId);
  // The app clock, not the wall clock (#2031): `todayStr` above is seam-derived and
  // so is the stored recorded_at this may be re-validating, so all three must agree.
  if (!isHistoricalDoseTimeAccepted(tz, todayStr, recordedAt, clockNow())) {
    return { kind: "invalid-time" };
  }
  const date = dateStrInTz(tz, recordedAt);
  const recordedAtStr = utcSqlString(recordedAt);

  return writeTx((tx): HistoricalDoseOutcome => {
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
              AND s.profile_id = ? AND l.recorded_at IS NOT NULL
              AND ABS(strftime('%s', l.recorded_at) - strftime('%s', ?)) <= ?
            LIMIT 1`
        )
        .get(doseId, profileId, recordedAtStr, ADMIN_DEDUP_WINDOW_SEC);
      if (duplicate) return { kind: "duplicate" };
    }

    const amount = amountOverride?.trim() || dose.amount;
    if (courseToExtend) {
      // Backdate the course's start through the course core (#2132) — the same
      // transaction (Tx token), the DML lives with the invariant's owner.
      setCourseStartDate(tx, profileId, itemId, courseToExtend.id, date);
    }
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, amount, recorded_at, supply_adjusted)
       VALUES (?,?,?,?,?,?)`
    ).run(doseId, itemId, date, amount, recordedAtStr, adjustSupply ? 1 : 0);
    if (adjustSupply) decrementSupply(profileId, itemId);
    return { kind: "logged", date };
  });
}

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
// IT WRITES `occurred_at`, NEVER `recorded_at` (#2228 decision 1). Under the #2229
// ruling `recorded_at` is a RECORD instant (the tap), so a human's stated administration
// time lands in the stated-only event column (migration 165) and `recorded_at` is
// read-only history for this path — which also keeps the PRN redose window and the
// phantom-dose proximity guard, both keyed on `recorded_at`, behaving identically
// before and after an amendment (the issue's constraint 3).
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
    } else if (occurredAt) {
      // The phantom-dose proximity guard, unchanged: other rows still participate
      // by their `recorded_at` (the issue's constraint 3 — moving the guard onto
      // `occurred_at` is its own decision), judged against the stated instant. An
      // amendment that clears the time states nothing to be near, so it has no
      // proximity to check and lands as an ordinary `logged` outcome.
      const duplicate = db
        .prepare(
          `SELECT l.id
             FROM intake_item_logs l
             JOIN intake_items s ON s.id = l.item_id
            WHERE l.dose_id = ? AND l.id <> ? AND l.status = 'taken'
              AND s.profile_id = ? AND l.recorded_at IS NOT NULL
              AND ABS(strftime('%s', l.recorded_at) - strftime('%s', ?)) <= ?
            LIMIT 1`
        )
        .get(
          row.dose_id,
          logId,
          profileId,
          utcSqlString(occurredAt),
          ADMIN_DEDUP_WINDOW_SEC
        );
      if (duplicate) return { kind: "duplicate" };
    }

    if (courseToExtend) {
      // Backdate the course's start through the course core (#2132) — the same
      // transaction (Tx token), the DML lives with the invariant's owner.
      setCourseStartDate(tx, profileId, itemId, courseToExtend.id, date);
    }
    const amount = amountOverride?.trim() || row.dose_amount;
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

// The day's PRN administrations for one item, most-recent first — for the med
// card's "2 today · last 4:02pm" line. `recorded_at` and `taken_at` are the row's
// RECORD CHAIN (#2229, migration 173): the first is the tap the app filed the
// administration under, the second the insert stamp behind it. Neither is the event
// instant — that is `occurred_at`, and only when somebody stated one.
// Profile-scoped via the parent item (the denormalized
// item_id, kept consistent by migration 011).
export function getAdministrationsForItemOnDate(
  profileId: number,
  itemId: number,
  date: string
): {
  id: number;
  recorded_at: string | null;
  taken_at: string;
  amount: string | null;
  product: string | null;
}[] {
  return db
    .prepare(
      `SELECT l.id, l.recorded_at, l.taken_at, l.amount, l.product
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ? AND l.date = ?
          AND l.status = 'taken'
        ORDER BY COALESCE(l.recorded_at, l.taken_at) DESC, l.id DESC`
    )
    .all(profileId, itemId, date) as {
    id: number;
    recorded_at: string | null;
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
    recorded_at: string | null;
    taken_at: string;
    amount: string | null;
    product: string | null;
  }[]
> {
  const out = new Map<
    number,
    {
      id: number;
      recorded_at: string | null;
      taken_at: string;
      amount: string | null;
      product: string | null;
    }[]
  >();
  if (itemIds.length === 0) return out;
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT l.item_id, l.id, l.recorded_at, l.taken_at, l.amount, l.product
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id IN (${placeholders}) AND l.date = ?
          AND l.status = 'taken'
        ORDER BY COALESCE(l.recorded_at, l.taken_at) DESC, l.id DESC`
    )
    .all(profileId, ...itemIds, date) as {
    item_id: number;
    id: number;
    recorded_at: string | null;
    taken_at: string;
    amount: string | null;
    product: string | null;
  }[];
  for (const r of rows) {
    const arr = out.get(r.item_id) ?? [];
    arr.push({
      id: r.id,
      recorded_at: r.recorded_at,
      taken_at: r.taken_at,
      amount: r.amount,
      product: r.product,
    });
    out.set(r.item_id, arr);
  }
  return out;
}

// The ONE ordering every dose-history reader sorts by (#2417). Three readers answer
// the same question at three scopes — one item (getIntakeDoseHistory), a page's worth
// of items (getIntakeDoseHistoryForItems), and the whole profile
// (getIntakeDoseHistoryAll) — and they MUST sort identically: the cross-item ledger
// narrowed to one item is asserted row-for-row against the item-scoped reader, so a
// drifted ORDER BY in any one of them is a broken surface, not a cosmetic difference.
// Sharing the string is what makes that physically impossible rather than merely true
// today.
//
// The COALESCE is the recorded_at → taken_at RECORD CHAIN, hand-rolled here on purpose:
// both links answer one question by the owner's #2205 ruling, and routing it through
// `recordInstant` means selecting both columns and ordering in JS, which changes the
// perf shape of the medication surface's hottest query — a read-path change with its
// own PR. Extracting it does not retire it; it makes retiring it a ONE-line edit.
const DOSE_HISTORY_ORDER =
  "ORDER BY l.date DESC, COALESCE(l.recorded_at, l.taken_at) DESC, l.id DESC";

// One taken ledger row as the dose-history surfaces render it. It carries the row's
// declared temporal columns — `occurred_at` (the event instant, stated-only, migration
// 165) alongside the `recorded_at` → `taken_at` record chain — so a caller can ask
// lib/row-instants.ts the row-level question instead of pairing columns by hand, and
// so an unstated row can render "recorded 7:02am" rather than a bare clock (#2228
// decision 4). A type alias rather than an interface so it satisfies the readers'
// `Record<string, unknown>` row parameter structurally.
export type IntakeDoseHistoryRow = {
  id: number;
  dose_id: number;
  date: string;
  occurred_at: string | null;
  recorded_at: string | null;
  taken_at: string;
  amount: string | null;
  product: string | null;
};

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
      `SELECT l.id, l.dose_id, l.date, l.occurred_at, l.recorded_at, l.taken_at,
              l.amount, l.product
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ? AND l.status = 'taken'
          AND l.date >= ?
        ${DOSE_HISTORY_ORDER}`
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
      `SELECT l.id, l.dose_id, l.item_id, l.date, l.occurred_at, l.recorded_at,
              l.taken_at, l.amount, l.product
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id IN (${placeholders})
          AND l.status = 'taken' AND l.date >= ?
        ${DOSE_HISTORY_ORDER}`
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
      occurred_at: r.occurred_at,
      recorded_at: r.recorded_at,
      taken_at: r.taken_at,
      amount: r.amount,
      product: r.product,
    });
    out.set(r.item_id, arr);
  }
  return out;
}

// One row of the CROSS-ITEM dose ledger (#2417): the same taken-row shape the
// item-scoped reads return, plus the identity of the item it was taken against.
export type IntakeDoseLedgerRow = IntakeDoseHistoryRow & {
  item_id: number;
  item_name: string;
  item_kind: IntakeItemKind;
};

// The cross-item dose ledger: every taken row this profile recorded in a window,
// newest first, with the item's name and kind joined in (#2417).
//
// The third member of this family, and deliberately not a fork of it: the same
// `status = 'taken'` semantics (a skip is adherence's business, not the record of
// what was actually taken), the LITERALLY same ordering (`DOSE_HISTORY_ORDER`, shared
// by all three readers), and the same profile scoping through the parent item. What it
// adds is that the QUESTION is no longer item-scoped — "what did I actually take last
// week, across items" used to cost one navigation per item.
//
// The JOIN is on the item's PROFILE ONLY — never on `active`. History outlives
// retirement: a dose taken from a bottle that has since been paused, retired, or
// swapped still happened, and dropping it here would silently rewrite the record.
//
// `itemId` is offered so the ledger's item filter narrows in SQL rather than by
// post-filtering the window; narrowed to one item it returns exactly the rows
// `getIntakeDoseHistory` returns for that item over the same window (asserted in
// lib/__db_tests__/supplement-dose-history.test.ts), which is what lets the ledger
// and the per-item panel be two views of one ledger instead of two answers.
export interface IntakeDoseLedgerFilters {
  kind?: IntakeItemKind;
  itemId?: number;
  // Inclusive last day of the window; omit for "up to the newest row".
  untilDate?: string;
}

// The optional narrowing clauses, in the order their params are bound. The profile
// scope is NEVER built here — it stays spelled out in each statement's own text
// below, so the profile-scoping guard can read the query and so no future filter can
// accidentally replace the join condition that makes it this profile's ledger.
function doseLedgerFilters(opts: IntakeDoseLedgerFilters): {
  sql: string;
  params: (string | number)[];
} {
  const filters: string[] = [];
  const params: (string | number)[] = [];
  if (opts.untilDate) {
    filters.push(" AND l.date <= ?");
    params.push(opts.untilDate);
  }
  if (opts.kind) {
    filters.push(" AND s.kind = ?");
    params.push(opts.kind);
  }
  if (opts.itemId) {
    filters.push(" AND l.item_id = ?");
    params.push(opts.itemId);
  }
  return { sql: filters.join(""), params };
}

export function getIntakeDoseHistoryAll(
  profileId: number,
  sinceDate: string,
  opts: IntakeDoseLedgerFilters = {}
): IntakeDoseLedgerRow[] {
  const filters = doseLedgerFilters(opts);
  return db
    .prepare(
      `SELECT l.id, l.dose_id, l.item_id, l.date, l.occurred_at, l.recorded_at,
              l.taken_at, l.amount, l.product,
              s.name AS item_name, s.kind AS item_kind
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.status = 'taken' AND l.date >= ?${filters.sql}
        ${DOSE_HISTORY_ORDER}`
    )
    .all(profileId, sinceDate, ...filters.params) as IntakeDoseLedgerRow[];
}

export interface IntakeDoseLedgerPage {
  rows: IntakeDoseLedgerRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ONE page of that ledger, plus the total the pager needs.
//
// This is what the dose-history SURFACE reads (#2445). Its date range offers an
// explicit "All time", which passes the ISO floor as `sinceDate` — a window with no
// lower bound — and the reader above has no LIMIT, so a twice-daily medication kept
// for years fetched and rendered thousands of rows on that tap. A range control is a
// filter, not a bound: "all time" is a legitimate answer here (history outlives
// retirement, and a dose taken years ago still happened), so the bound has to be the
// page, and the page has to reach the SQL rather than only the DOM.
//
// The unpaged reader stays for callers that genuinely want the whole window in one
// array — and as the row-for-row cross-check against the per-item panel — but nothing
// that RENDERS the ledger should use it.
export function getIntakeDoseLedgerPage(
  profileId: number,
  sinceDate: string,
  opts: IntakeDoseLedgerFilters,
  page: number,
  pageSize: number
): IntakeDoseLedgerPage {
  const size = Math.max(1, Math.trunc(pageSize));
  const filters = doseLedgerFilters(opts);
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE s.profile_id = ? AND l.status = 'taken' AND l.date >= ?${filters.sql}`
      )
      .get(profileId, sinceDate, ...filters.params) as { n: number }
  ).n;
  const clamped = Math.min(clampPage(page), pageCount(total, size));
  const rows = db
    .prepare(
      `SELECT l.id, l.dose_id, l.item_id, l.date, l.occurred_at, l.recorded_at,
              l.taken_at, l.amount, l.product,
              s.name AS item_name, s.kind AS item_kind
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.status = 'taken' AND l.date >= ?${filters.sql}
        ${DOSE_HISTORY_ORDER}
        LIMIT ? OFFSET ?`
    )
    .all(
      profileId,
      sinceDate,
      ...filters.params,
      size,
      pageOffset(clamped, size)
    ) as IntakeDoseLedgerRow[];
  return { rows, total, page: clamped, pageSize: size };
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
// Kind 'administration' in deleted_rows (the shared retention-purged holding table);
// restore
// re-inserts the ledger row (NEW id) and RE-decrements supply. The undo toast +
// undoDelete action route restore back here via restoreDeletedRow's kind branch.

// The captured shape of one administration row (the deleted_rows payload for kind
// 'administration'). item_id + the log's own columns, enough to re-insert it verbatim.
interface CapturedAdministration {
  dose_id: number;
  item_id: number;
  date: string;
  taken_at: string;
  recorded_at: string | null;
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
        `SELECT l.id, l.dose_id, l.item_id, l.date, l.taken_at, l.recorded_at,
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
      recorded_at: row.recorded_at,
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

    // Scoped at the DELETE too (#2059), not only at the SELECT that captured the row:
    // an undo is the one write here that destroys a record of something taken, so it is
    // the last statement that should depend on a sibling query staying correct.
    db.prepare(
      `DELETE FROM intake_item_logs
        WHERE id = ? AND item_id IN (
          SELECT id FROM intake_items WHERE profile_id = ?
        )`
    ).run(logId, profileId);
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
         (dose_id, item_id, date, taken_at, recorded_at, amount, product, status,
          supply_adjusted)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      captured.dose_id,
      captured.item_id,
      captured.date,
      captured.taken_at,
      captured.recorded_at,
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
      `SELECT l.id AS id, l.recorded_at AS recordedAt
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ? AND l.status = 'taken'
          AND l.recorded_at IS NOT NULL
        ORDER BY l.recorded_at DESC, l.id DESC
        LIMIT 1`
    )
    .get(profileId, itemId) as { id: number; recordedAt: string } | undefined;
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
    latestGivenAt: latest?.recordedAt ?? null,
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
              (SELECT MAX(COALESCE(l.recorded_at, l.taken_at)) FROM intake_item_logs l
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
export function getIntakeEscalateChatId(
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
// columns (the Medications loader's lastDates() uses the same today()-based window); a UTC
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
    kind: IntakeItemKind;
    product: string | null;
    condition: IntakeCondition;
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
// the IMMUTABLE audit stamp — burst identity and FRESHNESS key on it, never on
// `recorded_at`, because a correction is not a tap and must not renew the correction window
// (#2206). `statedAt` is `recorded_at`: the administration instant itself, which is what the
// row's header states and what a chip counts back from, so repeat taps compose.
export interface DoseTapRow {
  id: number;
  tapAt: string;
  statedAt: string | null;
  // Which message's tap wrote this row (#2264) — the burst's attribution; null for a
  // web/offline confirm or a pruned message row.
  messageRef: number | null;
  label: string;
  doseId: number;
  date: string;
}

// The profile's dose confirmations tapped within the correction window, oldest first.
// Bounded by that window, so the read is a handful of rows. Profile-scoped through the
// dose → item JOIN.
//
// SCHEDULED CONFIRMS ONLY IS NOT THE RULE — a PRN administration is exactly the case
// #2020 is about (the redose window arms off `recorded_at`), so both are here. What IS
// excluded is a row with no `recorded_at` at all: there is no administration instant to
// correct, and inventing one would be the guess this feature exists to end.
export function getRecentDoseTaps(
  profileId: number,
  now: Date = clockNow()
): DoseTapRow[] {
  const since = utcSqlString(
    new Date(now.getTime() - CORRECTION_FRESH_MIN * 60_000)
  );
  const rows = db
    .prepare(
      `SELECT l.id AS id, l.dose_id AS doseId, l.date AS date,
              l.taken_at AS takenAt, l.recorded_at AS recordedAt,
              l.notify_message_id AS messageRef, s.name AS name
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.status = 'taken'
          AND l.recorded_at IS NOT NULL AND l.taken_at >= ?
        ORDER BY l.taken_at, l.id
        LIMIT 100`
    )
    .all(profileId, since) as {
    id: number;
    doseId: number;
    date: string;
    takenAt: string;
    recordedAt: string | null;
    messageRef: number | null;
    name: string;
  }[];
  const out: DoseTapRow[] = [];
  for (const r of rows) {
    // Stored datetimes carry no zone, so they are parsed as UTC rather than handed to
    // `new Date`, which would read them in the process-local zone.
    const tap = parseUtcSql(r.takenAt);
    if (!tap) continue;
    const given = r.recordedAt ? parseUtcSql(r.recordedAt) : null;
    out.push({
      id: r.id,
      tapAt: tap.toISOString(),
      statedAt: given ? given.toISOString() : null,
      messageRef: r.messageRef,
      label: r.name,
      doseId: r.doseId,
      date: r.date,
    });
  }
  return out;
}

// The correction rows a dose keyboard should carry right now. Same computation as the
// food side (#221), over the ledger the dose reminder itself writes to. `binding` is
// the rendering message's #2264 identity; omitting it returns the profile-wide set,
// which only a caller that is not rendering a message may use.
export function getDoseCorrectionBursts(
  profileId: number,
  now: Date = clockNow(),
  binding?: CorrectionMessageBinding
): CorrectionBurst[] {
  return correctionBursts(getRecentDoseTaps(profileId, now), now, binding);
}

// The typed result of a dose-time correction:
//   restamped — `count` log rows now carry a corrected `recorded_at`; `crossedMidnight`
//               says whether any of them landed on a different calendar day, which the
//               toast has to mention because the row's DAY deliberately does not move.
//               `anchor` names the dose + day the message can be rebuilt from once the
//               session's own buttons are gone.
//   no-burst  — the anchor row is gone or belongs to another profile. Nothing written.
//   out-of-range — the resolver refused at least one row (a chip that would walk the
//               burst past the floor, #2206). All-or-nothing: a burst is one error.
export type DoseRestampOutcome =
  | {
      kind: "restamped";
      count: number;
      crossedMidnight: boolean;
      anchor: { doseId: number; date: string };
    }
  | { kind: "no-burst" }
  | { kind: "out-of-range" };

// Correct a burst of administration instants (issue #2020).
//
// THE ROW'S `date` DOES NOT MOVE, and this is the deliberate contrast with the food
// side. A serving's day is a fact about the serving, so #2019's correction re-dates it;
// a dose's day is SCHEDULE-OWNED (#614 — the token's date is the day the reminder was
// asking about), so a correction that crosses midnight moves only `recorded_at` and leaves
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
//   • It only ever moves an instant EARLIER (chips step back, picker hours are all past),
//     so the PRN redose window can only become MORE conservative — the safe direction
//     for the one consumer that is safety-relevant. Repeat chip taps COMPOSE off the
//     stored `recorded_at` (#2206), which keeps that direction and bounds how far it can go
//     through the resolver's own floor rather than through idempotence.
export function restampDoseLogsCore(
  profileId: number,
  fromLogId: number,
  resolve: (row: { tapAt: string; statedAt: string | null }) => Date | null
): DoseRestampOutcome {
  return writeTx(() => {
    const rows = db
      .prepare(
        `SELECT l.id AS id, l.dose_id AS doseId, l.date AS date,
                l.taken_at AS takenAt, l.recorded_at AS recordedAt, s.name AS name
           FROM intake_item_logs l
           JOIN intake_item_doses d ON d.id = l.dose_id
           JOIN intake_items s ON s.id = d.item_id
          WHERE s.profile_id = ? AND l.id >= ? AND l.status = 'taken'
            AND l.recorded_at IS NOT NULL
          ORDER BY l.taken_at, l.id
          LIMIT 200`
      )
      .all(profileId, fromLogId) as {
      id: number;
      doseId: number;
      date: string;
      takenAt: string;
      recordedAt: string | null;
      name: string;
    }[];
    const taps: {
      row: (typeof rows)[number];
      tapAt: string;
      statedAt: string | null;
    }[] = [];
    for (const r of rows) {
      const tap = parseUtcSql(r.takenAt);
      if (!tap) continue;
      const given = r.recordedAt ? parseUtcSql(r.recordedAt) : null;
      taps.push({
        row: r,
        tapAt: tap.toISOString(),
        statedAt: given ? given.toISOString() : null,
      });
    }
    const byId = new Map(taps.map((t) => [t.row.id, t]));
    const burst = burstFrom(
      taps.map((t) => ({
        id: t.row.id,
        tapAt: t.tapAt,
        statedAt: t.statedAt,
        label: t.row.name,
      })),
      fromLogId
    );
    if (!burst) return { kind: "no-burst" as const };

    // Resolve every row before writing any: one refusal refuses the burst.
    const targets = new Map<number, Date>();
    for (const id of burst.ids) {
      const t = byId.get(id);
      if (!t) continue;
      const instant = resolve({ tapAt: t.tapAt, statedAt: t.statedAt });
      if (!instant) return { kind: "out-of-range" as const };
      targets.set(id, instant);
    }

    const tz = getTimezone(profileId);
    let crossedMidnight = false;
    for (const id of burst.ids) {
      const t = byId.get(id);
      const instant = targets.get(id);
      if (!t || !instant) continue;
      if (dateStrInTz(tz, instant) !== t.row.date) crossedMidnight = true;
      // Re-scoped at the point of the WRITE (#2059), not only at the read that
      // produced `id`. The burst ids already come from the profile-filtered SELECT
      // above, so this changes no outcome today — it is the same double defence every
      // other `intake_item_logs` write in this file carries, and the reason CLAUDE.md
      // asks for it is that the ONE statement that mutates a row must not depend on a
      // sibling query staying correct through a later refactor or a new call site.
      // Scoped through dose → item rather than the row's own `item_id`, so the write
      // and the burst SELECT walk the identical join.
      db.prepare(
        `UPDATE intake_item_logs SET recorded_at = ?
          WHERE id = ? AND dose_id IN (
            SELECT d.id FROM intake_item_doses d
            JOIN intake_items s ON s.id = d.item_id
           WHERE s.profile_id = ?
          )`
      ).run(utcSqlString(instant), id, profileId);
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
