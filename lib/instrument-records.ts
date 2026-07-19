// Mental-health instrument SCORE write core + reads (issue #716). AUTH-BLIND and
// profileId-first — no lib/auth import (the calling Server Action is the only auth
// boundary). The instrument SCORE is a biomarker-shaped `medical_records` row (the
// observation substrate, #860/#944); the per-item answers live in `instrument_responses`.
//
// SENSITIVITY (decided, #716): this write NEVER touches `activities`, so it is
// structurally invisible to the milestone/streak machinery (gatherMilestoneInput reads
// activities/streak/doses/goals) — the "never gamify a depression score" law is enforced
// by construction, pinned by lib/__db_tests__/mental-health-milestone-exemption.test.ts.

import { db, writeTx } from "./db";
import { reconcileFlags } from "./queries/medical";
import {
  type Instrument,
  type SeverityBand,
  type CrisisDecision,
  INSTRUMENTS,
  instrumentDef,
  isInstrument,
  severityBand,
  crisisDecision,
} from "./mental-health";
import {
  type SubstanceInstrument,
  SUBSTANCE_INSTRUMENTS,
  substanceInstrumentDef,
  substanceSeverityBand,
} from "./substance-use";

// The instrument write core serves BOTH catalogs (#716 mental-health, #998
// substance-use): one biomarker-shaped medical_records row + per-item
// instrument_responses, regardless of which catalog defines the items/bands.
// Crisis handling stays STRICTLY mental-health (substance scores never escalate
// to the crisis surface — #996 is item-9/explicit only).
export type AnyInstrument = Instrument | SubstanceInstrument;

// The canonical_name a score is stored under, resolved across both catalogs.
function canonicalNameFor(instrument: AnyInstrument): string {
  return isInstrument(instrument)
    ? instrumentDef(instrument).canonicalName
    : substanceInstrumentDef(instrument).canonicalName;
}

// One answered item (0-based index → answer), as captured by the in-app tap-through.
// Mental-health items answer 0..3; AUDIT-C items answer 0..4 (the calling action
// validates against the instrument's own option set).
export interface InstrumentAnswer {
  itemIndex: number;
  answer: number;
}

export interface RecordInstrumentInput {
  instrument: AnyInstrument;
  date: string; // YYYY-MM-DD (the administration/observed date)
  total: number; // the summed score
  // Per-item answers (in-app administration). Empty/omitted for an OUTSIDE total-only
  // score — item-9 handling then degrades to total-only (rests on the severe total).
  answers?: InstrumentAnswer[];
  notes?: string | null;
}

// Record ONE instrument score for a profile: a biomarker `medical_records` row plus its
// per-item answers, in one IMMEDIATE transaction. Returns the new record id.
export function recordInstrumentScore(
  profileId: number,
  input: RecordInstrumentInput
): number {
  const canonicalName = canonicalNameFor(input.instrument);
  return writeTx(() => {
    const info = db
      .prepare(
        `INSERT INTO medical_records
           (date, category, name, value, value_num, unit, reference_range, notes, canonical_name, profile_id)
         VALUES (?, 'biomarker', ?, ?, ?, NULL, NULL, ?, ?, ?)`
      )
      .run(
        input.date,
        canonicalName,
        String(input.total),
        input.total,
        input.notes?.trim() || null,
        canonicalName,
        profileId
      );
    const recordId = Number(info.lastInsertRowid);
    const answers = input.answers ?? [];
    if (answers.length > 0) {
      const insAnswer = db.prepare(
        `INSERT INTO instrument_responses (profile_id, medical_record_id, item_index, answer)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(medical_record_id, item_index) DO UPDATE SET answer = excluded.answer`
      );
      for (const a of answers) {
        insAnswer.run(profileId, recordId, a.itemIndex, a.answer);
      }
    }
    // Reconcile the flag for consistency with every other biomarker write. These
    // instruments carry NO canonical range, so this is a no-op (flag stays null — the
    // severity band, not a MedicalFlag, is the on-screen signal; see lib/mental-health).
    reconcileFlags(profileId, [recordId]);
    return recordId;
  });
}

// One stored score reading, with its derived band. `selfHarmAnswer` is the item-9 answer
// (PHQ-9) when the reading has stored item-level answers, else null (total-only reading).
export interface InstrumentReading {
  id: number;
  instrument: Instrument;
  date: string;
  total: number;
  band: SeverityBand;
  selfHarmAnswer: number | null;
}

const INSTRUMENT_NAMES = INSTRUMENTS as readonly string[];

// The self-harm-item answer for a set of record ids, keyed by record id. Only records with
// stored item answers appear; a total-only record is absent (→ null selfHarmAnswer).
function selfHarmAnswersByRecord(
  profileId: number,
  recordIds: number[]
): Map<number, number> {
  const out = new Map<number, number>();
  if (recordIds.length === 0) return out;
  // Build the (instrument → self-harm item index) filter as a small OR set. Only PHQ-9 has
  // a self-harm item today; GAD-7's index is null and contributes nothing.
  const placeholders = recordIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ir.medical_record_id AS rid, ir.item_index AS idx, ir.answer AS answer,
              mr.canonical_name AS canon
       FROM instrument_responses ir
       JOIN medical_records mr ON mr.id = ir.medical_record_id AND mr.profile_id = ir.profile_id
       WHERE ir.profile_id = ? AND ir.medical_record_id IN (${placeholders})`
    )
    .all(profileId, ...recordIds) as {
    rid: number;
    idx: number;
    answer: number;
    canon: string | null;
  }[];
  for (const r of rows) {
    const inst = INSTRUMENTS.find((k) => k === r.canon);
    if (!inst) continue;
    const shIdx = instrumentDef(inst).selfHarmItemIndex;
    if (shIdx != null && r.idx === shIdx) out.set(r.rid, r.answer);
  }
  return out;
}

// All stored instrument readings for a profile, newest-first, with band + self-harm answer.
export function getInstrumentReadings(profileId: number): InstrumentReading[] {
  const rows = db
    .prepare(
      `SELECT id, canonical_name AS canon, date, value_num AS total
       FROM medical_records
       WHERE profile_id = ? AND canonical_name IN (${INSTRUMENT_NAMES.map(() => "?").join(",")})
         AND value_num IS NOT NULL
       ORDER BY date DESC, id DESC`
    )
    .all(profileId, ...INSTRUMENT_NAMES) as {
    id: number;
    canon: string;
    date: string;
    total: number;
  }[];
  const shByRecord = selfHarmAnswersByRecord(
    profileId,
    rows.map((r) => r.id)
  );
  const out: InstrumentReading[] = [];
  for (const r of rows) {
    const inst = INSTRUMENTS.find((k) => k === r.canon);
    if (!inst) continue;
    out.push({
      id: r.id,
      instrument: inst,
      date: r.date,
      total: r.total,
      band: severityBand(inst, r.total),
      selfHarmAnswer: shByRecord.get(r.id) ?? null,
    });
  }
  return out;
}

// ---- Substance-use instrument readings (#998) ------------------------------

// One stored substance-instrument score with its derived band. No self-harm/crisis
// dimension by design: substance scores NEVER touch the crisis machinery (#996 is
// item-9/explicit only) — a high score gets only the calm on-surface note.
export interface SubstanceInstrumentReading {
  id: number;
  instrument: SubstanceInstrument;
  date: string;
  total: number;
  band: SeverityBand;
}

const SUBSTANCE_INSTRUMENT_NAMES = SUBSTANCE_INSTRUMENTS as readonly string[];

// All stored substance-instrument readings for a profile, newest-first, banded.
export function getSubstanceInstrumentReadings(
  profileId: number
): SubstanceInstrumentReading[] {
  const rows = db
    .prepare(
      `SELECT id, canonical_name AS canon, date, value_num AS total
       FROM medical_records
       WHERE profile_id = ? AND canonical_name IN (${SUBSTANCE_INSTRUMENT_NAMES.map(() => "?").join(",")})
         AND value_num IS NOT NULL
       ORDER BY date DESC, id DESC`
    )
    .all(profileId, ...SUBSTANCE_INSTRUMENT_NAMES) as {
    id: number;
    canon: string;
    date: string;
    total: number;
  }[];
  const out: SubstanceInstrumentReading[] = [];
  for (const r of rows) {
    const inst = SUBSTANCE_INSTRUMENTS.find((k) => k === r.canon);
    if (!inst) continue;
    out.push({
      id: r.id,
      instrument: inst,
      date: r.date,
      total: r.total,
      band: substanceSeverityBand(inst, r.total),
    });
  }
  return out;
}

// The latest reading per instrument (or null when none), with its crisis decision. Used by
// the instrument surface AND the care-tier crisis builder — ONE computation both share.
export interface InstrumentState {
  instrument: Instrument;
  latest: InstrumentReading | null;
  crisis: CrisisDecision | null;
}

export function getInstrumentStates(profileId: number): InstrumentState[] {
  const readings = getInstrumentReadings(profileId);
  return INSTRUMENTS.map((inst) => {
    const latest = readings.find((r) => r.instrument === inst) ?? null;
    const crisis = latest
      ? crisisDecision(
          inst,
          latest.total,
          latest.selfHarmAnswer != null
            ? {
                [instrumentDef(inst).selfHarmItemIndex ?? -1]:
                  latest.selfHarmAnswer,
              }
            : {}
        )
      : null;
    return { instrument: inst, latest, crisis };
  });
}

// The stored per-item answers for one record (0-based index → answer), for the detail view.
export function getInstrumentResponses(
  profileId: number,
  medicalRecordId: number
): Record<number, number> {
  const rows = db
    .prepare(
      `SELECT item_index AS idx, answer FROM instrument_responses
       WHERE profile_id = ? AND medical_record_id = ?
       ORDER BY item_index`
    )
    .all(profileId, medicalRecordId) as { idx: number; answer: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.idx] = r.answer;
  return out;
}
