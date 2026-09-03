import { describe, it, expect } from "vitest";
import { vitalReadingTime, type VitalReadingRow } from "@/lib/vitals-day";

// A vital reading's clock time (#1466, narrowed by #4767). Pure: fixtures only, no
// DB. Every value here is synthetic (no PHI) — round numbers on a fictional day.

const TZ = "America/New_York";
const DAY = "2026-07-25";

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
  it("reads a stated occurred_at first — the declared event column (#2154/#2235)", () => {
    // 11:12Z on a July day is 07:12 in New York (UTC-4). The legacy external_id
    // encoding never overrides the column that MEANS "when this reading was
    // taken".
    const row = bpRow({
      occurred_at: "2026-07-25T11:12:00Z",
      external_id: hcId("Blood Pressure Systolic", "2026-07-25T11:10:00Z"),
    });
    expect(vitalReadingTime(row, TZ)).toBe("07:12");
  });

  it("gates a stated occurred_at on the row's own local day, like the ingest instant", () => {
    // The statement resolves to the 24th locally while the row says the 25th —
    // the profile's timezone moved since it was stated. Fall through to the
    // legacy encoding rather than labelling the day with another day's clock.
    const row = bpRow({
      date: DAY,
      occurred_at: "2026-07-24T18:00:00Z",
      external_id: hcId("Blood Pressure Systolic", "2026-07-25T11:10:00Z"),
    });
    expect(vitalReadingTime(row, TZ)).toBe("07:10");
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
});
