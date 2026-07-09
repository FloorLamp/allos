// The user's bodyweight as of a given date (most recent weight on or before it;
// falls back to the earliest known; null when there are no weights recorded).
// `weights` must be ascending by date. Folded into bodyweight-lift loads.
export function bodyweightAsOf(
  weights: { date: string; weight_kg: number }[],
  date: string
): number | null {
  if (weights.length === 0) return null;
  let val = weights[0].weight_kg;
  for (const w of weights) {
    if (w.date <= date) val = w.weight_kg;
    else break;
  }
  return val;
}
