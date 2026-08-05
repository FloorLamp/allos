"use server";
import { requireSession, requireWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "@/app/(app)/gate-item";

import { revalidatePath } from "next/cache";
import { db, today, writeTx } from "@/lib/db";
import { queuePostWorkoutDispatch } from "@/lib/notifications/post-workout-queue";
import { type JournalFeedPage } from "@/lib/journal-feed";
import { normalizeJournalFilters } from "@/lib/journal-filters";
import { resolveJournalFeed } from "./journal-feed-resolve";
import { captureDelete } from "@/lib/undo-delete-db";
import {
  writeActivityFold,
  snapshotKeeperFold,
  dropSetIds,
} from "@/lib/merge-activity";
import { recordPairDecision, cleanupOrphanPrDismissals } from "@/lib/queries";
import {
  ACTIVITY_DOMAIN,
  activityToken,
  pairSignature,
} from "@/lib/import-review/detect";
import { parseOverrideChoices } from "@/lib/import-review/conflicts";
import type { ActivityType, SaveActivityOutcome } from "@/lib/types";
import { getUnitPrefs, type WeightUnit } from "@/lib/settings";
import { toKg, submittedWeightUnit } from "@/lib/units";
import { saveActivityCore } from "@/lib/activity-write";
import {
  finishWorkoutSession,
  type FinishWorkoutOutcome,
} from "@/lib/workout-finish";
import { isRealIsoDate } from "@/lib/date";
import { isTrainingRestricted, isActivityTypeAllowed } from "@/lib/age-gate";

// Re-validate every surface that reads activity-derived data after a create/edit/
// merge/delete: the Journal feed on /training, the /trends fitness-volume chart +
// workout heatmap (issue #333), the dashboard rollups, and every ride detail whose
// summary/comparison/history may have changed. Kept in one place so the next
// activity-reading surface is added once, not in each mutation.
function revalidateActivitySurfaces() {
  revalidatePath("/training");
  revalidatePath("/training/rides/[id]", "page");
  revalidatePath("/trends");
  revalidatePath("/");
}

// Create a new activity, or update an existing one when `id` is present. Returns
// a typed SaveActivityOutcome (issue #332): a validation or ownership failure must
// reach the auto-saving form as an explicit `{ ok: false }` — never `undefined`,
// which the client read as success and confirmed with "Saved ✓" while nothing
// persisted (silently losing the edit).
export async function saveActivity(
  formData: FormData
): Promise<SaveActivityOutcome> {
  // Multi-view (#1330): an EDIT card carries its subject's `profile_id`, so
  // gateItemProfile() → requireProfileWriteAccess targets (and write-gates) the
  // SUBJECT's profile — a read-only-granted / ungranted member is bounced. A CREATE
  // (no profile_id) falls back to requireWriteAccess() on the acting profile, so a new
  // activity always lands on the acting profile. `login` (for the viewer's unit prefs)
  // is the acting login regardless. Everything below keys on the resolved target.
  const { login } = await requireSession();
  const targetProfileId = await gateItemProfile(formData);
  // The whole validate-and-persist path lives in the auth-blind lib core
  // (saveActivityCore, #1596) — the SAME implementation the offline replay runs,
  // so a queued gym-floor session lands byte-for-byte like a live save. This
  // action owns only the gate above, the viewer's unit-pref fallback (#630 — used
  // when the form didn't stamp the captured unit), and the revalidation below.
  const outcome = saveActivityCore(
    targetProfileId,
    formData,
    getUnitPrefs(login.id)
  );
  if (!outcome.ok) return outcome;

  revalidateActivitySurfaces();
  return outcome;
}

// Headless "Finish workout" (#1124/#1205, #221): stamp end = now on a live draft
// through the SHARED finishWorkoutSession core — the request-path sibling of the
// notification-finish (which calls the same core from the notify process). Stamping a
// today-session's end arms the ~60s post-workout dose dispatch, exactly like a form
// save does, so an at-app finish still delivers due post-workout doses. The auth +
// cross-profile gate lives HERE (requireWriteAccess); the lib core is auth-blind.
export async function finishWorkout(
  activityId: number
): Promise<FinishWorkoutOutcome> {
  const { profile } = await requireWriteAccess();
  if (!Number.isInteger(activityId) || activityId <= 0)
    return { kind: "not-found" };
  const outcome = finishWorkoutSession(profile.id, activityId);
  if (outcome.kind === "finished") {
    queuePostWorkoutDispatch(profile.id, activityId);
    revalidateActivitySurfaces();
  }
  return outcome;
}

// Record the user's bodyweight (entered in their preferred unit) as a body-metrics
// entry, so bodyweight lifts can fold it into volume / strength stats. Called from
// the activity form when a bodyweight exercise is logged with no weight on record.
export async function logBodyweight(
  weight: number,
  date: string,
  // The unit the value was captured in (issue #630) — honored over the login's
  // current stored pref so an inline bodyweight log converts with the render-time
  // unit. Falls back to the stored pref when the caller doesn't pass one.
  weightUnit?: WeightUnit
) {
  const { login, profile } = await requireWriteAccess();
  const d = date.trim();
  if (!Number.isFinite(weight) || weight <= 0 || !d) return;
  const unit = submittedWeightUnit(
    weightUnit,
    getUnitPrefs(login.id).weightUnit
  );
  db.prepare(
    `INSERT INTO body_metrics (date, weight_kg, source, profile_id) VALUES (?,?,?,?)`
  ).run(d, toKg(weight, unit), "manual", profile.id);
  // A bodyweight entry feeds bodyweight-lift volume/strength, so it refreshes the
  // same fitness surfaces an activity write does (plus /trends body charts).
  revalidateActivitySurfaces();
}

// MANUAL pair-merge from the Journal (issue #64): the user picks two activities of
// the SAME day and explicitly merges them — the escape hatch for duplicates no
// heuristic catches (e.g. rows with no clock windows). Reuses the SAME machinery as
// the Data → Review resolver: fold the discarded row's gap-filling fields into the
// keeper (writeActivityFold, keeper edited=1), record a durable 'merged' decision
// keyed on the stable pair signature, then delete the discarded row.
//
// The keeper is user-chosen (issue #1081): the keeper radio spans the originating card
// + the checked siblings, so picking a SIBLING as keeper absorbs the originating card
// itself. UNLIKE the review resolver, each dropped row routes through captureDelete so
// the whole N-way merge is UNDOABLE from a toast (issue #30).
//
// FULLY-INVERTIBLE undo (issues #199/#200), now across N drops: every dropped row is
// captured with its OWN MergeUndoContext — the shared pre-fold keeper snapshot, the
// shared merge id + override choices, that drop's re-parented set ids (#199) + moved
// route id (#569), and the keeper↔drop pair signature — so undoing (via the batch
// undoDeletes) re-inserts every dropped row, moves each one's sets back off the
// keeper, re-folds the keeper from whatever drops are still merged into it, and clears
// every recorded 'merged' decision so the un-merged pairs resurface in Review. The
// undo of a chosen-away originating card brings it back exactly like any other drop.
//
// PARTIAL-BATCH SAFETY (#1884): the batch undo isolates a token whose restore throws
// (#202's design), so any SUBSET of the drops can come back. Each drop's undo removes
// only its own contribution — the keeper is recomputed as the fold over the drops
// still merged in, and children always follow their own row — so a failed token leaves
// its drop's data on the keeper (reachable, retriable) rather than nowhere.
//
// Same-profile + same-day are enforced server-side (the untrusted form ids), even
// though the UI only ever offers same-day siblings.
export async function mergeActivities(
  formData: FormData
): Promise<{ undoIds: number[] }> {
  // Merging edits the keeper and deletes the discarded rows — a write (issue #33).
  // Multi-view (#1330): a merge on a subject's card carries that subject's
  // `profile_id`, so gateItemProfile() write-gates + targets the subject's profile.
  // Every keep_id/drop id is re-verified `AND profile_id = ?` below against THIS
  // resolved profile, so a cross-profile member is refused by construction — two
  // people's activities are never duplicates of each other. Single-view merge (no
  // profile_id) falls back to the acting profile.
  const profileId = await gateItemProfile(formData);
  const profile = { id: profileId };
  // Merge is an adult-analytics affordance (the Journal duplicate-review flow) and
  // is not offered on the restricted profile's lightweight activity log; keep it
  // fully gated for a restricted profile (#489) so the un-surfaced action can't be
  // reached out-of-band.
  if (isTrainingRestricted(profile.id)) return { undoIds: [] };
  const keepId = Number(formData.get("keep_id"));
  // drop_ids is a JSON array (the multi-select); a single drop_id is still accepted
  // for the pairwise callers and the in-flight-form back-compat.
  const dropIds = parseMergeDropIds(formData).filter((id) => id !== keepId);
  if (!keepId || dropIds.length === 0) return { undoIds: [] };
  // Conflict-picker overrides (issue #100/#1431): validated to real fold-field
  // names + member ids only — the value for each is taken from the chosen member's
  // re-read row, never the client. Empty for the common (no-conflict) one-click
  // merge. The legacy pairwise array shape ("take the discarded row's value") can
  // only resolve when there is exactly one drop.
  const overrides = parseOverrideChoices(
    formData.get("overrides"),
    dropIds.length === 1 ? dropIds[0] : undefined
  );

  let undoIds: number[] = [];
  const ok = writeTx((): boolean => {
    const keep = db
      .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
      .get(keepId, profile.id) as Record<string, unknown> | undefined;
    if (!keep) return false;
    const drops: Record<string, unknown>[] = [];
    for (const id of dropIds) {
      const drop = db
        .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
        .get(id, profile.id) as Record<string, unknown> | undefined;
      // Every drop must be the acting profile's and share the keeper's day — a manual
      // merge only makes sense within one day (the detector buckets by day too).
      if (drop && drop.date === keep.date) drops.push(drop);
    }
    if (drops.length === 0) return false;

    // Snapshot the invert-undo context BEFORE the fold mutates anything (#199/#200):
    // the keeper's pre-fold fields (shared across drops), and each drop's set ids
    // before writeActivityFold re-parents them onto the keeper.
    const keeperBefore = snapshotKeeperFold(keep);
    const setIdsByDrop = new Map<number, number[]>();
    for (const drop of drops)
      setIdsByDrop.set(drop.id as number, dropSetIds(drop.id as number));

    // The N-way core folds every drop into the keeper and re-parents their children,
    // returning the ACTUAL per-drop route move so each undo context inverts exactly
    // what happened (#569).
    const moves = writeActivityFold(profile.id, keepId, keep, drops, overrides);
    const movedRouteByDrop = new Map(
      moves.map((m) => [m.dropId, m.movedRouteId])
    );

    // One identity for THIS merge, stamped on every drop's undo context (#1884), so an
    // undo can find the merge's other drops that are still folded into the keeper and
    // un-fold only its own contribution. Opaque and non-PHI.
    const mergeId = crypto.randomUUID();

    const tokens: number[] = [];
    for (const drop of drops) {
      const signature = pairSignature(
        activityToken(keep as { id: number; external_id: string | null }),
        activityToken(drop as { id: number; external_id: string | null })
      );
      recordPairDecision(profile.id, ACTIVITY_DOMAIN, signature, "merged");
      // Capture-and-delete this dropped row. Its sets/route have already been
      // re-parented onto the keeper (#199/#569), so nothing set-related cascades; the
      // per-drop merge context rides in the payload so undo fully inverts (#200).
      const undoId = captureDelete("activity", profile.id, drop.id as number, {
        keeperId: keepId,
        mergeId,
        domain: ACTIVITY_DOMAIN,
        signature,
        keeperBefore,
        overrides,
        movedSetIds: setIdsByDrop.get(drop.id as number) ?? [],
        movedRouteId: movedRouteByDrop.get(drop.id as number) ?? null,
      });
      if (undoId != null) tokens.push(undoId);
    }
    undoIds = tokens;
    return true;
  });
  if (!ok) return { undoIds: [] };

  // Refresh every activity-reading surface the folded/deleted rows feed — the
  // Journal feed on /training, the /trends fitness chart + heatmap, and the
  // dashboard rollups (same surfaces deleteActivity refreshes).
  revalidateActivitySurfaces();
  return { undoIds };
}

// Parse the Journal merge's drop ids: the multi-select `drop_ids` JSON array, or a
// single legacy `drop_id`. Positive integers only, deduped; the caller re-verifies
// each `AND profile_id = ?`, so this is shape validation, not an auth check.
function parseMergeDropIds(formData: FormData): number[] {
  const seen = new Set<number>();
  const raw = formData.get("drop_ids");
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = null;
    }
  }
  if (Array.isArray(list))
    for (const x of list) {
      const n = Number(x);
      if (Number.isInteger(n) && n > 0) seen.add(n);
    }
  const single = Number(formData.get("drop_id"));
  if (Number.isInteger(single) && single > 0) seen.add(single);
  return [...seen];
}

// Load one window of the Journal feed (issues #451, #1634). The Training → Log
// surface renders only its newest UNFILTERED page server-side; this fetches the
// next-older window on a "Load more" tap (or when a deep link targets a day/activity
// below the loaded set) — and, since #1634, page one of a FILTERED feed whenever the
// user changes a filter, so search pages over matches across the whole ledger instead
// of over whatever windows happen to be loaded.
//
// A READ, but scoped to the SESSION's active profile (or, in a household view, its
// authorized view-set — resolveJournalFeed re-resolves the scope on every call).
// `before` and `filters` are the only client inputs and neither selects a profile:
// the cursor is used purely as a `date <` bound, and the filters are normalized
// (normalizeJournalFilters) before anything reaches SQL — an unknown activity type,
// an over-long query, or a malformed tag degrades to "no such filter" rather than
// being trusted. A malformed cursor normalizes to null (start from the newest day).
export async function loadJournalPage(
  before: string | null,
  filters?: unknown
): Promise<JournalFeedPage> {
  await requireSession();
  const cursor =
    typeof before === "string" && isRealIsoDate(before) ? before : null;
  const feed = await resolveJournalFeed(
    normalizeJournalFilters(filters),
    cursor
  );
  return { groups: feed.groups, nextBefore: feed.cursor };
}

export async function deleteActivity(
  formData: FormData
): Promise<{ undoId: number | null }> {
  // Multi-view (#1330): a card's delete carries its subject's `profile_id`, so
  // gateItemProfile() write-gates + targets the row's own profile (a read-only /
  // ungranted member is bounced); single-view delete (no profile_id) falls back to
  // the acting profile. Everything below is scoped by this target profile id.
  const profileId = await gateItemProfile(formData);
  const profile = { id: profileId };
  const id = Number(formData.get("id"));
  if (!id) return { undoId: null };
  // Type-aware restriction (#489): a restricted profile owns only sport/cardio
  // rows (strength creation is blocked), but guard defensively so a leftover
  // strength row can't be deleted from the lightweight activity log either — the
  // gate matches the write path so create/delete agree.
  if (isTrainingRestricted(profile.id)) {
    const act = db
      .prepare("SELECT type FROM activities WHERE id = ? AND profile_id = ?")
      .get(id, profile.id) as { type: ActivityType } | undefined;
    if (act && !isActivityTypeAllowed(act.type, true)) return { undoId: null };
  }
  // Capture the activity + its exercise_sets into the undo holding table and
  // delete it in one transaction (issue #30), so a mis-tap can be undone from the
  // toast. children cascade; captureDelete returns the undo token.
  //
  // PAIR-DECISION POLICY (issue #334). A plain delete DELIBERATELY leaves any
  // recorded import-pair decision this row took part in (`import_pair_decisions`,
  // keyed on the stable pair signature) in place — it does NOT clear `ext:` or
  // `id:` signature rows. This is the same durability contract the whole pair-
  // decision system is built on (lib/import-review/detect.ts): a decision is keyed
  // on natural identity (external_id for sourced rows, row id for manual) PRECISELY
  // so it survives the row's re-creation. Deleting a sourced activity is transient —
  // the rolling 48h re-sync re-inserts it under the same external_id, re-forming the
  // identical pair, where the prior resolution should still apply; and a manual row's
  // `id:` token never recycles, so its leftover is a harmless dead row. A plain delete
  // means "remove this row", not "un-resolve a duplicate I separately decided" — so it
  // must not retroactively invert a merge/kept-both/dismissed decision. (A MERGE's undo
  // DOES clear its own just-recorded decision — that's inverting its own side effect,
  // #200 — which is a different operation from this bare delete.) Pinned by
  // lib/__action_tests__/delete-pair-decision.actions.test.ts.
  const undoId = captureDelete("activity", profile.id, id);
  // Deleting the last session of a movement/activity un-backs its `pr:` celebration
  // dismissal (#1931) — sweep it so a later re-log under the same name isn't silenced
  // by a row minted for history that is gone. Runs AFTER the delete so "what's still
  // backed" reflects the new state, exactly as sweepImmunizationDismissals does.
  cleanupOrphanPrDismissals(profile.id);
  revalidateActivitySurfaces();
  return { undoId };
}
