import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MeasurementsQuickAdd from "@/app/(app)/trends/MeasurementsQuickAdd";

// THE MEASUREMENTS FORM'S OWN CHROME (#4977 items 2 and 3).
//
// Two claims the rendered markup can carry on its own, in both presentations the
// form has: the blood-pressure cell asks the grid for two tracks because it holds
// two controls, and the constant explainer sentence is the title's glyph rather
// than a paragraph. The WIDTHS those produce are measured where widths exist —
// e2e/measurements-form-layout.spec.ts — because a jsdom tree has no layout and a
// class assertion is all this tier can honestly make about a span.

vi.mock("@/app/(app)/trends/measurement-actions", () => ({
  addMeasurements: async () => ({}),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: async () => "kept" }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  Element.prototype.scrollIntoView ??= () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  cleanup();
});

afterEach(() => {
  vi.useRealTimers();
});

const ABOUT = /fill in only what you measured/;

// The default timezone is UTC (components/TimezoneProvider.tsx), so a frozen
// clock makes `defaultDate` the control's own "today" — which is what puts the
// one-tap "Now" on the surface beside the commit.
const TODAY = "2026-05-20";

function mount(presentation: "card" | "modal") {
  render(
    <MeasurementsQuickAdd
      defaultDate={TODAY}
      weightUnit="kg"
      defaultGroup="vitals"
      presentation={presentation}
    />
  );
}

/** Every control on the mounted surface wearing the one primary paint. */
const primaries = () =>
  Array.from(document.querySelectorAll(".button-control-primary"));

/** The grid cell a field's control sits in — the element the grid lays out. */
function cellOf(id: string): HTMLElement {
  const control = document.querySelector<HTMLElement>(id);
  return control!.closest<HTMLElement>("div.min-w-0")!;
}

it.each(["card", "modal"] as const)(
  "%s: the pair's cell takes two tracks and a single-control cell takes one",
  (presentation) => {
    mount(presentation);
    // The pair, against a neighbour in the same group. Asserted as the DIFFERENCE
    // between two real cells: "the BP cell spans two" is also true of a form that
    // spanned every cell, which would be a one-column grid wearing a span.
    //
    // AND THE SPAN MUST BE CONTAINER-GATED. An UNGATED `col-span-2` is the defect
    // measured at 320px in e2e/measurements-form-layout.spec.ts — `auto-fit` counts
    // one column, the span invents a second sized from content, and the next field
    // lands in an 82px track. The bare spelling is what that regression looks like
    // in the markup, so it is named here rather than only caught by geometry.
    expect(cellOf("#m-systolic").className).toContain(
      "@min-[21.75rem]:col-span-2"
    );
    expect(cellOf("#m-systolic").className).not.toMatch(
      /(^|\s)col-span-2(\s|$)/
    );
    expect(cellOf("#m-diastolic")).toBe(cellOf("#m-systolic"));
    expect(cellOf("#m-resting-hr").className).not.toContain("col-span");
  }
);

it.each(["card", "modal"] as const)(
  "%s: the explainer is the title's glyph, not a paragraph",
  (presentation) => {
    mount(presentation);
    expect(screen.queryByText(ABOUT)).toBeNull();
    expect(screen.getByTestId("measurements-help")).toHaveProperty(
      "ariaLabel",
      expect.stringMatching(ABOUT)
    );
  }
);

// THE FORM'S COMMIT OUTRANKS ITS HELPER (#4978 item 2, from #4977's sighting).
// The owner reported "Save measurements" reading quieter than the "Now" beside
// it: the commit rendered the plain secondary while the helper wore the ghost's
// fill. Asserted as the RELATIONSHIP between the two real controls plus the
// admission rule (#3982: at most one primary per surface), because "Save has
// the paint" is also true of a form that painted everything primary.
it.each(["card", "modal"] as const)(
  "%s: the commit wears the one primary paint and the Now beside it does not",
  (presentation) => {
    mount(presentation);
    const save = screen.getByRole("button", { name: "Save measurements" });
    const now = screen.getByTestId("m-now");
    expect(save.className).toContain("button-control-primary");
    expect(now.className).not.toContain("button-control-primary");
    expect(primaries()).toEqual([save]);
  }
);
