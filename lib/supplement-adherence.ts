// Adherence over a rolling window of daily states, ordered oldest-first (the
// last element is today). Consumed by the supplements page to summarize each
// supplement's recent adherence as a streak + percentage instead of a per-day
// dot strip.

export type AdherenceState = "taken" | "partial" | "missed" | "na";

export interface AdherenceDot {
  date: string;
  state: AdherenceState;
}

export interface AdherenceSummary {
  // Consecutive days ending at the most recent completed day where at least some
  // dose was taken (fully or partially). "na" days (not due) are transparent —
  // they neither count nor break the run.
  streak: number;
  // Percent of due days taken over the window (0–100), with partial days
  // counting as half. Null when no day in the window was due (nothing to
  // report).
  pct: number | null;
  takenDays: number;
  partialDays: number;
  applicableDays: number;
}

// Group per-dose log rows into a set of logged dates keyed by dose id — the
// taken-date lookup both the supplements page and the notifier feed into
// doseStrip.
export function indexTakenByDose(
  rows: { dose_id: number; date: string }[]
): Map<number, Set<string>> {
  const byDose = new Map<number, Set<string>>();
  for (const { dose_id, date } of rows) {
    const set = byDose.get(dose_id) ?? new Set<string>();
    set.add(date);
    byDose.set(dose_id, set);
  }
  return byDose;
}

// Build one dose's adherence strip over `dates` (oldest-first): "na" on days the
// dose wasn't due, "taken" when it was logged, otherwise "missed". Pure so the
// notifier can summarize a single dose's streak/percentage without the page's
// per-supplement aggregation.
export function doseStrip(
  dates: string[],
  isDue: (date: string) => boolean,
  takenDates: Set<string>
): AdherenceDot[] {
  return dates.map((date) => ({
    date,
    state: !isDue(date) ? "na" : takenDates.has(date) ? "taken" : "missed",
  }));
}

export function adherenceSummary(strip: AdherenceDot[]): AdherenceSummary {
  // A trailing "missed" today means today is still pending — nothing logged
  // yet. Drop it so a day still in progress penalizes neither the percentage
  // nor the streak (both would otherwise read it as a miss all day).
  const n = strip.length;
  const settled =
    n > 0 && strip[n - 1].state === "missed" ? strip.slice(0, n - 1) : strip;

  const applicable = settled.filter((d) => d.state !== "na");
  const applicableDays = applicable.length;
  const takenDays = applicable.filter((d) => d.state === "taken").length;
  const partialDays = applicable.filter((d) => d.state === "partial").length;
  // Partial days count as half a taken day toward the percentage.
  const pct =
    applicableDays > 0
      ? Math.round(((takenDays + partialDays * 0.5) / applicableDays) * 100)
      : null;

  let streak = 0;
  for (let i = settled.length - 1; i >= 0; i--) {
    const st = settled[i].state;
    if (st === "na") continue; // not due — transparent to the streak
    if (st === "taken" || st === "partial")
      streak++; // partial keeps it alive
    else break; // only a fully missed day ends the run
  }

  return { streak, pct, takenDays, partialDays, applicableDays };
}
