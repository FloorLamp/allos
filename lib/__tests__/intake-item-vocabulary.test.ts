import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

describe("shared intake-item vocabulary (#2484)", () => {
  it("uses neutral names for the supplement and medication model", () => {
    const source = fs.readFileSync(
      path.join(repo, "lib/types/intake.ts"),
      "utf8"
    );
    for (const retired of [
      "interface Supplement {",
      "type SupplementKind =",
      "interface SupplementDose {",
      "type SupplementCondition =",
      "interface SupplementPair {",
    ]) {
      expect(source, retired).not.toContain(retired);
    }
    for (const current of [
      "interface IntakeItem {",
      "type IntakeItemKind =",
      "interface IntakeDose {",
      "type IntakeCondition =",
      "interface IntakePair {",
    ]) {
      expect(source, current).toContain(current);
    }
  });

  it("keeps shared modules and actions intake-named", () => {
    for (const current of [
      "lib/intake-schedule.ts",
      "lib/intake-adherence.ts",
      "lib/notifications/intake.ts",
      "lib/notifications/intake-format.ts",
      "app/(app)/nutrition/intake-actions.ts",
      "components/IntakeItemCombobox.tsx",
    ]) {
      expect(fs.existsSync(path.join(repo, current)), current).toBe(true);
    }
    for (const retired of [
      "lib/supplement-schedule.ts",
      "lib/supplement-adherence.ts",
      "lib/notifications/supplements.ts",
      "lib/notifications/supplement-format.ts",
      "app/(app)/nutrition/supplement-actions.ts",
      "components/SupplementCombobox.tsx",
    ]) {
      expect(fs.existsSync(path.join(repo, retired)), retired).toBe(false);
    }
  });

  it("keeps medication-capable notification and adherence code item-neutral", () => {
    const roots = [
      "lib/notifications",
      "lib/queries/intake",
      "lib/intake-adherence.ts",
      "lib/intake-schedule.ts",
      "lib/household.ts",
      "lib/adherence-patterns.ts",
      "lib/refill-nudge.ts",
      "lib/rule-findings.ts",
      "lib/queries/upcoming/intake-safety.ts",
      "app/(app)/nutrition/intake-actions.ts",
    ];
    const files = roots.flatMap((relative) => {
      const absolute = path.join(repo, relative);
      if (fs.statSync(absolute).isFile()) return [absolute];
      return fs
        .readdirSync(absolute, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => path.join(entry.parentPath, entry.name));
    });
    const retired =
      /\b(?:supp|supps|suppId|suppById|supplementId|supplementName)\b|\b(?:const|let|var)\s+supplements\b/;
    const offenders = files
      .map((file) => ({
        file: path.relative(repo, file),
        source: fs.readFileSync(file, "utf8"),
      }))
      .filter(({ source }) => retired.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
