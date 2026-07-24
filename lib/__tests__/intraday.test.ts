import { describe, expect, it } from "vitest";
import {
  buildIntradayModel,
  clockMinute,
  downsampleHr,
  localStampMinute,
  splitHrSegments,
  INTRADAY_MAX_POINTS,
  MINUTES_IN_DAY,
  type IntradayHrBucket,
  type IntradayInput,
} from "@/lib/intraday";
import {
  timelineEntryAnchorId,
  type TimelineEvent,
} from "@/lib/timeline-format";

const DAY = "2026-03-11";

function input(over: Partial<IntradayInput> = {}): IntradayInput {
  return {
    date: DAY,
    events: [],
    hr: [],
    sleep: [],
    zone2: null,
    nowMinute: null,
    ...over,
  };
}

function hrRun(
  date: string,
  startMinute: number,
  count: number,
  bpm: (i: number) => number,
  spread = 0
): IntradayHrBucket[] {
  return Array.from({ length: count }, (_, i) => {
    const m = startMinute + i;
    const ts = `${date}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(
      m % 60
    ).padStart(2, "0")}`;
    return {
      ts,
      bpm: bpm(i),
      bpm_min: bpm(i) - spread,
      bpm_max: bpm(i) + spread,
      n: 6,
    };
  });
}

function activityEvent(
  id: string,
  over: Partial<TimelineEvent> = {}
): TimelineEvent {
  return {
    id,
    date: DAY,
    category: "activity",
    title: "Morning ride",
    sortTime: "08:00",
    iconType: "cardio",
    href: "/training?tab=log#activity-1",
    clockWindow: {
      date: DAY,
      start_time: "08:00",
      end_time: null,
      duration_min: 60,
    },
    ...over,
  };
}

describe("clockMinute / localStampMinute", () => {
  it("parses HH:MM and HH:MM:SS wall times", () => {
    expect(clockMinute("00:00")).toBe(0);
    expect(clockMinute("08:30")).toBe(510);
    expect(clockMinute("23:59:59")).toBe(1439);
  });

  it("rejects non-clock strings and impossible times", () => {
    expect(clockMinute(null)).toBeNull();
    expect(clockMinute("")).toBeNull();
    expect(clockMinute("morning")).toBeNull();
    expect(clockMinute("25:00")).toBeNull();
    expect(clockMinute("08:74")).toBeNull();
  });

  it("offsets a stamp from an adjacent day", () => {
    expect(localStampMinute(DAY, `${DAY}T06:15`)).toBe(375);
    expect(localStampMinute(DAY, "2026-03-10T22:30")).toBe(22 * 60 + 30 - 1440);
    expect(localStampMinute(DAY, "2026-03-12T01:00")).toBe(1440 + 60);
    expect(localStampMinute(DAY, "nonsense")).toBeNull();
  });
});

describe("downsampleHr", () => {
  it("collapses per-minute buckets to 5-minute points, count-weighted", () => {
    // Five minutes: four at 100 bpm with n=1, one at 200 bpm with n=16. The
    // weighted mean leans to the heavier bucket; a plain mean would say 120.
    const buckets: IntradayHrBucket[] = [
      { ts: `${DAY}T06:00`, bpm: 100, n: 1 },
      { ts: `${DAY}T06:01`, bpm: 100, n: 1 },
      { ts: `${DAY}T06:02`, bpm: 100, n: 1 },
      { ts: `${DAY}T06:03`, bpm: 100, n: 1 },
      { ts: `${DAY}T06:04`, bpm: 200, n: 16, bpm_min: 180, bpm_max: 210 },
    ];
    const points = downsampleHr(DAY, buckets);
    expect(points).toHaveLength(1);
    expect(points[0].minute).toBe(360);
    expect(points[0].bpm).toBe(180);
    // The band keeps the TRUE extremes of the merged minutes — averaging them
    // would shrink the band and hide the spike.
    expect(points[0].lo).toBe(100);
    expect(points[0].hi).toBe(210);
  });

  it("never exceeds 288 points for a fully-worn day", () => {
    const points = downsampleHr(
      DAY,
      hrRun(DAY, 0, MINUTES_IN_DAY, () => 70)
    );
    expect(points).toHaveLength(INTRADAY_MAX_POINTS);
    expect(points[0].minute).toBe(0);
    expect(points.at(-1)?.minute).toBe(MINUTES_IN_DAY - 5);
  });

  it("drops buckets stamped outside the rendered day", () => {
    const points = downsampleHr(DAY, [
      { ts: `${DAY}T10:00`, bpm: 70 },
      { ts: "2026-03-10T23:59", bpm: 55 },
      { ts: "2026-03-12T00:01", bpm: 58 },
    ]);
    expect(points.map((p) => p.minute)).toEqual([600]);
  });

  it("falls back to bpm when the min/max columns are null", () => {
    const points = downsampleHr(DAY, [
      { ts: `${DAY}T07:00`, bpm: 62, bpm_min: null, bpm_max: null },
    ]);
    expect(points[0]).toMatchObject({ bpm: 62, lo: 62, hi: 62 });
  });
});

describe("splitHrSegments", () => {
  it("breaks the line across a wear gap instead of interpolating", () => {
    const points = [
      ...downsampleHr(
        DAY,
        hrRun(DAY, 0, 30, () => 60)
      ),
      ...downsampleHr(
        DAY,
        hrRun(DAY, 600, 30, () => 120)
      ),
    ].sort((a, b) => a.minute - b.minute);
    const segments = splitHrSegments(points);
    expect(segments).toHaveLength(2);
    expect(segments[0].at(-1)?.minute).toBe(25);
    expect(segments[1][0].minute).toBe(600);
  });

  it("keeps a contiguous run in one segment", () => {
    const segments = splitHrSegments(
      downsampleHr(
        DAY,
        hrRun(DAY, 0, 120, () => 60)
      )
    );
    expect(segments).toHaveLength(1);
  });

  it("treats a DST spring-forward hour as an ordinary gap (not engineered)", () => {
    // A 23-hour local day: no stored minutes exist between 02:00 and 03:00, so
    // the axis simply has a hole there and the line breaks over it.
    const points = [
      ...downsampleHr(
        DAY,
        hrRun(DAY, 60, 60, () => 58)
      ),
      ...downsampleHr(
        DAY,
        hrRun(DAY, 180, 60, () => 61)
      ),
    ].sort((a, b) => a.minute - b.minute);
    const segments = splitHrSegments(points);
    expect(segments).toHaveLength(2);
    expect(points.some((p) => p.minute >= 120 && p.minute < 180)).toBe(false);
  });
});

describe("buildIntradayModel — layer gating", () => {
  it("returns null when nothing on the day is intraday (no empty frame)", () => {
    // A weigh-in and a grouped lab panel: real feed events, but day-grained —
    // no clock time, so no ticks, and no HR / sleep / windowed workout either.
    const model = buildIntradayModel(
      input({
        events: [
          { id: "body:7", date: DAY, category: "body", title: "Body metrics" },
          { id: "medical:1", date: DAY, category: "medical", title: "Lipids" },
        ],
      })
    );
    expect(model).toBeNull();
  });

  it("returns null on a completely empty day", () => {
    expect(buildIntradayModel(input())).toBeNull();
  });

  it("drops the HR layer but keeps the panel when only ticks exist", () => {
    const model = buildIntradayModel(
      input({
        events: [
          {
            id: "document:4",
            date: DAY,
            category: "document",
            title: "Lab PDF",
            sortTime: "14:05",
          },
        ],
      })
    );
    expect(model).not.toBeNull();
    expect(model!.hr).toBeNull();
    expect(model!.sleep).toEqual([]);
    expect(model!.workouts).toEqual([]);
    expect(model!.ticks).toHaveLength(1);
  });

  it("carries the Zone 2 band through onto the HR layer", () => {
    const model = buildIntradayModel(
      input({
        hr: hrRun(DAY, 480, 30, () => 135),
        zone2: { low: 130, high: 142 },
      })
    );
    expect(model!.hr!.zone2).toEqual({ low: 130, high: 142 });
    expect(model!.hr!.min).toBe(135);
    expect(model!.hr!.max).toBe(135);
  });
});

describe("buildIntradayModel — sleep clipping", () => {
  it("clips a session entering from before midnight without re-attributing it", () => {
    const model = buildIntradayModel(
      input({
        sleep: [
          { key: "s1", startMinute: -75, endMinute: 6 * 60 + 30, stages: [] },
        ],
      })
    );
    const block = model!.sleep[0];
    expect(block.startMinute).toBe(0);
    expect(block.endMinute).toBe(390);
    expect(block.clippedStart).toBe(true);
    expect(block.clippedEnd).toBe(false);
  });

  it("clips a session running past midnight at the right edge", () => {
    const model = buildIntradayModel(
      input({
        sleep: [{ key: "s2", startMinute: 1380, endMinute: 1830, stages: [] }],
      })
    );
    expect(model!.sleep[0]).toMatchObject({
      startMinute: 1380,
      endMinute: MINUTES_IN_DAY,
      clippedStart: false,
      clippedEnd: true,
    });
  });

  it("drops a session that does not overlap the day at all", () => {
    const model = buildIntradayModel(
      input({
        sleep: [{ key: "s3", startMinute: -400, endMinute: -30, stages: [] }],
        hr: hrRun(DAY, 600, 10, () => 70),
      })
    );
    expect(model!.sleep).toEqual([]);
  });

  it("clips stage sub-bands with their session and drops out-of-day ones", () => {
    const model = buildIntradayModel(
      input({
        sleep: [
          {
            key: "s4",
            startMinute: -60,
            endMinute: 420,
            stages: [
              { stage: "deep", startMinute: -50, endMinute: 20 },
              { stage: "rem", startMinute: 200, endMinute: 260 },
              { stage: "light", startMinute: -300, endMinute: -200 },
            ],
          },
        ],
      })
    );
    expect(model!.sleep[0].stages).toEqual([
      { stage: "deep", startMinute: 0, endMinute: 20 },
      { stage: "rem", startMinute: 200, endMinute: 260 },
    ]);
  });

  it("orders blocks by start time", () => {
    const model = buildIntradayModel(
      input({
        sleep: [
          { key: "nap", startMinute: 840, endMinute: 900 },
          { key: "night", startMinute: -60, endMinute: 400 },
        ],
      })
    );
    expect(model!.sleep.map((b) => b.key)).toEqual(["night", "nap"]);
  });
});

describe("buildIntradayModel — workout blocks", () => {
  it("bounds a block from start_time + duration and links the activity", () => {
    const model = buildIntradayModel(input({ events: [activityEvent("a:1")] }));
    expect(model!.workouts).toHaveLength(1);
    expect(model!.workouts[0]).toMatchObject({
      startMinute: 480,
      endMinute: 540,
      title: "Morning ride",
      href: "/training?tab=log#activity-1",
      anchorId: timelineEntryAnchorId("a:1"),
    });
  });

  it("prefers a stored end_time and rolls a past-midnight session forward", () => {
    const model = buildIntradayModel(
      input({
        events: [
          activityEvent("a:2", {
            clockWindow: {
              date: DAY,
              start_time: "23:00",
              end_time: "01:00",
              duration_min: null,
            },
          }),
        ],
      })
    );
    expect(model!.workouts[0]).toMatchObject({
      startMinute: 1380,
      endMinute: MINUTES_IN_DAY,
      clippedEnd: true,
    });
  });

  it("draws no block for an activity that cannot be bounded — it stays a tick", () => {
    const model = buildIntradayModel(
      input({
        events: [
          activityEvent("a:3", {
            sortTime: "17:45",
            clockWindow: {
              date: DAY,
              start_time: "17:45",
              end_time: null,
              duration_min: null,
            },
          }),
        ],
      })
    );
    expect(model!.workouts).toEqual([]);
    expect(model!.ticks).toHaveLength(1);
    expect(model!.ticks[0].minute).toBe(1065);
  });

  it("does not double-draw a bounded workout as a tick", () => {
    const model = buildIntradayModel(input({ events: [activityEvent("a:4")] }));
    expect(model!.workouts).toHaveLength(1);
    expect(model!.ticks).toEqual([]);
  });
});

describe("buildIntradayModel — the tick rail", () => {
  const ticked: TimelineEvent[] = [
    {
      id: "symptom:x",
      date: DAY,
      category: "symptom",
      title: "Temperature 101.4 °F",
      sortTime: "21:15",
      tone: "bad",
    },
    {
      id: "document:9",
      date: DAY,
      category: "document",
      title: "Visit summary",
      sortTime: "09:30",
    },
    {
      id: "body:2",
      date: DAY,
      category: "body",
      title: "Body metrics logged",
    },
  ];

  it("emits one tick per clock-timed event, in time order, with tone + anchor", () => {
    const model = buildIntradayModel(input({ events: ticked }));
    expect(model!.ticks.map((t) => t.eventId)).toEqual([
      "document:9",
      "symptom:x",
    ]);
    expect(model!.ticks[0]).toMatchObject({
      minute: 570,
      tone: "default",
      anchorId: timelineEntryAnchorId("document:9"),
      label: "Visit summary",
      category: "document",
    });
    expect(model!.ticks[1]).toMatchObject({ minute: 1275, tone: "bad" });
  });

  it("gives a day-grained event no tick (it has no clock time to place)", () => {
    const model = buildIntradayModel(input({ events: ticked }));
    expect(model!.ticks.some((t) => t.eventId === "body:2")).toBe(false);
  });

  // The "one visibility predicate" contract: the panel is handed the feed's OWN
  // resolved event list, so anything the feed filtered out (an age-restricted
  // training event, a category-filtered row) is structurally unable to produce a
  // block or a tick. Pinned here so a future refactor that re-queries events
  // inside the model breaks this test.
  it("yields nothing for an event the feed filtered out", () => {
    const visible = [activityEvent("a:9"), ...ticked];
    const feedFilter = (e: TimelineEvent) => e.category !== "activity";
    const full = buildIntradayModel(input({ events: visible }))!;
    const filtered = buildIntradayModel(
      input({ events: visible.filter(feedFilter) })
    )!;
    expect(full.workouts).toHaveLength(1);
    expect(filtered.workouts).toEqual([]);
    expect(filtered.ticks.map((t) => t.eventId)).toEqual(
      full.ticks.map((t) => t.eventId)
    );
    expect(
      filtered.ticks.some((t) => t.eventId === "a:9") ||
        filtered.workouts.some((w) => w.eventId === "a:9")
    ).toBe(false);
  });
});

describe("buildIntradayModel — the now-marker", () => {
  it("keeps an in-range now minute", () => {
    const model = buildIntradayModel(
      input({ hr: hrRun(DAY, 0, 10, () => 60), nowMinute: 780 })
    );
    expect(model!.nowMinute).toBe(780);
  });

  it("drops an out-of-range or absent now minute", () => {
    const hr = hrRun(DAY, 0, 10, () => 60);
    expect(
      buildIntradayModel(input({ hr, nowMinute: 5000 }))!.nowMinute
    ).toBeNull();
    expect(buildIntradayModel(input({ hr }))!.nowMinute).toBeNull();
  });

  it("never justifies a frame on its own", () => {
    expect(buildIntradayModel(input({ nowMinute: 600 }))).toBeNull();
  });
});

describe("timelineEntryAnchorId", () => {
  it("makes a fragment-safe id from an event id", () => {
    expect(timelineEntryAnchorId("activity:12")).toBe(
      "timeline-entry-activity-12"
    );
    expect(timelineEntryAnchorId("intake:medication:2026-03-11")).toBe(
      "timeline-entry-intake-medication-2026-03-11"
    );
  });

  it("collapses anything outside the fragment-safe set", () => {
    expect(timelineEntryAnchorId("doc: Ada’s panel (2026)")).toBe(
      "timeline-entry-doc-Ada-s-panel-2026-"
    );
  });
});
