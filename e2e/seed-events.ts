// Extra e2e fixture rows layered on top of the normal sample seed (scripts/seed.ts):
// a few integration sync events so the Data → Review inbox has content to render,
// including one currently-failing provider (Strava) that must surface under
// "Needs attention" and drive the profile-menu badge. Runs against the same
// ALLOS_DB_PATH the webServer boots with (see playwright.config.ts).
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { db } from "../lib/db";
import { writeRawPayload } from "../lib/integrations/raw-log";

const PROFILE_ID = 1;

db.prepare(
  `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider IN ('strava','health-connect')`
).run(PROFILE_ID);

// Capture a raw payload file for the healthy Health Connect sync so the admin-only
// "View raw" affordance (#9) has something to fetch. Synthetic fixture content —
// no real PHI. writeRawPayload writes under data/integration-payloads/<profile>/
// (the same dir the raw route reads), returning the bare ref stored on the event.
const hcRawRef = writeRawPayload(
  PROFILE_ID,
  "health-connect",
  JSON.stringify(
    {
      records: [
        { type: "Steps", count: 8000, startTime: "2026-07-08T00:00:00Z" },
        { type: "HeartRate", bpm: 61, time: "2026-07-08T06:30:00Z" },
      ],
    },
    null,
    2
  )
);

const ins = db.prepare(
  `INSERT INTO integration_sync_events
     (profile_id, provider, at, ok, window_start, window_end,
      received, written, inserted, updated, unchanged, skipped, raw_ref, error)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// Two clean syncs, then a newer Strava failure — so Strava is "currently failing"
// (its latest event is the failure) while Health Connect is healthy. The Health
// Connect sync carries the #273 split (30 new + 10 changed + 2 skipped); the
// Strava sync is an all-unchanged re-scan of the rolling window ("nothing new").
ins.run(
  PROFILE_ID,
  "health-connect",
  "2026-07-08 07:00:00",
  1,
  "2026-07-06",
  "2026-07-08",
  42, // received
  40, // written (inserted + updated + unchanged)
  30, // inserted
  10, // updated
  0, // unchanged
  2, // skipped
  hcRawRef, // raw_ref → drives the admin "View raw" affordance (#9)
  null
);
ins.run(
  PROFILE_ID,
  "strava",
  "2026-07-08 08:00:00",
  1,
  "2026-07-01",
  "2026-07-08",
  6, // received
  6, // written
  0, // inserted
  0, // updated
  6, // unchanged → "nothing new"
  0, // skipped
  null, // raw_ref
  null
);
ins.run(
  PROFILE_ID,
  "strava",
  "2026-07-09 09:00:00",
  0,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null, // raw_ref
  "Strava token refresh failed (401): unauthorized"
);

// ── Duplicate/conflict fixtures (issue #10, Phase 2) ──────────────────────────
// A cross-source ACTIVITY pair on one day: a manually-logged "Morning run" and a
// Strava-imported run with overlapping clock times — a HIGH-confidence duplicate
// the Review inbox must surface with merge/keep-both/dismiss actions. Clear any
// prior fixtures first so re-seeding is idempotent. Synthetic data only.
const DUP_DATE = "2026-07-07";
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND date = ? AND (source = 'strava' OR title IN ('Morning run', 'Afternoon Run'))`
).run(PROFILE_ID, DUP_DATE);
db.prepare(`DELETE FROM import_pair_decisions WHERE profile_id = ?`).run(
  PROFILE_ID
);

const insActivity = db.prepare(
  `INSERT INTO activities
     (profile_id, date, type, title, duration_min, distance_km,
      start_time, end_time, source, external_id, edited)
   VALUES (?, ?, 'cardio', ?, ?, ?, ?, ?, ?, ?, 0)`
);
// Manual entry (source NULL): the user's own "Morning run".
insActivity.run(
  PROFILE_ID,
  DUP_DATE,
  "Morning run",
  32,
  5.0,
  "08:00",
  "08:32",
  null,
  null
);
// Strava import of the same run, overlapping times → detected as a duplicate.
insActivity.run(
  PROFILE_ID,
  DUP_DATE,
  "Afternoon Run",
  33,
  5.1,
  "08:02",
  "08:35",
  "strava",
  "strava:e2e-run-1"
);

// ── Unified import-feed fixtures (issue #208 / #212) ──────────────────────────
// The Data → Review feed merges background syncs with uploaded documents and
// pasted/CSV jobs. Plant one of each so the feed proves it renders every stream,
// not just integration syncs. Synthetic filenames/content only — no real PHI.
// Clear prior e2e fixtures first so re-seeding stays idempotent.
db.prepare(
  `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN ('e2e-labs.pdf', 'e2e-broken.txt')`
).run(PROFILE_ID);
db.prepare(
  `DELETE FROM import_jobs WHERE profile_id = ? AND summary = 'e2e: 4 readings'`
).run(PROFILE_ID);

// A successfully-extracted document (7 records) — links to its /import/[id] detail.
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

console.log(
  "e2e: seeded integration_sync_events (strava failing) + a cross-source duplicate activity pair + import-feed document/job fixtures"
);
