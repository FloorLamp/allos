// PURE TIER — the coaching-reach census (#3129), cross-file half.
//
// #3095 gave the dashboard rollup a relevance floor (`review` = 2): a finding without an
// explicit `dashboardRelevance` clears it only on caution/action tone. That default is
// correct for a coaching class with an origin tab of its own — its tab is its reach
// (#449, restated in docs/internals/findings.md) — but a class whose ONLY surface is the
// rollup renders NOWHERE unless its producer declares relevance. #3129 is what one
// missing declaration looks like: the mood observation computed, suppressible,
// documented — and unreachable.
//
// Two of the three directions this file used to scan are now TYPES (#5351, on #4241's
// ruling), so they are gone from here rather than asserted twice:
//
//   1. Every coaching namespace declares its reach — `RULE_FINDING_REGISTRY` carries a
//      required `reach` column, so a new namespace must choose a side to compile.
//   2. Every rollup-only producer declares the relevance — `COACHING_COLLECTION`'s entry
//      type may only run a "rollup-only" builder that returns `RollupOnlyFinding`, whose
//      `dashboardRelevance` is required. A rename of the constant or a differently
//      spelled equivalent no longer defeats it, which a source-text match could not say.
//
// What survives is the direction no type expresses: that an ORIGIN-TAB row's claimed
// surface really reads the symbol it names. That is a cross-file text fact, and it is
// what stops the census rotting into a list of stale excuses.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RULE_FINDING_REGISTRY } from "@/lib/rule-finding-prefixes";
import { REPO } from "./sql-scan";

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// The registry's origin-tab rows: each names the surface file that renders the class's
// observation and the symbol that surface reads — the builder itself, or the shared
// computation/formatter the builder maps into the envelope.
const ORIGIN_TAB = RULE_FINDING_REGISTRY.flatMap((entry) =>
  entry.tier === "coaching" && typeof entry.reach === "object"
    ? [{ builder: entry.builder, ...entry.reach }]
    : []
);

describe("the coaching rollup-reach census is total and enforced (#3129)", () => {
  it("every origin-tab class's claimed surface really reads the named symbol", () => {
    expect(ORIGIN_TAB.length).toBeGreaterThan(0);
    const broken = ORIGIN_TAB.filter(
      ({ surface, symbol }) => !read(surface).includes(symbol)
    ).map((r) => `${r.builder} → ${r.surface}`);
    expect(broken, `\n${broken.join("\n")}\n`).toEqual([]);
  });

  // The scan must be able to fail (the #1893 fixture rule): a symbol a surface does not
  // read is exactly what the assertion above flags.
  it("FLAGS a surface that does not read the named symbol", () => {
    const { surface } = ORIGIN_TAB[0];
    expect(read(surface)).not.toContain("noSuchPlantedSymbol");
  });
});
