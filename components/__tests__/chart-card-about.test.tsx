import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ChartCard from "@/components/ChartCard";

// THE NOTE-SLOT RULE (#4927): `about` is a CONSTANT explainer — the same
// sentence on every visit, about what the card IS — and renders as the
// title's info glyph. `note` is a FACT about the data in front of the reader
// and stays printed. A test that only checks the tooltip renders would pass
// with the sentence ALSO still printed under the header, so every case here
// asserts both halves: the glyph carries the text, and no `<p>` prints it.
const ABOUT =
  "An acute signal. Fevers are tracked on the illness chart, not as a long-term trend.";

describe("ChartCard: about renders as the title's info glyph, not the note slot (#4927)", () => {
  it("with a detailHref: glyph sits inside the header link, one tab stop, opens on focus and on tap", () => {
    render(
      <ChartCard title="Temperature" about={ABOUT} detailHref="/">
        <div />
      </ChartCard>
    );

    const link = screen.getByTestId("chart-card-header-link");
    const glyph = screen.getByRole("button", { name: ABOUT });
    expect(link.contains(glyph)).toBe(true);

    // ONE tab stop for the explainer — it is not duplicated anywhere else.
    expect(screen.getAllByRole("button", { name: ABOUT })).toHaveLength(1);

    // No tooltip panel exists until it is opened.
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(glyph);
    expect(screen.getByRole("tooltip").textContent).toBe(ABOUT);
    fireEvent.blur(glyph);

    fireEvent.click(glyph);
    expect(screen.getByRole("tooltip").textContent).toBe(ABOUT);
  });

  it("without a detailHref: still one glyph, still no note paragraph", () => {
    const { container } = render(
      <ChartCard title="Macros & fiber" about={ABOUT} detailHref={null}>
        <div />
      </ChartCard>
    );

    expect(screen.queryByTestId("chart-card-header-link")).toBeNull();
    expect(screen.getAllByRole("button", { name: ABOUT })).toHaveLength(1);
    // The note slot renders nothing but a `<p>`, and only when `note` is set —
    // this is the assertion a tooltip-only test would miss.
    expect(container.querySelector("p")).toBeNull();
  });

  it("a fact passed as note still prints, and never through the glyph", () => {
    const FACT = "3 of 5 days logged this week.";
    render(
      <ChartCard title="Cadence" note={FACT} detailHref={null}>
        <div />
      </ChartCard>
    );

    const printed = screen.getByText(FACT);
    expect(printed.tagName).toBe("P");
    expect(screen.queryByRole("button", { name: FACT })).toBeNull();
  });
});
