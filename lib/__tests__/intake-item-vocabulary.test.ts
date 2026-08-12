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
      "app/(app)/nutrition/intake-actions.ts",
      "components/IntakeItemCombobox.tsx",
    ]) {
      expect(fs.existsSync(path.join(repo, current)), current).toBe(true);
    }
    for (const retired of [
      "lib/supplement-schedule.ts",
      "lib/supplement-adherence.ts",
      "app/(app)/nutrition/supplement-actions.ts",
      "components/SupplementCombobox.tsx",
    ]) {
      expect(fs.existsSync(path.join(repo, retired)), retired).toBe(false);
    }
  });
});
