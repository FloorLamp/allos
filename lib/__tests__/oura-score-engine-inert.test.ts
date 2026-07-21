import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load-bearing invariant for issue #1069, pinned MECHANICALLY.
//
// Oura's `oura_sleep_score` / `oura_readiness_score` are STORE-WHAT-THE-SOURCE-SAID
// display values — a factual attribution of what Oura reported, like an imported
// lab flag. They are NOT synthesis inputs. The app's no-composite-score stance
// (#1066, #161/pillars) forbids the app from *inventing* a score; displaying a
// vendor's own, attributed, is fine — but nothing may CONSUME these kinds. Not the
// healthspan pillars, not coaching findings, not notifications/digest, not
// risk/cadence.
//
// This is the #553-style allowlist IN REVERSE: instead of asserting every engine
// opts into a layer, we assert NO code outside a tiny display/ingest allowlist even
// references these kinds — by their literal string OR their exported constant. A
// future engine reaching for an Oura score (hardcoded kind or imported constant)
// adds a file to the match set that isn't allowlisted, and CI fails here with a
// pointer to this rationale. Reads sources as TEXT (no DB, no network — "pure").

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The ONLY files permitted to reference the Oura score kinds, each a
// display/ingest/bounds surface — never an engine that derives a decision from them.
const ALLOWLIST = new Set<string>([
  // Definitions + the pure parser that mints the samples.
  "lib/integrations/oura.ts",
  // The sync that ingests the two daily-score endpoints into metric_samples.
  "lib/integrations/oura-sync.ts",
  // Plausibility bounds (0–100) — storage hygiene, not synthesis.
  "lib/ingest-bounds.ts",
  // The SOLE read path: the Sleep page's display query.
  "lib/queries/sleep.ts",
  // The display surfaces (Sleep page + its attributed tiles).
  "app/(app)/sleep/page.tsx",
  "app/(app)/sleep/OuraScores.tsx",
]);

// Match the literal kinds AND their exported constant identifiers, so importing the
// constant into an engine is caught just as a hardcoded string would be.
const NEEDLES = [
  "oura_sleep_score",
  "oura_readiness_score",
  "OURA_SLEEP_SCORE_METRIC",
  "OURA_READINESS_SCORE_METRIC",
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  // Test tiers reference the kinds by construction (fixtures, this guard) — they are
  // not shipped engines, so they're out of scope for the reverse allowlist.
  "__tests__",
  "__db_tests__",
  "__action_tests__",
]);

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

describe("Oura vendor scores are engine-inert (issue #1069)", () => {
  it("no code outside the display/ingest allowlist references the Oura score kinds", () => {
    const files: string[] = [];
    walk(path.join(REPO, "lib"), files);
    walk(path.join(REPO, "app"), files);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO, file);
      if (ALLOWLIST.has(rel)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (NEEDLES.some((n) => text.includes(n))) offenders.push(rel);
    }

    expect(
      offenders,
      `These files reference an Oura vendor score kind but are not on the ` +
        `display/ingest allowlist. Oura scores are display-only and MUST feed no ` +
        `engine (#1069). If this is a new display surface, add it to the allowlist ` +
        `with a justification; if it is an engine, it must NOT consume these kinds.\n` +
        offenders.join("\n")
    ).toEqual([]);
  });
});
