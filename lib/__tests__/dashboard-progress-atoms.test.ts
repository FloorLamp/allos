import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HabitProgressAtom } from "@/components/dashboard/ProgressAtoms";

describe("dashboard progress atoms", () => {
  it("a met habit names its own target without claiming every habit is complete", () => {
    const html = renderToStaticMarkup(
      createElement(HabitProgressAtom, {
        progress: {
          target: {
            id: 7,
            scope_kind: "practice",
            scope_value: "Yoga",
            per_week: 3,
            per_week_max: null,
            created_at: "2026-08-01T00:00:00.000Z",
          },
          count: 3,
          per_week: 3,
          per_week_max: null,
          met: true,
          atCeiling: false,
          pace: "met",
          daysLeftInWindow: 2,
        },
      })
    );

    expect(html).toContain("Yoga");
    expect(html).toContain(">3/3</span>");
    expect(html).not.toContain("All weekly habits complete");
  });
});
