import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
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
// EVERY TEST HERE IS A SOURCE CLAIM AND IS NAMED AS ONE (#3300). The source tier is the
// right tier for "did a second producer appear", which genuinely is a question about
// source. The RUNTIME halves live where they can be observed:
//   - lib/__db_tests__/rpe-column-opt-in.test.ts — the row is the seam, and the
//     back-fill hands the column to profiles that were already logging RPE;
//   - e2e/rpe-logging.spec.ts — the column is absent until opted in, the opt-in is one
//     tap inside the editor, and the set row's tab order is the same either way.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Spelled this way, rather than as a string escape, so THIS file stays plain text and
// never has to appear in the deliberate-NUL registry (#3206).
const NUL = String.fromCharCode(0);
const sourceCache = new Map<string, string>();

function read(rel: string): string {
  let source = sourceCache.get(rel);
  if (source === undefined) {
    source = readFileSync(path.join(REPO, rel), "utf8");
    sourceCache.set(rel, source);
  }
  return source;
}

function trackedSources(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split(NUL)
    .filter(Boolean)
    .filter((rel) => /\.tsx?$/.test(rel))
    .sort();
}

const SCALE_MODULE = "lib/rpe.ts";
const SEAM_MODULE = "lib/rpe-tracking.ts";

// A test may mint a tracking directly — it is asserting on the scale, not deciding who
// gets one. Production may not, and that is the whole point of the census below.
const isTest = (rel: string) =>
  rel.includes("__tests__") ||
  rel.includes("__db_tests__") ||
  rel.includes("__action_tests__") ||
  rel.startsWith("e2e/");

const productionFiles = trackedSources().filter((rel) => !isTest(rel));

describe("the RPE opt-in seam is structural — source claims (#3335)", () => {
  it("source: exactly one production module imports the minter", () => {
    const importers = productionFiles.filter(
      (rel) => rel !== SCALE_MODULE && /\bmintRpeTracking\b/.test(read(rel))
    );
    expect(importers).toEqual([SEAM_MODULE]);
  });

  it("source: the seam module mints on exactly one branch", () => {
    const seam = read(SEAM_MODULE);
    expect(seam.match(/mintRpeTracking\(\)/g) ?? []).toHaveLength(1);
    // …and that one call is reached only when the profile's row was found. Any other
    // production path to a tracking would have to go through `getRpeTracking`, which
    // is this ternary.
    expect(seam).toMatch(/getProfileSetting\([\s\S]*?\)\s*!=\s*null/);
  });

  it("source: nothing outside the scale module casts its way past the brand", () => {
    const casters = productionFiles.filter(
      (rel) => rel !== SCALE_MODULE && /\bas\s+RpeTracking\b/.test(read(rel))
    );
    expect(casters).toEqual([]);
  });

  // The stored key is an identity. Two spellings of it would be two opt-ins, which is
  // the same drift by another route — so the literal appears only where the seam is
  // defined and where the one-time back-fill writes it.
  it("source: the opt-in key is spelled in one place, plus its back-fill migration", () => {
    const spellers = productionFiles.filter((rel) =>
      /["']strength_rpe["']/.test(read(rel))
    );
    expect(spellers).toEqual([
      "lib/migrations/versions/20260820-rpe-column-opt-in.ts",
      SEAM_MODULE,
    ]);
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
