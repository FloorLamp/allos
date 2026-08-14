import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("shared reading follow-up vocabulary (#2732)", () => {
  it("uses neutral names at the lab and IOP seam", () => {
    const component = path.join(
      ROOT,
      "app/(app)/results/readings/TrackReadingFollowUpControl.tsx"
    );
    const actions = path.join(
      ROOT,
      "app/(app)/results/readings/followup-actions.ts"
    );
    const queries = fs.readFileSync(
      path.join(ROOT, "lib/queries/clinical.ts"),
      "utf8"
    );

    expect(fs.existsSync(component)).toBe(true);
    expect(fs.existsSync(actions)).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          ROOT,
          "app/(app)/results/readings/TrackLabFollowUpControl.tsx"
        )
      )
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(ROOT, "app/(app)/results/readings/biomarker-actions.ts")
      )
    ).toBe(false);
    expect(queries).toContain("interface ReadingFollowUpSummary");
    expect(queries).not.toContain("interface LabFollowUpSummary");
  });
});
