// Extra e2e fixture rows layered on top of the normal sample seed (scripts/seed.ts):
// a few integration sync events so the Data → Review inbox has content to render,
// including one currently-failing provider (Strava) that must surface under
// "Needs attention" and drive the profile-menu badge. Runs against the same
// ALLOS_DB_PATH the webServer boots with (see playwright.config.ts).
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { db, today } from "../lib/db";
import { shiftDateStr } from "../lib/date";
import { writeRawPayload } from "../lib/integrations/raw-log";
import { upsertConnection } from "../lib/integrations/connections";
import {
  setDashboardLayout,
  setProfileSetting,
  setSetting,
  setWeekMode,
} from "../lib/settings";

// A persisted notification-delivery failure (#131) so Settings → Server surfaces
// the "Last notification delivery failed" marker for the e2e to assert. Synthetic
// error text — no PHI. Mirrors what dispatch() writes on a failed Telegram send.
setSetting(
  "notify_last_error",
  "Telegram API 401: Unauthorized (bot token revoked)"
);
setSetting("notify_last_error_at", "2026-07-09T08:00:00.000Z");
setSetting("notify_last_error_channel", "telegram");

const PROFILE_ID = 1;

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
// "Next workout" card reads "Second easy day" (a continuing easy stretch) rather
// than a fresh "Rest or take it easy today" alert. Dates follow the app timezone
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
  `e2e: seeded a 6-week Skullcrusher plateau and a weight jump on ${jumpDate} (#45)`
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

// ── Import-detail tabbed records-browser fixture (issue #271) ─────────────────
// A 'done' document that produced rows across several kinds — labs + a
// prescription (medical_records), a visit, a condition, an immunization, and a
// referenced provider — so the records browser has a multi-tab strip to render:
// default tab, ?tab= selection, category-correct row links (the prescription →
// /medicine regression), the read-only visit listing deep-linking to
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
