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
  workoutBlockLayout,
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
    workouts: [],
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

function workout(over: Partial<IntradayModel["workouts"][number]> = {}) {
  return {
    key: "a:1",
    eventId: "a:1",
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
        workouts: [workout()],
        ticks: [
          {
            key: "t",
            eventId: "t",
            anchorId: "a",
            minute: 600,
            label: "Doc",
            category: "document",
            kind: "event",
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
      model({ sleep: [sleepBlock()], workouts: [workout()] }),
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
  it("names a long block and never paints past its right edge", () => {
    const w = workout({ startMinute: 480, endMinute: 780 }); // 5 h
    const geo = intradayGeometry(model({ workouts: [w] }), "wide");
    const layout = workoutBlockLayout(geo, w)!;
    expect(layout.showIcon).toBe(true);
    expect(layout.text).not.toBeNull();
    expect(layout.textX).toBeGreaterThanOrEqual(layout.left);
    expect(
      layout.textX + layout.text!.length * geo.labelSize * 0.6
    ).toBeLessThanOrEqual(layout.left + layout.width + 1e-9);
  });

  it("elides a name the block cannot hold", () => {
    const w = workout({
      startMinute: 480,
      endMinute: 620,
      title: "Evening ride with the club along the river",
    });
    const geo = intradayGeometry(model({ workouts: [w] }), "wide");
    const layout = workoutBlockLayout(geo, w)!;
    expect(layout.text!.endsWith("…")).toBe(true);
  });

  it("falls back to icon-only for a short block", () => {
    const w = workout({ startMinute: 480, endMinute: 500 });
    const geo = intradayGeometry(model({ workouts: [w] }), "compact");
    const layout = workoutBlockLayout(geo, w)!;
    expect(layout.text).toBeNull();
  });

  it("drops even the icon when the block is a sliver", () => {
    const w = workout({ startMinute: 480, endMinute: 482 });
    const geo = intradayGeometry(model({ workouts: [w] }), "compact");
    const layout = workoutBlockLayout(geo, w)!;
    expect(layout.showIcon).toBe(false);
    expect(layout.text).toBeNull();
    expect(layout.width).toBeGreaterThan(0);
  });

  it("clips a block to a zoomed window and drops one outside it", () => {
    const w = workout({ startMinute: 480, endMinute: 525 });
    const geo = intradayGeometry(model({ workouts: [w] }), "wide", {
      from: 500,
      to: 560,
    });
    const layout = workoutBlockLayout(geo, w)!;
    expect(layout.left).toBeCloseTo(geo.plotLeft, 6);
    expect(
      workoutBlockLayout(
        intradayGeometry(model({ workouts: [w] }), "wide", {
          from: 900,
          to: 1000,
        }),
        w
      )
    ).toBeNull();
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
