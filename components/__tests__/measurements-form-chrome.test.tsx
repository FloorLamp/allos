import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
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

const ABOUT = /fill in only what you measured/;

function mount(presentation: "card" | "modal") {
  render(
    <MeasurementsQuickAdd
      defaultDate="2026-05-20"
      weightUnit="kg"
      defaultGroup="vitals"
      presentation={presentation}
    />
  );
}

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
    expect(cellOf("#m-systolic").className).toContain("col-span-2");
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
