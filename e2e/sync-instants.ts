import { utcInstant } from "../lib/date";

/**
 * THE derivation for a seeded `integration_sync_events.at`, shared by the seed that
 * WRITES those rows (e2e/seed/*, run standalone under tsx) and the specs that read
 * them back (which compare on the exact string).
 *
 * Sync freshness is minute-grain SILENCE since #2263 — a connected source whose last
 * success is older than its declared tolerance reads "Sync failing" — so a fixture
 * stamped at a fixed time of day is healthy or broken depending on the hour CI happened
 * to start. Every seeded run is therefore placed relative to the run's frozen clock.
 *
 * The clock is passed in rather than read here, because the two processes reach the
 * same frozen instant by different routes: the seed through lib/clock's ALLOS_TEST_NOW
 * seam, a spec through `frozenNow()` (which also reads the run-context file a worker
 * process gets it from). One formula, one convention ('YYYY-MM-DDTHH:MM:SSZ', #2205 /
 * migration 163), two callers.
 */
export function syncInstantBefore(clock: Date, hoursAgo: number): string {
  return utcInstant(new Date(clock.getTime() - hoursAgo * 3600_000));
}
