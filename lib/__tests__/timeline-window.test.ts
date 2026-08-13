import { describe, expect, it } from "vitest";
import {
  foldKeyHiding,
  parseTimelineOpen,
  renderedTimelineDays,
  timelineFoldCounts,
  timelineMonthKey,
  timelineMonthLabel,
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
});
