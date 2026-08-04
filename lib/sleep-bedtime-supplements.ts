// Factual bedtime-supplement context for the Sleep page. This module does not
// compute what "bedtime", "due", or "logged" mean: the query layer reuses
// isDueOn(), doseBucketOn(), doseExistsSince(), and the shared dose-log index,
// then asks bedtimeDoseDisposition() below which doses belong to a night and
// hands those to the pure reducer.

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

// How one dose reaches (or misses) a night's bedtime summary.
//   "logged"    — a taken/skipped log exists for that night; it renders as-is.
//   "scheduled" — no log, so the caller still asks doseDueOn() for that date.
//   "excluded"  — not part of this night at all.
export type BedtimeDoseDisposition = "logged" | "scheduled" | "excluded";

export interface BedtimeDoseDispositionInput {
  // Profile-local day the sleep session began — the day intake logs are keyed to.
  sleepDate: string;
  // A taken or skipped log exists for this dose on `sleepDate`.
  logged: boolean;
  // The dose held the Before-sleep bucket ON `sleepDate`. Effective-dated (#1973):
  // the caller resolves the schedule VERSION in force that night (doseBucketOn), not
  // the current row, so a dose re-timed into or out of the bedtime slot is attributed
  // to the slot it actually occupied on the night being summarized.
  isBedtimeDose: boolean;
  // Item active and dose not retired, i.e. the dose is still part of the regimen.
  isCurrentDose: boolean;
  // The first day this dose may be judged over: the day it EXISTED from
  // (doseExistsSince), and nothing else. Before #1973 this folded in the dose's
  // `updated_at`, so any schedule edit voided every night before it — the invariant
  // "editing a dose must not rewrite adherence history" honoured by erasing the
  // history. A night before an EDIT is now judged by the version in force then.
  adherenceSince: string | null;
}

// Adherence is taken / due, and the two halves answer to different evidence.
// `logged` is a FACT — somebody recorded that this dose was taken or skipped that
// night — so it is decided by the log alone. Dueness is a JUDGMENT derived from
// the schedule as it stands today, so it is the only half the dose's lifetime
// bounds may narrow.
//
// #1972: this order matters. The lifetime clamp used to run first and discarded a
// night whose dose row had been edited afterwards, so backfilling a bedtime dose
// and then editing that dose silently erased the night from the sleep history. A
// later edit can make us unsure whether a dose was DUE; it can never make a
// recorded log stop having happened.
export function bedtimeDoseDisposition(
  input: BedtimeDoseDispositionInput
): BedtimeDoseDisposition {
  if (!input.isBedtimeDose) return "excluded";
  if (input.logged) return "logged";
  if (!input.isCurrentDose) return "excluded";
  if (input.adherenceSince != null && input.sleepDate < input.adherenceSince) {
    return "excluded";
  }
  return "scheduled";
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
