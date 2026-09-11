// DOES THE BAN REACH EVERY PRODUCTION MODULE? (#5856)
//
// eslint-config-composition.test.ts names files one at a time and asks which bans
// reach each. That answers "did this file LOSE a rule" and structurally cannot
// answer "does every production file HAVE one" — and the second question is what
// #5348's composite defence rests on, because actions-write-access.test.ts
// lets an action that calls a branded core drop its allowlist entry on the strength
// of production code being unable to forge the brand.
//
// Three shipped modules were outside WRITE_BRAND_CAST while every sampled row stayed
// green: lib/revalidate.ts, whose `no-restricted-imports` exemption took the syntax
// bans with it (a flat config REPLACES rather than merges, so an `ignores` entry
// drops a file to the level above for every rule the block sets), and middleware.ts
// and instrumentation-client.ts, repo-root modules no `**/` tree reached.
//
// This asks ESLint's own API which rules it resolved for a file — it does not restate
// the config's lists. The production surface is enumerated from the config's OWN
// trees, and the repo root is read from disk rather than from a list, so a new root
// entrypoint is uncovered here on the commit that adds it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { PRODUCTION_TREES } from "../../eslint.config.mjs";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// A repo-root `.ts` is production unless it is the test harness's own configuration.
// Named as a shape rather than as a list: a list would need an entry per new root
// file, which is the maintenance the gap came from.
const ROOT_TOOLING = /^(?:playwright|vitest)[.\w-]*\.ts$/;

// The config's own test tiers, by the two markers TEST_TREES matches on.
const isTestSource = (rel: string) =>
  /(?:^|\/)__\w*tests__\//.test(rel) || /\.test\.tsx?$/.test(rel);

function rootEntrypoints(): string[] {
  return fs
    .readdirSync(REPO, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        /\.tsx?$/.test(e.name) &&
        !e.name.endsWith(".d.ts") &&
        !ROOT_TOOLING.test(e.name)
    )
    .map((e) => e.name);
}

/** Every shipped module the config's trees and the repo root contain. */
export function productionModules(): string[] {
  const fromTrees = fs
    .globSync(PRODUCTION_TREES, {
      cwd: REPO,
      exclude: (name) => name === "node_modules" || name === ".next",
    })
    .map((f) => f.split(path.sep).join("/"));
  return [...new Set([...fromTrees, ...rootEntrypoints()])]
    .filter((rel) => !isTestSource(rel))
    .sort();
}

export type BanSpec = {
  /** A fragment of the ban's own message, as eslint-config-composition.test.ts keys on. */
  fragment: string;
  /** Modules the config deliberately leaves outside the ban; each says why beside it. */
  owners: string[];
};

export const WRITE_BRAND_BAN: BanSpec = {
  fragment: "Do not cast or re-alias to WriteAuthorizedProfileId",
  // lib/auth.ts mints the brand in its three write gates, so it alone keeps the cast.
  owners: ["lib/auth.ts"],
};

export const RPE_BRAND_BAN: BanSpec = {
  fragment: "Do not cast to RpeTracking",
  // lib/rpe.ts's one permitted cast rides a disable line, not a config exemption.
  owners: [],
};

export type BanCoverage = {
  /** Every production module the sweep resolved a config for. */
  checked: string[];
  /** Production modules the ban does not reach, excluding its declared owners. */
  uncovered: string[];
  /** Declared owners the ban DOES reach — an exemption that no longer exempts. */
  staleOwners: string[];
};

const eslint = new ESLint({ cwd: REPO });

export async function banCoverage(ban: BanSpec): Promise<BanCoverage> {
  const checked = productionModules();
  const uncovered: string[] = [];
  const covered = new Set<string>();
  for (const rel of checked) {
    const config = await eslint.calculateConfigForFile(path.join(REPO, rel));
    const rule = (config as { rules?: Record<string, unknown> }).rules?.[
      "no-restricted-syntax"
    ];
    const entries = Array.isArray(rule) ? rule.slice(1) : [];
    if (JSON.stringify(entries).includes(ban.fragment)) covered.add(rel);
    else if (!ban.owners.includes(rel)) uncovered.push(rel);
  }
  return {
    checked,
    uncovered,
    staleOwners: ban.owners.filter((owner) => covered.has(owner)),
  };
}
