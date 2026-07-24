// Extra e2e fixture rows layered on top of the normal sample seed (scripts/seed.ts):
// a few integration sync events so the Data → Review inbox has content to render,
// including one currently-failing provider (Strava) that must surface under
// "Needs attention" and drive the profile-menu badge. Runs against the same
// ALLOS_DB_PATH the webServer boots with (see playwright.config.ts).
import "../scripts/load-env";

import fs from "node:fs";
import path from "node:path";

import { db, today, writeTx } from "../lib/db";
import { now as clockNow } from "../lib/clock";
import {
  shiftDateStr,
  utcSqlString,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "../lib/date";
import { writeRawPayload } from "../lib/integrations/raw-log";
import { upsertConnection } from "../lib/integrations/connections";
import { seedDupReviewPair } from "./dup-review-fixture";
import { EDIT_LOCK_SIGNATURE } from "./edit-lock-fixture";
import {
  setDashboardLayout,
  setProfileSetting,
  setWeekMode,
} from "../lib/settings";
import { setDeliveryFailure } from "../lib/notifications/delivery-marker";
import { setMinTrainingAge } from "../lib/age-gate";
import { saveFitnessEntry } from "../lib/fitness-assessment";
import { reconcileFlags } from "../lib/queries";
import { hashPasswordSync } from "../lib/password";
import {
  resetOnboardingProfileRows,
  writeWizardEntryState,
} from "./onboarding-reset";
import {
  E2E_LOGIN_CHILD,
  E2E_LOGIN_COMPARE,
  E2E_LOGIN_DUP,
  E2E_LOGIN_EMPTY_TRAINING,
  E2E_LOGIN_SLEEP_EDIT,
  E2E_LOGIN_SLEEP_PHASE,
  E2E_LOGIN_SLEEP_SEGMENTED,
  E2E_LOGIN_MENTAL,
  MENTAL_HEALTH_PROFILE,
  E2E_LOGIN_SUBSTANCE,
  SUBSTANCE_PROFILE,
  E2E_LOGIN_PREVENTIVE,
  PREVENTIVE_PROFILE,
  E2E_LOGIN_CRISIS,
  CRISIS_PROFILE,
  CRISIS_OVERRIDE_LABEL,
  CRISIS_OVERRIDE_CONTACT,
  E2E_LOGIN_NUTRITION,
  NUTRITION_PROFILE,
  E2E_LOGIN_CYCLE,
  CYCLE_PROFILE,
  E2E_LOGIN_DAILY,
  DAILY_LOOP_PROFILE,
  E2E_LOGIN_WEIGHT_QA,
  WEIGHT_QUICKADD_PROFILE,
  E2E_LOGIN_NAV_FEMALE,
  NAV_FEMALE_PROFILE,
  E2E_LOGIN_NAV_MALE,
  NAV_MALE_PROFILE,
  E2E_LOGIN_HC,
  E2E_LOGIN_MOBILE_HC,
  MOBILE_HC_PROFILE,
  E2E_LOGIN_NOGEAR,
  E2E_LOGIN_FITNESS,
  E2E_LOGIN_FITNESS_SENIOR,
  E2E_LOGIN_MOBILITY,
  MOBILITY_PROFILE,
  E2E_LOGIN_ROUTINE,
  E2E_LOGIN_ROUTINE_BUILDER,
  E2E_LOGIN_ROUTINE_DELOAD,
  E2E_LOGIN_FORM_DELOAD,
  E2E_LOGIN_FORM_PLATEAU,
  E2E_LOGIN_FORM_INJURY,
  E2E_LOGIN_ONBOARDING,
  E2E_LOGIN_ONBOARDING_CAREGIVER,
  E2E_LOGIN_STRAVA,
  E2E_LOGIN_WEATHER,
  WEATHER_PROFILE,
  E2E_LOGIN_MULTI,
  MULTI_OWNER_PROFILE,
  MULTI_SHARED_PROFILE,
  MULTI_OWNER_DOSE,
  MULTI_SHARED_DOSE,
  E2E_LOGIN_MVMEDS,
  MVMEDS_SELF_PROFILE,
  MVMEDS_RO_PROFILE,
  MVMEDS_SELF_MED,
  MVMEDS_RO_MED,
  MULTI_OWNER_CONDITION,
  MULTI_SHARED_CONDITION,
  MULTI_OWNER_ALLERGY,
  MULTI_SHARED_ALLERGY,
  MULTI_OWNER_GOAL,
  MULTI_SHARED_GOAL,
  MULTI_ACTIVITY_DATE,
  MULTI_OWNER_ACTIVITY_A,
  MULTI_OWNER_ACTIVITY_B,
  MULTI_SHARED_ACTIVITY,
  E2E_LOGIN_TL_MULTI,
  TL_EAST_PROFILE,
  TL_WEST_PROFILE,
  TL_EAST_ACTIVITY,
  TL_WEST_ACTIVITY,
  TL_EAST_TZ,
  TL_WEST_TZ,
  MULTI_OWNER_VISIT,
  MULTI_SHARED_VISIT,
  MULTI_OWNER_VACCINE,
  MULTI_SHARED_VACCINE,
  E2E_LOGIN_OWN,
  OWN_SELF_PROFILE,
  OWN_OTHER_PROFILE,
  OWN_SELF_DOSE,
  OWN_OTHER_DOSE,
  E2E_MEMBER_PASSWORD,
  DUP_REVIEW_PROFILE,
  EMPTY_TRAINING_PROFILE,
  SLEEP_EDIT_PROFILE,
  SLEEP_PHASE_PROFILE,
  SLEEP_SEGMENTED_PROFILE,
  HEALTH_CONNECT_PROFILE,
  NO_GEAR_PROFILE,
  FITNESS_PROFILE,
  FITNESS_SENIOR_PROFILE,
  ROUTINE_BUILDER_PROFILE,
  ROUTINE_DELOAD_PROFILE,
  FORM_DELOAD_PROFILE,
  FORM_PLATEAU_PROFILE,
  FORM_INJURY_PROFILE,
  ROUTINE_PROFILE,
  ONBOARDING_CAREGIVER_PROFILE,
  ONBOARDING_PROFILE,
  SOURCE_COMPARE_PROFILE,
  STRAVA_REAUTH_PROFILE,
  E2E_LOGIN_SICK_SELF,
  SICK_SELF_PROFILE,
  E2E_LOGIN_SICK_COLLAPSE,
  SICK_COLLAPSE_PROFILE,
  E2E_LOGIN_SITCOACH,
  SITCOACH_PROFILE,
  E2E_LOGIN_ILLNESS_CARE,
  ILLNESS_CARE_PROFILE,
  E2E_LOGIN_CARE,
  CARE_PARENT_PROFILE,
  SICK_KID_A_PROFILE,
  SICK_KID_B_PROFILE,
  E2E_LOGIN_COCARE,
  COCARE_PARENT_PROFILE,
  E2E_LOGIN_HHHIST,
  E2E_LOGIN_HHHIST_RO,
  HH_HISTORY_PARENT_PROFILE,
  HH_HISTORY_CHILD_PROFILE,
  E2E_LOGIN_HH_CAREGIVER,
  E2E_LOGIN_HH_SOLO,
  E2E_LOGIN_HH_VIEWER,
  E2E_LOGIN_ILLNESS_CAREGIVER,
  E2E_LOGIN_ILLNESS_RO,
  E2E_LOGIN_CONDREV,
  CONDITION_REVIEW_PROFILE,
  E2E_LOGIN_REASON,
  REASON_MODEL_PROFILE,
  E2E_LOGIN_ASK,
  ASK_RECORDS_PROFILE,
  ASK_RECORDS_MED,
  E2E_LOGIN_CLOSURE_DQ,
  CLOSURE_DQ_PROFILE,
  E2E_LOGIN_DERIVED,
  DERIVED_SITU_PROFILE,
  DERIVED_SITU_PERIOD_ITEM,
  DERIVED_SITU_SLEEP_ITEM,
  E2E_LOGIN_PRESENCE,
  PRESENCE_PROFILE,
  E2E_LOGIN_NOTIF,
  NOTIF_PROFILE,
  E2E_LOGIN_PROTEIN,
  PROTEIN_QUICKADD_PROFILE,
  E2E_LOGIN_RECAP,
  RECAP_PROFILE,
  E2E_LOGIN_FOODSLOT,
  FOOD_SLOT_PROFILE,
  E2E_LOGIN_ENDURANCE,
  ENDURANCE_PROFILE,
  E2E_LOGIN_FLABS,
  FLAGGED_LAB_PROFILE,
  E2E_LOGIN_IOP,
  FLAGGED_IOP_PROFILE,
  E2E_LOGIN_CEL_IMPORT,
  CEL_IMPORT_PROFILE,
  E2E_LOGIN_PREVCODE,
  PREVENTIVE_CODES_PROFILE,
  E2E_LOGIN_DRUG_ALLERGY,
  DRUG_ALLERGY_PROFILE,
  E2E_LOGIN_PRN_FAMILY,
  PRN_FAMILY_PROFILE,
  E2E_LOGIN_COVERAGE,
  SAFETY_COVERAGE_PROFILE,
  E2E_LOGIN_HA_NOTIFY,
  HA_NOTIFY_PROFILE,
  E2E_LOGIN_DQ_GAPPY,
  DQ_GAPPY_PROFILE,
  E2E_LOGIN_DQ_COMPLETE,
  DQ_COMPLETE_PROFILE,
  E2E_LOGIN_DQ_CARE,
  DQ_CARE_PARENT_PROFILE,
  DQ_CARE_CHILD_PROFILE,
  E2E_LOGIN_DQ_ADULT,
  DQ_ADULT_PROFILE,
  E2E_LOGIN_VISITLINKS,
  VISITLINKS_PROFILE,
  E2E_LOGIN_ENCRICH,
  ENCRICH_PROFILE,
  E2E_LOGIN_CREATEVISIT,
  CREATEVISIT_PROFILE,
  E2E_LOGIN_TOASTS,
  TOAST_SWITCH_A_PROFILE,
  TOAST_SWITCH_B_PROFILE,
  E2E_LOGIN_TRENDS_BODY,
  TRENDS_BODY_PROFILE,
  E2E_LOGIN_REST,
  REST_CARD_PROFILE,
  E2E_LOGIN_PHOTOS,
  E2E_LOGIN_SUPPRESSED,
  PROGRESS_PHOTOS_PROFILE,
  SUPPRESSED_PROFILE,
  E2E_LOGIN_VIDEO,
  VIDEO_PROFILE,
  E2E_LOGIN_SITIMPACT,
  SITUATION_IMPACT_PROFILE,
  E2E_LOGIN_WELLSYM,
  WELL_SYMPTOM_PROFILE,
} from "./fixture-logins";
import {
  diffSituations,
  serializeSituationEvents,
} from "../lib/trend-annotations";
import { adoptTemplate, activateRoutine } from "../lib/routines";
import { getTimezone, setInstanceTimezone, setTimezone } from "../lib/settings";
import { pinnedTimezone } from "./pinned-timezone";

// Pin the instance-default timezone so the frozen clock (#1103's run-start
// ALLOS_TEST_NOW) reads 13:mm LOCAL — deterministic Midday — at every UTC start
// hour; see e2e/pinned-timezone.ts for why the run-start freeze alone left
// bucket-progression assertions (past-due doses) hour-dependent. Global-only on
// purpose: every profile without an explicit per-profile timezone resolves to
// the instance default at READ time (lib/settings getTimezone), including
// profiles specs create at runtime. A fixture that DEPENDS on UTC wall-times
// opts out per-profile below (the food-slot ranking profile). The demo server
// seeds via scripts/seed.ts only and stays UTC — its specs are time-neutral.
if (process.env.ALLOS_TEST_NOW) {
  const { zone } = pinnedTimezone(process.env.ALLOS_TEST_NOW);
  setInstanceTimezone(zone);
  console.log(`e2e: pinned instance timezone ${zone} (frozen local ~13:00)`);
}

// A persisted notification-delivery failure (#131) so Settings → Notifications
// surfaces the "Last notification delivery failed" marker for the e2e to assert.
// Synthetic error text — no PHI. Written through the real marker write path (the
// notify_lifecycle delivery-health row, #942) so the fixture can't drift from
// what dispatch() records on a failed Telegram send.
writeTx(() =>
  setDeliveryFailure(
    "telegram",
    "Telegram API 401: Unauthorized (bot token revoked)",
    "2026-07-09T08:00:00.000Z"
  )
);

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
db.prepare(
  `UPDATE integration_sync_events
      SET details = ?
    WHERE profile_id = ? AND provider = 'health-connect' AND at = ?`
).run(
  JSON.stringify({
    warnings: [],
    origins: [
      {
        date: "2026-07-08",
        metric: "total_kcal",
        chosen: "com.garmin.android.apps.connectmobile",
        ignored: ["com.fitbit.FitbitMobile"],
      },
    ],
  }),
  PROFILE_ID,
  "2026-07-08 07:00:00"
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
// Strava-imported run with overlapping clock times — a HIGH-confidence duplicate the
// Review inbox must surface with merge/keep-both/dismiss actions. The seeder lives in
// e2e/dup-review-fixture.ts so import-dedup.spec.ts (which MERGES the pair) can re-seed
// it per test and stay repeat-safe (#868). Synthetic data only.
seedDupReviewPair(db, PROFILE_ID);

// ── Manual pair-merge fixture (issue #64) ─────────────────────────────────────
// Two same-day MANUAL cardio activities the Journal's manual merge test folds
// together — the "duplicate no heuristic catches" case (two manual rows, no clock
// windows, so detection deliberately ignores them). Distinct date + titles so this
// fixture never collides with the cross-source dedup pair above. Synthetic only.
// RELATIVE date (#1048 frozen-clock follow-up): the journal feed's first page is the
// newest JOURNAL_PAGE_DAYS (14) days, and the run-start frozen clock advances daily,
// so the old FIXED "2026-07-05" aged OFF page 1 — the merge specs couldn't see the
// keeper card and went red suite-wide. Anchor a few days back like the #659 edit-lock
// fixture so it stays inside the page-1 window; the three pairs stay on DISTINCT days.
const MERGE_DATE = shiftDateStr(today(PROFILE_ID), -8);
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
const CONFLICT_DATE = shiftDateStr(today(PROFILE_ID), -9); // relative — see MERGE_DATE (distinct recent day, on page 1)
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
const SETS_DATE = shiftDateStr(today(PROFILE_ID), -3); // relative — see MERGE_DATE (distinct recent day, on page 1)
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
// Anchored on the clock seam (#990) so it stays future relative to the app's frozen
// "today" under e2e, not the real wall clock.
const soon = clockNow();
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
const milestoneDate = clockNow().toISOString().slice(0, 10);
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

// ── Sleep page fixture (issue #1066) ──[SLEEP-PAGE-1066]───────────────────────
// Self-contained block layered on the #160 SRI nights above — keep it standalone
// and clearly marked so a parallel #1117 edit to this file merges trivially.
// Adds, for profile 1:
//   (a) per-night sleep STAGE samples for the last 14 wake-days (today-13 … today),
//       so the Sleep page "Stage composition" chart and the hero stage bar render;
//   (b) a deterministic LAST NIGHT on wake-day `today` — a 5h main overnight
//       (23:00 → 04:00 LOCAL) plus an afternoon NAP (13:00 → 13:45 LOCAL) — so the
//       hero shows the 5h main session and the nap as a SEPARATE line, never summed
//       (the #1118 main-vs-nap split; asserted by sleep-page.spec).
//
// CRITICAL (#1110 pinned instance timezone): `lastNightSummary` groups sessions by
// the profile-LOCAL calendar date of each session END, so the fixture MUST build
// instants through the profile timezone (zonedWallTimeToUtc), NOT bare UTC. A bare
// `…Z` string under the run's Etc/GMT±N zone lands on the wrong wake-day (e.g. a
// 13:00Z nap becomes tomorrow-02:00 local), which strands the nap alone on the
// latest wake-day and makes the hero render the NAP instead of the night. The
// overnight is seeded here (not relied on from the naive-timestamp coaching block
// above) precisely so its wake-day placement is tz-correct and deterministic.
// Synthetic values only (no PHI). Idempotent: clears its own windows first.
const sleepTz = getTimezone(PROFILE_ID);
const iso = (d: Date) => d.toISOString();
const sleepStageInsert = db.prepare(
  `INSERT OR IGNORE INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'manual', ?, ?, ?, ?, ?)`
);
for (let i = 0; i <= 13; i++) {
  const wakeDay = shiftDateStr(COACH_TODAY, -i);
  const bedDay = shiftDateStr(wakeDay, -1);
  // Stage rows are grouped by the stored `date` column (getSleepStageDailyTotals),
  // not by the window, so tz placement doesn't affect them; still build the window
  // through the profile tz for consistency.
  const start = iso(zonedWallTimeToUtc(sleepTz, bedDay, "23:00"));
  const end = iso(zonedWallTimeToUtc(sleepTz, wakeDay, "07:00"));
  // deterministic light jitter so the stacked areas aren't perfectly flat
  const jitter = (i * 5) % 20;
  const stages: [string, number][] = [
    ["sleep_deep_min", 80 + jitter],
    ["sleep_rem_min", 100 - jitter],
    ["sleep_light_min", 250 + jitter],
    ["sleep_awake_min", 25 + (jitter % 10)],
  ];
  for (const [metric, value] of stages) {
    db.prepare(
      `DELETE FROM metric_samples
        WHERE profile_id = ? AND metric = ? AND source = 'manual' AND date = ?`
    ).run(PROFILE_ID, metric, wakeDay);
    sleepStageInsert.run(PROFILE_ID, metric, wakeDay, start, end, value);
  }
}
// Last night on `today`: a 5h main overnight (23:00 prev → 04:00 today, LOCAL) and
// a 45-min afternoon nap (13:00 → 13:45 today, LOCAL). Both land on wake-day
// `today` in the profile tz; mainSleepSession keeps the 5h overnight and the nap is
// a separate figure. Idempotent by the exact tz-correct windows.
const overnightStart = iso(
  zonedWallTimeToUtc(sleepTz, COACH_YESTERDAY, "23:00")
);
const overnightEnd = iso(zonedWallTimeToUtc(sleepTz, COACH_TODAY, "04:00"));
const napStart = iso(zonedWallTimeToUtc(sleepTz, COACH_TODAY, "13:00"));
const napEnd = iso(zonedWallTimeToUtc(sleepTz, COACH_TODAY, "13:45"));
const sleepSessionInsert = db.prepare(
  `INSERT OR IGNORE INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'manual', 'sleep_min', ?, ?, ?, ?)`
);
// Own wake-day `today` entirely: clear ALL of today's manual sleep_min sessions —
// crucially the NAIVE-timestamp overnight the coaching block above seeded for
// COACH_TODAY (23:00→04:00 as bare, non-tz strings → fixed 23:00Z→04:00Z). Its
// old per-start_time DELETE only matched THIS block's own tz-correct start, so the
// coaching duplicate survived: two 300-min overnights on today, and mainSleepSession's
// duration-tie → earliest-END tiebreak flipped to the coaching row whenever the
// pinned tz is west of UTC (ALLOS_TEST_NOW hour ≥ 14:00 UTC — utcHour drives the
// Etc/GMT offset), rendering "22:00 → 03:00" and lumping the real overnight into a
// 345-min "nap" (sleep-page:194 time-window flake). The coaching REST signal is
// preserved: the tz-correct overnight is also 300 min (5h), so getSleepSignal still
// trips the absolute floor.
db.prepare(
  `DELETE FROM metric_samples
    WHERE profile_id = ? AND metric = 'sleep_min' AND source = 'manual'
      AND date = ?`
).run(PROFILE_ID, COACH_TODAY);
for (const [start, end, value] of [
  [overnightStart, overnightEnd, 300],
  [napStart, napEnd, 45],
] as [string, string, number][]) {
  sleepSessionInsert.run(PROFILE_ID, COACH_TODAY, start, end, value);
}
console.log(
  "e2e: seeded sleep stages (14 nights) + a tz-correct 5h night & nap for profile 1 (#1066)"
);

// Bedtime-supplement context for the same two most-recent overnight sessions.
// Reuse the base seed's real Before-sleep supplement instead of minting a second
// schedule. Last night's start-day is taken; the preceding night's is deliberately
// unlogged so the hero/log exercise both factual states. Move the synthetic dose's
// lifetime before the fixture window so the shared #430 lifetime guard correctly
// considers both nights applicable.
const bedtimeDose = db
  .prepare(
    `SELECT d.id AS dose_id, d.item_id AS item_id
       FROM intake_item_doses d
       JOIN intake_items i ON i.id = d.item_id
      WHERE i.profile_id = ? AND i.name = 'Magnesium Glycinate'
        AND d.retired = 0
      ORDER BY d.id LIMIT 1`
  )
  .get(PROFILE_ID) as { dose_id: number; item_id: number } | undefined;
if (bedtimeDose) {
  const bedtimeFixtureStart = `${shiftDateStr(COACH_TODAY, -30)} 00:00:00`;
  db.prepare(
    `UPDATE intake_items SET created_at = ? WHERE id = ? AND profile_id = ?`
  ).run(bedtimeFixtureStart, bedtimeDose.item_id, PROFILE_ID);
  db.prepare(
    `UPDATE intake_item_doses SET created_at = ?, updated_at = NULL
      WHERE id = ? AND item_id = ?
        AND EXISTS (
          SELECT 1 FROM intake_items i
           WHERE i.id = intake_item_doses.item_id AND i.profile_id = ?
        )`
  ).run(
    bedtimeFixtureStart,
    bedtimeDose.dose_id,
    bedtimeDose.item_id,
    PROFILE_ID
  );
  const priorSleepDate = shiftDateStr(COACH_YESTERDAY, -1);
  db.prepare(
    `DELETE FROM intake_item_logs
      WHERE dose_id = ? AND item_id = ? AND date IN (?, ?)
        AND EXISTS (
          SELECT 1 FROM intake_items i
           WHERE i.id = intake_item_logs.item_id AND i.profile_id = ?
        )`
  ).run(
    bedtimeDose.dose_id,
    bedtimeDose.item_id,
    COACH_YESTERDAY,
    priorSleepDate,
    PROFILE_ID
  );
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
     VALUES (?, ?, ?, 'taken')`
  ).run(bedtimeDose.dose_id, bedtimeDose.item_id, COACH_YESTERDAY);
}
console.log(
  "e2e: seeded taken + unlogged bedtime-supplement nights for profile 1"
);

// ── Oura vendor daily scores fixture (issue #1069) ──[OURA-SCORES-1069]────────
// Profile 1's Oura sleep/readiness scores for the last 14 days, so the Sleep
// page's attributed "From Oura" tiles + trends render (sleep-page.spec). These are
// DISPLAY-ONLY, engine-inert vendor numbers under the vendor-prefixed kinds — the
// parser keys each day at UTC midnight, so match that natural key here. Source
// 'oura'. Synthetic values only (no PHI). Idempotent: clears its own kind/day rows.
const ouraScoreInsert = db.prepare(
  `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'oura', ?, ?, ?, ?, ?)`
);
for (let i = 0; i <= 13; i++) {
  const day = shiftDateStr(COACH_TODAY, -i);
  const instant = `${day}T00:00:00.000Z`;
  // Deterministic synthetic 0–100 figures with light jitter; today's = latest.
  const sleepScore = 78 + ((i * 3) % 12);
  const readinessScore = 70 + ((i * 5) % 15);
  for (const [metric, value] of [
    ["oura_sleep_score", sleepScore],
    ["oura_readiness_score", readinessScore],
  ] as [string, number][]) {
    db.prepare(
      `DELETE FROM metric_samples
        WHERE profile_id = ? AND metric = ? AND source = 'oura' AND date = ?`
    ).run(PROFILE_ID, metric, day);
    ouraScoreInsert.run(PROFILE_ID, metric, day, instant, instant, value);
  }
}
console.log(
  "e2e: seeded Oura sleep/readiness daily scores (14 days) for profile 1 (#1069)"
);

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

// #789 — a CUSTOM-ONLY strength session for the per-session muscle-figure spec's
// negative case: one strength activity whose only lift is a made-up, non-catalog
// name, so `musclesWorked` resolves to the empty set and the Journal card's
// per-session anatomy figure degrades to nothing. Unique title so the spec targets
// it exactly; a recent date so it lands in the Journal's first (newest) page. The
// custom lift has no catalog muscle tags, so it adds nothing to weekly coverage and
// leaves the coverage/volume-band specs undisturbed. Idempotent.
const MUSCLE_FIG_CUSTOM = "Custom-only lift day (e2e)";
db.prepare(`DELETE FROM activities WHERE profile_id = ? AND title = ?`).run(
  PROFILE_ID,
  MUSCLE_FIG_CUSTOM
);
const muscleFigActId = Number(
  db
    .prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity, source, external_id)
       VALUES (?, ?, 'strength', ?, 40, 'hard', 'manual', 'e2e:muscle-fig-custom')`
    )
    .run(PROFILE_ID, shiftDateStr(today(PROFILE_ID), -1), MUSCLE_FIG_CUSTOM)
    .lastInsertRowid
);
const insMuscleFigSet = db.prepare(
  `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
   VALUES (?, 'E2E Bespoke Machine Press', ?, 40, 10)`
);
for (let s = 1; s <= 3; s++) insMuscleFigSet.run(muscleFigActId, s);

console.log(
  `e2e: seeded a custom-only strength session "${MUSCLE_FIG_CUSTOM}" for the per-session muscle-figure spec (#789)`
);

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
  // Source-text reconciliation flags (AI PDF path): one of each verdict, so the
  // "Source reconciliation" card renders with both badge variants. Synthetic
  // analyte names; the value is a bare number with no unit/date context.
  reconciliation: {
    confirmed: 10,
    total: 12,
    flags: [
      { name: "E2E Mismatch Marker", value: "999", verdict: "value_mismatch" },
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
).run(prnMedId, shiftDateStr(today(PROFILE_ID), -5));
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
    utcSqlString(new Date(clockNow().getTime() - minutesAgo * 60 * 1000))
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
  utcSqlString(new Date(clockNow().getTime() - 7 * 60 * 60 * 1000))
);
console.log(
  `e2e: seeded PRN redose-notice fixture "${REDOSE_MED_NAME}" (#798)`
);

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
const BROWSER_DOC_ID = 908;
const BROWSER_DOC_SOURCE = `document:${BROWSER_DOC_ID}`;
db.prepare(`DELETE FROM medical_records WHERE document_id = ?`).run(
  BROWSER_DOC_ID
);
// FK is ON (lib/db.ts), so this cascades the med's doses/courses/logs.
db.prepare(
  `DELETE FROM intake_items WHERE profile_id = ? AND document_id = ?`
).run(PROFILE_ID, BROWSER_DOC_ID);
db.prepare(`DELETE FROM encounters WHERE document_id = ?`).run(BROWSER_DOC_ID);
db.prepare(`DELETE FROM conditions WHERE document_id = ?`).run(BROWSER_DOC_ID);
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
// legacy free-text prescriber. The medication detail can then prove that a
// registry-backed provider navigates to the provider detail page.
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
         (name, notes, active, condition, priority, kind, as_needed,
          document_id, source, provider_id, import_key, profile_id)
       VALUES (?, NULL, 1, 'daily', 'high', 'medication', 1,
               ?, 'extracted', NULL, ?, ?)`
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

// #698 §4 — visual acuity is a Snellen fraction ("20/20"): qualitative-shaped, so it
// must render as a dated timeline (not a flat numeric chart), and it must NOT flag as
// abnormal (no numeric reference band). Two dated readings, value_num NULL, canonical
// "Visual Acuity, Right Eye". parseLeadingNumeric now rejects the bare fraction, so
// plottableReadingValue is null → the dated-timeline branch; reconcileFlags leaves it
// unflagged (an unrecognized qualitative analyte defers).
const ACUITY_MARKER = "Visual Acuity, Right Eye";
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
).run(PROFILE_ID, ACUITY_MARKER);
qualInsert.run(PROFILE_ID, "2024-04-01", ACUITY_MARKER, "20/40", ACUITY_MARKER);
qualInsert.run(PROFILE_ID, "2025-04-01", ACUITY_MARKER, "20/20", ACUITY_MARKER);

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

// #1063 — a dedicated Health Connect profile seeded already CONNECTED with a
// long, synthetic DB-backed token, so the mobile-overflow spec renders the
// endpoint/token card read-only (never generating or rotating — those mutations
// belong to the E2E_LOGIN_HC spec above and would race a concurrent reader).
const mobileHcId = fixtureProfileId(MOBILE_HC_PROFILE);
upsertConnection(mobileHcId, "health-connect", {
  status: "connected",
  config: {
    // Synthetic 64-char token of hex characters (real generated tokens are 48
    // hex chars), so the row is provably wider than a 360px viewport without
    // wrapping. Deliberately LOW-entropy ("e2e0" × 16) — a random-looking hex
    // string trips the gitleaks generic-api-key rule even when fake.
    token: "e2e0".repeat(16),
    tokenCreatedAt: utcSqlString(
      new Date(clockNow().getTime() - 24 * 3600 * 1000)
    ),
  },
});
seedMemberLogin(E2E_LOGIN_MOBILE_HC, mobileHcId);

// ── Nutrition trio (#974 protein gauge / #975 preferences / #976 fiber) ──────
// A dedicated adult profile carrying everything the three nutrition surfaces read: a
// recent weigh-in (a target to scale), this-week food servings across protein- AND
// fiber-bearing groups, a CONFIRMED capsule fiber supplement today (the honest
// grams-unknown note), sex = male (a DRI fiber target), and one flagged low omega-3 (the
// #577 engine fires → the vegetarian preset's plant substitution is observable). Isolated
// on purpose: the preferences spec mutates the excluded set, which on profile 1 would race
// the coaching specs' suggestion reads. Idempotent — every owned table is cleared first.
const nutritionId = fixtureProfileId(NUTRITION_PROFILE);
seedMemberLogin(E2E_LOGIN_NUTRITION, nutritionId);
{
  const nToday = today(nutritionId);
  // Clear prior fixture data so a reused dev server re-seeds cleanly.
  db.prepare(`DELETE FROM food_log WHERE profile_id = ?`).run(nutritionId);
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(nutritionId);
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'Omega-3 Total (OmegaCheck)'`
  ).run(nutritionId);
  db.prepare(
    `DELETE FROM intake_item_logs WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ? AND name = 'Fiber capsules')`
  ).run(nutritionId);
  db.prepare(
    `DELETE FROM intake_item_doses WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ? AND name = 'Fiber capsules')`
  ).run(nutritionId);
  db.prepare(
    `DELETE FROM intake_items WHERE profile_id = ? AND name = 'Fiber capsules'`
  ).run(nutritionId);
  db.prepare(
    `DELETE FROM profile_settings WHERE profile_id = ? AND key IN ('sex', 'dietary_excluded_groups')`
  ).run(nutritionId);

  // Sex → a DRI fiber target (adult male = 38 g/day).
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')`
  ).run(nutritionId);
  // A recent weigh-in → a protein target to scale (active band ~95–130 g at 80 kg).
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, notes) VALUES (?, ?, 80, 'e2e:nutrition')`
  ).run(nutritionId, nToday);

  // This-week food servings — protein- AND fiber-bearing groups, plus fatty_fish so the
  // vegetarian preset's demotion of an excluded group is observable. Kept modestly below
  // both targets so the below-verdict copy renders.
  const logFood = (date: string, slug: string, servings: number) =>
    db
      .prepare(
        `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)`
      )
      .run(nutritionId, date, slug, servings);
  for (const [dayOffset, rows] of [
    [
      0,
      [
        ["legumes", 1],
        ["whole_grains", 1],
        ["fatty_fish", 1],
      ],
    ],
    [
      -1,
      [
        ["leafy_greens", 2],
        ["eggs", 1],
      ],
    ],
    [
      -2,
      [
        ["poultry", 1],
        ["berries", 1],
      ],
    ],
  ] as const) {
    for (const [slug, n] of rows)
      logFood(shiftDateStr(nToday, dayOffset), slug, n);
  }

  // A confirmed capsule-unit fiber supplement TODAY → the honest "grams unknown" note.
  const fiberItemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority)
         VALUES (?, 'Fiber capsules', 1, 'supplement', 'daily', 'low')`
      )
      .run(nutritionId).lastInsertRowid
  );
  const fiberDoseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 capsule', 'morning', 'any', 0)`
      )
      .run(fiberItemId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, given_at, status)
     VALUES (?, ?, ?, '1 capsule', ?, 'taken')`
  ).run(fiberDoseId, fiberItemId, nToday, utcSqlString(clockNow()));

  // One flagged low omega-3 reading → the #577 engine surfaces a fish suggestion the
  // vegetarian preset substitutes to a plant source.
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, flag, created_at)
     VALUES (?, ?, 'lab', 'Omega-3 Total (OmegaCheck)', '3.2', '%', 'Omega-3 Total (OmegaCheck)', 'low', ?)`
  ).run(nutritionId, nToday, utcSqlString(clockNow()));
}

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

// Fitness check (#834) — a dedicated ADULT profile carrying sex + birthdate (so norms
// resolve) and a PRIOR check ~100 days ago, so the spec can record a test today and see a
// check-over-check delta. A dedicated SENIOR profile (age 72) renders the older-adult
// battery variant. Idempotent: clear their fitness sessions first.
const fitnessId = fixtureProfileId(FITNESS_PROFILE);
db.prepare(
  `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')`
).run(fitnessId);
db.prepare(
  `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1986-05-01')`
).run(fitnessId);
db.prepare(`DELETE FROM fitness_assessments WHERE profile_id = ?`).run(
  fitnessId
);
saveFitnessEntry(fitnessId, {
  date: shiftDateStr(today(fitnessId), -100),
  testKey: "grip",
  value: 44,
});
// #1129 ambient auto-count fixtures — natural-store readings the check NEVER recorded, so
// the grid lights up tiles as measured-with-provenance without a check session: a SYNCED
// VO2 Max (medical_records, source 'oura'), a scale body-fat/resting-HR + a bodyweight
// (body_metrics, source 'withings'), a logged heavy Back Squat (exercise_sets), and a
// logged Plank hold (#1135 self-norm rough band). Idempotent-ish: cleared with the
// profile's fitness sessions is not enough (these aren't sessions), so clear them first.
const fitnessRecent = shiftDateStr(today(fitnessId), -3);
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'VO2 Max' AND source = 'oura'`
).run(fitnessId);
db.prepare(
  `DELETE FROM body_metrics WHERE profile_id = ? AND source = 'withings'`
).run(fitnessId);
db.prepare(
  `DELETE FROM exercise_sets WHERE activity_id IN
     (SELECT id FROM activities WHERE profile_id = ? AND title = 'Fitness log (e2e)')`
).run(fitnessId);
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND title = 'Fitness log (e2e)'`
).run(fitnessId);
db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
   VALUES (?, ?, 'biomarker', 'VO2 Max', '48', 48, 'mL/kg/min', 'VO2 Max', 'oura')`
).run(fitnessId, fitnessRecent);
reconcileFlags(fitnessId);
db.prepare(
  `INSERT INTO body_metrics (date, weight_kg, body_fat_pct, resting_hr, source, profile_id)
   VALUES (?, 82, 18, 55, 'withings', ?)`
).run(fitnessRecent, fitnessId);
{
  const squatActivity = Number(
    db
      .prepare(
        "INSERT INTO activities (date, type, title, profile_id) VALUES (?, 'strength', 'Fitness log (e2e)', ?)"
      )
      .run(fitnessRecent, fitnessId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, 'Back Squat', 1, 140, 3, 0)`
  ).run(squatActivity);
  const holdActivity = Number(
    db
      .prepare(
        "INSERT INTO activities (date, type, title, profile_id) VALUES (?, 'strength', 'Fitness log (e2e)', ?)"
      )
      .run(fitnessRecent, fitnessId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, duration_sec, warmup)
     VALUES (?, 'Plank', 1, 90, 0)`
  ).run(holdActivity);
}
seedMemberLogin(E2E_LOGIN_FITNESS, fitnessId);

const fitnessSeniorId = fixtureProfileId(FITNESS_SENIOR_PROFILE);
db.prepare(
  `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')`
).run(fitnessSeniorId);
db.prepare(
  `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1954-03-01')`
).run(fitnessSeniorId);
seedMemberLogin(E2E_LOGIN_FITNESS_SENIOR, fitnessSeniorId);

// A dedicated ADULT profile for the mobility spec (#840): sex + birthdate so the
// fitness-norms percentile gate opens, plus a LOW sit-and-reach vital so the Training
// overview's Mobility section renders a deficit→habit SUGGESTION (a Legs mobility habit).
// NO seeded recovery session / mobility_region target — the log bar starts empty and the
// suggestion is present; the spec owns its own move toggles. Idempotent: clear the
// profile's recovery activities + mobility_region targets so a reused server re-plants a
// clean slate.
const mobilityId = fixtureProfileId(MOBILITY_PROFILE);
db.prepare(
  `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')`
).run(mobilityId);
db.prepare(
  `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1985-01-01')`
).run(mobilityId);
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND type = 'recovery'`
).run(mobilityId);
db.prepare(
  `DELETE FROM frequency_targets WHERE profile_id = ? AND scope_kind = 'mobility_region'`
).run(mobilityId);
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'Sit-and-Reach'`
).run(mobilityId);
db.prepare(
  `INSERT INTO medical_records (profile_id, date, category, name, value_num, unit, canonical_name)
   VALUES (?, ?, 'vitals', 'Sit-and-Reach', 15, 'cm', 'Sit-and-Reach')`
).run(mobilityId, today(mobilityId));
seedMemberLogin(E2E_LOGIN_MOBILITY, mobilityId);

// A dedicated profile with a LIVE, in-progress strength session (issue #921): an
// activity today with a start_time (~40 min ago), NO end_time, and a fresh
// updated_at (auto-save timestamp) — so getWorkoutPresence reads `active`. Drives
// the workout dock hydration/reopen and the household presence chip. Idempotent:
// clear the profile's activities first so a reused server re-plants exactly one.
const presenceId = fixtureProfileId(PRESENCE_PROFILE);
db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(presenceId);
{
  const now = clockNow();
  const startIso = new Date(now.getTime() - 40 * 60_000);
  // start_time is HH:MM wall clock IN THE PROFILE'S TIMEZONE (see
  // lib/workout-presence.ts) — a bare UTC slice diverges from it by the pinned
  // offset (top of file), so derive the wall time through the profile's zone.
  const startHHMM = zonedDateParts(getTimezone(presenceId), startIso).hhmm;
  db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, start_time, end_time, created_at, updated_at, source)
     VALUES (?, ?, 'strength', 'Push day', ?, NULL, ?, ?, NULL)`
  ).run(
    presenceId,
    today(presenceId),
    startHHMM,
    utcSqlString(startIso),
    utcSqlString(now)
  );
}
seedMemberLogin(E2E_LOGIN_PRESENCE, presenceId);

// A dedicated profile with a JUST-FINISHED strength session (#924): a manual
// activity today with a start_time AND a recent end_time (~8 min ago) + two working
// sets that hit their rep target, plus a prior session of the same lift a week
// earlier so the recap flags a PR. So getWorkoutPresence reads `finished` and the
// dashboard renders the finished-window recap card. Idempotent: clear activities first.
const recapId = fixtureProfileId(RECAP_PROFILE);
db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(recapId);
{
  const now = clockNow();
  const startIso = new Date(now.getTime() - 55 * 60_000);
  const endIso = new Date(now.getTime() - 8 * 60_000);
  // Prior session a week earlier — the baseline the finished session beats.
  const priorId = Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min, source)
         VALUES (?, ?, 'strength', 'Bench day', 45, NULL)`
      )
      .run(recapId, shiftDateStr(today(recapId), -7)).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, target_reps)
       VALUES (?, 'Bench Press', 1, 60, 5, 5)`
  ).run(priorId);
  // Today's just-finished session: a warmup + two working sets at 65 kg × 5 (PR).
  const finishedId = Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min, start_time, end_time, created_at, updated_at, source)
         VALUES (?, ?, 'strength', 'Push day', 47, ?, ?, ?, ?, NULL)`
      )
      .run(
        recapId,
        today(recapId),
        // Wall clock in the profile's timezone, NOT a UTC slice: presence
        // reconstructs the end instant via zonedWallTimeToUtc, so a UTC slice
        // reads 60×offset minutes off under the pinned instance timezone and
        // pushed the ~8-min-ago finish outside FINISHED_WINDOW_MIN.
        zonedDateParts(getTimezone(recapId), startIso).hhmm,
        zonedDateParts(getTimezone(recapId), endIso).hhmm,
        utcSqlString(startIso),
        utcSqlString(endIso)
      ).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, target_reps, warmup)
       VALUES (?, 'Bench Press', 1, 40, 8, NULL, 1),
              (?, 'Bench Press', 2, 65, 5, 5, 0),
              (?, 'Bench Press', 3, 65, 5, 5, 0)`
  ).run(finishedId, finishedId, finishedId);
}
seedMemberLogin(E2E_LOGIN_RECAP, recapId);

// Truly empty, isolated profiles for the goal-based onboarding paths (#719).
// Explicit state opts them into onboarding; every other fixture profile without
// the marker behaves as an existing profile and is never forced through setup.
// The reset/entry-state functions are shared with the spec's per-repeat reset
// (e2e/onboarding-reset.ts) so boot-time seed and mid-suite reset can't drift.
const onboardingId = fixtureProfileId(ONBOARDING_PROFILE);
resetOnboardingProfileRows(db, onboardingId);
writeWizardEntryState(db, onboardingId);
seedMemberLogin(E2E_LOGIN_ONBOARDING, onboardingId);

const caregiverOnboardingId = fixtureProfileId(ONBOARDING_CAREGIVER_PROFILE);
resetOnboardingProfileRows(db, caregiverOnboardingId);
writeWizardEntryState(db, caregiverOnboardingId);
seedMemberLogin(E2E_LOGIN_ONBOARDING_CAREGIVER, caregiverOnboardingId);

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

// Dedicated write surface for historical sleep/mood editing. The spec seeds and
// clears its own observation rows around the test; boot only guarantees the
// isolated write-granted login/profile exists.
const sleepEditId = fixtureProfileId(SLEEP_EDIT_PROFILE);
db.prepare(`DELETE FROM mood_logs WHERE profile_id = ?`).run(sleepEditId);
db.prepare(`DELETE FROM metric_samples WHERE profile_id = ?`).run(sleepEditId);
seedMemberLogin(E2E_LOGIN_SLEEP_EDIT, sleepEditId);
console.log(
  `e2e: seeded isolated historical sleep/mood editor profile ${sleepEditId} (${SLEEP_EDIT_PROFILE})`
);

// Dedicated, read-only post-noon-wake fixture (#1190). Pin UTC so the intended
// wall-clock labels are explicit and independent of the suite's run-hour timezone
// pin. Rebuild its tiny observation set on every seed; no browser test writes or
// cleans this profile, so fully-parallel and --repeat-each runs cannot contend.
const sleepPhaseId = fixtureProfileId(SLEEP_PHASE_PROFILE);
setTimezone(sleepPhaseId, "UTC");
db.prepare(`DELETE FROM metric_samples WHERE profile_id = ?`).run(sleepPhaseId);
const sleepPhaseToday = today(sleepPhaseId);
const lateRiserDate = shiftDateStr(sleepPhaseToday, -1);
const daytimeSleepDate = shiftDateStr(sleepPhaseToday, -2);
const insertSleepPhase = db.prepare(
  `INSERT INTO metric_samples
     (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'oura', 'sleep_min', ?, ?, ?, ?)`
);
insertSleepPhase.run(
  sleepPhaseId,
  lateRiserDate,
  iso(zonedWallTimeToUtc("UTC", lateRiserDate, "04:00")),
  iso(zonedWallTimeToUtc("UTC", lateRiserDate, "13:00")),
  540
);
insertSleepPhase.run(
  sleepPhaseId,
  daytimeSleepDate,
  iso(zonedWallTimeToUtc("UTC", daytimeSleepDate, "08:00")),
  iso(zonedWallTimeToUtc("UTC", daytimeSleepDate, "16:00")),
  480
);
seedMemberLogin(E2E_LOGIN_SLEEP_PHASE, sleepPhaseId, "read");
console.log(
  `e2e: seeded read-only late/daytime sleep-phase profile ${sleepPhaseId} (${SLEEP_PHASE_PROFILE}, #1190)`
);

// Dedicated, read-only SEGMENTED-night fixture (#1191/#1283). Every wake-day is a
// biphasic 23:00→03:00 (4h) + 04:00→08:00 (4h) pair — neither block reaches the 6h
// main-sleep floor — so the merge must read them as ONE ~8h night (bed 23:00 → wake
// 08:00, no nap), the behavior f53892f shipped with no browser test for the rendered
// hero/tile. Pin UTC so the wall-clock labels are explicit; the latest wake-day is
// "today" so the hero + dashboard tile both render it. Rebuilt every seed; no browser
// test writes or cleans this profile, so parallel / --repeat-each runs cannot contend.
const sleepSegmentedId = fixtureProfileId(SLEEP_SEGMENTED_PROFILE);
setTimezone(sleepSegmentedId, "UTC");
db.prepare(`DELETE FROM metric_samples WHERE profile_id = ?`).run(
  sleepSegmentedId
);
const sleepSegmentedToday = today(sleepSegmentedId);
const insertSegmentedSleep = db.prepare(
  `INSERT INTO metric_samples
     (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'health-connect', 'sleep_min', ?, ?, ?, 240)`
);
for (let offset = 14; offset >= 0; offset--) {
  const wakeDay = shiftDateStr(sleepSegmentedToday, -offset);
  const bedDay = shiftDateStr(wakeDay, -1);
  // First fragment: 23:00 the prior evening → 03:00 the wake-day (4h).
  insertSegmentedSleep.run(
    sleepSegmentedId,
    wakeDay,
    iso(zonedWallTimeToUtc("UTC", bedDay, "23:00")),
    iso(zonedWallTimeToUtc("UTC", wakeDay, "03:00"))
  );
  // Second fragment after a 1h awake gap: 04:00 → 08:00 the same wake-day (4h).
  insertSegmentedSleep.run(
    sleepSegmentedId,
    wakeDay,
    iso(zonedWallTimeToUtc("UTC", wakeDay, "04:00")),
    iso(zonedWallTimeToUtc("UTC", wakeDay, "08:00"))
  );
}
seedMemberLogin(E2E_LOGIN_SLEEP_SEGMENTED, sleepSegmentedId, "read");
console.log(
  `e2e: seeded read-only segmented-night profile ${sleepSegmentedId} (${SLEEP_SEGMENTED_PROFILE}, #1191/#1283)`
);

// A dedicated, score-free ADULT profile for the mental-health-instruments spec (#716).
// The spec administers PHQ-9/GAD-7 in-app, so it OWNS every write here. Idempotent:
// hard-clear any instrument scores (and their per-item answers) on a reused server so
// the profile can never drift out of its empty contract.
const mentalHealthId = fixtureProfileId(MENTAL_HEALTH_PROFILE);
db.prepare(`DELETE FROM instrument_responses WHERE profile_id = ?`).run(
  mentalHealthId
);
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name IN ('PHQ-9','GAD-7')`
).run(mentalHealthId);
seedMemberLogin(E2E_LOGIN_MENTAL, mentalHealthId);
console.log(
  `e2e: seeded score-free mental-health fixture profile ${mentalHealthId} (${MENTAL_HEALTH_PROFILE}) for the instruments spec (#716)`
);

// A dedicated, substance-data-free ADULT profile for the substance-use spec (#998).
// The spec OWNS every write (an AUDIT-C tap-through, an outside DAST-10 total,
// one-tap drinks, the weekly-cap target). Idempotent: hard-clear its substance
// rows on a reused server so the profile can never drift out of its empty contract
// (the spec's own assertions stay relative for --repeat-each).
const substanceId = fixtureProfileId(SUBSTANCE_PROFILE);
db.prepare(
  `DELETE FROM instrument_responses WHERE profile_id = ? AND medical_record_id IN (
     SELECT id FROM medical_records WHERE profile_id = ?
       AND canonical_name IN ('AUDIT-C','AUDIT','DAST-10'))`
).run(substanceId, substanceId);
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name IN ('AUDIT-C','AUDIT','DAST-10')`
).run(substanceId);
db.prepare(
  `DELETE FROM food_log_events WHERE profile_id = ? AND group_key = 'alcohol'`
).run(substanceId);
db.prepare(
  `DELETE FROM food_log WHERE profile_id = ? AND group_key = 'alcohol'`
).run(substanceId);
// The non-food ledger (#1078: nicotine/cannabis one-tap counts) — same empty
// contract as the alcohol food-log rows above.
db.prepare(`DELETE FROM substance_log WHERE profile_id = ?`).run(substanceId);
db.prepare(
  `DELETE FROM frequency_targets WHERE profile_id = ? AND scope_kind = 'substance'`
).run(substanceId);
seedMemberLogin(E2E_LOGIN_SUBSTANCE, substanceId);
console.log(
  `e2e: seeded substance-data-free fixture profile ${substanceId} (${SUBSTANCE_PROFILE}) for the substance-use spec (#998)`
);

// A dedicated OLDER-ADULT (sex=female, ~60yo) profile with NO satisfying records, so
// EVERY preventive screening class stays due on /upcoming — the preventive-deeplinks
// spec (#1083) reads its rows to prove each class deep-links to the concrete next
// action (lab/vital/instrument/procedure). Sex + a fixed birthdate drive the age
// assessor; nothing satisfies any rule (no labs, vitals, instruments, procedures), so
// the read-only spec is deterministic year-round. Idempotent for a reused server.
const preventiveDeeplinksId = fixtureProfileId(PREVENTIVE_PROFILE);
db.prepare(
  `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
).run(preventiveDeeplinksId);
db.prepare(
  `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1966-01-01')
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
).run(preventiveDeeplinksId);
seedMemberLogin(E2E_LOGIN_PREVENTIVE, preventiveDeeplinksId);
console.log(
  `e2e: seeded record-free preventive fixture profile ${preventiveDeeplinksId} (${PREVENTIVE_PROFILE}) for the deep-links spec (#1083)`
);

// A dedicated ADULT profile for the mental-health-visit sensitivity + crisis specs
// (#997/#996). Calendar feed set to FULL detail (so the spec can prove a
// mental_health visit STILL renders as "Medical appointment" — the privacy default),
// plus a per-profile crisis-resources override so the passive surface + inline
// finding render the profile's own line. The spec OWNS the appointments it books.
const crisisProfileId = fixtureProfileId(CRISIS_PROFILE);
db.prepare(
  `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'calendar_feed_detail', 'full')
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
).run(crisisProfileId);
db.prepare(
  `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'crisis_resources', ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
).run(
  crisisProfileId,
  JSON.stringify([
    { label: CRISIS_OVERRIDE_LABEL, contact: CRISIS_OVERRIDE_CONTACT },
  ])
);
// Idempotent: clear any appointments a prior run's spec booked so the profile keeps
// a clean contract across a reused server.
db.prepare(`DELETE FROM appointments WHERE profile_id = ?`).run(
  crisisProfileId
);
seedMemberLogin(E2E_LOGIN_CRISIS, crisisProfileId);
console.log(
  `e2e: seeded crisis/mental-health-visit fixture profile ${crisisProfileId} (${CRISIS_PROFILE}) for #997/#996`
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

// ── #923: activity-form fill-paths fixtures ─────────────────────────────────────
// FORM_DELOAD: an ADULT profile with an ACTIVE PPL routine in its deload week PLUS
// logged Barbell Bench Press history, so the strength editor's next-set suggestion for
// a routine lift is deload-shaved (100 kg progression → ~90 kg + the shared rationale).
// Dedicated on purpose so a create-and-clean save in the form spec never touches the
// #741 deload fixture (which asserts an exact slate). Idempotent: reset + re-adopt.
const formDeloadProfileId = fixtureProfileId(FORM_DELOAD_PROFILE);
db.prepare(
  `DELETE FROM routine_slots WHERE routine_day_id IN (
     SELECT rd.id FROM routine_days rd
       JOIN routines r ON r.id = rd.routine_id WHERE r.profile_id = ?)`
).run(formDeloadProfileId);
db.prepare(
  `DELETE FROM routine_days WHERE routine_id IN (
     SELECT id FROM routines WHERE profile_id = ?)`
).run(formDeloadProfileId);
db.prepare(`DELETE FROM routines WHERE profile_id = ?`).run(
  formDeloadProfileId
);
const formDeloadRoutineId = adoptTemplate(
  formDeloadProfileId,
  "push-pull-legs-6x"
);
activateRoutine(formDeloadProfileId, formDeloadRoutineId);
db.prepare(
  `UPDATE routines SET cycle_weeks = 2, started_date = ? WHERE id = ?`
).run(shiftDateStr(today(formDeloadProfileId), -7), formDeloadRoutineId);
// One prior Barbell Bench Press session (3 × 100 kg × 6) three days ago: the coached
// suggestion holds 100 kg and builds a rep, which the deload week shaves to 90 kg.
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:form-deload-bench'`
).run(formDeloadProfileId);
const formBenchActId = Number(
  db
    .prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, duration_min, source, external_id, edited)
       VALUES (?, ?, 'strength', 'Push', 40, 'manual', 'e2e:form-deload-bench', 0)`
    )
    .run(formDeloadProfileId, shiftDateStr(today(formDeloadProfileId), -3))
    .lastInsertRowid
);
const insFormBench = db.prepare(
  `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, 'Barbell Bench Press', ?, 100, 6, 0)`
);
for (let s = 1; s <= 3; s++) insFormBench.run(formBenchActId, s);
seedMemberLogin(E2E_LOGIN_FORM_DELOAD, formDeloadProfileId);

// FORM_PLATEAU: an ADULT profile with NO routine and a flat-for-6-weeks Skullcrusher
// (5 sessions of 30 kg × 8), so the strength editor shows the inline plateau hint for a
// plateaued lift — never shaved, since the profile has no cycle. Dedicated so the
// dismiss test's suppression write stays isolated from profile 1's Skullcrusher plateau
// (which rule-findings.spec relies on).
const formPlateauProfileId = fixtureProfileId(FORM_PLATEAU_PROFILE);
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND external_id LIKE 'e2e:form-plateau-%'`
).run(formPlateauProfileId);
const insFormPlAct = db.prepare(
  `INSERT INTO activities
     (profile_id, date, type, title, duration_min, source, external_id, edited)
   VALUES (?, ?, 'strength', 'Arms', 25, 'manual', ?, 0)`
);
const insFormPlSet = db.prepare(
  `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, 'Skullcrusher', ?, 30, 8, 0)`
);
[-40, -33, -26, -14, -2].forEach((day, i) => {
  const actId = Number(
    insFormPlAct.run(
      formPlateauProfileId,
      shiftDateStr(today(formPlateauProfileId), day),
      `e2e:form-plateau-${i}`
    ).lastInsertRowid
  );
  for (let s = 1; s <= 3; s++) insFormPlSet.run(actId, s);
});
seedMemberLogin(E2E_LOGIN_FORM_PLATEAU, formPlateauProfileId);

// FORM_INJURY (#1144): an ADULT profile with a RECOVERING "Chest" injury + logged Barbell
// Bench Press history (a Chest lift) and NO routine, so the strength editor's next-set
// suggestion is injury-TEMPERED (100 kg progression → 60 kg = 100 × RECOVERING_LOAD_FACTOR
// 0.6) OUTSIDE any deload week — the axis #1115 left open. The form now threads the same
// recovering-region context the Analyze/detail panel reads, so both surfaces seed 60 kg.
// Dedicated so the recovering injury never tempers a shared profile's coaching surfaces.
const formInjuryProfileId = fixtureProfileId(FORM_INJURY_PROFILE);
db.prepare(`DELETE FROM injuries WHERE profile_id = ?`).run(
  formInjuryProfileId
);
db.prepare(
  `INSERT INTO injuries (profile_id, label, regions, status, since)
     VALUES (?, 'Left pec strain (e2e)', '["Chest"]', 'recovering', ?)`
).run(formInjuryProfileId, shiftDateStr(today(formInjuryProfileId), -21));
// One prior Barbell Bench Press session (3 × 100 kg × 6) three days ago: the coached
// suggestion holds 100 kg + builds a rep, which the recovering-Chest temper backs to 60.
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:form-injury-bench'`
).run(formInjuryProfileId);
const formInjuryBenchActId = Number(
  db
    .prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, duration_min, source, external_id, edited)
       VALUES (?, ?, 'strength', 'Push', 40, 'manual', 'e2e:form-injury-bench', 0)`
    )
    .run(formInjuryProfileId, shiftDateStr(today(formInjuryProfileId), -3))
    .lastInsertRowid
);
const insFormInjuryBench = db.prepare(
  `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, 'Barbell Bench Press', ?, 100, 6, 0)`
);
for (let s = 1; s <= 3; s++) insFormInjuryBench.run(formInjuryBenchActId, s);
seedMemberLogin(E2E_LOGIN_FORM_INJURY, formInjuryProfileId);

console.log(
  `e2e: seeded activity-form fill-path fixtures — deload profile ${formDeloadProfileId}, plateau profile ${formPlateauProfileId}, injury profile ${formInjuryProfileId} (#923/#1144)`
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
// The description must match NO preventive concept-map phrase, so completing it
// can't infer-satisfy any rule and disturb preventive-upcoming's assertions (an
// earlier "eye exam" wording once satisfied vision_exam when the spec completed it;
// vision_exam is now also seed-satisfied via profile 1's current optical Rx, #1098).
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
// is genuinely sync-owned (only those carry the lock).
// The date MUST be a day with no other body-metric row: a Withings weight sharing a
// day with a manual weight registers as a same-day body-metric conflict
// (getBodyMetricConflicts) and silently inflates the Data → Review badge, which
// import-dedup.spec asserts exactly. The old fixed date ('2026-06-05', chosen as a
// gap when the cadence landed on 06-02/06-09) was a TIME BOMB: scripts/seed.ts's
// weekly manual weigh-ins are TODAY-relative, so the cadence drifts one day per day
// and periodically lands ON any fixed date (it hit 06-05 on 2026-07-18 and broke CI
// suite-wide). Compute a guaranteed-free day instead, anchored ~6 weeks back like
// the original. Idempotent: the fixture row is re-keyed by its synthetic signature
// (source + exact weight — the shared EDIT_LOCK_SIGNATURE that edit-lock-badge.spec's
// beforeEach restores the lock by), so prior seeds' copies are removed wherever they
// landed.
db.prepare(
  `DELETE FROM body_metrics WHERE profile_id = ? AND source = ? AND weight_kg = ?`
).run(PROFILE_ID, EDIT_LOCK_SIGNATURE.source, EDIT_LOCK_SIGNATURE.weightKg);
let editLockDate = shiftDateStr(today(PROFILE_ID), -43);
while (
  db
    .prepare(`SELECT 1 FROM body_metrics WHERE profile_id = ? AND date = ?`)
    .get(PROFILE_ID, editLockDate)
) {
  editLockDate = shiftDateStr(editLockDate, 1);
}
db.prepare(
  `INSERT INTO body_metrics (profile_id, date, weight_kg, source, edited)
   VALUES (?, ?, ?, ?, 1)`
).run(
  PROFILE_ID,
  editLockDate,
  EDIT_LOCK_SIGNATURE.weightKg,
  EDIT_LOCK_SIGNATURE.source
);
console.log(
  `e2e: seeded an edit-locked (hand-edited) Withings body-metric row on ${editLockDate} (computed cadence-free day) for the edit-lock badge (#659)`
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

// ── Situation-aware coaching fixture (#837 / #662 item 1) ─────────────────────
// A dedicated sick profile WITH training history + one situational supplement, so the
// dashboard coaching widget shows the illness HELD note (coaching has gap nags to hold,
// not the empty state) and the Nutrition → Supplements situations bar shows the
// "1 situational item now active" activation acknowledgment. Read-only in the specs, so
// it stays repeat-safe and never perturbs the other sick fixtures' cockpit assertions.
const sitCoachId = fixtureProfileId(SITCOACH_PROFILE);
seedSickEpisode(sitCoachId, { activateSituation: true });
{
  const on = today(sitCoachId);
  // Training history a few days back → coaching HAS content to hold, with no session
  // logged today (so no "trained today" branch competes with the held note).
  const sid = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'strength', 'Squat Day', 45)`
      )
      .run(sitCoachId, shiftDateStr(on, -3)).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, 'Back Squat', 1, 100, 5)`
  ).run(sid);
  // A situational supplement tied to the active Illness situation (situation_id points
  // at the profile's Illness row so isDueOn's situational branch counts it while active).
  const illnessSitId = (
    db
      .prepare(
        "SELECT id FROM situations WHERE profile_id = ? AND name = 'Illness'"
      )
      .get(sitCoachId) as { id: number }
  ).id;
  const suppId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, situation, situation_id)
         VALUES (?, 'Zinc', 1, 'supplement', 'situational', 'high', 'Illness', ?)`
      )
      .run(sitCoachId, illnessSitId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 tab', 'morning', 'any', 0)`
  ).run(suppId);
}
seedMemberLogin(E2E_LOGIN_SITCOACH, sitCoachId);

// ILLNESS_CARE: a dedicated sick profile for the illness-care care finding (#805). Its
// fever is logged on FOUR consecutive days (daysAgo 3→0), crossing the cited "more than
// 3 days" line so the finding surfaces on Upcoming. Dedicated + read-only in
// illness-care.spec — profile 1 carries the same fixture, but the illness lifecycle specs
// mutate profile 1's illness state (end/reopen episode, dismiss the finding), and under
// --repeat-each a sibling's mutation made the finding vanish for the reader. Mirrors the
// scripts/seed.ts profile-1 shape: active Illness situation + open episode + 4-day fever.
const illnessCareId = fixtureProfileId(ILLNESS_CARE_PROFILE);
{
  const on = today(illnessCareId);
  const existingSit = db
    .prepare(
      "SELECT id FROM situations WHERE profile_id = ? AND name = 'Illness'"
    )
    .get(illnessCareId) as { id: number } | undefined;
  const sitId =
    existingSit?.id ??
    Number(
      db
        .prepare(
          "INSERT INTO situations (profile_id, name, active, illness_type) VALUES (?, 'Illness', 1, 1)"
        )
        .run(illnessCareId).lastInsertRowid
    );
  db.prepare(
    "UPDATE situations SET active = 1, illness_type = 1 WHERE id = ?"
  ).run(sitId);
  db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(
    illnessCareId
  );
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(illnessCareId, shiftDateStr(on, -3));
  // Fever on all four consecutive days (daysAgo 3→0) → "more than 3 days" → the finding.
  const seedFever = db.prepare(
    `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
     VALUES (?, ?, 'fever', ?, NULL)
     ON CONFLICT (profile_id, date, symptom)
     DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity)`
  );
  for (const [ago, severity] of [
    [3, 2],
    [2, 3],
    [1, 3],
    [0, 2],
  ] as const) {
    seedFever.run(illnessCareId, shiftDateStr(on, -ago), severity);
  }
}
seedMemberLogin(E2E_LOGIN_ILLNESS_CARE, illnessCareId);

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

// ── Household-rollup + illness-episode caregiver fixtures (#868 census hardening) ──
// Five member logins granted the SHARED seeded profiles — profile 1 ("admin") + profile 2
// ("Riley (child)", = rileyId) — so household-rollup / illness-episode stop creating
// members at runtime through Settings → Family (a router.refresh() render path that went
// stale under CI load — the create-member census flake). Grant sets are STATIC; the specs
// never mutate them, and profile 1 (lowest id) is the caregiver's default active profile.
if (rileyId) {
  // household-rollup: 1w+2w (confirm), 1w only (solo/redirect), 1r+2r (view-only).
  const hhCaregiverLoginId = seedMemberLogin(
    E2E_LOGIN_HH_CAREGIVER,
    1,
    "write"
  );
  grantProfile(hhCaregiverLoginId, rileyId, "write");
  seedMemberLogin(E2E_LOGIN_HH_SOLO, 1, "write");
  const hhViewerLoginId = seedMemberLogin(E2E_LOGIN_HH_VIEWER, 1, "read");
  grantProfile(hhViewerLoginId, rileyId, "read");
  // illness-episode: 1w+2w (cross-profile hero, #858), 1r+2w (view-only episode, #879).
  const illnessCaregiverLoginId = seedMemberLogin(
    E2E_LOGIN_ILLNESS_CAREGIVER,
    1,
    "write"
  );
  grantProfile(illnessCaregiverLoginId, rileyId, "write");
  const illnessRoLoginId = seedMemberLogin(E2E_LOGIN_ILLNESS_RO, 1, "read");
  grantProfile(illnessRoLoginId, rileyId, "write");
  console.log(
    "e2e: seeded household-rollup + illness-episode caregiver fixtures (#868)"
  );
}

// ── Household visit + illness history fixtures (#1009) ────────────────────────
// A caregiver granted a well parent + a currently-sick child, each carrying PAST
// visits + illness episodes, so /household/history has real cross-profile content to
// merge and tag by person. The child's CLOSED "Flu" overlaps the parent's Flu (the
// episode-card present case); the child's OPEN "Cold" makes the household currently
// sick (dashboard promotion); the parent's far-past "Chickenpox" overlaps nobody (the
// card-absent case). Parent is created FIRST so it carries the lower id — the login's
// active profile — so the caregiver acts as the well parent.
{
  const hhParentId = fixtureProfileId(HH_HISTORY_PARENT_PROFILE);
  const hhChildId = fixtureProfileId(HH_HISTORY_CHILD_PROFILE);
  const on = today(hhParentId);

  // Idempotent for a reused dev server.
  for (const pid of [hhParentId, hhChildId]) {
    db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(pid);
    db.prepare(
      "DELETE FROM encounters WHERE profile_id = ? AND source = 'manual'"
    ).run(pid);
  }

  const addEpisode = (
    pid: number,
    situation: string,
    startedAt: string,
    endedAt: string | null
  ): void => {
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, ?, ?, ?)`
    ).run(pid, situation, startedAt, endedAt);
  };
  const addEncounter = (pid: number, date: string, type: string): void => {
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, source)
       VALUES (?, ?, ?, 'manual')`
    ).run(pid, date, type);
  };

  // Parent: a past visit, a Flu that overlaps the child's, and a far-past Chickenpox.
  addEncounter(hhParentId, shiftDateStr(on, -40), "Annual physical");
  addEpisode(hhParentId, "Flu", shiftDateStr(on, -30), shiftDateStr(on, -25));
  addEpisode(
    hhParentId,
    "Chickenpox",
    shiftDateStr(on, -300),
    shiftDateStr(on, -295)
  );

  // Child: a past visit, a Flu overlapping the parent's, and an OPEN Cold (sick now).
  addEncounter(hhChildId, shiftDateStr(on, -10), "Sick visit");
  addEpisode(hhChildId, "Flu", shiftDateStr(on, -28), shiftDateStr(on, -24));
  addEpisode(hhChildId, "Cold", shiftDateStr(on, -2), null);

  const hhLoginId = seedMemberLogin(E2E_LOGIN_HHHIST, hhParentId);
  grantProfile(hhLoginId, hhChildId);

  // A second caregiver granted BOTH profiles read-only (the view-only grant case).
  const hhRoLoginId = seedMemberLogin(E2E_LOGIN_HHHIST_RO, hhParentId, "read");
  grantProfile(hhRoLoginId, hhChildId, "read");

  console.log(
    `e2e: seeded household-history fixtures — parent ${hhParentId}, child ${hhChildId}, caregivers ${hhLoginId}/${hhRoLoginId} (#1009)`
  );
}

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

// REASON_MODEL (#656 item 4): a dedicated adult profile with a family history of
// heart disease AND a fresh out-of-range LDL. The lipid analyte is risk-elevated for
// this profile (family-cardiovascular factor), so the biomarker-flag item on
// /upcoming gains its "why-for-this-profile" line ("Family history of heart
// disease") — the surface proof for the shared reason model. Read-only; isolated so
// it never changes a shared profile's flagged-lipid set. Idempotent: clear the LDL
// + family row first so a reused server re-seeds cleanly.
const reasonModelId = fixtureProfileId(REASON_MODEL_PROFILE);
db.prepare(
  `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')`
).run(reasonModelId);
db.prepare(
  `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1980-01-01')`
).run(reasonModelId);
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'LDL Cholesterol'`
).run(reasonModelId);
db.prepare(
  `DELETE FROM family_history WHERE profile_id = ? AND condition = 'Coronary artery disease'`
).run(reasonModelId);
db.prepare(
  `INSERT INTO family_history (profile_id, relation, condition) VALUES (?, 'parent', 'Coronary artery disease')`
).run(reasonModelId);
db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, canonical_name, value, unit, reference_range, flag)
   VALUES (?, date('now'), 'lab', 'LDL Cholesterol', 'LDL Cholesterol', '190', 'mg/dL', '<100', 'high')`
).run(reasonModelId);
seedMemberLogin(E2E_LOGIN_REASON, reasonModelId, "read");

// NOTIF_PROFILE (#928): a dedicated adult profile whose member OWNS every
// notification mutation the Settings IA / matrix spec makes (enable Home Assistant,
// toggle per-kind matrix cells, assert the safety all-channels-off warning). Kept
// off every shared profile so it's repeat-safe under --repeat-each=3. No health
// data needed — the matrix reads only notification settings.
const notifProfileId = fixtureProfileId(NOTIF_PROFILE);
seedMemberLogin(E2E_LOGIN_NOTIF, notifProfileId, "write");
console.log(
  `e2e: seeded reason-model fixture — profile ${reasonModelId} (#656)`
);

// ASK_RECORDS (#878, Phase 2): a dedicated adult profile whose records answer the
// canonical Q&A example — "when did I last take antibiotics?". An antibiotics
// medication (notes name it a course, so the deterministic search matches "antibiotics"
// via notes) plus a matching urgent-care visit. The palette's "Ask about your records"
// retrieves them and renders a LINKED answer (offline structured floor on the keyless
// e2e DB). Idempotent: clear the seeded rows first so a reused server re-seeds cleanly.
// Isolated + read-only so it's repeat-safe.
const askRecordsId = fixtureProfileId(ASK_RECORDS_PROFILE);
db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
  askRecordsId,
  ASK_RECORDS_MED
);
db.prepare(
  `DELETE FROM encounters WHERE profile_id = ? AND reason LIKE '%prescribed antibiotics%'`
).run(askRecordsId);
db.prepare(
  `INSERT INTO intake_items (profile_id, name, kind, condition, priority, active, source, notes)
   VALUES (?, ?, 'medication', 'daily', 'high', 1, 'manual', 'Antibiotics course for a sinus infection')`
).run(askRecordsId, ASK_RECORDS_MED);
db.prepare(
  `INSERT INTO encounters (profile_id, date, type, reason)
   VALUES (?, date('now', '-2 months'), 'Urgent care', 'Sinus infection — prescribed antibiotics')`
).run(askRecordsId);
seedMemberLogin(E2E_LOGIN_ASK, askRecordsId, "read");
console.log(`e2e: seeded record-QA fixture — profile ${askRecordsId} (#878)`);

// #1305 finding-closure toast (settings autosave path): a sole gappy profile with SEX set
// but NO birthdate, so ONLY the "Set a birthdate" data-quality gap is the salient clear.
// The closure spec resets the birthdate at test start (direct-DB), so its write never
// sticks across repeats and it never perturbs the DQ dashboard fixtures.
const closureDqId = fixtureProfileId(CLOSURE_DQ_PROFILE);
db.prepare(
  `DELETE FROM profile_settings WHERE profile_id = ? AND key = 'birthdate'`
).run(closureDqId);
db.prepare(
  `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
).run(closureDqId);
seedMemberLogin(E2E_LOGIN_CLOSURE_DQ, closureDqId, "write");
console.log(`e2e: seeded closure-DQ fixture — profile ${closureDqId} (#1305)`);

// PROTEIN_QUICKADD_PROFILE (#824): a dedicated adult profile for the protein-grams
// quick-add spec. Seeds a bodyweight (so the adequacy target scales) + a couple of
// protein-bearing food-group servings today (so the card renders over the ESTIMATED
// basis), with NO tracked protein_g and NO protein_log rows — the spec OWNS the grams
// writes. Idempotent: hard-clear any protein_log rows so a reused server always starts
// the day from the estimated-only basis the spec's transition asserts.
const proteinProfileId = fixtureProfileId(PROTEIN_QUICKADD_PROFILE);
const proteinAnchor = today(proteinProfileId);
db.prepare(`DELETE FROM protein_log WHERE profile_id = ?`).run(
  proteinProfileId
);
db.prepare(
  `DELETE FROM profile_settings WHERE profile_id = ? AND key = 'protein_quickadd_last'`
).run(proteinProfileId);
db.prepare(
  `INSERT OR IGNORE INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 80)`
).run(proteinProfileId, proteinAnchor);
for (const [slug, servings] of [
  ["poultry", 1],
  ["eggs", 1],
] as const) {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = excluded.servings`
  ).run(proteinProfileId, proteinAnchor, slug, servings);
}
seedMemberLogin(E2E_LOGIN_PROTEIN, proteinProfileId, "write");
console.log(
  `e2e: seeded protein quick-add fixture — profile ${proteinProfileId} (${PROTEIN_QUICKADD_PROFILE}) (#824)`
);

// ── Food-log slot-aware ranking + N-week habit trend fixture (#950 / #954) ────
// A dedicated adult profile (no birthdate) whose per-tap food_log_events ledger is
// slot-SKEWED: exactly one dominant encourage group per window (whole_grains at
// breakfast, fatty_fish at lunch, berries in the evening). Default timezone is UTC and
// the default slot boundaries are 11:00/15:00, so the 08:00Z / 12:00Z / 18:00Z taps
// land in Morning / Midday / Evening — whatever slot the e2e wall clock is in, the
// one-tap bar's lead matches the slot chip. Idempotent: hard-clear the profile's
// food_log + food_log_events + food_group targets so a reused server always starts from
// this exact skew.
const foodSlotId = fixtureProfileId(FOOD_SLOT_PROFILE);
// Opt this profile OUT of the pinned instance timezone (top of file): its taps
// below are stamped at fixed UTC wall-times (08/12/18Z) designed against the
// UTC slot boundaries this comment block describes, and the spec's
// whatever-slot-now-is assertion is hour-robust by design — pinning would shift
// the tap→slot mapping instead of stabilizing anything.
setTimezone(foodSlotId, "UTC");
const foodSlotAnchor = today(foodSlotId);
db.prepare(`DELETE FROM food_log WHERE profile_id = ?`).run(foodSlotId);
db.prepare(`DELETE FROM food_log_events WHERE profile_id = ?`).run(foodSlotId);
db.prepare(
  `DELETE FROM frequency_targets WHERE profile_id = ? AND scope_kind = 'food_group'`
).run(foodSlotId);
{
  const fLog = db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + excluded.servings`
  );
  const fEvent = db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, logged_at) VALUES (?, ?, ?, ?)`
  );
  const log = (date: string, group: string, n: number, hourZ: string) => {
    fLog.run(foodSlotId, date, group, n);
    for (let i = 0; i < n; i++)
      fEvent.run(foodSlotId, group, date, `${date}T${hourZ}Z`);
  };
  // 8 weeks so the habit trend has real history. One dominant group per slot each day,
  // plus fatty_fish twice a week at lunch (its 2×/week habit target).
  for (let d = 55; d >= 0; d--) {
    const date = shiftDateStr(foodSlotAnchor, -d);
    log(date, "whole_grains", 1, "08:00:00"); // morning dominant
    log(date, "berries", 1, "18:00:00"); // evening dominant
    if (d % 7 === 1 || d % 7 === 4) log(date, "fatty_fish", 1, "12:00:00"); // midday dominant (2×/week)
  }
  // A backdated "fatty fish 2×/week" habit → a real multi-week consistency trend (#954).
  // Created 63 days ago (before the whole 8-week / 56-day trend window) so every cell is
  // applicable — no not-applicable boundary cell to make the strip look like a cold start.
  db.prepare(
    `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week, created_at)
       VALUES (?, 'food_group', 'fatty_fish', 2, ?)`
  ).run(foodSlotId, `${shiftDateStr(foodSlotAnchor, -63)} 09:00:00`);
  // A freshly-created "leafy greens 3×/week" habit → an HONEST cold-start trend (weeks
  // before it existed render not-applicable, not misses). created_at defaults to now.
  db.prepare(
    `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'food_group', 'leafy_greens', 3)`
  ).run(foodSlotId);
}
seedMemberLogin(E2E_LOGIN_FOODSLOT, foodSlotId, "write");
console.log(
  `e2e: seeded food-slot ranking + habit-trend fixture — profile ${foodSlotId} (${FOOD_SLOT_PROFILE}) (#950/#954)`
);

// ── Endurance event plans (#839) ──────────────────────────────────────────────
// ENDURANCE_PROFILE: a dedicated adult profile with a few weeks of logged runs so a
// plan created in the spec has a real weekly-volume base + this-week actuals. The spec
// OWNS the endurance_plans lifecycle (create-and-clean), so hard-clear any leftover
// plans on a reused server. Runs seeded across the last three weeks + this week.
const enduranceProfileId = fixtureProfileId(ENDURANCE_PROFILE);
db.prepare(`DELETE FROM endurance_plans WHERE profile_id = ?`).run(
  enduranceProfileId
);
db.prepare(
  `DELETE FROM activities WHERE profile_id = ? AND type = 'cardio'`
).run(enduranceProfileId);
for (const [ago, km, wt] of [
  [20, 8, null],
  [18, 6, null],
  [13, 9, null],
  [11, 7, null],
  [6, 10, "long run"],
  [4, 6, null],
  [1, 8, null], // this week so far
] as const) {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, distance_km, workout_type)
     VALUES (?, ?, 'cardio', 'Running', ?, ?)`
  ).run(
    enduranceProfileId,
    shiftDateStr(today(enduranceProfileId), -ago),
    km,
    wt
  );
}
seedMemberLogin(E2E_LOGIN_ENDURANCE, enduranceProfileId, "write");
console.log(
  `e2e: seeded endurance-plan fixture — profile ${enduranceProfileId} (${ENDURANCE_PROFILE}) (#839)`
);

// ── Flagged-labs follow-up fixture (#700 flagged-labs adapter) ────────────────
// A dedicated adult profile (no birthdate) carrying ONE flagged biomarker: an
// out-of-range Hemoglobin A1c dated ~120 days ago. The followup-labs spec tracks a
// 3-month "Recheck A1c" follow-up from the biomarker detail page (so its planned date
// lands in the past → OVERDUE → surfaces on Upcoming immediately), asserts the legible
// item, then adds a later same-family (eAG) reading and resolves the loop. Idempotent:
// delete-then-insert the A1c source on (profile, canonical); the spec owns + cleans the
// follow-up care_plan_items + the later eAG reading in beforeAll/afterAll.
const flaggedLabId = fixtureProfileId(FLAGGED_LAB_PROFILE);
const flaggedLabAnchor = today(flaggedLabId);
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'Hemoglobin A1c'`
).run(flaggedLabId);
db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, value_num, unit, canonical_name, flag, source)
   VALUES (?, ?, 'lab', 'Hemoglobin A1c', '8.2', 8.2, '%', 'Hemoglobin A1c', 'high', 'manual')`
).run(flaggedLabId, shiftDateStr(flaggedLabAnchor, -120));
seedMemberLogin(E2E_LOGIN_FLABS, flaggedLabId, "write");
console.log(
  `e2e: seeded flagged-lab follow-up fixture — profile ${flaggedLabId} (${FLAGGED_LAB_PROFILE}) (#700)`
);

// ── Flagged-IOP glaucoma follow-up fixture (#698 §6 IOP adapter) ──────────────
// A dedicated adult profile carrying ONE flagged intraocular-pressure reading: an
// out-of-range right-eye IOP (28 mmHg, ref 10–21) dated ~120 days ago. The followup-iop
// spec tracks a 3-month "Recheck IOP / glaucoma workup" from the biomarker detail page
// (planned date lands in the past → OVERDUE → surfaces on Upcoming immediately), asserts
// the legible item, then adds a later LEFT-eye pressure and resolves the loop (bilateral).
// Idempotent: delete-then-insert the source IOP on (profile, canonical); the spec owns +
// cleans the follow-up care_plan_items + the later reading in beforeAll/afterAll.
const flaggedIopId = fixtureProfileId(FLAGGED_IOP_PROFILE);
const flaggedIopAnchor = today(flaggedIopId);
db.prepare(
  `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'Intraocular Pressure, Right Eye'`
).run(flaggedIopId);
db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, value_num, unit, canonical_name, flag, source)
   VALUES (?, ?, 'vitals', 'Intraocular Pressure, Right Eye', '28', 28, 'mmHg', 'Intraocular Pressure, Right Eye', 'high', 'manual')`
).run(flaggedIopId, shiftDateStr(flaggedIopAnchor, -120));
seedMemberLogin(E2E_LOGIN_IOP, flaggedIopId, "write");
console.log(
  `e2e: seeded flagged-IOP follow-up fixture — profile ${flaggedIopId} (${FLAGGED_IOP_PROFILE}) (#698)`
);

// ── Menstrual cycle log fixture (#714) ────────────────────────────────────────
// A dedicated adult profile with three completed, roughly-regular periods (~28-day
// cycles, 5-day bleeding) and NO open period, so the Cycle surface renders a derived
// phase, the cycle-length + variability stats, and the length trend chart. The cycle
// spec OWNS its mutations (one-tap start/end, add/delete), so hard-clear any leftover
// cycles on a reused server. Synthetic, no PHI.
const cycleProfileId = fixtureProfileId(CYCLE_PROFILE);
db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(cycleProfileId);
const cycleAnchor = today(cycleProfileId);
for (const [startAgo, endAgo, flow] of [
  [75, 71, "medium"],
  [47, 43, "heavy"],
  [19, 15, "light"],
] as const) {
  db.prepare(
    `INSERT INTO cycles (profile_id, period_start, period_end, flow)
     VALUES (?, ?, ?, ?)`
  ).run(
    cycleProfileId,
    shiftDateStr(cycleAnchor, -startAgo),
    shiftDateStr(cycleAnchor, -endAgo),
    flow
  );
}
// One activity ON the most recent period's start day so the Timeline has a day section
// there — its header renders the derived phase/period chip ("Period"), the #714 Timeline
// surface the spec asserts.
db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(cycleProfileId);
db.prepare(
  `INSERT INTO activities (profile_id, date, type, title, distance_km)
   VALUES (?, ?, 'cardio', 'Walk', 3)`
).run(cycleProfileId, shiftDateStr(cycleAnchor, -19));
seedMemberLogin(E2E_LOGIN_CYCLE, cycleProfileId, "write");
console.log(
  `e2e: seeded cycle-log fixture — profile ${cycleProfileId} (${CYCLE_PROFILE}) (#714)`
);

// ── Derived situations fixture (#1292 Poor sleep, #1298 Period) ───────────────
// A dedicated adult female (premenopausal → cycle-relevant) profile that carries a
// Period-keyed iron supplement and a Poor-sleep-keyed magnesium, plus a rough last-night
// sleep session so the DERIVED poor-sleep context is measured-ON. NO open period is
// seeded, so today starts a gap day (Period context off) until the spec logs a period
// (its own idempotent inverse). Hard-clear the fixture's cycles / intake / today sleep /
// override rows first so a reused server re-seeds cleanly. Synthetic, no PHI.
{
  const dsId = fixtureProfileId(DERIVED_SITU_PROFILE);
  const dsToday = today(dsId);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')`
  ).run(dsId);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value)
     VALUES (?, 'reproductive_status', 'premenopausal')`
  ).run(dsId);
  // Idempotent reset for a reused server.
  db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(dsId);
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ?`).run(dsId);
  db.prepare(`DELETE FROM situations WHERE profile_id = ?`).run(dsId);
  db.prepare(
    `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min'`
  ).run(dsId);
  db.prepare(
    `DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'poor-sleep-override:%'`
  ).run(dsId);

  // The two derived situations as inactive vocabulary rows (name-keyed; the derived
  // resolver keys on the names, no manual activation needed).
  const periodSit = Number(
    db
      .prepare(
        `INSERT INTO situations (profile_id, name, active) VALUES (?, 'Period', 0)`
      )
      .run(dsId).lastInsertRowid
  );
  const sleepSit = Number(
    db
      .prepare(
        `INSERT INTO situations (profile_id, name, active) VALUES (?, 'Poor sleep', 0)`
      )
      .run(dsId).lastInsertRowid
  );

  const keyedItem = (name: string, situation: string, sitId: number) => {
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, kind, condition, priority, situation, situation_id, active, as_needed)
           VALUES (?, ?, 'supplement', 'situational', 'high', ?, ?, 1, 0)`
        )
        .run(dsId, name, situation, sitId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '1 cap', 'evening', 'any', 0)`
    ).run(itemId);
    return itemId;
  };
  keyedItem(DERIVED_SITU_PERIOD_ITEM, "Period", periodSit);
  keyedItem(DERIVED_SITU_SLEEP_ITEM, "Poor sleep", sleepSit);

  // A rough last-night sleep session (300 min = 5h < the 6h floor) so getSleepSignal
  // trips and the measured poor-sleep context is ON, plus a few good baseline nights.
  for (let i = 5; i >= 1; i--) {
    const wake = shiftDateStr(dsToday, -i);
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 480)`
    ).run(dsId, wake, `${shiftDateStr(wake, -1)}T23:00`, `${wake}T07:00`);
  }
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 300)`
  ).run(
    dsId,
    dsToday,
    `${shiftDateStr(dsToday, -1)}T23:00`,
    `${dsToday}T04:00`
  );

  seedMemberLogin(E2E_LOGIN_DERIVED, dsId, "write");
  console.log(
    `e2e: seeded derived-situations fixture — profile ${dsId} (${DERIVED_SITU_PROFILE}) (#1292/#1298)`
  );
}

// ── Dashboard daily-loop fixture (#1221) ──────────────────────────────────────
// A dedicated adult female profile carrying one reading in every domain the four new
// dashboard cards read, all dated to the fixture's "today" so each card renders
// populated. Read-only in its spec; hard-clear the fixture rows first for a reused
// server. Synthetic, no PHI.
{
  const dailyId = fixtureProfileId(DAILY_LOOP_PROFILE);
  const dToday = today(dailyId);

  // Female + premenopausal so cycle tracking is relevant even before the cycle rows
  // below (data wins regardless, but this mirrors a realistic profile).
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')`
  ).run(dailyId);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value)
     VALUES (?, 'reproductive_status', 'premenopausal')`
  ).run(dailyId);

  // Body composition: a recent weigh-in (the protein target's mass) + resting HR (two
  // readings so the Latest-vitals card shows a resting-HR trend arrow).
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(dailyId);
  const insBm = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr, notes)
     VALUES (?, ?, ?, ?, 'e2e:daily-loop')`
  );
  insBm.run(dailyId, shiftDateStr(dToday, -3), 64.0, 60);
  insBm.run(dailyId, dToday, 63.6, 58);

  // Steps: today + a trailing week (additive; one source per day) so the Steps-today
  // card shows today vs the 7-day average with a direction arrow.
  db.prepare(
    `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'steps'`
  ).run(dailyId);
  const insSteps = db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health-connect', 'steps', ?, ?, ?, ?)`
  );
  for (const [ago, steps] of [
    [7, 6800],
    [6, 7200],
    [5, 8100],
    [4, 6500],
    [3, 7700],
    [2, 8300],
    [1, 7100],
    [0, 9400], // today, above the trailing average → "up"
  ] as const) {
    const day = shiftDateStr(dToday, -ago);
    insSteps.run(dailyId, day, `${day}T00:00:00Z`, `${day}T23:59:59Z`, steps);
  }

  // Blood pressure: a recent pair of readings (systolic + diastolic) stored as
  // biomarker medical_records, so the Latest-vitals card shows "118/76" with a trend.
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name IN ('Blood Pressure Systolic', 'Blood Pressure Diastolic')`
  ).run(dailyId);
  const insBp = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, reference_range, value_num, canonical_name)
     VALUES (?, ?, 'vitals', ?, ?, 'mmHg', ?, ?, ?)`
  );
  for (const [ago, sys, dia] of [
    [10, 122, 80],
    [2, 118, 76],
  ] as const) {
    const day = shiftDateStr(dToday, -ago);
    insBp.run(
      dailyId,
      day,
      "Blood Pressure Systolic",
      String(sys),
      "90-120",
      sys,
      "Blood Pressure Systolic"
    );
    insBp.run(
      dailyId,
      day,
      "Blood Pressure Diastolic",
      String(dia),
      "60-80",
      dia,
      "Blood Pressure Diastolic"
    );
  }

  // Food today: a few protein-bearing food-group servings so getProteinToday reads a
  // non-zero floor against the goal band (the Nutrition-today card).
  db.prepare(`DELETE FROM food_log WHERE profile_id = ?`).run(dailyId);
  const insFood = db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)`
  );
  for (const [ago, group, servings] of [
    [0, "legumes", 2],
    [0, "fatty_fish", 1],
    [0, "leafy_greens", 2],
    [1, "legumes", 1],
    [1, "red_meat", 1],
  ] as const) {
    insFood.run(dailyId, shiftDateStr(dToday, -ago), group, servings);
  }

  // Cycles: three completed, roughly-regular periods (no open period) so cycle tracking
  // is relevant and a phase + cycle-day derive for the Cycle-phase card.
  db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(dailyId);
  for (const [startAgo, endAgo, flow] of [
    [70, 66, "medium"],
    [42, 38, "medium"],
    [14, 10, "light"],
  ] as const) {
    db.prepare(
      `INSERT INTO cycles (profile_id, period_start, period_end, flow) VALUES (?, ?, ?, ?)`
    ).run(
      dailyId,
      shiftDateStr(dToday, -startAgo),
      shiftDateStr(dToday, -endAgo),
      flow
    );
  }

  // One active PRN medication so the check-in "Take any meds?" branch renders on this
  // profile's dashboard too (the folded quick-log, #1221).
  db.prepare(
    `DELETE FROM intake_items WHERE profile_id = ? AND name = 'Daily Loop PRN (e2e)'`
  ).run(dailyId);
  db.prepare(
    `INSERT INTO intake_items (profile_id, kind, name, active, as_needed)
     VALUES (?, 'medication', 'Daily Loop PRN (e2e)', 1, 1)`
  ).run(dailyId);

  // A custom NON-clinical situation (starts inactive) + a situational supplement keyed
  // to it, so the check-in "Anything going on?" chips include a custom fixture situation
  // and toggling it flips a situational supplement due — the #662 activation line the
  // Part-6 spec asserts on both the check-in card and the Supplements bar. Hard-clear for
  // a reused server (the situations UNIQUE(profile_id, name NOCASE) would otherwise clash).
  db.prepare(
    `DELETE FROM intake_items WHERE profile_id = ? AND name = 'Focus Blend (e2e)'`
  ).run(dailyId);
  db.prepare(
    `DELETE FROM situations WHERE profile_id = ? AND name = 'Deadline (e2e)'`
  ).run(dailyId);
  const dailySitId = Number(
    db
      .prepare(
        `INSERT INTO situations (profile_id, name, active, illness_type)
         VALUES (?, 'Deadline (e2e)', 0, 0)`
      )
      .run(dailyId).lastInsertRowid
  );
  const dailySuppId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, kind, name, condition, priority, situation, situation_id, active)
         VALUES (?, 'supplement', 'Focus Blend (e2e)', 'situational', 'low', 'Deadline (e2e)', ?, 1)`
      )
      .run(dailyId, dailySitId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'Anytime', 'any', 0)`
  ).run(dailySuppId);

  seedMemberLogin(E2E_LOGIN_DAILY, dailyId, "write");
  console.log(
    `e2e: seeded dashboard daily-loop fixture — profile ${dailyId} (${DAILY_LOOP_PROFILE}) (#1221)`
  );
}

// ── Nav relevance gating fixtures (#1042 phase 1) ─────────────────────────────
// Two dedicated, read-only profiles for the nav-consolidation spec:
//   • NAV_FEMALE — sex=female + explicit premenopausal status, NO cycle rows, so
//     the Cycle nav entry shows via cycleTrackingRelevant's status arm; no
//     vision/dental rows either, so those data-gated entries are hidden for it.
//   • NAV_MALE — sex=male + adult birthdate, NO cycle rows → Cycle hidden.
// Idempotent on a reused server: hard-clear the relevance-bearing rows and
// re-write the profile attributes.
for (const [profileName, loginName, attrs] of [
  [
    NAV_FEMALE_PROFILE,
    E2E_LOGIN_NAV_FEMALE,
    [
      ["sex", "female"],
      ["reproductive_status", "premenopausal"],
    ],
  ],
  [
    NAV_MALE_PROFILE,
    E2E_LOGIN_NAV_MALE,
    [
      ["sex", "male"],
      ["birthdate", "1988-04-01"],
    ],
  ],
] as const) {
  const pid = fixtureProfileId(profileName);
  db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(pid);
  db.prepare(`DELETE FROM optical_prescriptions WHERE profile_id = ?`).run(pid);
  db.prepare(`DELETE FROM dental_procedures WHERE profile_id = ?`).run(pid);
  db.prepare(
    `DELETE FROM profile_settings WHERE profile_id = ? AND key IN ('sex', 'reproductive_status', 'birthdate', 'age')`
  ).run(pid);
  for (const [key, value] of attrs) {
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)`
    ).run(pid, key, value);
  }
  seedMemberLogin(loginName, pid, "read");
  console.log(
    `e2e: seeded nav-relevance fixture — profile ${pid} (${profileName}) (#1042)`
  );
}

// ── Dashboard weight quick-add fixture (#1042 phase 2) ────────────────────────
// A dedicated adult profile with exactly two seeded weigh-ins so the dashboard
// weight-trend widget renders its chart state; the weight-quick-add spec owns
// every non-seed body_metrics row (it clears them itself at test start).
// Idempotent: hard-clear and re-insert the seed rows.
const weightQaId = fixtureProfileId(WEIGHT_QUICKADD_PROFILE);
db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(weightQaId);
const weightQaAnchor = today(weightQaId);
for (const [daysAgo, kg] of [
  [7, 70],
  [3, 70.6],
] as const) {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, notes)
     VALUES (?, ?, ?, 'e2e:seed-weight')`
  ).run(weightQaId, shiftDateStr(weightQaAnchor, -daysAgo), kg);
}
seedMemberLogin(E2E_LOGIN_WEIGHT_QA, weightQaId, "write");
console.log(
  `e2e: seeded weight quick-add fixture — profile ${weightQaId} (${WEIGHT_QUICKADD_PROFILE}) (#1042)`
);

// ── Legacy imported-Celsius temperature fixture (#1018) ───────────────────────
// A dedicated sick profile whose ONLY temperature is a LEGACY imported Celsius
// row — unit 'Cel', source 'ccd', external_id set, flag never derived — exactly
// the shape the CCDA mapper stored before the import-boundary conversion. Seeded
// AFTER boot (so migration 074 / the flag reconcile never touch it), it proves
// the episode read gate in the browser: the cockpit's latest temperature renders
// the CONVERTED 101.3 °F, never raw "38.5" on the °F axis. Spec-owned + read-only
// (imported-temp-unit.spec.ts); the situation/episode mirrors seedSickEpisode.
const celImportId = fixtureProfileId(CEL_IMPORT_PROFILE);
{
  const on = today(celImportId);
  const existingSit = db
    .prepare(
      "SELECT id FROM situations WHERE profile_id = ? AND name = 'Illness'"
    )
    .get(celImportId) as { id: number } | undefined;
  const sitId =
    existingSit?.id ??
    Number(
      db
        .prepare(
          "INSERT INTO situations (profile_id, name, active, illness_type) VALUES (?, 'Illness', 1, 1)"
        )
        .run(celImportId).lastInsertRowid
    );
  db.prepare(
    "UPDATE situations SET active = 1, illness_type = 1 WHERE id = ?"
  ).run(sitId);
  db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(
    celImportId
  );
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(celImportId, shiftDateStr(on, -1));
  db.prepare(
    `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
     VALUES (?, ?, 'fever', 2, NULL)
     ON CONFLICT (profile_id, date, symptom)
     DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity)`
  ).run(celImportId, on);
  // Idempotent for a reused dev server: this profile owns exactly one reading.
  db.prepare(
    "DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'Body Temperature'"
  ).run(celImportId);
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit,
        canonical_name, source, external_id, notes)
     VALUES (?, ?, 'vitals', 'Body temperature', '38.5', 38.5, 'Cel',
             'Body Temperature', 'ccd', 'ccda:vital:8310-5:e2e-cel:38.5', '09:00')`
  ).run(celImportId, on);
}
seedMemberLogin(E2E_LOGIN_CEL_IMPORT, celImportId, "write");
console.log(
  `e2e: seeded legacy imported-Cel temperature fixture — profile ${celImportId} (${CEL_IMPORT_PROFILE}) (#1018)`
);

// ── Coded preventive satisfaction (#1035/#1037) ───────────────────────────────
// A dedicated adult profile whose adult_physical and dental_cleaning rules are
// satisfied ONLY through stored codes: a generic "Office Visit" encounter carrying
// CPT 99396 (established preventive visit, 40-64) and a completed generic "Prophy"
// dental row carrying CDT D1110. No name synonym can match either, so the spec's
// absence assertions prove the code path end-to-end. vision_exam stays DUE (no
// evidence), anchoring the rendered list. Idempotent: rows are cleared first.
const prevCodeId = fixtureProfileId(PREVENTIVE_CODES_PROFILE);
{
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')`
  ).run(prevCodeId);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1980-02-01')`
  ).run(prevCodeId);
  const pToday = today(prevCodeId);
  db.prepare(`DELETE FROM encounters WHERE profile_id = ?`).run(prevCodeId);
  db.prepare(`DELETE FROM dental_procedures WHERE profile_id = ?`).run(
    prevCodeId
  );
  db.prepare(
    `INSERT INTO encounters (profile_id, date, type, code, code_system, class_code)
       VALUES (?, ?, 'Office Visit', '99396', 'CPT', 'AMB')`
  ).run(prevCodeId, shiftDateStr(pToday, -30));
  db.prepare(
    `INSERT INTO dental_procedures (profile_id, name, status, cdt_code, procedure_date)
       VALUES (?, 'Prophy', 'completed', 'D1110', ?)`
  ).run(prevCodeId, shiftDateStr(pToday, -30));
}
seedMemberLogin(E2E_LOGIN_PREVCODE, prevCodeId, "write");
console.log(
  `e2e: seeded coded preventive-satisfaction fixture — profile ${prevCodeId} (${PREVENTIVE_CODES_PROFILE}) (#1035/#1037)`
);

// ── Drug-allergy × medication cross-check fixture (#1029, #1092) ──────────────
// A dedicated adult profile with a recorded "Penicillin — hives" allergy plus two
// tracked active medications: amoxicillin (a same-class penicillin hit) and
// cephalexin (the documented penicillin ↔ cephalosporin cross-reactivity hit). The
// spec asserts the safety-strip cards on /medications and the care-persistent
// Needs-attention hero finding (#1092: snooze-only, a page dismissal resisted), and
// owns its dismissal state (reset per test). Idempotent for a reused server:
// hard-clear this profile's allergies + intake rows before re-seeding. Synthetic, no PHI.
const drugAllergyId = fixtureProfileId(DRUG_ALLERGY_PROFILE);
db.prepare(`DELETE FROM allergies WHERE profile_id = ?`).run(drugAllergyId);
db.prepare(
  `DELETE FROM intake_item_logs WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
).run(drugAllergyId);
db.prepare(
  `DELETE FROM intake_item_doses WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
).run(drugAllergyId);
db.prepare(`DELETE FROM intake_items WHERE profile_id = ?`).run(drugAllergyId);
db.prepare(
  `INSERT INTO allergies (profile_id, substance, reaction, severity, status)
   VALUES (?, 'Penicillin', 'hives', 'moderate', 'active')`
).run(drugAllergyId);
for (const medName of ["Amoxicillin 500 mg", "Cephalexin 250 mg"]) {
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, active, kind, as_needed)
     VALUES (?, ?, 1, 'medication', 1)`
  ).run(drugAllergyId, medName);
}
seedMemberLogin(E2E_LOGIN_DRUG_ALLERGY, drugAllergyId, "write");
console.log(
  `e2e: seeded drug-allergy cross-check fixture — profile ${drugAllergyId} (${DRUG_ALLERGY_PROFILE}) (#1029)`
);

// ── Cross-item PRN counter fixture (#1027) ────────────────────────────────────
// A dedicated adult profile with the issue's two-ibuprofen setup: OTC "Ibuprofen"
// (PRN, confirmed 6h interval / max 4 — the redose-line carrier) plus a second
// "Ibuprofen 800 mg" item (PRN, unconfirmed fields) whose administration ONE HOUR
// before the frozen e2e clock holds the OTC item's redose window across the family.
// The spec asserts the family-widened "across 2 items" counter line on /medications
// and the coaching duplication note on the dashboard rollup. Idempotent hard-clear
// for a reused server. Synthetic, no PHI.
const prnFamilyId = fixtureProfileId(PRN_FAMILY_PROFILE);
db.prepare(
  `DELETE FROM intake_item_logs WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
).run(prnFamilyId);
db.prepare(
  `DELETE FROM intake_item_doses WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
).run(prnFamilyId);
db.prepare(`DELETE FROM intake_items WHERE profile_id = ?`).run(prnFamilyId);
const prnOtcId = Number(
  db
    .prepare(
      `INSERT INTO intake_items
         (profile_id, name, active, kind, condition, priority, as_needed,
          redose_notice, min_interval_hours, max_daily_count)
       VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'high', 1, 1, 6, 4)`
    )
    .run(prnFamilyId).lastInsertRowid
);
db.prepare(
  `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
   VALUES (?, '200 mg', 'anytime', 'any', 0)`
).run(prnOtcId);
const prnRxId = Number(
  db
    .prepare(
      `INSERT INTO intake_items
         (profile_id, name, active, kind, condition, priority, as_needed)
       VALUES (?, 'Ibuprofen 800 mg', 1, 'medication', 'daily', 'high', 1)`
    )
    .run(prnFamilyId).lastInsertRowid
);
const prnRxDoseId = Number(
  db
    .prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '800 mg', 'anytime', 'any', 0)`
    )
    .run(prnRxId).lastInsertRowid
);
// The sibling administration: 1h before the frozen clock, on the profile-local day.
db.prepare(
  `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, status)
   VALUES (?, ?, ?, ?, 'taken')`
).run(
  prnRxDoseId,
  prnRxId,
  today(prnFamilyId),
  utcSqlString(new Date(clockNow().getTime() - 3_600_000))
);
seedMemberLogin(E2E_LOGIN_PRN_FAMILY, prnFamilyId, "write");
console.log(
  `e2e: seeded cross-item PRN counter fixture — profile ${prnFamilyId} (${PRN_FAMILY_PROFILE}) (#1027)`
);

// ── Safety-coverage empty-state fixture (#1032) ───────────────────────────────
// A dedicated adult profile whose stack produces NO safety warnings: loratadine
// (off the curated interaction set entirely) + sertraline (a name-matched SSRI
// concept with no interacting partner), both name-only (no confirmed RxNorm code).
// The spec asserts the honest empty state — the "checked 1 of 2, no flags" scope
// line on both safety strips (instead of the pre-#1032 silent blank) and the quiet
// limited-screening chip on the name-only rows. Idempotent hard-clear for a reused
// server. Synthetic, no PHI.
const coverageId = fixtureProfileId(SAFETY_COVERAGE_PROFILE);
db.prepare(
  `DELETE FROM intake_item_logs WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
).run(coverageId);
db.prepare(
  `DELETE FROM intake_item_doses WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
).run(coverageId);
db.prepare(`DELETE FROM intake_items WHERE profile_id = ?`).run(coverageId);
for (const medName of ["Loratadine 10 mg", "Sertraline 50 mg"]) {
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, active, kind, as_needed)
     VALUES (?, ?, 1, 'medication', 1)`
  ).run(coverageId, medName);
}
seedMemberLogin(E2E_LOGIN_COVERAGE, coverageId, "write");
console.log(
  `e2e: seeded safety-coverage fixture — profile ${coverageId} (${SAFETY_COVERAGE_PROFILE}) (#1032)`
);

// ── HA notification-config fixture (post-#1025 isolation) ─────────────────────
// A dedicated adult profile for home-assistant-notify.spec.ts. The spec persists a
// real (unreachable) HA webhook config; since #1025 the temperature write paths
// dispatch the red-flag nudge immediately, so that config must never live on a
// profile other specs log temperatures for (a failed real send would overwrite the
// GLOBAL delivery-health marker seeded above for notify-delivery-error.spec.ts).
// No health data needed — the spec reads and writes only notification settings.
const haNotifyId = fixtureProfileId(HA_NOTIFY_PROFILE);
seedMemberLogin(E2E_LOGIN_HA_NOTIFY, haNotifyId, "write");
console.log(
  `e2e: seeded HA notification-config fixture — profile ${haNotifyId} (${HA_NOTIFY_PROFILE})`
);

// ── Structural data-quality gaps (#1045) ─────────────────────────────────────
// Idempotent helpers to force a profile's structural fields to a known state on a
// reused dev server (the profile_settings + medical_documents are re-seeded cleanly).
function clearProfileAttrs(profileId: number): void {
  db.prepare(
    `DELETE FROM profile_settings WHERE profile_id = ?
       AND key IN ('sex','birthdate','age','reproductive_status','smoking_status',
                   'smoking_pack_years','smoking_quit_year','smoking_source',
                   'risk_attributes_reviewed')`
  ).run(profileId);
}
function setAttr(profileId: number, key: string, value: string): void {
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(profileId, key, value);
}

// (A) A GAPPY sole profile: no birthdate, no sex, one failed-extraction document, and a
// name-only active medication → the dashboard "Data quality" widget shows birthdate,
// sex, RxCUI, and failed-doc gaps (leverage-ranked). The dismiss test resets its own
// data-quality dismissals first (below), so its write never sticks across repeats.
const dqGappyId = fixtureProfileId(DQ_GAPPY_PROFILE);
clearProfileAttrs(dqGappyId);
db.prepare(
  `DELETE FROM medical_documents WHERE profile_id = ? AND filename = 'dq-broken.txt'`
).run(dqGappyId);
db.prepare(
  `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes,
      extraction_status, extraction_error, uploaded_at)
   VALUES (?, 'dq-broken.txt', '', 'text/plain', 12,
           'failed', 'Unsupported file type.', '2026-01-01 00:00:00')`
).run(dqGappyId);
db.prepare(
  `DELETE FROM intake_items WHERE profile_id = ? AND name = 'DQ Mystery Pill'`
).run(dqGappyId);
db.prepare(
  `INSERT INTO intake_items (profile_id, name, active, kind, as_needed)
   VALUES (?, 'DQ Mystery Pill', 1, 'medication', 1)`
).run(dqGappyId);
seedMemberLogin(E2E_LOGIN_DQ_GAPPY, dqGappyId, "write");

// (B) A COMPLETE sole profile: birthdate (adult) + sex + smoking status + reviewed risk
// factors, and no meds/labs/failed-docs → the "Data quality" widget self-hides.
const dqCompleteId = fixtureProfileId(DQ_COMPLETE_PROFILE);
clearProfileAttrs(dqCompleteId);
setAttr(dqCompleteId, "sex", "male");
setAttr(dqCompleteId, "birthdate", "1985-01-01");
setAttr(dqCompleteId, "smoking_status", "never");
setAttr(dqCompleteId, "smoking_source", "manual");
setAttr(dqCompleteId, "risk_attributes_reviewed", "1");
seedMemberLogin(E2E_LOGIN_DQ_COMPLETE, dqCompleteId, "write");

// (C) A caregiver with a COMPLETE own profile + a GAPPY child → the household page
// shows a per-member data-quality gaps line on the child's card only.
const dqParentId = fixtureProfileId(DQ_CARE_PARENT_PROFILE);
clearProfileAttrs(dqParentId);
setAttr(dqParentId, "sex", "female");
setAttr(dqParentId, "birthdate", "1988-06-01");
setAttr(dqParentId, "smoking_status", "never");
setAttr(dqParentId, "smoking_source", "manual");
setAttr(dqParentId, "risk_attributes_reviewed", "1");
const dqChildId = fixtureProfileId(DQ_CARE_CHILD_PROFILE);
clearProfileAttrs(dqChildId); // no birthdate/sex → birthdate + sex gaps
const dqCareLogin = seedMemberLogin(E2E_LOGIN_DQ_CARE, dqParentId, "write");
grantProfile(dqCareLogin, dqChildId, "write");
console.log(
  `e2e: seeded data-quality fixtures — gappy ${dqGappyId}, complete ${dqCompleteId}, ` +
    `care parent ${dqParentId} + child ${dqChildId} (#1045)`
);

// (D) A structurally-GAPPY ADULT (#1146/#1219): birthdate + sex set (male, adult) so
// the ADULT-gated gaps fire — smoking status unknown, risk factors unreviewed, and a
// PARTIAL PhenoAge panel (one Albumin lab → first missing analyte is Creatinine) —
// and its CTAs must deep-link the exact forms. The same profile hosts the
// dashboard-deeplinks #1219 fixtures: a target-less goal (bare title row → goals
// link) and FOUR ongoing protocols + a layout that shows the active-protocols widget
// (cap 3 → "+1 more" overflow link). Idempotent; synthetic values only.
{
  const dqAdultId = fixtureProfileId(DQ_ADULT_PROFILE);
  clearProfileAttrs(dqAdultId);
  setAttr(dqAdultId, "sex", "male");
  setAttr(dqAdultId, "birthdate", "1984-04-01");
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND name = 'Albumin'`
  ).run(dqAdultId);
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
     VALUES (?, '2026-01-15', 'lab', 'Albumin', '4.5', 4.5, 'g/dL', 'Albumin', 'manual')`
  ).run(dqAdultId);

  // #1219 item 3 — a goal with NO measurable target (no exercise/metric/body-metric
  // and no target_value): the dashboard row renders no bar, so its title must link.
  db.prepare(
    `DELETE FROM goals WHERE profile_id = ? AND title = 'Feel better all around'`
  ).run(dqAdultId);
  db.prepare(
    `INSERT INTO goals (profile_id, title, status) VALUES (?, 'Feel better all around', 'active')`
  ).run(dqAdultId);

  // #1219 item 4 — four ONGOING protocols (end_date null) + a stored dashboard
  // layout that shows the off-by-default active-protocols widget, so the widget
  // caps at 3 and renders the "+1 more" overflow link. Distinct start dates pin
  // the shown/overflow split (getProtocols orders by start_date DESC).
  db.prepare(
    `DELETE FROM protocols WHERE profile_id = ? AND name LIKE 'DQ Protocol %'`
  ).run(dqAdultId);
  const insDqProtocol = db.prepare(
    `INSERT INTO protocols (profile_id, name, start_date, outcome_keys)
     VALUES (?, ?, ?, '[]')`
  );
  const dqAdultToday = today(dqAdultId);
  for (let i = 1; i <= 4; i++) {
    insDqProtocol.run(
      dqAdultId,
      `DQ Protocol ${i}`,
      shiftDateStr(dqAdultToday, -(10 + i))
    );
  }
  setAttr(
    dqAdultId,
    "dashboard_layout",
    JSON.stringify({ order: ["active-protocols"], hidden: [] })
  );

  seedMemberLogin(E2E_LOGIN_DQ_ADULT, dqAdultId, "write");
  console.log(
    `e2e: seeded data-quality ADULT fixture — profile ${dqAdultId} (${DQ_ADULT_PROFILE}) (#1146/#1219)`
  );
}

// ── Record ↔ visit / episode ↔ visit linking fixture (#1050/#1053) ──────────────
// A self-contained profile: one visit, a same-day UNLINKED medication (with a
// course started that day so the tier-2 engine dates it), and
// an illness episode spanning that day with NO linked visit. The spec drives the
// "From this visit?" batch link, the med "Prescribed at" line, and the cockpit Care
// suggestion → link → encounter back-link. OWNS every row (dedicated profile), so the
// suite's shared-seed counts are untouched.
{
  const vlProfileId = fixtureProfileId(VISITLINKS_PROFILE);
  const VL_DATE = "2026-05-12";
  // A visit on VL_DATE with an attending provider (also seeds the provider row).
  // providers carries a NOT NULL UNIQUE dedup_key, so seed it explicitly.
  db.prepare(
    `INSERT OR IGNORE INTO providers (name, type, dedup_key)
     VALUES ('Dr. Vera Vasquez (e2e)', 'individual', 'e2e:vera-vasquez')`
  ).run();
  const vlProviderId = (
    db
      .prepare("SELECT id FROM providers WHERE dedup_key = 'e2e:vera-vasquez'")
      .get() as { id: number }
  ).id;
  // Idempotent: only seed the visit + med + episode once per profile.
  const existingVisit = db
    .prepare(
      "SELECT id FROM encounters WHERE profile_id = ? AND date = ? AND type = 'Office Visit'"
    )
    .get(vlProfileId, VL_DATE) as { id: number } | undefined;
  if (!existingVisit) {
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, class_code, reason, provider_id)
       VALUES (?, ?, 'Office Visit', 'AMB', 'Sinus infection', ?)`
    ).run(vlProfileId, VL_DATE, vlProviderId);
    // An unlinked medication + a course dated VL_DATE, with the SAME provider so
    // the suggestion reads STRONG. (The med IS the tier-2 candidate — #1178
    // removed the paired medical_records 'prescription' row / 'record' domain.)
    const vlMedId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, provider_id)
           VALUES (?, 'Amoxicillin (e2e)', 'medication', ?)`
        )
        .run(vlProfileId, vlProviderId).lastInsertRowid
    );
    db.prepare(
      "INSERT INTO medication_courses (item_id, started_on) VALUES (?, ?)"
    ).run(vlMedId, VL_DATE);
    // An illness episode spanning VL_DATE, no linked visit yet.
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, 'sinus infection', '2026-05-10', '2026-05-15')`
    ).run(vlProfileId);
  }
  seedMemberLogin(E2E_LOGIN_VISITLINKS, vlProfileId, "write");
  console.log(
    `e2e: seeded visit-link fixture — profile ${vlProfileId} (${VISITLINKS_PROFILE}) #1050/#1053`
  );
}

// ── Encounter-detail enrichment (#1350/#1353) ─────────────────────────────────
// A self-contained profile whose subject visit exercises every enrichment: a
// same-provider prior visit (visit context), a completed appointment booked for it
// (scheduling origin), an illness episode spanning the visit with NO link yet (the
// encounter-side link suggestion → link → care trail), and a document-sourced + a
// manual condition (RecordProvenance deep-link vs plain label). OWNS every row.
{
  const enId = fixtureProfileId(ENCRICH_PROFILE);
  const EN_SUBJECT_DATE = "2026-06-18";
  db.prepare(
    `INSERT OR IGNORE INTO providers (name, type, dedup_key)
     VALUES ('Dr. Enid Enrich (e2e)', 'individual', 'e2e:enid-enrich')`
  ).run();
  const enProviderId = (
    db
      .prepare("SELECT id FROM providers WHERE dedup_key = 'e2e:enid-enrich'")
      .get() as { id: number }
  ).id;
  const existingSubject = db
    .prepare(
      "SELECT id FROM encounters WHERE profile_id = ? AND date = ? AND type = 'Office Visit'"
    )
    .get(enId, EN_SUBJECT_DATE) as { id: number } | undefined;
  if (!existingSubject) {
    // A same-provider prior visit earlier the same year → visit context reads
    // "2nd visit with Dr. Enid Enrich · last one Feb 2026" and "2nd … this year".
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, class_code, reason, provider_id)
       VALUES (?, '2026-02-10', 'Office Visit', 'AMB', 'Annual checkup', ?)`
    ).run(enId, enProviderId);
    const subjectId = Number(
      db
        .prepare(
          `INSERT INTO encounters (profile_id, date, type, class_code, reason, provider_id)
           VALUES (?, ?, 'Office Visit', 'AMB', 'Sinus congestion', ?)`
        )
        .run(enId, EN_SUBJECT_DATE, enProviderId).lastInsertRowid
    );
    // A completed appointment booked for the subject visit → scheduling origin.
    db.prepare(
      `INSERT INTO appointments (profile_id, scheduled_at, provider_id, status, encounter_id, title)
       VALUES (?, '2026-06-10 09:30:00', ?, 'completed', ?, 'Sick visit')`
    ).run(enId, enProviderId, subjectId);
    // An illness episode spanning the subject visit, NO linked visit yet → the
    // encounter-side "Link an illness episode?" suggestion.
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, 'sinus infection (e2e)', '2026-06-15', '2026-06-23')`
    ).run(enId);
    // A source document + a document-sourced condition and a manual condition →
    // RecordProvenance deep-link vs plain label (#1353).
    const docId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, doc_type, extraction_status, extracted_count, document_date)
           VALUES (?, 'visit-summary-e2e.xml', '/dev/null', 'ccd', 'done', 1, ?)`
        )
        .run(enId, EN_SUBJECT_DATE).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status, source, document_id)
       VALUES (?, 'Acute sinusitis (e2e)', 'active', ?, ?)`
    ).run(enId, `document:${docId}`, docId);
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status, source)
       VALUES (?, 'Seasonal allergies (e2e)', 'active', NULL)`
    ).run(enId);
  }
  seedMemberLogin(E2E_LOGIN_ENCRICH, enId, "write");
  console.log(
    `e2e: seeded encounter-enrichment fixture — profile ${enId} (${ENCRICH_PROFILE}) #1350/#1353`
  );
}

// ── "Create a visit from this record?" (#1099) ────────────────────────────────
// A self-contained profile with ONE optical prescription dated a day that has NO
// encounter — so the Vision record card shows the "Create a visit from this record?"
// prompt. The spec accepts it and asserts the derived visit appears with the Rx in its
// "From this visit" section. OWNS the profile (dedicated login), so the accept's writes
// (a new encounter + the link) never touch shared-seed counts. Idempotent under
// --repeat-each: seed once, and the spec only accepts when the prompt is still present.
{
  const cvProfileId = fixtureProfileId(CREATEVISIT_PROFILE);
  const CV_DATE = "2026-05-20";
  db.prepare(
    `INSERT OR IGNORE INTO providers (name, type, dedup_key)
     VALUES ('Dr. Iris Optic (e2e)', 'individual', 'e2e:iris-optic')`
  ).run();
  const cvProviderId = (
    db
      .prepare("SELECT id FROM providers WHERE dedup_key = 'e2e:iris-optic'")
      .get() as { id: number }
  ).id;
  const existingRx = db
    .prepare(
      "SELECT id FROM optical_prescriptions WHERE profile_id = ? AND issued_date = ?"
    )
    .get(cvProfileId, CV_DATE) as { id: number } | undefined;
  if (!existingRx) {
    db.prepare(
      `INSERT INTO optical_prescriptions
         (profile_id, kind, od_sphere, os_sphere, issued_date, provider_id, brand)
       VALUES (?, 'glasses', -1.5, -1.75, ?, ?, 'Rx Slip (e2e)')`
    ).run(cvProfileId, CV_DATE, cvProviderId);
  }
  seedMemberLogin(E2E_LOGIN_CREATEVISIT, cvProfileId, "write");
  console.log(
    `e2e: seeded create-visit fixture — profile ${cvProfileId} (${CREATEVISIT_PROFILE}) #1099`
  );
}

// ── Profile-switch toaster spec isolation (#296 / PR #1110 shard-3 cascade) ────
// The profile-switch-toasts spec switches the ACTIVE PROFILE mid-test. Run on the
// shared admin storageState, a mid-switch failure on a degraded runner stranded the
// shared session on its fixture profile, and every LATER spec in that worker saw the
// wrong (empty) profile's data — 17 downstream specs failed as data-gated app shells
// (PR #1110 run 29829296858 shard 3). The fix moves the spec into its OWN cookie
// context with its OWN member login, so its switching can never touch the shared
// session. This dedicated member is granted TWO profiles, each carrying its own
// pre-existing TERMINAL document/import-job history — a done doc (→ "Extraction
// complete"), a failed doc (→ "Extraction unsuccessful"), and a ready import job
// (→ the "Extracted <summary>…" toast) — so switching between them exercises the
// silent-reseed on BOTH profiles. Seeded FIRST here so profile A sorts to the lower
// id (the login's default active profile on sign-in). Synthetic filenames/content
// only — no real PHI. Idempotent: clear this fixture's rows by name/summary first.
{
  const seedToasterHistory = (profileId: number, tag: string) => {
    db.prepare(
      `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN (?, ?)`
    ).run(profileId, `${tag}-labs.pdf`, `${tag}-broken.txt`);
    db.prepare(
      `DELETE FROM import_jobs WHERE profile_id = ? AND summary = ?`
    ).run(profileId, `${tag}: readings`);
    // A successfully-extracted document → the ExtractionToaster success toast.
    db.prepare(
      `INSERT INTO medical_documents
         (profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
          extraction_status, extracted_count, uploaded_at)
       VALUES (?, ?, '', 'application/pdf', 4096, 'Lab report',
               'done', 6, '2026-07-06 09:00:00')`
    ).run(profileId, `${tag}-labs.pdf`);
    // A rejected upload in a terminal 'failed' state → the error toast.
    db.prepare(
      `INSERT INTO medical_documents
         (profile_id, filename, stored_path, mime_type, size_bytes,
          extraction_status, extraction_error, uploaded_at)
       VALUES (?, ?, '', 'text/plain', 12,
               'failed', 'Unsupported file type.', '2026-07-06 08:30:00')`
    ).run(profileId, `${tag}-broken.txt`);
    // A ready import job → the ImportJobsToaster "Extracted <summary>…" toast.
    db.prepare(
      `INSERT INTO import_jobs
         (profile_id, type, status, summary, created_at, updated_at)
       VALUES (?, 'biomarkers', 'ready', ?, '2026-07-06 08:00:00', '2026-07-06 08:00:00')`
    ).run(profileId, `${tag}: readings`);
  };

  const toastAId = fixtureProfileId(TOAST_SWITCH_A_PROFILE);
  const toastBId = fixtureProfileId(TOAST_SWITCH_B_PROFILE);
  seedToasterHistory(toastAId, "e2e-toastA");
  seedToasterHistory(toastBId, "e2e-toastB");
  seedMemberLogin(E2E_LOGIN_TOASTS, toastAId, "read");
  seedMemberLogin(E2E_LOGIN_TOASTS, toastBId, "read");
  console.log(
    `e2e: seeded profile-switch toaster fixture — login ${E2E_LOGIN_TOASTS} → profiles ${toastAId} (${TOAST_SWITCH_A_PROFILE}) + ${toastBId} (${TOAST_SWITCH_B_PROFILE}) #296`
  );
}

// ── Provider-domain closeout fixtures (#1056/#1057/#1058/#1055) ────────────────
// On profile 1 (the admin's default active profile) so the provider-registry spec
// can drive both READ surfaces (grouped directory, specialty chip, "Practices at",
// archived disclosure) and the admin-only WRITE flows (archive round-trip, decline
// a suggestion). Idempotent: every provider is cleared by its dedup_key first, and
// the affiliation edge + encounters are rebuilt from the fresh ids. Synthetic names.
{
  const provKeys = [
    "e2e-prov-corabell",
    "e2e-prov-bellcardio",
    "e2e-prov-retired",
    "e2e-prov-samng",
    "e2e-prov-ngfp",
  ];
  const delProv = db.prepare(`DELETE FROM providers WHERE dedup_key = ?`);
  for (const k of provKeys) delProv.run(k);

  const insInd = db.prepare(
    `INSERT INTO providers (name, type, specialty_code, specialty, archived, dedup_key)
     VALUES (?, 'individual', ?, ?, ?, ?)`
  );
  const insOrg = db.prepare(
    `INSERT INTO providers (name, type, archived, dedup_key)
     VALUES (?, 'organization', ?, ?)`
  );
  const coraId = Number(
    insInd.run(
      "Dr. Cora Bell (e2e)",
      "207RC0000X",
      "Cardiology",
      0,
      "e2e-prov-corabell"
    ).lastInsertRowid
  );
  const bellCardioId = Number(
    insOrg.run("Bell Cardiology (e2e)", 0, "e2e-prov-bellcardio")
      .lastInsertRowid
  );
  // A seeded ARCHIVED provider for the archive→disclosure→unarchive round-trip.
  insOrg.run("Retired Clinic (e2e)", 1, "e2e-prov-retired");
  // A co-occurrence pair with NO edge → surfaces as a suggestion to accept/decline.
  const samId = Number(
    insInd.run("Dr. Sam Ng (e2e)", null, null, 0, "e2e-prov-samng")
      .lastInsertRowid
  );
  const ngfpId = Number(
    insOrg.run("Ng Family Practice (e2e)", 0, "e2e-prov-ngfp").lastInsertRowid
  );

  // The confirmed affiliation edge (Cora Bell practices at Bell Cardiology).
  db.prepare(
    `DELETE FROM provider_affiliations WHERE individual_id IN (?, ?) OR organization_id IN (?, ?)`
  ).run(coraId, samId, bellCardioId, ngfpId);
  db.prepare(
    `INSERT INTO provider_affiliations (individual_id, organization_id, status, source)
     VALUES (?, ?, 'linked', 'manual')`
  ).run(coraId, bellCardioId);

  // Encounters on profile 1 giving both pairs activity + co-occurrence. Clear the
  // fixture encounters first (by a reason marker) so a re-seed doesn't duplicate.
  db.prepare(
    `DELETE FROM encounters WHERE profile_id = ? AND reason = 'e2e provider fixture'`
  ).run(PROFILE_ID);
  const insEnc = db.prepare(
    `INSERT INTO encounters (profile_id, date, provider_id, location_provider_id, reason)
     VALUES (?, ?, ?, ?, 'e2e provider fixture')`
  );
  insEnc.run(PROFILE_ID, "2026-03-01", coraId, bellCardioId);
  insEnc.run(PROFILE_ID, "2026-03-02", samId, ngfpId);

  console.log(
    `e2e: seeded provider-domain closeout fixtures (#1055/#1056/#1057/#1058) on profile ${PROFILE_ID}`
  );
}

// ── Trends → Body mobile overhaul fixture (#1067 Phase 1) ─────────────────────
// A dedicated adult profile with a KNOWN, PARTIAL set of synced body metrics so
// the chart-jump chips + per-chart anchors are deterministic in the browser:
//   present → Weight/resting-HR (body-composition block), Steps, Sleep, HR (daily)
//   ABSENT  → hydration / BMR / calories / lean-mass / bone-mass / BMI / macros
// so the spec can assert BOTH that present metrics get a chip (and a `#id` anchor
// that lands on the card) AND that a chartless metric's chip is hidden. Read-only
// (spec navigates + scrolls only). Relative dates → never stale; UTC instants
// (the e2e default timezone) → deterministic regardless of host TZ. Idempotent:
// hard-clear this profile's fixture rows first.
{
  const tbId = fixtureProfileId(TRENDS_BODY_PROFILE);
  const tbToday = today(tbId);
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(tbId);
  db.prepare(
    `DELETE FROM metric_samples WHERE profile_id = ? AND metric IN ('steps', 'sleep_min')`
  ).run(tbId);
  db.prepare(`DELETE FROM hr_minutes WHERE profile_id = ?`).run(tbId);

  // Body-composition block: two weigh-ins with resting HR.
  const insBm = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr, notes)
     VALUES (?, ?, ?, ?, 'e2e:trends-body')`
  );
  insBm.run(tbId, shiftDateStr(tbToday, -7), 78.4, 58);
  insBm.run(tbId, shiftDateStr(tbToday, -1), 77.9, 56);

  // Steps (additive) — three recent days so the chart + chip render and are recent.
  const insSteps = db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health-connect', 'steps', ?, ?, ?, ?)`
  );
  for (const [ago, steps] of [
    [2, 8200],
    [1, 9100],
    [0, 7600],
  ] as const) {
    const day = shiftDateStr(tbToday, -ago);
    insSteps.run(tbId, day, `${day}T00:00:00Z`, `${day}T23:59:59Z`, steps);
  }

  // One sleep night ending today → the compact Sleep summary tile renders.
  const sleepPrev = shiftDateStr(tbToday, -1);
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 445)`
  ).run(tbId, tbToday, `${sleepPrev}T23:10:00Z`, `${tbToday}T06:35:00Z`);

  // One day of heart-rate minutes → the "Heart rate (daily avg)" chart renders.
  const insHrTb = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, ?, 6, 'health-connect')`
  );
  for (let m = 0; m < 20; m++) {
    const mm = String(m).padStart(2, "0");
    insHrTb.run(tbId, `${tbToday}T08:${mm}`, 62 + (m % 5));
  }

  seedMemberLogin(E2E_LOGIN_TRENDS_BODY, tbId, "read");
  console.log(
    `e2e: seeded Trends → Body mobile fixture — profile ${tbId} (${TRENDS_BODY_PROFILE}) (#1067)`
  );
}

// ── Coaching rest card: multi-signal + "Training anyway" (#1148 / #1150) ──────────
// A dedicated adult profile tripping TWO concurrent under-recovery signals so the
// dashboard coaching card leads with the salience-ordered primary (rest-sleep) AND
// shows the "Also: …" secondary line (rest-rhr, #1148), and the "Training anyway"
// acknowledgment (#1150) has a real rest rec to transform. Isolated from profile 1 so
// this spec's ack/snooze writes never race the neighbor coaching specs. Idempotent —
// clears its own fixture rows first. Synthetic values only; relative dates never stale.
{
  const rcId = fixtureProfileId(REST_CARD_PROFILE);
  const rcToday = today(rcId);
  const rcPrevNight = shiftDateStr(rcToday, -1);
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(rcId);
  db.prepare(
    `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min'`
  ).run(rcId);
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:rest-card-context'`
  ).run(rcId);

  // Signal 1 — a short overnight (300 min < the 6h floor) → rest-sleep fires.
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 300)`
  ).run(rcId, rcToday, `${rcPrevNight}T23:00:00Z`, `${rcToday}T04:00:00Z`);

  // Signal 2 — resting HR elevated today (62) over a ~54 baseline (prior days) →
  // rest-rhr fires with a fixed threshold (a flat baseline has zero spread).
  const insRcHr = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, notes)
     VALUES (?, ?, ?, 'e2e:rest-card')`
  );
  insRcHr.run(rcId, rcToday, 62);
  for (let d = 1; d <= 5; d++) insRcHr.run(rcId, shiftDateStr(rcToday, -d), 54);

  // Training context (one old strength day, well outside any streak/load window) so
  // the engine evaluates recovery at all — rest presupposes a training context.
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity, source, external_id)
     VALUES (?, ?, 'strength', 'Rest Card context lift', 40, 'hard', 'manual', 'e2e:rest-card-context')`
  ).run(rcId, shiftDateStr(rcToday, -10));

  seedMemberLogin(E2E_LOGIN_REST, rcId, "write");
  console.log(
    `e2e: seeded coaching rest-card fixture — profile ${rcId} (${REST_CARD_PROFILE}) (#1148/#1150)`
  );
}

// ── Suppressed-center fixture (#1151) ─────────────────────────────────────────
// A dedicated profile whose "Snoozed & dismissed" section spans all three
// classes: a CARE snooze (future appointment), a COACHING dismissal (a
// training-obs plateau key — no backing rows needed; the dismissal IS the fact),
// and a SUGGESTION dismissal (a med-bridge key resolved purely from its prefix —
// post-#1178/092 no backing medical_records 'prescription' row can exist, and a
// dismissal that outlived its record is a REAL current-state shape, #1232).
// Idempotent: the spec ALSO resets these suppression rows itself before each
// test (retries / --repeat-each), so this boot-time seed only guarantees the
// backing data + a first-run state. All synthetic.
{
  const scId = fixtureProfileId(SUPPRESSED_PROFILE);
  seedMemberLogin(E2E_LOGIN_SUPPRESSED, scId, "write");
  const scToday = today(scId);

  // Backing appointment (future, scheduled) — recreated each boot so its date
  // stays in the future relative to the frozen clock.
  db.prepare(
    `DELETE FROM appointments WHERE profile_id = ? AND title = 'E2E Suppressed Appointment'`
  ).run(scId);
  const scApptId = Number(
    db
      .prepare(
        `INSERT INTO appointments (profile_id, scheduled_at, title, status)
         VALUES (?, ?, 'E2E Suppressed Appointment', 'scheduled')`
      )
      .run(scId, `${shiftDateStr(scToday, 5)} 10:00`).lastInsertRowid
  );

  // The three suppression rows (the spec re-asserts these per test). The
  // med-bridge key needs no backing row — the section's resolver labels it from
  // the key alone (lib/suppression-display.ts), and Restore simply clears it.
  db.prepare(`DELETE FROM upcoming_dismissals WHERE profile_id = ?`).run(scId);
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until)
     VALUES (?, ?, ?)`
  ).run(scId, `appointment:${scApptId}`, shiftDateStr(scToday, 3));
  const scDismiss = db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
     VALUES (?, ?, datetime('now'))`
  );
  scDismiss.run(scId, "training-obs:plateau:e2e suppressed lift");
  scDismiss.run(scId, "med-bridge:e2e suppressed rx");

  console.log(
    `e2e: seeded suppressed-center fixture — profile ${scId} (${SUPPRESSED_PROFILE}), appointment ${scApptId} (#1151)`
  );
}

// #1119 — progress photos: a dedicated, initially PHOTO-LESS profile + write
// member. The spec itself uploads/deletes photos (and clears the table for this
// profile in beforeAll), so the seed only guarantees the login/profile exist —
// keeping the data-gated nav flip and the exact-count grid assertions isolated
// from profile 1 (whose sidebar order nav-consolidation.spec.ts pins verbatim).
{
  const photosId = fixtureProfileId(PROGRESS_PHOTOS_PROFILE);
  seedMemberLogin(E2E_LOGIN_PHOTOS, photosId, "write");
  console.log(
    `e2e: seeded progress-photos fixture — profile ${photosId} (${PROGRESS_PHOTOS_PROFILE}) (#1119)`
  );
}

// #1224 — video capture: a dedicated ADULT profile (birthdate so /training isn't
// age-gated) with ONE seeded strength activity the spec attaches a form-check clip
// to. The spec clears the profile's activity_videos / symptom_videos rows itself,
// so its clip counts stay isolated. Idempotent for a reused server.
{
  const videoId = fixtureProfileId(VIDEO_PROFILE);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1990-04-01')`
  ).run(videoId);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')`
  ).run(videoId);
  const hasActivity = db
    .prepare(
      `SELECT id FROM activities WHERE profile_id = ? AND title = 'Squat session (e2e)'`
    )
    .get(videoId) as { id: number } | undefined;
  if (!hasActivity) {
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, source)
         VALUES (?, ?, 'strength', 'Squat session (e2e)', 'manual')`
    ).run(videoId, today(videoId));
  }
  seedMemberLogin(E2E_LOGIN_VIDEO, videoId, "write");
  console.log(
    `e2e: seeded video-capture fixture — profile ${videoId} (${VIDEO_PROFILE}) (#1224)`
  );
}

// #1172 — the Open-Meteo weather/UV integration + two-sided UV-dose sun model. A
// dedicated adult profile seeded so the weather spec is fully isolated from profile
// 1: a coarse home location (New York; timezone matched so the local hour labels line
// up), Fitzpatrick skin type II, the weather connection ENABLED, an outdoor daytime
// activity TODAY (10:00–12:00, avg_temp_c present = the outdoor signal), and cached
// LIVE UV for that day+location — so /integrations/weather renders Connected and the
// timeline renders the live UV badge. All UV values are low-entropy synthetic.
{
  const wxId = fixtureProfileId(WEATHER_PROFILE);
  seedMemberLogin(E2E_LOGIN_WEATHER, wxId, "write");
  const wxTz = "America/New_York";
  const wxLat = 40.7;
  const wxLng = -74;
  // Home location + timezone + skin type (profile_settings key/value — no migration).
  const setPS = db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  );
  setPS.run(wxId, "home_lat", String(wxLat));
  setPS.run(wxId, "home_lng", String(wxLng));
  setPS.run(wxId, "timezone", wxTz);
  setPS.run(wxId, "skin_type", "2");
  // Today in the profile's timezone (YYYY-MM-DD).
  const wxToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: wxTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  // Enable the keyless weather connection (the enable flag the tick + grid read).
  upsertConnection(wxId, "weather", { status: "connected", config: null });
  // An outdoor daytime walk today, well inside the daylight window.
  db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, start_time, end_time, avg_temp_c)
     VALUES (?, ?, 'cardio', 'Lunch walk', '10:00', '12:00', 20)`
  ).run(wxId, wxToday);
  // Cached live UV (+ irradiance) for the location's hours that day — the values the
  // dose model crosses with the walk. High-ish UV so the badge is unmistakable; the
  // overexposure side needs the skin type above.
  const insUv = db.prepare(
    `INSERT INTO weather_uv_hours
       (lat, lng, hour_ts, uv_index, uv_index_clear_sky,
        shortwave_radiation, direct_radiation, diffuse_radiation, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open-meteo')
     ON CONFLICT(lat, lng, hour_ts) DO NOTHING`
  );
  for (const [hr, uv] of [
    ["10", 7],
    ["11", 8],
    ["12", 8],
  ] as [string, number][]) {
    insUv.run(wxLat, wxLng, `${wxToday}T${hr}:00`, uv, uv + 1, 600, 500, 100);
  }
  console.log(
    `e2e: seeded weather/UV fixture — profile ${wxId} (${WEATHER_PROFILE}), day ${wxToday} (#1172)`
  );
}

// ── Multi-profile viewing fixtures (issue #1096) ──────────────────────────────
// A dedicated member (E2E_LOGIN_MULTI) granted TWO dedicated profiles, both WRITE,
// each with one due-today supplement dose. The multi-view spec toggles the second
// profile into the view-set on /upcoming and confirms a CROSS-PROFILE dose — an
// isolated fixture so that persistent write never races the shared household specs.
{
  const multiOwnerId = fixtureProfileId(MULTI_OWNER_PROFILE);
  const multiSharedId = fixtureProfileId(MULTI_SHARED_PROFILE);
  const seedMultiDose = (profileId: number, name: string): void => {
    if (
      !db
        .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
        .get(profileId, name)
    ) {
      const supp = db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, condition, priority, active, source)
           VALUES (?, ?, 'daily', 'high', 1, 'manual')`
        )
        .run(profileId, name);
      // One daily dose, no taken-log for today → surfaces as a due dose on Upcoming.
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1000 IU', '08:00', 'any', 0)`
      ).run(Number(supp.lastInsertRowid));
    }
  };
  seedMultiDose(multiOwnerId, MULTI_OWNER_DOSE);
  seedMultiDose(multiSharedId, MULTI_SHARED_DOSE);
  // Tier-1 multi-view record-list fixtures (#1328): a condition, allergy, and health
  // goal per profile so the /records + /results record lists render one row per profile.
  const seedMultiRecords = (profileId: number, tag: string): void => {
    if (
      !db
        .prepare("SELECT 1 FROM conditions WHERE profile_id = ? AND name = ?")
        .get(profileId, tag)
    ) {
      db.prepare(
        "INSERT INTO conditions (profile_id, name, status, source) VALUES (?, ?, 'active', NULL)"
      ).run(profileId, tag);
    }
  };
  const seedMultiAllergy = (profileId: number, substance: string): void => {
    if (
      !db
        .prepare(
          "SELECT 1 FROM allergies WHERE profile_id = ? AND substance = ?"
        )
        .get(profileId, substance)
    ) {
      db.prepare(
        "INSERT INTO allergies (profile_id, substance, status, source) VALUES (?, ?, 'active', NULL)"
      ).run(profileId, substance);
    }
  };
  const seedMultiGoal = (profileId: number, description: string): void => {
    if (
      !db
        .prepare(
          "SELECT 1 FROM care_goals WHERE profile_id = ? AND description = ?"
        )
        .get(profileId, description)
    ) {
      db.prepare(
        "INSERT INTO care_goals (profile_id, description, source) VALUES (?, ?, NULL)"
      ).run(profileId, description);
    }
  };
  seedMultiRecords(multiOwnerId, MULTI_OWNER_CONDITION);
  seedMultiRecords(multiSharedId, MULTI_SHARED_CONDITION);
  seedMultiAllergy(multiOwnerId, MULTI_OWNER_ALLERGY);
  seedMultiAllergy(multiSharedId, MULTI_SHARED_ALLERGY);
  seedMultiGoal(multiOwnerId, MULTI_OWNER_GOAL);
  seedMultiGoal(multiSharedId, MULTI_SHARED_GOAL);
  // Multi-view Training Journal (#1330): manual cardio activities so /training's Log
  // feed renders a merged, subject-stamped card feed. Idempotent per (profile, title).
  const seedMultiActivity = (profileId: number, title: string): void => {
    if (
      !db
        .prepare(
          "SELECT 1 FROM activities WHERE profile_id = ? AND date = ? AND title = ?"
        )
        .get(profileId, MULTI_ACTIVITY_DATE, title)
    ) {
      db.prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'cardio', ?, 30)`
      ).run(profileId, MULTI_ACTIVITY_DATE, title);
    }
  };
  // Owner: two same-day rows (a same-profile merge candidate for each other).
  seedMultiActivity(multiOwnerId, MULTI_OWNER_ACTIVITY_A);
  seedMultiActivity(multiOwnerId, MULTI_OWNER_ACTIVITY_B);
  // Shared: one same-day row — a cross-profile card (subject chip), never an owner
  // card's merge sibling.
  seedMultiActivity(multiSharedId, MULTI_SHARED_ACTIVITY);
  // Tier-1b bespoke-list multi-view fixtures (#1359): a past visit (encounter) + a
  // recorded immunization dose per profile, so the Visits "Past" list and the
  // Immunizations "All recorded doses" list each render one row per profile.
  const seedMultiVisit = (profileId: number, type: string): void => {
    if (
      !db
        .prepare("SELECT 1 FROM encounters WHERE profile_id = ? AND type = ?")
        .get(profileId, type)
    ) {
      db.prepare(
        "INSERT INTO encounters (profile_id, date, type, source) VALUES (?, '2026-02-15', ?, NULL)"
      ).run(profileId, type);
    }
  };
  const seedMultiVaccine = (profileId: number, vaccine: string): void => {
    if (
      !db
        .prepare(
          "SELECT 1 FROM immunizations WHERE profile_id = ? AND vaccine = ?"
        )
        .get(profileId, vaccine)
    ) {
      db.prepare(
        "INSERT INTO immunizations (profile_id, date, vaccine, source) VALUES (?, '2026-01-20', ?, NULL)"
      ).run(profileId, vaccine);
    }
  };
  seedMultiVisit(multiOwnerId, MULTI_OWNER_VISIT);
  seedMultiVisit(multiSharedId, MULTI_SHARED_VISIT);
  seedMultiVaccine(multiOwnerId, MULTI_OWNER_VACCINE);
  seedMultiVaccine(multiSharedId, MULTI_SHARED_VACCINE);
  const multiLoginId = seedMemberLogin(E2E_LOGIN_MULTI, multiOwnerId, "write");
  grantProfile(multiLoginId, multiSharedId, "write");
  console.log(
    `e2e: seeded multi-view fixture — ${E2E_LOGIN_MULTI} granted ${MULTI_OWNER_PROFILE} (${multiOwnerId}) + ${MULTI_SHARED_PROFILE} (${multiSharedId})`
  );
}

// ── Multi-view Medications regimen boards (issue #1373 Part 1) ─────────────────
// E2E_LOGIN_MVMEDS: a base profile (WRITE, acting) + a second profile READ-ONLY, each
// with one due-today SCHEDULED medication (kind='medication', a daily dose, no taken
// log) so both boards render Today content and both feed the leading strip. The self
// profile is created FIRST so it holds the lower id → the login lands acting as it.
{
  const mvSelfId = fixtureProfileId(MVMEDS_SELF_PROFILE);
  const mvRoId = fixtureProfileId(MVMEDS_RO_PROFILE);
  const seedBoardMed = (profileId: number, name: string): void => {
    if (
      !db
        .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
        .get(profileId, name)
    ) {
      const med = db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, kind, condition, priority, active, as_needed, source)
           VALUES (?, ?, 'medication', 'daily', 'high', 1, 0, 'manual')`
        )
        .run(profileId, name);
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 tablet', '08:00', 'any', 0)`
      ).run(Number(med.lastInsertRowid));
    }
  };
  seedBoardMed(mvSelfId, MVMEDS_SELF_MED);
  seedBoardMed(mvRoId, MVMEDS_RO_MED);
  const mvLoginId = seedMemberLogin(E2E_LOGIN_MVMEDS, mvSelfId, "write");
  grantProfile(mvLoginId, mvRoId, "read");
  console.log(
    `e2e: seeded medications-board fixture — ${E2E_LOGIN_MVMEDS} granted ${MVMEDS_SELF_PROFILE} (${mvSelfId}, write) + ${MVMEDS_RO_PROFILE} (${mvRoId}, read)`
  );
}

// ── Multi-view Timeline: divergent-timezone day boundary (issue #1329) ─────────
// A dedicated member (E2E_LOGIN_TL_MULTI) granted TWO adult profiles WRITE, each with a
// per-profile timezone ~25h apart, so the SAME frozen instant is a DIFFERENT local
// calendar date for each. Each profile carries ONE activity dated on ITS OWN today
// (computed in its zone from the SAME clock the app freezes), so the merged multi-view
// Timeline renders two separate "Today" day-groups with honest per-member divergence
// badges. The timeline spec toggles WEST into the view-set and asserts both members'
// today-badges + the subject chip on the non-acting row; single view stays unchanged.
{
  const eastId = fixtureProfileId(TL_EAST_PROFILE);
  const westId = fixtureProfileId(TL_WEST_PROFILE);
  const setTz = db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  );
  setTz.run(eastId, TL_EAST_TZ);
  setTz.run(westId, TL_WEST_TZ);
  // The frozen instant the app uses (ALLOS_TEST_NOW when set, else real now), so the
  // seeded activity date == the app's today(profileId) at request time.
  const seedNow = process.env.ALLOS_TEST_NOW
    ? new Date(process.env.ALLOS_TEST_NOW)
    : new Date();
  const todayIn = (tz: string): string =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(seedNow);
  const seedTlActivity = (
    profileId: number,
    tz: string,
    title: string
  ): void => {
    if (
      !db
        .prepare("SELECT 1 FROM activities WHERE profile_id = ? AND title = ?")
        .get(profileId, title)
    ) {
      db.prepare(
        `INSERT INTO activities (profile_id, date, type, title)
         VALUES (?, ?, 'cardio', ?)`
      ).run(profileId, todayIn(tz), title);
    }
  };
  seedTlActivity(eastId, TL_EAST_TZ, TL_EAST_ACTIVITY);
  seedTlActivity(westId, TL_WEST_TZ, TL_WEST_ACTIVITY);
  const tlLoginId = seedMemberLogin(E2E_LOGIN_TL_MULTI, eastId, "write");
  grantProfile(tlLoginId, westId, "write");
  console.log(
    `e2e: seeded timeline divergent-tz fixture — ${E2E_LOGIN_TL_MULTI} granted ${TL_EAST_PROFILE} (${eastId}, ${todayIn(TL_EAST_TZ)}) + ${TL_WEST_PROFILE} (${westId}, ${todayIn(TL_WEST_TZ)})`
  );
}

// ── Own-profile / not-self write affordances fixture (issue #1013) ────────────
// A dedicated member (E2E_LOGIN_OWN) granted TWO adult profiles WRITE, with its
// own-profile pointing at the FIRST (SELF). Each carries a due-today dose (household
// dose-confirm buttons) + one weigh-in (the dashboard weight widget renders). The
// spec asserts the not-self naming on the OTHER profile (never the login's own).
{
  const ownSelfId = fixtureProfileId(OWN_SELF_PROFILE);
  const ownOtherId = fixtureProfileId(OWN_OTHER_PROFILE);
  const seedOwnDose = (profileId: number, name: string): void => {
    if (
      !db
        .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
        .get(profileId, name)
    ) {
      const supp = db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, condition, priority, active, source)
           VALUES (?, ?, 'daily', 'high', 1, 'manual')`
        )
        .run(profileId, name);
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1000 IU', '08:00', 'any', 0)`
      ).run(Number(supp.lastInsertRowid));
    }
  };
  const seedOwnWeigh = (profileId: number): void => {
    if (
      !db
        .prepare(
          "SELECT 1 FROM body_metrics WHERE profile_id = ? AND notes = 'e2e:own-seed'"
        )
        .get(profileId)
    ) {
      db.prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg, notes)
         VALUES (?, date('now'), 72.0, 'e2e:own-seed')`
      ).run(profileId);
    }
  };
  seedOwnDose(ownSelfId, OWN_SELF_DOSE);
  seedOwnDose(ownOtherId, OWN_OTHER_DOSE);
  seedOwnWeigh(ownSelfId);
  seedOwnWeigh(ownOtherId);
  const ownLoginId = seedMemberLogin(E2E_LOGIN_OWN, ownSelfId, "write");
  grantProfile(ownLoginId, ownOtherId, "write");
  // Declare SELF as the login's own-profile (#1013): the association, not a grant.
  db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
    ownSelfId,
    ownLoginId
  );
  console.log(
    `e2e: seeded own-profile fixture — ${E2E_LOGIN_OWN} own=${OWN_SELF_PROFILE} (${ownSelfId}), other=${OWN_OTHER_PROFILE} (${ownOtherId})`
  );
}

// ── Situation-window analytics fixture (#1297) ────────────────────────────────
// A dedicated adult profile with a DECLARED "Travel" transition window (start day-14 →
// stop day-9, so during = [day-14, day-10], baseline = [day-19, day-15]) carrying real
// weight + resting-HR readings on the during AND baseline days, so Trends → Insights renders
// the pooled "Situation impact" card for Travel. A one-day "High stress" toggle has too
// little windowed history to render (the absent-pillar negative case). Read-only in the
// spec, so the pooled deltas stay stable under --repeat-each. Idempotent; synthetic only.
{
  const siId = fixtureProfileId(SITUATION_IMPACT_PROFILE);
  const siToday = today(siId);
  db.prepare(
    `DELETE FROM body_metrics WHERE profile_id = ? AND notes = 'e2e:sit-impact'`
  ).run(siId);

  const travelStart = shiftDateStr(siToday, -14);
  const travelStop = shiftDateStr(siToday, -9);
  const stressStart = shiftDateStr(siToday, -3);
  const stressStop = shiftDateStr(siToday, -2);
  const events = [
    ...diffSituations([], ["Travel"], travelStart),
    ...diffSituations(["Travel"], [], travelStop),
    ...diffSituations([], ["High stress"], stressStart),
    ...diffSituations(["High stress"], [], stressStop),
  ];
  setProfileSetting(
    siId,
    "situation_events",
    serializeSituationEvents([], events)
  );

  const insSi = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr, notes)
     VALUES (?, ?, ?, ?, 'e2e:sit-impact')`
  );
  // Baseline [day-19, day-15]: weight 80.0, resting HR 50. During [day-14, day-10]: weight
  // 80.8 (+0.8 kg), resting HR 56 (+6 bpm — "worse", lower_better). Enough on each side to
  // clear the pooled 3-sample floor.
  for (let d = -19; d <= -15; d++)
    insSi.run(siId, shiftDateStr(siToday, d), 80.0, 50);
  for (let d = -14; d <= -10; d++)
    insSi.run(siId, shiftDateStr(siToday, d), 80.8, 56);

  seedMemberLogin(E2E_LOGIN_SITIMPACT, siId, "read");
  console.log(
    `e2e: seeded situation-impact fixture — profile ${siId} (${SITUATION_IMPACT_PROFILE}) (#1297)`
  );
}

// ── Well-day symptom + reported-burden coaching tilt fixture (#1300) ───────────
// A dedicated adult WELL profile (no illness, no rest signals) with a small strength history
// so coaching has content — the spec logs a severe symptom from the check-in Report entry
// and asserts the coaching card tilts toward an easier session naming the symptom, with the
// suggest-only illness bridge present but not required. Isolated so the symptom write never
// perturbs a neighbor coaching fixture. Idempotent; synthetic only.
{
  const wsId = fixtureProfileId(WELL_SYMPTOM_PROFILE);
  const wsToday = today(wsId);
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:well-symptom'`
  ).run(wsId);
  db.prepare(`DELETE FROM symptom_logs WHERE profile_id = ?`).run(wsId);
  db.prepare(`DELETE FROM mood_logs WHERE profile_id = ?`).run(wsId);

  // One old strength day, well outside any streak/load window, so the engine evaluates
  // recovery at all (rest presupposes a training context) but no schedule-based rest fires.
  const wsAid = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity, source, external_id)
         VALUES (?, ?, 'strength', 'Well Symptom context lift', 40, 'hard', 'manual', 'e2e:well-symptom')`
      )
      .run(wsId, shiftDateStr(wsToday, -10)).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, 'Back Squat', 1, 100, 5)`
  ).run(wsAid);

  seedMemberLogin(E2E_LOGIN_WELLSYM, wsId, "write");
  console.log(
    `e2e: seeded well-symptom fixture — profile ${wsId} (${WELL_SYMPTOM_PROFILE}) (#1300)`
  );
}
