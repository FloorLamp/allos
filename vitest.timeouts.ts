// Shared non-browser test and hook limits. CI keeps the default; local agent
// gates may allow more time on a contended development machine. Per-test limits
// detect hangs; comparable tier timings are better for gradual slowdown.
// See docs/internals/test-tier-timeouts.md for diagnosis and measurement policy.
const DEFAULT_TEST_TIMEOUT_MS = 15_000;

// agent-gates.sh defaults this local override to 60,000 ms. A truthy CI value
// disables the override so local contention allowances cannot relax CI's default.
const OVERRIDE_ENV = "ALLOS_VITEST_TIMEOUT_MS";

/** Resolve the run's per-test limit from its environment, in milliseconds. */
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

// Setup and teardown receive twice the test budget, including local overrides.
export const hookTimeout = testTimeout * 2;

/** Default per-test ceiling used when CI is set. */
export const CI_TEST_TIMEOUT_MS = DEFAULT_TEST_TIMEOUT_MS;

/**
 * Scale one exceptional test's limit with the tier. Record the duration and
 * rationale at the call site: "worst" names the slowest observed run; "green"
 * means only a passing-run reading is available. Basis does not affect the math.
 */
export function perTestCeiling(
  multiple: number,
  basis: "worst" | "green"
): number {
  void basis;
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

// Event-loop utilization separates mostly waiting from busy-loop observations.
const IDLE_UTILIZATION = 0.25;

/**
 * Describe a test timeout, or return null for other results. Utilization is a
 * diagnostic clue: it cannot prove a hang or separate computation from contention.
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
