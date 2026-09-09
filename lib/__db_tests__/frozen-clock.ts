// Default Date freeze for the DB/action tiers. Timers remain real, and each test
// starts from one captured UTC day. Use vi.setSystemTime for a test-specific instant.
// SQLite retains its real clock; tests comparing it with JavaScript timestamps must
// use the explicit real-clock opt-out below. Do not move the tier freeze to satisfy
// comparisons between different clocks.
//
// The late wall time supports same-day statements while leaving more than the
// stated-time future skew before midnight. SQLite can trail it by up to 23h50m;
// the full positive-gap range has not been measured. Use the real-clock opt-out
// for JS/SQL expiry comparisons instead of assuming a smaller gap.
// Ordinary fixtures use vi.setSystemTime. Only tests contrasting the app clock
// with Date should set the cross-process ALLOS_TEST_NOW override explicitly.

import { afterAll, beforeAll, beforeEach, vi } from "vitest";

// Clear inherited overrides before spec modules and their fixtures load.
delete process.env.ALLOS_TEST_NOW;

// Late enough for ordinary same-day fixtures, with room to test future-time refusal.
export const FROZEN_WALL_TIME_UTC = "23:50:00.000Z";

/** The default frozen instant for a UTC day. Exported for ./frozen-clock.test.ts. */
export function frozenInstantForDay(day: string): Date {
  return new Date(`${day}T${FROZEN_WALL_TIME_UTC}`);
}

/**
 * The instant this tier freezes at. Captured ONCE per worker process, before anything
 * fakes Date, so a run that straddles real midnight cannot hand two files in the same
 * worker different days.
 */
export const TIER_FROZEN_INSTANT = frozenInstantForDay(
  new Date().toISOString().slice(0, 10)
);

function freeze(): void {
  delete process.env.ALLOS_TEST_NOW;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TIER_FROZEN_INSTANT);
}

// beforeAll so a spec's own `beforeAll` fixtures are seeded on the frozen clock;
// beforeEach so a spec that moves the clock in one test starts the next one back at
// the tier's instant rather than carrying that test's instant into the next.
beforeAll(freeze);
beforeEach(freeze);

// Registered LAST, so this runs FIRST on the way out (vitest unwinds `afterAll` in
// reverse): the tier setup's own teardown — temp-directory discard, and the next
// file's reseed — is back on the real clock before it runs. lib/__tests__/tmp-dir.ts
// unlinks by mtime AGE, and a frozen Date would mis-age every entry it considers.
afterAll(() => {
  delete process.env.ALLOS_TEST_NOW;
  vi.useRealTimers();
});

/**
 * Declare that this spec needs REAL elapsed time, and opt it out of the tier freeze.
 *
 * Call it at module scope. The hooks it registers run after the tier's, so the clock
 * is real again by the time the spec's own hooks and tests run.
 *
 * `reason` is required and unused on purpose: an opt-out that costs nothing to write
 * is a silent default with extra steps, and the next reader needs the sentence more
 * than the runtime does.
 */
export function usesRealElapsedTime(reason: string): void {
  void reason;
  beforeAll(() => vi.useRealTimers());
  beforeEach(() => vi.useRealTimers());
}
