// The Results › Biomarkers "Trajectory watch" ROLLUP (issue #1499, section B).
// Pure — no DB, no auth, no React.
//
// WHY. The trajectory engine (#41) fires up to three rules per analyte, over every
// analyte with enough history, and the card rendered every one as a sibling ~130px
// block. The seeded profile produces nine of them, so the Results hub opened with
// ~1.2k px of forward-looking observations above the analyte list it exists to
// show — the #1496 unrolled-findings disease, on the hub #1496 didn't cover.
//
// RENDERING ONLY — the load-bearing promise, copied verbatim from #1496. This
// module never touches identity: each Finding is carried through UNCHANGED, keeps
// its own `dedupeKey` and its `supersedes` acknowledgment, and every row still posts
// its own dismiss to the shared findings bus. Folding N cards into one expandable
// row changes what the page LOOKS like, never what a dismiss MEANS.
//
// THE GROUP IS THE ANALYTE, and that is not a cosmetic choice. Since #564 every
// trajectory finding carries the SAME analyte-level acknowledgment key
// (`biomarker-flag:<family>`, the #482 family identity) as its `supersedes`, and
// `dismissTrajectory` writes exactly that key — so an analyte's approaching /
// persistent / velocity findings are already ONE dismissable thing to the bus.
// Grouping on that key makes the rendering agree with the suppression semantics
// that were always there: the group's own dismiss button writes the identical key
// its members write, so "dismiss the group" and "dismiss any member" are the same
// write, not a new bulk action.
//
// CAP. The group rows render top-`cap` with the rest behind a "show all" disclosure
// — the #1219/#1496 rule that nothing on this hub unrolls unbounded.

import type { Finding } from "./findings";
import { parseTrajectoryKey } from "./biomarker-trajectory";
import { summarizeNames } from "./summarize-names";

// How many analyte rows the card renders before the "show all" disclosure.
export const TRAJECTORY_ROLLUP_CAP = 3;

export interface TrajectoryAnalyteGroup {
  // The shared analyte-level acknowledgment key (#564) — BOTH the group's identity
  // and the key its dismiss button posts. Not a new namespace: it is the key its
  // members already carry as `supersedes`.
  key: string;
  // The analyte(s) the group covers. One #482 family can hold several spellings
  // (Vitamin D total/D2/D3), and they share the acknowledgment key — so the label
  // names each distinct one rather than picking a winner (#531: label by what
  // differs).
  label: string;
  // The folded findings, untouched: same dedupeKeys, same action links, each still
  // individually dismissible through the bus.
  items: Finding[];
}

export interface TrajectoryRollup {
  // Every group, in the order its first finding arrived (the engine's analyte order).
  groups: TrajectoryAnalyteGroup[];
  // The capped slice and its overflow — `shown` renders inline, `overflow` behind
  // the "show all" disclosure.
  shown: TrajectoryAnalyteGroup[];
  overflow: TrajectoryAnalyteGroup[];
  // Distinct analyte groups (what the card's subtitle counts — a reader thinks in
  // analytes, not in rule firings).
  analyteCount: number;
  // Total FINDINGS folded, so the subtitle can report what actually fired rather
  // than how many rows the rollup chose to draw.
  total: number;
  // "eGFR, LDL Cholesterol, hs-CRP and 2 more" — the roster under the subtitle.
  names: string;
}

// The analyte name a finding is about. `supersedes` is the family-level key, which
// is lowercased and unsuitable as a label, so the NAME comes from the dedupeKey's
// own `trajectory:<analyte>:<rule>` grammar. A foreign key (a finding from another
// engine that somehow reached this card) contributes no name — it still groups and
// still counts, it just isn't named.
function analyteName(finding: Finding): string | null {
  return parseTrajectoryKey(finding.dedupeKey)?.analyte ?? null;
}

/**
 * Fold a suppression-filtered trajectory findings list into the rollup model.
 *
 * Pure over its input — the caller has already applied the shared findings-bus
 * filter (activeFindings), so a dismissed finding never reaches here.
 */
export function rollupTrajectoryFindings(
  findings: readonly Finding[],
  cap: number = TRAJECTORY_ROLLUP_CAP
): TrajectoryRollup {
  const byKey = new Map<string, Finding[]>();
  for (const f of findings) {
    // The acknowledgment key when the finding carries one (every trajectory finding
    // does since #564); a finding without one is its own group, so nothing is ever
    // silently merged under a missing key.
    const key = f.supersedes ?? f.dedupeKey;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(f);
    else byKey.set(key, [f]);
  }

  const groups: TrajectoryAnalyteGroup[] = [...byKey].map(([key, items]) => {
    const names: string[] = [];
    for (const f of items) {
      const name = analyteName(f);
      if (name && !names.includes(name)) names.push(name);
    }
    return { key, label: names.join(" / "), items };
  });

  const limit = Math.max(0, cap);
  return {
    groups,
    shown: groups.slice(0, limit),
    overflow: groups.slice(limit),
    analyteCount: groups.length,
    total: findings.length,
    names: summarizeNames(groups.map((g) => g.label).filter(Boolean)),
  };
}
