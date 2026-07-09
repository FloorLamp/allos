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

console.log("e2e: seeded integration_sync_events (strava currently failing)");
