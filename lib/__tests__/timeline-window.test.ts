import { describe, expect, it } from "vitest";
import {
  allTimelineMonths,
  foldKeyHiding,
  parseTimelineOpen,
  renderedTimelineDays,
  timelineFoldCounts,
  timelineMonthKey,
  timelineMonthLabel,
  timelineYearKey,
  toggledTimelineOpen,
  windowTimelineDays,
  TIMELINE_AHEAD_KEY,
  TIMELINE_OPEN_PARAM,
  TIMELINE_RECENT_DAYS,
} from "../timeline-window";

// Timeline windowing (#2657). Every expectation below is a PINNED LITERAL — the
// partition boundaries, the labels, the counts — never a value recomputed from the
// module under test, so gutting the production rule fails the assertion instead of
// moving it.

// A frozen "today" and a fictional feed around it. With TIMELINE_RECENT_DAYS = 14 the
// recent band is 2026-07-31 … 2026-08-13 inclusive, which the dates below straddle in
// both directions by exactly one day.
const TODAY = "2026-08-13";

function day(date: string, events: number) {
  return {
    date,
    events: Array.from({ length: events }, (_, i) => `${date}#${i}`),
  };
}

// Newest-first, exactly as groupTimelineDays hands them over.
const FEED = [
  day("2026-12-11", 1), // ahead — a goal target date months out
  day("2026-08-19", 2), // ahead — next week
  day("2026-08-13", 3), // recent — today
  day("2026-07-31", 1), // recent — the oldest day still event-grained
  day("2026-07-30", 2), // folded — one day past the boundary
  day("2026-07-02", 1), // folded — same month
  day("2026-05-04", 4), // folded — an older month
];

describe("the recent band's span", () => {
  it("is 14 days", () => {
    expect(TIMELINE_RECENT_DAYS).toBe(14);
  });

  it("names its query param and its reserved future key", () => {
    expect(TIMELINE_OPEN_PARAM).toBe("open");
    expect(TIMELINE_AHEAD_KEY).toBe("ahead");
  });
});

describe("timelineMonthKey / timelineMonthLabel", () => {
  it("keys a date by its calendar month and names the month in English", () => {
    expect(timelineMonthKey("2026-03-27")).toBe("2026-03");
    expect(timelineMonthLabel("2026-03")).toBe("March 2026");
    expect(timelineMonthLabel("2025-12")).toBe("December 2025");
  });

  it("renders an unparseable key as itself rather than inventing a month", () => {
    expect(timelineMonthLabel("2026-99")).toBe("2026-99");
  });
});

describe("parseTimelineOpen", () => {
  it("accepts the ahead key and YYYY-MM months, from a string, a list or a CSV", () => {
    expect([...parseTimelineOpen("ahead")]).toEqual(["ahead"]);
    expect([...parseTimelineOpen(["2026-05", "2026-07"])]).toEqual([
      "2026-05",
      "2026-07",
    ]);
    expect([...parseTimelineOpen("2026-05,ahead")]).toEqual([
      "2026-05",
      "ahead",
    ]);
  });

  it("drops anything that is not one of those, so a hand-edited URL opens less rather than breaking", () => {
    expect([...parseTimelineOpen(undefined)]).toEqual([]);
    expect([...parseTimelineOpen("2026-13")]).toEqual([]);
    expect([...parseTimelineOpen("2026-00")]).toEqual([]);
    expect([...parseTimelineOpen("2026-5")]).toEqual([]);
    expect([...parseTimelineOpen("AHEAD")]).toEqual([]);
    expect([...parseTimelineOpen("<script>")]).toEqual([]);
  });
});

describe("timelineFoldCounts", () => {
  it("always states both counts, singular and plural", () => {
    expect(timelineFoldCounts({ eventCount: 47, dayCount: 22 })).toBe(
      "47 events · 22 days"
    );
    expect(timelineFoldCounts({ eventCount: 1, dayCount: 1 })).toBe(
      "1 event · 1 day"
    );
    expect(timelineFoldCounts({ eventCount: 0, dayCount: 0 })).toBe(
      "0 events · 0 days"
    );
  });
});

describe("windowTimelineDays", () => {
  it("splits the feed into the future fold, the 14-day recent band and older months", () => {
    const w = windowTimelineDays(FEED, TODAY);

    expect(w.recentFrom).toBe("2026-07-31");

    expect(w.ahead?.key).toBe("ahead");
    expect(w.ahead?.label).toBe("Scheduled ahead");
    expect(w.ahead?.days.map((d) => d.date)).toEqual([
      "2026-12-11",
      "2026-08-19",
    ]);
    expect(w.ahead?.dayCount).toBe(2);
    expect(w.ahead?.eventCount).toBe(3);

    expect(w.recent.map((d) => d.date)).toEqual(["2026-08-13", "2026-07-31"]);

    expect(w.months.map((m) => m.key)).toEqual(["2026-07", "2026-05"]);
    expect(w.months.map((m) => m.label)).toEqual(["July 2026", "May 2026"]);
    expect(w.months.map((m) => m.dayCount)).toEqual([2, 1]);
    expect(w.months.map((m) => m.eventCount)).toEqual([3, 4]);
  });

  it("opens nothing by default — the future is never the opening content", () => {
    const w = windowTimelineDays(FEED, TODAY);
    expect(w.ahead?.open).toBe(false);
    expect(w.months.map((m) => m.open)).toEqual([false, false]);
    expect(renderedTimelineDays(w).map((d) => d.date)).toEqual([
      "2026-08-13",
      "2026-07-31",
    ]);
  });

  it("opens exactly the folds ?open= named, and renders them in feed order", () => {
    const w = windowTimelineDays(FEED, TODAY, new Set(["ahead", "2026-05"]));
    expect(w.ahead?.open).toBe(true);
    expect(w.months.map((m) => m.open)).toEqual([false, true]);
    expect(renderedTimelineDays(w).map((d) => d.date)).toEqual([
      "2026-12-11",
      "2026-08-19",
      "2026-08-13",
      "2026-07-31",
      "2026-05-04",
    ]);
  });

  it("reports which closed fold hides a date, and nothing for a rendered one", () => {
    const w = windowTimelineDays(FEED, TODAY);
    expect(foldKeyHiding(w, "2026-12-11")).toBe("ahead");
    expect(foldKeyHiding(w, "2026-07-30")).toBe("2026-07");
    expect(foldKeyHiding(w, "2026-05-04")).toBe("2026-05");
    expect(foldKeyHiding(w, "2026-08-13")).toBe(null);
    expect(foldKeyHiding(w, "2019-01-01")).toBe(null);

    const opened = windowTimelineDays(FEED, TODAY, new Set(["2026-05"]));
    expect(foldKeyHiding(opened, "2026-05-04")).toBe(null);
  });

  it("keeps a day exactly 13 days back event-grained and folds the one at 14", () => {
    const w = windowTimelineDays(
      [day("2026-07-31", 1), day("2026-07-30", 1)],
      TODAY
    );
    expect(w.recent.map((d) => d.date)).toEqual(["2026-07-31"]);
    expect(w.months.map((m) => m.key)).toEqual(["2026-07"]);
    expect(w.months[0].days.map((d) => d.date)).toEqual(["2026-07-30"]);
  });

  it("opens the newest month when the recent band is empty, so a dormant profile lands on content", () => {
    const dormant = [day("2026-05-04", 4), day("2026-03-02", 1)];
    const w = windowTimelineDays(dormant, TODAY);
    expect(w.recent).toEqual([]);
    expect(w.months.map((m) => m.open)).toEqual([true, false]);
    expect(renderedTimelineDays(w).map((d) => d.date)).toEqual(["2026-05-04"]);
  });

  it("does not second-guess an explicit choice — an opened older month suppresses the auto-open", () => {
    const dormant = [day("2026-05-04", 4), day("2026-03-02", 1)];
    const w = windowTimelineDays(dormant, TODAY, new Set(["2026-03"]));
    expect(w.months.map((m) => m.open)).toEqual([false, true]);
  });

  it("leaves an all-recent feed with no folds at all", () => {
    const w = windowTimelineDays([day("2026-08-12", 2)], TODAY);
    expect(w.ahead).toBe(null);
    expect(w.months).toEqual([]);
    expect(w.recent.map((d) => d.date)).toEqual(["2026-08-12"]);
  });

  it("drops nothing: every day lands in exactly one band", () => {
    const w = windowTimelineDays(FEED, TODAY);
    const placed = [
      ...(w.ahead?.days ?? []),
      ...w.recent,
      ...w.months.flatMap((m) => m.days),
    ].map((d) => d.date);
    expect(placed).toEqual([
      "2026-12-11",
      "2026-08-19",
      "2026-08-13",
      "2026-07-31",
      "2026-07-30",
      "2026-07-02",
      "2026-05-04",
    ]);
  });

  it("leaves the years empty for a feed that never leaves the current year", () => {
    expect(windowTimelineDays(FEED, TODAY).years).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// YEARS ROLL UP (#2657 item 6). A month card costs ~70px; `?category=medical`
// carried 54 of them, so the compression the fold bought back at day grain leaked
// away again at month grain. A month outside the current calendar year compresses
// once more into a year card.
// ---------------------------------------------------------------------------

// The same today, and a feed reaching back three calendar years. 2026 months stay
// month cards; 2025 and 2024 roll up.
const DEEP_FEED = [
  day("2026-08-13", 1), // recent — today
  day("2026-06-10", 2), // this year's month card
  day("2026-02-04", 1), // this year's month card
  day("2025-11-20", 3), // inside the 2025 year card
  day("2025-11-02", 1), // same month
  day("2025-04-17", 2), // inside the 2025 year card
  day("2024-09-09", 5), // inside the 2024 year card
];

describe("timelineYearKey", () => {
  it("keys a date and a month key alike by their calendar year", () => {
    expect(timelineYearKey("2026-03-27")).toBe("2026");
    expect(timelineYearKey("2025-12")).toBe("2025");
  });
});

describe("years roll up", () => {
  it("keeps this year's months as cards and folds earlier years into year cards", () => {
    const w = windowTimelineDays(DEEP_FEED, TODAY);

    expect(w.recent.map((d) => d.date)).toEqual(["2026-08-13"]);
    expect(w.months.map((m) => m.key)).toEqual(["2026-06", "2026-02"]);

    expect(w.years.map((y) => y.key)).toEqual(["2025", "2024"]);
    expect(w.years.map((y) => y.label)).toEqual(["2025", "2024"]);
    expect(w.years.map((y) => y.monthCount)).toEqual([2, 1]);
    expect(w.years.map((y) => y.dayCount)).toEqual([3, 1]);
    expect(w.years.map((y) => y.eventCount)).toEqual([6, 5]);
    expect(w.years[0].months.map((m) => m.key)).toEqual(["2025-11", "2025-04"]);
    expect(w.years[0].months.map((m) => m.label)).toEqual([
      "November 2025",
      "April 2025",
    ]);
  });

  it("opens no year by default, so a five-year profile is a one-screen spine", () => {
    const w = windowTimelineDays(DEEP_FEED, TODAY);
    expect(w.years.map((y) => y.open)).toEqual([false, false]);
    expect(renderedTimelineDays(w).map((d) => d.date)).toEqual(["2026-08-13"]);
  });

  it("an open year shows its month cards and still none of their days", () => {
    const w = windowTimelineDays(DEEP_FEED, TODAY, new Set(["2025"]));
    expect(w.years.map((y) => y.open)).toEqual([true, false]);
    expect(w.years[0].months.map((m) => m.open)).toEqual([false, false]);
    expect(renderedTimelineDays(w).map((d) => d.date)).toEqual(["2026-08-13"]);
  });

  it("a month key alone opens the month AND the year around it, so an old deep link still lands", () => {
    const w = windowTimelineDays(DEEP_FEED, TODAY, new Set(["2025-04"]));
    expect(w.years[0].open).toBe(true);
    expect(w.years[0].months.map((m) => m.open)).toEqual([false, true]);
    expect(renderedTimelineDays(w).map((d) => d.date)).toEqual([
      "2026-08-13",
      "2025-04-17",
    ]);
  });

  it("names the month, not the year, as the fold hiding a buried date — one key is the whole answer", () => {
    const w = windowTimelineDays(DEEP_FEED, TODAY);
    expect(foldKeyHiding(w, "2024-09-09")).toBe("2024-09");
    expect(foldKeyHiding(w, "2025-11-20")).toBe("2025-11");
    expect(foldKeyHiding(w, "2026-06-10")).toBe("2026-06");

    // …and that one key is sufficient: feeding it back renders the date.
    const opened = windowTimelineDays(
      DEEP_FEED,
      TODAY,
      new Set(toggledTimelineOpen(new Set(), "2024-09"))
    );
    expect(renderedTimelineDays(opened).map((d) => d.date)).toContain(
      "2024-09-09"
    );
    expect(foldKeyHiding(opened, "2024-09-09")).toBe(null);
  });

  it("counts a year in MONTHS, because months are what a tap reveals", () => {
    expect(
      timelineFoldCounts({ eventCount: 180, dayCount: 62, monthCount: 3 })
    ).toBe("180 events · 3 months");
    expect(
      timelineFoldCounts({ eventCount: 1, dayCount: 1, monthCount: 1 })
    ).toBe("1 event · 1 month");
  });

  it("auto-opens the newest month even when it lives inside a year card", () => {
    const dormant = [day("2025-04-17", 2), day("2024-09-09", 5)];
    const w = windowTimelineDays(dormant, TODAY);
    expect(w.months).toEqual([]);
    expect(w.years.map((y) => y.open)).toEqual([true, false]);
    expect(w.years[0].months.map((m) => m.open)).toEqual([true]);
    expect(renderedTimelineDays(w).map((d) => d.date)).toEqual(["2025-04-17"]);
  });

  it("an explicitly opened YEAR suppresses the auto-open too", () => {
    const dormant = [day("2025-04-17", 2), day("2024-09-09", 5)];
    const w = windowTimelineDays(dormant, TODAY, new Set(["2024"]));
    expect(w.years.map((y) => y.open)).toEqual([false, true]);
    expect(w.years[0].months.map((m) => m.open)).toEqual([false]);
    expect(renderedTimelineDays(w)).toEqual([]);
  });

  it("drops nothing: every day still lands in exactly one band", () => {
    const w = windowTimelineDays(DEEP_FEED, TODAY);
    const placed = [
      ...(w.ahead?.days ?? []),
      ...w.recent,
      ...allTimelineMonths(w).flatMap((m) => m.days),
    ].map((d) => d.date);
    expect(placed).toEqual(DEEP_FEED.map((d) => d.date));
  });
});

describe("toggledTimelineOpen", () => {
  it("adds a key that is absent and removes one that is present, always sorted", () => {
    expect(toggledTimelineOpen(new Set(["2026-05"]), "ahead")).toEqual([
      "2026-05",
      "ahead",
    ]);
    expect(
      toggledTimelineOpen(new Set(["2026-05", "ahead"]), "2026-05")
    ).toEqual(["ahead"]);
  });

  it("closing a year takes its months with it — otherwise the derivation re-opens it", () => {
    const open = new Set(["2025", "2025-04", "2025-11", "2026-02"]);
    expect(
      toggledTimelineOpen(open, "2025", {
        open: true,
        descendants: ["2025-04", "2025-11"],
      })
    ).toEqual(["2026-02"]);
  });

  it("OPENING a year touches only the year — the months inside arrive collapsed", () => {
    expect(
      toggledTimelineOpen(new Set(), "2025", {
        open: false,
        descendants: ["2025-04"],
      })
    ).toEqual(["2025"]);
  });

  // The defect the `fold` argument exists for. A year opened BY ITS MONTH holds no key
  // of its own, so a toggle reading set membership answers "closed" and ADDS one —
  // leaving the reader's tap on a shut-looking control with the card still open.
  it("shuts a year that was open only by derivation, rather than adding a key to it", () => {
    const openedByMonth = windowTimelineDays(
      DEEP_FEED,
      TODAY,
      new Set(["2025-04"])
    );
    const year = openedByMonth.years[0];
    expect(year.open).toBe(true);
    expect(openedByMonth.years[0].key).toBe("2025");

    const next = toggledTimelineOpen(new Set(["2025-04"]), "2025", {
      open: year.open,
      descendants: year.months.map((m) => m.key),
    });
    expect(next).toEqual([]);

    const reclosed = windowTimelineDays(DEEP_FEED, TODAY, new Set(next));
    expect(reclosed.years[0].open).toBe(false);
    expect(renderedTimelineDays(reclosed).map((d) => d.date)).toEqual([
      "2026-08-13",
    ]);
  });
});
