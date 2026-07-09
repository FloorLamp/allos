// Pure grouping for bulk biomarker reads: split one canonical-name-ordered row
// list (getAllBiomarkerSeries) into per-analyte series, keyed case-insensitively
// to match the SQL NOCASE matching getBiomarkerSeries uses — so a lookup by any
// casing of a used name returns the same series a per-analyte query would.
// Rows keep their input order within each group (the query orders date, id).

export function canonicalGroupKey(name: string): string {
  return name.toLowerCase();
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
