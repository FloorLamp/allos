// The Training → Overview findings ROLLUP (issue #1496).
//
// Overview is the DOING surface (#1492's other half: analyze on Trends, do on
// /training), and the one thing that made it an 8,798px wall was the findings
// block: the per-muscle volume-band engine (#742) can fire once per MuscleId, so a
// normal week unrolled ~17 sibling cards above everything the page is actually for.
// The dashboard already treats coaching-tier findings as a calm, capped rollup
// (#449/#1219); this applies that posture to the page that GENERATES them.
//
// RENDERING ONLY. This module never touches identity: each per-muscle Finding keeps
// its own `dedupeKey`, and the rollup carries the Finding objects through unchanged
// so every row still renders its own dismiss form against the shared findings bus
// (#39/#45). Folding N cards into one expandable row changes what the page LOOKS
// like, not what a dismiss MEANS — dismissing "Calves" inside the rollup writes the
// same `muscle-volume:below:calves:<YYYY-MM>` suppression it always did, and the
// rollup simply comes back with N−1 items.
//
// Two rules, both pure and both tested:
//   1. GROUP — every muscle-volume finding folds into ONE row summarizing the count
//      ("4 muscle groups under weekly target") and naming the biggest offenders.
//      The engine already orders them largest-shortfall-first, so the summary names
//      the muscles worth reading first.
//   2. CAP — the resulting row list renders top-3 + "show all N". Nothing on this
//      page unrolls unbounded, the group row included (it is ONE row, expandable).
//
// The group row leads deliberately: it is a single collapsed line, it is the
// densest signal, and putting it first keeps it out of the overflow disclosure no
// matter how many individual observations (plateau/stale/imbalance) are firing.

import type { Finding } from "./findings";
import { muscleLabel } from "./lifts";
import { parseMuscleVolumeKey } from "./muscle-volume-bands";
import { SUMMARY_NAME_LIMIT, summarizeNames } from "./summarize-names";

// Any findings list on Training → Overview renders this many rows, with the rest
// behind a "show all" disclosure (the #1219 movers pattern).
export const TRAINING_FINDINGS_CAP = 3;

// How many muscle names the group's summary line spells out before "and N more".
const GROUP_DETAIL_NAMES = SUMMARY_NAME_LIMIT;

export interface TrainingFindingGroup {
  // Stable React/testid key for the row (not a suppression key — the group is a
  // rendering artifact and is NEVER dismissible as a unit).
  key: string;
  title: string;
  detail: string;
  // The folded findings, untouched: same dedupeKeys, same action links, each still
  // individually dismissible through the bus.
  items: Finding[];
}

export type TrainingFindingRow =
  | { kind: "finding"; key: string; finding: Finding }
  | { kind: "group"; key: string; group: TrainingFindingGroup };

export interface TrainingFindingsRollup {
  // Rows in render order (group first, then the individual findings in engine order).
  rows: TrainingFindingRow[];
  // The capped slice and its overflow — `shown` renders open, `overflow` behind the
  // "show all" disclosure.
  shown: TrainingFindingRow[];
  overflow: TrainingFindingRow[];
  // Total FINDINGS (the group counts as its item count, not as 1) — what the card's
  // subtitle reports, so the number a user reads matches the number of things that
  // fired, not the number of rows the rollup chose to draw.
  total: number;
  // How many findings the group absorbed (0 when no volume-band finding fired).
  grouped: number;
}

// The muscles a set of volume-band findings names, in the order they arrived
// (largest shortfall first, per detectVolumeShortfalls). A key that doesn't parse
// contributes no label — it still counts, it just isn't named in the summary.
function muscleNames(findings: readonly Finding[]): string[] {
  const out: string[] = [];
  for (const f of findings) {
    const m = parseMuscleVolumeKey(f.dedupeKey);
    if (m) out.push(muscleLabel(m));
  }
  return out;
}

// "Chest, Quads, Calves and 2 more" — the summary line under the group title. The
// sentence itself is the shared summarizeNames (the Results-hub trajectory rollup
// prints the identical shape for analyte names); this stays as the muscle-domain
// name for it, so the rollup's own tests keep pinning the copy they always did.
export function summarizeMuscleNames(
  names: readonly string[],
  limit = GROUP_DETAIL_NAMES
): string {
  return summarizeNames(names, limit);
}

/**
 * Fold the Training-watch findings into the Overview rollup model: one group row for
 * the per-muscle volume-band shortfalls, individual rows for everything else, capped
 * to `cap` with the remainder as overflow.
 *
 * Pure over its input — the caller has already applied the shared suppression filter
 * (activeFindings), so a dismissed finding never reaches here.
 */
export function rollupTrainingFindings(
  findings: readonly Finding[],
  cap: number = TRAINING_FINDINGS_CAP
): TrainingFindingsRollup {
  const volume: Finding[] = [];
  const rest: Finding[] = [];
  for (const f of findings) {
    (parseMuscleVolumeKey(f.dedupeKey) ? volume : rest).push(f);
  }

  const rows: TrainingFindingRow[] = [];
  if (volume.length > 0) {
    const n = volume.length;
    rows.push({
      kind: "group",
      key: "muscle-volume-rollup",
      group: {
        key: "muscle-volume-rollup",
        title: `${n} muscle group${n === 1 ? "" : "s"} under weekly target`,
        detail: summarizeMuscleNames(muscleNames(volume)),
        items: volume,
      },
    });
  }
  for (const f of rest) {
    rows.push({ kind: "finding", key: f.dedupeKey, finding: f });
  }

  const limit = Math.max(0, cap);
  return {
    rows,
    shown: rows.slice(0, limit),
    overflow: rows.slice(limit),
    total: findings.length,
    grouped: volume.length,
  };
}
