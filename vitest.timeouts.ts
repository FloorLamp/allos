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
// it still fails a regression that makes the slowest test ~4x slower, or an
// ordinary test ~13x slower, which is the size of regression this instrument can
// honestly detect. Gradual tier-wide slowdown is CI's whole-tier wall time, and
// that is stable enough to read: 100 sampled `test-db` jobs from 18-21 Aug 2026
// ran a median 153 s, p95 167 s, max 181 s — max/median 1.18x, on 99 distinct
// ephemeral runners. CI co-schedules nothing, so a strict ceiling there is a
// tripwire rather than a flake generator.
//
// RE-DERIVE, do not nudge. Run a tier alone with
// `--testTimeout=120000 --reporter=json` and read the slowest test back out. If a
// worst case has crept past ~5 000 ms, fix that test rather than raise this: the
// DB tier's slowest specs replay the whole migration chain per test, and that
// chain grows with every merge (#3436).
const DEFAULT_TEST_TIMEOUT_MS = 15_000;

// ORCHESTRATION-BOX ESCAPE HATCH, in milliseconds, set by
// `scripts/orchestration/agent-gates.sh` and by nothing in CI.
//
// Up to five agents share four cores on the dispatch box. The DB tier measured
// there took 862 s instead of 161 s at load average 18.1 — 5.35x on wall time,
// 5.7x at the per-test p99, worst single test 16 308 ms. The cost is sharply
// non-linear: the same tier at load 11 finished in 220 s and needed no allowance
// at all. One knob covers both tiers because both are vitest on the same four
// cores; the contention is a property of the box, not of a suite.
export const testTimeout = Number(
  process.env.ALLOS_VITEST_TIMEOUT_MS ?? DEFAULT_TEST_TIMEOUT_MS
);

// Vitest ships hookTimeout at 2x testTimeout, and the ratio is load-bearing:
// 433 of the DB tier's files do their setup in a `beforeAll`/`beforeEach`, so a
// hook ceiling left at its 10 000 ms default while the test ceiling moved would
// simply become the new binding constraint — and it fails with a different
// sentence ("Hook timed out in 10000ms") that no runbook describes.
export const hookTimeout = testTimeout * 2;
