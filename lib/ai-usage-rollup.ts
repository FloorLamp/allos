// PURE aggregation for the AI-logs token/cost rollup (issue #410). Given the
// parsed AiEvent stream, produce a per-feature × profile summary of calls + token
// usage over today and the trailing 7 days. Imports nothing (unit-tested in the
// pure suite); the AI-logs page is the only caller and stays a formatter over this.
//
// Tokens are labeled honestly as tokens — NO dollar math (prices drift; each event
// records its model, so anyone who wants dollars can compute them downstream).

import type { AiEvent, AiFeature } from "./ai-log";

export interface UsageStat {
  calls: number; // dispatched calls (ok + failed; skipped never hit the API)
  tokensIn: number;
  tokensOut: number;
}

export interface UsageRollupRow {
  feature: AiFeature;
  profileId: number | null;
  today: UsageStat;
  week: UsageStat;
}

function emptyStat(): UsageStat {
  return { calls: 0, tokensIn: 0, tokensOut: 0 };
}

// The date (YYYY-MM-DD) N days before an ISO date string, by UTC calendar math.
function dateMinusDays(dateStr: string, n: number): string {
  const ms = Date.parse(`${dateStr}T00:00:00.000Z`);
  return new Date(ms - n * 86_400_000).toISOString().slice(0, 10);
}

function addInto(stat: UsageStat, e: AiEvent): void {
  // A `skipped` event never dispatched to the API (no key / cap / model declined),
  // so it isn't a "call" and carries no tokens.
  if (e.status !== "skipped") stat.calls += 1;
  if (e.usage) {
    stat.tokensIn += e.usage.in;
    stat.tokensOut += e.usage.out;
  }
}

// Aggregate the events into per-(feature, profile) rows. `nowISO` anchors the two
// windows; comparison is on the UTC date prefix, so a tz-skewed event near
// midnight may land a day off — acceptable for an audit rollup (the page notes it).
// Rows are sorted by 7-day token total desc, then feature, so the heaviest
// consumers surface first. Buckets with zero week activity are dropped.
export function rollupAiUsage(
  events: AiEvent[],
  nowISO: string
): UsageRollupRow[] {
  const todayDate = nowISO.slice(0, 10);
  const weekStart = dateMinusDays(todayDate, 6); // inclusive 7-day window

  const byKey = new Map<string, UsageRollupRow>();
  for (const e of events) {
    const eventDate = (e.time ?? "").slice(0, 10);
    if (!eventDate || eventDate < weekStart || eventDate > todayDate) continue;
    const key = `${e.feature}|${e.profileId ?? "null"}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        feature: e.feature,
        profileId: e.profileId ?? null,
        today: emptyStat(),
        week: emptyStat(),
      };
      byKey.set(key, row);
    }
    addInto(row.week, e);
    if (eventDate === todayDate) addInto(row.today, e);
  }

  return [...byKey.values()].sort((a, b) => {
    const at = a.week.tokensIn + a.week.tokensOut;
    const bt = b.week.tokensIn + b.week.tokensOut;
    if (bt !== at) return bt - at;
    if (a.feature !== b.feature) return a.feature.localeCompare(b.feature);
    return (a.profileId ?? 0) - (b.profileId ?? 0);
  });
}

// Convenience totals across all rows for a window, for a summary line.
export function totalStat(
  rows: UsageRollupRow[],
  window: "today" | "week"
): UsageStat {
  return rows.reduce((acc, r) => {
    const s = r[window];
    acc.calls += s.calls;
    acc.tokensIn += s.tokensIn;
    acc.tokensOut += s.tokensOut;
    return acc;
  }, emptyStat());
}
