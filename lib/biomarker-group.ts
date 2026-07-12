// Pure grouping for bulk biomarker reads: split one canonical-name-ordered row
// list (getAllBiomarkerSeries) into per-analyte series, keyed case-insensitively
// to match the SQL NOCASE matching getBiomarkerSeries uses — so a lookup by any
// casing of a used name returns the same series a per-analyte query would.
// Rows keep their input order within each group (the query orders date, id).

import { biomarkerFamily } from "./canonical-name";

// The grouping key is the biomarker FAMILY identity (#482), lowercased — so the
// bulk series grouping collapses family members (e.g. the vitamin-D 25-OH
// variants) exactly like the family-partitioned SQL dedup/latest and the
// per-analyte getBiomarkerSeries do. A non-family name is its own family, so its
// key is just the lowercased name — identical to the pre-#482 behavior, which is
// why every non-family lookup (the derived-index component reads, trajectory) is
// unchanged.
export function canonicalGroupKey(name: string): string {
  return biomarkerFamily(name).toLowerCase();
}

export function groupByCanonicalName<
  T extends { canonical_name: string | null },
>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.canonical_name) continue;
    const key = canonicalGroupKey(row.canonical_name);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}
