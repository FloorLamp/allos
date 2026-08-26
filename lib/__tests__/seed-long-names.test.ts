import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";
import {
  BASELINE_DIALS,
  DEFAULT_SEED,
  sampleDials,
} from "../../scripts/seed-rng";
import {
  LONG_NAMES,
  UNBOUNDED_NAME_FIELDS,
  UNBOUNDED_NAME_MIN_CHARS,
  type LongNameKey,
} from "../../scripts/seed-long-names";

// THE UNBOUNDED-NAME CORPUS'S CONTRACTS (#3631).
//
// #3631 is not a bug in the geometry probe. The probe reads rendered boxes and
// reported #3478's select correctly the moment one long name existed; what did not
// exist was a long name. So the deliverable is a CORPUS, and a corpus has the
// failure mode the census tier has shipped repeatedly: A CORPUS THAT FINDS NOTHING
// READS IDENTICAL TO A CORPUS THAT IS NOT THERE. Three things have to hold, and each
// `describe` below is one of them:
//
//   1. Every planted value is LONG ENOUGH to make the control it sizes exceed the
//      census's 390px phone viewport. A corpus of 23-character names is the state
//      #3631 is about, and it goes green just as quietly.
//   2. Every planted value is ACTUALLY PLANTED — scripts/seed.ts references it — and
//      every reference is INSIDE the `textLength` dial's guard. The second half is
//      the one that could silently cost something: a hook written outside the guard
//      lands in the BASELINE, which is the e2e demo template DB and the byte-stable
//      pin `--baseline` census diffing relies on.
//   3. The corpus is REACHABLE by a documented seed, and the number in the docs is
//      the number `sampleDials` actually produces.
//
// WHAT THIS FILE CANNOT DO, said plainly because a guard credited with more than it
// does is worse than none: it reads scripts/seed.ts AS TEXT. It cannot prove a row
// reached SQLite — that costs a seed run (~10s), and vitest.timeouts.ts is explicit
// that the DB tier's answer to a slow test is to not write it. The live half is the
// census run itself, which is what #3631's acceptance criterion asks for and what
// the PR records: seed with the dial on, run the census, and the clip comes back.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SEED = path.join(REPO, "scripts", "seed.ts");

/** The dial guard exactly as scripts/seed.ts writes it. */
const GUARD = `if (DIALS.textLength === "long") {`;

/**
 * Every `LONG_NAMES.<key>` reference in a source, with whether it sits inside a
 * `textLength` dial guard.
 *
 * Brace-matched rather than regexed over lines: the hooks are multi-statement
 * blocks, and "the reference appears somewhere after the guard" would call a hook
 * appended AFTER the closing brace guarded when it is not. Comments are blanked
 * first (offsets preserved), so the prose above each hook — which names the keys on
 * purpose — is not counted as a reference.
 */
export function longNameReferences(
  source: string
): { key: string; guarded: boolean }[] {
  const code = stripComments(source);
  const blocks: [number, number][] = [];
  for (
    let at = code.indexOf(GUARD);
    at >= 0;
    at = code.indexOf(GUARD, at + 1)
  ) {
    let depth = 0;
    let end = -1;
    for (let i = at + GUARD.length - 1; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    blocks.push([at, end < 0 ? code.length : end]);
  }
  const refs: { key: string; guarded: boolean }[] = [];
  for (const m of code.matchAll(/\bLONG_NAMES\.(\w+)/g)) {
    const at = m.index ?? 0;
    refs.push({
      key: m[1],
      guarded: blocks.some(([from, to]) => at > from && at < to),
    });
  }
  return refs;
}

describe("the planted values can express the class (#3631)", () => {
  it("plants a value for every roster entry marked planted, and only those", () => {
    const planted = UNBOUNDED_NAME_FIELDS.filter((f) => f.planted).map(
      (f) => f.key
    );
    expect([...planted].sort()).toEqual(Object.keys(LONG_NAMES).sort());
  });

  it("gives every unplanted family a reason instead of a silence", () => {
    // The roster's whole point: a family this corpus cannot yet express is a
    // NUMBER THAT CAN GO UP, not a blank. The tap-floor census's rule (#3557).
    for (const f of UNBOUNDED_NAME_FIELDS.filter((f) => !f.planted))
      expect(f.why?.length, f.key).toBeGreaterThan(40);
  });

  it("makes every planted value longer than a phone viewport can hold", () => {
    for (const [key, value] of Object.entries(LONG_NAMES))
      expect(value.length, `${key}: "${value}"`).toBeGreaterThanOrEqual(
        UNBOUNDED_NAME_MIN_CHARS
      );
  });

  it("names real files as the controls each family sizes", () => {
    // A roster whose citations rot is a roster nobody trusts. Each entry's first
    // token is a repo-relative path; the prose after the dash is free.
    for (const f of UNBOUNDED_NAME_FIELDS)
      for (const c of f.controls) {
        const rel = c.split(" ")[0];
        expect(fs.existsSync(path.join(REPO, rel)), `${f.key}: ${rel}`).toBe(
          true
        );
      }
  });

  it("keeps at least the one control #3478 was measured on", () => {
    // The NAMED SUBJECT (#3522's pattern). A roster that averaged out to the right
    // size while losing the control this issue exists for would still pass every
    // assertion above.
    // The file moved with #3484 part 2 — the bespoke dose shell became a mount of
    // the shared event-ledger frame, and its Item select became the frame's — but it
    // is the same control, still the one #3478 was measured on.
    const intake = UNBOUNDED_NAME_FIELDS.find((f) => f.key === "intakeItem");
    expect(intake?.controls.join("\n")).toContain(
      "components/ledger/EventLedgerItemFilter.tsx"
    );
  });
});

describe("scripts/seed.ts plants them, and only under the dial (#3631)", () => {
  const seedSource = (): string => fs.readFileSync(SEED, "utf8");

  it("references every planted key", () => {
    const seen = new Set(longNameReferences(seedSource()).map((r) => r.key));
    for (const key of Object.keys(LONG_NAMES) as LongNameKey[])
      expect([...seen].sort().join(", "), key).toContain(key);
  });

  it("puts every reference inside the textLength guard", () => {
    const loose = longNameReferences(seedSource()).filter((r) => !r.guarded);
    expect(loose).toEqual([]);
  });

  it("sees a hook written outside the guard", () => {
    // PROVE THE MATCHER CAN SEE. A green sweep over a complying source says nothing
    // about what the sweep can see, so here are the two ways this goes wrong,
    // written on purpose. (The corpus is one known file read by path — there is no
    // walk to fool, which is the one thing a planted-offender test cannot add here.)
    const outside = `
      const x = LONG_NAMES.intakeItem;
      if (DIALS.textLength === "long") {
        plant(LONG_NAMES.condition);
      }
    `;
    expect(longNameReferences(outside)).toEqual([
      { key: "intakeItem", guarded: false },
      { key: "condition", guarded: true },
    ]);

    // And the shape a brace-blind check would wave through: the hook appended AFTER
    // the guard's closing brace, which reads as "below the guard" on every line-
    // oriented scan.
    const after = `
      if (DIALS.textLength === "long") {
        plant(LONG_NAMES.condition);
      }
      plant(LONG_NAMES.clinicalResult);
    `;
    expect(longNameReferences(after)).toEqual([
      { key: "condition", guarded: true },
      { key: "clinicalResult", guarded: false },
    ]);
  });

  it("stays quiet on prose that names a key", () => {
    // The other half (#3325): a guard that fires on the documentation explaining it
    // teaches the next author to delete the documentation.
    const prose = `
      // LONG_NAMES.intakeItem is planted below, under the dial.
      /* and LONG_NAMES.condition beside it */
      if (DIALS.textLength === "long") {
        plant(LONG_NAMES.intakeItem);
      }
    `;
    expect(longNameReferences(prose)).toEqual([
      { key: "intakeItem", guarded: true },
    ]);
  });
});

describe("the corpus is reachable by a documented seed (#3631)", () => {
  /**
   * THE CANONICAL LONG-NAMES SEED, and the reason a number in a doc needs a test.
   *
   * `SEED_RNG=3` is "past illness + long names" — the smallest seed that turns the
   * dial on with the least other perturbation, which is what makes it the one worth
   * writing down. `sampleDials` is pure and its draw order is pinned (dials are
   * APPENDED, never inserted, scripts/seed-rng.ts), so this number is stable — but
   * "stable" is a claim, and .claude/skills/ux-walkthrough/SKILL.md and
   * scripts/seed-long-names.ts both print it to a human who will type it.
   */
  const CANONICAL_LONG_NAMES_SEED = 3;

  it("turns the dial on at the seed the docs tell people to use", () => {
    expect(sampleDials(CANONICAL_LONG_NAMES_SEED).textLength).toBe("long");
  });

  it("leaves the baseline look alone", () => {
    // The load-bearing half. scripts/seed.ts IS the e2e demo template DB
    // (e2e/global-setup.ts), and the baseline is the pin `npm run seed`, that
    // template, and census `--baseline` diffing all rely on. If this ever reads
    // "long", every long value above has silently joined profile 1's demo story.
    expect(sampleDials(DEFAULT_SEED).textLength).toBe("short");
    expect(BASELINE_DIALS.textLength).toBe("short");
  });

  it("is documented where the census reader and the census runner both look", () => {
    const skill = fs.readFileSync(
      path.join(REPO, ".claude", "skills", "ux-walkthrough", "SKILL.md"),
      "utf8"
    );
    expect(skill).toContain(`SEED_RNG=${CANONICAL_LONG_NAMES_SEED}`);
    expect(skill).toContain("scripts/seed-long-names.ts");
    const design = fs.readFileSync(
      path.join(REPO, "docs", "internals", "design-system.md"),
      "utf8"
    );
    expect(design).toContain("scripts/seed-long-names.ts");
  });
});
