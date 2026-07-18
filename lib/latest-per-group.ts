// The ONE latest-per-group selection (issue #944, the `is_latest` substrate helper).
//
// "Which reading is current for its group" is asked on every observation-shaped
// surface — the Biomarkers table's is_latest marker, the current-value filter, the
// series head. The GROUPING identity is domain-owned (biomarker rows group by the
// #482 FAMILY, not the bare name; a future observation domain supplies its own key),
// but the ORDERING rule is universal and must not be re-implemented per surface:
// newest by `date`, then the highest `id` as the tie-break for same-date rows. This
// is the pure counterpart of the SQL `LATEST_IDS_CTE` (lib/queries/medical.ts) — the
// finite-preimage realization SQL needs because it can't call this JS — so the two
// stay byte-identical on the "who is latest" question (#221: one computation).
//
// Kept pure (no DB) so the ordering rule is unit-testable in isolation and reused by
// the derived-table merge (which folds read-time derived rows in with stored rows and
// must re-decide is_latest over the combined set, exactly like the SQL does per group).

// A row that carries the two dimensions the latest rule orders on. `date` is a
// zero-padded ISO/`YYYY-MM-DD` string (lexicographic compare is chronological); `id`
// breaks a same-date tie (higher wins — mirrors the SQL `ORDER BY date DESC, id DESC`,
// and lets a stored positive id beat a same-date derived negative id).
export interface LatestRow {
  date: string;
  id: number;
}

// Strictly "a is a later reading than b" under the shared rule: later date wins; on
// an equal date the higher id wins. Pure — the single definition of the ordering both
// the marker and the current filter defer to.
export function isLaterReading(a: LatestRow, b: LatestRow): boolean {
  return a.date > b.date || (a.date === b.date && a.id > b.id);
}

// The current (latest) row per group: partition `rows` by `groupKey`, keep the
// newest per the shared rule. Returns group-key → winning row. The caller owns the
// grouping identity (e.g. the biomarker family) so this stays domain-agnostic; the
// ordering rule is fixed here so no surface can disagree about which reading is
// current. Pure.
export function latestByGroup<T extends LatestRow>(
  rows: readonly T[],
  groupKey: (r: T) => string
): Map<string, T> {
  const best = new Map<string, T>();
  for (const r of rows) {
    const key = groupKey(r);
    const cur = best.get(key);
    if (!cur || isLaterReading(r, cur)) best.set(key, r);
  }
  return best;
}
