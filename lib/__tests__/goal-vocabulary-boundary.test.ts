import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith("__")) continue;
      out.push(...sourceFiles(relative));
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      out.push(relative);
    }
  }
  return out;
}

describe("outcome-goal and frequency-target vocabulary boundary (#2480)", () => {
  it("gives the three goal models distinct application names", () => {
    const trainingTypes = read("lib/types/training.ts");
    const medicalTypes = read("lib/types/medical.ts");
    expect(trainingTypes).toContain("export interface OutcomeGoal");
    expect(trainingTypes).toContain("export interface FrequencyTarget");
    expect(trainingTypes).not.toMatch(/export interface Goal\b/);
    expect(medicalTypes).toContain("export interface CareGoal");
  });

  it("keeps cadence vocabulary out of the outcome-goal module", () => {
    const outcomeGoals = read("lib/outcome-goals.ts");
    for (const symbol of [
      "FrequencyPace",
      "frequencyPace",
      "weeklyTargetPaceLine",
      "frequencyScopeLabel",
      "FREQUENCY_SCOPE_KINDS",
    ]) {
      expect(outcomeGoals, symbol).not.toMatch(
        new RegExp(`export (?:type |const |function )${symbol}\\b`)
      );
      expect(read("lib/frequency-targets.ts"), symbol).toContain(symbol);
    }
  });

  it("has no production import of cadence symbols from outcome goals", () => {
    const offenders: string[] = [];
    const cadenceSymbols =
      /\b(?:FrequencyPace|frequencyPace|weeklyTargetPaceLine|frequencyScopeLabel|FREQUENCY_SCOPE_KINDS)\b/;
    for (const relative of ["app", "components", "lib"].flatMap(sourceFiles)) {
      const source = read(relative);
      for (const statement of source.matchAll(
        /import\s+(?:type\s+)?\{[^}]*\}\s+from\s+["'][^"']*outcome-goals["'];/g
      )) {
        if (cadenceSymbols.test(statement[0])) offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("retires the ambiguous goal module and generic query APIs", () => {
    expect(existsSync(path.join(ROOT, "lib/goals.ts"))).toBe(false);
    expect(existsSync(path.join(ROOT, "lib/queries/training/goals.ts"))).toBe(
      false
    );
    const query = read("lib/queries/training/outcome-goals.ts");
    expect(query).toContain("export function getOutcomeGoals");
    expect(query).not.toMatch(/export function getGoals\b/);
  });
});
