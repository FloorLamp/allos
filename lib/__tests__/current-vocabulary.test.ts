import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const roots = ["app", "components", "docs", "e2e", "lib", "scripts"];
const extensions = new Set([".ts", ".tsx", ".md", ".mjs"]);

function currentSources(): { file: string; source: string }[] {
  const files: { file: string; source: string }[] = [];
  const visit = (relative: string) => {
    if (
      relative === "lib/release-notes.json" ||
      relative.startsWith("lib/migrations/") ||
      relative === "lib/__tests__/current-vocabulary.test.ts"
    ) {
      return;
    }
    const absolute = path.join(repo, relative);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute)) {
        visit(path.join(relative, child));
      }
    } else if (extensions.has(path.extname(relative))) {
      files.push({ file: relative, source: fs.readFileSync(absolute, "utf8") });
    }
  };
  for (const root of roots) visit(root);
  return files;
}

describe("current namespace and log vocabulary (#2485)", () => {
  it("keeps daily insights in coaching and names stored summary shapes by grain", () => {
    expect(
      fs.existsSync(path.join(repo, "lib/queries/coaching/daily-insights.ts"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(repo, "lib/queries/coaching/period-recaps.ts"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(repo, "lib/queries/intake/insights.ts"))
    ).toBe(false);
    expect(fs.existsSync(path.join(repo, "lib/queries/narratives.ts"))).toBe(
      false
    );

    const types = fs.readFileSync(
      path.join(repo, "lib/types/coaching.ts"),
      "utf8"
    );
    expect(types).toContain("interface DailyInsight {");
    expect(types).toContain("interface PeriodRecap {");
    expect(types).not.toMatch(/interface (?:Insight|Narrative) \{/);
  });

  it("distinguishes daily aggregates from serving-event APIs", () => {
    const nutrition = fs.readFileSync(
      path.join(repo, "lib/queries/nutrition.ts"),
      "utf8"
    );
    expect(nutrition).toContain("getFoodDailyServingTotals(");
    expect(nutrition).toContain("getFoodMealDays(");
    expect(nutrition).toContain("getProteinDailyTotals(");
    expect(nutrition).not.toMatch(/get(?:Food|Protein)LogEntries\(/);

    const substance = fs.readFileSync(
      path.join(repo, "lib/queries/substance.ts"),
      "utf8"
    );
    expect(substance).toContain("interface SubstanceDailyTotal {");
    expect(substance).toContain("getSubstanceDailyTotals(");
  });

  it("retires generic PRN and removed-route vocabulary from current sources", () => {
    const violations = currentSources().flatMap(({ file, source }) => {
      const found: string[] = [];
      if (/\bisPrn\b/.test(source)) found.push("isPrn");
      if (/\/medicine\b/.test(source)) found.push("/medicine");
      if (/medicine\/actions\.ts/.test(source))
        found.push("medicine/actions.ts");
      if (/medicine-(?:name|finding-dismiss)/.test(source)) {
        found.push("retired medicine test id");
      }
      return found.map((term) => `${file}: ${term}`);
    });
    expect(violations).toEqual([]);
  });
});
