import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RollingNumber from "@/components/RollingNumber";

function mediaQuery(): MediaQueryList {
  return {
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  };
}

describe("RollingNumber authoritative end state", () => {
  const frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    window.matchMedia = mediaQuery;
    frames.length = 0;
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("publishes a downward correction before its first animation frame", () => {
    const view = render(<RollingNumber value={1} testId="rolling" />);

    view.rerender(<RollingNumber value={0} testId="rolling" />);
    // Truth is synchronous with the prop. No animation frame has advanced yet,
    // but the DOM must never retain the pre-correction quantity.
    expect(screen.getByTestId("rolling").textContent).toBe("0");
    expect(screen.getByTestId("rolling").getAttribute("data-rolling")).toBe(
      "true"
    );
    expect(screen.getByTestId("rolling").getAttribute("data-motion-runs")).toBe(
      "1"
    );
    expect(frames).toHaveLength(1);
  });

  it("settles the bounded visual receipt when its frame lands", () => {
    const view = render(<RollingNumber value={1} testId="rolling" />);
    view.rerender(<RollingNumber value={0} testId="rolling" />);

    act(() => {
      frames.shift()?.(1_300);
    });

    expect(screen.getByTestId("rolling").textContent).toBe("0");
    expect(screen.getByTestId("rolling").getAttribute("data-rolling")).toBe(
      "false"
    );
  });
});
