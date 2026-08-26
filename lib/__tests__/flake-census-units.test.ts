// WHAT UNIT IS THE FLAKE CENSUS COUNTING IN (#2845).
//
// `scripts/flake-census.mjs` printed `hits.length` — a count of ANNOTATIONS — under
// the word "failures", against a denominator counted in MATRICES. A single failing
// Playwright test yields two or three annotations (the assertion line, a `:0` timeout
// line, sometimes a context close), so the headline overstated by two or three in a
// tool whose entire job is keeping people honest about numbers. #2839's census is the
// fixture below: eight annotation lines, four failing matrices, printed as 8 — right
// only for a reader who happened to divide.
//
// The import is also the proof of the CLI entry guard: this module curls GitHub the
// moment it is evaluated without one, and no token is set here.
import { describe, expect, it } from "vitest";

import { failureUnits } from "../../scripts/flake-census.mjs";

/** Annotation records as the census collects them, one per reported line. */
const anns = (
  runId: number,
  headSha: string,
  job: string,
  ...lines: number[]
) =>
  lines.map((line) => ({
    runId,
    headSha,
    job,
    spec: "e2e/sleep-page.spec.ts",
    line,
  }));

// Four failing matrices, each contributing the assertion line and the `:0` timeout.
const CENSUS_2839 = [
  ...anns(101, "aa11", "e2e (3)", 44, 0),
  ...anns(102, "bb22", "e2e (7)", 44, 0),
  ...anns(103, "cc33", "e2e (7)", 44, 0),
  ...anns(104, "dd44", "e2e (2)", 44, 0),
];

describe("flake-census counts failures in matrices, not annotations (#2845)", () => {
  it.each([
    ["#2839's census", CENSUS_2839, { matrices: 4, shards: 4, annotations: 8 }],
    ["a clean streak", [], { matrices: 0, shards: 0, annotations: 0 }],
    [
      "three annotation lines from ONE failing shard",
      anns(200, "ee55", "e2e (5)", 44, 0, 12),
      { matrices: 1, shards: 1, annotations: 3 },
    ],
    [
      "two shards of one matrix",
      [...anns(300, "ff66", "e2e (1)", 44), ...anns(300, "ff66", "e2e (9)", 7)],
      { matrices: 1, shards: 2, annotations: 2 },
    ],
    // A re-run of the same commit is a second, independent exposure, so it must be a
    // second matrix — counting distinct HEAD SHAs here would deflate the numerator
    // while the denominator kept counting runs.
    [
      "a re-run of the same head",
      [
        ...anns(400, "77aa", "e2e (1)", 44),
        ...anns(401, "77aa", "e2e (1)", 44),
      ],
      { matrices: 2, shards: 2, annotations: 2 },
    ],
  ])("%s", (_label, hits, expected) => {
    expect(failureUnits(hits)).toEqual(expected);
  });
});
