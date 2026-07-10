// Adherence over a rolling window of daily states, ordered oldest-first (the
// last element is today). Consumed by the supplements page to summarize each
// supplement's recent adherence as a streak + percentage instead of a per-day
// dot strip.

// "skipped" (issue #232) is a DELIBERATE decision, distinct from "missed" (a
// lapse): it is excluded from the adherence denominator and, like "na", is
// transparent to the streak — it neither counts as follow-through nor breaks it.
export type AdherenceState = "taken" | "partial" | "skipped" | "missed" | "na";

export interface AdherenceDot {
  date: string;
  state: AdherenceState;
}

export interface AdherenceSummary {
  // Consecutive days ending at the most recent completed day where at least some
  // dose was taken (fully or partially). "na" (not due) and "skipped" (a
  // decision) days are transparent — they neither count nor break the run.
  streak: number;
  // Percent of due days taken over the window (0–100), with partial days
  // counting as half. Skipped days are excluded from the denominator (adherence
  // measures follow-through on INTENDED doses). Null when no day in the window
  // counted (nothing to report).
  pct: number | null;
  takenDays: number;
  partialDays: number;
  // Deliberately-skipped days, surfaced as their own count rather than folded
  // into the percentage (#232).
  skippedDays: number;
  applicableDays: number;
}

// Roll one supplement-day's per-dose outcomes into a single strip state (#232).
// `total` is the number of doses due that day; `takenN`/`skippedN` how many were
// taken / deliberately skipped. A day where every due dose is resolved as a skip
// (and none missed) is itself "skipped"; any taken dose makes it taken/partial;
// otherwise it's a real miss. Pure so the page and any other surface share it.
export function aggregateDoseDay(
  total: number,
  takenN: number,
  skippedN: number
): AdherenceState {
  const due = Math.max(total, 1);
  if (takenN >= due) return "taken";
  if (takenN > 0) return "partial";
  // Every due dose resolved as a deliberate skip (none taken, none left missed).
  if (skippedN >= due) return "skipped";
  return "missed";
}

// A per-dose lookup of which dates were taken vs deliberately skipped (#232),
// keyed by dose id. Both the supplements page and the notifier build these from
// getSupplementLogsInRange and feed them into doseStrip.
export interface DoseDateStatus {
  taken: Set<string>;
  skipped: Set<string>;
}

// Group per-dose log rows (each carrying a status) into taken/skipped date sets
// keyed by dose id. Rows without a status default to "taken" (a pre-#232 log).
export function indexTakenByDose(
  rows: { dose_id: number; date: string; status?: "taken" | "skipped" }[]
): Map<number, DoseDateStatus> {
  const byDose = new Map<number, DoseDateStatus>();
  for (const { dose_id, date, status } of rows) {
    const entry =
      byDose.get(dose_id) ??
      ({
        taken: new Set<string>(),
        skipped: new Set<string>(),
      } as DoseDateStatus);
    (status === "skipped" ? entry.skipped : entry.taken).add(date);
    byDose.set(dose_id, entry);
  }
  return byDose;
}

// Build one dose's adherence strip over `dates` (oldest-first): "na" on days the
// dose wasn't due, "taken" when it was logged taken, "skipped" on a deliberate
// skip (#232), otherwise "missed". `skippedDates` is optional so older callers
// (taken-only) keep working. Pure so the notifier can summarize a single dose's
// streak/percentage without the page's per-supplement aggregation.
export function doseStrip(
  dates: string[],
  isDue: (date: string) => boolean,
  takenDates: Set<string>,
  skippedDates: Set<string> = new Set()
): AdherenceDot[] {
  return dates.map((date) => ({
    date,
    state: !isDue(date)
      ? "na"
      : takenDates.has(date)
        ? "taken"
        : skippedDates.has(date)
          ? "skipped"
          : "missed",
  }));
}

export function adherenceSummary(strip: AdherenceDot[]): AdherenceSummary {
  // A trailing "missed" today means today is still pending — nothing logged
  // yet. Drop it so a day still in progress penalizes neither the percentage
  // nor the streak (both would otherwise read it as a miss all day).
  const n = strip.length;
  const settled =
    n > 0 && strip[n - 1].state === "missed" ? strip.slice(0, n - 1) : strip;

  // "skipped" days are a decision, not an intended dose — excluded from the
  // denominator (alongside "na"), but surfaced as their own count (#232).
  const skippedDays = settled.filter((d) => d.state === "skipped").length;
  const applicable = settled.filter(
    (d) => d.state !== "na" && d.state !== "skipped"
  );
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
    if (st === "na" || st === "skipped") continue; // transparent to the streak
    if (st === "taken" || st === "partial")
      streak++; // partial keeps it alive
    else break; // only a fully missed day ends the run
  }

  return { streak, pct, takenDays, partialDays, skippedDays, applicableDays };
}
