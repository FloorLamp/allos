// PURE TIER — the legacy `medical_records.category = "biomarker"` catch-all is
// RETIRED (#2479 part 2), and this is the ratchet that keeps it retired.
//
// Migration 185 empties the bucket of everything the canonical registry can classify.
// That is worth nothing if the writers keep refilling it, and the issue names both
// refill paths explicitly: the extraction prompt's "use `biomarker` when nothing else
// fits", and VO2 Max being written there by several integrations and fitness paths.
// Two of the closures are TYPES — `NormVital.category` and `FitnessStore`'s vital arm
// no longer admit the string, so a parser that reaches for it does not compile — and
// those need no test. What a type cannot reach is a raw SQL literal, a fresh object
// literal in a module with no narrowed shape, and a prompt sentence, so those are
// scanned here in the repo's established source-scan idiom.
//
// The retirement is deliberately ONE-SIDED. Reading the value, FILTERING for it and
// storing it are all still legal: migration 185 leaves behind the rows it cannot
// classify, and a residue row must stay visible and findable rather than being
// guessed into a category. So `MEDICAL_CATEGORIES` still lists it and the CHECK still
// admits it. What no longer exists is a way to CREATE one.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../medical-extract/constants";
import { SYSTEM, TOOL } from "../medical-extract/prompt";
import {
  ASSIGNABLE_MEDICAL_CATEGORIES,
  MEDICAL_CATEGORIES,
  RETIRED_MEDICAL_CATEGORIES,
} from "../medical-categories";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ROOTS = ["app", "components", "lib", "scripts"];

// Files allowed to name the retired value in a category position, each because it is
// about the retirement rather than an instance of it.
const ALLOWED = new Set([
  // The enum and the retirement list themselves.
  "lib/medical-categories.ts",
  "lib/types/medical.ts",
  // The one-shot pass, which reads and clears the value.
  "lib/legacy-category-reclass-db.ts",
  // A FILTER default, not a write: a residue row has to stay findable.
  "components/CategoryFilterSelect.tsx",
]);

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        // Shipped migrations are frozen history — 090's comments and every rebuilt
        // CHECK name the value, and none of them can be edited.
        if (full.endsWith(path.join("lib", "migrations", "versions"))) continue;
        // The test tiers construct legacy rows on purpose.
        if (/__(tests|db_tests|action_tests)__$/.test(e.name)) continue;
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(e.name)) out.push(path.relative(REPO, full));
    }
  };
  for (const root of ROOTS) walk(path.join(REPO, root));
  return out.sort();
}

// A category ASSIGNMENT of the retired value: an object-literal / annotation
// `category: "biomarker"`, or a SQL `category = 'biomarker'`. Reads
// (`category === "biomarker"`, `IN ('lab','biomarker')`) are deliberately not matched.
const WRITE_PATTERNS = RETIRED_MEDICAL_CATEGORIES.flatMap((value) => [
  new RegExp(`category\\s*:\\s*["']${value}["']`),
  new RegExp(`category\\s*=\\s*'${value}'`),
]);

describe("the retired medical category cannot be written (#2479)", () => {
  it("scans a non-trivial number of sources", () => {
    expect(sources().length).toBeGreaterThan(500);
  });

  it("no source outside the allowlist files a row under it", () => {
    const offenders: string[] = [];
    for (const rel of sources()) {
      if (ALLOWED.has(rel)) continue;
      const src = fs.readFileSync(path.join(REPO, rel), "utf8");
      src.split("\n").forEach((line, i) => {
        if (WRITE_PATTERNS.some((re) => re.test(line)))
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "the `biomarker` category is the retired pre-#1076 catch-all — it means " +
        '"no decision was made", and migration 185 exists to empty it. File the ' +
        "row under what it actually is (the canonical registry's own category), or " +
        "add a category that states it."
    ).toEqual([]);
  });

  it("every allowlisted file still names it — a stale exemption is a lie", () => {
    for (const rel of ALLOWED) {
      const src = fs.readFileSync(path.join(REPO, rel), "utf8");
      expect(
        RETIRED_MEDICAL_CATEGORIES.some((v) => src.includes(v)),
        `${rel} no longer mentions a retired category — drop its allowlist entry`
      ).toBe(true);
    }
  });
});

describe("the assignable set, and the extractor over it", () => {
  it("is the enum minus the retired values, derived rather than listed", () => {
    expect(ASSIGNABLE_MEDICAL_CATEGORIES).toEqual(
      MEDICAL_CATEGORIES.filter(
        (c) => !(RETIRED_MEDICAL_CATEGORIES as readonly string[]).includes(c)
      )
    );
    for (const retired of RETIRED_MEDICAL_CATEGORIES) {
      expect(MEDICAL_CATEGORIES as readonly string[]).toContain(retired);
      expect(ASSIGNABLE_MEDICAL_CATEGORIES).not.toContain(retired);
    }
  });

  it("the extraction whitelist is the assignable set", () => {
    expect(CATEGORIES).toEqual(ASSIGNABLE_MEDICAL_CATEGORIES);
  });

  it("the tool enum the model sees offers no retired category", () => {
    const props = TOOL.input_schema.properties as Record<string, unknown>;
    const results = props.results as {
      items: { properties: { category: { enum: string[] } } };
    };
    const offered = results.items.properties.category.enum;
    expect(offered).toEqual(ASSIGNABLE_MEDICAL_CATEGORIES);
  });

  it("the prompt names no catch-all and never offers the retired value", () => {
    for (const retired of RETIRED_MEDICAL_CATEGORIES)
      expect(SYSTEM).not.toContain(`"${retired}"`);
    // The clause the issue names, in the shape it took: a licence to make no decision.
    expect(SYSTEM).not.toMatch(/only if nothing else fits/i);
    // …replaced by an explicit statement that there is no such option.
    expect(SYSTEM).toContain("There is NO catch-all category");
  });
});
