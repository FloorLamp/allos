import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PageContainer, { type PageWidth } from "@/components/PageContainer";

// #3961: alignment belongs to the primitive, not to each call site. Before this,
// whether a capped page centered was a per-page `mx-auto` in `className`, and it
// drifted — the episodes index hugged the left of a 1770px main area while its own
// detail page centered. The invariant below is what replaces that convention: a
// capped width centers unless the page says `align="start"`, and `full` — which has
// no cap to align — is untouched by either.
function classesOf(width: PageWidth, align?: "center" | "start"): string[] {
  const { container, unmount } = render(
    <PageContainer width={width} align={align}>
      body
    </PageContainer>
  );
  const classes = (container.firstElementChild as HTMLElement).className
    .split(" ")
    .filter(Boolean);
  unmount();
  return classes;
}

const CAPPED: PageWidth[] = [
  "form",
  "narrow",
  "reading",
  "rail",
  "flow",
  "wide",
];

describe("PageContainer alignment (#3961)", () => {
  it.each(CAPPED)("centers %s by default and under align=center", (width) => {
    expect(classesOf(width)).toContain("mx-auto");
    expect(classesOf(width, "center")).toContain("mx-auto");
  });

  it.each(CAPPED)("left-anchors %s under align=start", (width) => {
    expect(classesOf(width, "start")).not.toContain("mx-auto");
  });

  it("keeps the width cap whichever alignment is asked for", () => {
    expect(classesOf("reading")).toContain("max-w-3xl");
    expect(classesOf("reading", "start")).toContain("max-w-3xl");
    // `rail` is two tokens; both survive.
    expect(classesOf("rail", "start")).toEqual([
      "max-w-3xl",
      "min-[1440px]:max-w-[97rem]",
    ]);
  });

  it("never centers full, which has no cap to align", () => {
    expect(classesOf("full")).toEqual([]);
    expect(classesOf("full", "center")).toEqual([]);
    expect(classesOf("full", "start")).toEqual([]);
  });

  it("appends className after the measure rather than replacing it", () => {
    expect(classesOf("flow", undefined)).toEqual(["max-w-4xl", "mx-auto"]);
    render(
      <PageContainer width="flow" className="space-y-6" data-testid="spaced">
        body
      </PageContainer>
    );
    expect(screen.getByTestId("spaced").className).toBe(
      "max-w-4xl mx-auto space-y-6"
    );
  });
});
