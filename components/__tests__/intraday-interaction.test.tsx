import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  IntradayInteractionProvider,
  useIntradayInteraction,
} from "@/components/IntradayInteraction";
import { windowFromView } from "@/lib/intraday-window";

// ONE WINDOW FOR THE DAY (#4950), tested on the mechanism rather than on the pixels.
//
// `IntradayPanel` mounts the chart TWICE, both in the DOM at once, and the owner's
// amendment makes something OUTSIDE the chart read "the current view". With two owners
// there are two views and the page cannot tell which variant the viewport is showing.
//
// What has to be true is a property of the state, not of the SVG: two consumers under
// one provider see one value, and two consumers with no provider stay independent.
// Driving a real zoom would need jsdom to answer `getBoundingClientRect`, and would test
// the geometry on the way to testing the sharing.

let setters: ((from: number, to: number) => void)[] = [];

function Consumer({ label }: { label: string }) {
  const { view, setView, cursor } = useIntradayInteraction();
  setters.push((from, to) => setView({ from, to }));
  const shown = windowFromView(view, cursor);
  return (
    <div data-testid={`consumer-${label}`}>
      {shown ? `${shown.from}-${shown.to ?? "start"}` : "none"}
    </div>
  );
}

afterEach(() => {
  setters = [];
  cleanup();
});

describe("the day chart's interaction state", () => {
  it("is ONE window across both chart variants under a provider", () => {
    render(
      <IntradayInteractionProvider>
        <Consumer label="compact" />
        <Consumer label="wide" />
      </IntradayInteractionProvider>
    );
    expect(screen.getByTestId("consumer-compact").textContent).toBe("none");
    expect(screen.getByTestId("consumer-wide").textContent).toBe("none");

    // The visible variant zooms; the hidden one must agree rather than hold its own.
    act(() => setters[0](19 * 60 + 10, 20 * 60 + 40));
    expect(screen.getByTestId("consumer-compact").textContent).toBe(
      "1150-1240"
    );
    expect(screen.getByTestId("consumer-wide").textContent).toBe("1150-1240");
  });

  it("lets the OTHER variant move it too, so neither is the owner", () => {
    render(
      <IntradayInteractionProvider>
        <Consumer label="compact" />
        <Consumer label="wide" />
      </IntradayInteractionProvider>
    );
    act(() => setters[1](6 * 60, 8 * 60));
    expect(screen.getByTestId("consumer-compact").textContent).toBe("360-480");
    expect(screen.getByTestId("consumer-wide").textContent).toBe("360-480");
  });

  it("keeps a private pair when there is no provider, so an isolated chart still works", () => {
    // The fallback is what stops this lift from making the chart depend on a wrapper.
    // It is also what the chart's own tests mount against.
    render(
      <>
        <Consumer label="alone-a" />
        <Consumer label="alone-b" />
      </>
    );
    act(() => setters[0](19 * 60 + 10, 20 * 60 + 40));
    expect(screen.getByTestId("consumer-alone-a").textContent).toBe(
      "1150-1240"
    );
    // Independent, which is the whole point of the fallback — and the exact behaviour
    // that would be WRONG inside the day page, which is why the provider exists.
    expect(screen.getByTestId("consumer-alone-b").textContent).toBe("none");
  });
});
