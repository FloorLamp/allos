// Server-side write cores for the offline-queueable quick-log flows (issue #28).
// These are the SINGLE implementation of each write: both the online Server Actions
// (app/(app)/trends/measurement-actions.ts + body-actions.ts, medicine/actions.ts,
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
import { isRealIsoDate, utcInstant, zonedDateParts } from "@/lib/date";
import { isDoseDateAccepted } from "@/lib/dose-log-window";
import { toKg } from "@/lib/units";
import type { WeightUnit } from "@/lib/settings";
import {
  normalizeClockTime,
  normalizeVitalsInput,
  VITAL_CANONICAL,
  type VitalsRawInput,
} from "@/lib/vitals-input";
import { statedInstantOnDate } from "@/lib/stated-time";
import { normalizeGrowthInput, type GrowthInputRaw } from "@/lib/growth-input";
import { markDoseSkipped, markDoseTaken } from "@/lib/queries";
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
import { acceptEatenAt } from "@/lib/food-eating-time";
import { addProteinGramsCore } from "@/lib/protein-log-write";
import { saveActivityCore } from "@/lib/activity-write";
import { logMobilityMoveCore } from "@/lib/mobility-log-write";
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
} from "@/lib/offline/queue";

// ── dose confirm / skip ───────────────────────────────────────────────────────

// Apply a queued dose confirm or skip through the SHARED write core (#1427).
//
// There is NO offline-specific dose write. markDoseTaken / markDoseSkipped are the
// one implementation every confirm path goes through — the page tri-state's sibling,
// the dashboard hero, the household cockpit, the Telegram ✅/⏭ taps — and a replayed
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
  // Distinguish "the entry sat in the queue too long" from "the dose is gone" for the
  // user-facing reason ONLY — the same pure predicate the core gates on, so the two
  // can't drift. The core still enforces it (it answers stale-dose either way).
  if (!isDoseDateAccepted(today(profileId), date)) {
    return { status: "rejected", reason: STALE_QUEUED_DOSE_REASON };
  }
  const outcome =
    flow === "dose"
      ? markDoseTaken(
          profileId,
          doseId,
          null,
          date,
          payload.clientTakenAt ? new Date(payload.clientTakenAt) : undefined
        )
      : markDoseSkipped(profileId, doseId, null, date);
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
  // statement, never the reading.
  occurredAt?: string | null;
}

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
): boolean {
  if (!isRealIsoDate(w.date)) return false;
  const weightRaw = String(w.weight ?? "").trim();
  const weight = weightRaw === "" ? null : Number(weightRaw);
  if (weight != null && !Number.isFinite(weight)) return false;
  const bodyFat = numOrNull(w.bodyFatPct);
  const restingHr = numOrNull(w.restingHr);
  if (weight == null && bodyFat == null && restingHr == null) return false;
  const weightKg = weight == null ? null : toKg(weight, w.weightUnit);
  const notes = w.notes && w.notes.trim() ? w.notes.trim() : null;
  const stated = resolveStatedOccurredAt(profileId, w.date, w.occurredAt);
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
        `INSERT INTO body_metrics (date, weight_kg, body_fat_pct, resting_hr, notes, occurred_at, profile_id)
         VALUES (?,?,?,?,?,?,?)`
      ).run(
        w.date,
        weightKg,
        bodyFat,
        restingHr,
        notes,
        // Bound, never defaulted (#2205): the stated instant or honest NULL.
        stated ?? null,
        profileId
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
  return true;
}

// ── vitals quick-add ────────────────────────────────────────────────────────────

// Insert-or-update a manual daily metric sample (sleep/HRV) — one row per date so a
// re-entry corrects rather than duplicates. source='manual', origin=NULL, and a
// fixed midnight start make the natural key stable, while `source` keeps a Health
// Connect push from ever touching it.
function upsertManualSample(
  profileId: number,
  metric: string,
  date: string,
  value: number
): void {
  const ts = `${date}T00:00:00`;
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       value = excluded.value, date = excluded.date`
  ).run(profileId, metric, date, ts, ts, value);
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
// `start_time`, so a second blow the same day is a second reading rather than a
// correction of the first (the natural key includes the instant).
//
// THE SITTING'S STATED TIME (#2154). `occurredAt` is the one WhenControl statement
// the measurements form posts for the whole sitting, on the exact contract the
// body-metrics core declares: `undefined` = no statement, `null` = explicitly no
// time, a string = the stated instant. Every observation this submission writes
// (BP, glucose, SpO₂, temperature) carries it into `medical_records.occurred_at`
// through `recordReading`'s acceptance gate — a refused statement (future, or off
// the row's day) costs the statement, never the reading — and the peak-flow blow
// derives its profile-local `start_time` from the SAME accepted instant, so one
// sitting states one "when" everywhere it lands.
//
// LEGACY per-measure times: an intent queued before the fold carries
// `temperatureTime` / `peakFlowTime` ("HH:MM") instead. Those are the user's own
// wall clock on the profile's own day, so — unlike a zoneless clinical clock —
// resolving them against the profile's timezone is exactly what the WhenControl
// itself would have done (`statedInstantOnDate`); the temperature time lands on
// the temperature row only, as it always did, and never writes a note again.
export function insertVitals(
  profileId: number,
  date: string,
  raw: VitalsRawInput,
  occurredAt?: string | null
): boolean {
  if (!isRealIsoDate(date)) return false;
  const normalized = normalizeVitalsInput(raw);
  if ("error" in normalized) return false;
  const { medical, samples, readings } = normalized;
  if (medical.length === 0 && samples.length === 0 && readings.length === 0) {
    return false;
  }

  const tz = getTimezone(profileId);
  // The sitting statement, resolved ONCE through the shared boundary so the
  // peak-flow derivation below can only ever use an instant the gate accepted.
  const stated = resolveStatedOccurredAt(profileId, date, occurredAt);
  // A pre-fold temperature "HH:MM" (a queued intent, or a stale pre-fold tab whose
  // sitting Time was left empty), as an instant on the row's own day — only
  // consulted when the submission carries no sitting INSTANT, because in the
  // pre-fold form an empty sitting Time said nothing about the temperature's own
  // time field. A new client never posts the field, so this path never fires.
  const legacyTempAt =
    occurredAt == null
      ? (() => {
          const hhmm = normalizeClockTime(raw.temperatureTime);
          return hhmm
            ? (statedInstantOnDate(date, hhmm, tz)?.toISOString() ?? undefined)
            : undefined;
        })()
      : undefined;

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
      category: m.category,
      occurredAt:
        m.canonical === VITAL_CANONICAL.temperature.canonical &&
        legacyTempAt !== undefined
          ? legacyTempAt
          : occurredAt,
    });
  }
  for (const s of samples) {
    upsertManualSample(profileId, s.metric, date, s.value);
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
      measuredAt: at ? `${date}T${at}:00` : null,
    });
  }
  return true;
}

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
// source='manual', origin=NULL, start_time) is stable across re-entries: logging
// the same date again CORRECTS that day rather than stacking a second point.
// Returns false on a rejected/empty input, true on a successful write.
export function insertGrowth(
  profileId: number,
  date: string,
  raw: GrowthInputRaw
): boolean {
  if (!isRealIsoDate(date)) return false;
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

// ── mood check-in (issue #992) ──────────────────────────────────────────────────

// Persist one daily wellbeing check-in — the SINGLE write core shared by the
// dashboard card's server action, the offline replay, and the Telegram check-in
// button, all running the same pure normalizeMoodInput guard. IDEMPOTENT PER DAY:
// upserts on the table's UNIQUE(profile_id, date) key, so a replay or a same-day
// re-tap updates the one row (last write wins for that day) instead of
// duplicating it. Every successful write also RESETS the check-in reminder's
// ignored counter — a submitted check-in re-arms the auto-paused reminder — done
// here so every write path re-arms identically. Returns false on a rejected
// payload (bad date / out-of-range scale), true on a successful upsert.
export function upsertMoodLog(
  profileId: number,
  date: string,
  raw: {
    valence: unknown;
    energy?: unknown;
    anxiety?: unknown;
    factors?: unknown;
    note?: unknown;
  }
): boolean {
  if (!isRealIsoDate(date)) return false;
  const normalized = normalizeMoodInput(raw);
  if ("error" in normalized) return false;
  db.prepare(
    `INSERT INTO mood_logs (profile_id, date, valence, energy, anxiety, factors, notes)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(profile_id, date) DO UPDATE SET
       valence = excluded.valence,
       energy = excluded.energy,
       anxiety = excluded.anxiety,
       factors = excluded.factors,
       notes = excluded.notes,
       updated_at = datetime('now')`
  ).run(
    profileId,
    date,
    normalized.valence,
    normalized.energy,
    normalized.anxiety,
    normalized.factors.length ? JSON.stringify(normalized.factors) : null,
    normalized.note
  );
  resetMoodCheckinIgnored(profileId);
  return true;
}

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

export function deleteMoodLog(profileId: number, id: number): boolean {
  const info = db
    .prepare(`DELETE FROM mood_logs WHERE id = ? AND profile_id = ?`)
    .run(id, profileId);
  return info.changes > 0;
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
// runs the identical age-gate, title/date guard, captured-unit conversion (#630),
// composite rollup, per-set canonicalization, routine crediting (#740), and
// post-workout dispatch (#1154). The captured `date` on the intent is
// authoritative (issue #28 point 5): it overwrites whatever the fields carry, so
// the session lands on the day the user logged it. The core's typed
// SaveActivityOutcome is honored via classifySetReplay, so a refusal (restricted
// profile, invalid payload) dead-letters with its reason instead of vanishing.
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
  // haunt every page for up to ACTIVE_MAX_QUIET_MIN — hours after the user
  // walked away (the #1441 class, re-created by replay; caught as cross-spec
  // dock contamination on CI). The capture instant IS when the session closed,
  // so stamp it as the end — wall-clock HH:MM in the profile's timezone, the
  // same "end = the moment you finished" rule the live Finish button applies —
  // making the row read as the completed session it is (isCompletedSessionRow).
  // A payload that already carries an end time or a positive duration is left
  // untouched; a start-less capture is already completed and needs nothing.
  const durationField = Number(fd.get("duration_min"));
  const hasDuration = Number.isFinite(durationField) && durationField > 0;
  if (fd.get("start_time") && !fd.get("end_time") && !hasDuration) {
    const closedAt = new Date(resolveCapturedInstant(capturedAt));
    fd.set("end_time", zonedDateParts(getTimezone(profileId), closedAt).hhmm);
  }
  // Canonical-unit fallbacks only: the capture always stamps the units each value
  // was entered in (buildFormData sets both), so these are unreachable for a real
  // intent and merely keep the core total for a hand-crafted one.
  const outcome = saveActivityCore(profileId, fd, {
    weightUnit: "kg",
    distanceUnit: "km",
  });
  return classifySetReplay(outcome);
}

// ── food quick-add (#1596) ──────────────────────────────────────────────────────

// Apply a queued food-serving or protein-grams tap through the SAME auth-blind
// cores the online actions (and the Telegram buttons) use, so a replay runs the
// identical catalog validation and per-add bounds. Additive only — the "−" undo
// taps never queue (see the queue.ts scope comment). The intent's capturedAt is
// the ledger's tap instant (resolveCapturedInstant), and a captured meal slot is
// asserted at replay exactly like the Telegram nudge's baked-in slot, so the
// serving counts for the meal the user was logging, not the reconnect moment.
function applyFoodIntent(
  profileId: number,
  payload: FoodPayload,
  date: string,
  capturedAt: unknown
): { status: "done" | "rejected"; reason?: string } {
  if (!payload || typeof payload !== "object" || !isRealIsoDate(date)) {
    return { status: "rejected" };
  }
  const loggedAt = resolveCapturedInstant(capturedAt);
  if (payload.entry === "serving") {
    const group = typeof payload.groupKey === "string" ? payload.groupKey : "";
    // A captured slot must still be a real slot; a garbage one rejects rather
    // than silently re-slotting the serving (the online action refuses it too).
    let mealSlot: FoodSlot | undefined;
    if (payload.mealSlot != null && payload.mealSlot !== "") {
      if (!isFoodSlot(payload.mealSlot)) return { status: "rejected" };
      mealSlot = payload.mealSlot;
    }
    // The stated eating time (#2053), validated rather than trusted. It came off the
    // client's own wall clock, so — exactly like a queued dose's `clientTakenAt` — the
    // comparison is between two independent REAL clocks and deliberately sits outside the
    // app's test-clock seam (see resolveQueuedTakenAt's "real time on purpose" note). An
    // instant that is in the future, or whose profile-local date isn't the day this
    // serving is landing on, costs the STATEMENT and never the serving.
    const stated = acceptEatenAt(
      typeof payload.eatenAt === "string" ? new Date(payload.eatenAt) : null,
      getTimezone(profileId),
      date,
      new Date()
    );
    const outcome = logFoodServingCore(
      profileId,
      group,
      date,
      loggedAt,
      mealSlot,
      stated
        ? { eatenAt: utcInstant(stated), source: "stated" as const }
        : undefined
    );
    if (outcome.kind === "unknown-group") {
      return {
        status: "rejected",
        reason:
          "This food group is no longer available, so the serving wasn't logged.",
      };
    }
    return { status: "done" };
  }
  if (payload.entry === "protein") {
    const grams = payload.grams;
    if (typeof grams !== "number") return { status: "rejected" };
    const outcome = addProteinGramsCore(profileId, date, grams, loggedAt);
    if (outcome.kind === "invalid") {
      return {
        status: "rejected",
        reason:
          "The protein amount wasn't valid (1–300 grams), so it wasn't logged.",
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
      ok = insertBodyMetric(profileId, {
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
      });
    } else if (intent.flow === "mood") {
      const p = intent.payload as MoodPayload;
      ok = upsertMoodLog(profileId, intent.date, {
        valence: p.valence,
        energy: p.energy,
        anxiety: p.anxiety,
        factors: p.factors,
        note: p.note,
      });
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
      const applied = logMobilityMoveCore(profileId, slug, intent.date);
      if (applied.kind === "unknown-move") {
        outcome = {
          status: "rejected",
          reason:
            "This mobility move is no longer in the catalog, so it wasn't logged.",
        };
        return;
      }
      ok = true;
    } else if (intent.flow === "vitals") {
      const p = intent.payload as VitalsPayload;
      ok = insertVitals(
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
          hrv: p.hrv,
          gripStrength: p.gripStrength,
          chairStand: p.chairStand,
          balance: p.balance,
          peakFlow: p.peakFlow,
          // Pre-fold intents' per-measure times (#2154 keeps replaying them).
          temperatureTime: p.temperatureTime,
          peakFlowTime: p.peakFlowTime,
        },
        // The sitting's stated time (#2154), carried through the queue exactly as
        // the body-metric flow carries its own. An intent queued before the fold
        // has `undefined` here — no statement, and the legacy fields above apply.
        p.occurredAt
      );
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
    outcome = { status: "done" };
  });
  return outcome;
}
