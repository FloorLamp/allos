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
});
