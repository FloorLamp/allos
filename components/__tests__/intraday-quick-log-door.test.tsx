import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IntradayChart from "@/components/IntradayChart";
import IntradayPanel from "@/components/IntradayPanel";
import { ProfileDaysBoundary } from "@/components/DayContext";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";
import type { IntradayModel } from "@/lib/intraday";
import { intradayGeometry, projectMinute } from "@/lib/intraday-layout";

// THE CHART IS A LOGGING DOOR ON TODAY, AND ONLY ON TODAY (#5927, spec §3.2/§6.6).
//
// Two things are being separated here, and the past day is the one that makes the
// separation worth a test. A click at a minute on TODAY opens the Quicklogger with
// that minute; a click on a day the person is READING opens nothing and proposes
// nothing, because a minute prefilled onto a day nobody is logging into is a guess.
// Both are asserted against the SAME gesture at the SAME place on the plot, so the
// only difference between them is which day the chart was handed.
//
// AND THE MINUTE IS THE CLICKED ONE. Every assertion below reads the clock back from
// the prefill and compares it with the minute the pointer was put at — a fixed clock
// is frozen to a time no tap here lands on, so an implementation that proposed "now"
// would fail every one of them rather than passing by coincidence.
//
// The browser case (e2e/intraday-quick-log-door.spec.ts) owns the other half: that the
// form actually mounted holds the minute. This tier owns which minute is handed over.

const OPENED = vi.hoisted(() => vi.fn());
vi.mock("@/components/QuickEntryProvider", () => ({
  useOptionalQuickEntry: () => ({
    open: OPENED,
    close: () => {},
    noteSlotBoundaries: () => {},
  }),
}));

const DAY = "2026-09-03";
const PROFILE = 7;

// Spelled out rather than cast from a partial, for the reason the sibling chart spec
// states: the chart reads every field on this list.
const MODEL: IntradayModel = {
  date: DAY,
  minutesInDay: 24 * 60,
  hr: null,
  sleep: [],
  blocks: [],
  ticks: [],
  nowMinute: null,
  solarDay: null,
  expectedSleep: null,
};

function chart(today: string, opensQuickLog?: boolean) {
  return (
    <ProfileDaysBoundary
      clocks={new Map([[PROFILE, { today, timeZone: "UTC" }]])}
    >
      <IntradayChart
        model={MODEL}
        formatPrefs={DEFAULT_FORMAT_PREFS}
        className=""
        profileId={PROFILE}
        {...(opensQuickLog === undefined ? {} : { opensQuickLog })}
      />
    </ProfileDaysBoundary>
  );
}

/** The wide drawing's svg — both geometries are in the DOM at once (#4973). */
function svgOf(container: HTMLElement): SVGSVGElement {
  return container.querySelector<SVGSVGElement>(
    '[data-variant="wide"] [data-testid="intraday-svg"]'
  )!;
}

/** A real tap at `minute`: jsdom has no layout, so the geometry is supplied. */
function tap(svg: SVGSVGElement, minute: number): void {
  const geo = intradayGeometry(MODEL, "wide");
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, geo.viewBoxWidth, geo.height)
  );
  const at = (type: string) =>
    fireEvent(
      svg,
      Object.assign(
        new MouseEvent(type, {
          bubbles: true,
          clientX: projectMinute(geo, minute),
          clientY: (geo.padTop + geo.axisY) / 2,
          button: 0,
        }),
        { pointerId: 1, isPrimary: true }
      )
    );
  at("pointerdown");
  at("pointerup");
}

beforeEach(() => {
  OPENED.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("clicking the day chart at a time", () => {
  it("opens the Quicklogger on the clicked minute when the day is today", () => {
    const { container } = render(chart(DAY));
    tap(svgOf(container), 12 * 60 + 20);
    expect(OPENED).toHaveBeenCalledTimes(1);
    expect(OPENED).toHaveBeenCalledWith("food", { proposedAt: "12:20" });
  });

  it("carries the minute clicked, not the same one every time", () => {
    const { container } = render(chart(DAY));
    const svg = svgOf(container);
    tap(svg, 6 * 60 + 5);
    tap(svg, 19 * 60 + 10);
    expect(OPENED.mock.calls.map((call) => call[1].proposedAt)).toEqual([
      "06:05",
      "19:10",
    ]);
  });

  it("opens nothing on a past day, and proposes no minute", () => {
    // The same tap, on the same chart, one day after the day it draws.
    const { container } = render(chart("2026-09-04"));
    tap(svgOf(container), 12 * 60 + 20);
    expect(OPENED).not.toHaveBeenCalled();
    // AND THE READING AFFORDANCE SURVIVES: the tap still marks the minute it always
    // marked, which is what the record's add row reads (#4950).
    expect(
      container.querySelector(
        '[data-variant="wide"] [data-testid="intraday-selection"]'
      )
    ).not.toBeNull();
  });

  it("opens from the keyboard too, at the cursor's minute", () => {
    const { container } = render(chart(DAY));
    const svg = svgOf(container);
    fireEvent.keyDown(svg, { key: "Home" });
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    fireEvent.keyDown(svg, { key: "Enter" });
    expect(OPENED).toHaveBeenCalledWith("food", { proposedAt: "00:30" });
  });

  it("stays shut where the surface has its own add row", () => {
    // `IntradayPanel` is the record's day view, whose chips already read this gesture.
    const { container } = render(
      <ProfileDaysBoundary
        clocks={new Map([[PROFILE, { today: DAY, timeZone: "UTC" }]])}
      >
        <IntradayPanel
          model={MODEL}
          formatPrefs={DEFAULT_FORMAT_PREFS}
          profileId={PROFILE}
          home={null}
          timezone="UTC"
          daylightOutdoor={0}
          uv={null}
          cyclePhase={null}
          cyclePeriod={null}
          weather={null}
        />
      </ProfileDaysBoundary>
    );
    tap(svgOf(container), 12 * 60 + 20);
    expect(OPENED).not.toHaveBeenCalled();
  });
});
