// Server-side write cores for the offline-queueable quick-log flows (issue #28).
// These are the SINGLE implementation of each write: both the online Server Actions
// (app/(app)/trends/measurement-actions.ts + body-actions.ts, nutrition/intake-actions.ts,
// nutrition/actions.ts, training/activity-actions.ts — the latter two through their
// shared lib cores) and the offline replay route (app/api/offline-replay) call them,
// so a replayed write runs byte-for-byte the same validation + persistence the live
// form does — there is no second, drift-prone copy of the rules. Callers own their own
// requireWriteAccess()/session gate and revalidatePath(); these functions take a
// resolved profileId and just do the profile-scoped write.
//
// Every statement here filters by profile_id (child tables reach it via their
// parent), per the repo scoping rule.

import { db, today, writeTx } from "@/lib/db";
import {
  BODY_READING_WRITE,
  MOOD_CHECKIN,
  STOOL_MOVEMENT_LOG,
  isPastWriteAccepted,
  isWithinTapReach,
} from "@/lib/log-manifest";
import { OFFLINE_REPLAY, type LoggedVia } from "../logged-via";
import { now as clockNow, sqlNow } from "@/lib/clock";
import {
  isRealIsoDate,
  shiftDateStr,
  utcInstant,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "@/lib/date";
import { isDoseDateAccepted } from "@/lib/dose-log-window";
import { inMetricBounds } from "@/lib/ingest-bounds";
import { toKg } from "@/lib/units";
import type { WeightUnit } from "@/lib/settings";
import {
  normalizeClockTime,
  normalizeVitalsInput,
  SLEEP_METRIC,
  VITAL_CANONICAL,
  type SleepWindowRefusal,
  type StatedSleepWindow,
  type VitalsRawInput,
} from "@/lib/vitals-input";
import {
  judgeStatedAt,
  statedInstantOnDate,
  type StatedTimeRefusal,
} from "@/lib/stated-time";
import { normalizeGrowthInput, type GrowthInputRaw } from "@/lib/growth-input";
import { normalizeWaistInput, type WaistInputRaw } from "@/lib/waist-input";
import {
  HYDRATION_METRIC,
  normalizeCompositionInput,
  type CompositionInputRaw,
} from "@/lib/composition-input";
import { WAIST_CIRC_METRIC } from "@/lib/waist-circ-extract";
import { BRISTOL_STOOL_METRIC, parseBristolType } from "@/lib/bristol-stool";
import { markDoseSkipped, markDoseTaken } from "@/lib/queries";
import { captureDelete } from "@/lib/undo-delete-db";
import { REPLAYED_KEYS_RETENTION_DAYS, daysAgoModifier } from "@/lib/retention";
import {
  MOOD_MAX,
  MOOD_MIN,
  normalizeMoodInput,
  type MoodRatingColumn,
} from "@/lib/mood";
import { getTimezone, resetMoodCheckinIgnored } from "@/lib/settings";
import { isFoodSlot, type FoodSlot } from "@/lib/food-slot";
import { logFoodServingCore } from "@/lib/food-log-write";
import { judgeEatenAt } from "@/lib/food-eating-time";
import { addProteinGramsCore } from "@/lib/protein-daily-totals-write";
import { saveActivityCore } from "@/lib/activity-write";
import { logMobilityMoveCore } from "@/lib/mobility-log-write";
import { logPracticeSessionForDay } from "@/lib/practice-log";
import { recordReading, resolveStatedOccurredAt } from "@/lib/reading-writes";
import {
  classifyDoseReplay,
  classifySetReplay,
  resolveCapturedInstant,
  STALE_QUEUED_DOSE_REASON,
  type FlowKind,
  type QueuedIntent,
  type DosePayload,
  type BodyMetricPayload,
  type VitalsPayload,
  type MoodPayload,
  type SetPayload,
  type FoodPayload,
  type MobilityPayload,
  type PracticePayload,
  type StoolPayload,
} from "@/lib/offline/queue";

// ── dose confirm / skip ───────────────────────────────────────────────────────

// Apply a queued dose confirm or skip through the SHARED write core (#1427).
//
// There is NO offline-specific dose write. markDoseTaken / markDoseSkipped are the
// one implementation every confirm path goes through — the page tri-state's sibling,
// the dashboard atom, the household cockpit, the Telegram ✅/⏭️ taps — and a replayed
// tap is just a late tap, so it runs the identical rules: profile-scoped ownership
// from the dose row's own item_id, the retired-dose and PAUSED-ITEM refusals, the
// per-(dose,date) idempotency exists-check under BEGIN IMMEDIATE, the amount snapshot,
// and the single supply decrement. (This replaced a parallel pair of offline-only
// writers that had drifted: they never checked `active`, so a replay could silently
// log — and burn supply for — a medication the user had deliberately paused.)
//
// The core's typed DoseTakenOutcome is HONORED rather than collapsed to a boolean:
// classifyDoseReplay turns it into the queue's disposition + the reason the user sees,
// so a refusal reaches the dead-letter panel instead of being reported as synced.
// `clientTakenAt` (confirm only) is the captured tap moment; the core validates it.
function applyDoseIntent(
  profileId: number,
  flow: "dose" | "skip-dose",
  payload: DosePayload,
  date: string
): { status: "done" | "rejected"; reason?: string } {
  const doseId = payload?.doseId;
  if (!Number.isInteger(doseId) || doseId <= 0 || !isRealIsoDate(date)) {
    return { status: "rejected" };
  }
  const todayStr = today(profileId);
  // Distinguish "the entry sat in the queue too long" from "the dose is gone" for the
  // user-facing reason ONLY — the same pure predicate the core gates on, so the two
  // can't drift. The core still enforces it (it answers stale-dose either way).
  if (!isDoseDateAccepted(todayStr, date)) {
    return { status: "rejected", reason: STALE_QUEUED_DOSE_REASON };
  }
  const capturedTakenAt = payload.clientTakenAt
    ? new Date(payload.clientTakenAt)
    : null;
  const capturedOnRowDate =
    capturedTakenAt != null &&
    !Number.isNaN(capturedTakenAt.getTime()) &&
    zonedDateParts(getTimezone(profileId), capturedTakenAt).date === date;
  const outcome =
    flow === "dose"
      ? markDoseTaken(profileId, doseId, null, date, OFFLINE_REPLAY, {
          takenAt: capturedOnRowDate
            ? capturedTakenAt
            : date === todayStr
              ? (capturedTakenAt ?? undefined)
              : null,
        })
      : markDoseSkipped(profileId, doseId, null, date, OFFLINE_REPLAY);
  return classifyDoseReplay(flow, outcome);
}

// ── body-metric quick-add ───────────────────────────────────────────────────────

export interface BodyMetricWrite {
  date: string;
  weight: string | null; // raw, in `weightUnit`; nullable for body-fat/HR detail entry
  weightUnit: WeightUnit;
  bodyFatPct: string | null;
  restingHr: string | null;
  notes: string | null;
  // The sitting's stated instant (#2235): an ISO instant somebody STATED, `null`
  // for the form's explicitly-empty Time (clears a stated time on a resubmission),
  // `undefined` for a time-blind caller (Telegram, the palette, an old queued
  // intent — leaves any stored statement alone). Accepted / normalized by
  // `resolveStatedOccurredAt`; a mismatched or future statement costs the
  // statement, never the reading — and since #2311 never in silence either: the
  // refusal rides back out on the outcome below.
  occurredAt?: string | null;
  /**
   * WHICH SURFACE MADE THIS SUBMISSION (#3087) — required, no default. Stamped on the
   * INSERT arm only: the per-column UPDATEs below correct a day row that already
   * exists, and a correction is not a new weigh-in.
   */
  loggedVia: LoggedVia;
}

// What one manual body-metrics submission did (#2311). It used to be a bare
// `boolean`, which could say "the reading landed" and nothing else — so a phone
// whose clock ran past the five-minute tolerance kept its weigh-in and quietly
// lost the "when", with no caller able to say otherwise because no caller could
// see it. Same defect, same shape, same fix as #2296's for food.
//
// `statedTimeRefused` is a NOTICE, not a failure: `wrote` is still true, the row
// is still on its own day, and nothing is persisted to chase the user later. It is
// absent whenever nobody stated a time — the common case, and nothing to report.
// What a refusal COSTS stays the CALLER's (a log path keeps the reading; a
// correction path, where the statement is the whole submission, refuses) — every
// caller of this core is a log path.
export type BodyMetricWriteOutcome =
  { wrote: false } | { wrote: true; statedTimeRefused?: StatedTimeRefusal };

function numOrNull(v: string | null): number | null {
  if (v === null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Persist one manual body-metrics submission. At least ONE measurement is required,
// but weight is not: body_fat_pct and resting_hr are nullable columns and
// metric-detail entry can record either independently. A present weight is still
// validated and converted to canonical kg exactly as before.
//
// FIND-THEN-WRITE over the day's MANUAL row (#2235 decision 6) — the same shape,
// for the same reason, as lib/reading-writes.ts's body_metrics branch: the unique
// index (profile_id, date, source) treats two NULL sources as distinct, so a plain
// INSERT quietly grew a second manual row per day and `ON CONFLICT` could never
// dedupe the manual path at all. A resubmission of a day now CORRECTS that day's
// manual row — writing only the measures the submission carries, so "body fat and
// resting HR entered in one sitting" land on ONE row and a later resting-HR entry
// never blanks that morning's weight. Source-owned rows are invisible to this find
// (`source IS NULL`), so an importer's row is never touched — and one weigh-in per
// day stays the contract: this records WHEN the day's reading was taken, it does
// not enable a second one (multiple readings per day is the readings merge's to
// grant, via the store that keys on its instant).
//
// A resubmitted NOTE is last-write-wins only when the submission actually carries
// one: a metric-scoped form (which has no notes field) must not blank the morning
// weigh-in's note, so an empty/absent note leaves the stored one alone.
export function insertBodyMetric(
  profileId: number,
  w: BodyMetricWrite
): BodyMetricWriteOutcome {
  // A REJECTED submission never reaches the acceptance gate below, so it has no
  // refusal to report: nothing was written and nothing was judged. The weigh-in's own
  // writers do not go through `recordReading`, so this door was not silently dropping
  // anything — it takes the shared invariant so the BODY domain answers one way at
  // both of its doors, rather than a queued sitting dead-lettering while a queued
  // weigh-in on the same tomorrow lands.
  if (!isPastWriteAccepted(today(profileId), w.date)) return { wrote: false };
  const weightRaw = String(w.weight ?? "").trim();
  const weight = weightRaw === "" ? null : Number(weightRaw);
  if (weight != null && !Number.isFinite(weight)) return { wrote: false };
  const bodyFat = numOrNull(w.bodyFatPct);
  const restingHr = numOrNull(w.restingHr);
  if (weight == null && bodyFat == null && restingHr == null)
    return { wrote: false };
  const weightKg = weight == null ? null : toKg(weight, w.weightUnit);
  const notes = w.notes && w.notes.trim() ? w.notes.trim() : null;
  const { value: stated, refused } = resolveStatedOccurredAt(
    profileId,
    w.date,
    w.occurredAt
  );
  writeTx(() => {
    const found = db
      .prepare(
        `SELECT id FROM body_metrics
          WHERE profile_id = ? AND date = ? AND source IS NULL
          ORDER BY id LIMIT 1`
      )
      .get(profileId, w.date) as { id: number } | undefined;
    if (!found) {
      db.prepare(
        `INSERT INTO body_metrics (date, weight_kg, body_fat_pct, resting_hr, notes, occurred_at, profile_id, logged_via)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        w.date,
        weightKg,
        bodyFat,
        restingHr,
        notes,
        // Bound, never defaulted (#2205): the stated instant or honest NULL.
        stated ?? null,
        profileId,
        w.loggedVia
      );
      return;
    }
    // One literal statement per column (the profile-scoping scanner reads
    // profile_id out of LITERAL prepare() text), each run only when the
    // submission carries that measure.
    if (weightKg != null) {
      db.prepare(
        `UPDATE body_metrics SET weight_kg = ? WHERE id = ? AND profile_id = ?`
      ).run(weightKg, found.id, profileId);
    }
    if (bodyFat != null) {
      db.prepare(
        `UPDATE body_metrics SET body_fat_pct = ? WHERE id = ? AND profile_id = ?`
      ).run(bodyFat, found.id, profileId);
    }
    if (restingHr != null) {
      db.prepare(
        `UPDATE body_metrics SET resting_hr = ? WHERE id = ? AND profile_id = ?`
      ).run(restingHr, found.id, profileId);
    }
    if (notes != null) {
      db.prepare(
        `UPDATE body_metrics SET notes = ? WHERE id = ? AND profile_id = ?`
      ).run(notes, found.id, profileId);
    }
    // `undefined` = no statement, leave the stored one; `null` = explicit clear.
    if (stated !== undefined) {
      db.prepare(
        `UPDATE body_metrics SET occurred_at = ? WHERE id = ? AND profile_id = ?`
      ).run(stated, found.id, profileId);
    }
  });
  // The reading landed. If a statement was made and thrown away, the caller now
  // holds the reason — and every one of them renders it rather than dropping it.
  return { wrote: true, ...(refused ? { statedTimeRefused: refused } : {}) };
}
// #4614: each core declares its own domain; `LOG_MANIFEST`'s cores column derives.
export const insertBodyMetricDeclares = BODY_READING_WRITE;

// ── vitals quick-add ────────────────────────────────────────────────────────────

// Insert-or-update a manual metric sample. Most callers use the stable midnight
// point so a re-entry corrects; genuinely additive hydration supplies its tap instant
// so each contribution appends. `source` keeps integration rows separate.
// The day's midnight, the natural-key anchor a POINT measurement is filed at. It is
// a day attribution rather than an instant, which is why it is a template here and
// not a `utcInstant()` call.
function dayMidnightAnchor(date: string): string {
  return `${date}T00:00:00`;
}

function sampleTime(profileId: number, date: string, instant: Date): string {
  const { hhmm } = zonedDateParts(getTimezone(profileId), instant);
  const seconds = String(instant.getUTCSeconds()).padStart(2, "0");
  return `${date}T${hhmm}:${seconds}`;
}

function upsertManualSample(
  profileId: number,
  metric: string,
  date: string,
  value: number,
  window?: { startedAt: string; endedAt: string }
): void {
  const startedAt = window?.startedAt ?? dayMidnightAnchor(date);
  const endedAt = window?.endedAt ?? startedAt;
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
       VALUES (?, 'manual', ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       value = excluded.value, date = excluded.date,
       -- The natural key (migration 083) is (profile, metric, source, origin,
       -- started_at) — the END is NOT in it. Without this, re-stating a night with
       -- the same bedtime and a new wake clock updated the value in place and left
       -- the old end instant behind: a window whose length no longer matched the
       -- hours printed beside it. Point rows are unaffected (end equals start).
       ended_at = excluded.ended_at`
  ).run(profileId, metric, date, startedAt, endedAt, value);
}

// ONE manual sleep row per profile-day, whichever shape the sitting used (#1851).
//
// `metric_samples`' natural key is the START instant and `sleep_min` is ADDITIVE, so
// a duration-only night filed at midnight and a stated bed/wake window are two keys
// that would read one night as two. Every other manual row for the day therefore
// goes BEFORE the upsert, which then corrects in place — keeping the row id the
// Sleep log's per-reading delete addresses.
//
// A sitting that states NO window keeps whatever window the day's manual row
// already has: correcting the hours on the Sleep page — a form that knows only a
// duration — must not silently discard clocks typed on the measurements form.
// TWO cases break that retention, and each returns its reason rather than deciding
// in silence:
//
//   • the sitting DID state a pair and it could not be stored (`stated.refused`).
//     The fallback is a duration-only row, and it has to actually fall back: leaving
//     the day's old clocks in place answers a refused statement with someone else's
//     night, which is the one outcome nobody asked for.
//   • the retained window is SHORTER than the hours now being stored. Time asleep
//     can be less than time in bed and never more — `validateVitalsInput` refuses
//     exactly that inside one sitting — so a 12-hour correction landing on a
//     23:00→07:00 night means those clocks are no longer an account of it.
function upsertManualSleep(
  profileId: number,
  date: string,
  value: number,
  stated: {
    window: { startedAt: string; endedAt: string } | null;
    refused: boolean;
  }
): SleepWindowRefusal | null {
  return writeTx(() => {
    let notice: SleepWindowRefusal | null = null;
    let target = stated.window;
    if (target == null) {
      if (stated.refused) {
        notice = "unstorable";
      } else {
        const existing = db
          .prepare(
            `SELECT started_at AS startedAt, ended_at AS endedAt FROM metric_samples
              WHERE profile_id = ? AND metric = ? AND source = 'manual'
                AND origin IS NULL AND date = ?
                AND julianday(ended_at) > julianday(started_at)
              ORDER BY id LIMIT 1`
          )
          .get(profileId, SLEEP_METRIC, date) as
          { startedAt: string; endedAt: string } | undefined;
        if (existing) {
          const elapsed = Math.round(
            (Date.parse(existing.endedAt) - Date.parse(existing.startedAt)) /
              60000
          );
          if (Number.isFinite(elapsed) && value > elapsed) {
            notice = "shorter-than-stated-sleep";
          } else {
            target = existing;
          }
        }
      }
    }
    const startedAt = target?.startedAt ?? dayMidnightAnchor(date);
    const endedAt = target?.endedAt ?? startedAt;
    db.prepare(
      `DELETE FROM metric_samples
        WHERE profile_id = ? AND metric = ? AND source = 'manual'
          AND origin IS NULL AND date = ? AND started_at <> ?`
    ).run(profileId, SLEEP_METRIC, date, startedAt);
    upsertManualSample(profileId, SLEEP_METRIC, date, value, {
      startedAt,
      endedAt,
    });
    return notice;
  });
}

// The two absolute instants a stated bed/wake pair denotes in the profile's zone,
// or null when the zone cannot place them or the ELAPSED minutes between them fall
// outside `sleep_min`'s ingest envelope.
//
// THE STORED VALUE IS BOUNDED HERE, not by the validator's ceiling: that bounds the
// NOMINAL clock difference, this bounds the elapsed minutes the row actually
// carries, and a zone transition separates the two by however much the zone shifts.
// Antarctica/Troll shifts two hours, which let a validated 12:00→11:00 pair store
// 1500 against a 0–1440 envelope. Every other writer of this metric goes through
// the same `inMetricBounds`; this is that check on the one path that lacked it.
//
// WHICH ZONE INTERPRETS THE CLOCKS: the profile's zone AT WRITE TIME, which for a
// replayed intent is the zone at RECONNECT rather than the one the person was in
// when they typed. The intent carries clocks, not instants, deliberately — an
// offline device has no server to ask — so the rule follows from that: the stated
// wall clock is resolved by whatever zone the profile holds when the write lands.
// A sitting queued abroad and flushed at home moves with the profile. (lib/travel.ts
// makes zone changes routine, which is why this is written down; pinning a zone into
// the payload at capture is a payload change, not a silent one, and nobody has asked
// for it.) The bed clock sits on the previous calendar day whenever it is at or
// after noon — the anchoring lib/sleep-regularity.ts indexes by — and the wake clock
// is on the row's own wake day, which is how every sleep session here is dated.
// EXPORTED for the sleep re-time (#5021), which asks this module's question and must
// not answer it a second way: a person states two wall clocks against a wake day, and
// the pair becomes one UTC window. That lane hands it the zone in force at the night's
// own stored WAKE, not the current one (#5125) — it is correcting a window it has just
// printed through that historical zone, and a display and its interpretation have to be
// inverses or a one-hour nudge is not a one-hour move. The CURRENT-zone rule above is
// unchanged, and stays the rule for every caller that writes a window nobody read back
// first; `sleepRetimeZone` in lib/sleep-retime-db.ts carries the distinction.
export function resolveSleepWindow(
  tz: string,
  date: string,
  window: StatedSleepWindow
): { startedAt: string; endedAt: string; minutes: number } | null {
  const bedAt = zonedWallTimeToUtc(
    tz,
    window.bedOnPreviousDay ? shiftDateStr(date, -1) : date,
    window.bed
  );
  const wakeAt = zonedWallTimeToUtc(tz, date, window.wake);
  if (!bedAt || !wakeAt) return null;
  const minutes = Math.round((wakeAt.getTime() - bedAt.getTime()) / 60000);
  if (minutes <= 0 || !inMetricBounds(SLEEP_METRIC, minutes)) return null;
  return { startedAt: utcInstant(bedAt), endedAt: utcInstant(wakeAt), minutes };
}

// Persist a manual vitals entry. Runs the SAME pure normalizeVitalsInput guard the
// online action and client form use, so a crafted/replayed request can never store a
// partial/out-of-range set. Returns false on a rejected/empty input, true on a
// successful write.
//
// The observation half no longer names a table (#2032): each normalized vital is offered
// to `recordReading` by its CANONICAL NAME, and the placement policy decides where it
// lands. For every vital in the vitals vocabulary that decision is `medical_records`
// (none of them has a registered stream), so the rows are byte-for-byte the ones this
// function wrote before — pinned in lib/__db_tests__/reading-writes.test.ts. What
// changes is that the destination is now a POLICY rather than a constant here: the day a
// manual vital gains a stream source, this path follows it instead of quietly splitting
// the quantity across two stores.
//
// Sleep and HRV stay on the sample writer: neither has a canonical reading identity, so
// the policy refuses them by design rather than inventing a placement (the #482
// exclusion discipline, applied to the write side).
//
// PEAK FLOW (#1850) is the first vital whose placement is a STREAM, and it rides the
// same `recordReading` call the observation half does — which is the point: the caller
// names "Peak Expiratory Flow" and the policy routes it to `metric_samples`, exactly as
// it routes a blood pressure to `medical_records`. Its "HH:MM" becomes the row's
// `started_at`, so a second blow the same day is a second reading rather than a
// correction of the first (the natural key includes the instant).
//
// THE SITTING'S STATED TIME (#2154). `occurredAt` is the one WhenControl statement
// the measurements form posts for the whole sitting, on the exact contract the
// body-metrics core declares: `undefined` = no statement, `null` = explicitly no
// time, a string = the stated instant. Every observation this submission writes
// (BP, glucose, SpO₂, temperature) carries it into `medical_records.occurred_at`
// through `recordReading`'s acceptance gate — a refused statement (future, or off
// the row's day) costs the statement, never the reading — and the peak-flow blow
// derives its profile-local `started_at` from the SAME accepted instant, so one
// sitting states one "when" everywhere it lands.
//
// LEGACY per-measure times: an intent queued before the fold carries
// `temperatureTime` / `peakFlowTime` ("HH:MM") instead. Those are the user's own
// wall clock on the profile's own day, so — unlike a zoneless clinical clock —
// resolving them against the profile's timezone is exactly what the WhenControl
// itself would have done (`statedInstantOnDate`); the temperature time lands on
// the temperature row only, as it always did, and never writes a note again.
// What one vitals sitting did (#2363) — the twin of `BodyMetricWriteOutcome`, and
// for the same reason. This answered a bare `boolean`, so a sitting that stated a
// time the gate refused had nowhere to put the verdict: the readings landed,
// `occurred_at` went NULL, and the toast said "Measurements saved" with nothing
// about the minute it discarded. A sitting that also wrote a weight DID report,
// because the body half already carried the notice — that asymmetry was the bug.
//
// `statedTimeRefused` is a NOTICE, never a failure: `wrote` is still true, the rows
// are still on their own day, and nothing is persisted to chase the user later.
// Absent whenever nobody stated a time.
//
// `sleepWindowRefused` is the same shape for the same reason (#1851). A stated
// bed/wake pair that cannot be stored, or clocks a later duration contradicts, used
// to be dropped with the toast still saying "Measurements saved" — the identical
// silence, one field over.
export type VitalsWriteOutcome =
  | { wrote: false }
  | {
      wrote: true;
      statedTimeRefused?: StatedTimeRefusal;
      sleepWindowRefused?: SleepWindowRefusal;
    };

export function insertVitals(
  profileId: number,
  date: string,
  raw: VitalsRawInput,
  // WHICH SURFACE TOOK THESE READINGS (#3087). Required and positional, ahead of the
  // optional `occurredAt`, for the reason every write core in this tranche takes one:
  // a default would let a new call site land in the wrong bucket in silence. This
  // module lives under lib/offline/, but two of its three callers are ONLINE Server
  // Actions — the Sleep form and the Trends measurements form — and only the replay
  // at the bottom of this file is a replay. Spelling `offline-replay` here once
  // stamped every online blood-pressure, glucose, SpO2 and temperature entry as a
  // queued write replayed after reconnect.
  loggedVia: LoggedVia,
  occurredAt?: string | null
): VitalsWriteOutcome {
  // A REJECTED submission never reaches the acceptance gate below, so it has no
  // refusal to report: nothing was written and nothing was judged.
  //
  // THE DAY IS JUDGED HERE, AT THE DOOR, and that placement is the fix for a silent
  // loss #4425 introduced. `recordReading` gained the shared not-future invariant, and
  // the two loops below IGNORE its outcome — under the old gate its only refusal was a
  // blank date, a programming error, so ignoring it cost nothing. The moment the
  // refusal set included a REACHABLE case, this function reported `wrote: true` while
  // writing no rows at all.
  //
  // And the case is reachable, though NOT by the route this comment used to name
  // (#4559). It claimed the queue stamps a browser-zone day; the sitting's day comes
  // from the measurements form, whose `defaultDate` is the server's own, so a day
  // ahead of the profile's is one the person TYPED — and nothing upstream stops it,
  // because `maxDate` is optional there and neither mount of that form passes one.
  // The online action already answers that with `dateRefused`; asking here gives the
  // offline half of the same refusal the channel it needs — the replay dead-letters
  // with a reason — instead of two loops each learning to handle an outcome.
  if (!isPastWriteAccepted(today(profileId), date)) return { wrote: false };
  const normalized = normalizeVitalsInput(raw);
  if ("error" in normalized) return { wrote: false };
  const { medical, samples, readings } = normalized;
  if (medical.length === 0 && samples.length === 0 && readings.length === 0) {
    return { wrote: false };
  }

  const tz = getTimezone(profileId);
  // The sitting statement, resolved ONCE through the shared boundary so the
  // peak-flow derivation below can only ever use an instant the gate accepted.
  //
  // The verdict is the SITTING'S (#2363), which is why it is taken here rather than
  // collected from the per-reading outcomes: one statement went through one gate, so
  // every row `recordReading` writes for this submission carries the identical
  // verdict on its own outcome, and reading it once cannot disagree with itself.
  const { value: stated, refused } = resolveStatedOccurredAt(
    profileId,
    date,
    occurredAt
  );
  // A pre-fold temperature "HH:MM" (a queued intent, or a stale pre-fold tab whose
  // sitting Time was left empty), as an instant on the row's own day — only
  // consulted when the submission carries no sitting INSTANT, because in the
  // pre-fold form an empty sitting Time said nothing about the temperature's own
  // time field. A new client never posts the field, so this path never fires.
  const legacyTempAt =
    occurredAt == null
      ? (() => {
          const hhmm = normalizeClockTime(raw.temperatureTime);
          const inst = hhmm ? statedInstantOnDate(date, hhmm, tz) : null;
          return inst ? utcInstant(inst) : undefined;
        })()
      : undefined;

  // WHY THE NEXT TWO LOOPS MAY DISCARD `recordReading`'S OUTCOME, stated here because
  // it is a claim about THIS call site rather than about the core (#4425 review).
  // `recordReading` refuses three ways, and none can produce a PARTIAL sitting:
  //   • the date invariant — a pure function of (profileId, date), and the whole
  //     sitting shares one date, already asked at this function's door above. Uniform
  //     by construction: it cannot answer differently for row three than for row one.
  //   • `edit-locked` — the #133 lock fires only for a SOURCE-OWNED row, and `source`
  //     is 'manual' below, so `sourceOwned` is false and that branch is unreachable.
  //   • `unplaceable` — `placeReading` refuses only a name with no reading identity,
  //     and these are the `VITAL_CANONICAL` vocabulary.
  // A tally here would be code defending against a state the shape already forbids. If
  // any of those three premises stops holding, this is the comment that has to change.
  for (const m of medical) {
    // `source` is 'manual' and `external_id` stays NULL, so a same-window Health
    // Connect push never matches it. The core registers the canonical name and
    // re-derives the reference-range flag, exactly as this function used to do in
    // a batch — and binds the sitting's stated instant onto the row's occurred_at
    // (#2154; the legacy temperature time reaches only its own row).
    recordReading(profileId, {
      name: m.canonical,
      value: m.value_num,
      unit: m.unit,
      date,
      source: "manual",
      loggedVia,
      category: m.category,
      occurredAt:
        m.canonical === VITAL_CANONICAL.temperature.canonical &&
        legacyTempAt !== undefined
          ? legacyTempAt
          : occurredAt,
    });
  }
  let sleepWindowRefused: SleepWindowRefusal | null = null;
  for (const s of samples) {
    if (s.metric !== SLEEP_METRIC) {
      upsertManualSample(profileId, s.metric, date, s.value);
      continue;
    }
    // The night, as ONE row (#1851). A stated bed/wake pair becomes the session
    // WINDOW the Sleep Regularity Index reads — the thing a duration-only row can
    // never give it — resolved against the profile's own zone, so the clock minutes
    // SRI compares are the ones the person's clock showed.
    const resolved = s.window ? resolveSleepWindow(tz, date, s.window) : null;
    sleepWindowRefused = upsertManualSleep(
      profileId,
      date,
      // Hours ASLEEP when the sitting stated them (a window includes time awake in
      // bed); otherwise the window's own ELAPSED minutes, which carry the real UTC
      // offsets and so are the length a zone-transition night actually had.
      resolved && !s.window?.durationStated ? resolved.minutes : s.value,
      { window: resolved, refused: s.window != null && resolved == null }
    );
  }
  for (const r of readings) {
    // The blow's clock time: the sitting's accepted statement, rendered on the
    // profile's own wall clock (the metric_samples convention); a pre-fold intent's
    // `at` is already that wall clock. Absent both, the core files the reading at
    // the day's midnight so a re-entry with no time CORRECTS the day instead of
    // stacking a duplicate.
    const at = stated ? zonedDateParts(tz, new Date(stated)).hhmm : r.at;
    recordReading(profileId, {
      name: r.canonical,
      value: r.value,
      unit: r.unit,
      date,
      source: "manual",
      loggedVia,
      measuredAt: at ? `${date}T${at}:00` : null,
    });
  }
  // The readings landed. If the sitting stated a time and the gate threw it away,
  // the caller now holds the reason instead of the resolver's shape erasing it.
  return {
    wrote: true,
    ...(refused ? { statedTimeRefused: refused } : {}),
    ...(sleepWindowRefused ? { sleepWindowRefused } : {}),
  };
}
export const insertVitalsDeclares = BODY_READING_WRITE;

// ── growth (height / head circumference) ───────────────────────────────────────

// Persist a manual height / head-circumference measurement. Moved here from the
// retired `app/(app)/trends/growth-actions.ts` when the standalone growth form
// folded into the combined "Log measurements" form (#1486): the growth fields are
// now life-stage-gated rows of ONE form served by ONE action, so its write core
// belongs beside the other two quick-log cores rather than in a per-form action
// module. Auth-blind + profileId-first, like its neighbours.
//
// Height and head circumference have a single home in metric_samples (metrics
// 'height_cm' / 'head_circumference_cm') — the SAME place the document-extraction
// writers land them — so a manually entered value feeds the WHO/CDC growth charts
// and the height/head-circ Body charts identically to an imported reading. A point
// metric uses a fixed midnight start, so the natural key (profile_id, metric,
// source='manual', origin=NULL, started_at) is stable across re-entries: logging
// the same date again CORRECTS that day rather than stacking a second point.
// Returns false on a rejected/empty input, true on a successful write.
export function insertGrowth(
  profileId: number,
  date: string,
  raw: GrowthInputRaw
): boolean {
  // The shared date invariant (#4425), and the SITTING is why it matters here rather
  // than only on the two cores the review named. One "Log measurements" submission fans
  // out across five cores; the moment two of them answered different questions about
  // the day, a future-dated sitting wrote its tape reading and dropped its weigh-in,
  // with the form saying "Measurements saved" either way. All five ask the same
  // question, so the sitting is all-or-nothing. `insertWaistCirc` and
  // `insertComposition` below take it for the same reason.
  if (!isPastWriteAccepted(today(profileId), date)) return false;
  const normalized = normalizeGrowthInput(raw);
  if ("error" in normalized) return false;
  if (normalized.samples.length === 0) return false;
  writeTx(() => {
    for (const s of normalized.samples) {
      upsertManualSample(profileId, s.metric, date, s.value);
    }
  });
  return true;
}
export const insertGrowthDeclares = BODY_READING_WRITE;

// ── waist circumference (issue #2322) ─────────────────────────────────────────

// Persist a manual waist-circumference measurement. The SIBLING of insertGrowth
// rather than a member of it: "growth" is the life-stage-gated pair the WHO/CDC
// percentile card reads, and a waist measurement is neither gated nor plotted against
// a growth curve — what the two share is the STORE and the discipline.
//
// Waist circumference has a single home in metric_samples (metric
// 'waist_circumference_cm') — the SAME place the document-extraction writer lands it
// (lib/waist-circ-extract.ts) — so a tape reading typed at home feeds the
// `waist-circ` chart identically to an imported one. A point metric uses a fixed
// midnight start, so the natural key (profile_id, metric, source='manual',
// origin=NULL, started_at) is stable across re-entries: logging the same date again
// CORRECTS that day rather than stacking a second point. Auth-blind + profileId-first
// like its neighbours. Returns false on a rejected/empty input, true on a write.
export function insertWaistCirc(
  profileId: number,
  date: string,
  raw: WaistInputRaw
): boolean {
  if (!isPastWriteAccepted(today(profileId), date)) return false;
  const normalized = normalizeWaistInput(raw);
  if ("error" in normalized) return false;
  writeTx(() => {
    upsertManualSample(profileId, WAIST_CIRC_METRIC, date, normalized.valueCm);
  });
  return true;
}
export const insertWaistCircDeclares = BODY_READING_WRITE;

// ── lean mass / bone mass / hydration (issue #1851) ───────────────────────────

// Persist the manual body samples the census charted but the form could not take.
// The SIBLING of insertGrowth and insertWaistCirc — same store, same discipline,
// same fixed-midnight point key, so re-logging a date CORRECTS it rather than
// stacking a second reading — and deliberately not a member of either: these three
// are neither life-stage-gated nor a tape measurement.
//
// The metric keys are the ones Withings and Health Connect already write
// ('lean_mass_kg' / 'bone_mass_kg' / 'hydration_l'), so a DEXA figure typed at home
// is the same row a synced one is: `lib/protein.ts` reads the latest lean mass
// whatever wrote it, and the hydration chart plots both together. Auth-blind +
// profileId-first like its neighbours. Returns false on a rejected/empty input.
export function insertComposition(
  profileId: number,
  date: string,
  raw: CompositionInputRaw
): boolean {
  if (!isPastWriteAccepted(today(profileId), date)) return false;
  const normalized = normalizeCompositionInput(raw);
  if ("error" in normalized) return false;
  writeTx(() => {
    for (const s of normalized.samples) {
      const ts =
        s.metric === HYDRATION_METRIC
          ? sampleTime(profileId, date, clockNow())
          : null;
      upsertManualSample(
        profileId,
        s.metric,
        date,
        s.value,
        ts ? { startedAt: ts, endedAt: ts } : undefined
      );
    }
  });
  return true;
}
export const insertCompositionDeclares = BODY_READING_WRITE;

// ── Bristol stool form (issue #2785) ──────────────────────────────────────────

// Persist one Bristol stool-form observation. The SIBLING of insertWaistCirc in
// store and discipline, and its deliberate opposite in GRAIN.
//
// `upsertManualSample` above files a point measure at the day's midnight, so a
// re-entry CORRECTS that day — right for a tape reading, wrong here. Several bowel
// movements a day is ordinary and each is its own observation, so a Bristol row is
// keyed on the INSTANT it was tapped: the natural key is
// (profile_id, metric, source, origin, start_time), so 08:12 and 19:40 are two rows
// and a double-tap inside the same minute settles on one. That is the peak-flow
// answer (a morning and an evening blow are two blows) applied to the store directly,
// because Bristol has no canonical identity and therefore no placement — the #482
// exclusion discipline, the same reason sleep and HRV stay on the sample writer.
//
// NOT `recordReading`: placement clause 1 would refuse it, correctly. And no edit-lock
// consult — that lock (#133) holds out a SOURCE-owned re-push, and nothing streams
// Bristol; every row here is the user's own tap.
//
// Auth-blind + profileId-first like its neighbours. Answers in the house shape the
// body-metric writers above use: `wrote: false` on a rejected input (bad date, or a
// value the scale does not name), and on a written row the REFUSAL of a stated time
// the gate would not take — a notice, never a failure (#4425).
export function logBristolStool(
  profileId: number,
  date: string,
  type: unknown,
  // The observation's profile-local wall clock, "HH:MM". Omitted → read from the
  // clock seam, which is what a one-tap log does: the moment IS now.
  at?: string | null,
  instant: Date = clockNow()
): { wrote: false } | { wrote: true; statedTimeRefused?: StatedTimeRefusal } {
  // The shared date invariant (#4425): any real past day, never the future. The tap
  // itself states no day — `logStoolForm` stamps today — so `TAP_REACH` files
  // `stool-form` as `today`; the core is open for the dated surfaces #4433 will add.
  if (!isPastWriteAccepted(today(profileId), date)) return { wrote: false };
  const bristolType = parseBristolType(type);
  if (bristolType === null) return { wrote: false };
  // SECOND precision, not minute, and the resolution is load-bearing.
  //
  // The key is the instant, so two readings are two rows exactly when they fall on
  // different seconds. That lines up with the affordance's declared repeat class
  // rather than fighting it: `stool-form` is `additive`, and the accidental
  // double-tap is absorbed by the one-tap ledger's POST_SUCCESS_COOLDOWN_MS window.
  // The cooldown is two seconds and the key's resolution is one, so a tap the ledger
  // would absorb and a tap this key would collapse are the SAME tap — a deliberate
  // second movement always lands on a later second and is always its own row. At
  // minute resolution the two mechanisms would not line up, and a genuine second
  // reading forty seconds after the first would be lost with the surviving row
  // looking perfectly normal.
  //
  // A caller that STATES a wall time gives HH:MM and lands on :00, so restating the
  // same time corrects that reading — which is what a stated time means. Only the
  // clock path carries seconds, and it reads them off the instant in UTC: every IANA
  // zone in the modern era is a whole-minute offset, so the seconds are the same
  // number on any wall clock.
  // JUDGED, NOT SHAPE-CHECKED (#4425). This ran `normalizeClockTime` alone — a shape
  // check — so "Happened earlier?" took 23:50 typed at 09:00 and filed a bowel movement
  // fourteen hours in the future, on a row whose natural key IS that instant. It now
  // runs the one acceptance gate every other stated instant runs (`judgeStatedAt`,
  // #2236), against the clock seam, and reports what it would not take.
  //
  // The refusal COSTS the statement, never the observation — the body-metric contract:
  // losing the stated minute is cosmetic, losing the log is not — so a refused time
  // falls back to the clock exactly as an unstated one does. `other-day` cannot fire
  // here because the instant is BUILT from `date`; a wall time that does not exist on
  // that day (a DST gap) is `malformed`, which is the honest word for a time the
  // calendar has no room for.
  const tz = getTimezone(profileId);
  const shaped = normalizeClockTime(at ?? null);
  const verdict = shaped
    ? judgeStatedAt(statedInstantOnDate(date, shaped, tz), tz, date, clockNow())
    : ({ kind: "unstated" } as const);
  const stated = verdict.kind === "accepted" ? shaped : null;
  const refused = verdict.kind === "refused" ? verdict.reason : undefined;
  const ts = stated
    ? `${date}T${stated}:00`
    : sampleTime(profileId, date, instant);
  writeTx(() => {
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
         VALUES (?, 'manual', ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET
         value = excluded.value, date = excluded.date`
    ).run(profileId, BRISTOL_STOOL_METRIC, date, ts, ts, bristolType);
  });
  return { wrote: true, ...(refused ? { statedTimeRefused: refused } : {}) };
}
export const logBristolStoolDeclares = STOOL_MOVEMENT_LOG;

// ── mood check-in (issue #992) ──────────────────────────────────────────────────

// WHAT A CHECK-IN'S AUTHOR COULD SEE (#3416), and why one write core has two upserts.
//
// A check-in replaces the day's row, and that is right for every form that composes
// one WITH THE DAY'S CURRENT ANSWER ALREADY IN IT: the dashboard card, the history
// editor and the quick sheet all pre-fill from the stored row, so a null they send is
// a field the person looked at and left empty. Last-write-wins is safe there because
// the last writer saw what it was replacing.
//
// The quick logger's COLD OFFLINE OPEN is the first form in the app that cannot see
// it. With no connection the sheet builds the mood form from what the device itself
// holds — the day and its own queued taps — so a day the person filled in this
// morning on another device opens EMPTY, and a one-tap face over it would replay a
// null energy, a null Calm, no factors and no note onto a paragraph nobody meant to
// delete. A null there means "not asked on this device", which is not an answer.
//
// So the caller states which of the two it is, and a payload composed blind MERGES:
// it lands what it carries and leaves untouched every field it does not.
//
// THE COST, STATED: a blind payload cannot CLEAR a field — including one this device
// queued itself and is showing back to the person, since the cold-open copy folds in
// its own queued check-ins. Deleting a note or deselecting every factor on that form
// leaves both as they were. Failing to delete is the better half of the trade, and it
// is the whole of it: clearing is reachable from any form that read the day.
export type MoodWriteSight =
  // The payload is the day's whole answer; every field it carries, including its
  // nulls, replaces what is there. The default, and what every path but one passes.
  | "saw-the-day"
  // The payload was composed without the day's stored row in view. Absent is UNKNOWN,
  // never an erasure.
  | "day-unseen";

// TWO LITERAL STATEMENTS rather than one built from a flag — the same rule
// `moodRatingUpdate` states below: the profile-scoping scanner reads the literal
// prepare() text, and SQL assembled around a condition is unreadable to it.
function moodUpsert(sight: MoodWriteSight) {
  return sight === "day-unseen"
    ? db.prepare(
        `INSERT INTO mood_logs (profile_id, date, valence, energy, anxiety, factors, notes)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(profile_id, date) DO UPDATE SET
           valence = excluded.valence,
           energy = COALESCE(excluded.energy, mood_logs.energy),
           anxiety = COALESCE(excluded.anxiety, mood_logs.anxiety),
           factors = COALESCE(excluded.factors, mood_logs.factors),
           notes = COALESCE(excluded.notes, mood_logs.notes),
           updated_at = ?`
      )
    : db.prepare(
        `INSERT INTO mood_logs (profile_id, date, valence, energy, anxiety, factors, notes)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(profile_id, date) DO UPDATE SET
           valence = excluded.valence,
           energy = excluded.energy,
           anxiety = excluded.anxiety,
           factors = excluded.factors,
           notes = excluded.notes,
           updated_at = ?`
      );
}

// Persist one daily wellbeing check-in — the SINGLE write core shared by the
// dashboard card's server action, the offline replay, and the Telegram check-in
// button, all running the same pure normalizeMoodInput guard. IDEMPOTENT PER DAY:
// upserts on the table's UNIQUE(profile_id, date) key, so a replay or a same-day
// re-tap updates the one row (last write wins for that day) instead of
// duplicating it. Every successful write also RESETS the check-in reminder's
// ignored counter — a submitted check-in re-arms the auto-paused reminder — done
// here so every write path re-arms identically. Returns false on a rejected
// payload (bad date / out-of-range scale), true on a successful upsert.
//
// NO CAPTURED INSTANT, deliberately (#2312's inventory, answered rather than left
// to inference). A check-in is a DAY's answer: `MoodPayload` carries no instant,
// the queue's captured `date` is the whole of its time model (#94 day attribution,
// untouched by the instant work), and a replay at dinner still lands on the day the
// user tapped. `updated_at` is a pure audit "last modified" stamp — nothing keys a
// day off it, so the #1534 rule PERMITS SQL's own clock here — but both statements
// bind `sqlNow()` anyway: the seam is byte-identical in production, and one bound
// parameter is cheaper than two more raw clock reads for a stamp nothing reads back.
export function upsertMoodLog(
  profileId: number,
  date: string,
  raw: {
    valence: unknown;
    energy?: unknown;
    anxiety?: unknown;
    factors?: unknown;
    note?: unknown;
  },
  // WHAT THE FORM COULD SEE WHEN IT COMPOSED `raw` — the caller's own answer, never
  // inferred here. The default is what every path but the cold offline open passes,
  // and it is the write this core has always made. See `MoodWriteSight`.
  sight: MoodWriteSight = "saw-the-day"
): boolean {
  // The shared date invariant (#4425). The CHIP tap's ±2 reach lives in `TAP_REACH`
  // where the offer is; the core takes any real past day, which is also what lets the
  // offline replay keep landing a queued check-in on its captured date however long
  // the queue sat.
  if (!isPastWriteAccepted(today(profileId), date)) return false;
  const normalized = normalizeMoodInput(raw);
  if ("error" in normalized) return false;
  moodUpsert(sight).run(
    profileId,
    date,
    normalized.valence,
    normalized.energy,
    normalized.anxiety,
    normalized.factors.length ? JSON.stringify(normalized.factors) : null,
    normalized.note,
    sqlNow()
  );
  resetMoodCheckinIgnored(profileId);
  return true;
}
export const upsertMoodLogDeclares = MOOD_CHECKIN;

// Correct or remove ONE past check-in, from the mood detail page's readings table
// (issue #1488, absorbing #1397). Before this, `upsertMoodLog` was the only mood
// write there was: today's mood was correctable by re-tapping, but a mis-tapped
// "1 — awful" on a PAST day sat in the trend permanently, and the only editor was a
// dialog reachable solely for days that already had a sleep record.
//
// Both live HERE, beside the upsert, because mood is store-private (#992): the ONE
// write core owns every mutation of the table, so no engine elsewhere names it.
// Profile-scoped by the WHERE clause; return false when nothing matched (a wrong id,
// or another profile's row).
// `column` names WHICH of the row's three 1–5 ratings the correction lands on
// (#1408) — energy and anxiety are charted and detail-paged now, so each is
// correctable from its own readings table. The value is always in STORED semantics:
// the Calm relabel is a display map that never reaches this layer.
export function updateMoodRating(
  profileId: number,
  id: number,
  column: MoodRatingColumn,
  value: number
): boolean {
  // The same 1-5 scale the pure normalizeMoodInput guard enforces on insert; a
  // correction may not smuggle in an off-scale value the check-in couldn't produce.
  if (!Number.isInteger(value) || value < MOOD_MIN || value > MOOD_MAX)
    return false;
  return moodRatingUpdate(column).run(value, id, profileId).changes > 0;
}

// One literal statement per column — the column can't be interpolated without making
// the SQL unreadable to the profile-scoping scanner, which verifies `profile_id` in
// LITERAL prepare() text.
function moodRatingUpdate(column: MoodRatingColumn) {
  switch (column) {
    case "valence":
      return db.prepare(
        `UPDATE mood_logs SET valence = ?, updated_at = datetime('now')
          WHERE id = ? AND profile_id = ?`
      );
    case "energy":
      return db.prepare(
        `UPDATE mood_logs SET energy = ?, updated_at = datetime('now')
          WHERE id = ? AND profile_id = ?`
      );
    case "anxiety":
      return db.prepare(
        `UPDATE mood_logs SET anxiety = ?, updated_at = datetime('now')
          WHERE id = ? AND profile_id = ?`
      );
  }
}

// Clear ONE optional rating off a check-in (#1408) — the body_metrics precedent, one
// store down: a check-in row carries up to three ratings, so removing a mis-tapped
// energy must not take that day's mood, note and factors with it. Valence has no
// clear (it is NOT NULL and IS the check-in); deleting it deletes the day's row,
// which is what `deleteMoodLog` below has always done.
export function clearMoodRating(
  profileId: number,
  id: number,
  column: Exclude<MoodRatingColumn, "valence">
): boolean {
  const stmt =
    column === "energy"
      ? db.prepare(
          `UPDATE mood_logs SET energy = NULL, updated_at = datetime('now')
            WHERE id = ? AND profile_id = ? AND energy IS NOT NULL`
        )
      : db.prepare(
          `UPDATE mood_logs SET anxiety = NULL, updated_at = datetime('now')
            WHERE id = ? AND profile_id = ? AND anxiety IS NOT NULL`
        );
  return stmt.run(id, profileId).changes > 0;
}

// Delete a whole check-in — the row IS the day, so this takes valence, energy, anxiety,
// factors and the note together. Returns the UNDO TOKEN (#2123) rather than a boolean:
// the readings table's ⋯ → Delete offered Undo for a weigh-in and nothing for a mood row
// out of the same menu, and a mis-tap here cost a note nobody could retype. `null` means
// nothing was deleted (no such row, or not this profile's) — the boolean's `false`.
export function deleteMoodLog(profileId: number, id: number): number | null {
  return captureDelete("mood-log", profileId, id);
}

// ── workout session (#1596 — #28's "add set", landed) ──────────────────────────

// The form fields a queued session capture may carry into saveActivityCore — the
// exact submit vocabulary of the activity form's buildFormData, MINUS `id` and
// `profile_id`. Stripping those two is what makes the flow create-only on the
// stamped profile by construction: a tampered queue entry can't turn a capture
// into an update of an arbitrary row, and profile attribution stays the route's
// per-intent write-access check (#599), never a smuggled form field.
const SET_FIELDS = [
  "weight_unit",
  "distance_unit",
  "type",
  "title",
  "date",
  "components",
  "sets",
  "notes",
  "start_time",
  "end_time",
  "intensity",
  "duration_min",
  "est_calories",
  "equipment_id",
] as const;

// Apply a queued offline-logged workout session through the SHARED activity write
// core — the same implementation the live form's auto-save posts to, so a replay
// runs the identical title/date guard, captured-unit conversion (#630),
// composite rollup, per-set canonicalization, routine crediting (#740), and
// post-workout dispatch (#1154). The captured `date` on the intent is
// authoritative (issue #28 point 5): it overwrites whatever the fields carry, so
// the session lands on the day the user logged it. The core's typed
// SaveActivityOutcome is honored via classifySetReplay, so an invalid payload
// dead-letters with its reason instead of vanishing.
function applySetIntent(
  profileId: number,
  payload: SetPayload,
  date: string,
  capturedAt: unknown
): { status: "done" | "rejected"; reason?: string } {
  const fields = payload?.fields;
  if (!fields || typeof fields !== "object" || !isRealIsoDate(date)) {
    return { status: "rejected" };
  }
  const fd = new FormData();
  for (const key of SET_FIELDS) {
    const value = (fields as Record<string, unknown>)[key];
    if (typeof value === "string") fd.set(key, value);
  }
  fd.set("date", date);
  // COMPLETION STAMP (#1596 follow-up). A queued session is a CLOSED session —
  // the capture only ever fires on the editor's close path — but the create form
  // defaults start_time to the open moment, and an offline session is typically
  // abandoned without an end or a duration. Replayed verbatim, that row carries
  // the live-draft signature (started, unended, duration-less), so workout
  // presence (#921) resurrects it as an ACTIVE workout at whatever moment the
  // device reconnects: the app-wide dock and the 45-min "Still working out?" nag
  // haunt every page for as long as the draft is held open — hours after the user
  // walked away (the #1441 class, re-created by replay; caught as cross-spec
  // dock contamination on CI). The capture instant IS when the session closed,
  // so stamp it as the end — wall-clock HH:MM in the profile's timezone, the
  // same "end = the moment you finished" rule the live Finish button applies —
  // making the row read as the completed session it is (isCompletedSessionRow).
  // A payload that already carries an end time or a positive duration is left
  // untouched; a start-less capture is already completed and needs nothing.
  //
  // The ceiling this capture is judged against is the app's own now (`clockNow()`,
  // #2312), never a bare `new Date()` — the same correction #2287/#2310 made for
  // food, on the flow that fix did not reach. A session closed at 18:05 and
  // replayed at 21:00 must end at 18:05, and under the e2e freeze the capture and
  // the seam read one clock, so a real-time ceiling would rewrite the close moment
  // into the reconnect moment. Inert in production, where the seam IS real time.
  const durationField = Number(fd.get("duration_min"));
  const hasDuration = Number.isFinite(durationField) && durationField > 0;
  if (fd.get("start_time") && !fd.get("end_time") && !hasDuration) {
    const closedAt = new Date(resolveCapturedInstant(capturedAt, clockNow()));
    fd.set("end_time", zonedDateParts(getTimezone(profileId), closedAt).hhmm);
  }
  // Canonical-unit fallbacks only: the capture always stamps the units each value
  // was entered in (buildFormData sets both), so these are unreachable for a real
  // intent and merely keep the core total for a hand-crafted one.
  const outcome = saveActivityCore(
    profileId,
    fd,
    { weightUnit: "kg", distanceUnit: "km" },
    OFFLINE_REPLAY
  );
  return classifySetReplay(outcome);
}

// ── food quick-add (#1596) ──────────────────────────────────────────────────────

// Apply a queued food-serving or protein-grams tap through the SAME auth-blind
// cores the online actions (and the Telegram buttons) use, so a replay runs the
// identical catalog validation and per-add bounds. Additive only — the "−" undo
// taps never queue (see the queue.ts scope comment). The intent's capturedAt is
// the ledger's tap instant (resolveCapturedInstant). The captured meal slot and
// the captured eating time both travel, and the CORE arbitrates them (#2269,
// logFoodServingCore): a usable stated time wins and no slot is stored — the meal
// derives from the instant — while a statement-less capture keeps its declared
// slot, so the serving counts for the meal the user was logging, not the
// reconnect moment. One chokepoint, so this replay cannot drift from the web
// action or the quick-log sheet.
function applyFoodIntent(
  profileId: number,
  payload: FoodPayload,
  date: string,
  capturedAt: unknown
): {
  status: "done" | "rejected";
  reason?: string;
  timeNotice?: StatedTimeRefusal;
} {
  if (!payload || typeof payload !== "object" || !isRealIsoDate(date)) {
    return { status: "rejected" };
  }
  // The RECORD instant this replayed serving is filed at. Its ceiling is the app's
  // own now (`clockNow()`, #2287), not a bare `new Date()`: the capture instant came
  // off a browser that answers the SAME "now" the server does, so clamping it against
  // a second, independent clock silently rewrites a seconds-old tap into a different
  // instant. In production the seam IS real time, so this is inert.
  const loggedAt = resolveCapturedInstant(capturedAt, clockNow());
  if (payload.entry === "serving") {
    const group = typeof payload.groupKey === "string" ? payload.groupKey : "";
    // A captured slot must still be a real slot; a garbage one rejects rather
    // than silently re-slotting the serving (the online action refuses it too).
    let mealSlot: FoodSlot | undefined;
    if (payload.mealSlot != null && payload.mealSlot !== "") {
      if (!isFoodSlot(payload.mealSlot)) return { status: "rejected" };
      mealSlot = payload.mealSlot;
    }
    // The stated eating time (#2053), validated rather than trusted: an instant that
    // is in the future, or whose profile-local date isn't the day this serving is
    // landing on, costs the STATEMENT and never the serving.
    //
    // THIS is where a fast device clock actually bites (#2296): the offline capture is
    // the one food path that carries a client INSTANT rather than a choice the server
    // resolves, so a phone six minutes ahead loses the minute it stated, here. The
    // serving still lands — but the verdict rides back out as a `timeNotice` so the
    // reconnect confirmation can say the minute did not.
    //
    // WHICH now it is judged against is the whole of #2287, and it is what makes that
    // notice TRUE. This used to be a bare `new Date()` — deliberately outside the clock
    // seam, on the reasoning that a client instant and the server's are two independent
    // REAL clocks. Under the e2e freeze they are not independent: the fixture puts the
    // BROWSER on the same frozen instant the server reads, so judging against real time
    // compared a value with a DIFFERENT clock and refused a seconds-old statement as 58
    // minutes in the future — landing `time_source` NULL, and (since #2296) telling the
    // user their device's clock was ahead when it was the suite's freeze that had moved.
    // The seam removes the spurious refusals; the ones that survive are real, which is
    // the only footing on which a notice is worth showing. Inert in production, where
    // the seam IS the real clock — a genuinely fast device is still refused, and still
    // says so.
    const verdict = judgeEatenAt(
      typeof payload.eatenAt === "string" ? new Date(payload.eatenAt) : null,
      getTimezone(profileId),
      date,
      clockNow()
    );
    const outcome = logFoodServingCore(
      profileId,
      group,
      date,
      OFFLINE_REPLAY,
      loggedAt,
      // ONE placement, reduced exactly as the online action reduces it (#4729), so a
      // replay and a live tap cannot answer the same payload differently.
      verdict.kind === "accepted"
        ? { eatenAt: utcInstant(verdict.at), source: "stated" as const }
        : mealSlot
    );
    if (outcome.kind === "unknown-group") {
      return {
        status: "rejected",
        reason:
          "This food group is no longer available, so the serving wasn't logged.",
      };
    }
    // The core's day bound (#4118), which this path had none of: a queued write carries
    // a CLIENT-captured date and, until that bound, `isRealIsoDate` was the whole check
    // — so a phone whose clock was a day fast queued a serving into the future and the
    // replay stored it. Permanently rejected rather than re-dated: the queue never
    // invents a day (that is D20's rule for doses, and this is its food sibling).
    if (outcome.kind === "invalid-date") {
      return {
        status: "rejected",
        reason:
          "That day isn't one this can be logged on, so the serving wasn't logged.",
      };
    }
    return {
      status: "done",
      ...(verdict.kind === "refused" ? { timeNotice: verdict.reason } : {}),
    };
  }
  if (payload.entry === "protein") {
    const grams = payload.grams;
    if (typeof grams !== "number") return { status: "rejected" };
    const outcome = addProteinGramsCore(
      profileId,
      date,
      grams,
      OFFLINE_REPLAY,
      loggedAt
    );
    if (outcome.kind === "invalid") {
      return {
        status: "rejected",
        reason:
          "The protein amount wasn't valid (1–300 grams), so it wasn't logged.",
      };
    }
    if (outcome.kind === "invalid-date") {
      return {
        status: "rejected",
        reason:
          "That day isn't one this can be logged on, so it wasn't logged.",
      };
    }
    return { status: "done" };
  }
  // Unknown entry discriminant — permanently malformed.
  return { status: "rejected" };
}

// ── idempotency ledger ──────────────────────────────────────────────────────────

// Has this idempotency key already been applied for this profile? Consulted before
// a replayed write so a duplicate flush is a no-op (issue #28 exactly-once).
export function alreadyReplayed(profileId: number, key: string): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM replayed_keys WHERE client_key = ? AND profile_id = ?"
    )
    .get(key, profileId);
}

function recordReplayKey(profileId: number, key: string, flow: FlowKind): void {
  db.prepare(
    "INSERT OR IGNORE INTO replayed_keys (client_key, profile_id, flow) VALUES (?,?,?)"
  ).run(key, profileId, flow);
}

// Retention sweep (issue #98), driven from the hourly notify tick alongside the
// deleted_rows undo purge. A replayed-key row only has to outlive the replay-race
// window (online event / on-load flush / Background Sync triple-fire), so anything
// older than REPLAYED_KEYS_RETENTION_DAYS is safe to drop — a flush that old would
// re-apply the write on a fresh key anyway. GLOBAL by design: one call per tick
// clears EVERY profile's expired ledger rows by age, so it is intentionally NOT
// profile-scoped (mirrors sweepDeletedRows; allowlisted in the profile-scoping
// test). Returns the number of rows removed. Never throws — a sweep failure must
// not affect the tick.
export function sweepReplayedKeys(
  maxAgeDays = REPLAYED_KEYS_RETENTION_DAYS
): number {
  try {
    return db
      .prepare(
        `DELETE FROM replayed_keys WHERE created_at < datetime('now', ?)`
      )
      .run(daysAgoModifier(maxAgeDays)).changes;
  } catch {
    return 0;
  }
}

// ── replay dispatch ─────────────────────────────────────────────────────────────

// The terminal outcome of applying one queued intent: "done" (written now),
// "duplicate" (key already applied — no-op), or "rejected" (payload permanently
// invalid). A transient failure is NOT represented here — the underlying write /
// transaction throws, and the route maps that to a retryable "error". A rejection
// may carry a `reason` — the honest, user-facing explanation the dead-letter panel
// shows (#1427: a paused item / retired dose / too-old entry each say so, instead of
// the generic "couldn't validate this entry").
export type ReplayApplied = "done" | "duplicate" | "rejected";

export interface ReplayOutcome {
  status: ReplayApplied;
  reason?: string;
  // A statement the write KEPT NOTHING OF while keeping the row (#2296). Only a
  // `done` outcome carries one: the intent applied, and something the user said about
  // WHEN did not survive the gate. It is not a failure and must never be shown as
  // one — see components/OfflineQueueProvider for how loud "tell them" is allowed to
  // be once the user may have walked away from the tap.
  timeNotice?: StatedTimeRefusal;
}

// Apply one queued intent for `profileId`, exactly once. The idempotency-key check
// and the write run in ONE transaction: a key already present short-circuits to
// "duplicate"; a rejected payload commits nothing and records no key; a successful
// write records the key so any later flush of the same key is a no-op. Real DB
// errors propagate (the caller treats them as retryable). (The dose flows' own write
// cores open a nested writeTx — better-sqlite3 turns that into a SAVEPOINT, so the
// whole intent still commits or rolls back as one.)
export function applyIntent(
  profileId: number,
  intent: QueuedIntent
): ReplayOutcome {
  let outcome: ReplayOutcome = { status: "rejected" };
  // Set by a flow that APPLIED while refusing a stated time (#2296) — carried out on
  // the "done" outcome below, never on a rejection (the two mean opposite things: one
  // kept the row, the other kept nothing).
  let timeNotice: StatedTimeRefusal | undefined;
  writeTx(() => {
    if (alreadyReplayed(profileId, intent.key)) {
      outcome = { status: "duplicate" };
      return;
    }
    let ok = false;
    if (intent.flow === "dose" || intent.flow === "skip-dose") {
      // The dose flows answer from the shared core's typed outcome, so a refusal
      // keeps its reason instead of collapsing to a bare false.
      const applied = applyDoseIntent(
        profileId,
        intent.flow,
        intent.payload as DosePayload,
        intent.date
      );
      if (applied.status === "rejected") {
        outcome = applied;
        return;
      }
      ok = true;
    } else if (intent.flow === "body-metric") {
      const p = intent.payload as BodyMetricPayload;
      const applied = insertBodyMetric(profileId, {
        date: intent.date,
        weight: p.weight,
        weightUnit: p.weightUnit,
        bodyFatPct: p.bodyFatPct,
        restingHr: p.restingHr,
        notes: p.notes,
        // The stated sitting time (#2235), carried through the queue so an offline
        // weigh-in keeps its statement. An intent queued before the field existed
        // has `undefined` here — no statement, never a clear.
        occurredAt: p.occurredAt,
        loggedVia: OFFLINE_REPLAY,
      });
      ok = applied.wrote;
      // The queued capture is where a fast device clock actually bites a weigh-in
      // (#2311): the intent carries a resolved INSTANT, because there was no server
      // to ask while offline, and the replay judges it against real time. The
      // reading still lands — and the reconnect confirmation now says the minute
      // did not, on the SAME `timeNotice` channel the food flow opened in #2296.
      if (applied.wrote) timeNotice = applied.statedTimeRefused;
    } else if (intent.flow === "mood") {
      const p = intent.payload as MoodPayload;
      ok = upsertMoodLog(
        profileId,
        intent.date,
        {
          valence: p.valence,
          energy: p.energy,
          anxiety: p.anxiety,
          factors: p.factors,
          note: p.note,
        },
        // The capture says what its form could see (#3416). A check-in composed on a
        // cold offline open never saw the day's stored row, so its nulls are unknowns
        // and this replay merges rather than replacing. An intent queued before the
        // flag existed carries a form that DID see the day — absent keeps its old
        // meaning, exactly as it does for the measurement markers above.
        p.dayUnseen ? "day-unseen" : "saw-the-day"
      );
    } else if (intent.flow === "stool") {
      const p = intent.payload as StoolPayload;
      const applied = logBristolStool(
        profileId,
        intent.date,
        p?.type,
        typeof p?.at === "string" ? p.at : null,
        new Date(resolveCapturedInstant(intent.capturedAt, clockNow()))
      );
      ok = applied.wrote;
      // A capture whose stated minute aged out of acceptance still lands its
      // observation, and says so on the SAME `timeNotice` channel the food flow
      // opened in #2296.
      if (applied.wrote) timeNotice = applied.statedTimeRefused;
    } else if (intent.flow === "set") {
      // The offline-logged workout replays through the shared activity core; its
      // typed outcome keeps the refusal's reason (#1596, the dose-flow pattern).
      const applied = applySetIntent(
        profileId,
        intent.payload as SetPayload,
        intent.date,
        intent.capturedAt
      );
      if (applied.status === "rejected") {
        outcome = applied;
        return;
      }
      ok = true;
    } else if (intent.flow === "food") {
      const applied = applyFoodIntent(
        profileId,
        intent.payload as FoodPayload,
        intent.date,
        intent.capturedAt
      );
      if (applied.status === "rejected") {
        outcome = applied;
        return;
      }
      timeNotice = applied.timeNotice;
      ok = true;
    } else if (intent.flow === "mobility") {
      // A queued mobility ON tap (#2130) replays through the SAME auth-blind core
      // the online action uses (set semantics per (profile, date, move)), so the
      // identical catalog validation applies and a re-replay settles on the same
      // session row. Only the ON direction ever queues — see queue.ts.
      const p = intent.payload as MobilityPayload;
      const slug = typeof p?.move === "string" ? p.move.trim() : "";
      if (!slug || !isRealIsoDate(intent.date)) {
        outcome = { status: "rejected" };
        return;
      }
      const applied = logMobilityMoveCore(
        profileId,
        slug,
        intent.date,
        OFFLINE_REPLAY
      );
      if (applied.kind === "unknown-move") {
        outcome = {
          status: "rejected",
          reason:
            "This mobility move is no longer in the catalog, so it wasn't logged.",
        };
        return;
      }
      ok = true;
    } else if (intent.flow === "practice") {
      // A queued practice tap (#2908) replays DAY-IDEMPOTENTLY: the core inserts only
      // when that (practice-identity, day) holds no session, so a day already logged
      // from another device between capture and replay is a NO-OP, not a second
      // session. That is the amendment to #2130's argued exclusion, and the reason the
      // #2007 same-day confirm never needs asking here.
      //
      // "already-logged" settles as DONE, not rejected, for the same reason a dose
      // confirm that finds the dose already taken is done: a set-to intent's whole
      // point is that the state it wanted is the state that stands. Reporting it as a
      // failure would put a red "couldn't be applied" card in front of someone whose
      // practice day is recorded exactly as they meant it.
      const p = intent.payload as PracticePayload;
      const name = typeof p?.practice === "string" ? p.practice.trim() : "";
      if (!name) {
        outcome = { status: "rejected" };
        return;
      }
      // THE TAP'S REACH, ASKED HERE (#4425 owner ruling 2026-08-31). A queued practice
      // capture IS a tap, and a capture that sat until its day fell out of the tap's
      // reach is dead-lettered rather than landed years late — the dose replay has
      // always consulted `isDoseDateAccepted` for exactly this. The bound used to come
      // from the write core, which now takes any real past day like every other core,
      // so asking the core would silently land a stale capture on a closed day.
      if (
        !isWithinTapReach("practice-session", today(profileId), intent.date)
      ) {
        outcome = {
          status: "rejected",
          reason:
            "This practice entry is too old to log automatically. Re-enter it from the practice's history.",
        };
        return;
      }
      const applied = logPracticeSessionForDay(
        profileId,
        name,
        intent.date,
        OFFLINE_REPLAY,
        {
          durationMin: p.durationMin ?? null,
          // No stated start: the capture happened offline on a device clock, and the
          // write core's own tap stamp is the profile's clock (#450). A replay landing
          // the next morning must not stamp the session with the reconnect minute, so
          // this path states nothing rather than stating something false. It states no
          // end either — the queue carries a practice DAY, never a window (#3142).
          startTime: null,
        }
      );
      if (applied.kind === "invalid-date") {
        outcome = {
          status: "rejected",
          reason:
            "This practice entry is too old to log automatically. Re-enter it from the practice's history.",
        };
        return;
      }
      ok = true;
    } else if (intent.flow === "vitals") {
      const p = intent.payload as VitalsPayload;
      const applied = insertVitals(
        profileId,
        intent.date,
        {
          systolic: p.systolic,
          diastolic: p.diastolic,
          glucose: p.glucose,
          glucoseUnit: p.glucoseUnit,
          spo2: p.spo2,
          temperature: p.temperature,
          tempUnit: p.tempUnit,
          sleepHours: p.sleepHours,
          // The night's two clocks (#1851) — a queued sitting replays with the
          // window it stated, so an offline bed/wake entry still feeds SRI.
          bedTime: p.bedTime,
          wakeTime: p.wakeTime,
          hrv: p.hrv,
          respiratoryRate: p.respiratoryRate,
          gripStrength: p.gripStrength,
          chairStand: p.chairStand,
          balance: p.balance,
          peakFlow: p.peakFlow,
          // Pre-fold intents' per-measure times (#2154 keeps replaying them).
          temperatureTime: p.temperatureTime,
          peakFlowTime: p.peakFlowTime,
        },
        // THE ONE call of this core that really is a replay (#3087).
        OFFLINE_REPLAY,
        // The sitting's stated time (#2154), carried through the queue exactly as
        // the body-metric flow carries its own. An intent queued before the fold
        // has `undefined` here — no statement, and the legacy fields above apply.
        p.occurredAt
      );
      ok = applied.wrote;
      // A queued sitting is where a fast device clock bites the vitals half, for
      // the same reason it bites the weigh-in (#2311): the intent carries a
      // resolved INSTANT because there was no server to ask while offline. The
      // readings still land, and the reconnect confirmation now says the minute did
      // not — on the SAME `timeNotice` channel the food flow opened in #2296
      // (#2363).
      if (applied.wrote) timeNotice = applied.statedTimeRefused;
    } else {
      // Unknown flow — treat as a permanent rejection (client drops it).
      outcome = { status: "rejected" };
      return;
    }
    if (!ok) {
      outcome = { status: "rejected" };
      return;
    }
    recordReplayKey(profileId, intent.key, intent.flow);
    outcome = { status: "done", ...(timeNotice ? { timeNotice } : {}) };
  });
  return outcome;
}
