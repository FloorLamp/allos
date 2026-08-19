import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const runtimeRoots = ["app", "components", "lib"];
const retired = [
  "RankableDashboardSurface",
  "currentPlacement",
  "currentOrder",
  "DASHBOARD_WIDGETS",
  "DashboardGrid",
  "saveDashboardLayout",
  "getDashboardLayout",
  "setDashboardLayout",
  "dashboardCustomizeMode",
  "layoutReviewed",
];

function runtimeSource(): string {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (
        /\.(ts|tsx)$/.test(entry.name) &&
        !file.includes("/__tests__/") &&
        !file.includes("/__db_tests__/") &&
        !file.includes("/__action_tests__/")
      )
        files.push(file);
    }
  };
  runtimeRoots.forEach((directory) => walk(path.join(root, directory)));
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

describe("atomic dashboard source boundary", () => {
  it("contains no retired placement or customization vocabulary", () => {
    const source = runtimeSource();
    retired.forEach((token) => expect(source).not.toContain(token));
  });

  it("renders only through the atomic candidate map", () => {
    const page = fs.readFileSync(path.join(root, "app/(app)/page.tsx"), "utf8");
    const canvas = fs.readFileSync(
      path.join(root, "components/dashboard/DashboardPlacementCanvas.tsx"),
      "utf8"
    );
    expect(page).toContain("rankDashboardCandidates(candidates");
    expect(page).toContain("candidateNodes={candidateNodes}");
    expect(canvas).toContain(
      "candidateNodes.get(placement.candidate.candidateId)"
    );
    expect(canvas).toContain('placement.lane !== "standing"');
    expect(canvas).toContain("Missing dashboard candidate node for");
  });

  it("keeps nodes for readings phase 4 can move out of Standing", () => {
    const page = fs.readFileSync(path.join(root, "app/(app)/page.tsx"), "utf8");
    const protein = page.slice(
      page.indexOf("if (proteinToday)"),
      page.indexOf("else if (foodLoggingApplicable)")
    );
    const sleep = page.slice(
      page.indexOf("values.forEach(([key, title, value], index)"),
      page.indexOf("sourceOrder += values.length")
    );

    expect(protein).toContain("add(");
    expect(protein).toContain("<NutritionTodayWidget");
    expect(protein).not.toContain("addStandingOnly(");
    expect(sleep).toContain("add(");
    expect(sleep).toContain("<DashboardAtomCard");
    expect(sleep).not.toContain("addStandingOnly(");
  });

  it("keeps candidate definitions behind the React-free domain builders", () => {
    const page = fs.readFileSync(path.join(root, "app/(app)/page.tsx"), "utf8");
    for (const definitionToken of [
      "actionCandidate(",
      "readingCandidate(",
      "statementCandidate(",
      "stateCandidate(",
      "buildDashboardCandidate(",
      "profileDataRelevance(",
      "candidateId:",
      "factKey:",
    ]) {
      expect(page).not.toContain(definitionToken);
    }
    for (const builder of [
      "careCandidates.",
      "dailyCandidates.",
      "progressCandidates.",
      "setupCandidates.",
      "sleepCandidates.",
    ]) {
      expect(page).toContain(builder);
    }
  });

  it("keeps each candidate group in its own small domain module", () => {
    const directory = path.join(root, "lib/dashboard-candidates");
    for (const group of ["care", "daily", "progress", "setup", "sleep"]) {
      const source = fs.readFileSync(
        path.join(directory, `${group}.ts`),
        "utf8"
      );
      expect(source).toContain(`export const ${group}Candidates`);
      expect(source.split("\n").length).toBeLessThan(250);
    }
    expect(fs.existsSync(path.join(directory, "domain.ts"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "manifest.ts"))).toBe(false);
  });

  it("keeps one pure Standing registry and no presentation-local ordering", () => {
    const standing = fs.readFileSync(
      path.join(root, "lib/dashboard-standing.ts"),
      "utf8"
    );
    const relevance = fs.readFileSync(
      path.join(root, "lib/dashboard-relevance.ts"),
      "utf8"
    );
    const cluster = fs.readFileSync(
      path.join(root, "components/dashboard/DashboardStandingCluster.tsx"),
      "utf8"
    );
    expect(
      runtimeSource().match(/export const STANDING_READING_ORDER\b/g)
    ).toHaveLength(1);
    expect(standing).not.toMatch(/from ["'](react|next\/|@\/components)/);
    expect(relevance).not.toContain("isActingProfileReading");
    expect(relevance).not.toContain('engagement !== "external"');
    expect(cluster).not.toContain(".sort(");
    expect(cluster).not.toContain('className="card"');
  });
});
