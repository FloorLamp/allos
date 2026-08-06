// DB INTEGRATION TIER — export COMPLETENESS binding (issue #465, extended to
// child tables by #2129).
//
// The export-side twin of the #201/#212 import-footprint disease: tables added after
// the export feature never joined it, and nothing bound DATASETS to the schema. This
// test is the established cure — it DERIVES the completeness obligation from
// OWNED_TABLES so a new profile-owned table can no longer be silently absent from the
// portable export a family relies on when migrating off an instance. #2129 extends
// the same model one FK hop down: the obligation for CHILD tables (no profile_id of
// their own) is derived from PRAGMA foreign_key_list over the owned roots — the
// profile-delete sweep guard's sibling on the read side — because every child that
// WAS exported got there by someone happening to write a dataset, and
// intake_dose_schedule_versions / medical_record_revisions proved undo can consider
// history worth preserving while export silently drops it.
//
// It lives in the DB tier (not the pure tier) only because importing lib/export pulls
// in the SQLite handle.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { DATASETS } from "@/lib/export";
import { OWNED_TABLES } from "@/lib/owned-tables";
import { ownedChildTables } from "@/lib/profile-delete";
import { FHIR_EXPORT_RESOURCE_TYPES } from "@/lib/fhir-export";
import { FHIR_IMPORT_RESOURCE_TYPES } from "@/lib/fhir";

// Owned tables whose rows reach the export through the FHIR passport input rather than
// (or in addition to) a flat dataset. Kept explicit so a domain that ONLY exports via
// FHIR still counts as covered.
const FHIR_INPUT_TABLES = new Set<string>([
  "conditions",
  "allergies",
  "procedures",
  "immunizations",
  "medical_records", // labs/vitals → Observations
  "intake_items", // medications → MedicationRequest
  "encounters",
  "family_history",
  "care_plan_items",
  "care_goals",
]);

// Owned tables intentionally NOT in the portable export, each with the reason a
// migrating family isn't losing health data by their absence. Anything NOT here and
// NOT in a dataset / the FHIR input fails the completeness assertion below — the exact
// drift this test exists to catch.
const EXPORT_ALLOWLIST: { table: string; why: string }[] = [
  // Preference / UI state — not the user's health record.
  {
    table: "saved_items",
    why: "UI save state (which items the ★ star gesture marked — biomarkers, Trends tiles; #1456 folded starred_biomarkers + trend_pins here). Curation, not the user's health record; every saved biomarker's READINGS export via medical_records.",
  },
  {
    table: "upcoming_dismissals",
    why: "UI dismissal/snooze state for due-nudges; regenerated from the underlying data",
  },
  {
    table: "coverage_gaps",
    why: "opt-in catalog-gap registry + AI-generated descriptive blurbs (issue #550); re-derivable from the profile's own records and re-fillable, not user-entered health data",
  },
  // AI-derived, regenerable from the source data.
  {
    table: "insights",
    why: "AI-generated daily summaries; re-derivable from the data",
  },
  {
    table: "narratives",
    why: "AI-generated period recaps; re-derivable from the data",
  },
  {
    table: "intake_item_suggestions",
    why: "AI-proposed, not-yet-accepted supplement suggestions; not user-entered data",
  },
  {
    table: "notify_messages",
    why: "live Telegram message pointers (#1779): chat/message ids plus the delivered keyboard, kept only until Telegram's ~48h edit horizon so the tick can un-stale what a chat displays. Delivery plumbing about a THIRD-PARTY chat, not the user's health record, and worthless outside this instance's bot — the health facts every button refers to export via their own datasets (doses, food log, mood, symptoms).",
  },
  // Operational / non-portable machinery (credentials, ledgers, tombstones, queues).
  {
    table: "integration_connections",
    why: "provider OAuth tokens / sync config — secrets, not portable clinical data",
  },
  {
    table: "integration_sync_events",
    why: "integration sync audit log — operational, not a health record",
  },
  {
    table: "integration_backfill_jobs",
    why: "transient provider-enrichment progress, quota timing, and retry state; operational and meaningless without this instance's non-portable integration connection",
  },
  {
    table: "portal_identities",
    why: "portal↔patient routing configuration (#1739) — it records HOW records arrive (which label on which portal maps to this profile), never anything a clinician wrote. Deliberately not portable: it is keyed on a `portals` row that is global to this instance and on a label defined by an external portal's proxy list, so it is meaningless on another instance, and the documents it routed export in full via medical_documents. Same class as integration_connections/integration_sync_events, which sit directly above.",
  },
  {
    table: "profile_share_links",
    why: "hashed share-link tokens — secrets, meaningless off this instance",
  },
  {
    table: "import_jobs",
    why: "transient import-processing queue; the source documents live in medical_documents",
  },
  {
    table: "import_pair_decisions",
    why: "import dedup bookkeeping (merge/keep-both signatures); transient processing state",
  },
  {
    table: "visit_link_decisions",
    why: "record↔visit / episode↔visit accept-decline bookkeeping (#1050/#1053); provenance/navigation decisions keyed on stable tokens, not health data — the linked encounter_id lives on the exported record/episode rows",
  },
  {
    table: "med_link_decisions",
    why: "med↔prescriber / med↔indication accept-decline bookkeeping (#1051/#1052); provenance/navigation decisions keyed on stable tokens, not health data — the resulting provider_id / indication_condition_id live on the exported intake_items rows",
  },
  {
    table: "episode_encounters",
    why: "episode↔visit link rows (#1198); navigation join between an exported illness_episodes row and its exported encounters rows — no independent clinical payload, exactly like visit_link_decisions whose 'linked' rows it mirrors as the canonical set",
  },
  {
    table: "episode_stopped_meds",
    why: "reopen-restore reversal records (#1140 Part B); operational bookkeeping of which med courses an episode's end closed so a reopen can restart them — the med/course state itself round-trips through intake_items/medication_courses, this holds only the transient episode→course link consumed on reopen",
  },
  {
    table: "import_tombstones",
    why: "re-import suppression bookkeeping (merged/deleted source-owned natural keys); operational dedup state, not health data",
  },
  {
    table: "document_coverage_markers",
    why: "acquirer inventory bookkeeping (#1828): the content hashes an automated client OFFERED and allos refused because it already holds those clinical entries. It is a record of an offer that was never stored — no bytes, no document, no health data — and it is re-earned the next time a client offers the same file. The records it points at round-trip through the covering document's own datasets.",
  },
  {
    table: "ai_usage_counters",
    why: "per-day AI rate-limit counters; operational, not health data",
  },
  {
    table: "deleted_rows",
    why: "undo/Trash holding buffer (tombstones); transient, purged on a timer once the admin-configured retention window runs out (#2013)",
  },
  {
    table: "replayed_keys",
    why: "offline-replay idempotency ledger; operational, purged on a timer",
  },
  {
    table: "routines",
    why: "adopted/authored training programs (#738); the routine's meaningful training signal is the frequency_targets it derives on activation (already a flat dataset), and template routines re-adopt from lib/routine-templates.ts. Full round-trip export of custom routines (with their routine_days/routine_slots children) lands with the builder UI that can author them (#739).",
  },
  {
    table: "illness_episodes",
    why: "illness-episode IDENTITY + annotations (note/outcome) with DERIVED membership (#856). The illness STORY that carries clinical weight — symptoms (symptom_logs), fever readings (medical_records vitals), administrations (intake_item_logs) — is already exported through those datasets; the episode row is a thin date-range + free-text annotation with no independent clinical payload to round-trip.",
  },
  {
    table: "fitness_assessments",
    why: "fitness-check SESSION rows (#834) — a date + coverage ledger that GROUPS a battery run. The measured VALUES that carry the signal already round-trip through their natural stores: set-based tests via activities/exercise_sets, VO2/grip/etc. via medical_records, body comp via body_metrics — all exported datasets/FHIR. The session row (and its child fitness_assessment_entries) references those, holding no independent clinical payload to export.",
  },
  {
    table: "instrument_responses",
    why: "mental-health instrument PER-ITEM answers (#716). The clinically meaningful value — the PHQ-9/GAD-7 total SCORE — is a medical_records biomarker reading that already round-trips through the FHIR Observation export; these rows are the item breakdown behind that score (kept for the item-9 handling), a supporting decomposition with no independent clinical payload to export, exactly like fitness_assessment_entries relative to its natural stores.",
  },
  // ── The five MEDIA tables (#1846) ────────────────────────────────────────────
  // These are no longer "excluded, opt-in is a follow-up": the follow-up SHIPPED.
  // "Include photo & video files" on the export flow (?media=1) puts the exporting
  // profile's files into the ZIP under media/<domain>/, and media/index.json carries
  // each file's row context — which for these tables IS the row export, since a thin
  // date/caption row is only meaningful next to the image or clip it names. They stay
  // out of DATASETS (not out of the bundle) for that reason, and stay OUT BY DEFAULT
  // because they are the strictest privacy tier: still excluded from share links, the
  // printable, and the emergency card, with no stored setting that could make
  // inclusion the standing default.
  {
    table: "symptom_photos",
    why: "symptom-day rash-progression photos (#859 item 4). Strictest privacy tier: excluded from share-link summaries and the printable, and out of the full export UNLESS the download opts in via the #1846 media toggle, which bundles the files under media/symptom-photos/ with their date/symptom/caption row context in media/index.json. The thin row is not a standalone dataset — it is only meaningful beside its image. Files live at data/uploads/symptom-photos/<profileId>/ and are unlinked with the profile on delete.",
  },
  {
    table: "lesion_photos",
    why: "serial lesion photos (#715) — the ones a year of mole tracking is made of. Same strictest-tier posture as symptom_photos, and covered by the SAME #1846 opt-in: media/lesion-photos/ plus each photo's date/caption and its parent lesion's label/region in media/index.json, alongside the now-exported skin_lesions dataset the photos belong to. Files live at data/uploads/lesion-photos/<profileId>/ and are unlinked with the profile on delete.",
  },
  {
    table: "progress_photos",
    why: "physique progress photos (#1119). Body photos are excluded from share links, the emergency card, and the DEFAULT full export — the #1119 product decision, which #1846 keeps as the default while adding the explicit per-download opt-in: media/progress-photos/ with date/pose/caption in media/index.json. The images are EXIF-stripped blobs at data/uploads/progress-photos/<profileId>/ and are unlinked with the profile on delete.",
  },
  {
    table: "symptom_videos",
    why: "symptom / episode video clips (#1224). Same strictest tier as the photo domains and the same #1846 opt-in: media/symptom-videos/ with date/symptom/caption/kind/duration in media/index.json. Posters are derived artifacts and are deliberately not bundled — the original capture is the record. Clips live at data/uploads/symptom-videos/<profileId>/ and are unlinked with the profile on delete.",
  },
  {
    table: "activity_videos",
    why: "training form-check video clips (#1224). Same strictest tier and the same #1846 opt-in (media/activity-videos/, with exercise/caption/duration plus the parent activity's date and title in media/index.json) — with one extra gate: a training-restricted profile's clips are held back exactly like its activities/goals datasets (#471), so the clips can't be the way around the age gate. Clips live at data/uploads/activity-videos/<profileId>/ and are unlinked with the profile on delete.",
  },
];

describe("full export covers every owned domain (issue #465)", () => {
  const datasetTables = new Set(DATASETS.map((d) => d.table));
  const allowlisted = new Set(EXPORT_ALLOWLIST.map((a) => a.table));

  it("every OWNED_TABLES entry is a dataset, in the FHIR input, or justified-allowlisted", () => {
    const uncovered = OWNED_TABLES.filter(
      (t) =>
        !datasetTables.has(t) &&
        !FHIR_INPUT_TABLES.has(t) &&
        !allowlisted.has(t)
    );
    expect(
      uncovered,
      `\nUn-exported owned tables (add a dataset/FHIR resource, or allowlist with a reason):\n${uncovered.join("\n")}\n`
    ).toEqual([]);
  });

  it("the allowlist references only real owned tables (no stale entries)", () => {
    const owned = new Set<string>(OWNED_TABLES);
    const stale = EXPORT_ALLOWLIST.filter((a) => !owned.has(a.table)).map(
      (a) => a.table
    );
    expect(stale).toEqual([]);
    // Every allowlist entry carries a justification.
    for (const a of EXPORT_ALLOWLIST)
      expect(a.why.trim().length).toBeGreaterThan(0);
  });

  it("no allowlisted table is also exported (allowlist and export are disjoint)", () => {
    const overlap = EXPORT_ALLOWLIST.filter(
      (a) => datasetTables.has(a.table) || FHIR_INPUT_TABLES.has(a.table)
    ).map((a) => a.table);
    expect(overlap).toEqual([]);
  });
});

// ── Child tables (#2129) ────────────────────────────────────────────────────────

// Child tables whose rows reach the export through the FHIR passport INPUT
// (collectFhirExportInput in lib/export-full.ts) rather than a flat dataset:
// allergy_reactions rides AllergyIntolerance.reaction[], and intake_item_doses is
// folded into each medication's dosage string (it ALSO folds into the supplements
// dataset's schedule column).
const FHIR_CHILD_INPUT_TABLES = new Set<string>([
  "allergy_reactions",
  "intake_item_doses",
]);

// Child tables intentionally NOT in the portable export, each with the reason a
// migrating family isn't losing health data by their absence — the same contract
// as EXPORT_ALLOWLIST, one FK hop down. A child of an allowlisted PARENT still
// needs its own entry here (naming the parent's argument), so the decision stays
// visible when the parent's entry changes.
const CHILD_EXPORT_ALLOWLIST: { table: string; why: string }[] = [
  {
    table: "intake_item_pairs",
    why: "take-together/apart pairing between two intake_items rows, keyed on instance-local row ids that are meaningless off this instance; both endpoint items export in full via the supplements dataset, and the pair itself is a two-tap re-declaration — no independent clinical payload",
  },
  {
    table: "routine_days",
    why: "children of routines, itself allowlisted: the routine's meaningful training signal exports via frequency_targets, and full round-trip export of custom routines (days + slots) lands with the builder UI (#739)",
  },
  {
    table: "routine_slots",
    why: "children of routine_days — same #739 argument as routine_days, one level down",
  },
  {
    table: "fitness_assessment_entries",
    why: "children of fitness_assessments, itself allowlisted: a coverage ledger referencing measured VALUES that already round-trip through their natural stores (activities/exercise_sets, medical_records, body_metrics) — no independent clinical payload",
  },
  {
    table: "integration_sync_rows",
    why: "per-row provenance of integration_sync_events (#1333), itself allowlisted: operational sync audit detail, not a health record — the synced rows themselves export via their own datasets",
  },
];

describe("full export covers every FK child of an owned table (#2129)", () => {
  const datasetTables = new Set(DATASETS.map((d) => d.table));
  const childTables = [...ownedChildTables(db).keys()].sort();
  const allowlisted = new Set(CHILD_EXPORT_ALLOWLIST.map((a) => a.table));

  it("derives a non-trivial child set from the schema", () => {
    // Sanity that the FK walk works — the two #2129 misses plus known children.
    for (const t of [
      "intake_dose_schedule_versions",
      "medical_record_revisions",
      "exercise_sets",
      "allergy_reactions",
    ]) {
      expect(childTables, t).toContain(t);
    }
  });

  it("every child table is a dataset, in the FHIR passport input, or justified-allowlisted", () => {
    const uncovered = childTables.filter(
      (t) =>
        !datasetTables.has(t) &&
        !FHIR_CHILD_INPUT_TABLES.has(t) &&
        !allowlisted.has(t)
    );
    expect(
      uncovered,
      `\nUn-exported child tables (add a dataset/passport reach, or allowlist with a reason):\n${uncovered.join("\n")}\n`
    ).toEqual([]);
  });

  it("the child allowlist references only real child tables, each justified, none also exported", () => {
    const children = new Set(childTables);
    for (const a of CHILD_EXPORT_ALLOWLIST) {
      expect(children.has(a.table), `${a.table} is not a child table`).toBe(
        true
      );
      expect(a.why.trim().length).toBeGreaterThan(0);
      expect(
        datasetTables.has(a.table) || FHIR_CHILD_INPUT_TABLES.has(a.table),
        `${a.table} is exported — remove its allowlist entry`
      ).toBe(false);
    }
  });

  it("the FHIR child input set stays real (collectFhirExportInput reads these)", () => {
    const children = new Set(childTables);
    for (const t of FHIR_CHILD_INPUT_TABLES) {
      expect(children.has(t), `${t} is not a child table`).toBe(true);
    }
  });
});

describe("FHIR export/import symmetry (issue #465)", () => {
  const exported = new Set<string>(FHIR_EXPORT_RESOURCE_TYPES);
  const imported = new Set<string>(FHIR_IMPORT_RESOURCE_TYPES);

  // Resource types the importer consumes as a read-only equivalent of a type the
  // exporter DOES emit in canonical form: MedicationStatement is an alias of
  // MedicationRequest, and DiagnosticReport is an Observation container. These are the
  // only importer types the exporter is allowed to not emit.
  const READ_ONLY_ALIASES = new Set([
    "MedicationStatement",
    "DiagnosticReport",
  ]);

  // Import-only STRUCTURED FEEDS (#708): resource types the importer consumes into a
  // record type that has no FHIR export builder YET. ImagingStudy / an imaging
  // DiagnosticReport / an imaging DocumentReference feed the imaging_studies table,
  // and VisionPrescription feeds the optical_prescriptions table — neither is part of
  // the FHIR passport export today (a dedicated exporter is a documented follow-up).
  // DocumentReference is inherently a pointer type the exporter would never emit.
  // Excluded from the "must be exported" direction only — NOT from "everything
  // exported is consumable" (that direction still binds).
  const IMPORT_ONLY_STRUCTURED_FEEDS = new Set([
    "ImagingStudy",
    "DocumentReference",
    "VisionPrescription",
  ]);

  it("everything the exporter emits, the importer can consume", () => {
    const unconsumable = [...exported].filter((t) => !imported.has(t));
    expect(unconsumable).toEqual([]);
  });

  it("every clinical domain the importer accepts, the exporter emits", () => {
    const notExported = [...imported].filter(
      (t) =>
        !exported.has(t) &&
        !READ_ONLY_ALIASES.has(t) &&
        !IMPORT_ONLY_STRUCTURED_FEEDS.has(t)
    );
    expect(
      notExported,
      `\nImporter consumes these but the exporter drops them (add an inverse builder):\n${notExported.join("\n")}\n`
    ).toEqual([]);
  });
});
