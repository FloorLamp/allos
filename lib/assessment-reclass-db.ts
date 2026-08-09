// The DB half of #2318: re-home the CCD observations already stored as `lab` rows
// that were never measurements, and clean up everything that took a NAME from them.
//
// Forward-only would not be enough. The parse fix stops the next import from minting
// these rows, but every database that already imported a CCD keeps its
// "Functional status" / questionnaire-item / "Lot Number" / "Expiration Date" rows
// forever — each with an ai-coined `canonical_biomarkers` entry, a permanent slot
// under Data → Coverage → Uncatalogued items, and a bandless series. So this is a
// one-shot data move, run from migration 177 (AGENTS.md: "Put one-shot data moves in
// a migration, not a settings flag"), the same shape #2306's pass took.
//
// It takes an explicit handle rather than the lib/db singleton because a migration
// runs before that singleton exists, and it assumes the caller has already opened a
// transaction (the runner wraps every up() in an IMMEDIATE one).
//
// WHICH ROWS. Only rows that are ALL of:
//   • category = 'lab' — the class the defect put them in;
//   • external_id LIKE 'ccda:obs:%' — the generic CCD observation mapper's own key
//     prefix, named in the issue. A manually entered lab, a FHIR reading and a
//     `ccda:vital:` row are all out of reach by construction;
//   • isNonAnalyteObservation — the SAME pure predicate the mapper now routes on: no
//     numeric value, no unit, no stated reference range, and no LOINC.
//
// A stored row has no memory of its C-CDA templateIds, so the `assessmentScale` leg
// of that predicate cannot fire here: a questionnaire item that kept a survey LOINC
// is deliberately LEFT ALONE. A LOINC is evidence of analyte identity, and
// re-categorising on a guess would be the mirror of the bug — hiding a genuine
// qualitative lab, whose shape ("Positive", "Detected", a blood type) is otherwise
// identical. The rows the issue actually found all lost their code already
// (functionalStatusExtractor nulls it) or never had one; a LOINC-carrying item that
// survives this pass is re-classified the next time its document is REPROCESSED,
// where the templateId is readable again.
//
// A vaccine LOT NUMBER / EXPIRY row already on disk is re-categorised here rather
// than DELETED, even though the mapper now refuses to emit one at all. Deleting is a
// bigger claim than the issue makes: `medical_records` is an FK parent (care-plan
// follow-ups, instrument responses, undo tombstones all reach rows by id), the row is
// honest provenance of what the document printed, and the acceptance criterion is
// about biomarker IDENTITY, which the category withholds either way. A reprocess of
// that document converges the last step by re-importing without the row.
//
// WHAT ELSE TOOK A NAME FROM THEM (the AGENTS.md row-ops checklist, enumerated for
// this domain rather than assumed). A name is "lost" for a profile once no
// identity-carrying record of that profile still uses it:
//   1. medical_records.category — the rows themselves, plus their `flag`, which the
//      mapper no longer derives for an assessment (a non-measurement is not in or out
//      of a band). `name`/`canonical_name` are PROVENANCE and stay: the row still
//      says what the document called it, and the category is what withholds identity.
//   2. canonical_biomarkers — the ai-coined vocabulary row. Checked GLOBALLY (the
//      table is a global reference table) and only ever `source = 'ai'`; a curated
//      row is untouchable, exactly as in the #2306 pass.
//   3. saved_items (kind='biomarker') — the ★ pin on a name that can no longer chart.
//   4. upcoming_dismissals — the retest snooze `biomarker:<family>` and the
//      flagged-result acknowledgment `biomarker-flag:<family>`. Both are FAMILY keys,
//      so one is dropped only when no surviving identity-carrying name of that
//      profile derives it.
//   5. coverage_gaps (kind='biomarker') — the tracked "not in the catalog" gap. Left
//      behind it is a phantom forever: its covered-check re-derives from the key, and
//      the key names something nobody has a reading for.
//
// Deliberately NOT touched, with reasons:
//   • goals.biomarker_name and protocols.outcome_keys — USER-AUTHORED links, and the
//     row they point at still exists and is still viewable. #2306 re-pointed them
//     because a rename kept a live target; there is no target to re-point to here,
//     and silently deleting someone's goal or protocol outcome is a bigger claim than
//     this issue makes. Same posture as cleanupOrphanBiomarkerKeyedState, which
//     sweeps saves and dismissals and leaves goals/protocols alone.
//   • medical_documents and the uploaded files — nothing is keyed on an analyte name,
//     and the source document stays stored and viewable. That is the whole point.
//   • the undo holding table's captured delete payload — restoring a row must replay
//     exactly what was deleted (the #2306 reasoning, unchanged).

import type Database from "better-sqlite3";
import { biomarkerCoverageKey } from "./coverage-gaps";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
} from "./dismissal-keys";
import { NON_IDENTITY_CATEGORIES } from "./medical-categories";
import { isNonAnalyteObservation } from "./non-analyte-observations";

export interface AssessmentReclassReport {
  // medical_records rows moved from `lab` to `assessment`.
  records: number;
  // canonical_biomarkers ai-coined names deleted (global).
  vocabulary: string[];
  // Name-keyed side-state rows dropped.
  savedItems: number;
  dismissals: number;
  coverageGaps: number;
}

interface CandidateRow {
  id: number;
  profile_id: number;
  canonical_name: string | null;
  name: string;
  loinc: string | null;
  value_num: number | null;
  unit: string | null;
  reference_range: string | null;
}

// "the row still carries a biomarker identity" as SQL — the exact statement
// carriesBiomarkerIdentity makes in TypeScript, so the sweep below and
// getUsedCanonicalNames can never disagree about what backs a name.
const IDENTITY_ONLY_SQL = `category NOT IN (${NON_IDENTITY_CATEGORIES.map(
  () => "?"
).join(",")})`;

function profileIds(db: Database.Database): number[] {
  return (
    db.prepare("SELECT id FROM profiles ORDER BY id").all() as { id: number }[]
  ).map((r) => r.id);
}

// One profile's CCD generic-observation rows, stored as labs, that state no
// measurement and claim no analyte identity.
function candidates(db: Database.Database, profileId: number): CandidateRow[] {
  const rows = db
    .prepare(
      `SELECT id, profile_id, canonical_name, name, loinc, value_num, unit, reference_range
         FROM medical_records
        WHERE profile_id = ? AND category = 'lab' AND external_id LIKE 'ccda:obs:%'`
    )
    .all(profileId) as CandidateRow[];
  return rows.filter((r) =>
    isNonAnalyteObservation({
      loinc: r.loinc,
      valueNum: r.value_num,
      unit: r.unit,
      referenceRange: r.reference_range,
    })
  );
}

// The distinct canonical names one profile still uses on rows that DO carry a
// biomarker identity — the survivors that keep a name (and its family keys) alive.
function survivingNames(db: Database.Database, profileId: number): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT canonical_name AS n FROM medical_records
          WHERE profile_id = ? AND TRIM(COALESCE(canonical_name, '')) != ''
            AND ${IDENTITY_ONLY_SQL}`
      )
      .all(profileId, ...NON_IDENTITY_CATEGORIES) as { n: string }[]
  ).map((r) => r.n);
}

// Run the reclassification. Idempotent: a second run finds no candidate rows (they
// are no longer `lab`) and writes nothing.
//
// PROFILE SCOPING follows the #2306 pass exactly: the vocabulary
// (canonical_biomarkers) is a global table, but every row this touches is
// profile-owned, so the whole pass runs per profile and every statement filters by
// profile_id. The one genuinely cross-profile question — "may this vocabulary row
// go?" — is answered by UNIONING each profile's own surviving names rather than by
// an unscoped read.
export function reclassifyNonAnalyteObservations(
  db: Database.Database
): AssessmentReclassReport {
  const report: AssessmentReclassReport = {
    records: 0,
    vocabulary: [],
    savedItems: 0,
    dismissals: 0,
    coverageGaps: 0,
  };

  const move = db.prepare(
    `UPDATE medical_records SET category = 'assessment', flag = NULL
      WHERE profile_id = ? AND id = ?`
  );
  const dropSaved = db.prepare(
    `DELETE FROM saved_items
      WHERE profile_id = ? AND kind = 'biomarker' AND key = ? COLLATE NOCASE`
  );
  const dropGap = db.prepare(
    `DELETE FROM coverage_gaps
      WHERE profile_id = ? AND kind = 'biomarker' AND item_key = ? COLLATE NOCASE`
  );
  const dropDismissal = db.prepare(
    "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
  );

  // Names that lost their last identity-carrying row in SOME profile, and the union
  // of every profile's survivors — the two halves of the global vocabulary question.
  const orphaned = new Set<string>();
  const liveAnywhere = new Set<string>();
  // The names each profile is about to stop backing with an identity-carrying row.
  const touched = new Map<number, Set<string>>();
  const ids = profileIds(db);

  // Pass 1 — MOVE. Every row moves before any name is judged orphaned, so a name
  // carried by two profiles is judged against the settled state, not a half-applied
  // one.
  for (const profileId of ids) {
    for (const r of candidates(db, profileId)) {
      report.records += move.run(profileId, r.id).changes;
      const label = (r.canonical_name ?? "").trim() || r.name.trim();
      if (!label) continue;
      const set = touched.get(profileId) ?? new Set<string>();
      set.add(label);
      touched.set(profileId, set);
    }
  }
  if (touched.size === 0) return report;
  for (const profileId of ids)
    for (const n of survivingNames(db, profileId))
      liveAnywhere.add(n.toLowerCase());

  // Pass 2 — SWEEP the name-keyed side-state of every name a profile just stopped
  // backing.
  for (const [profileId, names] of touched) {
    const surviving = survivingNames(db, profileId);
    const survivingLower = new Set(surviving.map((n) => n.toLowerCase()));
    // Family-derived keys a surviving name still mints — a dismissal is only orphaned
    // when NO survivor derives it.
    const liveKeys = new Set<string>();
    for (const n of surviving) {
      liveKeys.add(biomarkerDismissalKey(n));
      liveKeys.add(biomarkerFlagDismissalKey(n));
    }
    const liveGapKeys = new Set(
      surviving.map((n) => biomarkerCoverageKey(n).toLowerCase())
    );
    for (const name of names) {
      if (survivingLower.has(name.toLowerCase())) continue;
      orphaned.add(name);
      report.savedItems += dropSaved.run(profileId, name).changes;
      const gapKey = biomarkerCoverageKey(name);
      if (gapKey && !liveGapKeys.has(gapKey))
        report.coverageGaps += dropGap.run(profileId, gapKey).changes;
      for (const key of [
        biomarkerDismissalKey(name),
        biomarkerFlagDismissalKey(name),
      ]) {
        if (liveKeys.has(key)) continue;
        report.dismissals += dropDismissal.run(profileId, key).changes;
      }
    }
  }

  // The vocabulary is GLOBAL, so a name only leaves it when no profile anywhere still
  // has an identity-carrying record using it — and only when it was ai-coined. A
  // `seed`/`curated` row is untouchable, exactly as in the #2306 pass.
  const dropName = db.prepare(
    "DELETE FROM canonical_biomarkers WHERE name = ? COLLATE NOCASE AND source = 'ai'"
  );
  for (const name of orphaned) {
    if (liveAnywhere.has(name.toLowerCase())) continue;
    if (dropName.run(name).changes > 0) report.vocabulary.push(name);
  }
  return report;
}
