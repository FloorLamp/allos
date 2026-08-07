import { describe, it, expect } from "vitest";
import {
  buildTodayVitalsStrip,
  hrSlotSeries,
  intradayVitalPoints,
  latestVitalOn,
  slotLabel,
  toIntradaySlotSeries,
  VITALS_SLOT_MINUTES,
  vitalReadingTime,
  type VitalReadingRow,
} from "@/lib/vitals-day";
import { MINUTES_IN_DAY } from "@/lib/intraday";

// The Trends → Vitals today/intraday model (#1466). Pure: fixtures only, no DB.
// Every value here is synthetic (no PHI) — round numbers on a fictional day.

const TZ = "America/New_York";
const DAY = "2026-07-25";
const SLOTS = MINUTES_IN_DAY / VITALS_SLOT_MINUTES;

function bpRow(over: Partial<VitalReadingRow> = {}): VitalReadingRow {
  return { id: 1, date: DAY, value_num: 120, ...over };
}

// The ingest's natural key carries the reading instant (see lib/integrations/
// health-connect.ts) — the only place a synced vital's clock time survives, since
// medical_records.date is day-granular by contract.
function hcId(canonical: string, iso: string): string {
  return `health-connect:${canonical}:${iso}`;
}

describe("vitalReadingTime", () => {
  it("reads a manual reading's HH:MM note (the #800 convention)", () => {
    expect(vitalReadingTime(bpRow({ notes: "08:05" }), TZ)).toBe("08:05");
  });

  it("reads a stated occurred_at first — the declared event column (#2235)", () => {
    // 11:12Z on a July day is 07:12 in New York (UTC-4). The riding conventions
    // (a notes HH:MM, an external_id instant) never override the column that
    // MEANS "when this reading was taken".
    const row = bpRow({
      occurred_at: "2026-07-25T11:12:00Z",
      notes: "08:05",
      external_id: hcId("Blood Pressure Systolic", "2026-07-25T11:10:00Z"),
    });
    expect(vitalReadingTime(row, TZ)).toBe("07:12");
  });

  it("gates a stated occurred_at on the row's own local day, like the ingest instant", () => {
    // The statement resolves to the 24th locally while the row says the 25th —
    // the profile's timezone moved since it was stated. Fall through to the next
    // convention rather than labelling the day with another day's clock.
    const row = bpRow({
      date: DAY,
      occurred_at: "2026-07-24T18:00:00Z",
      notes: "08:05",
    });
    expect(vitalReadingTime(row, TZ)).toBe("08:05");
    expect(
      vitalReadingTime(
        bpRow({ date: DAY, occurred_at: "2026-07-24T18:00:00Z" }),
        TZ
      )
    ).toBeNull();
    // Garbage in the column is no statement at all.
    expect(
      vitalReadingTime(bpRow({ occurred_at: "not-an-instant" }), TZ)
    ).toBeNull();
  });

  it("ignores a note that is not a clock time", () => {
    expect(vitalReadingTime(bpRow({ notes: "after coffee" }), TZ)).toBeNull();
    expect(vitalReadingTime(bpRow({ notes: "44:99" }), TZ)).toBeNull();
  });

  it("converts an ingested instant into the profile's wall clock", () => {
    // 11:10Z on a July day is 07:10 in New York (UTC-4).
    const row = bpRow({
      external_id: hcId("Blood Pressure Systolic", "2026-07-25T11:10:00Z"),
    });
    expect(vitalReadingTime(row, TZ)).toBe("07:10");
  });

  it("resolves a UTC instant that belongs to the PREVIOUS UTC day", () => {
    // 01:30Z on the 26th is 21:30 on the 25th in New York — the row's own local
    // day, so the evening reading keeps its time instead of being dropped.
    const row = bpRow({
      date: DAY,
      external_id: hcId("Oxygen Saturation", "2026-07-26T01:30:00Z"),
    });
    expect(vitalReadingTime(row, TZ)).toBe("21:30");
  });

  it("returns null when the derived wall clock lands on another local day", () => {
    // The row says the 25th but its instant resolves to the 24th locally: the
    // profile's timezone moved after ingest. A time that names a different day
    // than the row it labels is worse than no time at all.
    const row = bpRow({
      date: DAY,
      external_id: hcId("Oxygen Saturation", "2026-07-24T18:00:00Z"),
    });
    expect(vitalReadingTime(row, TZ)).toBeNull();
  });

  it("returns null for a day-granular row and for an unparseable instant", () => {
    expect(vitalReadingTime(bpRow(), TZ)).toBeNull();
    expect(
      vitalReadingTime(bpRow({ external_id: "manual:whatever" }), TZ)
    ).toBeNull();
    expect(
      vitalReadingTime(
        bpRow({ external_id: hcId("X", "2026-13-45T99:99:99Z") }),
        TZ
      )
    ).toBeNull();
  });

  it("prefers the note over the instant when a row somehow carries both", () => {
    const row = bpRow({
      notes: "06:00",
      external_id: hcId("Body Temperature", "2026-07-25T11:10:00Z"),
    });
    expect(vitalReadingTime(row, TZ)).toBe("06:00");
  });
});

describe("latestVitalOn", () => {
  it("ignores other days and non-numeric rows", () => {
    const rows = [
      bpRow({ id: 1, date: "2026-07-24", value_num: 111 }),
      bpRow({ id: 2, value_num: null }),
      bpRow({ id: 3, value_num: 118 }),
    ];
    expect(latestVitalOn(rows, DAY, TZ)).toEqual({ value: 118, time: null });
  });

  it("picks the latest by clock time, not by row order", () => {
    const rows = [
      bpRow({ id: 9, value_num: 131, notes: "19:40" }),
      bpRow({ id: 10, value_num: 118, notes: "07:10" }),
    ];
    expect(latestVitalOn(rows, DAY, TZ)).toEqual({
      value: 131,
      time: "19:40",
    });
  });

  it("falls back to insert order when the day's rows carry no time", () => {
    const rows = [
      bpRow({ id: 4, value_num: 120 }),
      bpRow({ id: 7, value_num: 126 }),
      bpRow({ id: 5, value_num: 122 }),
    ];
    expect(latestVitalOn(rows, DAY, TZ)).toEqual({ value: 126, time: null });
  });

  it("prefers a timed reading over an untimed one on the same day", () => {
    const rows = [
      bpRow({ id: 30, value_num: 140 }),
      bpRow({ id: 2, value_num: 117, notes: "06:15" }),
    ];
    expect(latestVitalOn(rows, DAY, TZ)).toEqual({
      value: 117,
      time: "06:15",
    });
  });

  it("returns null for an empty day", () => {
    expect(latestVitalOn([], DAY, TZ)).toBeNull();
  });
});

describe("buildTodayVitalsStrip", () => {
  const specs = [
    {
      key: "bp",
      label: "Blood pressure",
      unit: "mmHg",
      rows: [bpRow({ id: 1, value_num: 118, notes: "07:10" })],
      pairRows: [bpRow({ id: 2, value_num: 76, notes: "07:10" })],
    },
    {
      key: "temperature",
      label: "Temperature",
      unit: "°F",
      rows: [bpRow({ id: 3, value_num: 98.64, notes: "08:05" })],
      decimals: 1,
    },
    {
      key: "steps",
      label: "Steps",
      unit: "steps",
      rows: [bpRow({ id: 4, value_num: 4321 })],
      groupThousands: true,
    },
    { key: "spo2", label: "Oxygen sat.", unit: "%", rows: [] },
  ];

  it("renders one row per vital with a reading today, in spec order", () => {
    expect(buildTodayVitalsStrip(specs, DAY, TZ)).toEqual([
      {
        key: "bp",
        label: "Blood pressure",
        value: "118/76",
        unit: "mmHg",
        time: "07:10",
      },
      {
        key: "temperature",
        label: "Temperature",
        value: "98.6",
        unit: "°F",
        time: "08:05",
      },
      {
        key: "steps",
        label: "Steps",
        value: "4,321",
        unit: "steps",
        time: null,
      },
    ]);
  });

  it("renders nothing at all for an empty day", () => {
    // The strip is data-gated like every #1068 intraday layer: no readings today
    // means no frame, not an empty card.
    expect(buildTodayVitalsStrip(specs, "2026-07-20", TZ)).toEqual([]);
  });

  it("shows the primary alone when its pair has no reading today", () => {
    const rows = buildTodayVitalsStrip(
      [{ ...specs[0], pairRows: [] }],
      DAY,
      TZ
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("118");
  });

  it("carries a null time for a day-granular aggregate", () => {
    const rows = buildTodayVitalsStrip(
      [
        {
          key: "resting-hr",
          label: "Resting HR",
          unit: "bpm",
          rows: [{ date: DAY, value_num: 54 }],
        },
      ],
      DAY,
      TZ
    );
    expect(rows).toEqual([
      {
        key: "resting-hr",
        label: "Resting HR",
        value: "54",
        unit: "bpm",
        time: null,
      },
    ]);
  });
});

describe("intradayVitalPoints", () => {
  it("keeps only today's TIMED readings, ascending by minute", () => {
    const rows = [
      bpRow({ id: 1, value_num: 131, notes: "19:40" }),
      bpRow({ id: 2, value_num: 118, notes: "07:10" }),
      bpRow({ id: 3, value_num: 125 }), // untimed → stays in the Today strip
      bpRow({ id: 4, date: "2026-07-24", value_num: 140, notes: "07:10" }),
    ];
    expect(intradayVitalPoints(rows, DAY, TZ)).toEqual([
      { minute: 7 * 60 + 10, value: 118, time: "07:10" },
      { minute: 19 * 60 + 40, value: 131, time: "19:40" },
    ]);
  });

  it("positions an ingested reading by its LOCAL clock", () => {
    const rows = [
      bpRow({
        id: 5,
        value_num: 97,
        external_id: hcId("Oxygen Saturation", "2026-07-25T11:10:00Z"),
      }),
    ];
    expect(intradayVitalPoints(rows, DAY, TZ)).toEqual([
      { minute: 430, value: 97, time: "07:10" },
    ]);
  });
});

describe("toIntradaySlotSeries", () => {
  it("spans the whole day at a fixed slot width", () => {
    const series = toIntradaySlotSeries([]);
    expect(series).toHaveLength(SLOTS);
    expect(series[0].date).toBe("00:00");
    expect(series[1].date).toBe("00:05");
    expect(series[SLOTS - 1].date).toBe("23:55");
    // An empty day is all-null, never a collapsed axis — the caller data-gates on
    // the point list, not on this array's length.
    expect(series.every((p) => p.value === null)).toBe(true);
  });

  it("places a reading in its slot and leaves the rest null", () => {
    const series = toIntradaySlotSeries([
      { minute: 7 * 60 + 12, value: 97 },
      { minute: 19 * 60 + 40, value: 95 },
    ]);
    // 07:12 floors into the 07:10 slot; the gap between the two readings is a run
    // of real nulls, which is what makes x proportional to time.
    expect(series[(7 * 60 + 10) / 5]).toEqual({ date: "07:10", value: 97 });
    expect(series[(19 * 60 + 40) / 5]).toEqual({ date: "19:40", value: 95 });
    expect(series.filter((p) => p.value !== null)).toHaveLength(2);
  });

  it("keeps the LATER reading when two share a slot", () => {
    const series = toIntradaySlotSeries([
      { minute: 604, value: 99 },
      { minute: 601, value: 91 },
    ]);
    expect(series[120]).toEqual({ date: "10:00", value: 99 });
  });

  it("drops out-of-day and non-finite minutes", () => {
    const series = toIntradaySlotSeries([
      { minute: -5, value: 60 },
      { minute: MINUTES_IN_DAY, value: 61 },
      { minute: Number.NaN, value: 62 },
      { minute: 0, value: Number.NaN },
    ]);
    expect(series.every((p) => p.value === null)).toBe(true);
  });
});

describe("slotLabel", () => {
  it("formats minutes past midnight as a wall clock", () => {
    expect(slotLabel(0)).toBe("00:00");
    expect(slotLabel(65)).toBe("01:05");
    expect(slotLabel(1435)).toBe("23:55");
  });
});

describe("hrSlotSeries", () => {
  it("maps the day's HR minutes onto the same slot grid", () => {
    const buckets = [
      { ts: `${DAY}T06:00`, bpm: 58, n: 4 },
      { ts: `${DAY}T06:02`, bpm: 62, n: 4 },
      { ts: `${DAY}T09:30`, bpm: 140, n: 6 },
      { ts: `2026-07-24T06:00`, bpm: 200, n: 6 }, // another day → ignored
    ];
    const series = hrSlotSeries(DAY, buckets);
    expect(series).toHaveLength(SLOTS);
    // The 06:00 slot is downsampleHr's count-weighted merge of 06:00 + 06:02.
    expect(series[72]).toEqual({ date: "06:00", value: 60 });
    expect(series[114]).toEqual({ date: "09:30", value: 140 });
    // The hours between are genuine wear gaps, carried as nulls so the caller can
    // render a break rather than a straight line implying a measured flat HR.
    expect(series[90].value).toBeNull();
  });

  it("returns an empty series when the day has no HR at all", () => {
    expect(hrSlotSeries(DAY, [])).toEqual([]);
  });
});
