// THE TIER-WIDE CLOCK FREEZE for the db and action tiers (#4509, owner ruling
// 2026-09-01). Loaded LAST in `setupFiles` by both projects in vitest.db.config.ts,
// so it is the whole tier's default and no spec has to remember anything.
//
// WHAT WAS WRONG. A shipped comment said these tiers freeze the clock; they did not.
// The freeze was per-spec, so any spec that stated a wall time against a JUDGED seam
// was green in the evening and red at lunchtime (#3260's shape). Discipline was
// load-bearing, and discipline only protects the files somebody remembered.
//
// WHICH CONVENTION IS ENDORSED, because the tree had two with no stated preference.
// `vi.setSystemTime` is the one, and lib/clock.ts is why: `now()` reads
// ALLOS_TEST_NOW when it is set and otherwise returns `new Date()`. So a faked Date
// moves the seam AND everything that reads Date directly, while the env var moves
// only the seam and leaves Date real — half a spec pinned, half of it not. The two
// are not rival spellings of one thing; one is strictly stronger.
//
// ALLOS_TEST_NOW IS NOT RETIRED, it is demoted to what only it can do: reach ACROSS
// PROCESSES. The e2e suite pins a separately spawned Next server with it, and no
// in-process timer fake can. What this tier deliberately does NOT do is take its
// instant from an ambient one. Tried and measured, because it looks like the
// consistent thing to do: `now()` checks the env var BEFORE it falls back to Date, so
// an ambient value silently outranks a spec's own `vi.setSystemTime` and the seam and
// Date diverge in exactly the files that pin themselves most carefully — 16 files and
// 104 tests of the tier, against 0 with the same instant applied here. To run the tier
// at some other instant, change the constant below; that moves the fake Date, which is
// the thing every spec here reads through.
//
// TIMERS STAY REAL. `toFake: ["Date"]` fakes the clock and nothing else, so
// setTimeout, promises and Playwright-style waiting behave exactly as before. What a
// spec loses is ELAPSED TIME measured off Date: two reads a second apart return the
// same instant. A spec that genuinely needs real elapsed time says so out loud —
// `usesRealElapsedTime()` below — because the ruling asks an opt-out to be a
// declaration, not a silent default.
//
// WHY LATE IN THE DAY, AND WHY THE DAY STILL MOVES. The failing shape is a fixture
// that states a wall time on `today()` and a core that refuses a FUTURE statement, so
// the safe side of the boundary is "late enough that everything today has already
// happened" — 23:45 UTC is the instant the specs that pinned themselves for this
// reason had already chosen by hand, and this generalises theirs rather than
// inventing a new one. The DATE tracks the real calendar on purpose: SQLite's own
// `datetime('now')` reads the real clock and no JS fake can reach it, so a fixed
// calendar day would drift away from every raw SQL stamp a little further each day.
//
// AND LATE IS ALSO WHAT KEEPS THAT UNREACHABLE SQL CLOCK CLOSE. The gap between this
// instant and SQL's is `23:45 minus the hour the run started`, so it is at worst 15
// minutes NEGATIVE and otherwise positive. The sign is what matters: a run of the tier
// with this constant set to `00:05:00.000Z` — a ~12h negative gap — reds 8 files and 31
// tests, mostly token and session expiries seeded in JS and judged against SQL's clock,
// while the same magnitude of POSITIVE gap reds none of them. A midday constant would
// sit in the middle of the harmful half.

import { afterAll, beforeAll, beforeEach, vi } from "vitest";

// The frozen wall time, on whatever the current UTC day is.
export const FROZEN_WALL_TIME_UTC = "23:45:00.000Z";

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
afterAll(() => vi.useRealTimers());

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
