// Fuzzy subsequence matching for autocomplete lists. A query matches an option
// when all of the query's characters appear in the option in order — not
// necessarily adjacent — so "bpr" finds "Bench Press" and "ohp" finds
// "Overhead Press". The score rewards contiguous runs, matches at word starts,
// and matches near the beginning, so the closest options rank first.

// Score a single option against a query, or null when there's no subsequence
// match. Case-insensitive. Higher is better; an empty query scores 0 (any
// option matches, order unchanged).
export function fuzzyScore(option: string, query: string): number | null {
  const opt = option.toLowerCase();
  const q = query.toLowerCase();
  if (q === "") return 0;

  let score = 0;
  let qi = 0;
  let prevMatch = -2; // index in opt of the previously matched char
  for (let oi = 0; oi < opt.length && qi < q.length; oi++) {
    if (opt[oi] !== q[qi]) continue;
    let bonus = 1;
    // Contiguous with the previous matched char (a substring run).
    if (oi === prevMatch + 1) bonus += 3;
    // At a word boundary: option start or just after a separator.
    const prev = oi > 0 ? opt[oi - 1] : " ";
    if (oi === 0 || prev === " " || prev === "-" || prev === "/") bonus += 2;
    // The very first character of the option.
    if (oi === 0) bonus += 1;
    score += bonus;
    prevMatch = oi;
    qi++;
  }
  if (qi < q.length) return null; // ran out of option before matching all of q

  // Tie-break toward shorter options, so a concise name outranks a long one
  // that merely contains the same subsequence. Small enough not to overturn a
  // real scoring difference.
  return score - opt.length * 0.01;
}

// Rank `options` by fuzzy match against `query`, dropping non-matches, and
// return the top `limit`. An empty query keeps the original order (first
// `limit`). Ties break toward the earlier option so ordering is stable.
export function fuzzyFilter(
  options: string[],
  query: string,
  limit = Infinity
): string[] {
  // Trim once here (not per option): surrounding whitespace isn't part of the
  // subsequence the user means to match, and an all-space query is "empty".
  const q = query.trim();
  if (q === "") return options.slice(0, limit);
  return options
    .map((o, i) => ({ o, i, s: fuzzyScore(o, q) }))
    .filter((r): r is { o: string; i: number; s: number } => r.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.o);
}
