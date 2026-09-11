import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TimelineDayNav from "@/components/TimelineDayNav";
import { PageHeader } from "@/components/ui";
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
  //
  // THE SHORT GRAMMAR (#5764) is what the page now composes — `formatWeekdayDate`,
  // the spelling ruling 1 itself wrote — and these fixtures are spelled that way to
  // match. BE CLEAR ABOUT WHAT THAT BUYS: nothing. This component prints the string
  // it is handed, so the assertion below is true of every grammar and cannot fail on
  // the long one. The grammar is a claim about what `app/(app)/history/page.tsx`
  // COMPOSES and about whether the result fits beside two arrows at 390px, and both
  // are observed where they are real — `e2e/history.spec.ts`, against a painted bar.
  it.each([
    ["Wed, Sep 3 — 0 records", undefined],
    ["Wed, Sep 3 — 15 records", TOMORROW],
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
        day="Wed, Sep 3 — 15 records"
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
        day="Wed, Sep 3 — 0 records"
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

// ── THE BAR IS THE PHONE'S NAME, NOT EVERY WIDTH'S (#5764) ───────────────────
//
// The day view's h1 takes the day from `sm` up, so the bar printing it there would
// say the day twice the way the page used to say `History` twice. The hide is a
// PROP AND NOT THE COMPONENT'S DEFAULT, and the default is the half worth pinning:
// Home mounts this same bar under an `sr-only` "Home" h1, so there the bar is the
// only visible name of the day at EVERY width, and an unconditional `sm:hidden`
// would leave desktop Home with no date on it — a regression in a file #5764 never
// opens, caught by `e2e/machine-date-census.spec.ts`'s `/` route only afterwards.
//
// ON THE CLASS, which this repo normally refuses: jsdom computes no media query, so
// the hide itself is unobservable at this tier. What the browser paints is asserted
// in `e2e/history.spec.ts` (`timeline-day-name` hidden at 1280, visible at 390).
// This is the WIRING — that the opt-in reaches the element and that the default
// leaves it alone.
describe("the bar's name is the phone's, only when asked (#5764)", () => {
  it("hides the name from `sm` up when the page above it names the day", () => {
    render(
      <TimelineDayNav
        prev={YESTERDAY}
        next={TOMORROW}
        day="Wed, Sep 3 — 15 records"
        nameBelowSmOnly
        targetSelector="main"
      />
    );
    expect(screen.getByTestId("timeline-day-name").className).toContain(
      "sm:hidden"
    );
  });

  it("leaves the name at every width by default, which is Home's mount", () => {
    render(
      <TimelineDayNav
        prev={YESTERDAY}
        next={TOMORROW}
        day="Wed, Sep 3 — 15 records"
        targetSelector="main"
      />
    );
    expect(screen.getByTestId("timeline-day-name").className).not.toContain(
      "sm:hidden"
    );
  });

  // AND THE ARROWS STAY AT THE TWO EDGES. `justify-between` shares the slack, and the
  // name is what absorbed it; once the name can be `display:none`, an ungrouped bar of
  // prev / next / Select spreads THREE items evenly and parks the next-day arrow in
  // the middle of the column. The trailing end is one group, so the bar is two ends at
  // two edges whether or not the name is in the layout. Structure here, painted edges
  // in `e2e/history.spec.ts`.
  it("keeps the next arrow and the trailing control in one group at the far end", () => {
    render(
      <TimelineDayNav
        prev={YESTERDAY}
        next={TOMORROW}
        day="Wed, Sep 3 — 15 records"
        nameBelowSmOnly
        trailing={<button data-testid="day-nav-trailing">Select</button>}
        targetSelector="main"
      />
    );
    const nav = screen.getByTestId("timeline-day-nav");
    const next = screen.getByTestId("timeline-day-next");
    const trailing = screen.getByTestId("day-nav-trailing");
    // Neither is a direct child of the bar any more: they share one end.
    expect(next.parentElement).toBe(trailing.parentElement!.parentElement);
    expect(next.parentElement!.parentElement).toBe(nav);
    // …and the bar's own children are the prev arrow, the name, and that one group.
    expect([...nav.children].filter((el) => el.clientHeight >= 0).length).toBe(
      3
    );
    expect(nav.children[2]).toBe(next.parentElement);
  });
});

// ── THE HEADER CONTRACT #5764 RESTS ON ─────────────────────────────────────────
//
// A REGRESSION GUARD, AND IT IS NOT FALSIFIABLE BY THIS CHANGE: `PageHeader` is not
// edited on #5764: the day view's whole fix is passing it different props. That is
// exactly why the contract is worth pinning here. Three of its existing behaviours
// carry the fix, and each would break the day view silently if it moved —
//   • `back` renders ABOVE the h1 (#5411 ruling 4), so `← History` reads as the way
//     back from a page whose h1 is the day rather than as a second copy of it;
//   • `compactBelowSm` sends the h1 `sr-only` below `sm` (#1616/#1661), which is what
//     lets the day view take the h1 at all without spending a phone line on it;
//   • `compactBelowSm` drops the subtitle to `hidden` below `sm`, so the count costs
//     the phone nothing either — the day view's phone stack is unchanged (#5764's own
//     out-of-scope note about the chrome budget depends on this being true).
// AT hears ONE h1, and it is the day.
describe("the header contract the day view now leans on (#5764)", () => {
  it("renders the back link above one `sr-only`-below-sm h1 that names the day", () => {
    const { container } = render(
      <PageHeader
        back={{ href: "/history", destination: "History" }}
        title="Thursday, September 10"
        subtitle="13 records"
        compactBelowSm
      />
    );
    const headings = container.querySelectorAll("h1");
    expect(headings.length).toBe(1);
    const h1 = headings[0];
    expect(h1.textContent).toBe("Thursday, September 10");
    expect(h1.className).toContain("sr-only");
    expect(h1.className).toContain("sm:not-sr-only");

    const back = screen.getByRole("link", { name: "History" });
    // DOCUMENT_POSITION_FOLLOWING: the h1 comes after the back link, which is the
    // order the day view reads in — the way back, then the day.
    expect(
      back.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // The word `History` is printed exactly once, and the link is where it is.
    const historyTextNodes: Text[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent?.trim() === "History") historyTextNodes.push(n as Text);
    }
    expect(historyTextNodes.length).toBe(1);
    expect(back.contains(historyTextNodes[0])).toBe(true);

    const subtitle = screen.getByText("13 records");
    expect(subtitle.className).toContain("hidden");
    expect(subtitle.className).toContain("sm:block");
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

// Every chip is quiet by default (DaylightChip needs a home, CyclePhaseChip a
// phase), so this is the "nothing to add" shape most of this file's tests want —
// the rulings-4-and-7 tests are about the header and the waiting line, not #4918
// ruling 3's chips, which get their own describe block below.
const NO_CONTEXT = {
  home: null,
  timezone: "America/Los_Angeles",
  daylightOutdoor: 0,
  uv: null,
  cyclePhase: null,
  cyclePeriod: null,
  weather: null,
} as const;

describe("the chart card's header and context line (#4918 rulings 4 and 7)", () => {
  it("moves the instruction sentence behind a glyph and keeps the freshness line", () => {
    render(
      <IntradayPanel
        model={MODEL}
        formatPrefs={DEFAULT_FORMAT_PREFS}
        profileId={1}
        {...NO_CONTEXT}
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
        {...NO_CONTEXT}
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
        {...NO_CONTEXT}
      />
    );
    expect(screen.queryByTestId("intraday-context")).toBeNull();
  });
});

// #4918 ruling 3: the standalone `history-day-context` strip retired into this
// card's own context line. Real DaylightChip/CyclePhaseChip render here (only
// IntradayChart is mocked above), so this is the converse of the removal: the
// facts that strip used to carry must still be loud, inside `intraday-panel`.
describe("the day's context lives in the card now (#4918 ruling 3)", () => {
  const HOME = { lat: 37.77, lng: -122.42 };

  it("renders the daylight chip, the cycle phase chip, and the weather line inside the card", () => {
    render(
      <IntradayPanel
        model={MODEL}
        formatPrefs={DEFAULT_FORMAT_PREFS}
        profileId={1}
        home={HOME}
        timezone="America/Los_Angeles"
        daylightOutdoor={0}
        uv={null}
        cyclePhase="luteal"
        cyclePeriod={null}
        weather="Heatwave, day 3"
      />
    );
    const card = screen.getByTestId("intraday-panel");
    expect(card.querySelector('[data-testid="daylight-chip"]')).not.toBeNull();
    expect(
      card.querySelector('[data-testid="cycle-phase-chip"]')
    ).not.toBeNull();
    const weatherLine = card.querySelector(
      '[data-testid="history-day-weather"]'
    );
    expect(weatherLine).not.toBeNull();
    expect(weatherLine!.textContent).toBe("Heatwave, day 3");
  });

  it("draws none of it on an ordinary day — every chip stays quiet by default", () => {
    render(
      <IntradayPanel
        model={MODEL}
        formatPrefs={DEFAULT_FORMAT_PREFS}
        profileId={1}
        {...NO_CONTEXT}
      />
    );
    expect(screen.queryByTestId("daylight-chip")).toBeNull();
    expect(screen.queryByTestId("cycle-phase-chip")).toBeNull();
    expect(screen.queryByTestId("history-day-weather")).toBeNull();
  });
});
