import { describe, expect, it } from "vitest";
import { MIN_LABEL_PX, effectiveFontPx } from "@/lib/chart-svg";
import {
  FULL_DAY_VIEW,
  INTRADAY_VARIANTS,
  MIN_ZOOM_MINUTES,
  axisTicks,
  clipToView,
  hrAxisLabels,
  inView,
  intradayGeometry,
  intradayLabelPx,
  minuteAtX,
  nearestHrPoint,
  projectBpm,
  projectMinute,
  rowLabel,
  sleepEdgeLabels,
  blockLayout,
  blockLabels,
  blockRowTop,
  panView,
  zoomViewAt,
  type IntradayVariant,
} from "@/lib/intraday-layout";
import { MINUTES_IN_DAY, type IntradayModel } from "@/lib/intraday";

const VARIANTS: IntradayVariant[] = ["compact", "wide"];

function model(over: Partial<IntradayModel> = {}): IntradayModel {
  return {
    date: "2026-03-11",
    minutesInDay: MINUTES_IN_DAY,
    hr: {
      segments: [
        [
          { minute: 0, bpm: 52, lo: 48, hi: 58 },
          { minute: 480, bpm: 96, lo: 80, hi: 140 },
        ],
      ],
      pointCount: 2,
      min: 48,
      max: 140,
      zone2: null,
    },
    sleep: [],
    blocks: [],
    ticks: [],
    nowMinute: null,
    ...over,
  };
}

function sleepBlock(over: Partial<IntradayModel["sleep"][number]> = {}) {
  return {
    key: "sleep:1",
    startMinute: 0,
    endMinute: 402,
    clippedStart: true,
    clippedEnd: false,
    stages: [],
    ...over,
  };
}

function workout(over: Partial<IntradayModel["blocks"][number]> = {}) {
  return {
    key: "a:1",
    eventId: "a:1",
    source: "activity" as const,
    anchorId: "timeline-entry-a-1",
    startMinute: 480,
    endMinute: 525,
    title: "Morning ride",
    iconType: "cardio",
    iconTitle: null,
    iconSportNames: null,
    href: null,
    clippedStart: false,
    clippedEnd: false,
    ...over,
  };
}

/** A practice session's block — same shape, its own row since #4852. */
function practice(over: Partial<IntradayModel["blocks"][number]> = {}) {
  return workout({
    key: "practice:1",
    eventId: "practice:1",
    source: "practice",
    anchorId: "timeline-entry-practice-1",
    startMinute: 1140,
    endMinute: 1170,
    title: "Sauna",
    ...over,
  });
}

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
    Math.round(minute) % 60
  ).padStart(2, "0")}`;

describe("the variant size contract (#1518 / #1512 F)", () => {
  it.each(VARIANTS)(
    "%s clears the legibility floor at its narrowest container",
    (variant) => {
      const spec = INTRADAY_VARIANTS[variant];
      expect(
        effectiveFontPx(spec.labelSize, {
          viewBoxWidth: spec.viewBoxWidth,
          minContainerPx: spec.minContainerPx,
        })
      ).toBeGreaterThanOrEqual(MIN_LABEL_PX);
      expect(
        intradayLabelPx(variant, spec.minContainerPx)
      ).toBeGreaterThanOrEqual(MIN_LABEL_PX);
    }
  );

  it.each(VARIANTS)("%s stays in a sane band at its widest", (variant) => {
    const spec = INTRADAY_VARIANTS[variant];
    // The max width is what keeps the type from scaling back OUT of the band in
    // the app's 110rem shell — without it the old 720-unit box painted ~17px
    // labels on a wide monitor and ~3.5px ones on a phone.
    expect(intradayLabelPx(variant, spec.maxWidthPx)).toBeLessThanOrEqual(14);
  });

  it("reproduces the bug the compact variant exists to fix", () => {
    // The shipped geometry: 720 units into a 358px phone column.
    expect(
      effectiveFontPx(7, { viewBoxWidth: 720, minContainerPx: 358 })
    ).toBeLessThan(4);
    // The compact variant at the same container.
    expect(intradayLabelPx("compact", 358)).toBeGreaterThanOrEqual(
      MIN_LABEL_PX
    );
  });
});

describe("the row stack collapses to the day's layers", () => {
  it("reserves no strip for an absent layer", () => {
    const hrOnly = intradayGeometry(model(), "wide");
    const everything = intradayGeometry(
      model({
        sleep: [sleepBlock()],
        blocks: [workout()],
        ticks: [
          {
            key: "t",
            eventId: "t",
            anchorId: "a",
            minute: 600,
            label: "Doc",
            category: "document",
            tone: "default",
          },
        ],
      }),
      "wide"
    );
    expect(hrOnly.hasSleep).toBe(false);
    expect(hrOnly.height).toBeLessThan(everything.height);
    // The axis sits directly under the HR row on an HR-only day — no orphaned
    // row labels over empty strips (#1512's partial-day question).
    expect(hrOnly.axisY).toBe(hrOnly.hrTop + hrOnly.hrH + hrOnly.rowGap);
  });

  it("puts the sleep edge labels above the band, clear of the workout row", () => {
    const geo = intradayGeometry(
      model({ sleep: [sleepBlock()], blocks: [workout()] }),
      "wide"
    );
    expect(geo.sleepLabelY).toBeLessThanOrEqual(geo.sleepTop);
    expect(geo.sleepTop + geo.sleepH).toBeLessThanOrEqual(geo.workTop);
  });
});

describe("projection", () => {
  it.each(VARIANTS)("%s maps the day across the plot", (variant) => {
    const geo = intradayGeometry(model(), variant);
    expect(projectMinute(geo, 0)).toBeCloseTo(geo.plotLeft, 6);
    expect(projectMinute(geo, MINUTES_IN_DAY)).toBeCloseTo(geo.plotRight, 6);
    expect(projectMinute(geo, 720)).toBeCloseTo(
      geo.plotLeft + geo.plotW / 2,
      6
    );
  });

  it("clamps out-of-range minutes to the plot", () => {
    const geo = intradayGeometry(model(), "wide");
    expect(projectMinute(geo, -600)).toBe(geo.plotLeft);
    expect(projectMinute(geo, 9999)).toBe(geo.plotRight);
  });

  it("round-trips through minuteAtX", () => {
    const geo = intradayGeometry(model(), "wide");
    for (const minute of [0, 137, 720, 1439]) {
      expect(minuteAtX(geo, projectMinute(geo, minute))).toBeCloseTo(minute, 6);
    }
  });

  it("maps bpm down the HR row, high value at the top", () => {
    const geo = intradayGeometry(model(), "wide");
    expect(projectBpm(geo, geo.hrHi)).toBeCloseTo(geo.hrTop, 6);
    expect(projectBpm(geo, geo.hrLo)).toBeCloseTo(geo.hrTop + geo.hrH, 6);
    expect(projectBpm(geo, 400)).toBeCloseTo(geo.hrTop, 6);
  });
});

describe("the zoomed window (#1515)", () => {
  it("reprojects the selected window across the whole plot", () => {
    const geo = intradayGeometry(model(), "wide", { from: 480, to: 525 });
    expect(projectMinute(geo, 480)).toBeCloseTo(geo.plotLeft, 6);
    expect(projectMinute(geo, 525)).toBeCloseTo(geo.plotRight, 6);
    // ~15 units per minute where the full day gave ~0.47 — the whole point.
    expect(geo.plotW / 45).toBeGreaterThan(10);
  });

  it("leaks nothing outside the window", () => {
    const geo = intradayGeometry(model(), "wide", { from: 480, to: 525 });
    expect(inView(geo, 479)).toBe(false);
    expect(inView(geo, 500)).toBe(true);
    expect(clipToView(geo, 0, 200)).toBeNull();
    expect(clipToView(geo, 400, 600)).toEqual({
      startMinute: 480,
      endMinute: 525,
    });
  });

  it("refuses to collapse below the minimum window", () => {
    const geo = intradayGeometry(model(), "wide", { from: 600, to: 601 });
    expect(geo.view.to - geo.view.from).toBeGreaterThanOrEqual(
      MIN_ZOOM_MINUTES
    );
  });

  it("keeps the full day as the default view", () => {
    expect(intradayGeometry(model(), "wide").view).toEqual(FULL_DAY_VIEW);
  });
});

describe("axis ticks fit the plot they label", () => {
  it("gives the wide variant 3-hour ticks and the compact one a coarser step", () => {
    const wide = axisTicks(intradayGeometry(model(), "wide"));
    const compact = axisTicks(intradayGeometry(model(), "compact"));
    expect(wide).toEqual([0, 180, 360, 540, 720, 900, 1080, 1260, 1440]);
    expect(compact.length).toBeLessThan(wide.length);
    expect(compact[0]).toBe(0);
    expect(compact.at(-1)).toBe(MINUTES_IN_DAY);
  });

  it.each(VARIANTS)("%s labels never exceed the plot width", (variant) => {
    const geo = intradayGeometry(model(), variant);
    const ticks = axisTicks(geo);
    // Every label plus one label of breathing room has to fit.
    const perLabel = geo.plotW / ticks.length;
    expect(perLabel).toBeGreaterThan("00:00".length * geo.labelSize * 0.6);
  });

  it("picks a fine, clock-friendly step for a zoomed window", () => {
    const ticks = axisTicks(
      intradayGeometry(model(), "wide", { from: 480, to: 525 })
    );
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThanOrEqual(9);
    // Clock-friendly: every tick is a whole number of minutes on a round step.
    const step = ticks[1] - ticks[0];
    expect([1, 2, 5, 10, 15, 20, 30, 60]).toContain(step);
    for (const t of ticks) expect(t % step).toBe(0);
  });
});

describe("bed and wake labels (#1512 A)", () => {
  it("labels both edges of a session that starts and ends inside the day", () => {
    const geo = intradayGeometry(
      model({
        sleep: [
          sleepBlock({ startMinute: 60, endMinute: 402, clippedStart: false }),
        ],
      }),
      "wide"
    );
    const labels = sleepEdgeLabels(
      geo,
      [sleepBlock({ startMinute: 60, endMinute: 402, clippedStart: false })],
      hhmm
    );
    expect(labels.map((l) => l.edge).sort()).toEqual(["bed", "wake"]);
    expect(labels.find((l) => l.edge === "wake")!.text).toBe("06:42");
  });

  it("suppresses the label on a CLIPPED edge — midnight is not a bed time", () => {
    const blocks = [sleepBlock()]; // clippedStart: bled in from yesterday
    const geo = intradayGeometry(model({ sleep: blocks }), "wide");
    const labels = sleepEdgeLabels(geo, blocks, hhmm);
    expect(labels.map((l) => l.edge)).toEqual(["wake"]);
  });

  it("drops a colliding label rather than smearing two together (#1573)", () => {
    // A one-minute nap: its bed and wake labels land on the same few units.
    const blocks = [
      sleepBlock({
        key: "nap",
        startMinute: 800,
        endMinute: 801,
        clippedStart: false,
      }),
    ];
    const geo = intradayGeometry(model({ sleep: blocks }), "compact");
    expect(sleepEdgeLabels(geo, blocks, hhmm)).toHaveLength(1);
  });

  it("keeps the longer session's edges when two blocks compete", () => {
    const blocks = [
      sleepBlock({
        key: "main",
        startMinute: 10,
        endMinute: 400,
        clippedStart: false,
      }),
      sleepBlock({
        key: "nap",
        startMinute: 404,
        endMinute: 412,
        clippedStart: false,
      }),
    ];
    const geo = intradayGeometry(model({ sleep: blocks }), "compact");
    const labels = sleepEdgeLabels(geo, blocks, hhmm);
    expect(labels.some((l) => l.blockKey === "main" && l.edge === "wake")).toBe(
      true
    );
    expect(labels.some((l) => l.blockKey === "nap" && l.edge === "bed")).toBe(
      false
    );
  });

  it("clamps every label inside the plot", () => {
    const blocks = [
      sleepBlock({
        key: "late",
        startMinute: 1430,
        endMinute: 1440,
        clippedStart: false,
        clippedEnd: false,
      }),
    ];
    const geo = intradayGeometry(model({ sleep: blocks }), "compact");
    for (const label of sleepEdgeLabels(geo, blocks, hhmm)) {
      expect(label.start).toBeGreaterThanOrEqual(geo.plotLeft - 1e-9);
      expect(label.end).toBeLessThanOrEqual(geo.plotRight + 1e-9);
    }
  });

  it("labels nothing outside a zoomed window", () => {
    const blocks = [
      sleepBlock({ startMinute: 60, endMinute: 402, clippedStart: false }),
    ];
    const geo = intradayGeometry(model({ sleep: blocks }), "wide", {
      from: 600,
      to: 900,
    });
    expect(sleepEdgeLabels(geo, blocks, hhmm)).toEqual([]);
  });
});

describe("workout block names (#1512 B)", () => {
  it("names a long block INSIDE it and never paints past its right edge", () => {
    const w = workout({ startMinute: 480, endMinute: 780 }); // 5 h
    const geo = intradayGeometry(model({ blocks: [w] }), "wide");
    const layout = blockLayout(geo, w)!;
    expect(layout.showIcon).toBe(true);
    expect(layout.text).toBe("Morning ride");
    const [label] = blockLabels(geo, [w]);
    expect(label.mode).toBe("inside");
    expect(label.end).toBeLessThanOrEqual(layout.left + layout.width + 1e-9);
  });

  // The arithmetic that makes "inside the block" almost never available: a
  // one-hour session is 1/24th of the axis. The name goes BESIDE it instead —
  // which is the half of #1512 B that actually fixes "a 45-minute run and a
  // 45-minute lift look identical".
  it("puts an ordinary session's name BESIDE its block", () => {
    const w = workout({ startMinute: 480, endMinute: 540 }); // 1 h
    const geo = intradayGeometry(model({ blocks: [w] }), "wide");
    const layout = blockLayout(geo, w)!;
    expect(layout.text).toBeNull(); // does not fit inside
    const [label] = blockLabels(geo, [w]);
    expect(label.mode).toBe("beside");
    expect(label.text).toBe("Morning ride");
    expect(label.start).toBeGreaterThanOrEqual(layout.left + layout.width);
    expect(label.end).toBeLessThanOrEqual(geo.plotRight + 1e-9);
  });

  it("keeps a late block's beside-name inside the plot (#1573)", () => {
    // The block ends AT midnight, so its label wants to start past the right
    // edge. It paints inward instead of off the chart.
    const w = workout({
      startMinute: 1380,
      endMinute: 1440,
      title: "Evening ride with the club",
    });
    const geo = intradayGeometry(model({ blocks: [w] }), "compact");
    const [label] = blockLabels(geo, [w]);
    expect(label.mode).toBe("beside");
    expect(label.start).toBeGreaterThanOrEqual(geo.plotLeft - 1e-9);
    expect(label.end).toBeLessThanOrEqual(geo.plotRight + 1e-9);
  });

  it("elides a name wider than the whole plot rather than clipping it", () => {
    const w = workout({
      startMinute: 600,
      endMinute: 660,
      title: "Evening ride with the club along the river and back again twice",
    });
    const geo = intradayGeometry(model({ blocks: [w] }), "compact");
    const [label] = blockLabels(geo, [w]);
    expect(label.text.endsWith("…")).toBe(true);
    expect(label.end).toBeLessThanOrEqual(geo.plotRight + 1e-9);
  });

  it("keeps the icon but drops the name for a sliver block", () => {
    const w = workout({ startMinute: 480, endMinute: 500 });
    const geo = intradayGeometry(model({ blocks: [w] }), "compact");
    const layout = blockLayout(geo, w)!;
    expect(layout.text).toBeNull();
  });

  it("drops even the icon when the block is a sliver", () => {
    const w = workout({ startMinute: 480, endMinute: 482 });
    const geo = intradayGeometry(model({ blocks: [w] }), "compact");
    const layout = blockLayout(geo, w)!;
    expect(layout.showIcon).toBe(false);
    expect(layout.width).toBeGreaterThan(0);
  });

  // #1573's rule, applied to this row: the longer session keeps its name and the
  // neighbour that would overlap loses ITS TEXT ONLY — block, glyph and <title>
  // all stay.
  it("drops a colliding neighbour's name, longer session first", () => {
    const long = workout({
      key: "long",
      startMinute: 480,
      endMinute: 660,
      title: "Long ride",
    });
    const short = workout({
      key: "short",
      startMinute: 665,
      endMinute: 680,
      title: "Short lift",
    });
    const geo = intradayGeometry(model({ blocks: [long, short] }), "compact");
    const labels = blockLabels(geo, [long, short]);
    expect(labels.map((l) => l.key)).toEqual(["long"]);
  });

  it("clips a block to a zoomed window and drops one outside it", () => {
    const w = workout({ startMinute: 480, endMinute: 525 });
    const geo = intradayGeometry(model({ blocks: [w] }), "wide", {
      from: 500,
      to: 560,
    });
    const layout = blockLayout(geo, w)!;
    expect(layout.left).toBeCloseTo(geo.plotLeft, 6);
    expect(
      blockLayout(
        intradayGeometry(model({ blocks: [w] }), "wide", {
          from: 900,
          to: 1000,
        }),
        w
      )
    ).toBeNull();
    expect(
      blockLabels(
        intradayGeometry(model({ blocks: [w] }), "wide", {
          from: 900,
          to: 1000,
        }),
        [w]
      )
    ).toEqual([]);
  });
});

describe("gutter labels", () => {
  it.each(VARIANTS)("%s row labels stay out of the plot", (variant) => {
    const geo = intradayGeometry(model({ sleep: [sleepBlock()] }), variant);
    const label = rowLabel(geo, "Sleep")!;
    expect(label).not.toBeNull();
    expect(label.end).toBeLessThanOrEqual(geo.plotLeft + 1e-9);
    expect(label.start).toBeGreaterThanOrEqual(-1e-9);
  });

  it.each(VARIANTS)("%s HR bounds fit the gutter", (variant) => {
    const geo = intradayGeometry(model(), variant);
    const labels = hrAxisLabels(geo);
    expect(labels).toHaveLength(2);
    expect(labels[0].text).toBe(String(geo.hrHi));
    for (const l of labels) expect(l.x).toBeLessThanOrEqual(geo.plotLeft);
  });

  it("has no HR bounds on a day with no heart rate", () => {
    expect(hrAxisLabels(intradayGeometry(model({ hr: null }), "wide"))).toEqual(
      []
    );
  });
});

describe("reading a value at a minute (#1515)", () => {
  const segments = [
    [
      { minute: 480, bpm: 100, lo: 95, hi: 110 },
      { minute: 485, bpm: 120, lo: 110, hi: 130 },
    ],
    [{ minute: 900, bpm: 70, lo: 65, hi: 75 }],
  ];

  it("returns the nearest sample within tolerance", () => {
    expect(nearestHrPoint(segments, 483, 5)!.bpm).toBe(120);
    expect(nearestHrPoint(segments, 481, 5)!.bpm).toBe(100);
  });

  it("reports nothing across a wear gap rather than the far side's value", () => {
    expect(nearestHrPoint(segments, 700, 5)).toBeNull();
    expect(nearestHrPoint([], 700, 5)).toBeNull();
  });
});

// PRACTICE SESSIONS GET THEIR OWN ROW (#4852). A morning workout and an evening
// sauna stacked on one line read as one kind of thing; the block keeps its shape
// and its colour and changes line.
describe("the practice row (#4852)", () => {
  it("puts Practice directly under Train, and each block on its own line", () => {
    const geo = intradayGeometry(
      model({ blocks: [workout(), practice()] }),
      "wide"
    );
    expect(geo.practiceTop).toBeGreaterThanOrEqual(geo.workTop + geo.workH);
    expect(blockRowTop(geo, workout())).toBe(geo.workTop);
    expect(blockRowTop(geo, practice())).toBe(geo.practiceTop);
  });

  // The collapse rule every other row already follows, applied to both halves of
  // the split: a day with only practices reserves NO Train strip, and an HR-only
  // day reserves neither. `tickTop - workTop` is the height the two rows cost, so
  // a row that collapsed but kept its strip cannot pass.
  it.each([
    ["an activity and a practice", [workout(), practice()], true, true],
    ["only practices", [practice()], false, true],
    ["only activities", [workout()], true, false],
    ["heart rate only", [], false, false],
  ] as const)("%s", (_label, blocks, train, sessions) => {
    const geo = intradayGeometry(model({ blocks: [...blocks] }), "wide");
    expect([geo.hasWorkouts, geo.hasPractice]).toEqual([train, sessions]);
    const rows = (train ? 1 : 0) + (sessions ? 1 : 0);
    expect(geo.tickTop - geo.workTop).toBe(rows * (geo.workH + geo.rowGap));
    // A practice-only day starts its row where Train would have been, rather than
    // leaving an empty line above it.
    expect(geo.practiceTop).toBe(
      geo.workTop + (train ? geo.workH + geo.rowGap : 0)
    );
  });

  // Names are placed PER ROW. The single shared row layout this replaced drops one
  // of a same-minute pair — asserted here so the split is proved against the
  // behaviour it fixes, not only against itself.
  it("keeps both names when an activity and a practice share a minute", () => {
    const a = workout({ startMinute: 480, endMinute: 525 });
    const p = practice({ startMinute: 482, endMinute: 520 });
    const geo = intradayGeometry(model({ blocks: [a, p] }), "compact");
    expect(blockLabels(geo, [a, p])).toHaveLength(1);
    expect(blockLabels(geo, [a])).toHaveLength(1);
    expect(blockLabels(geo, [p])).toHaveLength(1);
  });
});

// WHEEL AND PINCH (#4852). Both gestures are one span multiplier about one minute,
// so both are this pair of pure functions and the component only maps an event to
// them. NULL is the interesting return: it means the gesture moves nothing and the
// caller must NOT preventDefault, which is the whole difference between a chart a
// reader can scroll past and a scroll trap.
describe("wheel and pinch zoom (#4852)", () => {
  it("hands the full day's zoom-out back to the page and keeps its zoom-in", () => {
    expect(zoomViewAt(FULL_DAY_VIEW, 600, 1.3)).toBeNull();
    expect(zoomViewAt(FULL_DAY_VIEW, 600, 1)).toBeNull();
    expect(zoomViewAt(FULL_DAY_VIEW, 600, 0.5)).toEqual({
      from: 300,
      to: 1020,
    });
  });

  it.each([
    // The pointer's minute keeps its position in the plot — the anchoring that
    // makes a wheel feel like it zooms where you are pointing.
    [
      "about the middle",
      { from: 480, to: 600 },
      540,
      0.5,
      { from: 510, to: 570 },
    ],
    [
      "about the left edge",
      { from: 480, to: 600 },
      480,
      0.5,
      { from: 480, to: 540 },
    ],
    [
      "out, clamped to midnight",
      { from: 0, to: 120 },
      0,
      2,
      { from: 0, to: 240 },
    ],
    [
      "out, clamped to the day's end",
      { from: 1320, to: 1440 },
      1440,
      2,
      { from: 1200, to: 1440 },
    ],
    [
      "in, clamped to the narrowest window",
      { from: 0, to: 12 },
      6,
      0.5,
      { from: 1, to: 11 },
    ],
    [
      "out, clamped to the whole day",
      { from: 600, to: 660 },
      630,
      100,
      { from: 0, to: MINUTES_IN_DAY },
    ],
  ])("zooms %s", (_label, view, at, factor, expected) => {
    expect(zoomViewAt(view, at, factor)).toEqual(expected);
  });

  // Already AT a clamp: the window cannot move, so the page keeps the event rather
  // than the chart swallowing a scroll it has no use for.
  it("returns null when the window is already at a clamp", () => {
    expect(zoomViewAt({ from: 0, to: MIN_ZOOM_MINUTES }, 5, 0.5)).toBeNull();
    expect(zoomViewAt({ from: 480, to: 600 }, 540, 0)).toBeNull();
  });

  it.each([
    [
      "slides a zoomed window",
      { from: 480, to: 600 },
      30,
      { from: 510, to: 630 },
    ],
    ["clamps to midnight", { from: 480, to: 600 }, -600, { from: 0, to: 120 }],
    [
      "rounds to whole minutes",
      { from: 480, to: 600 },
      30.4,
      { from: 510, to: 630 },
    ],
  ])("%s", (_label, view, delta, expected) => {
    const next = panView(view, delta)!;
    expect(next).toEqual(expected);
    // A pan is not a zoom: the span is the one thing it may never change.
    expect(next.to - next.from).toBe(view.to - view.from);
  });

  it.each([
    ["the whole day is already visible", FULL_DAY_VIEW, 60],
    [
      "the window is against the edge it is pushed toward",
      { from: 1380, to: 1440 },
      100,
    ],
    ["the nudge is under a minute", { from: 480, to: 600 }, 0.4],
  ])("pans nothing when %s", (_label, view, delta) => {
    expect(panView(view, delta)).toBeNull();
  });
});
