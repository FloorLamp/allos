import { shiftDateStr } from "./date";
import { speedKmh } from "./coaching/cardio";

export interface SessionOverviewInput {
  date: string;
  durationMin: number | null;
  distanceKm: number | null;
}

export interface SessionPeriodTotals {
  sessions: number;
  durationMin: number;
  distanceKm: number;
}

export interface SessionFormRollup {
  days: number;
  recent: SessionPeriodTotals;
  previous: SessionPeriodTotals;
  durationChangePercent: number | null;
  distanceChangePercent: number | null;
}

export interface SessionOverviewRecordInput extends SessionOverviewInput {
  id: number;
  title: string;
  avgSpeedKmh: number | null;
}

export type SessionOverviewRecordKey = "distance" | "speed" | "duration";

export interface SessionOverviewRecord {
  key: SessionOverviewRecordKey;
  activityId: number;
  date: string;
  title: string;
  value: number;
}

export interface SessionOverviewRollup extends SessionFormRollup {
  totals: SessionPeriodTotals & { averageSpeedKmh: number | null };
  records: SessionOverviewRecord[];
}

function totals(rows: readonly SessionOverviewInput[]): SessionPeriodTotals {
  return rows.reduce(
    (sum, row) => ({
      sessions: sum.sessions + 1,
      durationMin: sum.durationMin + (row.durationMin ?? 0),
      distanceKm: sum.distanceKm + (row.distanceKm ?? 0),
    }),
    { sessions: 0, durationMin: 0, distanceKm: 0 }
  );
}

function change(current: number, previous: number): number | null {
  return previous > 0
    ? Math.round(((current - previous) / previous) * 100)
    : null;
}

/** Shared rolling form comparison for any session domain. */
export function sessionFormRollup(
  rows: readonly SessionOverviewInput[],
  today: string,
  days = 28
): SessionFormRollup {
  const recentStart = shiftDateStr(today, -(days - 1));
  const previousEnd = shiftDateStr(recentStart, -1);
  const previousStart = shiftDateStr(previousEnd, -(days - 1));
  const recent = totals(
    rows.filter((row) => row.date >= recentStart && row.date <= today)
  );
  const previous = totals(
    rows.filter((row) => row.date >= previousStart && row.date <= previousEnd)
  );
  return {
    days,
    recent,
    previous,
    durationChangePercent: change(recent.durationMin, previous.durationMin),
    distanceChangePercent: change(recent.distanceKm, previous.distanceKm),
  };
}

function record(
  sessions: readonly SessionOverviewRecordInput[],
  key: SessionOverviewRecordKey,
  value: (session: SessionOverviewRecordInput) => number | null
): SessionOverviewRecord | null {
  let best: SessionOverviewRecord | null = null;
  for (const session of sessions) {
    const candidate = value(session);
    if (candidate == null || !Number.isFinite(candidate) || candidate <= 0)
      continue;
    if (
      !best ||
      candidate > best.value ||
      (candidate === best.value &&
        (session.date > best.date ||
          (session.date === best.date && session.id > best.activityId)))
    ) {
      best = {
        key,
        activityId: session.id,
        date: session.date,
        title: session.title,
        value: candidate,
      };
    }
  }
  return best;
}

/** Common all-time totals and records plus adjacent rolling form blocks. */
export function sessionOverviewRollup(
  sessions: readonly SessionOverviewRecordInput[],
  today: string,
  days = 28
): SessionOverviewRollup {
  const form = sessionFormRollup(sessions, today, days);
  const all = totals(sessions);
  const records = [
    record(sessions, "distance", (session) => session.distanceKm),
    record(
      sessions,
      "speed",
      (session) =>
        session.avgSpeedKmh ?? speedKmh(session.distanceKm, session.durationMin)
    ),
    record(sessions, "duration", (session) => session.durationMin),
  ].filter((value): value is SessionOverviewRecord => value != null);
  return {
    ...form,
    totals: {
      ...all,
      averageSpeedKmh: speedKmh(all.distanceKm, all.durationMin),
    },
    records,
  };
}
