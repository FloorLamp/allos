// e2e seed fixtures — imports domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import path from "node:path";
import { zonedWallTimeToUtc, utcSqlString } from "../../lib/date";
import { db, today } from "../../lib/db";
import { getTimezone } from "../../lib/settings";
import { PROFILE_ID } from "./common";
import { PARITY_MED_NAME } from "./intake";

// ── Unified import-feed fixtures ──
// The tabbed records-browser document's fixed id. Module-scope + exported because
// ./medical hangs one allergy row off the SAME document (the #384 allergy twins).
export const BROWSER_DOC_ID = 908;

export function seedImportFeed(): void {
  // ── Unified import-feed fixtures ──────────────────────────
  // The Data → Review feed merges background syncs with uploaded documents and
  // pasted/CSV jobs. Plant one of each so the feed proves it renders every stream,
  // not just integration syncs. Synthetic filenames/content only — no real PHI.
  // Clear prior e2e fixtures first so re-seeding stays idempotent.
  db.prepare(
    `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN ('e2e-labs.pdf', 'e2e-broken.txt', 'e2e-mychart-export.xml')`
  ).run(PROFILE_ID);
  db.prepare(
    `DELETE FROM import_jobs WHERE profile_id = ? AND summary = 'e2e: 4 readings'`
  ).run(PROFILE_ID);

  // A successfully-extracted document (7 items) — links to its /import/[id] detail.
  db.prepare(
    `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
      extraction_status, extracted_count, uploaded_at)
   VALUES (?, 'e2e-labs.pdf', '', 'application/pdf', 4096, 'Lab report',
           'done', 7, '2026-07-08 12:00:00')`
  ).run(PROFILE_ID);
  // A rejected upload (issue #58 magic-byte / unsupported): inserted straight into a
  // terminal 'failed' state, so the feed must still surface it.
  db.prepare(
    `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes,
      extraction_status, extraction_error, uploaded_at)
   VALUES (?, 'e2e-broken.txt', '', 'text/plain', 12,
           'failed', 'Unsupported file type.', '2026-07-08 11:30:00')`
  ).run(PROFILE_ID);
  // A pasted/CSV import job awaiting review.
  db.prepare(
    `INSERT INTO import_jobs
     (profile_id, type, status, summary, created_at, updated_at)
   VALUES (?, 'biomarkers', 'ready', 'e2e: 4 readings',
           '2026-07-08 11:00:00', '2026-07-08 11:00:00')`
  ).run(PROFILE_ID);

  // A deterministic HEALTH-RECORD document (source='ccda') with a non-empty
  // stored_path so it counts in the "Re-extract all documents" cost preview (issue
  // #208) as a re-imported-instantly, no-AI document — alongside the seed's AI
  // scan/PDF (labcorp-panel.pdf, source='upload'). Together they make the cost line
  // show BOTH kinds. The stored_path is fake (the e2e only opens the confirm dialog
  // and cancels — it never actually re-extracts), so no blob on disk is needed.
  db.prepare(
    `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes, doc_type, source,
      extraction_status, extracted_count, uploaded_at)
   VALUES (?, 'e2e-mychart-export.xml', 'data/uploads/medical/1/e2e-nonexistent.xml',
           'application/xml', 8192, 'MyChart export (CCD/XDM)', 'ccda',
           'done', 5, '2026-07-08 10:30:00')`
  ).run(PROFILE_ID);

  console.log(
    "e2e: seeded integration_sync_events (strava failing) + a cross-source duplicate activity pair + import-feed document/job fixtures"
  );
}

// ── Import-detail drop-report fixture ──
export function seedDropReport(): void {
  // ── Import-detail drop-report fixture (issue #270) ────────────────────────────
  // A 'done' document carrying a stored import_report with (a) a reason-group of
  // HUNDREDS of identical drops (the real-world CCD noise that made the Dropped
  // section unusable) that must collapse to one ×N row, (b) enough DISTINCT drops
  // that the collapsed list still overflows the card's viewport bound (proving the
  // scroll containment), and (c) an unmapped lab code driving the "Report unmapped
  // code" prefill. Fixed id so the spec can navigate straight to /import/907.
  // All content synthetic — fictional analyte names, no values/dates/PHI in drops.
  const DROP_DOC_ID = 907;
  db.prepare(`DELETE FROM medical_documents WHERE id = ?`).run(DROP_DOC_ID);
  const dropReport = {
    drops: [
      // 220 identical null-flavored "Comment(s)" rows from Results → one ×220 row.
      ...Array.from({ length: 220 }, () => ({
        kind: "lab",
        label: "Comment(s)",
        reason: "null_flavor",
        section: "Results",
      })),
      // 40 distinct value-less labs → 40 collapsed rows (the list must scroll).
      ...Array.from({ length: 40 }, (_, i) => ({
        kind: "lab",
        label: `E2E Panel Item ${String(i + 1).padStart(2, "0")}`,
        reason: "no_value",
        section: "Results",
      })),
    ],
    coverage: [
      { key: "results", title: "Results", consumed: true, present: 272 },
      // Recognized-but-ignored (#268): must render under "Recognized, not
      // imported", NOT as a present-but-not-consumed gap.
      {
        key: "insurance",
        title: "Insurance",
        consumed: false,
        present: 4,
        ignored: true,
      },
      // A genuinely unrecognized section stays in "Present but not consumed".
      {
        key: "E2E Mystery Section",
        title: "E2E Mystery Section",
        consumed: false,
        present: 2,
      },
    ],
    imported: 12,
    considered: 272,
    unmappedLoincs: [
      { loinc: "11111-1", name: "E2E Novel Marker", unit: "ng/mL", count: 3 },
    ],
    // Unresolved analyte NAMES (#918 §4), stored in the pre-#2313 flat shape — one
    // genuine gap alongside two names the repo has since DECLARED it doesn't curate.
    // The split happens on read, so this fixture is also the retroactivity proof:
    // nothing about the stored blob knows about the registry.
    unresolvedNames: [
      { name: "E2E Unknown Analyte", count: 2, unit: "ng/mL" },
      { name: "eGFR, African American", count: 1, unit: "mL/min/1.73" },
      { name: "Diuretic Screen, Urine", count: 1, unit: null },
    ],
    // Source-text reconciliation flags (AI PDF path): one of each verdict, so the
    // "Source reconciliation" card renders with both badge variants. Synthetic
    // analyte names; the value is a bare number with no unit/date context.
    reconciliation: {
      confirmed: 10,
      total: 12,
      flags: [
        {
          name: "E2E Mismatch Marker",
          value: "999",
          verdict: "value_mismatch",
        },
        { name: "E2E Phantom Marker", value: "1", verdict: "name_not_found" },
      ],
    },
  };
  db.prepare(
    `INSERT INTO medical_documents
     (id, profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
      source, extraction_status, extracted_count, import_report, uploaded_at)
   VALUES (?, ?, 'e2e-drop-report.xml', '', 'application/xml', 2048,
           'MyChart export (CCD/XDM)', 'ccda', 'done', 12, ?,
           '2026-07-08 09:45:00')`
  ).run(DROP_DOC_ID, PROFILE_ID, JSON.stringify(dropReport));

  // A second document whose unresolved list is ENTIRELY declared names (#2313):
  // the "Unresolved analytes" card must not render at all here, because there is
  // no outstanding work — the honest answer. Its own id so the spec owns it and
  // 907's counts stay undisturbed.
  const DECLINED_ONLY_DOC_ID = 911;
  db.prepare(`DELETE FROM medical_documents WHERE id = ?`).run(
    DECLINED_ONLY_DOC_ID
  );
  db.prepare(
    `INSERT INTO medical_documents
     (id, profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
      source, extraction_status, extracted_count, import_report, uploaded_at)
   VALUES (?, ?, 'e2e-declined-only.pdf', '', 'application/pdf', 1024,
           'Lab report', 'upload', 'done', 3, ?,
           '2026-07-08 09:50:00')`
  ).run(
    DECLINED_ONLY_DOC_ID,
    PROFILE_ID,
    JSON.stringify({
      drops: [],
      coverage: [
        { key: "results", title: "Results", consumed: true, present: 3 },
      ],
      imported: 3,
      considered: 3,
      unresolvedNames: [
        { name: "eGFR, Non-African-American", count: 1, unit: "mL/min/1.73" },
        { name: "eGFR, Thai", count: 1, unit: "mL/min/1.73" },
        { name: "Beta Adrenergic Blocker Screen", count: 1, unit: null },
      ],
    })
  );

  console.log(
    `e2e: seeded import document ${DROP_DOC_ID} with a 260-drop report + an unmapped LOINC (#270), and ${DECLINED_ONLY_DOC_ID} with declared-only unresolved names (#2313)`
  );
}

// ── Import-detail + Review-feed extraction-confidence fixture ──
export function seedExtractionConfidence(): void {
  // ── Extraction-confidence fixture (issue #1601) ───────────────────────────────
  // An AI-EXTRACTED document (source 'upload') whose stored import_report carries a
  // per-record confidence summary: 3 rows the extractor hedged on (one low, two
  // medium — one of them without a reason) among 6 rows total. It drives BOTH review
  // surfaces: /import/906's "Check these first" card (ranked lowest-first, with a
  // per-row tier badge) and the Data → Review feed row's "· 3 to check" badge.
  // Fixed id 906 so the spec navigates straight to it and owns its own fixture.
  // All content synthetic — fictional analyte/condition names, no values or PHI.
  const CONFIDENCE_DOC_ID = 906;
  db.prepare(`DELETE FROM medical_records WHERE document_id = ?`).run(
    CONFIDENCE_DOC_ID
  );
  db.prepare(`DELETE FROM conditions WHERE document_id = ?`).run(
    CONFIDENCE_DOC_ID
  );
  db.prepare(`DELETE FROM medical_documents WHERE id = ?`).run(
    CONFIDENCE_DOC_ID
  );
  const confidenceReport = {
    drops: [],
    coverage: [],
    imported: 6,
    considered: 6,
    confidence: {
      counts: { high: 3, medium: 2, low: 1, unknown: 0 },
      scrutiny: 3,
      // Stored lowest-first exactly as the writer ranked it (and re-ranked on parse).
      flags: [
        {
          kind: "lab",
          label: "E2E Smudged Marker",
          confidence: "low",
          reason: "printed figure partly illegible",
        },
        {
          kind: "lab",
          label: "E2E Ambiguous Marker",
          confidence: "medium",
          reason: "unit could be mg/dL or mmol/L",
        },
        // A hedged row with NO reason — the card must still render it.
        {
          kind: "condition",
          label: "E2E Possible Condition",
          confidence: "medium",
          reason: null,
        },
      ],
    },
  };
  db.prepare(
    `INSERT INTO medical_documents
     (id, profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
      source, extraction_status, extracted_count, import_report, uploaded_at)
   VALUES (?, ?, 'e2e-confidence-labs.pdf', '', 'application/pdf', 3072,
           'Lab report', 'upload', 'done', 6, ?, '2026-07-08 09:40:00')`
  ).run(CONFIDENCE_DOC_ID, PROFILE_ID, JSON.stringify(confidenceReport));

  // The six rows the report describes, actually present — so the feed's produced
  // count ("6 items") agrees with the card's "3 of 6 rows" instead of reading as
  // #1339 drift. Two of the labs are the hedged ones the card ranks first.
  const insConfidenceRecord = db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, canonical_name, value, unit,
      document_id, source)
   VALUES (?, '2026-07-01', 'lab', ?, ?, ?, 'mg/dL', ?, 'upload')`
  );
  for (const [name, value] of [
    ["E2E Smudged Marker", "18"],
    ["E2E Ambiguous Marker", "7"],
    ["E2E Clear Marker One", "42"],
    ["E2E Clear Marker Two", "43"],
    ["E2E Clear Marker Three", "44"],
  ]) {
    insConfidenceRecord.run(PROFILE_ID, name, name, value, CONFIDENCE_DOC_ID);
  }
  db.prepare(
    `INSERT INTO conditions (profile_id, name, status, document_id, source)
   VALUES (?, 'E2E Possible Condition', 'active', ?, 'upload')`
  ).run(PROFILE_ID, CONFIDENCE_DOC_ID);

  console.log(
    `e2e: seeded import document ${CONFIDENCE_DOC_ID} with a per-record extraction-confidence summary (#1601)`
  );
}

// ── Import-detail records browser + type-appropriate panels ──
export function seedRecordsBrowser(): void {
  // ── Import-detail tabbed records-browser fixture (issue #271) ─────────────────
  // A 'done' document that produced rows across several kinds — labs + a projected
  // medication (intake_items, the single medication entity an imported prescription
  // becomes post-#1178 — never a medical_records 'prescription' row, #1232), a
  // visit, a condition, an immunization, and a referenced provider — so the records
  // browser has a multi-tab strip to render: default tab, ?tab= selection,
  // category-correct row links (the medication → /medications regression), the
  // read-only visit listing deep-linking to /encounters/[id], and the Providers
  // chip (linking to /providers). Fixed id 908; all content synthetic (fictional
  // analytes/clinic/patient — no real PHI).
  const BROWSER_DOC_SOURCE = `document:${BROWSER_DOC_ID}`;
  db.prepare(`DELETE FROM medical_records WHERE document_id = ?`).run(
    BROWSER_DOC_ID
  );
  // FK is ON (lib/db.ts), so this cascades the med's doses/courses/logs.
  db.prepare(
    `DELETE FROM intake_items WHERE profile_id = ? AND document_id = ?`
  ).run(PROFILE_ID, BROWSER_DOC_ID);
  db.prepare(`DELETE FROM encounters WHERE document_id = ?`).run(
    BROWSER_DOC_ID
  );
  db.prepare(`DELETE FROM conditions WHERE document_id = ?`).run(
    BROWSER_DOC_ID
  );
  db.prepare(`DELETE FROM immunizations WHERE source = ?`).run(
    BROWSER_DOC_SOURCE
  );
  db.prepare(`DELETE FROM medical_documents WHERE id = ?`).run(BROWSER_DOC_ID);
  // A tiny, synthetic CCD-shaped raw so the Debug → Raw extraction panel exercises the
  // shared RawDataViewer's XML tree mode (#1318): nested elements + attributes, all
  // obviously-fictional (Test Patient, made-up codes) — no real PHI.
  const BROWSER_DOC_RAW_XML = `<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget>
    <patientRole>
      <id extension="E2E-000" root="2.16.840.1.113883.19.5"/>
      <patient>
        <name><given>Test</given><family>Patient</family></name>
        <birthTime value="19900101"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>
      <component>
        <section>
          <title>Results</title>
          <entry>
            <observation classCode="OBS">
              <code code="E2E-FER" displayName="Ferritin"/>
              <value unit="ng/mL" value="95"/>
            </observation>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>`;
  db.prepare(
    `INSERT INTO medical_documents
     (id, profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
      source, extraction_status, extracted_count, uploaded_at, raw_extraction)
   VALUES (?, ?, 'e2e-records-browser.xml', '', 'application/xml', 4096,
           'MyChart export (CCD/XDM)', 'ccda', 'done', 6, '2026-07-08 09:50:00', ?)`
  ).run(BROWSER_DOC_ID, PROFILE_ID, BROWSER_DOC_RAW_XML);
  // A provider referenced by one lab row → the Providers count chip shows 1.
  db.prepare(
    `DELETE FROM providers WHERE dedup_key = 'e2e-browser-clinic'`
  ).run();
  const browserProviderId = Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, dedup_key)
       VALUES ('E2E Browser Clinic', 'organization', 'e2e-browser-clinic')`
      )
      .run().lastInsertRowid
  );
  // Give the scheduled medication fixture a structured provider as well as its
  // legacy free-text prescriber. The med itself is seeded by ./intake
  // (seedMedicationCards), which runs earlier — re-resolve it by its unique name.
  const parityMedId = (
    db
      .prepare(`SELECT id FROM intake_items WHERE profile_id = ? AND name = ?`)
      .get(PROFILE_ID, PARITY_MED_NAME) as { id: number }
  ).id;
  // The medication detail can then prove that a registry-backed provider navigates
  // to the provider detail page.
  db.prepare(
    `UPDATE intake_items
      SET provider_id = ?
    WHERE id = ? AND profile_id = ? AND kind = 'medication'`
  ).run(browserProviderId, parityMedId, PROFILE_ID);
  const insBrowserRecord = db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, value_num, unit, panel,
      canonical_name, document_id, provider_id, source)
   VALUES (?, '2026-06-20', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ccda')`
  );
  insBrowserRecord.run(
    PROFILE_ID,
    "lab",
    "Ferritin",
    "95",
    95,
    "ng/mL",
    "E2E Iron Panel",
    "Ferritin",
    BROWSER_DOC_ID,
    browserProviderId
  );
  insBrowserRecord.run(
    PROFILE_ID,
    "lab",
    "E2E Novel Lab",
    "1.2",
    1.2,
    "mg/L",
    "E2E Iron Panel",
    null,
    BROWSER_DOC_ID,
    null
  );
  // The document's projected MEDICATION (#1178/#1232): the current single-entity
  // shape persistExtractedMedications writes for a CCD prescription — a
  // kind='medication' intake_items row (source='extracted', document_id, the
  // stable `medimport:` import_key), the strength carried on a dose row (an
  // as-needed med, no fabricated reminder), and an initial open course. Loratadine
  // pairs with the seeded "E2E Hay fever" condition and is off the curated
  // interaction/allergy sets, so it adds no warnings to shared surfaces.
  const browserMedId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
         (name, notes, active, condition, obligation, kind, document_id, source, provider_id, import_key, profile_id)
         VALUES (?, NULL, 1, 'daily', 'may', 'medication', ?, 'extracted', NULL, ?, ?)`
      )
      .run(
        "E2E Loratadine",
        BROWSER_DOC_ID,
        `medimport:${BROWSER_DOC_ID}|e2e loratadine`,
        PROFILE_ID
      ).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
   VALUES (?, '10 mg', NULL, 'any', 0)`
  ).run(browserMedId);
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on) VALUES (?, '2026-06-20')`
  ).run(browserMedId);
  db.prepare(
    `INSERT INTO encounters
     (profile_id, date, type, class_code, reason, document_id, source)
   VALUES (?, '2026-06-20', 'E2E Browser Visit', 'AMB', 'E2E annual physical', ?, 'ccda')`
  ).run(PROFILE_ID, BROWSER_DOC_ID);
  db.prepare(
    `INSERT INTO conditions (profile_id, name, status, document_id, source)
   VALUES (?, 'E2E Hay fever', 'active', ?, 'ccda')`
  ).run(PROFILE_ID, BROWSER_DOC_ID);
  db.prepare(
    `INSERT INTO immunizations (profile_id, date, vaccine, dose_label, source)
   VALUES (?, '2026-06-20', 'E2E Tdap', 'booster', ?)`
  ).run(PROFILE_ID, BROWSER_DOC_SOURCE);

  console.log(
    `e2e: seeded import document ${BROWSER_DOC_ID} with labs + medication + visit + condition + immunization for the records browser (#271)`
  );

  // ── Import-detail type-appropriate panels fixture (issue #1182) ──────────────
  // A 'done' document that produced BOTH an analyte category (a lab, with a value/
  // unit/reference band → the editable analyte grid) AND a non-analyte category (a
  // vitals BP row → the read-only value/date table, no "Panel"/"Reference"
  // columns), plus one referenced provider (an organization → the promoted
  // Providers listing linking to /providers/[id], no longer a bare count chip).
  // Dedicated id 909 so the #1182 presentation spec owns its own fixture and never
  // perturbs 908's default-tab/count assertions. All content synthetic — no PHI.
  const PANELS_DOC_ID = 909;
  db.prepare(`DELETE FROM medical_records WHERE document_id = ?`).run(
    PANELS_DOC_ID
  );
  db.prepare(`DELETE FROM medical_documents WHERE id = ?`).run(PANELS_DOC_ID);
  db.prepare(
    `INSERT INTO medical_documents
     (id, profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
      source, extraction_status, extracted_count, uploaded_at)
   VALUES (?, ?, 'e2e-produced-panels.xml', '', 'application/xml', 4096,
           'MyChart export (CCD/XDM)', 'ccda', 'done', 2, '2026-07-09 09:50:00')`
  ).run(PANELS_DOC_ID, PROFILE_ID);
  db.prepare(`DELETE FROM providers WHERE dedup_key = 'e2e-panels-lab'`).run();
  const panelsProviderId = Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, dedup_key)
       VALUES ('E2E Panels Lab', 'organization', 'e2e-panels-lab')`
      )
      .run().lastInsertRowid
  );
  const insPanelsRecord = db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, value_num, unit, panel,
      reference_range, canonical_name, document_id, provider_id, source)
   VALUES (?, '2026-06-21', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ccda')`
  );
  // Analyte category → keeps the editable analyte grid (Panel + Reference columns).
  insPanelsRecord.run(
    PROFILE_ID,
    "lab",
    "E2E Sodium",
    "140",
    140,
    "mmol/L",
    "E2E Basic Metabolic Panel",
    "135–145",
    "Sodium",
    PANELS_DOC_ID,
    panelsProviderId
  );
  // Vitals (non-analyte) → the read-only value/date table: no Panel, no Reference
  // band. A BP pair recorded as one row (systolic/diastolic).
  insPanelsRecord.run(
    PROFILE_ID,
    "vitals",
    "E2E Blood Pressure",
    "128/82",
    null,
    "mmHg",
    null,
    null,
    null,
    PANELS_DOC_ID,
    null
  );
  console.log(
    `e2e: seeded import document ${PANELS_DOC_ID} with a lab + a vitals row + a provider for the type-appropriate panels (#1182)`
  );

  // The old records-bridge fixture (#817/#852) seeded documentless medical_records
  // category='prescription' rows here. Removed by #1232: migration 092 consolidated
  // every such row into the single medication entity (intake_items) and NO current
  // write path produces the shape anymore, so the fixture was re-creating a state
  // the app itself can never reach (failure class 7 — a fixture feeding a dead
  // legacy read path). The "From your records" bridge itself was then removed
  // outright (UI/actions/generator) in #1270; only a stored `med-bridge:` dismissal
  // survives, exercised by the suppressed-center orphan fixture below.

  // An imported visit whose notes carry a real line break (issue #794 cluster 11a),
  // so the encounter-detail notes test can pin that multi-line notes render with
  // their breaks preserved (whitespace-pre-wrap) instead of flattening to one run-on
  // line. Fixed id so the browser test deep-links deterministically; char(10) is the
  // embedded newline. All content synthetic — no real PHI.
  const MULTILINE_ENCOUNTER_ID = 9071;
  db.prepare(`DELETE FROM encounters WHERE id = ?`).run(MULTILINE_ENCOUNTER_ID);
  db.prepare(
    `INSERT INTO encounters
     (id, profile_id, date, type, class_code, reason, notes, source)
   VALUES (?, ?, '2026-06-18', 'E2E Imported Visit', 'AMB', 'E2E follow-up',
           'E2E imported note line one.' || char(10) || 'E2E imported note line two.',
           'ccda')`
  ).run(MULTILINE_ENCOUNTER_ID, PROFILE_ID);

  // Two due-today doses on the primary profile whose bucket order is the REVERSE of
  // their alphabetical order (issue #297): a MORNING dose named with a leading "Z"
  // and a BEDTIME dose named with a leading "A". Before the fix the Upcoming Today
  // band dropped time_of_day and sorted by title, so the bedtime "A…" came first;
  // after it, the morning "Z…" leads because Morning outranks Before-sleep. Both are
  // daily + active with no taken-log today, so they surface as due. Fully synthetic.
  //
  // STAMPED FROM THE FROZEN CLOCK, not SQL's `datetime('now')` default. These rows
  // are dose LIFETIME anchors, and the dose-existence bound (`doseExistsSince`,
  // lib/intake-adherence) uses them to decide which nights/days a dose was even
  // alive for — so leaving them on real wall-clock silently coupled a fixture to
  // real-vs-frozen skew. Concretely: the Sleep hero's bedtime-supplement line
  // (lib/queries/sleep.ts) excludes a dose whose lifetime starts AFTER the night it
  // is summarizing (`sleepDate < since`), and last night's sleepDate is frozen-today
  // − 1. With `created_at` = REAL today and `today()` = FROZEN today the two
  // normally agree and this bedtime dose is correctly excluded from last night. But
  // inside #1464's hazard window the freeze instant is nudged FORWARD across UTC
  // midnight — frozen date D+1, real date still D — so `since` = D and `sleepDate` =
  // D, the strict `<` no longer holds, and this NEIGHBOR fixture leaked into
  // sleep-page.spec's hero assertion as a second due bedtime supplement ("1 of 2
  // taken" instead of "All taken"). Deterministic for a ~30-minute band each day, on
  // any branch. Dating from `today()` puts the anchor on the same clock every
  // consumer reads, so the exclusion is intentional rather than an accident of when
  // the suite happened to run.
  //
  // The anchor is a real INSTANT for profile-local midnight, not the naive string
  // `${today()} 00:00:00`. `created_at` columns are UTC SQL, and the bound converts
  // them back to the profile's calendar day, so a naive local wall-time stored as if
  // it were UTC reads a day EARLY under the #1103 pin (Etc/GMT+10 → local 14:00 the
  // previous day) and the dose stopped being excluded from last night at all. Same
  // rule as every other profile-local fixture instant: build it with
  // zonedWallTimeToUtc(getTimezone(profile), day, "HH:MM")!.
  const DOSE_ORDER_MORNING = "Zeaxanthin Morning (e2e)";
  const DOSE_ORDER_BEDTIME = "Ashwagandha Bedtime (e2e)";
  const doseOrderCreatedAt = utcSqlString(
    zonedWallTimeToUtc(getTimezone(PROFILE_ID), today(PROFILE_ID), "00:00")!
  );
  for (const [name, timeOfDay, amount] of [
    [DOSE_ORDER_MORNING, "morning", "1 cap"],
    [DOSE_ORDER_BEDTIME, "bedtime", "300 mg"],
  ] as const) {
    if (
      !db
        .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
        .get(PROFILE_ID, name)
    ) {
      const supp = db
        .prepare(
          `INSERT INTO intake_items
           (profile_id, name, condition, obligation, active, source, created_at)
         VALUES (?, ?, 'daily', 'should', 1, 'manual', ?)`
        )
        .run(PROFILE_ID, name, doseOrderCreatedAt);
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
       VALUES (?, ?, ?, 'any', 0, ?)`
      ).run(
        Number(supp.lastInsertRowid),
        amount,
        timeOfDay,
        doseOrderCreatedAt
      );
    }
  }

  console.log(
    `e2e: seeded morning + bedtime due doses on profile ${PROFILE_ID} for the dose-order spec (#297)`
  );
}

// ── Import-detail triage-link fixture ──
export function seedTriageLinks(): void {
  // ── "Check these first" → the row it names (issue #2339) ──────────────────────
  // The confidence card names rows that are already rendered below it, so each
  // flagged row is a LINK. This fixture plants one document (id 910) carrying all
  // three resolutions at once, because the two unhappy ones are the contract:
  //
  //   • a label naming exactly ONE row      → links at that row, on its own tab
  //   • a label naming SEVERAL rows         → filters the tab, selects none
  //   • a label naming NO row (since edited
  //     or deleted)                         → says so, and is not a link at all
  //
  // It also spans two tabs (a lab and a condition), so the "switch to the owning
  // tab" half is exercised rather than assumed. The report describes 6 extracted
  // rows; 5 remain, because the vanished one is exactly the row a reviewer deleted
  // after extraction. All content synthetic — fictional analyte/condition names.
  const TRIAGE_DOC_ID = 910;
  db.prepare(`DELETE FROM medical_records WHERE document_id = ?`).run(
    TRIAGE_DOC_ID
  );
  db.prepare(`DELETE FROM conditions WHERE document_id = ?`).run(TRIAGE_DOC_ID);
  db.prepare(`DELETE FROM medical_documents WHERE id = ?`).run(TRIAGE_DOC_ID);
  const triageReport = {
    drops: [],
    coverage: [],
    imported: 6,
    considered: 6,
    confidence: {
      counts: { high: 2, medium: 2, low: 2, unknown: 0 },
      scrutiny: 4,
      // Stored lowest-first, as the writer ranked it.
      flags: [
        {
          kind: "lab",
          label: "E2E Faded Marker",
          confidence: "low",
          reason: "printed figure partly illegible",
        },
        {
          // Nothing carries this name any more — the row was deleted after import.
          kind: "lab",
          label: "E2E Vanished Marker",
          confidence: "low",
          reason: "value read from a torn corner",
        },
        {
          // TWO rows carry this name: the link must filter, never pick one.
          kind: "lab",
          label: "E2E Twin Marker",
          confidence: "medium",
          reason: "two panels report this name",
        },
        {
          // A different tab entirely — the link has to switch to it.
          kind: "condition",
          label: "E2E Uncertain Condition",
          confidence: "medium",
          reason: "diagnosis hedged in the note",
        },
      ],
    },
  };
  db.prepare(
    `INSERT INTO medical_documents
     (id, profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
      source, extraction_status, extracted_count, import_report, uploaded_at)
   VALUES (?, ?, 'e2e-triage-labs.pdf', '', 'application/pdf', 3072,
           'Lab report', 'upload', 'done', 6, ?, '2026-07-08 09:35:00')`
  ).run(TRIAGE_DOC_ID, PROFILE_ID, JSON.stringify(triageReport));
  const insTriageRecord = db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, canonical_name, value, unit,
      document_id, source)
   VALUES (?, '2026-07-02', 'lab', ?, ?, ?, 'mg/dL', ?, 'upload')`
  );
  for (const [name, value] of [
    ["E2E Faded Marker", "12"],
    // The twins: same name, different values — the ambiguity a reviewer must not
    // be sent to one half of.
    ["E2E Twin Marker", "31"],
    ["E2E Twin Marker", "33"],
    ["E2E Settled Marker", "70"],
  ]) {
    insTriageRecord.run(PROFILE_ID, name, name, value, TRIAGE_DOC_ID);
  }
  db.prepare(
    `INSERT INTO conditions (profile_id, name, status, document_id, source)
   VALUES (?, 'E2E Uncertain Condition', 'active', ?, 'upload')`
  ).run(PROFILE_ID, TRIAGE_DOC_ID);

  console.log(
    `e2e: seeded import document ${TRIAGE_DOC_ID} with resolvable / ambiguous / vanished confidence labels (#2339)`
  );
}
