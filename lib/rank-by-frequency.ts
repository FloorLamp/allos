import { decayedWeight } from "./decay";

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

// Float a routine's prescribed exercises to the FRONT of an already-frequency-ranked
// picker list (#1115 Fix C), so opening the logger on "Push day" surfaces today's
// prescribed lifts first instead of your globally-most-frequent ones. `priority` is the
// resolved routine session's slot exercises (base-collapsed to match the picker's base
// names) in slot order; each is moved ahead of the rest, preserving their given order,
// and every other option keeps its frequency order. Case-insensitive match; a priority
// name not present in `ranked` is skipped (a custom slot exercise the catalog doesn't
// list). Empty `priority` (off a routine) returns `ranked` byte-for-byte — the default.
export function prioritizeRoutineSlots(
  ranked: string[],
  priority: string[]
): string[] {
  if (priority.length === 0) return ranked;
  const wanted = new Set(priority.map((p) => p.toLowerCase()));
  const front: string[] = [];
  const seen = new Set<string>();
  // Take priority names in the picker's own casing, in slot order, de-duplicated.
  for (const p of priority) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    const match = ranked.find((r) => r.toLowerCase() === key);
    if (match) {
      front.push(match);
      seen.add(key);
    }
  }
  const rest = ranked.filter((r) => !wanted.has(r.toLowerCase()));
  return [...front, ...rest];
}

// Sum recency-weighted occurrences by name; callers own their ranking rules.
export function decayWeights(
  occurrences: readonly { name: string; date: string; weight?: number }[],
  today: string,
  halfLifeDays?: number
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const o of occurrences) {
    const w = (o.weight ?? 1) * decayedWeight(o.date, today, halfLifeDays);
    weights.set(o.name, (weights.get(o.name) ?? 0) + w);
  }
  return weights;
}

// Rank by recent usage, keeping curated order on ties and including custom names.
export function rankByRecentFrequency(
  curated: string[],
  occurrences: { name: string; date: string; weight?: number }[],
  today: string,
  halfLifeDays?: number
): string[] {
  const weights = decayWeights(occurrences, today, halfLifeDays);
  const rows = [...weights].map(([name, c]) => ({ name, c }));
  return rankByFrequency(curated, rows);
}
