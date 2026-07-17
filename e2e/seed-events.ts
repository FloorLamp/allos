// Extra e2e fixture rows layered on top of the normal sample seed (scripts/seed.ts):
// a few integration sync events so the Data → Review inbox has content to render,
// including one currently-failing provider (Strava) that must surface under
// "Needs attention" and drive the profile-menu badge. Runs against the same
// ALLOS_DB_PATH the webServer boots with (see playwright.config.ts).
import "../scripts/load-env";

import fs from "node:fs";
import path from "node:path";

import { db, today } from "../lib/db";
import { shiftDateStr, utcSqlString } from "../lib/date";
import { writeRawPayload } from "../lib/integrations/raw-log";
import { upsertConnection } from "../lib/integrations/connections";
import {
  setOnboardingState,
  setDashboardLayout,
  setProfileSetting,
  setSetting,
  setWeekMode,
} from "../lib/settings";
import { setMinTrainingAge } from "../lib/age-gate";
import { reconcileFlags } from "../lib/queries";
import { hashPasswordSync } from "../lib/password";
import { initialOnboardingState } from "../lib/onboarding";
import {
  E2E_LOGIN_CHILD,
  E2E_LOGIN_COMPARE,
  E2E_LOGIN_DUP,
  E2E_LOGIN_EMPTY_TRAINING,
  E2E_LOGIN_HC,
  E2E_LOGIN_NOGEAR,
  E2E_LOGIN_ROUTINE,
  E2E_LOGIN_ROUTINE_BUILDER,
  E2E_LOGIN_ROUTINE_DELOAD,
  E2E_LOGIN_ONBOARDING,
  E2E_LOGIN_ONBOARDING_CAREGIVER,
  E2E_LOGIN_ORIENTATION,
  E2E_LOGIN_STRAVA,
  E2E_MEMBER_PASSWORD,
  DUP_REVIEW_PROFILE,
  EMPTY_TRAINING_PROFILE,
  HEALTH_CONNECT_PROFILE,
  NO_GEAR_PROFILE,
  ROUTINE_BUILDER_PROFILE,
  ROUTINE_DELOAD_PROFILE,
  ROUTINE_PROFILE,
  ONBOARDING_CAREGIVER_PROFILE,
  ONBOARDING_PROFILE,
  ORIENTATION_PROFILE,
  SOURCE_COMPARE_PROFILE,
  STRAVA_REAUTH_PROFILE,
  E2E_LOGIN_SICK_SELF,
  SICK_SELF_PROFILE,
  E2E_LOGIN_SICK_COLLAPSE,
  SICK_COLLAPSE_PROFILE,
  E2E_LOGIN_CARE,
  CARE_PARENT_PROFILE,
  SICK_KID_A_PROFILE,
  SICK_KID_B_PROFILE,
  E2E_LOGIN_COCARE,
  COCARE_PARENT_PROFILE,
  E2E_LOGIN_CONDREV,
  CONDITION_REVIEW_PROFILE,
} from "./fixture-logins";
import { adoptTemplate, activateRoutine } from "../lib/routines";

// A persisted notification-delivery failure (#131) so Settings → Server surfaces
// the "Last notification delivery failed" marker for the e2e to assert. Synthetic
// error text — no PHI. Mirrors what dispatch() writes on a failed Telegram send.
setSetting(
  "notify_last_error",
  "Telegram API 401: Unauthorized (bot token revoked)"
);
setSetting("notify_last_error_at", "2026-07-09T08:00:00.000Z");
setSetting("notify_last_error_channel", "telegram");

// A persisted unexpected server error (#596) so Settings → Errors has a row to
// render for the admin-access e2e. Synthetic message — no PHI. Written straight
// to the errors.jsonl the admin page reads (data/logs/errors.jsonl), so the test
// doesn't need to provoke a real 500. Mirrors what recordErrorEvent appends.
// WRITE, not append: unlike the DB, errors.jsonl isn't reset between e2e runs,
// and a second appended copy of the same message would strict-mode-break the
// spec's getByText assertion.
{
  const errorLogPath = path.join(process.cwd(), "data", "logs", "errors.jsonl");
  fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
  const event = {
    id: `${Date.now()}-000000`,
    time: new Date().toISOString(),
    level: "error",
    scope: "e2e-seed",
    message: "Seeded server error for the admin errors surface",
    detail: "Error: synthetic failure\n    at seedEvents (e2e/seed-events.ts)",
    loginId: null,
    profileId: null,
  };
  fs.writeFileSync(errorLogPath, JSON.stringify(event) + "\n");
}

const PROFILE_ID = 1;

// Dense Journal-card fixture: the base seed already carries the full synthetic
// Strava payload; e2e adds only a deliberately long note and the hand-edit lock so
// disclosure + lock affordances can be exercised without another activity row.
db.prepare(
  `UPDATE activities
      SET notes = ?, edited = 1
    WHERE profile_id = ? AND external_id = 'strava:seed-ride-1'`
).run(
  "Synthetic training note: steady endurance work with controlled breathing through the first half, then a slightly stronger finish while keeping cadence smooth and effort comfortably below threshold.",
  PROFILE_ID
);

// Give one recent strength row an explicit met target so the card's visible and
// accessible status treatment is covered by the browser tier.
db.prepare(
  `UPDATE exercise_sets
      SET target_reps = reps
    WHERE activity_id = (
      SELECT id FROM activities
       WHERE profile_id = ? AND title = 'Push day'
       ORDER BY date DESC, id DESC LIMIT 1
    ) AND exercise = 'Barbell Bench Press'`
).run(PROFILE_ID);

db.prepare(
  `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider IN ('strava','health-connect')`
).run(PROFILE_ID);

// Mark Strava CONNECTED so the Data → Review "Connected sources" card shows the
// per-provider "Sync now" affordance (issue #208) rather than a "Connect" link.
// Synthetic config only — the e2e never taps Sync now (it would hit the network), it
// only asserts the button renders. Health Connect stays unconnected → its card shows
// the push-only explainer.
upsertConnection(PROFILE_ID, "strava", {
  status: "connected",
  config: { clientId: "e2e-client", accessToken: "e2e-token" },
});

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

// One meaningful Health Connect sync, then a RUN of hourly all-unchanged Strava
// re-scans (the "nothing new every hour" spam of issue #137), then a newer Strava
// failure — so Strava is "currently failing" (its latest event is the failure)
// while Health Connect is healthy. The Health Connect sync carries the split (30
// new + 10 changed + 2 skipped). The four consecutive Strava no-ops (all ok=1,
// 0 inserted + 0 updated) must COLLAPSE into a single "No new data · 4 checks"
// line in the Review feed rather than four rows. The failure below stays newest so
// the "currently failing" surface is unaffected.
//
// NOTE: these timestamps are deliberately fixed past dates, NOT relative to today.
// Nothing compares them against `now`/`today()` — the feed sorts them purely by
// string and "currently failing" is decided by per-provider ordering within this
// block — so they can't drift or collide with a relative fixture the way a
// hardcoded date in a table that ALSO has daysAgo() rows can. The only invariant
// is that the failure sorts newest among Strava and the no-ops stay consecutive.
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
// Four consecutive hourly Strava no-op re-scans (05:00–08:00) → one collapsed line.
for (const hour of ["05", "06", "07", "08"]) {
  ins.run(
    PROFILE_ID,
    "strava",
    `2026-07-08 ${hour}:00:00`,
    1,
    "2026-07-01",
    "2026-07-08",
    6, // received
    6, // written
    0, // inserted
    0, // updated
    6, // unchanged → no new data
    0, // skipped
    null, // raw_ref
    null
  );
}
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

// Issue #294: a source that was CONNECTED and later removed keeps showing its
// historical logs under "Connected sources" — as a "Not connected" card with a
// Reconnect link — instead of vanishing. Oura models that removed-but-historical
// case: mark it disconnected but seed one past successful sync so its card renders
// with the Reconnect affordance. (A provider with NEITHER a connection nor any sync
// history — the never-set-up case — is filtered out entirely, which is the behavior
// the issue asked for; that decision is unit-tested in sync-log.test.ts.) The
// disconnected + ok=1 shape keeps this off the "currently failing" surface, so the
// review badge count is unaffected.
db.prepare(
  `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider = 'oura'`
).run(PROFILE_ID);
upsertConnection(PROFILE_ID, "oura", { status: "disconnected", config: null });
ins.run(
  PROFILE_ID,
  "oura",
  "2026-07-05 06:00:00",
  1,
  "2026-07-01",
  "2026-07-05",
  12, // received
  12, // written
  8, // inserted
  4, // updated
  0, // unchanged
  0, // skipped
  null, // raw_ref
  null
);

// Issue #326: a provider whose token DIED (dead/revoked refresh token) flips to the
// terminal `needs_reauth` state — the hourly tick then auto-syncs `connected` rows
// ONLY, so it stops retrying forever. Withings models that: mark it needs_reauth with
// a preserved config, plus one past failed sync event so the card has history and
// renders under "Connected sources" with the distinct "Needs reconnect" badge + a
// Reconnect link (contrast Oura's benign "Not connected"). Its latest event is a
// failure, so it also surfaces under "Needs attention". Synthetic config only.
db.prepare(
  `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider = 'withings'`
).run(PROFILE_ID);
upsertConnection(PROFILE_ID, "withings", {
  status: "needs_reauth",
  config: { clientId: "e2e-w-client", clientSecret: "e2e-w-secret" },
});
ins.run(
  PROFILE_ID,
  "withings",
  "2026-07-09 08:30:00",
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
  "Withings token refresh failed (401)"
);

// ── Duplicate/conflict fixtures (issue #10, Phase 2) ──────────────────────────
// A cross-source ACTIVITY pair on one day: a manually-logged "Morning run" and a
// Strava-imported run with overlapping clock times — a HIGH-confidence duplicate
// the Review inbox must surface with merge/keep-both/dismiss actions. Clear any
// prior fixtures first so re-seeding is idempotent. Synthetic data only.
const DUP_DATE = "2026-07-07";
// Idempotency cleanup scoped to THIS fixture's rows only (its titles + its own
// external_id) — a blanket source='strava' delete on the date silently ate the
// provenance fixture's "Strava morning ride" whenever seed.ts's relative
// daysAgo(3) rolled onto DUP_DATE (it did on 2026-07-10, failing
// journal-provenance suite-wide until the date moved on).
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND date = ? AND (external_id = 'strava:e2e-run-1' OR title IN ('Morning run', 'Afternoon Run'))`
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

// ── Manual pair-merge fixture (issue #64) ─────────────────────────────────────
// Two same-day MANUAL cardio activities the Journal's manual merge test folds
// together — the "duplicate no heuristic catches" case (two manual rows, no clock
// windows, so detection deliberately ignores them). Distinct date + titles so this
// fixture never collides with the cross-source dedup pair above. Synthetic only.
const MERGE_DATE = "2026-07-05";
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND date = ? AND title IN ('Journal merge keeper', 'Journal merge dupe')`
).run(PROFILE_ID, MERGE_DATE);
const insMerge = db.prepare(
  `INSERT INTO activities
     (profile_id, date, type, title, duration_min, distance_km, source, external_id, edited)
   VALUES (?, ?, 'cardio', ?, ?, ?, NULL, NULL, 0)`
);
insMerge.run(PROFILE_ID, MERGE_DATE, "Journal merge keeper", 40, 6);
insMerge.run(PROFILE_ID, MERGE_DATE, "Journal merge dupe", 42, null);

// ── Conflict-aware merge fixture (issue #100) ─────────────────────────────────
// Two same-day MANUAL cardio rows that genuinely DISAGREE on duration (42 vs 51
// min — well beyond the conflict tolerance) but agree on distance. The manual
// merge must therefore raise the per-field conflict preview; the e2e overrides
// duration to the discarded row's value and asserts the merged keeper carries it.
// Distinct date + titles so it never collides with the fixtures above. Synthetic.
const CONFLICT_DATE = "2026-07-06";
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND date = ? AND title IN ('Conflict merge keeper', 'Conflict merge dupe')`
).run(PROFILE_ID, CONFLICT_DATE);
insMerge.run(PROFILE_ID, CONFLICT_DATE, "Conflict merge keeper", 42, 5);
insMerge.run(PROFILE_ID, CONFLICT_DATE, "Conflict merge dupe", 51, 5);

// ── Set-re-parenting merge fixture (issues #199/#200) ─────────────────────────
// Two same-day MANUAL STRENGTH activities that conflict on duration (30 vs 45 min),
// so the manual merge raises the per-field conflict preview — the surface that now
// shows how many logged sets will move (#199). The DROP carries two typed-in sets
// that a merge must RE-PARENT onto the keeper (never destroy). Distinct date + titles
// so it never collides with the fixtures above. Synthetic only.
const SETS_DATE = "2026-07-04";
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND date = ? AND title IN ('Set merge keeper', 'Set merge dupe')`
).run(PROFILE_ID, SETS_DATE);
const insStrength = db.prepare(
  `INSERT INTO activities
     (profile_id, date, type, title, duration_min, source, external_id, edited)
   VALUES (?, ?, 'strength', ?, ?, NULL, NULL, 0)`
);
const setsKeeperId = Number(
  insStrength.run(PROFILE_ID, SETS_DATE, "Set merge keeper", 30).lastInsertRowid
);
const setsDupeId = Number(
  insStrength.run(PROFILE_ID, SETS_DATE, "Set merge dupe", 45).lastInsertRowid
);
const insSeedSet = db.prepare(
  `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
   VALUES (?, ?, ?, ?, ?)`
);
// The keeper has one set of its own; the dupe carries the two the merge must move.
insSeedSet.run(setsKeeperId, "Bench Press", 1, 60, 5);
insSeedSet.run(setsDupeId, "Back Squat", 1, 80, 5);
insSeedSet.run(setsDupeId, "Deadlift", 1, 100, 5);

console.log(
  "e2e: seeded integration_sync_events (strava failing) + a cross-source duplicate activity pair + a same-day manual-merge pair + a conflicting merge pair"
);

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

// ── Household rollup fixtures (issue #31) ─────────────────────────────────────
// A SECOND profile so the Household cross-profile view has more than one card and
// the caregiver-grant flows can be exercised (a login granted 2 profiles sees the
// overview; a single-grant login does not). The profile carries exactly one due-
// today supplement dose, unlogged, so it surfaces as an "Attention today" item a
// caregiver can confirm from the household card WITHOUT switching to it. Fully
// synthetic — no real PHI. Idempotent: the DB is reset per run, but guard anyway.
const HOUSEHOLD_PROFILE_ID = 2;
const HOUSEHOLD_PROFILE_NAME = "Sam Rivers"; // obviously-fictional
const HOUSEHOLD_SUPP_NAME = "Household Vitamin D";

if (
  !db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(HOUSEHOLD_PROFILE_ID)
) {
  db.prepare("INSERT INTO profiles (id, name) VALUES (?, ?)").run(
    HOUSEHOLD_PROFILE_ID,
    HOUSEHOLD_PROFILE_NAME
  );
}

if (
  !db
    .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
    .get(HOUSEHOLD_PROFILE_ID, HOUSEHOLD_SUPP_NAME)
) {
  const supp = db
    .prepare(
      `INSERT INTO intake_items
         (profile_id, name, condition, priority, active, source)
       VALUES (?, ?, 'daily', 'high', 1, 'manual')`
    )
    .run(HOUSEHOLD_PROFILE_ID, HOUSEHOLD_SUPP_NAME);
  // One daily dose, no taken-log for today → surfaces as a due dose on the card.
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '2000 IU', '08:00', 'any', 0)`
  ).run(Number(supp.lastInsertRowid));
}

// A SECOND due dose dedicated to the read-only-member spec. The write-member
// spec CONFIRMS the Vitamin D dose above, so a later test asserting a still-due
// row needs its own item — sharing one fixture made the read-only test order-
// dependent (it failed whenever the confirm test ran first).
const HOUSEHOLD_RO_SUPP_NAME = "Household Magnesium";
if (
  !db
    .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
    .get(HOUSEHOLD_PROFILE_ID, HOUSEHOLD_RO_SUPP_NAME)
) {
  const roSupp = db
    .prepare(
      `INSERT INTO intake_items
         (profile_id, name, condition, priority, active, source)
       VALUES (?, ?, 'daily', 'high', 1, 'manual')`
    )
    .run(HOUSEHOLD_PROFILE_ID, HOUSEHOLD_RO_SUPP_NAME);
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '200 mg', '20:00', 'any', 0)`
  ).run(Number(roSupp.lastInsertRowid));
}

console.log(
  `e2e: seeded household profile ${HOUSEHOLD_PROFILE_ID} (${HOUSEHOLD_PROFILE_NAME}) with two due-today supplement doses`
);

// ── Profile-switch toaster fixtures (issue #296) ──────────────────────────────
// The ExtractionToaster/ImportJobsToaster poll the ACTIVE profile's document/job
// history and toast terminal transitions, seeding silently on the first poll.
// Before #296 a profile switch didn't reset that seed, so the new profile's whole
// terminal history ghost-toasted as "just finished". To prove the fix, the second
// profile (id 2, "Sam Rivers") needs its own pre-existing TERMINAL rows: switching
// to it must produce ZERO toasts (the fix reseeds silently). Synthetic filenames/
// content only — no real PHI. Idempotent: clear prior fixtures first.
db.prepare(
  `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN ('e2e-p2-labs.pdf', 'e2e-p2-broken.txt')`
).run(HOUSEHOLD_PROFILE_ID);
db.prepare(
  `DELETE FROM import_jobs WHERE profile_id = ? AND summary = 'e2e-p2: 3 readings'`
).run(HOUSEHOLD_PROFILE_ID);
db.prepare(
  `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
      extraction_status, extracted_count, uploaded_at)
   VALUES (?, 'e2e-p2-labs.pdf', '', 'application/pdf', 4096, 'Lab report',
           'done', 9, '2026-07-07 09:00:00')`
).run(HOUSEHOLD_PROFILE_ID);
db.prepare(
  `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes,
      extraction_status, extraction_error, uploaded_at)
   VALUES (?, 'e2e-p2-broken.txt', '', 'text/plain', 12,
           'failed', 'Unsupported file type.', '2026-07-07 08:30:00')`
).run(HOUSEHOLD_PROFILE_ID);
db.prepare(
  `INSERT INTO import_jobs
     (profile_id, type, status, summary, created_at, updated_at)
   VALUES (?, 'biomarkers', 'ready', 'e2e-p2: 3 readings',
           '2026-07-07 08:00:00', '2026-07-07 08:00:00')`
).run(HOUSEHOLD_PROFILE_ID);

console.log(
  `e2e: seeded profile ${HOUSEHOLD_PROFILE_ID} terminal document/job history for the profile-switch toaster spec (#296)`
);

// ── Consolidated "family" calendar fixtures ───────────────────────────────────
// A SECOND profile with its own upcoming appointment so the family-calendar feed +
// preview have two profiles' data to merge. The e2e login is the bootstrap admin,
// who can access every profile without an explicit grant. Synthetic name/provider
// only — no real PHI. Idempotent: reuse the profile if a prior run created it, and
// clear its fixture appointment before re-inserting.
const CHILD_NAME = "Test Child";
let childId = (
  db.prepare("SELECT id FROM profiles WHERE name = ?").get(CHILD_NAME) as
    { id: number } | undefined
)?.id;
if (!childId) {
  childId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(CHILD_NAME)
      .lastInsertRowid
  );
}
// A clearly-future date so the appointment always lands in the feed's forward window.
const soon = new Date();
soon.setDate(soon.getDate() + 5);
const soonDate = soon.toISOString().slice(0, 10);
db.prepare(
  "DELETE FROM appointments WHERE profile_id = ? AND title = 'Pediatric checkup'"
).run(childId);
db.prepare(
  `INSERT INTO appointments (profile_id, scheduled_at, title, location, status)
   VALUES (?, ?, 'Pediatric checkup', 'Springfield Pediatrics', 'scheduled')`
).run(childId, `${soonDate} 10:00`);

console.log(
  `e2e: seeded a second profile (${CHILD_NAME}, id=${childId}) with an upcoming appointment for the family-calendar feed`
);

// ── Weekly recap + milestones fixtures (issue #32) ────────────────────────────
// The Weekly-recap dashboard widget is off by default (it stays quiet), so pin a
// layout for profile 1 that makes ONLY it a known-visible widget; every other
// widget falls back to its registry default. This gives the recap spec a
// deterministic card to assert on. Synthetic — no PHI.
setDashboardLayout(PROFILE_ID, { order: ["weekly-recap"], hidden: [] });

// Pin profile 1 to rolling week_mode so the recap covers a trailing seven days
// (issue #223): the recap now honors week_mode, and under the default calendar
// mode the current-week window would shrink toward the week-start day, so on some
// weekdays the last seeded workout (daysAgo(1)) would fall outside it and the card
// would render its empty-state nudge instead of the summary rows. Rolling keeps
// the spec deterministic across every CI run day. Calendar-mode window behavior is
// covered by the pure unit tests (lib/__tests__/week-window.test.ts).
setWeekMode(PROFILE_ID, "rolling");

// A fired milestone so the Timeline's `milestone` category has a deterministic
// entry to render (the milestone engine also fires live on the notify tick, but
// e2e never runs that). achieved_on is today so it lands at the top of the feed.
const milestoneDate = new Date().toISOString().slice(0, 10);
db.prepare(
  `DELETE FROM milestones WHERE profile_id = ? AND key = 'workouts:50'`
).run(PROFILE_ID);
db.prepare(
  `INSERT INTO milestones (profile_id, key, kind, threshold, title, detail, achieved_on)
   VALUES (?, 'workouts:50', 'workouts', 50, '50 workouts logged',
           'You''ve logged 50 workouts. Consistency is the point — nice going.', ?)`
).run(PROFILE_ID, milestoneDate);

console.log(
  "e2e: seeded weekly-recap dashboard layout + a milestone timeline entry for profile 1"
);

// ── Coaching rest-episode continuity fixtures (#44 item 3b) ───────────────────
// Force a rest nudge for profile 1 today (a short night, below the 6h floor) and
// pre-seed a rest episode that started YESTERDAY, so the Training → Overview
// "Next workout" card reads "Rest or take it easy — 2nd day" (a persisting
// recommendation, #752) rather than a fresh "Rest or take it easy today" alert.
// Dates follow the app timezone
// via today()/shiftDateStr so this is deterministic regardless of the host TZ.
// Synthetic values only — no real PHI.
const COACH_TODAY = today(PROFILE_ID);
const COACH_YESTERDAY = shiftDateStr(COACH_TODAY, -1);

// A single low sleep_min sample for last night → getSleepSignal trips the
// absolute floor and restRecommendation fires a rest nudge. Clear any prior
// fixture row first so re-seeding stays idempotent.
db.prepare(
  `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?`
).run(PROFILE_ID, COACH_TODAY);
db.prepare(
  `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 300)`
).run(
  PROFILE_ID,
  COACH_TODAY,
  `${COACH_YESTERDAY}T23:00`,
  `${COACH_TODAY}T04:00`
);

// The persisted episode marker (mirrors the refill nudge's dedup marker). Started
// yesterday and last seen yesterday → today's rest rec continues it into day 2.
setProfileSetting(
  PROFILE_ID,
  "coaching_rest_episode",
  JSON.stringify({
    startDate: COACH_YESTERDAY,
    lastDate: COACH_YESTERDAY,
    reasonId: "rest-sleep",
  })
);

console.log(
  `e2e: seeded a low-sleep sample + a day-2 rest episode for profile 1 (${COACH_YESTERDAY} → ${COACH_TODAY})`
);

// ── Sleep Regularity Index fixture (issue #160) ───────────────────────────────
// 28 nightly sleep sessions (wake-days today-1 … today-28), each bed 23:00 → wake
// 07:00 in UTC (the e2e default profile timezone), so the rolling 28-night window
// clears the minimum-nights gate and the Trends → Body "Sleep regularity" card
// (SRI) renders. Weekend nights (Sat/Sun wake) shift 90 min later so the companion
// social-jetlag line is non-trivial. Relative dates → never stale; instants carry
// a Z so they're timezone-unambiguous. Idempotent: clear this range first (the
// coaching low-sleep row on wake-day `today` is outside it and untouched).
const sriInsert = db.prepare(
  `INSERT OR IGNORE INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'manual', 'sleep_min', ?, ?, ?, ?)`
);
for (let i = 1; i <= 28; i++) {
  const wakeDay = shiftDateStr(COACH_TODAY, -i);
  const bedDay = shiftDateStr(wakeDay, -1);
  db.prepare(
    `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?`
  ).run(PROFILE_ID, wakeDay);
  const dow = new Date(wakeDay + "T00:00:00Z").getUTCDay(); // 0=Sun … 6=Sat
  const weekend = dow === 0 || dow === 6;
  // Weekday 23:00→07:00 (480 min); weekend 00:30→08:30 (still 480 min, later).
  const start = weekend ? `${wakeDay}T00:30:00Z` : `${bedDay}T23:00:00Z`;
  const end = weekend ? `${wakeDay}T08:30:00Z` : `${wakeDay}T07:00:00Z`;
  sriInsert.run(PROFILE_ID, wakeDay, start, end, 480);
}
console.log("e2e: seeded 28 nightly sleep sessions for profile 1 (SRI, #160)");

// ── Multi-source metric fixture (issue #14) ───────────────────────────────────
// The SAME metric (nightly HRV) reported by TWO sources — Health Connect and
// Oura — over the last five nights, so the Trends → Body "Compare sources"
// overlay has something to render and the primary-source picker can be
// exercised. HRV is a point (AVG) metric with no standalone Body-tab chart, so
// this fixture can't disturb the sleep/SRI/zone fixtures above or the seeded
// charts. Values are plausible synthetic ms figures — no PHI. Idempotent: clear
// this window's rows for both sources first. Each source keys its own window
// (source is part of the metric_samples unique key), slightly offset like real
// devices.
const insHrv = db.prepare(
  `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, ?, 'hrv_ms', ?, ?, ?, ?)`
);
for (let i = 1; i <= 5; i++) {
  const wakeDay = shiftDateStr(COACH_TODAY, -i);
  const bedDay = shiftDateStr(wakeDay, -1);
  db.prepare(
    `DELETE FROM metric_samples
      WHERE profile_id = ? AND metric = 'hrv_ms' AND date = ?
        AND source IN ('health-connect','oura')`
  ).run(PROFILE_ID, wakeDay);
  insHrv.run(
    PROFILE_ID,
    "health-connect",
    wakeDay,
    `${bedDay}T23:00:00Z`,
    `${wakeDay}T07:00:00Z`,
    42 + i
  );
  insHrv.run(
    PROFILE_ID,
    "oura",
    wakeDay,
    `${bedDay}T23:05:00Z`,
    `${wakeDay}T07:10:00Z`,
    55 + i
  );
}
console.log(
  "e2e: seeded 5 nights of two-source HRV for profile 1 (compare sources, #14)"
);

// ── Training HR-zone fixture (issue #159) ─────────────────────────────────────
// A windowed cardio session with per-minute HR inside its window, so the Trends →
// Fitness zone section, weekly Zone 2 volume, and polarization split render on the
// e2e DB. The seed profile is ~40y with a latest resting HR of 55 bpm, so the zone
// model is Karvonen (max 180, resting 55): Zone 2 ≈ 130–142 bpm, Zone 4 ≈ 155–167.
// Relative dates so it never goes stale. Idempotent: clear any prior fixture rows.
const zoneDate = shiftDateStr(today(PROFILE_ID), -2);

db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:zone-ride'`
).run(PROFILE_ID);
db.prepare(
  `DELETE FROM hr_minutes WHERE profile_id = ? AND substr(ts,1,10) = ?`
).run(PROFILE_ID, zoneDate);

db.prepare(
  `INSERT INTO activities
     (profile_id, date, type, title, notes, duration_min, distance_km, intensity,
      start_time, end_time, components, source, external_id)
   VALUES (1, ?, 'cardio', 'Zone 2 base ride', NULL, 60, 20, 'moderate',
           '08:00', '09:00', ?, 'manual', 'e2e:zone-ride')`
).run(
  zoneDate,
  JSON.stringify([
    { name: "Cycling", type: "cardio", distance_km: 20, duration_min: 60 },
  ])
);

const insHr = db.prepare(
  `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (1, ?, ?, 6, 'health-connect')`
);
// 08:00–08:49 easy Zone 2 (135 bpm), 08:50–08:59 hard Zone 4 (160 bpm): 50 easy +
// 10 hard, an ~83/17 balanced split (below the hard-heavy nudge threshold).
for (let m = 0; m < 60; m++) {
  const mm = String(m).padStart(2, "0");
  insHr.run(`${zoneDate}T08:${mm}`, m < 50 ? 135 : 160);
}
// A resting bucket at noon, OUTSIDE any activity window — proves the aggregation
// scopes to workout windows (this all-day wear minute must not count as training).
insHr.run(`${zoneDate}T12:00`, 62);

console.log(
  `e2e: seeded a windowed HR-zone ride for profile 1 on ${zoneDate} (50 min Z2 + 10 min Z4)`
);

// ---- issue #45 rule-domain fixtures (domains 4–6) --------------------------
// Deterministic fixtures so the new observational-findings surfaces have something
// to render in e2e. Goal pacing (domain 6) is already covered by the base seed's
// off-pace "Reach 74 kg" / "Cut to 78 kg" weight goals; these add the training
// plateau (domain 4) and the body-metric weight jump (domain 5). All idempotent.

// Domain 4 — a PLATEAUED lift: six weekly Skullcrusher sessions at a FIXED 30 kg × 10,
// so the estimated 1RM is flat across ~5 weeks and the plateau rule fires on
// Training → Overview. Skullcrusher is outside the seeded PPL routine, so it doesn't
// disturb the progressing lifts.
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND external_id LIKE 'e2e:plateau-%'`
).run(PROFILE_ID);
const insPlateauAct = db.prepare(
  `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity, source, external_id)
   VALUES (1, ?, 'strength', 'Arms — Skullcrusher', 30, 'hard', 'manual', ?)`
);
const insPlateauSet = db.prepare(
  `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
   VALUES (?, 'Skullcrusher', ?, 30, 10)`
);
for (let w = 0; w < 6; w++) {
  const date = shiftDateStr(today(PROFILE_ID), -(w * 7 + 2));
  const actId = Number(
    insPlateauAct.run(date, `e2e:plateau-${w}`).lastInsertRowid
  );
  for (let s = 1; s <= 3; s++) insPlateauSet.run(actId, s);
}

// #449 — a DEDICATED plateaued lift ("E2E Dismiss Press") whose ONLY purpose is the
// coaching-observations dashboard-dismiss spec. That spec mutates the shared
// suppression store (dismissing the finding), and "dismiss once, silence everywhere"
// would then hide the finding on Training → Overview too — so it must NOT reuse the
// Skullcrusher plateau, which rule-findings.spec.ts asserts is visible. Built exactly
// like the Skullcrusher fixture (six weekly sessions at a FIXED 30 kg × 10 → flat 1RM →
// plateau rule fires), with a unique name no other spec references. Idempotent; outside
// the seeded PPL routine so it doesn't disturb the progressing lifts.
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND external_id LIKE 'e2e:dismiss-plateau-%'`
).run(PROFILE_ID);
const insDismissAct = db.prepare(
  `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity, source, external_id)
   VALUES (1, ?, 'strength', 'Arms — E2E Dismiss Press', 30, 'hard', 'manual', ?)`
);
const insDismissSet = db.prepare(
  `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
   VALUES (?, 'E2E Dismiss Press', ?, 30, 10)`
);
for (let w = 0; w < 6; w++) {
  const date = shiftDateStr(today(PROFILE_ID), -(w * 7 + 2));
  const actId = Number(
    insDismissAct.run(date, `e2e:dismiss-plateau-${w}`).lastInsertRowid
  );
  for (let s = 1; s <= 3; s++) insDismissSet.run(actId, s);
}

// Domain 5 — a probable-error weight JUMP: one outlier reading (92 kg) three days
// after the prior weekly weigh-in (~80.5 kg), ~14% above it — a scale-glitch
// signature the body-hygiene rule flags on Trends → Body.
const jumpDate = shiftDateStr(today(PROFILE_ID), -12);
db.prepare(
  `DELETE FROM body_metrics WHERE profile_id = ? AND notes = 'e2e:weight-jump'`
).run(PROFILE_ID);
db.prepare(
  `INSERT INTO body_metrics (profile_id, date, weight_kg, notes)
   VALUES (1, ?, 92, 'e2e:weight-jump')`
).run(jumpDate);

console.log(
  `e2e: seeded a 6-week Skullcrusher plateau, a dedicated E2E Dismiss Press plateau (#449), and a weight jump on ${jumpDate} (#45)`
);

// Domain 3 — an adherence PATTERN: a daily Evening supplement taken every day for
// ~8 weeks EXCEPT every Friday. The weekday-miss rule then flags "you miss your
// evening dose most Fridays" and suggests moving it earlier, on Supplements & Meds.
// Fully synthetic. Idempotent: re-created from scratch each boot (the item + its
// dose + logs), so today-relative dates stay correct across days.
const ADHERE_ITEM = "Evening Vitamin C (e2e)";
db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
  PROFILE_ID,
  ADHERE_ITEM
);
// Backdated created_at: the #430 lifetime clamp bounds each dose's adherence
// strip to max(item created, dose created/re-timed), so the item + dose must
// PREDATE the 63-day backfilled log window or the pattern rules see no history.
const adhereBorn = `${shiftDateStr(today(PROFILE_ID), -70)} 08:00:00`;
const adhereItemId = Number(
  db
    .prepare(
      `INSERT INTO intake_items
         (profile_id, name, condition, priority, active, source, created_at)
       VALUES (?, ?, 'daily', 'high', 1, 'manual', ?)`
    )
    .run(PROFILE_ID, ADHERE_ITEM, adhereBorn).lastInsertRowid
);
const adhereDoseId = Number(
  db
    .prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort, created_at, updated_at)
       VALUES (?, '500 mg', 'Evening', 'any', 0, ?, ?)`
    )
    .run(adhereItemId, adhereBorn, adhereBorn).lastInsertRowid
);
const insAdhereLog = db.prepare(
  `INSERT OR IGNORE INTO intake_item_logs (dose_id, item_id, date, status)
   VALUES (?, ?, ?, 'taken')`
);
// 63 days back → nine Fridays in the window; log taken on every non-Friday.
for (let i = 1; i <= 63; i++) {
  const date = shiftDateStr(today(PROFILE_ID), -i);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 5) continue; // Friday → missed (no taken-log)
  insAdhereLog.run(adhereDoseId, adhereItemId, date);
}

console.log(
  `e2e: seeded an every-Friday evening-dose miss pattern for ${ADHERE_ITEM} (#45 domain 3)`
);

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
};
db.prepare(
  `INSERT INTO medical_documents
     (id, profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
      source, extraction_status, extracted_count, import_report, uploaded_at)
   VALUES (?, ?, 'e2e-drop-report.xml', '', 'application/xml', 2048,
           'MyChart export (CCD/XDM)', 'ccda', 'done', 12, ?,
           '2026-07-08 09:45:00')`
).run(DROP_DOC_ID, PROFILE_ID, JSON.stringify(dropReport));

console.log(
  `e2e: seeded import document ${DROP_DOC_ID} with a 260-drop report + an unmapped LOINC (#270)`
);

// ── Percent-strength medication fixture (issue #272) ─────────────────────────
// A topical med whose name carries a PERCENT strength ("Hydrocortisone 2.5%
// Cream"). Its educational "What is this?" explainer only renders when the name
// normalizer strips the percent strength before the description lookup — the
// regression this fixture pins in the browser. PRN (as_needed=1, the Ibuprofen
// precedent) so it adds no scheduled-due dose to reminder/digest fixtures, and
// hydrocortisone appears in no interaction dataset, so other specs are
// undisturbed. Synthetic prescriber — no real PHI.
const PCT_MED_NAME = "Hydrocortisone 2.5% Cream";
if (
  !db
    .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
    .get(PROFILE_ID, PCT_MED_NAME)
) {
  const pctMed = db
    .prepare(
      `INSERT INTO intake_items
         (profile_id, name, notes, condition, priority, kind, prescriber,
          active, as_needed)
       VALUES (?, ?, 'Topical steroid — apply to affected area', 'daily',
               'low', 'medication', 'Dr. Test Provider', 1, 1)`
    )
    .run(PROFILE_ID, PCT_MED_NAME);
  const pctMedId = Number(pctMed.lastInsertRowid);
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, 'thin layer', 'Anytime', 'any', 0)`
  ).run(pctMedId);
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
     VALUES (?, ?, NULL, NULL, 'PRN for eczema flare')`
  ).run(pctMedId, shiftDateStr(today(PROFILE_ID), -14));
}

console.log(`e2e: seeded percent-strength medication "${PCT_MED_NAME}" (#272)`);

// ── Med-card adherence + refill parity fixture (issue #747) ──────────────────
// A CURRENT (open-course, active, daily) medication carrying refill tracking
// (quantity_on_hand) AND a run of deterministic taken-logs, so its medication
// CARD renders BOTH the "≈N days left" refill badge and the 14-day adherence
// summary line — the parity the med card previously lacked (it received neither
// strip nor refillRate). Fully synthetic name with no rxcui → matches no
// interaction/PGx/food-drug dataset, so other specs are undisturbed; supply is
// set HIGH (90 units ÷ ~1/day ≈ 90 days) so it stays ABOVE the low-supply
// threshold and never joins the dashboard Low-supply widget / Upcoming refill
// fixtures. Idempotent: re-created from scratch each boot so the log window
// stays today-relative.
const PARITY_MED_NAME = "Adherence Refill Med (e2e)";
db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
  PROFILE_ID,
  PARITY_MED_NAME
);
const parityMedId = Number(
  db
    .prepare(
      `INSERT INTO intake_items
         (profile_id, name, notes, condition, priority, kind, prescriber,
          active, as_needed, quantity_on_hand, qty_per_dose)
       VALUES (?, ?, 'Daily maintenance med — e2e parity fixture', 'daily',
               'low', 'medication', 'Dr. Test Provider', 1, 0, 90, 1)`
    )
    .run(PROFILE_ID, PARITY_MED_NAME).lastInsertRowid
);
const parityDoseId = Number(
  db
    .prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '1 tablet', 'Morning', 'any', 0)`
    )
    .run(parityMedId).lastInsertRowid
);
db.prepare(
  `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
   VALUES (?, ?, NULL, NULL, 'Ongoing — e2e parity fixture')`
).run(parityMedId, shiftDateStr(today(PROFILE_ID), -60));
// Deterministic taken-logs for the last 14 days (every day taken) → 100%
// adherence and a multi-day streak, so the AdherenceSummaryLine renders with
// stable text regardless of the run.
const insParityLog = db.prepare(
  `INSERT OR IGNORE INTO intake_item_logs (dose_id, item_id, date, status)
   VALUES (?, ?, ?, 'taken')`
);
for (let i = 1; i <= 14; i++) {
  insParityLog.run(
    parityDoseId,
    parityMedId,
    shiftDateStr(today(PROFILE_ID), -i)
  );
}

console.log(
  `e2e: seeded med-card adherence+refill parity fixture "${PARITY_MED_NAME}" (#747)`
);

// ── PRN administration ledger fixture (issue #797) ───────────────────────────
// A CURRENT, active PRN (as_needed) medication with refill tracking and TWO
// administrations already logged TODAY (real given_at times), so BOTH the
// Medications-page card ("2 today · last …") and the dashboard "Log a PRN dose"
// widget render a populated PRN med, and the widget's "Log" button can add a
// third. Fully synthetic name with no rxcui → matches no interaction/PGx/food-drug
// dataset, so other specs are undisturbed; supply stays HIGH (60 units) so it never
// joins the low-supply widget/Upcoming fixtures. Idempotent: recreated each boot so
// the administrations stay today-relative. given_at is stored UTC ("YYYY-MM-DD
// HH:MM:SS"); the profile tz labels the displayed clock.
const PRN_MED_NAME = "PRN Quicklog Med (e2e)";
db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
  PROFILE_ID,
  PRN_MED_NAME
);
const prnMedId = Number(
  db
    .prepare(
      `INSERT INTO intake_items
         (profile_id, name, notes, condition, priority, kind, prescriber,
          active, as_needed, quantity_on_hand, qty_per_dose)
       VALUES (?, ?, 'As-needed med — e2e PRN quick-log fixture', 'daily',
               'low', 'medication', 'Dr. Test Provider', 1, 1, 60, 1)`
    )
    .run(PROFILE_ID, PRN_MED_NAME).lastInsertRowid
);
const prnDoseId = Number(
  db
    .prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '400 mg', 'Anytime', 'any', 0)`
    )
    .run(prnMedId).lastInsertRowid
);
db.prepare(
  `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
   VALUES (?, ?, NULL, NULL, 'PRN — e2e fixture')`
).run(prnMedId, shiftDateStr(today(PROFILE_ID), -30));
// Two administrations earlier today, so the card shows "2 today". given_at is
// computed from seed-time minus a fixed offset (45m / 90m ago) — always well outside
// the widget's ~2-minute double-tap dedup window from the later test-run "now", so a
// subsequent widget "Log" click deterministically becomes the third. `date` is pinned
// to today() (not derived from given_at) so the count stays "today" even if an offset
// crosses UTC midnight at boot.
const prnToday = today(PROFILE_ID);
const insAdmin = db.prepare(
  `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, amount, status)
   VALUES (?, ?, ?, ?, '400 mg', 'taken')`
);
for (const minutesAgo of [90, 45]) {
  insAdmin.run(
    prnDoseId,
    prnMedId,
    prnToday,
    utcSqlString(new Date(Date.now() - minutesAgo * 60 * 1000))
  );
}

console.log(
  `e2e: seeded PRN administration ledger fixture "${PRN_MED_NAME}" (#797)`
);

// A second PRN med with a CONFIRMED redose notice (#798): min interval 6h, max 4/day,
// opt-in on, and ONE administration ~7h ago — so the redose window is OPEN and the
// card/widget render the "Redose OK — min interval passed · 1 of 4 today" status line.
// Synthetic name → matches no interaction dataset; high supply so it never joins the
// low-supply fixtures. Idempotent (recreated each boot, administration stays
// today-relative).
const REDOSE_MED_NAME = "PRN Redose Med (e2e)";
db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
  PROFILE_ID,
  REDOSE_MED_NAME
);
const redoseMedId = Number(
  db
    .prepare(
      `INSERT INTO intake_items
         (profile_id, name, notes, condition, priority, kind, prescriber,
          active, as_needed, quantity_on_hand, qty_per_dose,
          min_interval_hours, max_daily_count, redose_notice)
       VALUES (?, ?, 'As-needed med — e2e redose fixture', 'daily',
               'low', 'medication', 'Dr. Test Provider', 1, 1, 60, 1, 6, 4, 1)`
    )
    .run(PROFILE_ID, REDOSE_MED_NAME).lastInsertRowid
);
const redoseDoseId = Number(
  db
    .prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '200 mg', 'Anytime', 'any', 0)`
    )
    .run(redoseMedId).lastInsertRowid
);
db.prepare(
  `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
   VALUES (?, ?, NULL, NULL, 'PRN redose — e2e fixture')`
).run(redoseMedId, shiftDateStr(today(PROFILE_ID), -30));
db.prepare(
  `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, amount, status)
   VALUES (?, ?, ?, ?, '200 mg', 'taken')`
).run(
  redoseDoseId,
  redoseMedId,
  today(PROFILE_ID),
  utcSqlString(new Date(Date.now() - 7 * 60 * 60 * 1000))
);
console.log(
  `e2e: seeded PRN redose-notice fixture "${REDOSE_MED_NAME}" (#798)`
);

// ── Import-detail tabbed records-browser fixture (issue #271) ─────────────────
// A 'done' document that produced rows across several kinds — labs + a
// prescription (medical_records), a visit, a condition, an immunization, and a
// referenced provider — so the records browser has a multi-tab strip to render:
// default tab, ?tab= selection, category-correct row links (the prescription →
// /medications regression), the read-only visit listing deep-linking to
// /encounters/[id], and the Providers chip (linking to /providers). Fixed id 908; all content
// synthetic (fictional analytes/clinic/patient — no real PHI).
const BROWSER_DOC_ID = 908;
const BROWSER_DOC_SOURCE = `document:${BROWSER_DOC_ID}`;
db.prepare(`DELETE FROM medical_records WHERE document_id = ?`).run(
  BROWSER_DOC_ID
);
db.prepare(`DELETE FROM encounters WHERE document_id = ?`).run(BROWSER_DOC_ID);
db.prepare(`DELETE FROM conditions WHERE document_id = ?`).run(BROWSER_DOC_ID);
db.prepare(`DELETE FROM immunizations WHERE source = ?`).run(
  BROWSER_DOC_SOURCE
);
db.prepare(`DELETE FROM medical_documents WHERE id = ?`).run(BROWSER_DOC_ID);
db.prepare(
  `INSERT INTO medical_documents
     (id, profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
      source, extraction_status, extracted_count, uploaded_at)
   VALUES (?, ?, 'e2e-records-browser.xml', '', 'application/xml', 4096,
           'MyChart export (CCD/XDM)', 'ccda', 'done', 6, '2026-07-08 09:50:00')`
).run(BROWSER_DOC_ID, PROFILE_ID);
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
insBrowserRecord.run(
  PROFILE_ID,
  "prescription",
  "E2E Amoxicillin 500 mg",
  null,
  null,
  null,
  null,
  "E2E Amoxicillin 500 mg",
  BROWSER_DOC_ID,
  null
);
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
  `e2e: seeded import document ${BROWSER_DOC_ID} with labs + prescription + visit + condition + immunization for the records browser (#271)`
);

// ── Records bridge fixture (#817) ────────────────────────────────────────────
// Two imported prescription records (documentless) with NO matched tracked med, so
// the /medications "From your records" bridge has deterministic suggest-only rows:
// one to TRACK (→ becomes a medication) and one to DISMISS (→ disappears via the
// findings bus). Fully synthetic names with no trailing strength, so cleanMedicationName
// is the identity — the tracked med and the dismissal key are predictable. Idempotent:
// the records, any med tracked from a prior run, and the dismissal are all reset each
// boot so both rows show again on a fresh run.
const BRIDGE_TRACK_MED = "E2E Bridge Track Med";
const BRIDGE_DISMISS_MED = "E2E Bridge Dismiss Med";
// A THIRD untracked prescription dedicated to the #852 item 6 dismiss→restore round-trip
// (kept separate from the Track/Dismiss rows so that spec never collides with theirs).
const BRIDGE_RESTORE_MED = "E2E Bridge Restore Med";
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND category = 'prescription' AND name IN (?, ?, ?)`
).run(PROFILE_ID, BRIDGE_TRACK_MED, BRIDGE_DISMISS_MED, BRIDGE_RESTORE_MED);
db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
  PROFILE_ID,
  BRIDGE_TRACK_MED
);
db.prepare(
  `DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key IN (?, ?)`
).run(
  PROFILE_ID,
  `med-bridge:${BRIDGE_DISMISS_MED.toLowerCase()}`,
  `med-bridge:${BRIDGE_RESTORE_MED.toLowerCase()}`
);
const insBridgeRx = db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, canonical_name, source)
   VALUES (?, '2026-06-10', 'prescription', ?, ?, 'ccda')`
);
insBridgeRx.run(PROFILE_ID, BRIDGE_TRACK_MED, BRIDGE_TRACK_MED);
insBridgeRx.run(PROFILE_ID, BRIDGE_DISMISS_MED, BRIDGE_DISMISS_MED);
insBridgeRx.run(PROFILE_ID, BRIDGE_RESTORE_MED, BRIDGE_RESTORE_MED);
console.log(
  `e2e: seeded records-bridge fixture (untracked prescriptions "${BRIDGE_TRACK_MED}" + "${BRIDGE_DISMISS_MED}" + "${BRIDGE_RESTORE_MED}") (#817/#852)`
);

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
const DOSE_ORDER_MORNING = "Zeaxanthin Morning (e2e)";
const DOSE_ORDER_BEDTIME = "Ashwagandha Bedtime (e2e)";
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
           (profile_id, name, condition, priority, active, source)
         VALUES (?, ?, 'daily', 'high', 1, 'manual')`
      )
      .run(PROFILE_ID, name);
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, ?, ?, 'any', 0)`
    ).run(Number(supp.lastInsertRowid), amount, timeOfDay);
  }
}

console.log(
  `e2e: seeded morning + bedtime due doses on profile ${PROFILE_ID} for the dose-order spec (#297)`
);

// ── Time-aware Today panel fixtures (issue #852 item 1) ──────────────────────
// Two SCHEDULED, active medications whose alphabetical order REVERSES their bucket
// order: "Zeta Morning Med" is a MORNING dose, "Alpha Evening Med" an EVENING dose.
// Data/alphabetical order would put Alpha first; the shared doseSortKey ordering must
// put Zeta (Morning) first — the same order Upcoming derives. Both daily + active with
// no taken-log today, so they surface as due on the Medications Today panel AND in
// Upcoming. Fully synthetic, no rxcui (no interaction/food dataset hit). Idempotent.
for (const [name, timeOfDay] of [
  ["Zeta Morning Med (e2e)", "morning"],
  ["Alpha Evening Med (e2e)", "evening"],
] as const) {
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
    PROFILE_ID,
    name
  );
  const medId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, condition, priority, kind, active, as_needed)
         VALUES (?, ?, 'daily', 'low', 'medication', 1, 0)`
      )
      .run(PROFILE_ID, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 tablet', ?, 'any', 0)`
  ).run(medId, timeOfDay);
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
     VALUES (?, ?, NULL, NULL, 'e2e Today-order fixture')`
  ).run(medId, shiftDateStr(today(PROFILE_ID), -30));
}
console.log(
  `e2e: seeded morning + evening scheduled meds on profile ${PROFILE_ID} for the Today-order spec (#852)`
);

// ── Low-supply medication fixture (issue #852 item 3) ────────────────────────
// A CURRENT, active, SCHEDULED daily medication sitting BELOW the low-supply threshold —
// the state the one-tap "Refilled" action + run-out date render on. qty_per_dose is 10
// (units/day ≈ 10), so 3 units ≈ 0 days left; a +30 refill only reaches ~3 days, keeping
// it low across the browser test's repeated runs (the shared seed isn't reset between
// them, so the affordance must persist). A fill size (30) is REMEMBERED so the browser
// test exercises the genuine one-tap path repeatably (the first-use "ask for a size"
// path is covered by the action tier). Distinctly named so filter-based specs are
// undisturbed.
const LOW_SUPPLY_MED_NAME = "Low Supply Med (e2e)";
db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
  PROFILE_ID,
  LOW_SUPPLY_MED_NAME
);
const lowSupplyMedId = Number(
  db
    .prepare(
      `INSERT INTO intake_items
         (profile_id, name, notes, condition, priority, kind, prescriber,
          active, as_needed, quantity_on_hand, qty_per_dose, last_fill_size)
       VALUES (?, ?, 'e2e low-supply refill fixture', 'daily', 'low',
               'medication', 'Dr. Test Provider', 1, 0, 3, 10, 30)`
    )
    .run(PROFILE_ID, LOW_SUPPLY_MED_NAME).lastInsertRowid
);
db.prepare(
  `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
   VALUES (?, '1 tablet', 'morning', 'any', 0)`
).run(lowSupplyMedId);
db.prepare(
  `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
   VALUES (?, ?, NULL, NULL, 'e2e low-supply fixture')`
).run(lowSupplyMedId, shiftDateStr(today(PROFILE_ID), -30));
console.log(
  `e2e: seeded low-supply medication "${LOW_SUPPLY_MED_NAME}" on profile ${PROFILE_ID} (#852)`
);

// ---- Medical/passport UI-audit fixtures (#381, #383, #384) ----
// All idempotent (delete-then-insert on unique e2e identifiers) and fully
// synthetic. Layered on profile 1 for the medical-smalls specs.

// #381 — a STARRED genomics biomarker whose only reading is ~2 years old. The
// canonical name has no canonical_biomarkers row, so before the fix the pinned
// tile judged staleness on the (null) canonical category and mislabelled a
// genotype "stale"; after the fix it judges on the RECORD's 'genomics' category
// (never stale). The starred-biomarker-stale spec asserts the tile shows no
// "stale" note.
const APOE_MARKER = "E2E APOE Genotype";
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
).run(PROFILE_ID, APOE_MARKER);
db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, source)
   VALUES (?, '2023-05-01', 'genomics', ?, 'e3/e4', ?, 'manual')`
).run(PROFILE_ID, APOE_MARKER, APOE_MARKER);
db.prepare(
  `DELETE FROM starred_biomarkers WHERE profile_id = ? AND canonical_name = ?`
).run(PROFILE_ID, APOE_MARKER);
db.prepare(
  `INSERT INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, ?)`
).run(PROFILE_ID, APOE_MARKER);

// #516 — a positive durable-immunity antibody titer whose only reading is ~2 years
// old. On the flat 365-day retest clock it would nag "retest overdue" and render
// "These results are stale", which is clinically wrong for a documented positive
// immunity result (durable evidence, like genomics). The durable-immunity spec asserts
// the detail page shows no "stale" note. Unique synthetic name so the assertion is
// deterministic and it can't collide with the seed's own titers.
const IMMUNITY_MARKER = "E2E Varicella IgG";
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
).run(PROFILE_ID, IMMUNITY_MARKER);
db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, notes, source)
   VALUES (?, '2023-05-01', 'lab', ?, 'Immune', ?, 'Immune', 'manual')`
).run(PROFILE_ID, IMMUNITY_MARKER, IMMUNITY_MARKER);

// #544/#549 — a POSITIVE durable-immunity titer the extractor stamped "abnormal".
// The qualitative classifier reroutes the flag reconcile to present it as a neutral
// "Immune" status (never a red "Abnormal" attention flag) and cross-link to the
// immunization surface. Synthetic name that matches isDurableImmunityTiter.
const IMMUNE_FLAG_MARKER = "E2E Hepatitis B Surface Antibody";
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
).run(PROFILE_ID, IMMUNE_FLAG_MARKER);
db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, notes, flag, source)
   VALUES (?, '2023-05-01', 'lab', ?, 'Positive', ?, 'Immune', 'abnormal', 'manual')`
).run(PROFILE_ID, IMMUNE_FLAG_MARKER, IMMUNE_FLAG_MARKER);

// #548 — an IMMUTABLE identity attribute (blood type) the extractor stamped
// "abnormal", dated ~2 years old. The classifier makes it neutral (never abnormal)
// and exempt from the retest-stale clock, the way genomics + durable immunity are.
const BLOOD_TYPE_MARKER = "E2E ABO Blood Group";
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
).run(PROFILE_ID, BLOOD_TYPE_MARKER);
db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, flag, source)
   VALUES (?, '2023-05-01', 'lab', ?, 'A POSITIVE', ?, 'abnormal', 'manual')`
).run(PROFILE_ID, BLOOD_TYPE_MARKER, BLOOD_TYPE_MARKER);

// #542 — a titer series whose values carry an embedded unit ("58 mIU/mL") and a
// dilution ratio ("1:160"), both with value_num NULL. parseLeadingNumeric recovers
// the leading numeric at the chart boundary so these plot instead of vanishing.
const EMBEDDED_UNIT_MARKER = "E2E Rubella IgG Titer";
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
).run(PROFILE_ID, EMBEDDED_UNIT_MARKER);
const embeddedInsert = db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, source)
   VALUES (?, ?, 'lab', ?, ?, ?, 'manual')`
);
embeddedInsert.run(
  PROFILE_ID,
  "2024-02-01",
  EMBEDDED_UNIT_MARKER,
  "1:40",
  EMBEDDED_UNIT_MARKER
);
embeddedInsert.run(
  PROFILE_ID,
  "2025-02-01",
  EMBEDDED_UNIT_MARKER,
  "58 mIU/mL",
  EMBEDDED_UNIT_MARKER
);

// #543 — a purely qualitative series (no numeric anywhere) renders as a dated
// timeline instead of a blank numeric chart.
const QUALITATIVE_MARKER = "E2E Mumps IgG Screen";
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
).run(PROFILE_ID, QUALITATIVE_MARKER);
const qualInsert = db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, source)
   VALUES (?, ?, 'lab', ?, ?, ?, 'manual')`
);
qualInsert.run(
  PROFILE_ID,
  "2023-03-01",
  QUALITATIVE_MARKER,
  "Negative",
  QUALITATIVE_MARKER
);
qualInsert.run(
  PROFILE_ID,
  "2025-03-01",
  QUALITATIVE_MARKER,
  "Reactive",
  QUALITATIVE_MARKER
);

// Reconcile so the extractor's blunt "abnormal" flags are corrected before the
// specs read the page (the app's own boot reconcile is signature-gated and the seed
// already stamped the current signature, so it would skip these post-seed inserts).
reconcileFlags(PROFILE_ID);

// A recent qualitative lab with a valid directionless provider flag. The compact
// dashboard must say "Abnormal" explicitly: unlike high/low, this status cannot
// communicate its meaning with a directional caret. Inserted after reconciliation
// because this fixture models the provider-authored flag before a later canonical
// mapping is available.
const DIRECTIONLESS_LAB_MARKER = "E2E Directionless Lab Status";
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
).run(PROFILE_ID, DIRECTIONLESS_LAB_MARKER);
db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, flag, source)
   VALUES (?, ?, 'lab', ?, 'Detected', ?, 'abnormal', 'manual')`
).run(
  PROFILE_ID,
  shiftDateStr(today(PROFILE_ID), -1),
  DIRECTIONLESS_LAB_MARKER,
  DIRECTIONLESS_LAB_MARKER
);

// #383 — a lab whose raw name ("...CHOLESTEROL, TOTAL") differs from its
// displayed canonical heading ("...Total Cholesterol"), so the biomarker search
// must match the canonical name a user actually sees.
const CHOL_RAW = "E2E CHOLESTEROL, TOTAL";
const CHOL_CANONICAL = "E2E Total Cholesterol";
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
).run(PROFILE_ID, CHOL_CANONICAL);
db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
   VALUES (?, '2026-06-20', 'lab', ?, '185', 185, 'mg/dL', ?, 'manual')`
).run(PROFILE_ID, CHOL_RAW, CHOL_CANONICAL);

// #384 — two overlapping documents' twin of the same allergy (a unique synthetic
// substance so the assertion is deterministic): one manual, one imported from the
// e2e browser document. The "Recorded allergies" manager must collapse them to a
// single row, like its clinical-list siblings.
const RAGWEED = "E2E Ragweed";
db.prepare(`DELETE FROM allergies WHERE profile_id = ? AND substance = ?`).run(
  PROFILE_ID,
  RAGWEED
);
db.prepare(
  `INSERT INTO allergies (profile_id, substance, reaction, status, document_id)
   VALUES (?, ?, 'Sneezing', 'active', NULL)`
).run(PROFILE_ID, RAGWEED);
db.prepare(
  `INSERT INTO allergies (profile_id, substance, reaction, status, document_id)
   VALUES (?, ?, 'Sneezing', 'active', ?)`
).run(PROFILE_ID, RAGWEED, BROWSER_DOC_ID);

console.log(
  `e2e: seeded medical-smalls fixtures on profile ${PROFILE_ID} (#381 starred genomics, #383 canonical search, #384 allergy twins)`
);

// ── E2E coverage-gap fixtures (issue #391) ────────────────────────────────────
// Fill the browser-coverage holes the audit flagged: share links, immunizations,
// equipment, Strava/Health-Connect integration states, care-plan, AI-logs gate,
// and appointments. Anything that needs a NON-profile-1 active profile is served
// by a purpose-built member login + grant (created directly below) so the spec can
// sign in as an isolated session in its own cookie context — never mutating the
// shared admin storageState's active profile. All synthetic; idempotent.

// The instance-wide age gate, ON at 13 whole years. This is deliberately global,
// but SAFE for every existing spec: it restricts ONLY a profile whose known age is
// under 13, and the sole such profile is the ~18-month-old "Riley (child)". Profile
// 1 (the admin's active profile, ~40y) is never restricted, so the training /
// equipment specs that run as profile 1 are untouched; Test Child / Sam Rivers have
// no birthdate → unknown age → never restricted; and the demo webServer boots from
// scripts/seed.ts ONLY (no seed-events), so its DB never sees this setting. The two
// child-profile specs (kids-growth, pediatric-ranges) only visit Trends / Settings /
// Biomarkers as Riley — none of which the gate touches. The equipment-manager spec
// uses it to prove /settings/equipment bounces a restricted profile to /settings.
setMinTrainingAge(13);

// Create a member login (username + scrypt hash) granted exactly ONE profile at the
// given access level. INSERT OR IGNORE keeps it idempotent across a reused dev
// server; the grant is re-asserted either way. Returns the login id.
function seedMemberLogin(
  username: string,
  profileId: number,
  access: "read" | "write" = "write"
): number {
  db.prepare(
    "INSERT OR IGNORE INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
  ).run(username, hashPasswordSync(E2E_MEMBER_PASSWORD));
  const loginId = (
    db.prepare("SELECT id FROM logins WHERE username = ?").get(username) as {
      id: number;
    }
  ).id;
  db.prepare(
    `INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)
       ON CONFLICT(login_id, profile_id) DO UPDATE SET access = excluded.access`
  ).run(loginId, profileId, access);
  return loginId;
}

// Look up (or create) a fixture profile by name — idempotent for a reused server.
function fixtureProfileId(name: string): number {
  const existing = db
    .prepare("SELECT id FROM profiles WHERE name = ?")
    .get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Riley (child) is seeded by scripts/seed.ts; grant the child member to it.
const rileyId = (
  db.prepare("SELECT id FROM profiles WHERE name = ?").get("Riley (child)") as
    { id: number } | undefined
)?.id;
if (rileyId) seedMemberLogin(E2E_LOGIN_CHILD, rileyId);

// A dedicated profile whose Strava connection sits in the terminal `needs_reauth`
// state (dead/revoked refresh token, #326/#352): config kept (client id/secret) but
// NO access token, so the page reads !connected + needsReauth → the reconnect CTA.
const stravaReauthId = fixtureProfileId(STRAVA_REAUTH_PROFILE);
upsertConnection(stravaReauthId, "strava", {
  status: "needs_reauth",
  config: { clientId: "e2e-reauth-client", clientSecret: "e2e-reauth-secret" },
});
seedMemberLogin(E2E_LOGIN_STRAVA, stravaReauthId);

// A dedicated, connection-less profile for the Health Connect generate→rotate flow.
const healthConnectId = fixtureProfileId(HEALTH_CONNECT_PROFILE);
seedMemberLogin(E2E_LOGIN_HC, healthConnectId);

// A dedicated profile whose sole Data → Review item is a SAME-SOURCE duplicate:
// two manual weigh-ins on one day (both source NULL → both "Manual entry"), so the
// resolver's candidate labels collide and the A/B disambiguation fallback (#531) is
// exercised without touching profile 1's review inbox. Idempotent: clear the
// profile's body_metrics first (it owns no others). Distinct weights so the two rows
// visibly differ; body_metrics allows two NULL-source rows on one day.
const dupReviewId = fixtureProfileId(DUP_REVIEW_PROFILE);
seedMemberLogin(E2E_LOGIN_DUP, dupReviewId);

// A dedicated ADULT profile that owns NO equipment (issue #592) so the activity
// form's equipment picker renders its empty-state "Add equipment" bootstrap door.
// It owns nothing else either — the spec only opens the log form and reads the door.
const noGearId = fixtureProfileId(NO_GEAR_PROFILE);
db.prepare(`DELETE FROM equipment WHERE profile_id = ?`).run(noGearId);
seedMemberLogin(E2E_LOGIN_NOGEAR, noGearId);

function resetOnboardingProfile(profileId: number) {
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM medical_records WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM medical_documents WHERE profile_id = ?`).run(
    profileId
  );
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM appointments WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM immunizations WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM care_plan_items WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM goals WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM frequency_targets WHERE profile_id = ?`).run(
    profileId
  );
  db.prepare(`DELETE FROM equipment WHERE profile_id = ?`).run(profileId);
  db.prepare(
    `DELETE FROM routine_slots
    WHERE routine_day_id IN (
      SELECT rd.id FROM routine_days rd
      JOIN routines r ON r.id = rd.routine_id
      WHERE r.profile_id = ?
    )`
  ).run(profileId);
  db.prepare(
    `DELETE FROM routine_days
    WHERE routine_id IN (SELECT id FROM routines WHERE profile_id = ?)`
  ).run(profileId);
  db.prepare(`DELETE FROM routines WHERE profile_id = ?`).run(profileId);
  db.prepare(
    `DELETE FROM profile_settings WHERE profile_id = ? AND key = 'dashboard_layout'`
  ).run(profileId);
}

// Truly empty, isolated profiles for the goal-based onboarding paths (#719).
// Explicit state opts them into onboarding; every other fixture profile without
// the marker behaves as an existing profile and is never forced through setup.
const onboardingId = fixtureProfileId(ONBOARDING_PROFILE);
resetOnboardingProfile(onboardingId);
setOnboardingState(onboardingId, initialOnboardingState());
seedMemberLogin(E2E_LOGIN_ONBOARDING, onboardingId);

const caregiverOnboardingId = fixtureProfileId(ONBOARDING_CAREGIVER_PROFILE);
resetOnboardingProfile(caregiverOnboardingId);
setOnboardingState(caregiverOnboardingId, initialOnboardingState());
seedMemberLogin(E2E_LOGIN_ONBOARDING_CAREGIVER, caregiverOnboardingId);

// A populated legacy/existing profile gets orientation, never the empty-profile
// wizard. Clear the per-login dismissal so repeated e2e runs remain deterministic.
const orientationId = fixtureProfileId(ORIENTATION_PROFILE);
db.prepare(
  `DELETE FROM profile_settings WHERE profile_id = ? AND key = 'onboarding_state'`
).run(orientationId);
db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(orientationId);
db.prepare(
  `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
   VALUES (?, ?, 68.2, 'manual')`
).run(orientationId, today(orientationId));
const orientationLoginId = seedMemberLogin(
  E2E_LOGIN_ORIENTATION,
  orientationId,
  "read"
);
db.prepare(
  `DELETE FROM login_settings
    WHERE login_id = ? AND key = ?`
).run(orientationLoginId, `profile_orientation_v1:${orientationId}`);
// One logged activity so the Training "Log" tab renders the Journal (with its "New
// activity" button) instead of the empty state — the spec opens that add form to
// reach the equipment picker's empty-state door. An activity creates no equipment,
// so the profile's inventory stays empty. Idempotent by external_id.
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:nogear-seed'`
).run(noGearId);
db.prepare(
  `INSERT INTO activities (profile_id, date, type, title, duration_min, source, external_id, edited)
   VALUES (?, ?, 'cardio', 'E2E No Gear Walk', 20, 'manual', 'e2e:nogear-seed', 0)`
).run(noGearId, today(noGearId));
db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(dupReviewId);
const insDupWeighIn = db.prepare(
  `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
   VALUES (?, '2026-06-15', ?, NULL)`
);
insDupWeighIn.run(dupReviewId, 80.2);
insDupWeighIn.run(dupReviewId, 81.4);
console.log(
  `e2e: seeded a same-source (two manual weigh-ins) duplicate on profile ${dupReviewId} (A/B disambiguation, #531)`
);

// A dedicated ADULT profile for the routine-BUILDER specs (#739), SEPARATE from the
// routine-recommendation fixture below: that spec needs its profile's routine to stay
// ACTIVE (the Today's-session card), while the builder spec activates/deactivates
// routines — sharing a profile would let one spec break the other. Activating a
// routine also REPLACES the profile's training-scope frequency_targets, which is why
// neither fixture is profile 1 (whose seeded PPL targets other specs rely on). Seed a
// clean slate — no routines — plus two training-scope frequency targets so the
// activate-confirm dialog (which only appears when there ARE targets to replace) is
// exercised. Idempotent.
const routineBuilderProfileId = fixtureProfileId(ROUTINE_BUILDER_PROFILE);
seedMemberLogin(E2E_LOGIN_ROUTINE_BUILDER, routineBuilderProfileId);
db.prepare(
  `DELETE FROM routine_slots WHERE routine_day_id IN (
     SELECT rd.id FROM routine_days rd
       JOIN routines r ON r.id = rd.routine_id WHERE r.profile_id = ?)`
).run(routineBuilderProfileId);
db.prepare(
  `DELETE FROM routine_days WHERE routine_id IN (
     SELECT id FROM routines WHERE profile_id = ?)`
).run(routineBuilderProfileId);
db.prepare(`DELETE FROM routines WHERE profile_id = ?`).run(
  routineBuilderProfileId
);
db.prepare(
  `DELETE FROM frequency_targets WHERE profile_id = ? AND scope_kind IN ('region','group','type')`
).run(routineBuilderProfileId);
const insRoutineTarget = db.prepare(
  `INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id)
     VALUES (?, ?, ?, ?)`
);
insRoutineTarget.run("group", "Upper", 2, routineBuilderProfileId);
insRoutineTarget.run("group", "Lower", 2, routineBuilderProfileId);
console.log(
  `e2e: seeded routine-builder fixture profile ${routineBuilderProfileId} (${ROUTINE_BUILDER_PROFILE}) with two training-scope frequency targets (#739)`
);

// A dedicated ADULT profile with NOTHING logged (#809): the brand-new/post-onboarding
// first-run state that every other fixture profile lacks. Kept activity-free so the
// training-first-run spec can assert the Journal's first-run empty variant renders the
// action row (Start workout + New activity, no Repeat last). Idempotent: hard-clear any
// activities (and their sets) on a reused server so the profile can never drift out of
// its empty contract.
const emptyTrainingId = fixtureProfileId(EMPTY_TRAINING_PROFILE);
db.prepare(
  `DELETE FROM exercise_sets WHERE activity_id IN (
     SELECT id FROM activities WHERE profile_id = ?)`
).run(emptyTrainingId);
db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(emptyTrainingId);
seedMemberLogin(E2E_LOGIN_EMPTY_TRAINING, emptyTrainingId);
console.log(
  `e2e: seeded activity-free first-run fixture profile ${emptyTrainingId} (${EMPTY_TRAINING_PROFILE}) for the Training Log empty state (#809)`
);

console.log(
  `e2e: enabled age gate (13) + seeded member logins for the child (${rileyId}), Strava-reauth (${stravaReauthId}), and Health-Connect (${healthConnectId}) fixture profiles (#391)`
);

// A dedicated ADULT profile with an ACTIVE Push/Pull/Legs routine (#740) at
// position 0 (Push day) and NO recovery data, so the Training overview resolves
// today's routine session and renders the "Today's session" card without a rest
// override. Idempotent: reset the routine tables for this profile, then adopt +
// activate the PPL template fresh (activate resets position to 0 → Push day).
const routineProfileId = fixtureProfileId(ROUTINE_PROFILE);
db.prepare(
  `DELETE FROM routine_slots WHERE routine_day_id IN (
     SELECT rd.id FROM routine_days rd
       JOIN routines r ON r.id = rd.routine_id
      WHERE r.profile_id = ?
   )`
).run(routineProfileId);
db.prepare(
  `DELETE FROM routine_days WHERE routine_id IN (
     SELECT id FROM routines WHERE profile_id = ?
   )`
).run(routineProfileId);
db.prepare(`DELETE FROM routines WHERE profile_id = ?`).run(routineProfileId);
const routineId = adoptTemplate(routineProfileId, "push-pull-legs-6x");
activateRoutine(routineProfileId, routineId);
seedMemberLogin(E2E_LOGIN_ROUTINE, routineProfileId);
console.log(
  `e2e: seeded an active PPL routine on profile ${routineProfileId} (Today's session card, #740)`
);

// A dedicated ADULT profile with an ACTIVE PPL routine whose mesocycle places TODAY
// in the DELOAD week (#741): a 2-week cycle whose started_date is backdated 7 days
// (weekInCycle = floor(7/7) % 2 = 1 = the last, deload week). No credited sessions in
// that 7-day span, so the pause re-anchor never trips (gap 7 < 21). SEPARATE from
// ROUTINE_PROFILE so the #740 recommendation spec's non-deload copy stays intact.
const deloadProfileId = fixtureProfileId(ROUTINE_DELOAD_PROFILE);
db.prepare(
  `DELETE FROM routine_slots WHERE routine_day_id IN (
     SELECT rd.id FROM routine_days rd
       JOIN routines r ON r.id = rd.routine_id
      WHERE r.profile_id = ?
   )`
).run(deloadProfileId);
db.prepare(
  `DELETE FROM routine_days WHERE routine_id IN (
     SELECT id FROM routines WHERE profile_id = ?
   )`
).run(deloadProfileId);
db.prepare(`DELETE FROM routines WHERE profile_id = ?`).run(deloadProfileId);
const deloadRoutineId = adoptTemplate(deloadProfileId, "push-pull-legs-6x");
activateRoutine(deloadProfileId, deloadRoutineId);
db.prepare(
  `UPDATE routines SET cycle_weeks = 2, started_date = ? WHERE id = ?`
).run(shiftDateStr(today(deloadProfileId), -7), deloadRoutineId);
seedMemberLogin(E2E_LOGIN_ROUTINE_DELOAD, deloadProfileId);
console.log(
  `e2e: seeded an active PPL routine in its deload week on profile ${deloadProfileId} (#741)`
);

// A profile-1 equipment row REFERENCED by a logged strength set, so the equipment
// manager's delete can prove it detaches the link (nulls exercise_sets.equipment_id)
// and the referencing session still renders — no FK 500 (the #342 side-state rule).
// Idempotent: rebuilt from scratch each boot.
db.prepare(
  `DELETE FROM equipment WHERE profile_id = ? AND name = 'E2E Delete Bar'`
).run(PROFILE_ID);
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:equip-delete'`
).run(PROFILE_ID);
const delBarId = Number(
  db
    .prepare(
      `INSERT INTO equipment (profile_id, name, weight_kg, category)
       VALUES (?, 'E2E Delete Bar', 20, 'Barbell')`
    )
    .run(PROFILE_ID).lastInsertRowid
);
const delActId = Number(
  db
    .prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, duration_min, source, external_id, edited)
       VALUES (?, ?, 'strength', 'E2E Equipment Delete Session', 30, 'manual', 'e2e:equip-delete', 0)`
    )
    .run(PROFILE_ID, shiftDateStr(today(PROFILE_ID), -1)).lastInsertRowid
);
db.prepare(
  `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, equipment_id)
   VALUES (?, 'Bench Press', 1, 60, 5, ?)`
).run(delActId, delBarId);

// A DEDICATED, non-retired profile-1 Bike used by a session-level cardio activity
// (activities.equipment_id), for the equipment-registry spec (issue #343): it
// proves the /equipment index renders a usage badge + a Cardio group, and its
// /equipment/[id] detail renders the sessions/last-used/total-distance payoff.
// Distinct name from "E2E Delete Bar" (the delete spec's fixture) so the two specs
// never race on the same row. Idempotent: rebuilt from scratch each boot.
db.prepare(
  `DELETE FROM equipment WHERE profile_id = ? AND name = 'E2E Registry Bike'`
).run(PROFILE_ID);
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:equip-registry-ride'`
).run(PROFILE_ID);
const regBikeId = Number(
  db
    .prepare(
      `INSERT INTO equipment (profile_id, name, weight_kg, category)
       VALUES (?, 'E2E Registry Bike', NULL, 'Bike')`
    )
    .run(PROFILE_ID).lastInsertRowid
);
db.prepare(
  `INSERT INTO activities
     (profile_id, date, type, title, duration_min, distance_km, source, external_id, edited, equipment_id)
   VALUES (?, ?, 'cardio', 'E2E Registry Ride', 45, 20, 'manual', 'e2e:equip-registry-ride', 0, ?)`
).run(PROFILE_ID, shiftDateStr(today(PROFILE_ID), -2), regBikeId);

// A dedicated recovery device on profile 1 for the protocol-practice spec (issue
// #344): the protocol form can reference it as the gear its experiment is about.
// Distinct, synthetic name so it never collides with the equipment specs' rows.
// Idempotent: rebuilt each boot.
db.prepare(
  `DELETE FROM equipment WHERE profile_id = ? AND name = 'E2E Protocol Sauna'`
).run(PROFILE_ID);
db.prepare(
  `INSERT INTO equipment (profile_id, name, weight_kg, category)
   VALUES (?, 'E2E Protocol Sauna', NULL, 'Sauna')`
).run(PROFILE_ID);

// A dedicated STRENGTH implement on profile 1 for the protocols "Recovery gear"
// filter spec (issue #592): the protocol form must offer the recovery Sauna above
// but NOT this Barbell. Distinct name so it never collides with the equipment
// specs' "E2E Delete Bar" (which the manager delete spec removes). Idempotent.
db.prepare(
  `DELETE FROM equipment WHERE profile_id = ? AND name = 'E2E Protocol Barbell'`
).run(PROFILE_ID);
db.prepare(
  `INSERT INTO equipment (profile_id, name, weight_kg, category)
   VALUES (?, 'E2E Protocol Barbell', 20, 'Barbell')`
).run(PROFILE_ID);

// A dedicated, open, FUTURE-dated care-plan item on profile 1 for the care-plan
// spec's complete→disappears-from-Upcoming check. Distinct from the base seed's
// care-plan rows (which care-plan-upcoming.spec drives), so the two never collide.
// The description must match NO preventive concept-map phrase (an earlier "eye
// exam" wording, once the spec completed it, was inferred as satisfying the
// vision_exam rule and broke preventive-upcoming's still-due control assertion).
db.prepare(
  `DELETE FROM care_plan_items WHERE profile_id = ? AND description IN ('E2E annual eye exam', 'E2E orthotics fitting')`
).run(PROFILE_ID);
db.prepare(
  `INSERT INTO care_plan_items
     (profile_id, description, category, planned_date, status, notes)
   VALUES (?, 'E2E orthotics fitting', 'procedure', ?, 'planned', 'Custom insole fitting')`
).run(PROFILE_ID, shiftDateStr(today(PROFILE_ID), 21));

// A dedicated, FUTURE, scheduled appointment on profile 1 (with a provider) for the
// appointments spec's cancel→removed-from-Upcoming check — separate from the base
// seed's appointments so cancelling it can't disturb the family-calendar / upcoming
// fixtures. Provider linked via a dedicated synthetic clinic.
db.prepare(
  `DELETE FROM appointments WHERE profile_id = ? AND title = 'E2E dermatology visit'`
).run(PROFILE_ID);
db.prepare(`DELETE FROM providers WHERE dedup_key = 'e2e-appt-clinic'`).run();
const apptProviderId = Number(
  db
    .prepare(
      `INSERT INTO providers (name, type, dedup_key)
       VALUES ('E2E Skin Clinic', 'organization', 'e2e-appt-clinic')`
    )
    .run().lastInsertRowid
);
db.prepare(
  `INSERT INTO appointments (profile_id, scheduled_at, provider_id, title, location, status)
   VALUES (?, ?, ?, 'E2E dermatology visit', 'E2E Skin Clinic', 'scheduled')`
).run(
  PROFILE_ID,
  `${shiftDateStr(today(PROFILE_ID), 4)} 09:30`,
  apptProviderId
);

console.log(
  `e2e: seeded an equipment-delete link fixture, an open care-plan item, and a future appointment on profile ${PROFILE_ID} (#391)`
);

// ── Duplicate-immunization delete-confirm fixture (issue #534) ────────────────
// Two yellow-fever doses on the SAME date for profile 1, so the immunizations
// delete confirm — keyed on "vaccine + date" — would read identically for both
// without the distinguishing dose label the #534 fix folds in. Yellow fever is a
// travel/record-only vaccine (never due/overdue), so this can't perturb any CDC
// schedule-status assertion. Distinct dose labels give the confirm something to
// disambiguate on. Idempotent: clear the marked rows first.
db.prepare(
  `DELETE FROM immunizations WHERE profile_id = ? AND notes = 'e2e:dup-immz'`
).run(PROFILE_ID);
const insDupImmz = db.prepare(
  `INSERT INTO immunizations (profile_id, date, vaccine, dose_label, notes, source)
   VALUES (?, '2024-05-01', 'yellow_fever', ?, 'e2e:dup-immz', NULL)`
);
insDupImmz.run(PROFILE_ID, "Travel dose A");
insDupImmz.run(PROFILE_ID, "Travel dose B");
console.log(
  `e2e: seeded two same-date yellow-fever immunizations on profile ${PROFILE_ID} (delete-confirm disambiguation, #534)`
);

// ── Same-named provider pair for the merge disambiguation (issue #532) ────────
// Two organizations that share the name "E2E Duplicate Lab" but carry distinct
// identifiers + addresses (so distinct dedup keys). The admin merge picker + its
// irreversible confirm must label them by the differing field, not by the byte-
// identical name — otherwise the destructive pick is blind on the exact case merge
// targets. Idempotent: clear both by dedup_key first. Unlinked (no records), so the
// merge-disambig spec can open the picker/confirm and CANCEL without side effects.
for (const key of ["id:e2e-dup-lab-a", "id:e2e-dup-lab-b"]) {
  db.prepare(`DELETE FROM providers WHERE dedup_key = ?`).run(key);
}
const insDupProvider = db.prepare(
  `INSERT INTO providers (name, type, identifier, address, dedup_key)
   VALUES ('E2E Duplicate Lab', 'organization', ?, ?, ?)`
);
insDupProvider.run(
  "e2e-dup-lab-a",
  "100 Alpha St, Springfield",
  "id:e2e-dup-lab-a"
);
insDupProvider.run(
  "e2e-dup-lab-b",
  "200 Beta Ave, Portland",
  "id:e2e-dup-lab-b"
);
console.log(
  "e2e: seeded two same-named 'E2E Duplicate Lab' providers (merge disambiguation, #532)"
);

// ── Two-document body-metric source comparison (issue #533) ───────────────────
// A metric extracted from TWO different documents stays two distinct series, but
// the legend/picker used to collapse both to one "Document" label and one teal
// color. Seed two DEXA-style documents on a DEDICATED member profile plus a
// body-fat reading sourced from each (source 'document:<id>') and one manual
// reading, so Trends → Body's "Compare sources" renders a body_fat card whose two
// document series carry distinct filenames + colors. Dedicated profile ON PURPOSE
// (first landing tried profile 1 and broke two sibling specs): extra documents on
// profile 1 pluralize review-inbox's re-extract-all "1 scan/PDF" copy, and a
// multi-source body_fat adds a second "Body fat" heading (the compare card's h3)
// that collides kids-growth's strict heading locator. Distinct dates per row so
// the profile never grows a same-day body-metric conflict.
const compareProfileId = fixtureProfileId(SOURCE_COMPARE_PROFILE);
seedMemberLogin(E2E_LOGIN_COMPARE, compareProfileId);
db.prepare(
  `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN ('e2e-dexa-a.pdf', 'e2e-dexa-b.pdf')`
).run(compareProfileId);
const insCompareDoc = db.prepare(
  `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes, doc_type, source,
      document_date, extraction_status, extracted_count, content_hash, uploaded_at)
   VALUES (?, ?, ?, 'application/pdf', 1024, 'dexa', 'upload', ?, 'done', 1, ?, ?)`
);
const compareDocs: { id: number; date: string; bodyFat: number }[] = [];
for (const [filename, date, bodyFat] of [
  ["e2e-dexa-a.pdf", "2022-11-01", 21.4],
  ["e2e-dexa-b.pdf", "2022-11-03", 19.8],
] as const) {
  const id = Number(
    insCompareDoc.run(
      compareProfileId,
      filename,
      `data/uploads/medical/${compareProfileId}/${filename}`,
      date,
      `e2e533${filename.replace(/\W/g, "")}`.padEnd(64, "0"),
      `${date} 08:00:00`
    ).lastInsertRowid
  );
  compareDocs.push({ id, date, bodyFat });
}
// Reset the profile's body metrics wholesale (it owns nothing else), then one
// row per document + one manual row on distinct dates.
db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(
  compareProfileId
);
for (const { id, date, bodyFat } of compareDocs) {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, body_fat_pct, source)
     VALUES (?, ?, ?, ?)`
  ).run(compareProfileId, date, bodyFat, `document:${id}`);
}
db.prepare(
  `INSERT INTO body_metrics (profile_id, date, body_fat_pct, source)
   VALUES (?, '2022-11-05', 20.6, NULL)`
).run(compareProfileId);
console.log(
  `e2e: seeded two-document body-fat source comparison on profile ${compareProfileId} (#533)`
);

// An uncatalogued biomarker lab so the Coverage gaps page (#550) has a real
// derivable gap to opt into. The canonical name is deliberately synthetic and
// absent from every curated seed / #482 family, so detection surfaces it as a
// candidate. Idempotent: cleared then re-inserted on each seed run.
const COVERAGE_GAP_ANALYTE = "Serum Fictionase (e2e)";
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
).run(PROFILE_ID, COVERAGE_GAP_ANALYTE);
db.prepare(
  `INSERT INTO medical_records (profile_id, date, category, name, value_num, unit, canonical_name)
   VALUES (?, '2026-05-01', 'lab', ?, 42, 'U/L', ?)`
).run(PROFILE_ID, COVERAGE_GAP_ANALYTE, COVERAGE_GAP_ANALYTE);
console.log(
  `e2e: seeded uncatalogued biomarker "${COVERAGE_GAP_ANALYTE}" on profile ${PROFILE_ID} for coverage gaps (#550)`
);

// Deterministic biomarker→food suggestion fixtures (#577). Currently-flagged-LOW
// diet-responsive readings on profile 1 so the food-suggestion surfaces render, and a
// synthetic "fish" allergy so the omega-3 suggestion shows its algae/ALA ALTERNATIVE
// (the allergy screen). The seeded Warfarin med (scripts/seed.ts) supplies the
// MEDICATION screen — the folate suggestion carries the vitamin-K consistency note.
// Idempotent: cleared by canonical_name then re-inserted; value_num is genuinely below
// the reference low so the flag stays 'low' through any reconcile.
for (const bm of [
  { name: "Omega-3 Total (OmegaCheck)", value: 3.0, unit: "% by wt" },
  { name: "Folate", value: 2.0, unit: "ng/mL" },
  // #774: an expanded-coverage low nutrient (selenium → brazil nuts).
  { name: "Selenium", value: 45, unit: "ug/L" },
]) {
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, bm.name);
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value_num, value, unit, canonical_name, flag)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, 'low')`
  ).run(
    PROFILE_ID,
    shiftDateStr(today(PROFILE_ID), -7),
    bm.name,
    bm.value,
    String(bm.value),
    bm.unit,
    bm.name
  );
}
// #775: a flagged-HIGH core-panel reading so the REDUCE direction renders (high LDL →
// cut-back on fried food / processed meat). Kept off omega-3 so it can't disturb the
// existing omega-3-alternative assertions. Idempotent by canonical_name.
{
  const name = "LDL Cholesterol";
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, name);
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value_num, value, unit, canonical_name, flag)
     VALUES (?, ?, 'lab', ?, 190, '190', 'mg/dL', ?, 'high')`
  ).run(PROFILE_ID, shiftDateStr(today(PROFILE_ID), -7), name, name);
}
if (
  !db
    .prepare(
      `SELECT 1 FROM allergies WHERE profile_id = ? AND substance = 'fish' COLLATE NOCASE`
    )
    .get(PROFILE_ID)
) {
  db.prepare(
    `INSERT INTO allergies (profile_id, substance, reaction, severity, status, source)
     VALUES (?, 'fish', 'Hives', 'moderate', 'active', 'manual')`
  ).run(PROFILE_ID);
}
console.log(
  `e2e: seeded low omega-3/folate/selenium (#577/#774) + high LDL (#775 reduce) readings and a fish allergy on profile ${PROFILE_ID} for food suggestions`
);

// A hand-edited imported body-metric row (the user-edit lock, #133) on the default
// profile so the Trends → Body edit-lock badge + "Resume sync updates" affordance
// (#659) has a row to render. Synthetic value; source is an integration so the row
// is genuinely sync-owned (only those carry the lock). Idempotent by (date, source).
// Date 2026-06-05 is deliberately a GAP in the weekly manual-weight cadence (rows
// land on 06-02 and 06-09): a Withings weight sharing a day with a manual weight
// would register as a same-day body-metric conflict (getBodyMetricConflicts) and
// silently inflate the Data → Review badge, which import-dedup.spec asserts exactly.
db.prepare(
  `DELETE FROM body_metrics WHERE profile_id = ? AND date = '2026-06-05' AND source = 'withings'`
).run(PROFILE_ID);
db.prepare(
  `INSERT INTO body_metrics (profile_id, date, weight_kg, source, edited)
   VALUES (?, '2026-06-05', 77.7, 'withings', 1)`
).run(PROFILE_ID);
console.log(
  `e2e: seeded an edit-locked (hand-edited) Withings body-metric row on profile ${PROFILE_ID} for the edit-lock badge (#659)`
);

// A permanently-OPEN weekly frequency target for the pace-tone spec (#780/#782): a
// region target on Glutes, the ONE muscle region no seeded exercise maps to
// (regionForExercise: Deadlift/Row/Pull Up → Back, Squat/RDL/Leg Press/Leg Curl/
// Calf Raise → Legs, Plank → Core — nothing Glutes-primary in scripts/seed.ts or
// this file), so the seeded history can never satisfy it in ANY week. The dashboard
// Goals-and-habits card hides MET habits, and by mid-week the four scripts/seed.ts
// targets are all met — leaving zero chips and a day-of-week-dependent spec. This
// target stays 0/5 all week → always at least one open chip, whose pace is
// "on-pace" (day 1) or "behind" (later) — never met, never rose — exactly the
// invariant pace-tone.spec.ts pins. Idempotent by (profile, kind, value).
db.prepare(
  `DELETE FROM frequency_targets
    WHERE profile_id = ? AND scope_kind = 'region' AND scope_value = 'Glutes'`
).run(PROFILE_ID);
db.prepare(
  `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
   VALUES (?, 'region', 'Glutes', 5)`
).run(PROFILE_ID);
console.log(
  `e2e: seeded a never-satisfiable Glutes 5x/week frequency target on profile ${PROFILE_ID} for pace-tone.spec (#780)`
);

// ── Illness hero fixtures (#858) ──────────────────────────────────────────────
// Dedicated logins/profiles for the illness hero so its mutations (collapse state, a
// cross-profile dose/temp) never touch the shared admin session (profile 1's live
// episode) — repeat-safe under CI's --repeat-each=3. The DB is reset each webServer
// boot, so these inserts don't accumulate across boots; the episode row is DELETE'd
// first for a reused dev server.
function seedSickEpisode(
  profileId: number,
  opts: { activateSituation?: boolean; prnMed?: boolean } = {}
): void {
  const on = today(profileId);
  const start = shiftDateStr(on, -2);
  const yesterday = shiftDateStr(on, -1);

  if (opts.activateSituation) {
    // The built-in illness-type situation, ACTIVE — so hasActiveIllnessSituation() keys
    // this profile's OWN full cockpit to the hero. Idempotent for a reused dev server.
    const existing = db
      .prepare(
        "SELECT id FROM situations WHERE profile_id = ? AND name = 'Illness'"
      )
      .get(profileId) as { id: number } | undefined;
    const sitId =
      existing?.id ??
      Number(
        db
          .prepare(
            "INSERT INTO situations (profile_id, name, active, illness_type) VALUES (?, 'Illness', 1, 1)"
          )
          .run(profileId).lastInsertRowid
      );
    db.prepare(
      "UPDATE situations SET active = 1, illness_type = 1 WHERE id = ?"
    ).run(sitId);
  }

  // The open episode ROW (#856) — identity for the cockpit; membership stays derived.
  db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(
    profileId
  );
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(profileId, start);

  // Symptoms (worst-severity upsert like the runtime core) + a small fever curve.
  const seedSym = db.prepare(
    `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (profile_id, date, symptom)
     DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity)`
  );
  seedSym.run(profileId, yesterday, "cough", 2);
  seedSym.run(profileId, on, "cough", 2);
  seedSym.run(profileId, on, "fever", 3);

  const tId = Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit,
            canonical_name, source, notes)
         VALUES (?, ?, 'vitals', 'Body Temperature', ?, ?, 'degF',
                 'Body Temperature', 'manual', ?)`
      )
      // An early clock time so a "now" reading a caregiver logs later in the day always
      // outranks it as the LATEST temp (the multi-sick cross-profile-temp spec asserts the
      // logged value shows in the accordion line).
      .run(profileId, on, "101.3", 101.3, "00:05").lastInsertRowid
  );
  reconcileFlags(profileId, [tId]);

  if (opts.prnMed) {
    // A PRN med with confirmed interval/max (so the cockpit redose line computes) but NO
    // prior administration — the co-caregiver dose the spec logs is the FIRST, so its
    // "last ibuprofen …" clause appears on the other caregiver's hero only after it.
    const has = db
      .prepare(
        "SELECT id FROM intake_items WHERE profile_id = ? AND name = 'Ibuprofen' AND as_needed = 1"
      )
      .get(profileId) as { id: number } | undefined;
    if (!has) {
      const medId = Number(
        db
          .prepare(
            `INSERT INTO intake_items
               (profile_id, name, active, kind, condition, priority, as_needed,
                quantity_on_hand, qty_per_dose, min_interval_hours, max_daily_count)
             VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'high', 1, 20, 1, 6, 4)`
          )
          .run(profileId).lastInsertRowid
      );
      // A PRN med needs a dose row — logAdministration resolves the loggable dose through
      // it (the item form guarantees one at runtime; the seed must mirror that).
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '400 mg', 'any', 'any', 0)`
      ).run(medId);
    }
  }
}

function grantProfile(
  loginId: number,
  profileId: number,
  access: "read" | "write" = "write"
): void {
  db.prepare(
    `INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)
       ON CONFLICT(login_id, profile_id) DO UPDATE SET access = excluded.access`
  ).run(loginId, profileId, access);
}

// Base (well) caregiver profiles FIRST so they carry the lowest ids among each
// caregiver's grants — createSession picks accessibleProfiles[0] (lowest id) as the
// active profile, so each caregiver lands acting as their OWN well profile (not a kid).
const careParentId = fixtureProfileId(CARE_PARENT_PROFILE);
const coCareParentId = fixtureProfileId(COCARE_PARENT_PROFILE);
const sickKidAId = fixtureProfileId(SICK_KID_A_PROFILE);
const sickKidBId = fixtureProfileId(SICK_KID_B_PROFILE);
const sickSelfId = fixtureProfileId(SICK_SELF_PROFILE);
const sickCollapseId = fixtureProfileId(SICK_COLLAPSE_PROFILE);

seedSickEpisode(sickSelfId, { activateSituation: true });
seedSickEpisode(sickCollapseId, { activateSituation: true });
seedSickEpisode(sickKidAId, { prnMed: true });
seedSickEpisode(sickKidBId, {});

// SICK_SELF: sole (active) profile is sick → its own FULL cockpit at hero position.
seedMemberLogin(E2E_LOGIN_SICK_SELF, sickSelfId);
// SICK_COLLAPSE: a separate sick-solo login for the collapse-persistence test.
seedMemberLogin(E2E_LOGIN_SICK_COLLAPSE, sickCollapseId);

// CARE: acts as the well Care Parent, granted both sick kids → two accordion cockpits.
const careLoginId = seedMemberLogin(E2E_LOGIN_CARE, careParentId);
grantProfile(careLoginId, sickKidAId);
grantProfile(careLoginId, sickKidBId);

// COCARE: a second caregiver granted Kid A (shared with CARE) → the co-caregiver case.
const coCareLoginId = seedMemberLogin(E2E_LOGIN_COCARE, coCareParentId);
grantProfile(coCareLoginId, sickKidAId);

console.log(
  `e2e: seeded illness-hero fixtures — sick self ${sickSelfId}, sick kids ${sickKidAId}/${sickKidBId}, caregivers ${careLoginId}/${coCareLoginId} (#858)`
);

// CONDITION_REVIEW (#685): a dedicated profile carrying a positive infection lab
// result NOT on its problem list, so the condition-suggestion review item surfaces on
// Upcoming with the "Add to conditions" confirm. Isolated on purpose — the spec drives
// a confirm/dismiss flow that mutates the problem list, and self-heals per run.
const condReviewId = fixtureProfileId(CONDITION_REVIEW_PROFILE);
db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, canonical_name, value, loinc)
   VALUES (?, date('now'), 'lab', 'HIV 1/2 Antibody', 'HIV 1/2 Antibody', 'Reactive', '56888-1')`
).run(condReviewId);
seedMemberLogin(E2E_LOGIN_CONDREV, condReviewId);
console.log(
  `e2e: seeded condition-suggestion fixture — profile ${condReviewId} (#685)`
);
