// THE CI CEILING CANNOT BE OVERRIDDEN — the executable half of #3436's design.
//
// Both vitest tiers take their per-test ceiling from vitest.timeouts.ts, and the
// design is a division of labour: the orchestration gate PERMITS at 60 000 ms so
// a loaded box stops manufacturing reds, and CI DETECTS at 15 000 ms because CI
// is the quiet environment. That only holds while CI actually keeps the strict
// number. If `ALLOS_VITEST_TIMEOUT_MS` ever reached a runner — exported by a
// workflow, inherited from a shell, copied out of agent-gates.sh into a job —
// the detector would silently become the permitter: every tier still green, and
// nothing anywhere to notice that the strict half had gone.
//
// That is the failure shape this repo keeps finding: a claim that reads
// correctly and that nothing can see. A comment saying "and nothing in CI sets
// it" is exactly such a claim, so the guard is a test instead.
import { describe, expect, it } from "vitest";
import {
  CI_TEST_TIMEOUT_MS,
  describeTimeout,
  hookTimeout,
  perTestCeiling,
  resolveTestTimeoutMs,
  testTimeout,
} from "../../vitest.timeouts";

describe("the vitest per-test ceiling", () => {
  it("ignores the orchestration override whenever CI is set", () => {
    // The mutation this exists to catch: drop the `env.CI` check in
    // vitest.timeouts.ts and this returns 60000.
    expect(
      resolveTestTimeoutMs({ CI: "true", ALLOS_VITEST_TIMEOUT_MS: "60000" })
    ).toBe(CI_TEST_TIMEOUT_MS);

    // GitHub Actions sets CI=true, but any non-empty value must count — a guard
    // that only recognised one spelling would be the same silent hole.
    for (const ci of ["true", "1", "yes", "TRUE"]) {
      expect(
        resolveTestTimeoutMs({ CI: ci, ALLOS_VITEST_TIMEOUT_MS: "60000" })
      ).toBe(CI_TEST_TIMEOUT_MS);
    }
  });

  it("honours the override off CI, which is the whole point of having it", () => {
    expect(resolveTestTimeoutMs({ ALLOS_VITEST_TIMEOUT_MS: "60000" })).toBe(
      60_000
    );
    expect(resolveTestTimeoutMs({})).toBe(CI_TEST_TIMEOUT_MS);
  });

  it("falls back to the strict ceiling on a value that is not a positive number", () => {
    // `Number("")` is 0 and `Number("sixty")` is NaN. Vitest reads NaN as NO
    // timeout, so a typo would remove the ceiling rather than widen it — the
    // one failure direction worse than the bug this module fixes.
    for (const raw of ["", "sixty", "-1", "0", "NaN", "Infinity"]) {
      expect(resolveTestTimeoutMs({ ALLOS_VITEST_TIMEOUT_MS: raw })).toBe(
        CI_TEST_TIMEOUT_MS
      );
    }
  });

  it("exports the value the resolver actually produces for this run", () => {
    // Ties the exported constants — the ones the configs import — to the
    // function the assertions above check, so the guard cannot be true of a
    // resolver nothing uses.
    expect(testTimeout).toBe(resolveTestTimeoutMs(process.env));
    expect(hookTimeout).toBe(testTimeout * 2);
  });

  it("gives this very run the strict ceiling when it is running on CI", () => {
    // The end-to-end statement, asserted only where it is meaningful: on a CI
    // runner the configs must be holding 15 000 ms no matter what is exported.
    if (!process.env.CI) return;
    expect(testTimeout).toBe(CI_TEST_TIMEOUT_MS);
  });
});

// A PER-TEST CEILING MUST STILL BE A MULTIPLE (#3986). A hard-coded literal is
// immune to the override above, which is how the seed-shape specs — the ones that
// block on real child processes and needed the escape hatch most — ended up as the
// only tests it could not reach.
describe("a per-test ceiling stated as a multiple", () => {
  it("scales with whichever ceiling this run resolved", () => {
    expect(perTestCeiling(2, "worst")).toBe(testTimeout * 2);
    expect(perTestCeiling(1, "green")).toBe(testTimeout);
    // The basis is a claim about the reading, never about the arithmetic: two calls
    // that differ only there must produce the same number, or a reader would start
    // deriving margins from the word instead of from the measurement beside it.
    expect(perTestCeiling(3, "green")).toBe(perTestCeiling(3, "worst"));
  });

  it("cannot be written without saying which reading it was derived from", () => {
    // #3999 derived migration-reentry's ceiling from a 3 505 ms GREEN reading while
    // recording, in the same comment, that the test had crossed 15 000 ms on main —
    // 2x the observed worst where the rule asks ~4x. Both kinds of call looked
    // identical in the source (#4002), so the basis is required rather than asked
    // for, and this is what holds that shut.
    // @ts-expect-error the basis argument is mandatory
    expect(perTestCeiling(2)).toBe(testTimeout * 2);
  });
});

// WHAT A TIMEOUT WAS, said where the reporter cannot say it. The cases below drive
// the formatter directly rather than forging a real timeout, so this file never
// prints the sentence the log's one real occurrence uses.
describe("describing a timeout", () => {
  const base = { ceilingMs: 15_000, wallMs: 15_004, utilization: 1 };

  it.each([
    ["an assertion failure", "expected 1 to be 2", 1],
    ["a hook failure", "Hook timed out in 30000ms.", 1],
    ["a clean pass", undefined, 1],
  ])("stays silent on %s", (_name, message, utilization) => {
    expect(describeTimeout({ ...base, message, utilization })).toBeNull();
  });

  it.each([
    // An idle loop is an await that never settled; a busy one is work, or a worker
    // that lost the CPU. Both time out, and only one of them is anybody's bug.
    [0.006, "WAITING", "RUNNING"],
    [1, "RUNNING", "WAITING"],
  ])(
    "reads utilization %s as %s and not as %s",
    (utilization, says, notSays) => {
      const line = describeTimeout({
        ...base,
        utilization,
        message: "Test timed out in 15000ms.",
      });
      expect(line).toContain("NO ASSERTION FAILED");
      expect(line).toContain(says);
      expect(line).not.toContain(notSays);
    }
  );
});
