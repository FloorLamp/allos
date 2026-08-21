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
  hookTimeout,
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
