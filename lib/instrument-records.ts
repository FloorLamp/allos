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
import { captureDelete } from "./undo-delete-db";
import { reconcileFlags } from "./queries/medical";
import { isMinor } from "./life-stage";
import { getProfileAge } from "./settings";
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

// ---- #1279's life-stage gate, enforced HERE (issue #2107) -------------------
//
// #1174 gated the substance-use SURFACE to adults; #1279 closed the gap under it,
// because a Server Action is independently POST-callable and "a UI-only gate is
// theater if the write core underneath has no independent check". It put that check
// in every substance-use action.
//
// The hole (#2107): this module's cores are SHARED with the mental-health surface,
// and update/delete RESOLVE their instrument from the targeted ROW. So posting the
// mental-health twins with a substance-instrument row id reached the very scores
// #1279 refuses to touch — the gate reopened one module over, through the shared
// resolver. Narrowing the two mental-health actions to their own family would have
// closed today's two callers and left the next one to rediscover it.
//
// So the refusal lives at the gate instead: every write core below asks this ONE
// question about the instrument it ends up operating on, whichever surface called
// it. That is a life-stage CONTENT policy, not an authorization check — the module
// stays auth-blind (no lib/auth import, profileId still first) and the write-access
// gate remains the calling action's job. Mental-health instruments are not adult-only
// and pass unconditionally; a substance instrument refuses for a KNOWN minor, and an
// unknown or adult age passes (lib/life-stage's documented "hide only on a positive
// under-age match" policy, the same line the surface and the actions use).
//
// The substance actions keep their own copies: they answer sooner and with the
// surface's own wording. They are now defense in depth over a real gate rather than
// the only gate. lib/adult-only-writes.ts registers this module so a new mutating
// export that skips the call fails CI.
export function adultOnlyRefusal(
  profileId: number,
  instrument: AnyInstrument
): boolean {
  if (isInstrument(instrument)) return false;
  return isMinor(getProfileAge(profileId));
}

// The instrument's maximum possible total, resolved across BOTH catalogs — the one
// place a correction action asks "is this total in range?" so the mental-health and
// substance-use surfaces can't drift apart on the same question (#1396).
export function instrumentMaxTotal(instrument: AnyInstrument): number {
  return isInstrument(instrument)
    ? instrumentDef(instrument).maxTotal
    : substanceInstrumentDef(instrument).maxTotal;
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

// Record ONE instrument score for a profile: an `instrument`-category `medical_records`
// row (#1076) plus its per-item answers, in one IMMEDIATE transaction. Returns the new
// id, or `null` when the life-stage gate refuses the instrument (#2107) — the same
// "there is nothing here for this profile" answer the row-resolving cores give.
export function recordInstrumentScore(
  profileId: number,
  input: RecordInstrumentInput
): number | null {
  if (adultOnlyRefusal(profileId, input.instrument)) return null;
  const canonicalName = canonicalNameFor(input.instrument);
  return writeTx(() => {
    // category 'instrument' (#1076): a screening-instrument total scores onto its
    // own class, NOT the general lab bucket — so it joins the instrument series and
    // can never leak into /results/readings or the flagged hero.
    const info = db
      .prepare(
        `INSERT INTO medical_records
           (date, category, name, value, value_num, unit, reference_range, notes, canonical_name, profile_id)
         VALUES (?, 'instrument', ?, ?, ?, NULL, NULL, ?, ?, ?)`
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

// ---- Correcting a recorded score (#1396) ------------------------------------
//
// A screening score used to be CREATE-ONLY, and that was a safety bug, not a missing
// nicety: every score trends like a biomarker, and a severe total (or a positive PHQ-9
// item 9) raises the NON-DISMISSIBLE crisis line. So a fat-fingered outside total — a
// GAD-7 of 21 typed for 12 — permanently distorted the trend AND could permanently trip
// a banner with no recovery path. Correction and removal live here, in the same
// auth-blind, profileId-first core as the write (#319); the calling Server Action is the
// only auth boundary.
//
// The derived state needs no invalidation step: getInstrumentStates / the crisis gate
// read the stored rows every time (ONE computation), so correcting or removing the row
// IS the recompute — a corrected sub-threshold score releases the banner by construction.

// The set of canonical_names that are instrument SCORES, across both catalogs. Used to
// prove a targeted row really is a score before editing/deleting it, so this path can
// never be pointed at an arbitrary lab reading (which has its own delete with its own
// star/retest side-state sweep).
const ALL_INSTRUMENT_NAMES: readonly string[] = [
  ...INSTRUMENTS,
  ...SUBSTANCE_INSTRUMENTS,
] as readonly string[];

function instrumentForName(canon: string | null): AnyInstrument | null {
  if (!canon) return null;
  const mh = INSTRUMENTS.find((k) => k === canon);
  if (mh) return mh;
  return SUBSTANCE_INSTRUMENTS.find((k) => k === canon) ?? null;
}

// The instrument a stored score belongs to, or null when the id isn't this profile's
// instrument score at all. Lets an action validate a submitted total against the RIGHT
// instrument's maxTotal without duplicating the identity rule.
export function getInstrumentScoreInstrument(
  profileId: number,
  id: number
): AnyInstrument | null {
  const row = db
    .prepare(
      `SELECT canonical_name AS canon FROM medical_records
        WHERE id = ? AND profile_id = ? AND category = 'instrument'`
    )
    .get(id, profileId) as { canon: string | null } | undefined;
  return row ? instrumentForName(row.canon) : null;
}

// Typed outcome for an edit that can legitimately refuse (the markDoseTaken pattern) —
// callers render it, never confirm unconditionally.
export type UpdateInstrumentOutcome =
  | { kind: "updated" }
  | { kind: "not-found" }
  // The reading was administered in-app, so its total is DERIVED from the stored item
  // answers (the server-side source of truth the record path enforces). Letting the
  // total be typed over would make the score disagree with the answers that produced it
  // — and with item 9, which the crisis gate reads. The date is still editable; a wrong
  // administered score is corrected by deleting it and re-answering.
  | { kind: "answers-derived"; itemCount: number };

export interface UpdateInstrumentInput {
  date: string; // YYYY-MM-DD
  total: number;
}

// Correct ONE stored score's date and/or total. Refuses a TOTAL change on an
// administered reading (see above); a date-only change is always allowed.
export function updateInstrumentScore(
  profileId: number,
  id: number,
  input: UpdateInstrumentInput
): UpdateInstrumentOutcome {
  return writeTx((): UpdateInstrumentOutcome => {
    const row = db
      .prepare(
        `SELECT canonical_name AS canon, value_num AS total FROM medical_records
          WHERE id = ? AND profile_id = ? AND category = 'instrument'
            AND canonical_name IN (${ALL_INSTRUMENT_NAMES.map(() => "?").join(",")})`
      )
      .get(id, profileId, ...ALL_INSTRUMENT_NAMES) as
      { canon: string | null; total: number | null } | undefined;
    const resolved = row ? instrumentForName(row.canon) : null;
    if (!row || resolved == null) return { kind: "not-found" };
    // #2107: the instrument comes from the ROW, so this is where a caller from the
    // other family lands. A gate-refused instrument is answered exactly as an
    // unknown row is — the substance surface's own minor path returns the same.
    if (adultOnlyRefusal(profileId, resolved)) return { kind: "not-found" };

    const answered = db
      .prepare(
        `SELECT COUNT(*) AS n FROM instrument_responses
          WHERE profile_id = ? AND medical_record_id = ?`
      )
      .get(profileId, id) as { n: number };
    const totalChanged = Number(row.total) !== input.total;
    if (answered.n > 0 && totalChanged)
      return { kind: "answers-derived", itemCount: answered.n };

    db.prepare(
      `UPDATE medical_records SET date = ?, value = ?, value_num = ?
        WHERE id = ? AND profile_id = ?`
    ).run(input.date, String(input.total), input.total, id, profileId);
    // Reconcile the flag exactly as the record path does — a no-op for these
    // rangeless instruments, but the biomarker write contract stays uniform.
    reconcileFlags(profileId, [id]);
    return { kind: "updated" };
  });
}

export type DeleteInstrumentOutcome =
  { kind: "deleted"; undoId: number | null } | { kind: "not-found" };

// Remove ONE stored score. Goes through the SHARED undo capture (#30) under the
// existing `biomarker-record` kind — the score IS a medical_records row — so a
// mis-tapped delete is recoverable from the toast, and the capture brings the item
// answers back with it (the instrument_responses child entity registered in
// lib/undo-delete.ts). Guarded to instrument-category rows so it can never be pointed
// at a lab reading, whose delete owns extra star/retest side-state sweeps.
export function deleteInstrumentScore(
  profileId: number,
  id: number
): DeleteInstrumentOutcome {
  const resolved = getInstrumentScoreInstrument(profileId, id);
  if (resolved == null) return { kind: "not-found" };
  // #2107: same gate, same answer as update — the row names the instrument, so the
  // refusal cannot depend on which surface reached this core.
  if (adultOnlyRefusal(profileId, resolved)) return { kind: "not-found" };
  const undoId = captureDelete("biomarker-record", profileId, id);
  return undoId == null ? { kind: "not-found" } : { kind: "deleted", undoId };
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
  documentId: number | null;
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
      `SELECT id, canonical_name AS canon, date, value_num AS total, document_id
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
    document_id: number | null;
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
      documentId: r.document_id,
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
  documentId: number | null;
}

const SUBSTANCE_INSTRUMENT_NAMES = SUBSTANCE_INSTRUMENTS as readonly string[];

// All stored substance-instrument readings for a profile, newest-first, banded.
export function getSubstanceInstrumentReadings(
  profileId: number
): SubstanceInstrumentReading[] {
  const rows = db
    .prepare(
      `SELECT id, canonical_name AS canon, date, value_num AS total, document_id
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
    document_id: number | null;
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
      documentId: r.document_id,
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
  observationId: number
): Record<number, number> {
  const rows = db
    .prepare(
      `SELECT item_index AS idx, answer FROM instrument_responses
       WHERE profile_id = ? AND medical_record_id = ?
       ORDER BY item_index`
    )
    .all(profileId, observationId) as { idx: number; answer: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.idx] = r.answer;
  return out;
}
