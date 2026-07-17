// DB INTEGRATION TIER — export COMPLETENESS binding (issue #465).
//
// The export-side twin of the #201/#212 import-footprint disease: tables added after
// the export feature never joined it, and nothing bound DATASETS to the schema. This
// test is the established cure — it DERIVES the completeness obligation from
// OWNED_TABLES so a new profile-owned table can no longer be silently absent from the
// portable export a family relies on when migrating off an instance.
//
// It lives in the DB tier (not the pure tier) only because importing lib/export pulls
// in the SQLite handle; the assertions themselves are structural (no rows needed).

import { describe, it, expect } from "vitest";
import { DATASETS } from "@/lib/export";
import { OWNED_TABLES } from "@/lib/owned-tables";
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
    table: "starred_biomarkers",
    why: "UI pin state (which biomarkers are starred)",
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
    table: "import_tombstones",
    why: "re-import suppression bookkeeping (merged/deleted source-owned natural keys); operational dedup state, not health data",
  },
  {
    table: "ai_usage_counters",
    why: "per-day AI rate-limit counters; operational, not health data",
  },
  {
    table: "deleted_rows",
    why: "24h undo holding buffer (tombstones); transient, purged on a timer",
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
    table: "symptom_photos",
    why: "symptom-day rash-progression photos (#859 item 4). PHI-cautious by design — photos are EXCLUDED from share-link summaries and the printable by default, so they are intentionally NOT in the full data export either; the images are binary blobs on disk (data/uploads/symptom-photos/<profileId>/) with only a thin date/caption row here, and are unlinked with the profile on delete.",
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
  // which is not part of the FHIR passport export today (a dedicated imaging exporter
  // is a documented follow-up). DocumentReference is inherently a pointer type the
  // exporter would never emit. Excluded from the "must be exported" direction only —
  // NOT from "everything exported is consumable" (that direction still binds).
  const IMPORT_ONLY_STRUCTURED_FEEDS = new Set([
    "ImagingStudy",
    "DocumentReference",
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
