import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { createLogger } from "../../log";
import { adoptWearableBreathingRates } from "../../breathing-rate-db";

// Issue #5409 (owner ruling, 2026-09-05): the wearable breathing rates already stored
// as `medical_records` vitals become the sleep-window samples they always were.
//
// WHAT WENT WRONG. Fitbit computes ONE breathing rate per sleep log and re-publishes it
// with a new stamp whenever it extends the log. The Health Connect parser keyed the
// observation on that stamp, so every re-stamp was a new row: on the record that raised
// this, six of the last forty-five nights carried two or three "Respiratory Rate"
// results for one night, and the day's record rendered them in the "Vital signs
// results" fold as three lab results. Fitbit Takeout's `daily_respiratory_rate` is the
// same nightly number labelled by day, filed the same way.
//
// WHAT THIS DOES. Exactly what the ingest now does on every push, run once over
// history: `adoptWearableBreathingRates` (lib/breathing-rate-db.ts). There is no second
// rule here to keep in step with the live one - the migration IS that function, with no
// profile filter. A night's several stamps collapse to the LATEST; a night with one
// stamp is one row either way; a night that already holds a sample keeps its value and
// only loses the stale observations.
//
// -- THE ROWS IT MUST NOT TOUCH, AND HOW IT KNOWS ----------------------------------
//
// THE SOURCE DECIDES, NOT THE ANALYTE NAME (the owner's words). A `Respiratory Rate`
// row written by hand or extracted from a document is a CLINICAL vital: a spot count
// taken while awake, judged at 12-20 against LOINC 9279-1, and it stays exactly where
// it is with its flag, its provider and its document link. The candidate clause names
// the two wearable integrations explicitly - never a prefix test, never "not manual" -
// so a clinical row is not merely left unmoved, it is never read. A db-tier test puts a
// manual row on the same night as a wearable one and pins that it survives byte for
// byte while its neighbour moves.
//
// A WEARABLE SPOT READING IS ALSO LEFT ALONE. A stamped reading with no sleep session
// around it is a spot reading and stays an observation - the same answer the parser
// gives it today. Only a reading the store can place inside a night moves.
//
// -- WHY IT IS SAFE TO RUN, AND TO RUN AGAIN ---------------------------------------
//
// IDEMPOTENT. After it runs, the only wearable `Respiratory Rate` rows left are the
// spot readings it declines, so a replay over an at-rest database moves nothing. The
// DB tier replays migrations, so this is a property it is exercised for rather than
// one that is merely claimed.
//
// NOTHING ELSE REFERENCES THESE ROWS. The tables that carry a
// `REFERENCES medical_records(id)` link - follow-up labs, instrument responses, the lab
// lifecycle, medication links, preventive decisions - are all document- and lab-driven
// and none of them can name a device vital: a wearable row has no document, no
// provider, and no lab lifecycle. The delete therefore strands nothing.
//
// THE #133 EDIT LOCK TRAVELS. A hand-corrected observation arrives in `metric_samples`
// with `edited = 1`, so the next push does not re-clobber the value now that it lives
// in the other store.
const log = createLogger("migration:breathing-rate-sleep-samples");

export function up(db: Database.Database): void {
  const { adopted, removed } = adoptWearableBreathingRates(db);
  if (adopted > 0 || removed > 0)
    log.info("wearable breathing rates moved to sleep-window samples", {
      adopted,
      removed,
    });
}

export const migration: Migration = {
  name: "20260911-breathing-rate-sleep-samples",
  up,
};
