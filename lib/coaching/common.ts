// Shared date helpers for the coaching submodules (strength + cardio PR
// windows). Pure — no DB/network.

// Whole days from dateISO to today (both YYYY-MM-DD), or Infinity if unparseable.
export function daysAgo(dateISO: string, today: string): number {
  const a = Date.parse(`${dateISO}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86_400_000);
}

export function within(dateISO: string, today: string, days: number): boolean {
  const d = daysAgo(dateISO, today);
  return d >= 0 && d <= days;
}

// Newest-first sort by ISO date string.
export function byDateDesc<T extends { date: string }>(a: T, b: T): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}
