import { tzOffsetMs } from "./date";

// Timezone resolution shared by lib/settings.getTimezone (request paths) and
// lib/db.appTimezone (the day-boundary source, read inline to avoid a settings→db
// import cycle). Keeping the decision here means the two entry points can't drift.

// App timezone fallback when neither a per-profile nor an instance-default zone is
// set (or the stored value is invalid).
export const DEFAULT_TIMEZONE = "UTC";

// True for a real IANA zone. Catches both bad names and impossible ones, and
// accepts aliases that Intl.supportedValuesOf omits.
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// UTC offset for an IANA timezone at a specific instant, in whole minutes and
// DST-aware. Reuse the cached wall-clock calculation used by date helpers.
export function timezoneOffsetMinutes(
  timezone: string,
  at: Date
): number | null {
  try {
    const offset = tzOffsetMs(timezone, at);
    return Number.isFinite(offset) ? Math.round(offset / 60_000) || 0 : null;
  } catch {
    return null;
  }
}

export function formatTimezoneOffset(timezone: string, at: Date): string {
  const totalMinutes = timezoneOffsetMinutes(timezone, at);
  if (totalMinutes === null) return "UTC";
  const sign = totalMinutes < 0 ? "−" : "+";
  const absolute = Math.abs(totalMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

// Resolve the effective timezone from the two stored candidates: the per-profile
// setting wins, then the instance default, then DEFAULT_TIMEZONE — and an invalid
// stored value falls through to DEFAULT_TIMEZONE rather than throwing. Callers read
// the profile value first and may skip reading the instance default when it's
// present (a nullish `instanceTz` is fine here).
export function resolveTimezone(
  profileTz: string | undefined,
  instanceTz: string | undefined
): string {
  const v = profileTz ?? instanceTz;
  return v && isValidTimezone(v) ? v : DEFAULT_TIMEZONE;
}
