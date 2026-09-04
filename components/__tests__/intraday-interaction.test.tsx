import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

// Each consumer renders its own control rather than pushing a setter into module scope:
// mutating shared state during render is a side effect, and it would double under
// StrictMode. Clicking one consumer's button is also closer to what happens for real —
// one variant receives the gesture and the other has to agree.
function Consumer({
  label,
  window: w,
}: {
  label: string;
  window: { from: number; to: number };
}) {
  const { view, setView, cursor } = useIntradayInteraction();
  const shown = windowFromView(view, cursor);
  return (
    <div>
      <button data-testid={`set-${label}`} onClick={() => setView(w)} />
      <div data-testid={`consumer-${label}`}>
        {shown ? `${shown.from}-${shown.to ?? "start"}` : "none"}
      </div>
    </div>
  );
}

afterEach(cleanup);

describe("the day chart's interaction state", () => {
  it("is ONE window across both chart variants under a provider", () => {
    render(
      <IntradayInteractionProvider>
        <Consumer
          label="compact"
          window={{ from: 19 * 60 + 10, to: 20 * 60 + 40 }}
        />
        <Consumer label="wide" window={{ from: 6 * 60, to: 8 * 60 }} />
      </IntradayInteractionProvider>
    );
    expect(screen.getByTestId("consumer-compact").textContent).toBe("none");
    expect(screen.getByTestId("consumer-wide").textContent).toBe("none");

    // The visible variant zooms; the hidden one must agree rather than hold its own.
    fireEvent.click(screen.getByTestId("set-compact"));
    expect(screen.getByTestId("consumer-compact").textContent).toBe(
      "1150-1240"
    );
    expect(screen.getByTestId("consumer-wide").textContent).toBe("1150-1240");
  });

  it("lets the OTHER variant move it too, so neither is the owner", () => {
    render(
      <IntradayInteractionProvider>
        <Consumer
          label="compact"
          window={{ from: 19 * 60 + 10, to: 20 * 60 + 40 }}
        />
        <Consumer label="wide" window={{ from: 6 * 60, to: 8 * 60 }} />
      </IntradayInteractionProvider>
    );
    fireEvent.click(screen.getByTestId("set-wide"));
    expect(screen.getByTestId("consumer-compact").textContent).toBe("360-480");
    expect(screen.getByTestId("consumer-wide").textContent).toBe("360-480");
  });

  it("keeps a private pair when there is no provider, so an isolated chart still works", () => {
    // The fallback is what stops this lift from making the chart depend on a wrapper.
    // It is also what the chart's own tests mount against.
    render(
      <>
        <Consumer
          label="alone-a"
          window={{ from: 19 * 60 + 10, to: 20 * 60 + 40 }}
        />
        <Consumer label="alone-b" window={{ from: 6 * 60, to: 8 * 60 }} />
      </>
    );
    fireEvent.click(screen.getByTestId("set-alone-a"));
    expect(screen.getByTestId("consumer-alone-a").textContent).toBe(
      "1150-1240"
    );
    // Independent, which is the whole point of the fallback — and the exact behaviour
    // that would be WRONG inside the day page, which is why the provider exists.
    expect(screen.getByTestId("consumer-alone-b").textContent).toBe("none");
  });
});
