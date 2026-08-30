import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CoverageGaps from "@/components/CoverageGaps";

vi.mock("@/app/(app)/data/coverage-actions", () => ({}));

describe("declined analyte destinations (#2766)", () => {
  it("routes both Total Mass spellings to weight without changing instead links", () => {
    render(
      <CoverageGaps
        tracked={[]}
        candidates={[]}
        requests={{}}
        aiConfigured={false}
        aiLabel="AI"
        declined={[
          ...["Total Mass", "Total Mass (g)"].map((label) => ({
            kind: "biomarker" as const,
            itemKey: label,
            label,
            declaration: { kind: "out-of-scope" as const, reason: "DEXA" },
          })),
          {
            kind: "biomarker",
            itemKey: "egfr",
            label: "eGFR, African American",
            declaration: {
              kind: "covered-elsewhere",
              instead: "Estimated Glomerular Filtration Rate (eGFR)",
              reason: "Uses the race-free result",
            },
          },
        ]}
      />
    );

    const weight = screen.getAllByRole("link", { name: "See Weight" });
    expect(weight.map((link) => link.getAttribute("href"))).toEqual([
      "/trends/metric/weight",
      "/trends/metric/weight",
    ]);
    expect(
      screen
        .getByRole("link", {
          name: "See Estimated Glomerular Filtration Rate (eGFR)",
        })
        .getAttribute("href")
    ).toContain("Estimated%20Glomerular%20Filtration%20Rate");
  });
});
