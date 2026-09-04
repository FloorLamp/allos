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

describe("mixed intake export (#2484/#2740)", () => {
  it("uses the physical intake_items key for the shared dataset", () => {
    expect(
      DATASETS.find((dataset) => dataset.key === "intake_items")
    ).toMatchObject({
      label: "Supplements & Medications",
      table: "intake_items",
    });
  });
});

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
    why: "UI save state (which items the ★ star gesture marked — clinical results, Trends tiles; #1456 folded starred_biomarkers + trend_pins here). Curation, not the user's health record; every saved result's READINGS export via medical_records.",
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
  {
    table: "notify_offers",
    why: "what a delivered Telegram button OFFERED (#2460): the bundle a 64-byte callback token has no room to name, kept only while the message carrying it can still be tapped. The same class as notify_messages above — delivery plumbing about a third-party chat, meaningless on another instance — and every health fact a redeemed offer actually wrote exports via its own dataset (food log, intake logs).",
  },
  {
    table: "notify_post_workout_claims",
    why: "durable post-workout dispatch claims (#3058): which process won the right to send one finish nudge, and whether it did. Delivery-election bookkeeping in the same class as notify_messages above — no health payload of its own (the workout it points at exports via activities; the doses the nudge listed export via their intake datasets), and meaningless on another instance, whose notification processes never raced over it.",
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
    table: "stream_frontiers",
    why: "the continuous-stream watermark (#2341): how far a provider's stream had got when ingest last looked, and whether the last pushes moved it. Operational detection state about the PIPELINE, in the same class as integration_sync_events above — the heart-rate minutes it watches export in full via their own dataset, and on another instance the watermark is not merely useless but wrong, since it describes pushes that instance never received. It rebuilds itself from the first push after an import.",
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
    why: "training form-check video clips (#1224). Same strictest tier and the same #1846 opt-in (media/activity-videos/, with exercise/caption/duration plus the parent activity's date and title in media/index.json). Activity data is age-neutral, so its clips follow the same profile-scoped activity opt-in at every life stage. Clips live at data/uploads/activity-videos/<profileId>/ and are unlinked with the profile on delete.",
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
    why: "take-together/apart pairing between two intake_items rows, keyed on instance-local row ids that are meaningless off this instance; both endpoint items export in full via the intake_items dataset, and the pair itself is a two-tap re-declaration — no independent clinical payload",
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

// ── Column completeness (#5117) ─────────────────────────────────────────────────
//
// Everything above asks "is this TABLE exported?". Nothing above can ask "is it
// exported COMPLETELY?" — which is how `bundle_id` landed on four exported tables
// and none of their datasets: every table involved was already covered, so the
// obligation those guards derive stayed satisfied while four datasets each dropped
// a column.
//
// THE RULE, also stated in lib/export.ts beside DATASETS and in
// lib/migrations/AGENTS.md, where the person adding the next column is standing:
//
//     Every column of a table that has a flat dataset is exported, unless it is
//     named in COLUMN_EXPORT_ALLOWLIST below.
//
// So adding a column to an exported table is now a fork in the road with no third
// path: put it in the dataset, or write its name and your reason here.
//
// ATTRIBUTION COMES FROM SQLITE, NOT FROM READING THIS REPO'S SOURCE. Each dataset
// carries the `select` its rows()/page() run, and better-sqlite3's
// `Statement#columns()` reports the ORIGIN table and column of every result column —
// through aliases (`ii.name AS item`) and JOINs alike. A computed cell (`exercises`,
// `schedule`) attributes to no origin column, so it can only make this guard
// stricter, never blinder. And anything this scan CANNOT attribute throws below
// rather than being skipped: a column the guard silently cannot see is precisely the
// hole it exists to close.

// Tables that have a flat dataset AND feed the FHIR passport. This guard reads flat
// SELECTs; it cannot read what a FHIR builder emits, so it does not pronounce on
// these tables' columns — a column of `conditions` absent from the flat dataset may
// well ride a FHIR resource, and calling it un-exported would be a lie. Carved out
// BY NAME and counted (not skipped): the census below proves every carve-out is a
// real dataset table that is really in FHIR_INPUT_TABLES, so the exemption cannot
// grow by accident.
const COLUMN_GUARD_FHIR_CARVE_OUT = FHIR_INPUT_TABLES;

// Result columns a dataset SELECTs — so they reach datasets/<key>.json — but keeps
// out of `columns`, the CSV header. `id` is the contract-wide one (every dataset
// carries the row's primary key for the manage UI, deliberately not a CSV column);
// anything else is a per-dataset divergence between the two files the archive ships
// and must be named here.
const CSV_OMITTED_RESULT_COLUMNS: {
  key: string;
  column: string;
  why: string;
}[] = [
  {
    key: "milestones",
    column: "key",
    why: "the milestone's stable identity (`first-5k`), which is also its once-only fired marker (lib/milestones.ts). It rides datasets/milestones.json for a re-importer that must not re-fire a milestone; the CSV a person reads shows the milestone itself — kind, threshold, title, detail, achieved_on.",
  },
];

// Columns of an exported table that the export does NOT carry. Two kinds, and the
// difference is the point:
//
//   "argued"     — someone decided this column has no place in a portable health
//                  record, and the reason is here.
//   "inherited"  — it simply never joined the export and nobody argued either way.
//                  This is the debt #5117 found, written down: an inventory, not a
//                  defence. Exporting one of these and deleting its name here is
//                  always a valid change, and needs no permission from this list.
//
// `profile_id` is not listed anywhere below — it is excluded by rule, right above
// the census, because the argument is identical on all 47 tables.
type ColumnExclusion = {
  table: string;
  columns: string[];
  kind: "argued" | "inherited";
  why: string;
};

const COLUMN_EXPORT_ALLOWLIST: ColumnExclusion[] = [
  // ── Instance-local keys: the row id of a parent, or of another row on this
  // instance. They renumber on import and name nothing outside this database; the
  // thing they point at exports under its own dataset (and child datasets carry the
  // parent's readable identity instead — `ii.name AS item`).
  {
    table: "activity_routes",
    columns: ["activity_id"],
    kind: "argued",
    why: "the parent activity's row id; the activity itself exports via the activities dataset",
  },
  {
    table: "exercise_sets",
    columns: ["activity_id", "warmup", "rpe"],
    kind: "inherited",
    why: "the parent activity's row id (the activity exports via the activities dataset), plus the warmup flag and RPE, which never joined the sets dataset",
  },
  {
    table: "intake_dose_schedule_versions",
    columns: ["dose_id"],
    kind: "argued",
    why: "the parent dose's row id; the dataset carries the readable item name and dose amount in its place",
  },
  {
    table: "medical_record_revisions",
    columns: ["record_id"],
    kind: "argued",
    why: "the parent record's row id; the record exports via medical_records",
  },
  {
    table: "intake_item_ingredients",
    columns: ["item_id", "sort"],
    kind: "argued",
    why: "the parent item's row id, plus the display order of the ingredient list — presentation, not a fact about the person",
  },
  {
    table: "intake_item_purposes",
    columns: ["item_id", "condition_id", "sort"],
    kind: "argued",
    why: "parent item id, the linked condition's row id (the condition itself exports via the FHIR passport, and the dataset carries its name), and display order",
  },
  {
    table: "intake_item_side_effects",
    columns: ["item_id", "course_id", "created_at"],
    kind: "argued",
    why: "parent item and course row ids, plus the row's write stamp",
  },

  // ── Write stamps: when the app filed the row, not when anything happened to the
  // person. Each of these datasets exports the event column that answers the
  // clinical question (see docs/internals/time-columns.md); the filing time is
  // machinery. Where a dataset DOES export its created_at (practice_logs), it is
  // exported and absent from this list.
  {
    table: "equipment",
    columns: ["created_at", "retired"],
    kind: "inherited",
    why: "write stamp, and the retired flag — gym-inventory state that never joined the dataset",
  },
  {
    table: "food_daily_totals",
    columns: ["created_at"],
    kind: "argued",
    why: "write stamp; the day the totals count for is the exported `date`",
  },
  {
    table: "protein_daily_totals",
    columns: ["created_at"],
    kind: "argued",
    why: "write stamp, as food_daily_totals",
  },
  {
    table: "immunization_overrides",
    columns: ["created_at"],
    kind: "argued",
    why: "write stamp",
  },
  {
    table: "preventive_events",
    columns: ["created_at"],
    kind: "argued",
    why: "write stamp",
  },
  {
    table: "preventive_overrides",
    columns: ["created_at"],
    kind: "argued",
    why: "write stamp",
  },
  {
    table: "preventive_record_decisions",
    columns: ["created_at", "updated_at"],
    kind: "argued",
    why: "write stamps",
  },
  {
    table: "situations",
    columns: ["created_at"],
    kind: "argued",
    why: "write stamp",
  },
  {
    table: "milestones",
    columns: ["created_at"],
    kind: "argued",
    why: "write stamp; `achieved_on` is the date that matters and is exported",
  },
  {
    table: "mood_logs",
    columns: ["updated_at"],
    kind: "argued",
    why: "last-edit stamp; the mood entry's own date is exported",
  },

  // ── Not argued: columns that simply never joined their dataset. Listed so the
  // NEXT one cannot join them silently.
  {
    table: "activities",
    columns: [
      "components",
      "created_at",
      "avg_speed_kmh",
      "max_speed_kmh",
      "relative_effort",
      "max_power_w",
      "weighted_avg_power_w",
      "avg_temp_c",
      "edited",
      "updated_at",
      "equipment_id",
      "elapsed_min",
      "logged_via",
    ],
    kind: "inherited",
    why: "#466 widened this dataset from the display projection to the device telemetry it was dropping, and stopped where it stopped; every telemetry column added since is here, alongside the write stamps, the equipment link and the edited/logged_via provenance pair",
  },
  {
    table: "activity_telemetry",
    columns: ["stream_summary_json", "answer"],
    kind: "inherited",
    why: "the stored stream summary and the answer derived from it, behind the telemetry columns the dataset does carry",
  },
  {
    table: "appointments",
    columns: [
      "provider_id",
      "created_at",
      "kind",
      "document_id",
      "source",
      "external_id",
      "encounter_id",
    ],
    kind: "inherited",
    why: "the link columns (provider, document, encounter), the ingest provenance trio, and the appointment kind",
  },
  {
    table: "body_metrics",
    columns: [
      "occurred_at",
      "logged_via",
      "weight_at",
      "body_fat_at",
      "resting_hr_at",
    ],
    kind: "inherited",
    why: "the per-measure instants behind the exported `date` (docs/internals/time-columns.md) and the logged_via provenance — the same class of fact as the bundle_id this dataset just gained, and not covered by #5117's ruling",
  },
  {
    table: "dental_procedures",
    columns: ["provider_id", "external_id", "created_at", "encounter_id"],
    kind: "inherited",
    why: "link columns and ingest provenance",
  },
  {
    table: "endurance_plans",
    columns: ["session_kinds"],
    kind: "inherited",
    why: "the plan's session-kind composition",
  },
  {
    table: "fasts",
    columns: ["end_written_at"],
    kind: "inherited",
    why: "when the fast's end was written down, as distinct from the exported end instant",
  },
  {
    table: "food_log_events",
    columns: [
      "created_at",
      "occurred_at",
      "time_source",
      "notify_message_id",
      "logged_via",
    ],
    kind: "inherited",
    why: "the eating instant a person may have stated, and where that time came from, behind the exported `recorded_at` tap instant; plus the Telegram message pointer and logged_via",
  },
  {
    table: "frequency_targets",
    columns: ["per_week_max", "created_at", "scope_identity"],
    kind: "inherited",
    why: "the range's upper bound beside the exported per_week, the write stamp, and the derived scope identity",
  },
  {
    table: "genomic_variants",
    columns: ["source", "document_id", "external_id", "created_at"],
    kind: "inherited",
    why: "ingest provenance and the source document link",
  },
  {
    table: "goals",
    columns: [
      "exercise",
      "metric",
      "target_weight_kg",
      "target_reps",
      "target_sets",
      "target_duration_sec",
      "body_metric",
      "baseline_value",
      "archived",
      "equipment_id",
      "biomarker_name",
      "target_direction",
      "achieved_at",
    ],
    kind: "inherited",
    why: "the whole typed half of a goal — what it is measured on and what the target actually is — behind the generic title/target_value/current_value the dataset carries",
  },
  {
    table: "imaging_studies",
    columns: [
      "ordering_provider_id",
      "reading_provider_id",
      "source",
      "document_id",
      "external_id",
      "created_at",
      "dose_msv",
      "encounter_id",
    ],
    kind: "inherited",
    why: "provider/document/encounter links, ingest provenance, and the study's radiation dose",
  },
  {
    table: "injuries",
    columns: [
      "laterality",
      "movements",
      "exercises",
      "load_factor",
      "review_date",
    ],
    kind: "inherited",
    why: "which side, what it restricts, and when to look again",
  },
  {
    table: "intake_item_logs",
    columns: [
      "dose_id",
      "item_id",
      "product",
      "supply_adjusted",
      "notify_message_id",
      "logged_via",
    ],
    kind: "inherited",
    why: "parent dose/item row ids (the readable item name is exported in their place), the product taken, whether the confirm moved supply, the Telegram pointer, and logged_via",
  },
  {
    table: "medical_documents",
    columns: [
      "stored_path",
      "patient_name",
      "extraction_error",
      "raw_extraction",
      "model",
      "import_report",
      "content_hash",
      "processing_started_at",
      "extraction_completed_at",
      "acquired_portal_id",
      "clinical_key",
      "acquired_identity_id",
      "delivered_at",
    ],
    kind: "argued",
    why: "the extraction pipeline's own record of processing this file — on-disk path, model, raw and errored extraction output, timings, and the portal/identity routing it arrived through. The FILE itself is bundled under medical-files/ and the clinical entries it produced export via their own datasets; none of this describes the person",
  },
  {
    table: "medication_courses",
    columns: [
      "item_id",
      "created_at",
      "prescriber",
      "provider_id",
      "dose_snapshot",
    ],
    kind: "inherited",
    why: "parent item row id and write stamp, plus who prescribed the course and the dose as of its start",
  },
  {
    table: "metric_samples",
    columns: ["activity_external_id", "edited", "pushed_at"],
    kind: "inherited",
    why: "the provider-side activity key this sample came from, the hand-edit lock, and when it was pushed back",
  },
  {
    table: "optical_prescriptions",
    columns: [
      "provider_id",
      "source",
      "document_id",
      "external_id",
      "created_at",
      "encounter_id",
    ],
    kind: "inherited",
    why: "link columns and ingest provenance",
  },
  {
    table: "practice_logs",
    columns: [
      "source",
      "external_id",
      "edited",
      "notify_message_id",
      "logged_via",
      "live",
      "derived_window",
      "correction_locked",
    ],
    kind: "inherited",
    why: "ingest provenance, the Telegram pointer, and the in-progress/derived-window/correction-lock flags behind the exported session window — the same class as the bundle_id this dataset just gained, and not covered by #5117's ruling",
  },
  {
    table: "protocols",
    columns: [
      "created_at",
      "equipment_id",
      "frequency_target_id",
      "owns_frequency_target",
      "intake_item_id",
    ],
    kind: "inherited",
    why: "write stamp and the equipment / frequency-target / intake-item links, each of which exports under its own dataset",
  },
  {
    table: "providers",
    columns: [
      "dedup_key",
      "created_at",
      "specialty_code",
      "specialty",
      "archived",
      "contact_edited",
    ],
    kind: "inherited",
    why: "the dedup key and write stamp are instance-local bookkeeping; the specialty pair, archived flag and contact-edit lock never joined the dataset",
  },
  {
    table: "skin_lesions",
    columns: ["provider_id", "external_id", "created_at", "encounter_id"],
    kind: "inherited",
    why: "link columns and ingest provenance",
  },
  {
    table: "substance_daily_totals",
    columns: ["created_at", "source", "edited", "logged_via"],
    kind: "inherited",
    why: "write stamp and the source/edited/logged_via provenance trio",
  },
  {
    table: "symptom_logs",
    columns: ["created_at", "episode_id", "logged_via"],
    kind: "inherited",
    why: "write stamp, the illness_episodes link (that table is allowlisted above), and logged_via",
  },
];

// The scope column. Every profile-owned table carries it, and it is the one thing an
// export of ONE profile cannot tell anyone: the archive is that profile's, and the id
// renumbers on import. Excluded by rule rather than 47 identical allowlist entries.
const PROFILE_SCOPE_COLUMN = "profile_id";

// The census the assertions below run on: for every dataset table not carved out,
// its physical columns and the ones the export actually carries. Anything it cannot
// attribute THROWS — an unseen dataset or column is the defect, not an exemption.
type TableColumnCensus = {
  table: string;
  physical: string[];
  exported: Set<string>;
};

function columnCensus(): {
  tables: TableColumnCensus[];
  carvedOut: string[];
  csvOmitted: { key: string; column: string }[];
} {
  const exported = new Map<string, Set<string>>();
  const datasetTables: string[] = [];
  const csvOmitted: { key: string; column: string }[] = [];

  for (const ds of DATASETS) {
    if (!ds.select?.trim()) {
      throw new Error(
        `dataset "${ds.key}" has no select — this guard cannot see which columns it exports`
      );
    }
    const result = db.prepare(ds.select).columns();
    const own = result.filter((c) => c.table === ds.table && c.column);
    if (own.length === 0) {
      throw new Error(
        `dataset "${ds.key}" selects nothing SQLite can attribute to ${ds.table} — this guard cannot see which columns it exports`
      );
    }
    if (!exported.has(ds.table)) {
      exported.set(ds.table, new Set<string>());
      datasetTables.push(ds.table);
    }
    const carried = exported.get(ds.table)!;
    const csvHeader = new Set(ds.columns);
    for (const c of own) {
      carried.add(c.column!);
      if (c.name !== "id" && !csvHeader.has(c.name)) {
        csvOmitted.push({ key: ds.key, column: c.name });
      }
    }
  }

  const tables: TableColumnCensus[] = [];
  const carvedOut: string[] = [];
  for (const table of datasetTables.sort()) {
    if (COLUMN_GUARD_FHIR_CARVE_OUT.has(table)) {
      carvedOut.push(table);
      continue;
    }
    const physical = (
      db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((r) => r.name);
    if (physical.length === 0) {
      throw new Error(
        `PRAGMA table_info(${table}) returned no columns — the guard cannot read the table a dataset says it exports`
      );
    }
    tables.push({ table, physical, exported: exported.get(table)! });
  }
  return { tables, carvedOut, csvOmitted };
}

// The floor. Not a target — a tripwire under the census, so a scan that reads an
// empty or truncated population fails LOUD instead of passing green over nothing.
// These are the counts at the time #5117 landed; they only ever move up, and moving
// one down means the export lost a table.
const MIN_TABLES_CHECKED = 47;
const MIN_COLUMNS_CHECKED = 583;

describe("every column of an exported table is exported (#5117)", () => {
  const { tables, carvedOut, csvOmitted } = columnCensus();
  const columnsChecked = tables.reduce((n, t) => n + t.physical.length, 0);

  it("checks a real population, not an empty one", () => {
    expect(
      tables.length,
      `only ${tables.length} dataset tables reached the column census`
    ).toBeGreaterThanOrEqual(MIN_TABLES_CHECKED);
    expect(
      columnsChecked,
      `only ${columnsChecked} columns reached the column census`
    ).toBeGreaterThanOrEqual(MIN_COLUMNS_CHECKED);
  });

  it("every column is exported, or named in the allowlist with a reason", () => {
    const excluded = new Map<string, Set<string>>();
    for (const entry of COLUMN_EXPORT_ALLOWLIST) {
      const set = excluded.get(entry.table) ?? new Set<string>();
      for (const c of entry.columns) set.add(c);
      excluded.set(entry.table, set);
    }
    const unexported: string[] = [];
    for (const t of tables) {
      for (const column of t.physical) {
        if (column === PROFILE_SCOPE_COLUMN) continue;
        if (t.exported.has(column)) continue;
        if (excluded.get(t.table)?.has(column)) continue;
        unexported.push(`${t.table}.${column}`);
      }
    }
    expect(
      unexported,
      `\nColumns of an exported table that the export drops.\nAdd each to its dataset's columns + select in lib/export.ts, or name it in COLUMN_EXPORT_ALLOWLIST with the reason:\n${unexported.join("\n")}\n`
    ).toEqual([]);
  });

  it("the column allowlist stays real (no stale table, column, or entry)", () => {
    const census = new Map(tables.map((t) => [t.table, t]));
    for (const entry of COLUMN_EXPORT_ALLOWLIST) {
      const t = census.get(entry.table);
      expect(
        t,
        `${entry.table} has no dataset (or is FHIR-carved-out) — remove its column allowlist entry`
      ).toBeDefined();
      expect(entry.columns.length).toBeGreaterThan(0);
      expect(entry.why.trim().length).toBeGreaterThan(0);
      for (const column of entry.columns) {
        expect(
          t!.physical,
          `${entry.table}.${column} is not a column of ${entry.table}`
        ).toContain(column);
        expect(
          t!.exported.has(column),
          `${entry.table}.${column} IS exported — remove it from the allowlist`
        ).toBe(false);
      }
    }
    // One entry per table, so a reader finds every excluded column in one place.
    const seen = COLUMN_EXPORT_ALLOWLIST.map((e) => e.table);
    expect(seen).toEqual([...new Set(seen)]);
  });

  it("the FHIR carve-out is exactly the tables the passport also carries", () => {
    for (const table of carvedOut) {
      expect(
        FHIR_INPUT_TABLES.has(table),
        `${table} is carved out of the column guard but is not a FHIR input table`
      ).toBe(true);
    }
    // Named and counted: this exemption cannot quietly grow.
    expect(carvedOut.length).toBe(10);
  });

  it("what a dataset selects reaches the CSV as well as the JSON", () => {
    const named = new Set(
      CSV_OMITTED_RESULT_COLUMNS.map((c) => `${c.key}.${c.column}`)
    );
    const undeclared = csvOmitted
      .map((c) => `${c.key}.${c.column}`)
      .filter((c) => !named.has(c));
    expect(
      undeclared,
      `\nSelected into datasets/<key>.json but missing from the CSV header (dataset \`columns\`):\n${undeclared.join("\n")}\n`
    ).toEqual([]);
    // …and nothing is declared that no longer diverges.
    const actual = new Set(csvOmitted.map((c) => `${c.key}.${c.column}`));
    for (const c of CSV_OMITTED_RESULT_COLUMNS) {
      expect(
        actual.has(`${c.key}.${c.column}`),
        `${c.key}.${c.column} is in the CSV now — remove its entry`
      ).toBe(true);
      expect(c.why.trim().length).toBeGreaterThan(0);
    }
  });
});
