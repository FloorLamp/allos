// The stuck-work lease window, in whole minutes. Pure (env only, NO db import) so it
// can be shared by both the hourly tick's reapStuckExtractions (lib/extraction-reaper.ts)
// and the boot-time interrupted-work reset (lib/migrations/boot-tasks.ts) WITHOUT
// creating an import cycle: boot-tasks runs inside createDb()'s boot path, so it must
// not transitively import lib/db. Both age-gate on this window so neither ever fails a
// FRESH in-flight row (issue #461).

// How long a document may sit in 'processing' before the reaper considers its
// extraction wedged. Extractions normally settle in seconds to a couple of minutes;
// 30m is comfortably past the slowest legitimate run (a large multi-page PDF) while
// still freeing a truly-hung row within the hour. Overridable per deploy via env.
export const DEFAULT_EXTRACTION_LEASE_MINUTES = 30;

// Always returns a validated positive integer, so callers can safely interpolate it
// into a `datetime('now', '-N minutes')` modifier.
export function extractionLeaseMinutes(): number {
  const raw = process.env.EXTRACTION_LEASE_MINUTES;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_EXTRACTION_LEASE_MINUTES;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_EXTRACTION_LEASE_MINUTES;
}
