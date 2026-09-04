// ONE MINT (#5082, acceptance criterion 1).
//
// A bundle id is the RECORD that one action wrote several rows, so it is only worth
// anything while there is exactly one way to make one. #5082 folded the dose-only
// `newDoseBundle` into `newBundle` (lib/bundle.ts) precisely because two mints had
// already grown — and the second one grew because someone needed a bundle id in a
// hurry, which is the shape that will grow again.
//
// So this is a scan rather than a grep somebody ran once. It reads the repo's own
// source as TEXT (no DB, no network) through the shared walker, and asks three
// questions of every production file:
//
//   1. the retired name is gone — a re-introduced `newDoseBundle` is a second door
//      wearing the old sign;
//   2. `newBundle` is DECLARED in exactly one file — a domain that grows its own
//      `newFoodBundle` has two mints again whatever the ids look like;
//   3. nothing outside lib/bundle.ts makes a BundleId out of randomness — the
//      in-a-hurry shape, an inline `randomBytes(8).toString("hex") as BundleId` at
//      the call site that no signature check can see.
//
// AND IT IS DELIBERATELY SILENT ON READING ONE BACK. `lib/queries/day-ledger.ts` casts
// a stored `bundle_id` to the brand, which is the read side and not a mint; a guard
// that cried wolf on it would be widened or deleted within a week, taking the real
// guard with it. The benign-neighbour assertion below pins that silence.
import { describe, expect, it } from "vitest";
import { readSource, relPath, sourceFiles } from "./sql-scan";

const MINT = "lib/bundle.ts";

// Each rule reports the files that break it. `mint` says whether lib/bundle.ts itself
// is exempt — it is the one file allowed to declare the door and to build the value.
const RULES = [
  {
    name: "the retired dose-only mint is gone",
    test: (src: string) => /\bnewDoseBundle\b/.test(src),
    exemptMint: false,
  },
  {
    name: "newBundle is declared in one file",
    test: (src: string) => /function\s+newBundle\b/.test(src),
    exemptMint: true,
  },
  {
    name: "no bundle id is built from randomness elsewhere",
    test: (src: string) =>
      /\bBundleId\b/.test(src) && /\brandom(Bytes|UUID)\b/.test(src),
    exemptMint: true,
  },
] as const;

function offenders(rule: (typeof RULES)[number], files: string[]): string[] {
  return files
    .map((file) => ({ rel: relPath(file), src: readSource(file) }))
    .filter(({ rel }) => !(rule.exemptMint && rel === MINT))
    .filter(({ src }) => rule.test(src))
    .map(({ rel }) => rel);
}

describe("one bundle mint (#5082)", () => {
  const files = sourceFiles();

  it("scans the mint itself, so an exemption is a real one", () => {
    expect(files.map(relPath)).toContain(MINT);
  });

  it.each(RULES)("$name", (rule) => {
    expect(offenders(rule, files)).toEqual([]);
  });

  // THE GUARD CAN SEE. Each rule is run over a source authored to break it (the
  // lib/__tests__/nul-byte-census.test.ts tradition), through the same predicate the
  // corpus walk runs — a rule that cannot fail is worse than no rule, because it turns
  // "nobody has done this" into "nobody can do this".
  it.each([
    [RULES[0], 'import { newDoseBundle } from "@/lib/bundle";'],
    [RULES[1], "export function newBundle(): BundleId { return x; }"],
    [RULES[2], 'const id = randomBytes(8).toString("hex") as BundleId;'],
  ])("$#: catches a forged offender", (rule, forged) => {
    expect(rule.test(forged)).toBe(true);
  });

  // AND IT IS QUIET ON THE READ SIDE, which is the neighbour it would otherwise take
  // down with it: the ledger query casts a stored column to the brand and mints nothing.
  it("stays silent on reading a stored bundle back", () => {
    const readSide = readSource(
      files.find((f) => relPath(f) === "lib/queries/day-ledger.ts")!
    );
    expect(RULES.map((rule) => rule.test(readSide))).toEqual([
      false,
      false,
      false,
    ]);
  });
});
