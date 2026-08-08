// The shared, auth-blind, id-keyed write core for ANSWERING the post-workout type ask
// (issue #2272). profileId-first, no lib/auth import — the calling Server Action /
// Telegram callback handler owns the auth and cross-profile gate; every statement is
// profile-scoped.
//
// WHAT THIS IS. An imported session whose source declined to classify it is stored as
// `unclassified` — a stated absence, not a category. The post-workout recap asks the
// one person who actually knows, ONCE, with three inline buttons. Detection SUGGESTS;
// the user's tap is the WRITE (#1670). Nothing in the app classifies an unclassified
// row on its own, and no answer is remembered as a rule for future sessions: a
// per-profile inference rule is a second engine and a separate decision, and a wrong
// remembered rule would silently mislabel every session after it.
//
// COMPARE-AND-SWAP, not a read-then-write. The guard is in the UPDATE's own WHERE
// (`type = 'unclassified'`), so the answer can only ever consume the absence it was
// offered for. A keyboard that has been sitting in a chat is stale by nature: its row
// may have been classified in the app since, or absorbed by the duplicate auto-merge
// (#2271) and deleted outright. Both answer honestly through the typed outcome rather
// than confirming a write that did not happen.
//
// THE EDIT LOCK IS PART OF THE WRITE. `activities` is re-ingested on the rolling
// re-sync window, and that UPDATE writes `type` — so an answer that did not also set
// `edited = 1` would be silently reverted to `unclassified` by the next sync.
// `isEditLocked(edited)` is the ONE thing standing between a hand correction and the
// importer, and this is a hand correction (see lib/integrations/normalize.ts).
//
// Not a STATEFUL_WRITE_TABLES entry: `activities.type` is an ordinary column written
// by the activity form and by every importer, so registering the table would gate
// dozens of legitimate plain writes. What this core owns is the ASK's answer — the
// one-tap affordance over an absence — and it carries the typed refusals that gate
// exists for.

import { db, writeTx } from "./db";
import { sqlNow } from "./clock";

// The three answers the ask offers. NOT the full ActivityType set: `recovery` has its
// own surface, and `unclassified` is the question, never an answer to it.
export type ClassifiableActivityType = "strength" | "cardio" | "sport";

export type ClassifyActivityTypeOutcome =
  | { kind: "classified"; activityId: number; type: ClassifiableActivityType }
  // The row exists but is no longer unclassified — answered in the app, or by an
  // earlier tap on this same keyboard.
  | { kind: "already-classified"; activityId: number; type: string }
  // No such row for this profile: deleted, or absorbed by the duplicate auto-merge.
  | { kind: "not-found" };

/**
 * Answer the type ask for ONE activity. Writes only when the row is still
 * `unclassified`; every other state is a typed refusal the caller must render.
 */
export function classifyActivityType(
  profileId: number,
  activityId: number,
  type: ClassifiableActivityType
): ClassifyActivityTypeOutcome {
  return writeTx(() => {
    const changed = db
      .prepare(
        `UPDATE activities
            SET type = ?, edited = 1, updated_at = ?
          WHERE id = ? AND profile_id = ? AND type = 'unclassified'`
      )
      .run(type, sqlNow(), activityId, profileId).changes;
    if (changed > 0) return { kind: "classified", activityId, type };
    const row = db
      .prepare("SELECT type FROM activities WHERE id = ? AND profile_id = ?")
      .get(activityId, profileId) as { type: string } | undefined;
    if (!row) return { kind: "not-found" };
    return { kind: "already-classified", activityId, type: row.type };
  });
}
