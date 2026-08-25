import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FoldSummary from "@/app/(app)/upcoming/FoldSummary";

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
    <details>
      <FoldSummary count={count} />
      <div>Suppressed rows</div>
    </details>
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
    const summary = screen.getByTestId("suppressed-summary");

    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.textContent).toBe("Snoozed & dismissed (2)");
    expect(summary.getAttribute("data-pulsing")).toBe("false");
    expect(summary.className).toBe(
      "min-h-11 cursor-pointer py-3.5 section-label sm:min-h-0 sm:py-0"
    );

    view.rerender(fold(1));
    expect(summary.textContent).toBe("Snoozed & dismissed (1)");
    expect(summary.getAttribute("data-pulsing")).toBe("false");

    view.rerender(fold(3));
    expect(summary.textContent).toBe("Snoozed & dismissed (3)");
    expect(summary.getAttribute("data-pulsing")).toBe("true");
    expect(summary.querySelector(".motion-fold")).not.toBeNull();

    act(() => vi.advanceTimersByTime(500));
    expect(summary.getAttribute("data-pulsing")).toBe("false");
    expect(summary.querySelector(".motion-fold")).toBeNull();
  });

  it("publishes the new count without a pulse under reduced motion", () => {
    window.matchMedia = () => mediaQuery(true);
    const view = render(fold(2));
    const summary = screen.getByTestId("suppressed-summary");

    view.rerender(fold(3));
    expect(summary.textContent).toBe("Snoozed & dismissed (3)");
    expect(summary.getAttribute("data-reduced-motion")).toBe("true");
    expect(summary.getAttribute("data-pulsing")).toBe("false");
    expect(summary.querySelector(".motion-fold")).toBeNull();
  });
});
