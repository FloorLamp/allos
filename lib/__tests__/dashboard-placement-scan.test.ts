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
});
