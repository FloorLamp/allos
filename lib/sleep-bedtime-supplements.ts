// Factual bedtime-supplement context for the Sleep page. This module does not
// decide whether a dose was due or what "bedtime" means: the query layer reuses
// isDueOn(), timeBucket(), doseAdherenceSince(), and the shared dose-log index,
// then hands only the due Before-sleep doses to this pure reducer.

import { aggregateDoseDay, type AdherenceState } from "./supplement-adherence";

export type BedtimeSupplementState = Exclude<AdherenceState, "na">;

export interface BedtimeSupplementItemSummary {
  name: string;
  due: number;
  taken: number;
  skipped: number;
  state: BedtimeSupplementState;
}

export interface BedtimeSupplementSummary {
  // Profile-local calendar day on which the main sleep session started. Intake
  // logs are keyed to this day, while the Sleep log row is keyed to wake-day.
  sleepDate: string;
  due: number;
  taken: number;
  skipped: number;
  state: BedtimeSupplementState;
  items: BedtimeSupplementItemSummary[];
}

export interface BedtimeSupplementDoseResolution {
  itemId: number;
  name: string;
  status: "taken" | "skipped" | null;
}

function counts(doses: readonly BedtimeSupplementDoseResolution[]): {
  due: number;
  taken: number;
  skipped: number;
} {
  return {
    due: doses.length,
    taken: doses.filter((dose) => dose.status === "taken").length,
    skipped: doses.filter((dose) => dose.status === "skipped").length,
  };
}

// Reduce the already-due bedtime doses for one sleep session into the same
// taken/partial/skipped/missed vocabulary as every adherence surface. Null means
// no bedtime supplement was due for this night, not a miss.
export function summarizeBedtimeSupplements(
  sleepDate: string,
  doses: readonly BedtimeSupplementDoseResolution[]
): BedtimeSupplementSummary | null {
  if (doses.length === 0) return null;

  const byItem = new Map<
    number,
    { name: string; doses: BedtimeSupplementDoseResolution[] }
  >();
  for (const dose of doses) {
    const item = byItem.get(dose.itemId) ?? { name: dose.name, doses: [] };
    item.doses.push(dose);
    byItem.set(dose.itemId, item);
  }

  const items = [...byItem.values()].map((item) => {
    const itemCounts = counts(item.doses);
    return {
      name: item.name,
      ...itemCounts,
      state: aggregateDoseDay(
        itemCounts.due,
        itemCounts.taken,
        itemCounts.skipped
      ),
    };
  });
  const total = counts(doses);
  return {
    sleepDate,
    ...total,
    state: aggregateDoseDay(total.due, total.taken, total.skipped),
    items,
  };
}

export function bedtimeSupplementStatusLabel(
  summary: Pick<BedtimeSupplementSummary, "due" | "taken" | "state"> | null
): string {
  if (!summary) return "—";
  switch (summary.state) {
    case "taken":
      return "All taken";
    case "partial":
      return `${summary.taken} of ${summary.due} taken`;
    case "skipped":
      return "Skipped";
    case "missed":
      return "Not logged";
  }
}
