import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3058 — the durable post-workout dispatch claim.
//
// WHY A TABLE. "One post-workout contact per session" was held by an in-process
// promise chain (#3021) plus a read-then-act marker check, and two callers sit
// outside both: another process (a web-process timer racing the notify tick),
// and the shared core called directly while a queued run is mid-send. The owner
// ruling (2026-08-18) makes the property DATABASE-enforced: the in-process queue
// stays a latency/order optimization, correctness may not depend on it.
//
// THE SHAPE. One row per announcement identity — the activity id, the same key
// the `notify_last_post_workout_<activityId>` one-shot marker uses. The PRIMARY
// KEY (profile_id, activity_id) is the election: exactly one caller's `pending`
// INSERT succeeds across any number of processes, everyone else gets a typed
// already-claimed/already-sent outcome and does not dispatch. `state` is the
// two-step lifecycle ('pending' while the winner is on the network, 'sent'
// forever after any channel succeeds); `claimed_at` is the lease stamp that
// makes a crashed pending claim retryable — only after the lease, which is
// asserted longer than the #3057 shared dispatch deadline
// (lib/notifications/post-workout-claim.ts owns the constant and the lifecycle).
//
// `activity_id` carries NO foreign key, deliberately — the same posture as the
// marker it hardens. A merge destroys and recreates activity identity inside an
// ingest transaction, and a claim row must record what was SENT for an id, not
// track the row's survival: AUTOINCREMENT ids never recycle (#203), so a claim
// for a merged-away row is an inert fact, and the #2570 marker fold remains the
// thing that carries "already announced" onto a merge's keeper. An FK cascade
// would silently erase the sent record mid-merge instead.
//
// CLEANUP CLASS (#203): grows one tiny row per ANNOUNCED activity — the same
// growth rate as the marker rows in profile_settings, which the same ruling
// accepts as harmless dead rows (ids never recycle, so a stale row can never
// suppress another session). Profile deletion clears it by profile_id via
// OWNED_TABLES; released claims (total failure) delete their own row.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notify_post_workout_claims (
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      activity_id INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'sent')),
      claimed_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, activity_id)
    )
  `);
}

export const migration: Migration = {
  name: "20260819-post-workout-dispatch-claims",
  up,
};
