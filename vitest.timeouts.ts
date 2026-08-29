// PER-TEST CEILINGS FOR BOTH NON-BROWSER TIERS, derived rather than inherited.
//
// Both `vitest.config.ts` (pure) and `vitest.db.config.ts` (DB + action) ran on
// vitest's implicit 5 000 ms default. Nobody chose that number for these suites,
// and measuring it (#3436) showed both had grown under it until a single slow
// fixture would tip them — on an IDLE box, not merely a loaded one.
//
// Measured 2026-08-21 on a 4-core box, each tier running ALONE:
//
//   tier   files/tests    wall    p99      p99.9    WORST SINGLE TEST
//   pure    980 / 15775    57 s    85 ms   1 119 ms  3 863 ms  stateful-writes
//   db      761 /  6489   161 s   768 ms   1 155 ms  3 407 ms  video.actions
//
// So the stock ceiling gave the pure tier's worst test 1.29x of headroom and the
// DB tier's 1.47x, on a quiet machine. Those are not ceilings; they are coin
// flips. The pure tier has already lost one on a CI runner —
// `lib/__tests__/e2e-fixture-time.test.ts`, `Test timed out in 5000ms`.
//
//   15 000 ms = 3.9x the pure tier's worst measured test
//             = 4.4x the DB tier's worst measured test
//             = ~13x either tier's measured p99.9
//
// A per-test ceiling is a HANG detector, not a performance budget. At 15 000 ms
// it still fails a regression that makes an ordinary test ~13x slower, which is
// the size of regression this instrument can honestly detect on the 17 395 pure
// and 6 930 DB tests that finish inside a second. Gradual tier-wide slowdown is
// CI's whole-tier wall time, and that is stable enough to read: `test-unit` over
// 59 sampled runs on 28-29 Aug 2026 ran a median 231 s, p90 243 s, max 257 s;
// `test-db` a median 185 s, p90 192 s, max 209 s.
//
// WHAT THE STABLE JOB TIME DOES NOT SAY, and what this file used to infer from it
// (#3986). The sentence here read "CI co-schedules nothing, so a strict ceiling
// there is a tripwire rather than a flake generator", with 1.18x max/median as its
// evidence. That ratio is a JOB-level number and it is still true. The per-TEST
// number underneath it is not: measured on the same commit, the same runner image
// and five minutes apart (43bdc712, CI attempts 1 and 2), the pure tier's total
// test time moved 1.03x — 420 158 ms against 408 970 ms — while INDIVIDUAL files
// moved much further, and `test-db` between two green runs moved 3.11x on
// migration-snapshot (3 167/1 017 ms) and 3.59x on restore (1 793/500 ms).
//
// The tier is not slower on a bad run; the WORK IS DEALT OUT DIFFERENTLY. Vitest
// packs files onto workers dynamically, and both configs here run TWO pools at
// once — a `threads` pool for the shared projects and a `forks` pool for the
// isolated ones (vitest's default pool) — each sized independently to
// `availableParallelism()`. On a 4-vCPU `ubuntu-latest` runner that is up to 8
// workers plus the vitest main process, plus the `node --import tsx` children the
// two seed-shape DB specs spawn. Which files are co-resident when a heavy one runs
// is therefore a property of the run, not of the commit — so a test's wall time is
// a reading of how much CPU it got, and that reading disperses 3-4x.
//
// SO THE "~4x THE WORST MEASURED TEST" RULE IS RIGHT AND ITS INPUT WAS WRONG. The
// worst case has to be measured ON CI, and the margin has to cover the per-test
// dispersion CI actually shows (3-4x), not the job-level 1.18x. Measured on CI at
// 43bdc712 against a solo run of the same test on a 4-core box:
//
//   test                                     solo     CI green    CI red   ceiling
//   nav-routes.test.ts:332                  2 687 ms   12 746 ms  16 919 ms  15 000  <- crossed
//   strip-comments oracle sweep            ~12 000 ms 118 700 ms 118 279 ms 120 000  <- 98.9% used
//   migration-reentry first test            3 004 ms    3 505 ms  >15 000 ms 15 000  <- crossed
//
// The two that crossed were not slow tests creeping up on their limits; they were
// tests whose ceiling had never been measured against the environment that
// enforces it. The tier default below stays STRICT, because it is honest for
// everything that finishes inside a second. The handful of whole-tree scanners and
// migration replays that do not are given an explicit ceiling at their call site,
// each with its own CI reading written beside it, through `perTestCeiling` below.
//
// RE-DERIVE, do not nudge. Run a tier alone with
// `--testTimeout=120000 --reporter=json` and read the slowest test back out, then
// read the same test's duration out of a GREEN CI job log and use THAT. If a worst
// case has crept past ~5 000 ms solo, fix that test rather than raise this: the
// DB tier's slowest specs replay the whole migration chain per test, and that
// chain grows with every merge (#3436).
const DEFAULT_TEST_TIMEOUT_MS = 15_000;

// ORCHESTRATION-BOX ESCAPE HATCH, in milliseconds, set by
// `scripts/orchestration/agent-gates.sh` and IGNORED WHEN `CI` IS SET.
//
// Up to five agents share four cores on the dispatch box. The DB tier measured
// there took 862 s instead of 161 s at load average 18.1 — 5.35x on wall time,
// 5.7x at the per-test p99, worst single test 16 308 ms. The cost is sharply
// non-linear: the same tier at load 11 finished in 220 s and needed no allowance
// at all. One knob covers both tiers because both are vitest on the same four
// cores; the contention is a property of the box, not of a suite.
//
// THE `CI` CHECK IS THE WHOLE DESIGN, NOT A PRECAUTION. This split only works as
// a division of labour: the GATE PERMITS at 60 000 ms so a loaded box stops
// manufacturing reds, and CI DETECTS at the strict number. If the variable ever
// reached a CI runner, the detector would silently become the permitter — every
// tier still green, nothing anywhere to notice, and the strict half of the design
// gone. So CI does not get to be overridden, and `vitest-timeouts.test.ts` holds
// that shut rather than a comment asking nicely. (CI is not the QUIET environment
// this used to claim — see the dispersion measurement above — it is the one whose
// verdict counts, which is a different reason for the same rule.)
const OVERRIDE_ENV = "ALLOS_VITEST_TIMEOUT_MS";

/**
 * The per-test ceiling this run should use, in milliseconds.
 *
 * Takes its environment as an argument so the guard above is testable without
 * mutating `process.env` — and so the export below cannot drift from the thing
 * the test checks.
 */
export function resolveTestTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  if (env.CI) return DEFAULT_TEST_TIMEOUT_MS;
  const raw = env[OVERRIDE_ENV];
  if (raw === undefined) return DEFAULT_TEST_TIMEOUT_MS;
  // A typo'd value must not become NaN: vitest reads NaN as "no timeout", which
  // would remove the ceiling entirely — the failure this whole module prevents.
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TEST_TIMEOUT_MS;
}

export const testTimeout = resolveTestTimeoutMs();

// Vitest ships hookTimeout at 2x testTimeout, and the ratio is load-bearing:
// 433 of the DB tier's files do their setup in a `beforeAll`/`beforeEach`, so a
// hook ceiling left at its 10 000 ms default while the test ceiling moved would
// simply become the new binding constraint — and it fails with a different
// sentence ("Hook timed out in 10000ms") that no runbook describes.
export const hookTimeout = testTimeout * 2;

/** The strict ceiling CI must always get, exported so the guard test can name it. */
export const CI_TEST_TIMEOUT_MS = DEFAULT_TEST_TIMEOUT_MS;

/**
 * A ceiling for ONE test, expressed as a multiple of the tier ceiling.
 *
 * WHY A MULTIPLE AND NOT A LITERAL (#3986). A hard-coded `}, 30_000)` is immune to
 * `ALLOS_VITEST_TIMEOUT_MS`, so the one lever the harness offers does not reach the
 * specs that need it most — the seed-shape files, which spawn real `node` children
 * and were the tier's most frequent local red on the dispatch box. Written as a
 * multiple, a per-test cap scales with whichever half of the design is in force:
 * strict on CI, permissive under `agent-gates.sh`.
 *
 * State the multiple against a MEASUREMENT at the call site, never on its own.
 */
export function perTestCeiling(multiple: number): number {
  return Math.round(testTimeout * multiple);
}

/** What a finished test looked like, as the reporter cannot see it. */
export interface TimeoutObservation {
  /** The `Test timed out in …` message vitest attached, or undefined if none. */
  message: string | undefined;
  /** The test's own ceiling, in ms. */
  ceilingMs: number;
  /** Wall clock the test actually consumed, in ms. */
  wallMs: number;
  /**
   * `performance.eventLoopUtilization()` over the test, measured IN THE WORKER —
   * per event loop, so it is this test's thread and not the whole process.
   */
  utilization: number;
}

// HOW LOUD A TEST HAS TO BE BEFORE THIS SAYS ANYTHING, as a fraction of its own
// ceiling. Only a test that actually TIMED OUT is described; the threshold exists
// so a future caller cannot make this chatty by accident.
const IDLE_UTILIZATION = 0.25;

/**
 * One paragraph naming what a timeout WAS, or `null` when the test did not time
 * out. Pure, so `vitest-timeouts.test.ts` can drive it without forging a timeout —
 * which also means the real signal is never buried under its own fixture's copies.
 *
 * THE DISCRIMINATOR IS EVENT-LOOP UTILIZATION, and it is the question a reader of a
 * red tier actually has. A test that awaited something that never settled — an
 * unresolved promise, a real-time await under fake timers — leaves its loop IDLE,
 * measured at 0.006 on a probe. A test that was computing, or that was descheduled
 * while computing, leaves it at 1.0. The first is a hang and belongs to whoever
 * touched the test; the second is the box, and re-running it is not a diagnosis.
 */
export function describeTimeout(o: TimeoutObservation): string | null {
  if (!o.message?.startsWith("Test timed out in")) return null;
  const idle = o.utilization < IDLE_UTILIZATION;
  return [
    `[timeout] NO ASSERTION FAILED. This test hit its ${o.ceilingMs} ms ceiling ` +
      `after ${Math.round(o.wallMs)} ms; a wrong value would have failed instead.`,
    idle
      ? `  Its event loop was IDLE ${Math.round((1 - o.utilization) * 100)}% of that time: it was WAITING, ` +
        `not working. Look for an await that never settles, or fake timers over a real-time await.`
      : `  Its event loop was BUSY ${Math.round(o.utilization * 100)}% of that time: it was RUNNING, not ` +
        `waiting. Either the work grew, or the worker did not get the CPU — see vitest.timeouts.ts (#3986).`,
  ].join("\n");
}
