// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Adherence / dose-log reads and writes: taken/skipped dose sets, the idempotent
// mark-taken/skipped log writers (the notification-webhook counterparts), the
// escalation-authorization helpers, and the adherence-strip range read.
import { suppressEscalationRearm } from "./no-rearm";
import { db, hoistedStatement, today, writeTx } from "../../db";
import { readAllForUpdate } from "../../tx";
import type { LoggedVia } from "../../logged-via";
import type { BundleId } from "../../bundle";
import {
  cadenceOn,
  doseOnDay,
  doseScheduleAsOf,
  type DoseCadence,
  type ItemCadence,
} from "../../intake-cadence";
import { instantNow, now as clockNow } from "../../clock";
import { shiftDateStr, dateStrInTz, utcInstant } from "../../date";
import { getTimezone } from "../../settings";
import {
  isDoseDateAccepted as isDoseDateInWindow,
  isGivenAtAccepted,
  isHistoricalDoseDateAccepted,
  isHistoricalDoseTimeAccepted,
  resolveQueuedTakenAt,
} from "../../dose-log-window";
import { judgeStatedAt } from "../../stated-time";
import { decrementSupply, incrementSupply } from "./refill";
import { setCourseStartDate } from "./medications";
import { redoseWindowState } from "./prn-family";
import type {
  AdministrationOutcome,
  DoseStatus,
  DoseStatusOutcome,
  DoseStatusTarget,
  DoseTakenOutcome,
  DoseUndoOutcome,
  HistoricalDoseOutcome,
  RedoseWindowAdministrationOutcome,
} from "../../types";
import type { IntakeObligation } from "../../types";
import { getDoseScheduleVersions } from "./schedule";
import { DOSE_CONFIRM_UNDO, DOSE_RESOLUTION } from "@/lib/log-manifest";

// ---- The split modules this file fronts (#2960) -----------------------------
//
// Each responsibility below moved out WHOLE, under its own header. This file keeps
// re-exporting them so `@/lib/queries/intake/adherence` (and the `lib/queries/intake`
// barrel above it) stays the same import surface every caller already uses — the
// issue's "keep one facade" option, with the bodies actually gone rather than aliased.
export * from "./callback-reads";
export * from "./dose-history";
export * from "./dose-time-correction";
export * from "./prn-quick-log";
export * from "./administration-delete";
export * from "./redose-reads";

// A Telegram dose token carries the day the reminder was sent so a late tap still
// logs to the right calendar date — but the token is client-supplied, so an
// arbitrary past/future date must not be honored (the web path pins today()). The
// accepted-window decision lives in lib/dose-log-window (pure, unit-tested); this
// binds it to the profile's today.
function isDoseDateAccepted(profileId: number, date: string): boolean {
  return isDoseDateInWindow(today(profileId), date);
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

// Intake item ids with AT LEAST ONE LOG EVER, of either status (#2574) — the lifetime
// counterpart of the windowed reads above, and the evidence behind "nobody has ever
// engaged with this item".
//
// A skipped dose counts. That is the point rather than an oversight: a skip is a
// decision on the record (#232), so an item somebody has skipped even once is an item
// somebody is managing, and the unconfirmed-medication offer must not reach it.
//
// Scoped through the DOSE's parent rather than the nullable `l.item_id` — a log whose
// denormalised item link was never written still belongs to its dose's item, and
// reading that column would silently answer "never logged" for it. Retired doses are
// included for the same reason: retiring a dose does not un-happen what was taken from
// it.
export function getEverLoggedItemIds(profileId: number): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT d.item_id AS item_id
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ?`
    )
    .all(profileId) as { item_id: number }[];
  return new Set(rows.map((r) => r.item_id));
}

// Dose ids TAKEN on `date` (per-dose view for the schedule check-offs), scoped to
// the profile through the dose's parent item. Skipped doses are NOT taken —
// getSkippedDoseIds surfaces those separately for the tri-state (issue #232).
// Hoisted: adherence is asked per member on every cross-profile surface (360
// executions on one /household render). NOT cache()-wrapped — markDoseTaken writes
// this table and the same request re-reads it to render the new state.
const TAKEN_DOSE_IDS_STMT = hoistedStatement(
  `SELECT l.dose_id FROM intake_item_logs l
     JOIN intake_item_doses d ON d.id = l.dose_id
     JOIN intake_items s ON s.id = d.item_id
    WHERE s.profile_id = ? AND l.date = ? AND l.status = 'taken'`
);
export function getTakenDoseIds(profileId: number, date: string): Set<number> {
  const rows = TAKEN_DOSE_IDS_STMT.all(profileId, date) as {
    dose_id: number;
  }[];
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
      `SELECT l.dose_id,
              COALESCE(l.occurred_at, l.recorded_at) AS administered_at
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date = ? AND l.status = 'taken'
        ORDER BY COALESCE(l.occurred_at, l.recorded_at) DESC, l.id DESC`
    )
    .all(profileId, date) as { dose_id: number; administered_at: string }[];
  const out = new Map<number, string>();
  for (const row of rows) {
    if (!out.has(row.dose_id)) out.set(row.dose_id, row.administered_at);
  }
  return out;
}

// Dose ids deliberately SKIPPED on `date` (issue #232) — the other half of the
// web tri-state and, together with getTakenDoseIds, the "resolved" set that
// suppresses escalation and re-nudging. Scoped through the parent item.
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
//     dashboard atom, the household cockpit): resolve an UNRESOLVED dose. ANY existing
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
  itemId?: number | null;
  // A captured intake instant (#1427), or explicit null when a past-day one-tap states
  // no instant (#4428). Undefined keeps the ordinary live-tap behavior: stamp now.
  takenAt?: Date | null;
  // Which MESSAGE'S tap this confirm is (#2264): the `notify_messages` row id the
  // Telegram handler resolved from its (chat, message), or absent/null everywhere
  // else. Attribution for the dose-time correction ride-along only — the burst this
  // row joins renders on the message that produced it, never on a sibling.
  notifyMessageId?: number | null;
  // WHICH COMPOSED ACTION WROTE THIS ROW (#4328), or absent for an ordinary one-at-a-
  // time tap, which composed nothing. Stamped at CREATION only, like `logged_via` and
  // for the same reason: it records the write EVENT, and an amendment months later is
  // not a new event. The Day ledger's collapse reads it instead of guessing a bundle
  // from a shared write minute.
  bundleId?: BundleId;
}

// WHAT EACH DOOR LETS ITS CALLER STATE (#4742, #4745), derived from the one options
// type above rather than restated beside it — so a field added there reaches every
// door, and no door can answer "which composed action wrote this" with silence. What
// each Omit takes away is what the door itself decides: `markDoseTaken` IS the
// resolve-only intent and takes the item id as its own argument, and the explicit web
// set is a tri-state tap — it carries no Telegram message and reads no callback token.
type DoseConfirmOptions = Omit<DoseResolveOptions, "resolveOnly" | "itemId">;
type DoseSetOptions = Omit<DoseResolveOptions, "itemId" | "notifyMessageId">;

function applyDoseStatusCore(
  profileId: number,
  doseId: number,
  date: string,
  target: DoseStatusTarget,
  // WHICH SURFACE THIS WRITE CAME FROM (#3087). Required, with no default, so a new
  // call site cannot silently land in the wrong bucket — the property the whole
  // column rests on. Stamped at CREATION only: a `clear` DELETES the row and stores
  // nothing, and the UPDATE arm below leaves the original stamp exactly where it is,
  // because an edit is not a new tap.
  loggedVia: LoggedVia,
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
    owned.versions = getDoseScheduleVersions(profileId).get(doseId);
    // A paused/stopped item keeps its buttons in old messages; refuse the write so a
    // lingering reminder can't silently log doses (and burn supply) for an item the user
    // has deliberately paused. The web control is only RENDERED for an active item, so
    // this is the forged/stale-post case there — it is not a new refusal a real tap can
    // reach, it is the twin's missing half of the #232 contract.
    if (!owned.active) return "inactive";
    if (opts.itemId != null && opts.itemId !== owned.item_id) {
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
    const amount =
      target === "taken"
        ? (doseScheduleAsOf(owned, date).amount ?? null)
        : null;
    // `recorded_at` is immutable capture; `occurred_at` is the administration the
    // Taken action asserts. A skip records the action but asserts no administration.
    const capturedAt = clockNow();
    // WHAT THIS ROW STATES, DECIDED ONCE, ABOVE THE INSERT/UPDATE SPLIT (#4686/#4779).
    // The UPDATE arm used to bind a bare `instantNow()`, so a past-day skipped→taken
    // flip both discarded a stated minute AND stamped today's instant onto yesterday's
    // dose — and since the arming reads then coalesced onto `recorded_at`, which on a
    // flip is the instant of the SKIP, a caregiver who skipped the 8pm ibuprofen and
    // gave it at 01:30 was pushed "Redose window open" at 02:10, forty minutes after
    // the dose. The target and the options own what the row states; which arm the row
    // happens to take does not.
    //
    // THREE LIMBS, AND THE THIRD IS THE ONE EVERY MOUNTED TODAY-FLIP TAKES:
    //   • `takenAt === null`      — explicitly untimed. The tri-state action yields it
    //                               for any day that is not the profile's today, and
    //                               the minute prompt's "Don't know" keeps it.
    //   • `takenAt` truthy        — the stated minute, resolved against THIS row's day.
    //                               An unusable value costs only that precision and
    //                               falls back to the capture instant.
    //   • `takenAt === undefined` — the captured instant. The action yields undefined
    //                               when nothing is stated on today's date, and
    //                               `toggleTaken` passes no options object at all.
    // A two-way here type-checks, keeps both suites green — nothing asserted
    // `occurred_at` on the UPDATE arm before this change — and makes every same-day
    // flip write NULL, which with the union above leaves the family permanently
    // unplaced. Control C4b is the test that reds on exactly that.
    const occurredAt =
      target !== "taken" || opts.takenAt === null
        ? null
        : opts.takenAt !== undefined
          ? utcInstant(
              resolveQueuedTakenAt(
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
                capturedAt
              ) ?? capturedAt
            )
          : utcInstant(capturedAt);
    if (!existing) {
      db.prepare(
        `INSERT INTO intake_item_logs
           (dose_id, item_id, date, amount, status, recorded_at, occurred_at,
            notify_message_id, logged_via, bundle_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        doseId,
        owned.item_id,
        date,
        amount,
        target,
        utcInstant(capturedAt),
        occurredAt,
        opts.notifyMessageId ?? null,
        loggedVia,
        opts.bundleId ?? null
      );
    } else {
      // THE IMMUTABLE RECORD STAMP STAYS PUT: `recorded_at` is not in this SET list and
      // must not join it — a flip is an edit of an existing row, not a new tap, and a
      // moved capture stamp would date the skip's act to the correction.
      db.prepare(
        `UPDATE intake_item_logs
            SET status = ?, amount = ?, supply_adjusted = ?, occurred_at = ?
          WHERE dose_id = ? AND date = ?`
      ).run(
        target,
        amount,
        target === "taken" ? 1 : 0,
        occurredAt,
        doseId,
        date
      );
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
// by the dashboard atom, the Upcoming inline confirm, Telegram inline actions, the
// household cockpit and the offline replay. Never deletes, never overwrites a deliberate
// skip. Returns what actually happened so the caller can answer honestly: a tap on a
// button whose dose was since deleted/retired by an edit, or whose item was paused, logs
// NOTHING and must not be acknowledged as "Logged".
export function markDoseTaken(
  profileId: number,
  doseId: number,
  itemId: number | null,
  date: string,
  // Which surface this tap came from (#3087). Required and positional, BEFORE the
  // named tail, so omitting it is a compile error rather than an undefined that
  // reads as "unknown surface".
  loggedVia: LoggedVia,
  // WHAT ELSE THIS CONFIRM STATES (#4742) — every field documented once, on
  // `DoseResolveOptions`. These were three optional trailing positionals, and the only
  // thing standing between a swap of the last two and a misfiled row was the BRANDED
  // bundle type: a type doing a signature's job. A named field cannot land in the
  // wrong slot, and the next addition is a field rather than a fourth position.
  opts: DoseConfirmOptions = {}
): DoseTakenOutcome {
  return resolvedOutcome(
    applyDoseStatusCore(profileId, doseId, date, "taken", loggedVia, {
      ...opts,
      // The intent and the id are this function's, not the caller's — which is why
      // they are the two fields `DoseConfirmOptions` takes away.
      resolveOnly: true,
      itemId,
    })
  );
}
// #4614: each core declares its own domain; `LOG_MANIFEST`'s cores column derives.
export const markDoseTakenDeclares = DOSE_RESOLUTION;

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
  itemId: number | null,
  date: string,
  loggedVia: LoggedVia
): DoseTakenOutcome {
  return resolvedOutcome(
    applyDoseStatusCore(profileId, doseId, date, "skipped", loggedVia, {
      resolveOnly: true,
      itemId,
    })
  );
}
export const markDoseSkippedDeclares = DOSE_RESOLUTION;

// Set one dose to an explicit target status for `date` — the web tri-state check-off's
// write (#232), auth-blind and profileId-first like every other lib write core. The
// Server Action (setDoseStatus) is the authorization + validation boundary over it and
// renders the outcome; it owns no SQL of its own.
//
// IT CAN CARRY A BUNDLE (#4745), and until now it was the one resolution core that
// could not. Nothing composed reaches it today — every composed writer goes through
// `markDoseTaken` — so this fixed no defect; what it removes is the door a future
// composed writer would have walked through to produce rows with a NULL `bundle_id`,
// indistinguishable from a pre-migration row and from a genuine one-at-a-time tap, and
// wrong in the one way nothing errors on. Making that unreachable BY TYPE was the
// preferred shape and TypeScript cannot express it — a call site's composedness is not
// a thing the checker can see — so the answer is the other end of the same rule: there
// is no longer a core that cannot carry one, so there is nothing to reach.
export function setDoseStatusCore(
  profileId: number,
  doseId: number,
  date: string,
  target: DoseStatusTarget,
  loggedVia: LoggedVia,
  // WHAT THIS TAP STATES, every field documented once on `DoseResolveOptions`. Named
  // rather than positional for #4742's reason and in the same shape: a fourth trailing
  // optional on this core is exactly how the drift on its sibling started.
  //
  // `resolveOnly` is the one a web caller must think about: the tri-state's licence to
  // overwrite comes from the person LOOKING at the state, so it does not extend to a
  // clear the surface only believed in — a list of what a day owes renders every stale
  // row clear, and a ✅ there would flip a skip made elsewhere. A flip or a clear off a
  // state the person could see is unaffected.
  opts: DoseSetOptions = {}
): DoseStatusOutcome {
  return applyDoseStatusCore(profileId, doseId, date, target, loggedVia, opts);
}
export const setDoseStatusCoreDeclares = DOSE_RESOLUTION;

// Take BACK the dose confirm a tap just made (#2642) — the inverse behind the act→undo
// toast, auth-blind and profileId-first like every other core here.
//
// WHY THIS IS NOT JUST `setDoseStatusCore(…, "clear")`. The tri-state check-off states an
// intent about the DAY ("this dose is clear now") and is right to overwrite whatever
// stands. An undo makes a much smaller claim — "the row I wrote a moment ago should not
// exist" — and the only honest way to keep that claim is to RE-DERIVE it: the tap is
// undoable while, and only while, the day's ledger is still exactly the one taken row the
// confirm produced. Flipped to skipped meanwhile? A PRN administration landed on the same
// (dose, date) since? Then clearing would destroy a fact this tap did not create — the
// core's DELETE is by (dose_id, date), not by row id, so it would take both. It refuses
// instead, exactly as `logUsualFoodCore` refuses a stale tap rather than logging a second
// breakfast.
//
// The probe runs inside the SAME writeTx as the clear (`readAllForUpdate` demands the
// token only `writeTx` mints, so a check made outside the transaction cannot typecheck),
// and the clear itself goes through `applyDoseStatusCore` — the ONE writer of
// intake_item_logs, which re-verifies ownership and liveness and hands back the supply
// the taken row consumed. The nested transaction is a SAVEPOINT under the outer IMMEDIATE
// lock, so probe-then-clear is atomic against the notify sidecar and a second web replica.
export function undoDoseConfirm(
  profileId: number,
  doseId: number,
  date: string,
  // The surface taking the confirm back. The clear DELETES the row, so nothing is
  // stamped — the argument is required anyway because the shared core requires it,
  // and a surface that cannot name itself has no business writing this ledger.
  loggedVia: LoggedVia
): DoseUndoOutcome {
  return writeTx((tx): DoseUndoOutcome => {
    // Profile-scoped through the parent item (the child-table rule), and that join IS the
    // ownership check: a forged dose id belonging to another profile reads zero rows and
    // is answered without ever reaching the writer.
    const standing = readAllForUpdate<{ status: DoseStatus }>(
      tx,
      db.prepare(
        `SELECT l.status AS status
           FROM intake_item_logs l
           JOIN intake_item_doses d ON d.id = l.dose_id
           JOIN intake_items s ON s.id = d.item_id
          WHERE l.dose_id = ? AND l.date = ? AND s.profile_id = ?`
      ),
      doseId,
      date,
      profileId
    );
    if (standing.length === 0) return "not-taken";
    if (standing.length > 1) return "changed";
    if (standing[0].status !== "taken") return "changed";
    const outcome = applyDoseStatusCore(
      profileId,
      doseId,
      date,
      "clear",
      loggedVia
    );
    // `cleared` is the only success available once a single taken row is proven to stand;
    // anything else is the shared core's own refusal (dose retired, item paused between
    // the probe and the write's re-check) and is passed through rather than dressed up as
    // a successful undo.
    return outcome === "cleared" ? "undone" : "stale-dose";
  });
}
export const undoDoseConfirmDeclares = DOSE_CONFIRM_UNDO;

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

// THE EVIDENCE AN ADHERENCE STRIP IS JUDGED OVER, which is not the same set as the
// rows it DRAWS (#3988).
//
// `intakeAdherenceStrip` asks its `takenByDose` index two different questions. "Was
// this dose taken on this drawn day" is bounded by the window, correctly. "When did
// this dose first exist" is NOT bounded by anything — `doseWindowSince` widens the
// lifetime clamp backwards by the dose's own logged history, and a window cannot
// answer an unbounded question. Given only the 14 days it draws, a dose whose sole
// proof of existence was a 60-day-old backfilled log scored `na` on days it
// demonstrably existed — and `na` is not a quieter `missed`: it asserts NOTHING WAS
// OWED and drops the day out of adherence entirely, setting a silent ceiling on every
// surface that reuses these verdicts.
//
// So the BOUND gets its own evidence rather than the window being widened. Widening is
// both dearer and still wrong — drawing 14 dots would pay for 60 days of rows, and a
// proof five years old escapes any finite window anyway.
//
// ONE STATEMENT, NOT TWO, and that is the reason for the UNION rather than two calls
// the caller concatenates: five surfaces read this and two of them render on the
// dashboard, whose per-render statement budget is measured
// (lib/__db_tests__/dashboard-placement-manifest.test.ts). The second arm is bounded
// by the dose count, reduces each dose's older history to its MINIMUM — which carries
// the same answer as the whole of it — and reads down idx_intake_log_dose_date rather
// than fanning out per dose. SQLite gives the bare `status` column the value from the
// row `MIN(l.date)` picked, so every row here is a real log row. Rows are never
// duplicated between the arms (the date predicates partition), and a duplicate would
// cost nothing anyway: `indexTakenByDose` collects dates into sets.
//
// The same bound is read one more place, from its own query: `pendingDayDoses`
// (lib/queries/usual-routine.ts) takes the earliest log per dose directly, because it
// wants the lifetime half and draws no window at all.
export function getIntakeAdherenceEvidence(
  profileId: number,
  days = 14
): { dose_id: number; date: string; status: DoseStatus }[] {
  const since = shiftDateStr(today(profileId), -(days - 1));
  return db
    .prepare(
      `SELECT l.dose_id, l.date, l.status FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date >= ?
       UNION ALL
       SELECT l.dose_id, MIN(l.date) AS date, l.status FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date < ?
        GROUP BY l.dose_id`
    )
    .all(profileId, since, profileId, since) as {
    dose_id: number;
    date: string;
    status: DoseStatus;
  }[];
}
