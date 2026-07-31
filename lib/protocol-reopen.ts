import { daysBetweenDateStr, isRealIsoDate } from "./date";

// A recently-ended protocol is the same run resumed; after a week, preserving the
// finished comparison window and starting a new row is the honest history.
// Protocol end_date is INCLUSIVE, so elapsed time is measured directly from it.
export const PROTOCOL_REOPEN_WINDOW_DAYS = 7;

export type ProtocolReopenEligibility =
  | { kind: "eligible"; elapsedDays: number }
  | { kind: "ongoing" }
  | { kind: "expired" }
  | { kind: "invalid" };

export function protocolReopenEligibility(
  endedAt: string | null,
  asOf: string
): ProtocolReopenEligibility {
  if (endedAt == null) return { kind: "ongoing" };
  if (!isRealIsoDate(endedAt) || !isRealIsoDate(asOf)) {
    return { kind: "invalid" };
  }
  const elapsedDays = daysBetweenDateStr(endedAt, asOf);
  if (elapsedDays == null || elapsedDays < 0) return { kind: "invalid" };
  if (elapsedDays > PROTOCOL_REOPEN_WINDOW_DAYS) return { kind: "expired" };
  return { kind: "eligible", elapsedDays };
}
