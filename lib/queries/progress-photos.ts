// Data-presence probe for the physique progress-photo domain (#1119 / #3284).
//
// It lives HERE, and not beside the write core in lib/progress-photo-write.ts, on
// two grounds plus one correction. getNavRelevance is a read/gather on the app
// layout path and progress-photo-write is a WRITE core, so a gather importing it is
// the wrong direction whatever the module graph already holds; and `progress:` sits
// one line from `sleep: hasSleepData(profileId)`, which lives in
// lib/queries/sleep.ts, so nav-relevance's data probes already have a home.
//
// The correction, kept because the next reader will otherwise re-derive it: this
// does NOT keep lib/photo/store off the layout path. That is already reachable
// there through lib/db.ts -> lib/migrations/boot-tasks.ts ->
// lib/photo/metadata-backfill.ts — pre-existing, and not this module's to fix.
// What the placement avoids is a SECOND, DIRECT edge from the gather into the
// write core.
//
// ONE definition, two readers: the #1119 nav gate and the #3284 in-domain door on
// Trends → Body. A second `SELECT 1` in either place would be a second opinion
// about one fact.

import { hoistedStatement } from "../db";

// Hoisted on the same argument as nav-relevance's neighbouring probes: a broadly
// shared helper on the layout path is the hot shape lib/queries/AGENTS.md names.
const PROGRESS_PHOTO_ROWS = hoistedStatement(
  `SELECT 1 FROM progress_photos WHERE profile_id = ? LIMIT 1`
);

export function hasProgressPhotos(profileId: number): boolean {
  return PROGRESS_PHOTO_ROWS.get(profileId) != null;
}
