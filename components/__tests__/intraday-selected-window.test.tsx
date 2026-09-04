import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import IntradayChart from "@/components/IntradayChart";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";
import type { IntradayModel } from "@/lib/intraday";
import { parseIntradayWindow } from "@/lib/intraday-window";

// A window stated in the URL is DRAWN by the chart (#4950).
//
// The mark has to come from the server render rather than from client state, and this
// is the tier that can see the difference: the selection stays under the add form while
// a person fills it in, and it survives a reload of the link they were sent, neither of
// which a `useState` in the chart could do.
//
// The two sources — a live drag and a stated window — paint the same rect, so what is
// asserted here is that the stated one appears with NO gesture at all.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

// The whole model, spelled out rather than cast from a partial: the chart reads every
// field on this list, and a `as unknown as IntradayModel` over three of them is how a
// fixture starts passing for a reason the component does not have.
const MODEL: IntradayModel = {
  date: "2026-09-03",
  minutesInDay: 24 * 60,
  hr: null,
  sleep: [],
  blocks: [],
  ticks: [],
  nowMinute: null,
  solarDay: null,
  expectedSleep: null,
};

const chart = (selectedWindow: { from: number; to: number | null } | null) => (
  <IntradayChart
    model={MODEL}
    formatPrefs={DEFAULT_FORMAT_PREFS}
    variant="wide"
    className=""
    profileId={1}
    selectedWindow={selectedWindow}
  />
);

afterEach(cleanup);

describe("the chart draws the window the URL states", () => {
  it("draws nothing when no window is stated", () => {
    render(chart(null));
    expect(screen.queryByTestId("intraday-selection")).toBeNull();
  });

  it("draws a band for a window, spanning exactly its minutes", () => {
    // 19:10 → 20:40, the issue's own example.
    render(chart({ from: 19 * 60 + 10, to: 20 * 60 + 40 }));
    const band = screen.getByTestId("intraday-selection");
    const x = Number(band.getAttribute("x"));
    const width = Number(band.getAttribute("width"));
    // Geometry is the chart's, so the assertion is a RELATIONSHIP rather than a pixel
    // count: 90 of the day's 1440 minutes, at whatever scale this variant draws.
    const full = render(
      chart({ from: 0, to: 24 * 60 - 5 })
    ).container.querySelector('[data-testid="intraday-selection"]')!;
    const fullWidth = Number(full.getAttribute("width"));
    expect(width / fullWidth).toBeCloseTo(90 / (24 * 60 - 5), 2);
    expect(x).toBeGreaterThan(0);
  });

  it("draws a start alone as a hairline, not as a zero-width nothing", () => {
    render(chart({ from: 19 * 60 + 10, to: null }));
    const band = screen.getByTestId("intraday-selection");
    // A tap marks when something began; the width floor is what keeps it visible.
    expect(Number(band.getAttribute("width"))).toBeGreaterThanOrEqual(1);
  });

  it("draws the SNAPPED clocks the parser returns, not the raw ones", () => {
    // The loop the param exists for, closed end to end: the clocks a link carries, the
    // parser the page uses, the mark the chart paints. `19:12–20:41` snaps to
    // `19:10–20:40`, and the band drawn from the parsed window has to be the band drawn
    // from those snapped minutes — otherwise the highlight sits beside the reading it
    // is pointing at.
    const parsed = parseIntradayWindow("19:12", "20:41");
    expect(parsed).toEqual({ from: 19 * 60 + 10, to: 20 * 60 + 40 });

    const fromParam = render(chart(parsed)).container.querySelector(
      '[data-testid="intraday-selection"]'
    )!;
    cleanup();
    const fromMinutes = render(
      chart({ from: 19 * 60 + 10, to: 20 * 60 + 40 })
    ).container.querySelector('[data-testid="intraday-selection"]')!;

    expect(fromParam.getAttribute("x")).toBe(fromMinutes.getAttribute("x"));
    expect(fromParam.getAttribute("width")).toBe(
      fromMinutes.getAttribute("width")
    );
  });
});
