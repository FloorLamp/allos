import { describe, expect, it } from "vitest";
import { MIN_LABEL_PX, effectiveFontPx } from "@/lib/chart-svg";
import {
  FULL_DAY_VIEW,
  INTRADAY_ROW_NAMES,
  INTRADAY_VARIANTS,
  MIN_ZOOM_MINUTES,
  axisTicks,
  clipToView,
  daylightBandX,
  expectedSleepBandX,
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
    solarDay: null,
    expectedSleep: null,
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

  // #4918 ruling 7: the expected-sleep band draws in the SAME lane a real session
  // would, so the row has to exist for it even when there is no session at all —
  // an HR-only day with nothing else stays exactly as thin as it was before.
  it("reserves the sleep row for the expected band alone, same as a real session would", () => {
    const bare = intradayGeometry(model(), "wide");
    const expecting = intradayGeometry(
      model({
        expectedSleep: {
          startMinute: -60,
          endMinute: 390,
          clippedStart: false,
          clippedEnd: false,
        },
      }),
      "wide"
    );
    expect(bare.hasExpectedSleep).toBe(false);
    expect(expecting.hasExpectedSleep).toBe(true);
    expect(expecting.height).toBeGreaterThan(bare.height);
    // The row sits directly under HR, same as a real session's row would — no
    // orphaned gap, and Train follows directly after it.
    expect(expecting.sleepTop).toBe(
      expecting.hrTop + expecting.hrH + expecting.rowGap
    );
    expect(expecting.workTop).toBe(
      expecting.sleepTop + expecting.sleepH + expecting.rowGap
    );
    // UNLIKE a real session, the expected band draws no bed/wake TEXT of its
    // own (see sleepEdgeLabels — it only ever reads model.sleep), so it earns no
    // label strip above the row: the row is thinner than a real session's.
    const withSession = intradayGeometry(
      model({ sleep: [sleepBlock({ startMinute: -60, endMinute: 390 })] }),
      "wide"
    );
    expect(expecting.workTop).toBeLessThan(withSession.workTop);
  });
});

// #4918 rulings 3 and 7: the two background bands. Neither is a row — the whole
// point is that adding one moves NOTHING about the row stack above.
describe("the background bands add no lane", () => {
  it("the daylight band spans sunrise→sunset in x, and adds zero height", () => {
    const bareModel = model();
    const sunModel = model({ solarDay: { sunriseMin: 372, sunsetMin: 1146 } });
    const bare = intradayGeometry(bareModel, "wide");
    const withSun = intradayGeometry(sunModel, "wide");
    // ZERO HEIGHT ADDED: the same model plus a solarDay is the identical row stack.
    expect(withSun.height).toBe(bare.height);
    expect(withSun.axisY).toBe(bare.axisY);
    const band = daylightBandX(withSun, sunModel)!;
    expect(band.left).toBeCloseTo(projectMinute(withSun, 372), 6);
    expect(band.right).toBeCloseTo(projectMinute(withSun, 1146), 6);
  });

  // #4918's empty-day ruling, and its own trap: the ROW-STACK floor above only
  // guards `showSleepRow`/`hasExpectedSleep`; a truly rowless day (no HR, no
  // sleep, no blocks, no ticks) leaves `axisY === padTop` UNLESS something else
  // gives the plot a canvas — which is exactly the day this ruling is about ("the
  // daylight band and the day context draw alone").
  it("still has a canvas for the daylight band on a day with no rows AT ALL", () => {
    const emptyWithSun = model({
      hr: null,
      solarDay: { sunriseMin: 372, sunsetMin: 1146 },
    });
    const geo = intradayGeometry(emptyWithSun, "wide");
    expect(geo.axisY).toBeGreaterThan(geo.padTop);
    const band = daylightBandX(geo, emptyWithSun)!;
    expect(band).not.toBeNull();
    expect(band.right).toBeGreaterThan(band.left);
    // The floor costs NOTHING once anything else already reserves the row stack —
    // proved by comparison rather than a hardcoded number, so a future row this
    // module gains cannot silently make the floor start double-reserving.
    const emptyNoSun = model({ hr: null });
    const bareEmpty = intradayGeometry(emptyNoSun, "wide");
    expect(bareEmpty.axisY).toBe(geo.axisY);
    const normalDay = intradayGeometry(model(), "wide"); // default fixture HAS hr
    expect(normalDay.axisY).toBeGreaterThan(bareEmpty.padTop);
  });

  it("draws nothing without a solarDay, and nothing outside the visible window", () => {
    const bareModel = model();
    const geo = intradayGeometry(bareModel, "wide");
    expect(daylightBandX(geo, bareModel)).toBeNull();
    const sunModel = model({ solarDay: { sunriseMin: 372, sunsetMin: 1146 } });
    const zoomed = intradayGeometry(sunModel, "wide", { from: 0, to: 300 });
    // The window sits entirely before sunrise: nothing to draw.
    expect(daylightBandX(zoomed, sunModel)).toBeNull();
  });

  it("clips the daylight band to a zoomed window that only covers part of it", () => {
    const sunModel = model({ solarDay: { sunriseMin: 372, sunsetMin: 1146 } });
    const geo = intradayGeometry(sunModel, "wide", { from: 300, to: 600 });
    const band = daylightBandX(geo, sunModel)!;
    expect(band.left).toBeCloseTo(projectMinute(geo, 372), 6);
    expect(band.right).toBeCloseTo(projectMinute(geo, 600), 6);
  });

  it("the expected-sleep band's x-span is pinned to bed→wake, gated on the state existing", () => {
    const waitingModel = model({
      expectedSleep: {
        startMinute: -60,
        endMinute: 390,
        clippedStart: false,
        clippedEnd: false,
      },
    });
    const geo = intradayGeometry(waitingModel, "wide");
    const band = expectedSleepBandX(geo, waitingModel)!;
    expect(band.left).toBeCloseTo(projectMinute(geo, -60), 6);
    expect(band.right).toBeCloseTo(projectMinute(geo, 390), 6);

    // GATED: no expectedSleep at all (a session is in hand, or nothing to expect)
    // draws nothing, however the rest of the model looks.
    const bareModel = model();
    const noBand = intradayGeometry(bareModel, "wide");
    expect(expectedSleepBandX(noBand, bareModel)).toBeNull();
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

  // WHAT THE WIDER GUTTER COST THE AXIS (#4852). Holding "Practice" whole took 15
  // units off the compact plot, which is one label slot: the compact axis now
  // affords 7 labels where it afforded 8. Nothing changes at the full day (both
  // variants keep their step) and nothing changes on the wide variant at all — the
  // move is confined to compact ZOOMED windows, where a span that used to land
  // exactly on 8 ticks steps up to the next clock-friendly step instead.
  //
  // Pinned rather than narrated, because it is the one place the gutter ruling
  // changed what a reader sees, and an accidental re-narrowing would show up here.
  it("gives the compact zoom one label slot fewer than the old gutter did", () => {
    const geo = intradayGeometry(model(), "compact", { from: 480, to: 590 });
    const ticks = axisTicks(geo);
    // 110 minutes: 8 ticks at a 15-minute step fitted the old 310-unit plot; the
    // 295-unit one takes the 20-minute step and 6 ticks.
    expect(ticks[1] - ticks[0]).toBe(20);
    expect(ticks.length).toBeLessThanOrEqual(7);
    // The wide variant is untouched: it loses 16.5 units and still affords 9.
    expect(
      axisTicks(intradayGeometry(model(), "wide", { from: 480, to: 590 }))
    ).toEqual([480, 495, 510, 525, 540, 555, 570, 585]);
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
  // THE GUTTER HOLDS EVERY ROW NAME WHOLE (#4852, owner ruling 2026-09-03).
  //
  // "Practice" is 52.80 units at the compact label size and 60.00 at the wide one;
  // the gutters that held "Sleep" and "Train" gave it 37.80 and 43.50, so it drew
  // as `Prac…`. The ruling widened `padLeft` rather than renaming the row, and this
  // is the assertion that keeps it widened: it reads `INTRADAY_ROW_NAMES` — the
  // same list the chart draws from — so a fourth row, a bigger label size or a
  // narrowed gutter all fail here rather than shipping a shortened row name.
  //
  // The claim is the TEXT, not merely that something was placed: `rowLabel` returns
  // a label either way, and `Prac…` is a placed label that passes every containment
  // assertion below it.
  it.each(VARIANTS)("%s elides no row name", (variant) => {
    const geo = intradayGeometry(
      model({ sleep: [sleepBlock()], blocks: [workout(), practice()] }),
      variant
    );
    for (const name of Object.values(INTRADAY_ROW_NAMES)) {
      const placed = rowLabel(geo, name);
      expect(placed, `${variant} dropped "${name}"`).not.toBeNull();
      expect(placed!.text, `${variant} elided "${name}"`).toBe(name);
      // …and still inside the gutter: widening it is not licence to paint over
      // the plot's left edge.
      expect(placed!.start).toBeGreaterThanOrEqual(-1e-9);
      expect(placed!.end).toBeLessThanOrEqual(geo.plotLeft + 1e-9);
    }
  });

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
