import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (relative: string) =>
  readFileSync(path.join(ROOT, relative), "utf8");

describe("wellness and frequency-target query boundaries (#1622/#1637)", () => {
  it("keeps the current read names available through the shared query barrel", () => {
    const barrel = read("lib/queries.ts");
    expect(barrel).toContain('export * from "./queries/frequency-targets"');
    expect(barrel).toContain('export * from "./queries/wellness"');

    const wellness = read("lib/queries/wellness.ts");
    for (const name of [
      "getWellnessPractices",
      "getAllPracticeSessions",
      "getPracticeTargets",
      "findPracticeTarget",
      "getPracticeSpellings",
      "getPracticeDayCount",
      "getPracticeSessions",
      "getPracticeSession",
      "getPracticeUsageInWindow",
      "getPracticeDayUsageInWindow",
      "practiceNameMatches",
    ]) {
      expect(wellness, name).toContain(`export function ${name}`);
    }
  });

  it("keeps shared target reads out of the training consumer module", () => {
    const frequencyTargets = read("lib/queries/frequency-targets.ts");
    expect(frequencyTargets).toContain("export function getFrequencyTargets");
    expect(frequencyTargets).toContain(
      "export function getFrequencyTargetProgress"
    );

    const trainingGoals = read("lib/queries/training/goals.ts");
    expect(trainingGoals).not.toContain("getFrequencyTargets");
    expect(trainingGoals).not.toContain("getFrequencyTargetProgress");
  });

  it("renders wellness cards from the already-grouped session payload", () => {
    const page = read("app/(app)/wellness/page.tsx");
    expect(page).toContain("sessions={practice.sessions}");
    expect(page).not.toContain("getAllPracticeSessions");
  });
});
