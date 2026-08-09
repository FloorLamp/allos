// Audiogram WRITE CORE + reads (issue #1600). AUTH-BLIND and profileId-first — no
// lib/auth import; the calling Server Action is the only auth boundary. The sibling of
// lib/instrument-records.ts, which does the same job for screening-instrument scores.
//
// STORE: `medical_records`, category `vitals`, one row per (ear, frequency) under the
// canonical analyte names lib/canonical-biomarkers.json already curates for the
// `hearing` panel. The full justification for reusing that store rather than minting an
// `audiograms` table lives at the top of lib/audiogram.ts — read it there; it is the
// decision this issue turned on, and it is why this change ships NO migration.
//
// SHARED OBSERVATION SUBSTRATE (AGENTS.md "Observation-shaped data" / #944) — all three
// pieces are used here, on the paths that need them:
//   • isEditLocked   — the upsert consults the `edited` lock through the shared helper,
//                      so a re-ingest can never silently revert a hand-corrected
//                      threshold. A MANUAL save (the entry form) is the user, so it
//                      passes origin "manual" and writes through the lock — and, like
//                      every other manual medical_records edit, SETS the lock on an
//                      integration-owned row (external_id IS NOT NULL) so the next
//                      rolling window doesn't undo the correction (#133).
//   • classifyUpsert / tallyUpsert — the inserted/updated/unchanged split for a saved
//                      audiogram, so re-saving the same date is honestly reported as
//                      "unchanged" instead of looking like a fresh write. The Server
//                      Action renders this typed outcome.
//   • latestByGroup  — reached through currentThresholds() in the pure module, keyed on
//                      the domain identity audiogramSeriesKey.

import { db, writeTx } from "./db";
import { reconcileFlags } from "./queries/medical";
import { cleanupOrphanBiomarkerKeyedState } from "./queries/upcoming/suppressions";
import {
  classifyUpsert,
  emptyCounts,
  isEditLocked,
  tallyUpsert,
  type UpsertCounts,
} from "./integrations/sync-log";
import {
  AUDIOGRAM_CANONICAL_NAMES,
  NORMAL_THRESHOLD_DB_HL,
  PTA_CANONICAL_NAMES,
  audiogramAnalyteName,
  groupAudiogramReadings,
  hearingBaselineFromReadings,
  parseAudiogramAnalyte,
  parsePtaAnalyte,
  type Audiogram,
  type AudiogramEar,
  type AudiogramFrequencyHz,
  type AudiogramReading,
  type HearingBaseline,
  type ReportedPta,
} from "./audiogram";

// The unit and printed reference range every threshold row carries — the same strings
// the seed and the canonical dataset use, so a manually entered reading is
// indistinguishable from an imported one on every downstream surface.
export const AUDIOGRAM_UNIT = "dB HL";
export const AUDIOGRAM_REFERENCE_RANGE = `≤${NORMAL_THRESHOLD_DB_HL} dB HL`;
// `panel` on the row — matches the `hearing` panel key in lib/biomarker-panels.ts.
const AUDIOGRAM_PANEL = "hearing";

const NAME_PLACEHOLDERS = AUDIOGRAM_CANONICAL_NAMES.map(() => "?").join(",");
const PTA_NAME_PLACEHOLDERS = PTA_CANONICAL_NAMES.map(() => "?").join(",");
// Every canonical name this domain owns — thresholds AND reported pure-tone averages
// (#2322). The preimage for the "does this profile have any hearing data" probe and
// for the delete that removes one dated test, so both stay one question.
const HEARING_CANONICAL_NAMES: readonly string[] = [
  ...AUDIOGRAM_CANONICAL_NAMES,
  ...PTA_CANONICAL_NAMES,
];
const HEARING_NAME_PLACEHOLDERS = HEARING_CANONICAL_NAMES.map(() => "?").join(
  ","
);

// ---- Reads ------------------------------------------------------------------

// Every stored pure-tone threshold for a profile, newest first. The finite canonical
// preimage is the SQL filter (#394 — SQL can't call parseAudiogramAnalyte); the parse
// is the belt that turns a row back into (ear, frequency).
export function getAudiogramReadings(profileId: number): AudiogramReading[] {
  const rows = db
    .prepare(
      `SELECT id, date, canonical_name AS canon, value_num AS db_hl, notes, flag
         FROM medical_records
        WHERE profile_id = ?
          AND canonical_name IN (${NAME_PLACEHOLDERS})
          AND value_num IS NOT NULL
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, ...AUDIOGRAM_CANONICAL_NAMES) as {
    id: number;
    date: string;
    canon: string;
    db_hl: number;
    notes: string | null;
    flag: string | null;
  }[];
  const out: AudiogramReading[] = [];
  for (const r of rows) {
    const parsed = parseAudiogramAnalyte(r.canon);
    if (!parsed) continue;
    out.push({
      id: r.id,
      date: r.date,
      ear: parsed.ear,
      hz: parsed.hz,
      dbHl: r.db_hl,
      notes: r.notes,
      flag: r.flag,
    });
  }
  return out;
}

// Every REPORTED pure-tone average for a profile, newest first (#2322) — the averages
// a document stated directly, with no per-frequency thresholds behind them. Same shape
// as the threshold reader: a finite canonical preimage in SQL, parsePtaAnalyte as the
// belt that turns a row back into (ear, conduction).
export function getReportedPtaReadings(profileId: number): ReportedPta[] {
  const rows = db
    .prepare(
      `SELECT id, date, canonical_name AS canon, value_num AS db_hl, notes, flag
         FROM medical_records
        WHERE profile_id = ?
          AND canonical_name IN (${PTA_NAME_PLACEHOLDERS})
          AND value_num IS NOT NULL
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, ...PTA_CANONICAL_NAMES) as {
    id: number;
    date: string;
    canon: string;
    db_hl: number;
    notes: string | null;
    flag: string | null;
  }[];
  const out: ReportedPta[] = [];
  for (const r of rows) {
    const parsed = parsePtaAnalyte(r.canon);
    if (!parsed) continue;
    out.push({
      id: r.id,
      date: r.date,
      ear: parsed.ear,
      conduction: parsed.conduction,
      dbHl: r.db_hl,
      notes: r.notes,
      flag: r.flag,
    });
  }
  return out;
}

// The profile's dated audiograms, newest first — what the Hearing surface renders.
// Thresholds and reported averages are grouped onto the same dates, so a document that
// reported only an average still lists as a hearing test (#2322).
export function getAudiograms(profileId: number): Audiogram[] {
  return groupAudiogramReadings(
    getAudiogramReadings(profileId),
    getReportedPtaReadings(profileId)
  );
}

// The hearing baseline a medication-safety note cites, or null when the profile has no
// audiogram at all. The ONE gather behind the ototoxic crosscheck's baseline citation.
export function getHearingBaseline(profileId: number): HearingBaseline | null {
  return hearingBaselineFromReadings(getAudiogramReadings(profileId));
}

// Whether the profile has any recorded hearing measurement — a threshold OR a reported
// pure-tone average (#2322; a summary report that carried only averages must not leave
// the Hearing pane looking empty). The cheap EXISTS probe the nav relevance gather
// uses. Deliberately not `getAudiogramReadings(...).length > 0`: this runs on every
// layout render.
export function hasAudiogramRows(profileId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM medical_records
          WHERE profile_id = ? AND canonical_name IN (${HEARING_NAME_PLACEHOLDERS})
          LIMIT 1`
      )
      .get(profileId, ...HEARING_CANONICAL_NAMES) != null
  );
}

// ---- Write ------------------------------------------------------------------

export interface AudiogramThresholdInput {
  ear: AudiogramEar;
  hz: AudiogramFrequencyHz;
  dbHl: number;
}

export interface RecordAudiogramInput {
  date: string; // YYYY-MM-DD (the test date)
  thresholds: AudiogramThresholdInput[];
  notes?: string | null;
}

// Typed outcome — the markDoseTaken pattern: a save that can legitimately do nothing
// says so, and the caller renders it rather than confirming unconditionally.
export type RecordAudiogramOutcome =
  | { kind: "saved"; counts: UpsertCounts; recordIds: number[] }
  // Every field was blank: nothing to store. NOT an error — an empty submit is a
  // user changing their mind, and inventing 12 null readings would be worse.
  | { kind: "no-thresholds" };

// Where a set of thresholds came from. "manual" is the entry form (the user IS the
// authority — it writes through the edit lock); "sync" is the future audiometry
// import path, which must respect a hand-corrected row (#133).
export type AudiogramOrigin = "manual" | "sync";

// Record ONE dated audiogram: an upsert per (ear, frequency) on the natural key
// (profile_id, canonical_name, date), all inside one IMMEDIATE transaction, then the
// standard flag reconcile every biomarker write does. Re-saving the same date corrects
// that audiogram in place rather than stacking a duplicate — which is what makes the
// insert/update/unchanged accounting meaningful.
export function recordAudiogram(
  profileId: number,
  input: RecordAudiogramInput,
  origin: AudiogramOrigin = "manual"
): RecordAudiogramOutcome {
  const thresholds = input.thresholds.filter((t) => Number.isFinite(t.dbHl));
  if (thresholds.length === 0) return { kind: "no-thresholds" };
  const notes = input.notes?.trim() || null;

  return writeTx((): RecordAudiogramOutcome => {
    const counts = emptyCounts();
    const recordIds: number[] = [];
    const find = db.prepare(
      `SELECT id, value_num AS db_hl, notes, edited, external_id
         FROM medical_records
        WHERE profile_id = ? AND canonical_name = ? AND date = ?
        ORDER BY id LIMIT 1`
    );
    const ins = db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit,
          reference_range, notes, canonical_name, panel, source)
       VALUES (?, ?, 'vitals', ?, ?, ?, ?, ?, ?, ?, ?, 'Audiogram')`
    );
    const upd = db.prepare(
      `UPDATE medical_records
          SET value = ?, value_num = ?, unit = ?, reference_range = ?, notes = ?,
              panel = ?,
              -- Lock an integration-imported row against re-ingest once a person has
              -- corrected it by hand (#133) — the same CASE the biomarker editor uses.
              -- A manual/document row (external_id NULL) is unaffected.
              edited = CASE WHEN external_id IS NOT NULL THEN 1 ELSE edited END
        WHERE id = ? AND profile_id = ?`
    );

    for (const t of thresholds) {
      const canonical = audiogramAnalyteName(t.ear, t.hz);
      const found = find.get(profileId, canonical, input.date) as
        | {
            id: number;
            db_hl: number | null;
            notes: string | null;
            edited: number | null;
            external_id: string | null;
          }
        | undefined;

      // The user-edit lock (#133), consulted ONLY through the shared helper. A sync
      // must not overwrite a hand-corrected threshold; a manual save is the person
      // themself, so it writes through.
      if (found && origin === "sync" && isEditLocked(found.edited)) {
        counts.edited++;
        continue;
      }

      const unchanged =
        found != null &&
        found.db_hl === t.dbHl &&
        (found.notes ?? null) === notes;
      // The ONE dedup classification (#14/#944) — never a hand-rolled counter bump.
      tallyUpsert(counts, classifyUpsert(found != null, unchanged));

      if (!found) {
        const info = ins.run(
          profileId,
          input.date,
          canonical,
          String(t.dbHl),
          t.dbHl,
          AUDIOGRAM_UNIT,
          AUDIOGRAM_REFERENCE_RANGE,
          notes,
          canonical,
          AUDIOGRAM_PANEL
        );
        recordIds.push(Number(info.lastInsertRowid));
      } else {
        if (!unchanged) {
          upd.run(
            String(t.dbHl),
            t.dbHl,
            AUDIOGRAM_UNIT,
            AUDIOGRAM_REFERENCE_RANGE,
            notes,
            AUDIOGRAM_PANEL,
            found.id,
            profileId
          );
        }
        recordIds.push(found.id);
      }
    }

    // Derive the out-of-range flag from the canonical ≤25 dB HL band, exactly as an
    // imported reading would — so a manually entered 40 dB HL at 4 kHz flags too.
    reconcileFlags(profileId, recordIds);
    return { kind: "saved", counts, recordIds };
  });
}

export type DeleteAudiogramOutcome =
  { kind: "deleted"; removed: number } | { kind: "not-found" };

// Remove ONE dated audiogram — every threshold row AND every reported pure-tone
// average this profile has on that date (#2322: the card renders both, so Delete must
// remove both; leaving the average behind would resurrect the card with half its
// content). Guarded to the canonical hearing analytes so it can never be pointed at an
// unrelated reading. No undo capture: the shared undo substrate is single-ROOT
// (captureDelete takes one row id), and an audiogram is up to twelve peer rows, so
// twelve independent undo entries would be a worse affordance than the confirm-first
// dialog the surface uses. The name-keyed side-state sweep still runs — deleting the
// last reading of a starred/snoozed analyte must not leave the star pointing at
// nothing (#203/#327).
export function deleteAudiogram(
  profileId: number,
  date: string
): DeleteAudiogramOutcome {
  const removed = writeTx((): number => {
    const info = db
      .prepare(
        `DELETE FROM medical_records
          WHERE profile_id = ? AND date = ?
            AND canonical_name IN (${HEARING_NAME_PLACEHOLDERS})`
      )
      .run(profileId, date, ...HEARING_CANONICAL_NAMES);
    return info.changes;
  });
  if (removed === 0) return { kind: "not-found" };
  cleanupOrphanBiomarkerKeyedState(profileId);
  return { kind: "deleted", removed };
}
