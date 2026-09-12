import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { createLogger } from "../../log";
import { adoptWearableBreathingRates } from "../../breathing-rate-db";
import { deleteRowsWithCascade } from "../cascade-delete";

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
// three kinds it DECLINES - a spot reading with no session around it, a row carrying a
// #1404 correction lineage, and a hand-corrected row whose night already stated a
// number - so a replay over an at-rest database moves nothing. Each of the three is
// declined by the same test on the second pass as on the first, which is why the
// replay is a no-op rather than a second, different answer. The DB tier replays
// migrations, so this is a property it is exercised for rather than one that is merely
// claimed.
//
// -- THE DELETE, AND WHAT POINTS AT WHAT IT DELETES ---------------------------------
//
// THE ROW REMOVAL RUNS THROUGH `deleteRowsWithCascade`, which is what
// lib/__db_tests__/migration-child-links.test.ts asks of a row-deleting migration
// (#2680). It is not a formality here: this file applies under `foreign_keys = OFF`
// (runner.ts, issue #95), where SQLite performs NO cascade at all, so a bare
// `DELETE FROM medical_records` would leave every child row pointing at a row that is
// gone - a dangling reference `PRAGMA foreign_key_check` reports and the runtime delete
// would never have produced. The helper walks the inbound links out of
// `PRAGMA foreign_key_list` at apply time and removes what the runtime would have
// removed, so the migration's delete and the ingest's delete leave the same graph.
//
// AND IT IS HANDED ROWS THAT HAVE NO CHILDREN TO CASCADE. An earlier draft of this
// header claimed "nothing else references these rows" and it was FALSE:
// `medical_record_revisions.record_id` cascades on `medical_records(id)` and is written
// by the ingest itself (`upsertVitals` -> `insertObservationRevision`) whenever a
// re-send supersedes a stored value - which a rolling 48-hour Health Connect window
// does routinely. `adoptWearableBreathingRates` now excludes a row carrying one from
// its candidate set entirely (see its header): the reading and its #1404 lineage stay
// exactly where they are rather than being orphaned here or destroyed at runtime. The
// helper above is therefore the guard for every OTHER inbound link - follow-up labs,
// instrument responses, the lab lifecycle, medication links, preventive decisions - all
// of which are document- and lab-driven and none of which can name a device vital.
//
// THE #133 EDIT LOCK IS HONOURED ON BOTH BRANCHES. A hand-corrected observation is
// elected ahead of the vendor's later re-stamp and arrives in `metric_samples` with
// `edited = 1`, so the next push does not re-clobber it now that it lives in the other
// store - and a locked row the night did NOT adopt is left in `medical_records` with
// its value and its note, never silently dropped.
const log = createLogger("migration:breathing-rate-sleep-samples");

export function up(db: Database.Database): void {
  const { adopted, removed } = adoptWearableBreathingRates(
    db,
    undefined,
    (rows) => {
      deleteRowsWithCascade(
        db,
        "medical_records",
        rows.map((row) => row.id)
      );
    }
  );
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
