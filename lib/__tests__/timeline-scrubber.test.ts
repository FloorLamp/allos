import { describe, expect, it } from "vitest";
import {
  SCRUBBER_HIT_WIDTH_PX,
  SCRUBBER_MIN_TICKS,
  SCRUBBER_TAP_SLOP_PX,
  SCRUBBER_YEAR_LABEL_MIN_GAP_PX,
  scrubberFraction,
  scrubberMonthLabel,
  scrubberRelease,
  scrubberScrollTop,
  scrubberTickAt,
  scrubberTickAtScroll,
  scrubberTickFractions,
  scrubberYearLabels,
  showTimelineScrubber,
  timelineScrubberTicks,
} from "@/lib/timeline-scrubber";
import { windowTimelineDays, type WindowableDay } from "@/lib/timeline-window";

// The timeline jump rail (#2657 item 4), decision half.
//
// The claims worth pinning are the ones the ruling states and a component would
// quietly get wrong: no tick for content no scroll can reach, one dot per calendar
// month even when that month is split across two render bands, dot placement and
// finger selection agreeing by construction, and a released pointer's tap/drag verdict
// deciding whether `?open=` may change at all.

const TODAY = "2026-08-13";

function day(date: string, events = 1): WindowableDay {
  return { date, events: Array.from({ length: events }, (_, i) => i) };
}

// Newest-first day groups, the shape `groupTimelineDays` hands the window.
function feed(dates: string[]): WindowableDay[] {
  return [...dates]
    .sort()
    .reverse()
    .map((d) => day(d));
}

describe("scrubberMonthLabel", () => {
  it("is the terse, uppercase form the drag bubble shows", () => {
    expect(scrubberMonthLabel("2026-03")).toBe("MAR 2026");
    expect(scrubberMonthLabel("2025-12")).toBe("DEC 2025");
  });

  it("renders an unparseable key rather than inventing a month", () => {
    expect(scrubberMonthLabel("2026-13")).toBe("2026-13");
  });
});

describe("timelineScrubberTicks", () => {
  it("offers one stop per rendered month, newest first, spelled out for AT", () => {
    const windowed = windowTimelineDays(
      feed(["2026-08-12", "2026-06-04", "2026-05-09"]),
      TODAY
    );
    const ticks = timelineScrubberTicks(windowed);

    expect(ticks.map((t) => t.key)).toEqual(["2026-08", "2026-06", "2026-05"]);
    expect(ticks.map((t) => t.label)).toEqual([
      "AUG 2026",
      "JUN 2026",
      "MAY 2026",
    ]);
    // "MAR" is a visual shorthand; a screen reader spelling it out is not a period
    // name, so the announced value is the full one.
    expect(ticks.map((t) => t.valueText)).toEqual([
      "August 2026",
      "June 2026",
      "May 2026",
    ]);
  });

  it("anchors a recent month on its own day group and a folded month on its card", () => {
    const windowed = windowTimelineDays(
      feed(["2026-08-12", "2026-06-04"]),
      TODAY
    );
    const [recent, folded] = timelineScrubberTicks(windowed);

    expect(recent.anchorId).toBe("timeline-day-2026-08-12");
    // Nothing to expand — the recent band's days are already painted.
    expect(recent.openKey).toBeNull();
    expect(folded.anchorId).toBe("timeline-fold-2026-06");
    expect(folded.openKey).toBe("2026-06");
  });

  it("drops the open key once the month it names is already expanded", () => {
    const windowed = windowTimelineDays(
      feed(["2026-08-12", "2026-06-04"]),
      TODAY,
      new Set(["2026-06"])
    );
    const [, folded] = timelineScrubberTicks(windowed);
    expect(folded.openKey).toBeNull();
    // A tap on an already-open month is a scroll, not a second toggle that would
    // CLOSE it — which is what an openKey that ignored `open` would produce.
    expect(folded.anchorId).toBe("timeline-fold-2026-06");
  });

  it("gives a month split across the recent band and a fold ONE dot", () => {
    // Today is the 13th, so the recent band reaches back to 2026-07-31: July has days
    // in BOTH bands. Two dots both reading "JUL 2026" would read as a bug and be one.
    const windowed = windowTimelineDays(
      feed(["2026-08-05", "2026-08-01", "2026-07-31", "2026-07-04"]),
      TODAY
    );
    const ticks = timelineScrubberTicks(windowed);

    expect(ticks.map((t) => t.key)).toEqual(["2026-08", "2026-07"]);
    const july = ticks[1];
    // Anchored at the TOPMOST place July appears — its recent day group…
    expect(july.anchorId).toBe("timeline-day-2026-07-31");
    // …while still carrying the fold key of the half that is still collapsed, so the
    // tap opens the rest of July rather than landing on a two-day sliver of it.
    expect(july.openKey).toBe("2026-07");
  });

  it("keeps a collapsed year's months OUT of the tick set", () => {
    // The ruling's sharpest clause: no phantom ticks for content no scroll can reach.
    const windowed = windowTimelineDays(
      feed(["2026-08-12", "2025-11-02", "2025-04-06"]),
      TODAY
    );
    const ticks = timelineScrubberTicks(windowed);

    expect(ticks.map((t) => t.key)).toEqual(["2026-08", "2025"]);
    const year = ticks[1];
    expect(year.kind).toBe("year");
    expect(year.label).toBe("2025");
    expect(year.anchorId).toBe("timeline-fold-2025");
    expect(year.openKey).toBe("2025");
    expect(ticks.some((t) => t.key.startsWith("2025-"))).toBe(false);
  });

  it("re-admits those months the moment the year is opened", () => {
    const windowed = windowTimelineDays(
      feed(["2026-08-12", "2025-11-02", "2025-04-06"]),
      TODAY,
      new Set(["2025"])
    );
    const ticks = timelineScrubberTicks(windowed);

    expect(ticks.map((t) => t.key)).toEqual(["2026-08", "2025-11", "2025-04"]);
    expect(ticks.every((t) => t.kind === "month")).toBe(true);
    // The year card itself is no longer a stop — its months are, which is what a tap
    // on the year revealed.
    expect(ticks.map((t) => t.openKey)).toEqual([null, "2025-11", "2025-04"]);
  });

  it("gives the future fold no stop at all", () => {
    // "Scheduled ahead" exists to demote speculative scheduling out of the reader's
    // entry point. Making it the rail's first stop would re-promote it.
    const windowed = windowTimelineDays(
      feed(["2026-12-25", "2026-08-12", "2026-06-04"]),
      TODAY
    );
    expect(windowed.ahead).not.toBeNull();
    const ticks = timelineScrubberTicks(windowed);
    expect(ticks.some((t) => t.key === "ahead")).toBe(false);
    expect(ticks.some((t) => t.key === "2026-12")).toBe(false);
  });

  it("marks the first stop of each year, and only the first", () => {
    const windowed = windowTimelineDays(
      feed(["2026-08-12", "2026-06-04", "2026-05-09", "2025-11-02"]),
      TODAY,
      new Set(["2025"])
    );
    const ticks = timelineScrubberTicks(windowed);
    expect(ticks.map((t) => t.yearMark)).toEqual([true, false, false, true]);
    expect(ticks.map((t) => t.year)).toEqual(["2026", "2026", "2026", "2025"]);
  });

  it("answers an empty feed with no stops", () => {
    expect(timelineScrubberTicks(windowTimelineDays([], TODAY))).toEqual([]);
  });
});

describe("showTimelineScrubber", () => {
  it("withholds the rail from a feed with nothing to scrub between", () => {
    expect(SCRUBBER_MIN_TICKS).toBe(2);
    expect(showTimelineScrubber([])).toBe(false);
    expect(showTimelineScrubber(["one"])).toBe(false);
    expect(showTimelineScrubber(["one", "two"])).toBe(true);
  });
});

describe("scrubberTickFractions", () => {
  it("places each dot at its anchor's share of the span between the stops", () => {
    // Proportional, not evenly spaced: an evenly spaced strip makes the drag lie —
    // the finger a third of the way down, the page a long way somewhere else.
    expect(scrubberTickFractions([100, 350, 600])).toEqual([0, 0.5, 1]);
  });

  it("is keyed on the STOP SPAN, not on how far the page can scroll", () => {
    // The defect this shipped with, and the reason it is worth a test of its own: the
    // windowed feed is a spine of ~70px cards, so a five-period profile on a 900px
    // viewport measured 58px of scroll range against anchors at 458–842. Divided by
    // the scroll range every dot clamped to 1 and the rail answered one period for
    // every pointer position. The span is what has structure on a short page.
    expect(scrubberTickFractions([458, 590, 674, 758, 842])).toEqual([
      0,
      (590 - 458) / (842 - 458),
      (674 - 458) / (842 - 458),
      (758 - 458) / (842 - 458),
      1,
    ]);
  });

  it("spreads the dots the way the document does", () => {
    // An expanded month occupies far more document than its collapsed neighbours, and
    // the rail says so — its dot is pushed away from theirs.
    const [a, b, c] = scrubberTickFractions([0, 900, 1000]);
    expect(a).toBe(0);
    expect(b).toBeGreaterThan(0.8);
    expect(c).toBe(1);
  });

  it("falls back to even spacing when the span has no structure", () => {
    expect(scrubberTickFractions([200, 200, 200, 200])).toEqual([
      0,
      1 / 3,
      2 / 3,
      1,
    ]);
    // An anchor the feed did not render measures as NaN, which poisons the span; even
    // spacing keeps every stop tappable rather than stacking them on one pixel.
    expect(scrubberTickFractions([Number.NaN, 500, 900])).toEqual([0, 0.5, 1]);
  });

  it("handles the degenerate sets without producing NaN", () => {
    expect(scrubberTickFractions([])).toEqual([]);
    expect(scrubberTickFractions([700])).toEqual([0]);
  });

  it("never goes backwards, so the strip reads in feed order", () => {
    const fractions = scrubberTickFractions([0, 120, 900, 2400, 9000]);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
  });
});

describe("scrubberTickAt", () => {
  const fractions = [0, 0.25, 0.5, 1];

  it("names the last stop at or above the finger", () => {
    expect(scrubberTickAt(fractions, 0)).toBe(0);
    expect(scrubberTickAt(fractions, 0.24)).toBe(0);
    expect(scrubberTickAt(fractions, 0.25)).toBe(1);
    expect(scrubberTickAt(fractions, 0.99)).toBe(2);
    expect(scrubberTickAt(fractions, 1)).toBe(3);
  });

  it("gives ties to the DEEPEST stop, which is what makes the clamped bottom work", () => {
    // Several trailing months pinned to 1 by the clamp: dragging to the bottom must
    // reach the deepest of them, the one no other gesture can.
    expect(scrubberTickAt([0, 1, 1, 1], 1)).toBe(3);
  });

  it("clamps a pointer outside the strip instead of answering nothing", () => {
    expect(scrubberTickAt(fractions, -3)).toBe(0);
    expect(scrubberTickAt(fractions, 42)).toBe(3);
  });

  it("answers -1 for an empty rail", () => {
    expect(scrubberTickAt([], 0.5)).toBe(-1);
  });

  it("agrees with the dots it was handed, by construction", () => {
    // Placement and selection read the SAME array, so "the period I get is the dot I
    // am pointing at" is a property rather than two functions happening to agree.
    const placed = scrubberTickFractions([0, 400, 1600, 3000]);
    placed.forEach((fraction, index) => {
      expect(scrubberTickAt(placed, fraction)).toBe(index);
    });
  });
});

describe("scrubberFraction", () => {
  it("maps a pointer's y onto the strip's own box", () => {
    expect(scrubberFraction(300, 100, 400)).toBe(0.5);
    expect(scrubberFraction(100, 100, 400)).toBe(0);
    expect(scrubberFraction(500, 100, 400)).toBe(1);
  });

  it("clamps a pointer dragged past either end", () => {
    expect(scrubberFraction(0, 100, 400)).toBe(0);
    expect(scrubberFraction(9000, 100, 400)).toBe(1);
  });

  it("answers 0 for a strip with no height rather than dividing by zero", () => {
    expect(scrubberFraction(300, 100, 0)).toBe(0);
  });
});

describe("scrubberScrollTop", () => {
  const offsets = [400, 1200, 2000];

  it("interpolates inside the stop span", () => {
    expect(scrubberScrollTop(0, offsets, 5000)).toBe(400);
    expect(scrubberScrollTop(0.5, offsets, 5000)).toBe(1200);
    expect(scrubberScrollTop(1, offsets, 5000)).toBe(2000);
  });

  it("stops at what the document can actually reach", () => {
    // A short feed does not pretend the bottom of the strip is somewhere the page can
    // go — it goes as far as it can and stays there.
    expect(scrubberScrollTop(1, offsets, 58)).toBe(58);
    expect(scrubberScrollTop(0, offsets, 58)).toBe(58);
  });

  it("stays put when there is nothing to scroll", () => {
    expect(scrubberScrollTop(0.7, offsets, 0)).toBe(0);
  });

  it("degrades to the raw scroll space when the span is unmeasurable", () => {
    expect(scrubberScrollTop(0.5, [], 5000)).toBe(2500);
    expect(scrubberScrollTop(0.5, [Number.NaN, 900], 5000)).toBe(2500);
  });
});

describe("scrubberTickAtScroll", () => {
  const offsets = [400, 1200, 2000];

  it("names the last period whose anchor has passed the top of the window", () => {
    expect(scrubberTickAtScroll(offsets, 0)).toBe(0);
    expect(scrubberTickAtScroll(offsets, 400)).toBe(0);
    expect(scrubberTickAtScroll(offsets, 1199)).toBe(0);
    expect(scrubberTickAtScroll(offsets, 1200)).toBe(1);
    expect(scrubberTickAtScroll(offsets, 99999)).toBe(2);
  });

  it("answers -1 for an empty rail", () => {
    expect(scrubberTickAtScroll([], 500)).toBe(-1);
  });
});

describe("scrubberRelease", () => {
  it("calls a still pointer a tap and a travelled one a drag", () => {
    // The whole difference between a gesture that may change `?open=` and one that
    // may not: releasing a drag only positions the scroll.
    expect(scrubberRelease(0)).toBe("tap");
    expect(scrubberRelease(SCRUBBER_TAP_SLOP_PX)).toBe("tap");
    expect(scrubberRelease(SCRUBBER_TAP_SLOP_PX + 1)).toBe("drag");
    expect(scrubberRelease(-40)).toBe("drag");
  });

  it("judges travel, never duration", () => {
    // A slow, hesitant tap is still a tap — a reader resting a thumb on the rail
    // before committing must not have their history expanded for hesitating. There is
    // no time input here at all, which is the strongest form of that guarantee.
    expect(scrubberRelease.length).toBe(1);
  });
});

describe("scrubberYearLabels", () => {
  // The owner ruling of 2026-08-14 reversed "at rest, no text" for year marks: the
  // rail prints each year's digits, because a textless strip cannot tell 2023 from
  // 2021 without a drag. What this function owns is the cost that came with it.
  const marks = (flags: boolean[]) => flags.map((yearMark) => ({ yearMark }));

  it("labels the year marks and nothing else", () => {
    expect(
      scrubberYearLabels(
        marks([true, false, false, true]),
        [0, 0.4, 0.7, 1],
        600
      )
    ).toEqual([true, false, false, true]);
  });

  it("drops a label that would land on the one above it", () => {
    // Two year marks 6px apart on a 600px strip. The mark, the stop and the drag
    // bubble all survive — only the digits go, because two overlapping four-digit
    // labels are worse than one missing.
    const fractions = [0, 0.01, 0.5];
    expect(
      scrubberYearLabels(marks([true, true, true]), fractions, 600)
    ).toEqual([true, false, true]);
  });

  it("measures from the last PRINTED label, so a tight run thins out evenly", () => {
    // Measured against the last MARK instead, a run of years 8px apart would print
    // the first and suppress every one after it forever. Against the last printed
    // label, the run prints roughly every other one and stays readable.
    const step = (SCRUBBER_YEAR_LABEL_MIN_GAP_PX - 4) / 600;
    const fractions = [0, step, step * 2, step * 3, step * 4];
    expect(
      scrubberYearLabels(marks([true, true, true, true, true]), fractions, 600)
    ).toEqual([true, false, true, false, true]);
  });

  it("prints everything before the strip has been measured", () => {
    // No geometry yet means nothing can be KNOWN to collide, and a year missing its
    // digits on the first frame is the worse of the two failures.
    expect(scrubberYearLabels(marks([true, true]), [], 0)).toEqual([
      true,
      true,
    ]);
    expect(
      scrubberYearLabels(marks([true, true]), [0, Number.NaN], 600)
    ).toEqual([true, true]);
  });

  it("never suppresses the first label", () => {
    expect(scrubberYearLabels(marks([true]), [0.99], 600)[0]).toBe(true);
  });
});

describe("the hit area", () => {
  it("is the platform touch floor, decoupled from the visual", () => {
    // Dots render at a hairline; the target is the full edge strip. The two are
    // deliberately different numbers, and the component owns a gutter of exactly this
    // width so the strip never sits on top of the feed's own links.
    expect(SCRUBBER_HIT_WIDTH_PX).toBe(44);
  });
});
