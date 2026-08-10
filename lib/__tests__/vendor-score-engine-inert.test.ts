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

// One entry per VENDOR whose own daily score the app stores. The stance is the same
// for all of them (#1069): store what the source said, render it attributed, and let
// NOTHING compute with it — so the guard is one mechanism over a table rather than a
// file per vendor. Fitbit joined when the Takeout importer landed; a future Garmin
// score adds a row here and nothing else.
interface VendorScores {
  vendor: string;
  issue: string;
  // Literal kinds AND their exported constant identifiers, so importing the constant
  // into an engine is caught exactly as a hardcoded string would be.
  needles: string[];
  // The ONLY files permitted to reference them — each a display/ingest/bounds
  // surface, never an engine that derives a decision from them.
  allowlist: Set<string>;
}

const OURA_ALLOWLIST = new Set<string>([
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

const FITBIT_ALLOWLIST = new Set<string>([
  // Definitions + the pure parser that mints the samples.
  "lib/integrations/fitbit-takeout.ts",
  // Plausibility bounds (0–100) — storage hygiene, not synthesis.
  "lib/ingest-bounds.ts",
  // The DECLARATION of which streams only a Takeout archive can deliver (#2164). Two
  // things make this a safe member rather than a hole in the rule:
  //
  //   It is DATA, not code. registry.ts is a literal array with type-only imports; it
  //   cannot compute with anything, and the two kinds appear only as the `metric`
  //   selector telling the reader WHICH ROWS to look at.
  //
  //   The reader asks `MAX(date)` and nothing else. `archiveExclusiveFrontier`
  //   (lib/queries/upcoming/records-recency.ts) selects no `value` column at all, so
  //   the ask it feeds is a fact about DELIVERY — "the last export carried data through
  //   the 26th" — never about what Fitbit scored. The score's number reaches no
  //   decision, no pillar, no copy. lib/__db_tests__/records-recency.test.ts pins that
  //   the verdict is unchanged by the value.
  //
  // Note the file itself is NOT the same as the query module: the query module never
  // names a kind, it reads the selector out of this declaration, which is why it does
  // not (and must not) appear here.
  "lib/integrations/registry.ts",
]);

const VENDORS: VendorScores[] = [
  {
    vendor: "Oura",
    issue: "#1069",
    needles: [
      "oura_sleep_score",
      "oura_readiness_score",
      "OURA_SLEEP_SCORE_METRIC",
      "OURA_READINESS_SCORE_METRIC",
    ],
    allowlist: OURA_ALLOWLIST,
  },
  {
    vendor: "Fitbit",
    issue: "#1069 (extended by the Takeout importer)",
    needles: [
      "fitbit_sleep_score",
      "fitbit_readiness_score",
      "FITBIT_SLEEP_SCORE_METRIC",
      "FITBIT_READINESS_SCORE_METRIC",
    ],
    allowlist: FITBIT_ALLOWLIST,
  },
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

describe("vendor daily scores are engine-inert (issue #1069)", () => {
  const files: string[] = [];
  walk(path.join(REPO, "lib"), files);
  walk(path.join(REPO, "app"), files);

  for (const { vendor, issue, needles, allowlist } of VENDORS) {
    it(`no code outside the display/ingest allowlist references the ${vendor} score kinds`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const rel = path.relative(REPO, file).split(path.sep).join("/");
        if (allowlist.has(rel)) continue;
        const text = fs.readFileSync(file, "utf8");
        if (needles.some((n) => text.includes(n))) offenders.push(rel);
      }

      expect(
        offenders,
        `These files reference a ${vendor} vendor score kind but are not on the ` +
          `display/ingest allowlist. Vendor scores are display-only and MUST feed no ` +
          `engine (${issue}). If this is a new display surface, add it to the allowlist ` +
          `with a justification; if it is an engine, it must NOT consume these kinds.\n` +
          offenders.join("\n")
      ).toEqual([]);
    });
  }
});
