import {
  aggregateDoseDay,
  trailingPendingIndex,
  type AdherenceState,
} from "./intake-adherence";

export interface SupplementAdherenceDayInput {
  date: string;
  due: number;
  taken: number;
  skipped: number;
  isToday: boolean;
}

// "excused" (#3263) is excluded: this rail is fed day COUNTS, and its caller drops a
// travel-excused dose from `due` before it ever gets here, so an excused day arrives
// as a day with nothing due. That keeps the rail out of the false-miss it exists to
// avoid; the month calendar is where the excusal is NAMED.
export type WeeklyAdherenceState =
  Exclude<AdherenceState, "excused"> | "pending";

export interface SupplementAdherenceDay extends SupplementAdherenceDayInput {
  intended: number;
  pending: number;
  state: WeeklyAdherenceState;
}

export interface SupplementWeeklyAdherence {
  days: SupplementAdherenceDay[];
  taken: number;
  intended: number;
  skipped: number;
  pct: number | null;
}

function normalizeDay(day: SupplementAdherenceDayInput) {
  const due = Math.max(0, day.due);
  const skipped = Math.min(due, Math.max(0, day.skipped));
  const intended = Math.max(0, due - skipped);
  const taken = Math.min(intended, Math.max(0, day.taken));
  const pending = Math.max(0, due - taken - skipped);

  // `na` is this rail's one extension: no due doses means no counted verdict.
  const state: Exclude<WeeklyAdherenceState, "pending"> =
    due === 0 ? "na" : aggregateDoseDay(due, taken, skipped);

  return {
    ...day,
    due,
    taken,
    skipped,
    intended,
    pending,
    state,
  };
}

// Stack-level adherence for the current profile-defined week. Past days and a
// fully-resolved today contribute to the headline; unresolved doses today remain
// visible in the strip but do not depress the percentage while the day is ongoing.
export function buildSupplementWeeklyAdherence(
  input: SupplementAdherenceDayInput[]
): SupplementWeeklyAdherence {
  const normalized = input.map(normalizeDay);
  const pendingIndex = trailingPendingIndex(normalized);
  const days = normalized.map((day, index) =>
    index === pendingIndex ? { ...day, state: "pending" as const } : day
  );
  let taken = 0;
  let intended = 0;

  for (const day of days) {
    if (day.isToday && day.pending > 0) continue;
    taken += day.taken;
    intended += day.intended;
  }

  const skipped = days.reduce((sum, day) => sum + day.skipped, 0);
  const pct =
    intended > 0
      ? Math.round((Math.min(taken, intended) / intended) * 100)
      : null;

  return { days, taken, intended, skipped, pct };
}
