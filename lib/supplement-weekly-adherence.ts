import type { AdherenceState } from "./intake-adherence";

export interface SupplementAdherenceDayInput {
  date: string;
  due: number;
  taken: number;
  skipped: number;
  isToday: boolean;
}

export type WeeklyAdherenceState = AdherenceState | "pending";

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

function normalizeDay(
  day: SupplementAdherenceDayInput
): SupplementAdherenceDay {
  const due = Math.max(0, day.due);
  const skipped = Math.min(due, Math.max(0, day.skipped));
  const intended = Math.max(0, due - skipped);
  const taken = Math.min(intended, Math.max(0, day.taken));
  const pending = Math.max(0, due - taken - skipped);

  let state: WeeklyAdherenceState;
  if (due === 0) state = "na";
  else if (day.isToday && pending > 0) state = "pending";
  else if (intended === 0) state = "skipped";
  else if (taken >= intended) state = "taken";
  else if (taken > 0) state = "partial";
  else state = "missed";

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
  const days = input.map(normalizeDay);
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
