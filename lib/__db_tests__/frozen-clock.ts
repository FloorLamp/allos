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
//
// AND THE NEGATIVE HALF IS NOW ONE MINUTE, NOT A QUARTER-HOUR (#4837). Everything
// above stands; this amends its one unchecked step. The paragraph measures the
// negative gap at "at worst 15 minutes" and stops, because it was weighing the gap's
// SIGN against its MAGNITUDE. Nothing had asked whether 15 minutes was small enough
// for the tolerances written down: `auth.test.ts:346` allows 1000 ms, so the tier was
// red from 23:45:01 to 23:59:59 UTC every day — four open PRs at once, one assertion,
// no relevant diff between them.
//
// THE WALL TIME IS PINNED BETWEEN TWO ASSERTIONS, AND THEY ARE THE SAME QUANTITY.
// Write W for the wall time as ms after midnight and r for the real time of day, so
// the freeze leads SQLite's clock by L = W - r.
//
//   UPPER  `auth.test.ts:326` allows 29 of a 30-day TTL while reading `Date.now()`
//          off this clock, so L must stay under 86_400_000 ms. L is largest at a run
//          starting at midnight, where it is W. Headroom H = 86_400_000 - W.
//   LOWER  `auth.test.ts:346` needs L positive. L goes negative once r passes W, so
//          the day's last 86_400_000 - W ms are red. Residual R = 86_400_000 - W.
//
// H AND R ARE THE SAME NUMBER. Every millisecond of headroom bought at the top is a
// millisecond of nightly red at the bottom; there is no setting that widens both, and
// picking an endpoint just moves which end is thin. 23:45 spent 900_000 ms on each.
// 23:59:59.999 would cut the residual to 1 ms and leave the cap cleared by 1 ms, which
// no later edit could survive.
//
// AND THE RESIDUAL HAS A FLOOR THAT IS NOT ABOUT CLOCKS AT ALL, which is what stops
// this being pushed to the end of the day. `STATED_FUTURE_SKEW_MS` is 5 minutes, and a
// spec that exercises a REFUSED future statement has to name a time that is later than
// the frozen now, past that skew, and STILL ON THE FROZEN DAY —
// bristol-stool-write.test.ts does exactly this. So 86_400_000 - W must exceed the skew
// with room to express it, or that verdict becomes unreachable and the fixture quietly
// tests something else. That floor is 5 minutes before any clock argument is made.
//
// 600_000 ms is the choice: 2x the skew, so a future statement has 5 minutes of room to
// live in; 20x SQLite's one-second truncation at the cap; and a third off the nightly
// window, which is the honest size of this fix rather than the fifteenfold it looks
// like it should be.
//
// WHAT IS TRADED, PLAINLY: the tier is still wrong for the last ten minutes of each UTC
// day, plus however long a run takes to reach a SQL-judged assertion after it starts.
// That residual is irreducible while the freeze is a fixed instant and SQLite's clock
// is not — shrinking it further thins the cap by the same amount AND walks into the
// skew floor above.
//
// AND ROLLING TO THE NEXT DAY IS NOT THE ANSWER, though it looks like it. It makes L
// positive everywhere, and it decouples the frozen DATE from SQL's for the same 15
// minutes: measured on the full tier with the frozen day one ahead, it moved the red
// rather than removing it — history-gather.test.ts and dose-lifecycle.test.ts read a
// day off the real clock at MODULE scope, before these hooks run, and
// attention-flagged-window.test.ts seeds `datetime('now', ?)` against a
// `today(profileId)` query. Keeping the date equal to the real one is why this moves
// the wall time instead.

import { afterAll, beforeAll, beforeEach, vi } from "vitest";

// The frozen wall time, on whatever the current UTC day is. Its distance from
// midnight is the whole design — see the interval arithmetic above.
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
