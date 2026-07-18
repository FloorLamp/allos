import { daysBetweenDateStr, isRealIsoDate, shiftDateStr } from "./date";

// A short relapse belongs on the same episode timeline; a later recurrence should be
// recorded as a new episode. `endedAt` is exclusive, so eligibility is measured from
// its last included day (`endedAt` - 1). This also makes an episode ended after today
// immediately reopenable even though its exclusive boundary is tomorrow.
export const EPISODE_REOPEN_WINDOW_DAYS = 7;

export type EpisodeReopenEligibility =
  | { kind: "eligible"; elapsedDays: number }
  | { kind: "ongoing" }
  | { kind: "expired" }
  | { kind: "invalid" };

export function episodeReopenEligibility(
  endedAt: string | null,
  asOf: string
): EpisodeReopenEligibility {
  if (endedAt == null) return { kind: "ongoing" };
  if (!isRealIsoDate(endedAt) || !isRealIsoDate(asOf)) {
    return { kind: "invalid" };
  }
  const lastActiveDay = shiftDateStr(endedAt, -1);
  const elapsedDays = daysBetweenDateStr(lastActiveDay, asOf);
  if (elapsedDays == null || elapsedDays < 0) return { kind: "invalid" };
  if (elapsedDays > EPISODE_REOPEN_WINDOW_DAYS) return { kind: "expired" };
  return { kind: "eligible", elapsedDays };
}
