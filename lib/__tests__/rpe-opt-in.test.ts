import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #3335 — the set grid's effort column is opted into, and the opt-in is STRUCTURAL.
//
// A boolean consulted in five places is the shape that drifts: the fifth place ships
// without the check and nobody notices, because nothing about a boolean says it was
// supposed to be asked. So the render-shaped value itself is the seam — `RpeTracking`,
// branded, minted on one branch of one module, and REQUIRED by `stepRpe`, which is the
// only way to compute what a tap on the control does. A surface holding null has
// nothing to render rather than a check it might forget. This is #3323's cap boundary
// re-instantiated (docs/internals/substances.md, "Where the opt-in boundary is").
//
// "DID A SECOND PRODUCER APPEAR" IS AN eslint.config.mjs RULE NOW (#5347): the minter
// may be imported only by the seam module, nothing may cast past the brand, and the
// stored key has one spelling — each grandfathered site carries its reason on its own
// disable line. What is left here is the shape of the seam itself, which no selector can
// read: that the mint sits on ONE branch, and that the two signatures either side of the
// opt-in still say what makes the null mean something.
//
// The RUNTIME halves live where they can be observed:
//   - lib/__db_tests__/rpe-column-opt-in.test.ts — the row is the seam, and the
//     back-fill hands the column to profiles that were already logging RPE;
//   - e2e/rpe-logging.spec.ts — the column is absent until opted in, the opt-in is one
//     tap inside the editor, and the set row's tab order is the same either way.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const SCALE_MODULE = "lib/rpe.ts";
const SEAM_MODULE = "lib/rpe-tracking.ts";

describe("the RPE opt-in seam is structural — source claims (#3335)", () => {
  it("source: the seam module mints on exactly one branch", () => {
    const seam = read(SEAM_MODULE);
    expect(seam.match(/mintRpeTracking\(\)/g) ?? []).toHaveLength(1);
    // …and that one call is reached only when the profile's row was found. Any other
    // production path to a tracking would have to go through `getRpeTracking`, which
    // is this ternary.
    expect(seam).toMatch(/getProfileSetting\([\s\S]*?\)\s*!=\s*null/);
  });

  // `stepRpe` is what makes the null MEAN something: a surface with no tracking cannot
  // work out what a tap would do, so it has no control to offer. If this argument ever
  // goes optional the opt-in becomes cosmetic and every one of the claims above still
  // passes.
  it("source: computing the next rating requires a tracking", () => {
    expect(read(SCALE_MODULE)).toMatch(
      /export function stepRpe\(\s*tracking: RpeTracking,/
    );
  });

  // The write boundary must NOT take one. A profile that opted out still edits sessions
  // whose sets carry a rating, and that rating rides back through the save untouched —
  // opting out hides the column, it is not a delete.
  it("source: the write boundary canonicalizes without consulting the opt-in", () => {
    expect(read(SCALE_MODULE)).toMatch(
      /export function canonicalRpe\(v: number \| null \| undefined\)/
    );
  });
});
