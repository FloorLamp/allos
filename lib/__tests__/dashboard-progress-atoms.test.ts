import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WeeklyTargets } from "@/components/WeeklyTargets";

// A MET HABIT NAMES ITS OWN TARGET. The dashboard's mount of this component retired
// with its card (#4076) — the habit is a row now, labelled by its own scope — but the
// claim was never about the mount: it is about what WeeklyTargets says when it holds
// ONE met target, on /training where it still renders. A component that answered
// "every habit is complete" to a list of one would be wrong on every surface.
describe("weekly target chips", () => {
  it("a met habit names its own target without claiming every habit is complete", () => {
    const html = renderToStaticMarkup(
      createElement(WeeklyTargets, {
        targets: [
          {
            id: 7,
            label: "Yoga",
            count: 3,
            perWeek: 3,
            met: true,
            pace: "met" as const,
          },
        ],
      })
    );

    expect(html).toContain("Yoga");
    expect(html).toContain(">3/3</span>");
    expect(html).not.toContain("All weekly habits complete");
  });
});
