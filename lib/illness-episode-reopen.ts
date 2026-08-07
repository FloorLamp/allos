import { daysBetweenDateStr, isRealIsoDate } from "./date";

// A short relapse belongs on the same episode timeline; a later recurrence should be
// recorded as a new episode. `endDate` is the inclusive last active day (#2232), so
// eligibility is measured from it directly.
export const EPISODE_REOPEN_WINDOW_DAYS = 7;

export type EpisodeReopenEligibility =
  | { kind: "eligible"; elapsedDays: number }
  | { kind: "ongoing" }
  | { kind: "expired" }
  | { kind: "invalid" };

export function episodeReopenEligibility(
  endDate: string | null,
  asOf: string
): EpisodeReopenEligibility {
  if (endDate == null) return { kind: "ongoing" };
  if (!isRealIsoDate(endDate) || !isRealIsoDate(asOf)) {
    return { kind: "invalid" };
  }
  const elapsedDays = daysBetweenDateStr(endDate, asOf);
  if (elapsedDays == null || elapsedDays < 0) return { kind: "invalid" };
  if (elapsedDays > EPISODE_REOPEN_WINDOW_DAYS) return { kind: "expired" };
  return { kind: "eligible", elapsedDays };
}
