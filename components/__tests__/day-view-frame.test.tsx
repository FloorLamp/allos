import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TimelineDayNav from "@/components/TimelineDayNav";
import IntradayPanel from "@/components/IntradayPanel";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";
import type { IntradayModel } from "@/lib/intraday";
import type { SleepWaitingState } from "@/lib/sleep-waiting";

// THE DAY VIEW'S FRAME (#4918), at the tier that can observe each defect.
//
// Three of the four defects the owner screenshotted are facts about what one
// component renders, so they are asserted here rather than through a browser:
// whether the bar NAMES the day (it did not — the only date text was a per-group
// header, which a day with no rows never renders), whether today's next control
// EXISTS (it did, pointing at the page it was on), and whether the chart card says
// last night's sleep is still on its way (nothing did). The fourth — the offer
// overflowing its column — is a painted width and belongs to e2e.
//
// `useDragGesture` is stubbed to RECORD rather than to no-op. The self-link had a
// twin: the leftward swipe pushed `nextHref` unconditionally, so an assertion about
// the arrow alone would have passed over a gesture still doing the same thing. What
// the stub captures is the `enabled` flag, which is the one place the two now agree.
const gestures: { direction: string; enabled: boolean }[] = [];
vi.mock("@/components/overlay", () => ({
  useDragGesture: (options: { direction: string; enabled?: boolean }) => {
    gestures.push({
      direction: options.direction,
      enabled: options.enabled ?? true,
    });
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/components/useShellChrome", () => ({
  useShellChrome: () => ({ hidden: false, ready: true }),
}));
// The chart itself is another lane's subject and draws an SVG this file makes no
// claim about; the panel's HEADER and context line are what #4918 moved.
vi.mock("@/components/IntradayChart", () => ({
  default: () => <div data-testid="intraday-chart-stub" />,
}));

afterEach(() => {
  cleanup();
  gestures.length = 0;
});

const YESTERDAY = { href: "/history?day=2026-09-02" as const, label: "Sep 2" };
const TOMORROW = { href: "/history?day=2026-09-04" as const, label: "Sep 4" };

describe("the day bar names the day (#4918 ruling 1)", () => {
  // "0 records" is not an edge case here, it is THE case: the empty day is the one
  // the per-group header could never name, because it renders once per group of rows.
  it.each([
    ["Wed, September 3 — 0 records", undefined],
    ["Wed, September 3 — 15 records", TOMORROW],
  ])("prints %s whether or not there is a next day", (label, next) => {
    render(
      <TimelineDayNav
        prev={YESTERDAY}
        next={next}
        day={label}
        targetSelector="main"
      />
    );
    expect(screen.getByTestId("timeline-day-name").textContent).toBe(label);
  });
});

describe("today draws no next destination at all (#4918 ruling 1)", () => {
  it("renders the arrow and enables the leftward swipe when a next day exists", () => {
    render(
      <TimelineDayNav
        prev={YESTERDAY}
        next={TOMORROW}
        day="Wed, September 3 — 15 records"
        targetSelector="main"
      />
    );
    expect(screen.getByTestId("timeline-day-next").getAttribute("href")).toBe(
      TOMORROW.href
    );
    expect(gestures).toContainEqual({ direction: "left", enabled: true });
  });

  it("renders neither the arrow nor the swipe on today", () => {
    render(
      <TimelineDayNav
        prev={YESTERDAY}
        day="Wed, September 3 — 0 records"
        targetSelector="main"
      />
    );
    expect(screen.queryByTestId("timeline-day-next")).toBeNull();
    // The prev arrow is untouched — a removal guard that could not tell "today has
    // no next" from "the bar lost its controls" would pass on both.
    expect(screen.getByTestId("timeline-day-prev").getAttribute("href")).toBe(
      YESTERDAY.href
    );
    expect(gestures).toContainEqual({ direction: "left", enabled: false });
    expect(gestures).toContainEqual({ direction: "right", enabled: true });
  });
});

const MODEL = {
  date: "2026-09-03",
  nowMinute: 405,
  lastSampleMinute: 364,
  spans: [],
  series: [],
  events: [],
} as unknown as IntradayModel;

const WAITING: SleepWaitingState = {
  kind: "waiting",
  headline: "Waiting for last night's sleep",
  etaMinutes: 424,
  lastCheckedAt: null,
};

describe("the chart card's header and context line (#4918 rulings 4 and 7)", () => {
  it("moves the instruction sentence behind a glyph and keeps the freshness line", () => {
    render(
      <IntradayPanel
        model={MODEL}
        formatPrefs={DEFAULT_FORMAT_PREFS}
        profileId={1}
      />
    );
    // The sentence is no longer a permanent line; it is the glyph's accessible name.
    expect(screen.queryByText(/drag to zoom · tap a mark to jump/)).toBeNull();
    expect(
      screen.getByRole("button", {
        name: /Midnight to midnight · drag to zoom · tap a mark to jump to its entry/,
      })
    ).not.toBeNull();
    // The converse: what the header must STILL carry. A card whose title row lost
    // its freshness line would satisfy every absence assertion above.
    expect(screen.queryByTestId("intraday-freshness")).not.toBeNull();
  });

  it("names the unarrived night and its ETA, and says nothing when the night is in", () => {
    const { rerender } = render(
      <IntradayPanel
        model={MODEL}
        formatPrefs={DEFAULT_FORMAT_PREFS}
        profileId={1}
        waiting={WAITING}
        waitingDetail="Usually in by ~07:04"
      />
    );
    const headline = screen.getByTestId("sleep-waiting-headline");
    expect(headline.getAttribute("data-kind")).toBe("waiting");
    expect(screen.getByTestId("intraday-context").textContent).toBe(
      "Waiting for last night's sleep · Usually in by ~07:04"
    );
    // The freshness sentence stays: the two lines say different things, and the
    // defect was that only the reassuring one was on screen.
    expect(screen.queryByTestId("intraday-freshness")).not.toBeNull();

    rerender(
      <IntradayPanel
        model={MODEL}
        formatPrefs={DEFAULT_FORMAT_PREFS}
        profileId={1}
      />
    );
    expect(screen.queryByTestId("intraday-context")).toBeNull();
  });
});
