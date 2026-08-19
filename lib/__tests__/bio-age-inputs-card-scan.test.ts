import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// STATIC BOUNDARY GUARD for the #2367 split, held where #3050 moved the boundary.
//
// Biological age is a longevity index: the NUMBER, the delta to calendar age, the pace
// of aging and the per-input effects render on /longevity and nowhere else. What lives
// on Results › Clinical results is the biomarker CATALOG half — which of the nine
// analytes you have, which you still need, and the import CTA — because that is the
// page where analytes are added.
//
// #3050 gave that card the draws' DATES, which is the closest it has ever come to the
// hero's material: a reader has to be able to tell whether the result behind the
// button is from June or from this morning. A date is not the number.
//
// THIS SCAN IS THE SECOND LINE, NOT THE FIRST. A scan over spellings guards the
// spelling: while the card still received the full `BioAgeDraw[]`, a review added a
// block rendering the estimate, the calendar age and the delta, and this file passed —
// ordinary destructuring names none of the tokens below, and `latest["bioAge"]` walks
// past them too. The guard that actually holds is a TYPE: the card reads
// `getBioAgeInputCatalog`, whose `drawDates` carry a date and nothing else, so the
// number is not in scope to render (`bioAgeInputsStatus` applies the same rule one
// level in). `lib/__action_tests__/bio-age-inputs-card.render.test.ts` then asserts the
// rendered card against the very number the hero shows for that profile.
//
// What this file still adds is early, cheap and specific: it fails on the IMPORT, at
// the moment someone reaches for the hero's helpers, with the reason stated.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CARD = "app/(app)/results/BioAgeInputsCard.tsx";

// The estimate-bearing surface vocabulary. Every one of these renders or computes a
// NUMBER about the person — the hero's material, and none of it belongs here.
const FORBIDDEN = [
  "bioAgeDelta",
  "bioAgeDeltaPhrase",
  "paceOfAging",
  "paceOfAgingPhrase",
  "bioAgeEffectLabel",
  "bioAgeEffectPhrase",
  "censoredInputNote",
  "phenoAgeReferenceBasisLabel",
  ".bioAge",
  ".chronoAge",
  ".effects",
  "bio-age-value",
  "bio-age-delta",
  "bio-age-pace",
];

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function offenders(source: string): string[] {
  const code = stripComments(source);
  return FORBIDDEN.filter((token) => code.includes(token));
}

describe("the Results inputs card renders no bio-age estimate (#2367/#3050)", () => {
  const source = fs.readFileSync(path.join(REPO, CARD), "utf8");

  it("names no value, delta, pace or per-input effect", () => {
    expect(
      offenders(source),
      `${CARD} reaches for the biological-age HERO's material. The number, its delta ` +
        `to calendar age, the pace and the per-input effects live on /longevity ` +
        `(#2367); this card owns the catalog half. A DRAW DATE is allowed — that is ` +
        `#3050 — an estimate is not.`
    ).toEqual([]);
  });

  it("still says which draw the result is from", () => {
    // The other half of the same boundary: the card must not go back to rendering
    // only a count. It states its status through the shared copy layer.
    expect(source).toContain("bioAgeInputsStatus");
    expect(source).toContain("status.message");
  });

  it("self-check: the scanner sees the vocabulary it forbids", () => {
    expect(offenders(`const d = bioAgeDelta(latest.bioAge, chrono);`)).toEqual([
      "bioAgeDelta",
      ".bioAge",
    ]);
    // …and is not tripped by prose describing the rule.
    expect(offenders(`// never render bioAgeDelta or .bioAge here`)).toEqual(
      []
    );
    expect(offenders(`{/* not the .effects list */}`)).toEqual([]);
  });
});
