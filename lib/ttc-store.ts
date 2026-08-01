// Trying-to-conceive: the STORE half (issue #1680) — the auth-blind read/write cores over
// the three shipped observation stores. profileId-first, never imports lib/auth (#319);
// the Server Actions in app/(app)/medical/cycles/ttc-actions.ts own the gate, the
// validation, and the revalidation. Every statement is profile-scoped; row writes go
// through writeTx (BEGIN IMMEDIATE, #468).
//
// NO NEW TABLE. Each observation is a vocabulary extension of an existing store (see the
// lib/ttc.ts header for the mapping), and each write path uses the SHARED observation
// substrate rather than re-implementing it:
//
//   • isEditLocked  — a hand-corrected imported row is never overwritten by a re-log.
//   • classifyUpsert / tallyUpsert — the inserted/updated/unchanged split is bumped in
//     exactly one place, so a TTC write reports its disposition the same way an
//     integration sync does (and a no-op re-tap counts `unchanged`, not `updated`).
//   • latestByGroup — "what is current per observation kind" uses the ONE ordering rule
//     (newest date, highest id), keyed by the domain's identity function
//     (ttcObservationKey).

import { db, writeTx } from "./db";
import { isRealIsoDate, shiftDateStr } from "./date";
import { getCycleForecast, listCyclePeriods } from "./cycle-store";
import { getRiskAttributes, getTtcStart } from "./settings/profile-attrs";
import {
  classifyUpsert,
  emptyCounts,
  isEditLocked,
  tallyUpsert,
  type UpsertCounts,
} from "./integrations/sync-log";
import { latestByGroup } from "./latest-per-group";
import { setSymptomSeverityCore } from "./symptom-log-write";
import {
  BBT_METRIC,
  CERVICAL_MUCUS_SYMPTOM,
  LH_TEST_RECORD_NAME,
  confirmOvulation,
  fertileWindow,
  isLhResult,
  isMucusQuality,
  lutealPhaseLengthDays,
  mucusFromOrdinal,
  mucusOrdinal,
  tryingDuration,
  type DatedLhTest,
  type DatedMucus,
  type DatedTemperature,
  type FertileWindow,
  type LhResult,
  type MucusQuality,
  type OvulationConfirmation,
  type TryingDuration,
} from "./ttc";

// Plausible waking temperatures, in canonical °F. A BBT outside this is a mis-entry (a °C
// value typed into a °F field, a decimal slip), not a body.
export const BBT_MIN_F = 93;
export const BBT_MAX_F = 102;

// The source every manually logged TTC observation carries, so a Health Connect / tracker
// push can never collide with (or overwrite) a hand-tapped reading.
const MANUAL_SOURCE = "manual";

// One TTC observation, whatever store it came from — the shape the log bar and the
// derivations read. `id`/`date` satisfy LatestRow so latestByGroup can order them.
export type TtcObservationKind = "lh" | "bbt" | "mucus";

export interface TtcObservation {
  id: number;
  date: string;
  kind: TtcObservationKind;
  // The stored reading, in the kind's own vocabulary.
  lhResult?: LhResult;
  degF?: number;
  mucus?: MucusQuality;
}

// The domain's canonical identity function: an observation's group is its KIND. One LH
// test, one waking temperature and one mucus observation are current at a time, and that
// is what the entry bar reflects back. Handed to latestByGroup so this domain never
// re-implements the "which reading is current" ordering.
export function ttcObservationKey(o: TtcObservation): string {
  return o.kind;
}

// The current reading per observation kind, through the shared ordering rule.
export function latestTtcObservations(
  observations: TtcObservation[]
): Map<string, TtcObservation> {
  return latestByGroup(observations, ttcObservationKey);
}

export type TtcWriteOutcome =
  | { kind: "logged"; counts: UpsertCounts }
  // The row exists but carries the #133 edit lock (an imported reading corrected by
  // hand): nothing is written and the caller says so, rather than silently discarding.
  | { kind: "locked" }
  | { kind: "invalid"; error: string };

// ---- LH test → medical_records ----------------------------------------------

// One home ovulation test per day. Stored as a `lab`-category record named
// LH_TEST_RECORD_NAME with NO canonical_name: a urine strip is a qualitative surge
// indicator, and filing it as the serum LH analyte would flag it against serum reference
// ranges it has nothing to do with. The optional numeric intensity (a line-ratio some
// digital readers report) rides value_num; the interpretation rides `value`.
export function logLhTestCore(
  profileId: number,
  date: string,
  result: LhResult,
  intensity: number | null = null
): TtcWriteOutcome {
  if (!isRealIsoDate(date))
    return { kind: "invalid", error: "Enter a valid date." };
  if (!isLhResult(result))
    return {
      kind: "invalid",
      error: "Record the test as positive or negative.",
    };
  if (intensity != null && (!Number.isFinite(intensity) || intensity < 0)) {
    return { kind: "invalid", error: "Enter a valid test intensity." };
  }
  return writeTx((): TtcWriteOutcome => {
    const found = db
      .prepare(
        `SELECT id, value, value_num, edited FROM medical_records
          WHERE profile_id = ? AND date = ? AND name = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(profileId, date, LH_TEST_RECORD_NAME) as
      | {
          id: number;
          value: string | null;
          value_num: number | null;
          edited: number;
        }
      | undefined;
    if (found && isEditLocked(found.edited)) return { kind: "locked" };

    const same =
      found != null && found.value === result && found.value_num === intensity;
    const disposition = classifyUpsert(found != null, same);
    if (found) {
      if (!same) {
        db.prepare(
          `UPDATE medical_records SET value = ?, value_num = ?
            WHERE id = ? AND profile_id = ?`
        ).run(result, intensity, found.id, profileId);
      }
    } else {
      db.prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, source, external_id)
         VALUES (?, ?, 'lab', ?, ?, ?, ?, NULL)`
      ).run(
        profileId,
        date,
        LH_TEST_RECORD_NAME,
        result,
        intensity,
        MANUAL_SOURCE
      );
    }
    const counts = emptyCounts();
    tallyUpsert(counts, disposition);
    return { kind: "logged", counts };
  });
}

export function listLhTests(profileId: number, since: string): DatedLhTest[] {
  const rows = db
    .prepare(
      `SELECT date, value FROM medical_records
        WHERE profile_id = ? AND name = ? AND date >= ?
        ORDER BY date ASC, id ASC`
    )
    .all(profileId, LH_TEST_RECORD_NAME, since) as {
    date: string;
    value: string | null;
  }[];
  return rows
    .filter((r) => isLhResult(r.value))
    .map((r) => ({ date: r.date, result: r.value as LhResult }));
}

// ---- BBT → metric_samples ----------------------------------------------------

// One waking temperature per day, canonical °F. source='manual' + a fixed midnight
// start_time make the natural key (profile_id, metric, source, origin, start_time) stable,
// exactly like the manual sleep/HRV quick-add — a re-entry corrects rather than
// duplicates, and a tracker push can never match the row.
export function logBbtCore(
  profileId: number,
  date: string,
  degF: number
): TtcWriteOutcome {
  if (!isRealIsoDate(date))
    return { kind: "invalid", error: "Enter a valid date." };
  if (!Number.isFinite(degF))
    return { kind: "invalid", error: "Enter a valid temperature." };
  if (degF < BBT_MIN_F || degF > BBT_MAX_F) {
    return {
      kind: "invalid",
      error: `Enter a plausible waking temperature (${BBT_MIN_F}–${BBT_MAX_F} °F).`,
    };
  }
  const ts = `${date}T00:00:00`;
  return writeTx((): TtcWriteOutcome => {
    const found = db
      .prepare(
        `SELECT id, value, edited FROM metric_samples
          WHERE profile_id = ? AND metric = ? AND source = ? AND origin IS NULL
            AND start_time = ?`
      )
      .get(profileId, BBT_METRIC, MANUAL_SOURCE, ts) as
      { id: number; value: number; edited: number } | undefined;
    if (found && isEditLocked(found.edited)) return { kind: "locked" };

    const same = found != null && found.value === degF;
    const disposition = classifyUpsert(found != null, same);
    if (found) {
      if (!same) {
        db.prepare(
          `UPDATE metric_samples SET value = ? WHERE id = ? AND profile_id = ?`
        ).run(degF, found.id, profileId);
      }
    } else {
      db.prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, start_time, end_time, value)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`
      ).run(profileId, MANUAL_SOURCE, BBT_METRIC, date, ts, ts, degF);
    }
    const counts = emptyCounts();
    tallyUpsert(counts, disposition);
    return { kind: "logged", counts };
  });
}

// Every recorded waking temperature since `since`, oldest first — the series
// confirmOvulation() reads. Not source-filtered: a tracker that one day pushes a waking
// temperature under this metric is the same observation, and the rise rule should see it.
export function listBbtReadings(
  profileId: number,
  since: string
): DatedTemperature[] {
  return db
    .prepare(
      `SELECT date, value AS degF FROM metric_samples
        WHERE profile_id = ? AND metric = ? AND date >= ?
        ORDER BY date ASC, id ASC`
    )
    .all(profileId, BBT_METRIC, since) as DatedTemperature[];
}

// ---- Cervical mucus → symptom_logs ------------------------------------------

// Delegates to the shipped symptom write core rather than opening a second door into
// symptom_logs: the ordinal is an EXPLICIT set (an edit may lower it), which is exactly
// setSymptomSeverityCore's contract. Re-tapping the same quality is a no-op write the
// accounting reports as `unchanged`.
export function logMucusCore(
  profileId: number,
  date: string,
  quality: MucusQuality
): TtcWriteOutcome {
  if (!isRealIsoDate(date))
    return { kind: "invalid", error: "Enter a valid date." };
  if (!isMucusQuality(quality))
    return { kind: "invalid", error: "Pick a cervical-mucus observation." };
  const ordinal = mucusOrdinal(quality);
  const existing = db
    .prepare(
      `SELECT severity FROM symptom_logs
        WHERE profile_id = ? AND date = ? AND symptom = ?`
    )
    .get(profileId, date, CERVICAL_MUCUS_SYMPTOM) as
    { severity: number } | undefined;
  const disposition = classifyUpsert(
    existing != null,
    existing != null && existing.severity === ordinal
  );
  const outcome = setSymptomSeverityCore(
    profileId,
    CERVICAL_MUCUS_SYMPTOM,
    ordinal,
    date
  );
  if (outcome.kind !== "logged") {
    return { kind: "invalid", error: "Couldn't record that observation." };
  }
  const counts = emptyCounts();
  tallyUpsert(counts, disposition);
  return { kind: "logged", counts };
}

export function listMucusObservations(
  profileId: number,
  since: string
): DatedMucus[] {
  const rows = db
    .prepare(
      `SELECT date, severity FROM symptom_logs
        WHERE profile_id = ? AND symptom = ? AND date >= ?
        ORDER BY date ASC, id ASC`
    )
    .all(profileId, CERVICAL_MUCUS_SYMPTOM, since) as {
    date: string;
    severity: number;
  }[];
  const out: DatedMucus[] = [];
  for (const r of rows) {
    const quality = mucusFromOrdinal(r.severity);
    if (quality) out.push({ date: r.date, quality });
  }
  return out;
}

// ---- The combined gather ------------------------------------------------------

export interface TtcObservationWindow {
  lhTests: DatedLhTest[];
  bbt: DatedTemperature[];
  mucus: DatedMucus[];
}

// Every TTC observation since `since`, in one profile-scoped gather — so the fertile
// window, the ovulation confirmation and the entry bar's current state all read the SAME
// rows and can never disagree (#221).
export function getTtcObservations(
  profileId: number,
  since: string
): TtcObservationWindow {
  return {
    lhTests: listLhTests(profileId, since),
    bbt: listBbtReadings(profileId, since),
    mucus: listMucusObservations(profileId, since),
  };
}

// Today's readings per kind, for the entry bar's reflected state. Built through
// latestTtcObservations so "current" means the same thing here as everywhere else.
export function latestTtcByKind(
  profileId: number,
  since: string
): Map<string, TtcObservation> {
  const w = getTtcObservations(profileId, since);
  const rows: TtcObservation[] = [
    ...w.lhTests.map((t, i) => ({
      id: i + 1,
      date: t.date,
      kind: "lh" as const,
      lhResult: t.result,
    })),
    ...w.bbt.map((t, i) => ({
      id: i + 1,
      date: t.date,
      kind: "bbt" as const,
      degF: t.degF,
    })),
    ...w.mucus.map((m, i) => ({
      id: i + 1,
      date: m.date,
      kind: "mucus" as const,
      mucus: m.quality,
    })),
  ];
  return latestTtcObservations(rows);
}

// ---- The assembled TTC state --------------------------------------------------

// How far back the observation gather reaches. Two-to-three cycles of context — enough
// for the current cycle's rise, the previous cycle's luteal length, and a mucus pattern —
// without dragging a year of readings into every page render.
export const TTC_OBSERVATION_WINDOW_DAYS = 120;

export interface TtcState {
  // The DECLARED start, or null. Null means TTC is simply off for this profile: no
  // surfaces, no window, no counter — the app never infers the intent.
  ttcStart: string | null;
  // Declared AND not suspended. The one boolean the surfaces gate on.
  active: boolean;
  // An ongoing pregnancy (#1402's handoff): TTC tracking stops, the counter freezes at
  // the declared start and is retained for history.
  pregnant: boolean;
  duration: TryingDuration | null;
  window: FertileWindow | null;
  // The CURRENT cycle's sustained BBT rise, if any — retrospective by nature.
  confirmation: OvulationConfirmation | null;
  // The last COMPLETED luteal phase: previous cycle's confirmed ovulation → the period
  // start that followed it. Null until a full confirmed cycle exists.
  lutealDays: number | null;
  observations: TtcObservationWindow;
  // Today's reading per kind, for the entry bar's reflected state.
  todayLh: LhResult | null;
  todayBbtF: number | null;
  todayMucus: MucusQuality | null;
}

// THE TTC gather: the declared start, the profile's own age/pregnancy context, the
// observation window, and every derivation over them. One computation per question,
// assembled once, formatted by whatever renders it.
export function getTtcState(profileId: number, todayStr: string): TtcState {
  const ttcStart = getTtcStart(profileId);
  const pregnant = getRiskAttributes(profileId).pregnant;
  const periods = listCyclePeriods(profileId); // newest first
  const since = shiftDateStr(todayStr, -TTC_OBSERVATION_WINDOW_DAYS);
  const observations = getTtcObservations(profileId, since);

  const forecast = getCycleForecast(profileId, todayStr);
  const window = fertileWindow({
    today: todayStr,
    lhTests: observations.lhTests,
    mucus: observations.mucus,
    calendarOvulation:
      forecast.kind === "forecast" ? forecast.ovulationEstimate : null,
    suspended: pregnant,
  });

  // The current cycle's readings — from the latest recorded period start onward.
  const starts = periods.map((p) => p.period_start).sort();
  const currentStart = [...starts].reverse().find((d) => d <= todayStr) ?? null;
  const inCurrent = currentStart
    ? observations.bbt.filter((r) => r.date >= currentStart)
    : observations.bbt;
  const confirmation = pregnant ? null : confirmOvulation(inCurrent);

  // The previous complete cycle, for the last measured luteal phase.
  let lutealDays: number | null = null;
  if (currentStart) {
    const prevStart = [...starts].reverse().find((d) => d < currentStart);
    if (prevStart) {
      const prevConfirm = confirmOvulation(
        observations.bbt.filter(
          (r) => r.date >= prevStart && r.date < currentStart
        )
      );
      if (prevConfirm) {
        lutealDays = lutealPhaseLengthDays(
          prevConfirm.ovulationDate,
          currentStart
        );
      }
    }
  }

  const latest = latestTtcObservations([
    ...observations.lhTests.map((t, i) => ({
      id: i + 1,
      date: t.date,
      kind: "lh" as const,
      lhResult: t.result,
    })),
    ...observations.bbt.map((t, i) => ({
      id: i + 1,
      date: t.date,
      kind: "bbt" as const,
      degF: t.degF,
    })),
    ...observations.mucus.map((m, i) => ({
      id: i + 1,
      date: m.date,
      kind: "mucus" as const,
      mucus: m.quality,
    })),
  ]);
  const onToday = (o: TtcObservation | undefined) =>
    o && o.date === todayStr ? o : undefined;

  return {
    ttcStart,
    active: ttcStart != null && !pregnant,
    pregnant,
    duration: ttcStart ? tryingDuration(ttcStart, todayStr, starts) : null,
    window,
    confirmation,
    lutealDays,
    observations,
    todayLh: onToday(latest.get("lh"))?.lhResult ?? null,
    todayBbtF: onToday(latest.get("bbt"))?.degF ?? null,
    todayMucus: onToday(latest.get("mucus"))?.mucus ?? null,
  };
}
