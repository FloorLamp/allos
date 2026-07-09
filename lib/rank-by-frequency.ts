// Merge a curated list with what the user has actually logged, then rank by
// usage frequency (descending). Curated entries keep their order on ties;
// previously-used custom names are appended and ranked by their own count.
export function rankByFrequency(
  curated: string[],
  rows: { name: string; c: number }[]
): string[] {
  const counts = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  const seen = new Set<string>();
  const items: { name: string; c: number }[] = [];
  for (const name of curated) {
    const key = name.toLowerCase();
    items.push({ name, c: counts.get(key)?.c ?? 0 });
    seen.add(key);
  }
  for (const [key, r] of counts) {
    if (!seen.has(key) && r.name.trim()) items.push({ name: r.name, c: r.c });
  }
  return items
    .map((it, i) => ({ ...it, i }))
    .sort((a, b) => b.c - a.c || a.i - b.i)
    .map((it) => it.name);
}
