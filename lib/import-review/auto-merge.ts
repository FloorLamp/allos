// High-confidence auto-merge (issue #1081) — the IMPURE half. Runs after a sync
// ingests activities: loads the profile's full duplicate-candidate rows, clusters the
// pairwise detections, and collapses ONLY the unambiguous clusters through the SAME
// N-way core the manual surfaces use (writeActivityFold + tombstone + merged-decision),
// leaving every other cluster for a human in Data → Review.
//
// The eligibility decision is PURE (autoMergeCluster in detect.ts): a cross-source
// group whose clock windows genuinely overlap, no material distance/duration conflict,
// at most one edit-locked member. This is a deliberate, bounded exception to the
// "never auto-merge" stance — every ambiguous cluster still waits for a human.
//
// NOT SILENT / INSPECTABLE (#1081): each auto-merge is written through the normal
// re-import tombstone + durable `merged` pair-decision path, exactly like a manual
// Review merge, so it stays fully inspectable and reversible in Review (a re-formed
// cluster resurfaces via the pairwise re-detection). The run is also logged.

import { db, writeTx } from "@/lib/db";
import { createLogger } from "@/lib/log";
import {
  findActivityDuplicates,
  clusterActivityDuplicates,
  autoMergeCluster,
  suppressingSignatures,
  undecidedPairs,
  ACTIVITY_DOMAIN,
  type ActivityDupInput,
} from "@/lib/import-review/detect";
import {
  ACTIVITY_MIDNIGHT_CANDIDATE_SQL,
  ACTIVITY_MIDNIGHT_CANDIDATE_CLOCKS,
} from "@/lib/import-review/candidate-sql";
import { writeActivityFold } from "@/lib/merge-activity";
import { writeImportTombstoneForRow } from "@/lib/integrations/tombstones";
import {
  recordPairDecision,
  getPairDecisions,
} from "@/lib/queries/integrations";

const log = createLogger("auto-merge");

// A full candidate row: the detection fields plus `edited` and every fold field the
// auto decision reads (richness / material-conflict). `SELECT *` supplies them all.
type FullActivityRow = ActivityDupInput &
  Record<string, unknown> & { id: number };

// Load the profile's duplicate-candidate activity rows in FULL (SELECT *) — the auto
// decision needs `edited` + all fold fields, unlike the pruned display loader. Same
// bucket pre-filter as loadActivityDupRows — the same `(date, type)` grouping and the
// same #2056 adjacent-day widening, which is shared rather than copied so the
// unattended path and Data → Review can't come to see different worlds. Profile-scoped.
function loadFullCandidateRows(profileId: number): FullActivityRow[] {
  return db
    .prepare(
      `WITH midnight AS (${ACTIVITY_MIDNIGHT_CANDIDATE_SQL})
       SELECT a.* FROM activities a
         JOIN (SELECT date, type FROM activities
                WHERE profile_id = ?
                GROUP BY date, type
               HAVING COUNT(DISTINCT COALESCE(source, 'manual')) > 1
                   OR SUM(CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END)
                        > COUNT(DISTINCT source)
               UNION SELECT evening_date, type FROM midnight
               UNION SELECT morning_date, type FROM midnight) m
           ON m.date = a.date AND m.type = a.type
        WHERE a.profile_id = ?`
    )
    .all(
      profileId,
      ...ACTIVITY_MIDNIGHT_CANDIDATE_CLOCKS,
      profileId,
      profileId
    ) as FullActivityRow[];
}

// Auto-collapse every eligible high-confidence duplicate cluster for one profile.
// Returns the number of dropped rows absorbed (0 when nothing was eligible). Best-
// effort per cluster — one cluster's failure never blocks the others or the sync.
export function autoMergeActivityDuplicates(profileId: number): number {
  const rows = loadFullCandidateRows(profileId);
  if (rows.length === 0) return 0;

  // Same suppression policy as the manual inbox (getActivityDuplicates): a
  // kept-both/dismissed pair stays suppressed; a re-formed `merged` pair is eligible
  // again (the resync undid it), so it can auto-collapse once more.
  const decided = suppressingSignatures(
    getPairDecisions(profileId, ACTIVITY_DOMAIN)
  );
  const clusters = clusterActivityDuplicates(
    undecidedPairs(findActivityDuplicates(rows), decided)
  );

  let mergedRows = 0;
  for (const cluster of clusters) {
    const decision = autoMergeCluster(cluster.members);
    if (!decision) continue; // ambiguous → leave for manual Review
    try {
      mergedRows += writeTx(() => {
        const keep = db
          .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
          .get(decision.keepId, profileId) as
          Record<string, unknown> | undefined;
        if (!keep) return 0;
        const drops: Record<string, unknown>[] = [];
        for (const id of decision.dropIds) {
          const drop = db
            .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
            .get(id, profileId) as Record<string, unknown> | undefined;
          if (drop) drops.push(drop);
        }
        if (drops.length === 0) return 0;
        writeActivityFold(profileId, decision.keepId, keep, drops);
        for (const drop of drops) {
          db.prepare(
            "DELETE FROM activities WHERE id = ? AND profile_id = ?"
          ).run(drop.id as number, profileId);
          // Tombstone each dropped integration row so the trailing-window resync
          // can't resurrect it (#507); no-op for a manual absorbed row.
          writeImportTombstoneForRow(profileId, "activities", drop);
        }
        // A durable `merged` decision per constituent pair signature — the same
        // inspectable/reversible record a manual cluster merge leaves (#1081).
        for (const sig of cluster.pairSignatures)
          recordPairDecision(profileId, ACTIVITY_DOMAIN, sig, "merged");
        return drops.length;
      });
    } catch (err) {
      log.error("auto-merge cluster failed", {
        profileId,
        signature: cluster.signature,
        err,
      });
    }
  }
  if (mergedRows > 0)
    log.info("auto-merged high-confidence activity duplicates", {
      profileId,
      droppedRows: mergedRows,
    });
  return mergedRows;
}
