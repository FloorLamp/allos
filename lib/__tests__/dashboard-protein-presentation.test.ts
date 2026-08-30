import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dashboard = readFileSync("app/(app)/page.tsx", "utf8");
const proteinPresentation = dashboard.slice(
  dashboard.indexOf("if (proteinToday)"),
  dashboard.indexOf("} else if (foodLoggingApplicable)")
);

describe("dashboard protein presentation", () => {
  it("names the tail moment without duplicating Standing's family label", () => {
    expect(proteinPresentation).toContain(
      'moment: { title: "Nutrition today", href: "/nutrition" }'
    );
    expect(proteinPresentation).not.toMatch(/\blabel:/);
  });
});
