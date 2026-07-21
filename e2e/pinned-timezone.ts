// Deterministic local time-of-day for the frozen e2e clock (the #1103 follow-up).
//
// #1103 froze the app clock (ALLOS_TEST_NOW, lib/clock.ts) at the run's REAL
// start so runtime-written rows — stamped with real UTC by SQL datetime('now')
// defaults — can never lag the frozen instant (the old fixed-noon "morning-UTC
// band"). But that made the frozen LOCAL TIME-OF-DAY whatever hour CI happened
// to start: with the profile timezone defaulting to UTC on runners, any run
// starting 00:00–10:59 UTC froze inside the Morning bucket, where a Morning
// dose can never be past due (lib/medication-today.ts ranks past-due as
// "bucket strictly below the current one"), and medications-page.spec.ts
// failed deterministically for ~11 hours of every day.
//
// This helper closes the loop from the TIMEZONE side instead of the clock side:
// pick the fixed-offset IANA zone in which the frozen instant reads 13:mm
// LOCAL — deterministic early afternoon (the Midday bucket) at every possible
// UTC start hour, with zero skew between real and frozen time preserved.
// offset = 13 − utcHour ∈ [−10 … +13], all valid Etc/GMT zones (note the
// POSIX-inverted sign: Etc/GMT-13 means UTC+13) and none observe DST. Because
// local always lands at 13:mm, the local DATE always equals the frozen
// instant's UTC date — today() and SQL-stamped row dates can never disagree.
export function pinnedTimezone(frozenIso: string): {
  zone: string;
  offsetHours: number;
} {
  const utcHour = new Date(frozenIso).getUTCHours();
  if (!Number.isFinite(utcHour)) return { zone: "UTC", offsetHours: 0 };
  const offsetHours = 13 - utcHour;
  const zone =
    offsetHours === 0
      ? "UTC"
      : offsetHours > 0
        ? `Etc/GMT-${offsetHours}`
        : `Etc/GMT+${-offsetHours}`;
  return { zone, offsetHours };
}
