// Data-presence probe for the physique progress-photo domain (#1119 / #3284).
//
// It lives HERE, and not beside the write core in lib/progress-photo-write.ts,
// because of who asks it: getNavRelevance runs on the app layout path for every
// render, and that module reaches lib/photo/store — and so node:fs — to do its own
// job. Answering "does this profile have any progress photo?" must not drag the
// filesystem photo store onto the layout's module graph. The sibling settles the
// placement too: `progress:` sits one line from `sleep: hasSleepData(profileId)`,
// which lives in lib/queries/sleep.ts.
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
