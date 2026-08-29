import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FoldSummary from "@/app/(app)/upcoming/FoldSummary";
import Disclosure from "@/components/Disclosure";

function mediaQuery(reduced: boolean): MediaQueryList {
  return {
    matches: reduced,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  };
}

function fold(count: number) {
  return (
    <Disclosure summary={<FoldSummary count={count} />}>
      <div>Suppressed rows</div>
    </Disclosure>
  );
}

describe("FoldSummary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = () => mediaQuery(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps authoritative text and pulses only when the fold gains a row", () => {
    const view = render(fold(2));
    const summary = screen.getByTestId("suppressed-pulse");

    // The pulse rides the summary's visible LINE, inside the `<summary>` the shared
    // disclosure owns (#3677) — so the line the count sits on is the thing that rings,
    // and the summary's own box, which the phone tap floor is measured against, never
    // changes size.
    expect(summary.tagName).toBe("SPAN");
    expect(summary.closest("summary")).not.toBeNull();
    expect(summary.textContent).toBe("Snoozed & dismissed (2)");
    expect(summary.getAttribute("data-pulsing")).toBe("false");
    expect(summary.className).toBe("inline-block rounded-lg");

    view.rerender(fold(1));
    expect(summary.textContent).toBe("Snoozed & dismissed (1)");
    expect(summary.getAttribute("data-pulsing")).toBe("false");

    view.rerender(fold(3));
    expect(summary.textContent).toBe("Snoozed & dismissed (3)");
    expect(summary.getAttribute("data-pulsing")).toBe("true");
    expect(summary.className).toContain("motion-fold");

    act(() => vi.advanceTimersByTime(500));
    expect(summary.getAttribute("data-pulsing")).toBe("false");
    expect(summary.className).not.toContain("motion-fold");
  });

  it("publishes the new count without a pulse under reduced motion", () => {
    window.matchMedia = () => mediaQuery(true);
    const view = render(fold(2));
    const summary = screen.getByTestId("suppressed-pulse");

    view.rerender(fold(3));
    expect(summary.textContent).toBe("Snoozed & dismissed (3)");
    expect(summary.getAttribute("data-reduced-motion")).toBe("true");
    expect(summary.getAttribute("data-pulsing")).toBe("false");
    expect(summary.className).not.toContain("motion-fold");
  });
});
