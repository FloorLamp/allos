// Cross-provider daily-metric reconciliation (pure — no DB), so it can be
// unit-tested in isolation. Some metrics are reported by more than one provider
// for the same day (e.g. active calories from both Strava and Health Connect);
// summing across sources would double-count, so we keep a single provider per day.

// Additive metrics that multiple providers report for the same day.
export const MULTI_PROVIDER_METRICS = new Set(["active_kcal"]);

// Preference order when a day carries the same metric from several providers.
// Health Connect covers the whole day; Strava only its recorded activities.
export const PROVIDER_PREFERENCE = ["health-connect", "strava"];

// Collapse per-(date, source) subtotals to one value per day by choosing a single
// provider — the first present in `preference`, else the largest single-source
// total (which for a lone source is just that source, and avoids double-counting
// two unknown providers).
export function pickOneProviderPerDay(
  rows: { date: string; source: string | null; value: number }[],
  preference: string[]
): { date: string; value: number }[] {
  const byDate = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = byDate.get(r.date);
    if (!m) {
      m = new Map();
      byDate.set(r.date, m);
    }
    const src = r.source ?? "";
    m.set(src, (m.get(src) ?? 0) + r.value);
  }
  const out: { date: string; value: number }[] = [];
  for (const [date, m] of byDate) {
    const chosen = preference.find((p) => m.has(p));
    const value = chosen != null ? m.get(chosen)! : Math.max(...m.values());
    out.push({ date, value });
  }
  return out;
}
