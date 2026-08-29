import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// SOURCE-SCAN tier — protect the startup boundary behind issue #3520.
//
// lib/db.ts loads the migration registry, which reaches metric-window-overlap through
// the frozen Health Connect overlap migration. Importing the full parser from that
// helper made essentially every DB spec transform the parser and its broad application
// graph before the spec could run. The shared constants now live in a leaf module.
describe("database startup import boundary", () => {
  it("keeps the migration overlap helper off the full Health Connect parser", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/metric-window-overlap.ts"),
      "utf8"
    );

    expect(source).toContain('from "./integrations/health-connect-metrics"');
    expect(source).not.toContain('from "./integrations/health-connect"');
  });

  it("keeps the shared Health Connect metric policy dependency-free", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/integrations/health-connect-metrics.ts"),
      "utf8"
    );

    expect(source).not.toMatch(
      /\b(?:import|require)\s*(?:\(|[^;]*?from\s*)?["']/
    );
  });
});
