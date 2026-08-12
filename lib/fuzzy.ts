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

// What a used option is worth against textual relevance (#2384). The CALLER
// answers "does this profile actually use this?" — the domain question, which
// its existing rankers already answer — and this constant is the one app-wide
// answer to "what is that worth?", so no surface invents a sort of its own.
//
// The bound IS the design:
//   • It OVERTURNS the +1 "very first character of the option" bonus and the
//     length tiebreak — exactly the ~1.04 gap that put a never-logged "Squash"
//     above five logged squats for the query "sqa".
//   • It CANNOT overturn a word-boundary difference (+2) or a contiguity run
//     (+3). A genuinely better textual match still wins: for "ohp" an unused
//     "Overhead Press" still beats a used "Other Hip Push".
//
// Binary, not graded (the #1490 discipline): bucketed presence, no raw-frequency
// jitter. Two used options do not reorder against each other on usage; textual
// score still separates them. And it DE-RANKS rather than hides (#345) — an
// unused option keeps its row.
export const USAGE_BONUS = 1.5;

export interface FuzzyOptions {
  // Cap on the number of results; applies to the empty query too.
  limit?: number;
  // Lowercased option names the profile has actually used. OMITTING it is
  // byte-for-byte the pre-#2384 behavior, and that is the correct default: for a
  // picker whose options are alphabetical, a position-derived bonus would merely
  // bias toward names beginning with "A". A picker earns this by declaring real
  // evidence, never by having an order.
  used?: ReadonlySet<string>;
}

function usageBonus(
  option: string,
  used: ReadonlySet<string> | undefined
): number {
  return used?.has(option.toLowerCase()) ? USAGE_BONUS : 0;
}

// Rank `options` by fuzzy match against `query`, dropping non-matches, and
// return the top `limit`. An empty query keeps the original order (first
// `limit`) — with nothing typed the caller's own ranking IS the relevance view,
// so usage must not reorder it. Ties break toward the earlier option so ordering
// is stable.
export function fuzzyFilter(
  options: string[],
  query: string,
  { limit = Infinity, used }: FuzzyOptions = {}
): string[] {
  // Trim once here (not per option): surrounding whitespace isn't part of the
  // subsequence the user means to match, and an all-space query is "empty".
  const q = query.trim();
  if (q === "") return options.slice(0, limit);
  return options
    .map((o, i) => {
      const s = fuzzyScore(o, q);
      return { o, i, s: s === null ? null : s + usageBonus(o, used) };
    })
    .filter((r): r is { o: string; i: number; s: number } => r.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.o);
}

// Alias-aware variant for a picker whose visible label is not its only searchable
// spelling. Each option keeps its visible value; hidden terms only contribute a
// score. Existing Combobox callers stay on fuzzyFilter unless they opt in.
//
// The usage bonus keys on the OPTION, never on the term that happened to match:
// an alias is a spelling, not evidence of use.
export function fuzzyFilterWithTerms(
  options: string[],
  query: string,
  termsFor: (option: string) => readonly string[],
  { limit = Infinity, used }: FuzzyOptions = {}
): string[] {
  const q = query.trim();
  if (q === "") return options.slice(0, limit);
  return options
    .map((o, i) => {
      const scores = [o, ...termsFor(o)]
        .map((term) => fuzzyScore(term, q))
        .filter((score): score is number => score !== null);
      return {
        o,
        i,
        s:
          scores.length > 0
            ? Math.max(...scores) + usageBonus(o, used)
            : (null as number | null),
      };
    })
    .filter((r): r is { o: string; i: number; s: number } => r.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.o);
}
