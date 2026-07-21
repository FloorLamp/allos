import { describe, expect, it } from "vitest";
import {
  pickOneProviderPerDay,
  pickRowsOneOriginPerSourceDay,
  pickRowsOneSourcePerDay,
  PROVIDER_PREFERENCE,
} from "@/lib/metric-providers";

describe("pickRowsOneOriginPerSourceDay", () => {
  const pick = (
    rows: {
      date: string;
      source: string;
      origin: string | null;
      value: number;
    }[]
  ) =>
    pickRowsOneOriginPerSourceDay(
      rows,
      (row) => row.date,
      (row) => row.source,
      (row) => row.origin,
      (row) => row.value
    );

  it("keeps the largest origin subtotal within one source/day", () => {
    const rows = [
      {
        date: "2026-07-20",
        source: "health-connect",
        origin: "garmin",
        value: 470,
      },
      {
        date: "2026-07-20",
        source: "health-connect",
        origin: "fitbit",
        value: 32.4,
      },
    ];
    expect(pick(rows)).toEqual([rows[0]]);
  });

  it("keeps independent days/sources and treats null origin as a normal group", () => {
    const rows = [
      {
        date: "2026-07-20",
        source: "health-connect",
        origin: null,
        value: 100,
      },
      {
        date: "2026-07-20",
        source: "health-connect",
        origin: "fitbit",
        value: 90,
      },
      {
        date: "2026-07-21",
        source: "health-connect",
        origin: "fitbit",
        value: 50,
      },
      { date: "2026-07-20", source: "strava", origin: null, value: 25 },
    ];
    expect(pick(rows)).toEqual([rows[0], rows[2], rows[3]]);
  });
});

describe("pickOneProviderPerDay", () => {
  it("keeps a single provider per day instead of summing across sources", () => {
    // A day with both Health Connect and Strava active calories must not sum.
    const out = pickOneProviderPerDay(
      [
        { date: "2026-06-15", source: "strava", value: 300 },
        { date: "2026-06-15", source: "health-connect", value: 500 },
      ],
      PROVIDER_PREFERENCE
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 500 }]);
  });

  it("falls back to Strava when Health Connect is absent", () => {
    const out = pickOneProviderPerDay(
      [{ date: "2026-06-15", source: "strava", value: 300 }],
      PROVIDER_PREFERENCE
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 300 }]);
  });

  it("sums multiple rows from the same chosen provider on a day", () => {
    const out = pickOneProviderPerDay(
      [
        { date: "2026-06-15", source: "strava", value: 300 },
        { date: "2026-06-15", source: "strava", value: 150 },
      ],
      PROVIDER_PREFERENCE
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 450 }]);
  });

  it("picks the largest single source when no preferred provider is present", () => {
    const out = pickOneProviderPerDay(
      [
        { date: "2026-06-15", source: "other-a", value: 100 },
        { date: "2026-06-15", source: "other-b", value: 250 },
      ],
      PROVIDER_PREFERENCE
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 250 }]);
  });

  it("handles independent days", () => {
    const out = pickOneProviderPerDay(
      [
        { date: "2026-06-15", source: "health-connect", value: 500 },
        { date: "2026-06-16", source: "strava", value: 200 },
      ],
      PROVIDER_PREFERENCE
    ).sort((a, b) => a.date.localeCompare(b.date));
    expect(out).toEqual([
      { date: "2026-06-15", value: 500 },
      { date: "2026-06-16", value: 200 },
    ]);
  });
});

describe("default provider preference", () => {
  it("prefers health-connect over strava", () => {
    expect(PROVIDER_PREFERENCE.indexOf("health-connect")).toBeLessThan(
      PROVIDER_PREFERENCE.indexOf("strava")
    );
  });

  it("prefers a manual entry over any provider, and health-connect over oura", () => {
    expect(PROVIDER_PREFERENCE.indexOf("manual")).toBe(0);
    expect(PROVIDER_PREFERENCE.indexOf("health-connect")).toBeLessThan(
      PROVIDER_PREFERENCE.indexOf("oura")
    );
  });
});

describe("pickOneProviderPerDay — issue #14 additions", () => {
  it("a per-profile primary source prepended to the preference wins the day", () => {
    const out = pickOneProviderPerDay(
      [
        { date: "2026-06-15", source: "oura", value: 300 },
        { date: "2026-06-15", source: "health-connect", value: 500 },
      ],
      ["oura", ...PROVIDER_PREFERENCE]
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 300 }]);
  });

  it("treats a NULL source as manual (which the defaults prefer)", () => {
    const out = pickOneProviderPerDay(
      [
        { date: "2026-06-15", source: null, value: 410 },
        { date: "2026-06-15", source: "health-connect", value: 500 },
      ],
      PROVIDER_PREFERENCE
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 410 }]);
  });
});

describe("pickRowsOneSourcePerDay", () => {
  interface Row {
    date: string;
    source: string | null;
    v: number;
  }
  const dateOf = (r: Row) => r.date;
  const sourceOf = (r: Row) => r.source;

  it("keeps only the preferred source's rows per day, preserving order", () => {
    const rows: Row[] = [
      { date: "2026-06-15", source: "oura", v: 1 },
      { date: "2026-06-15", source: "health-connect", v: 2 },
      { date: "2026-06-15", source: "health-connect", v: 3 },
      { date: "2026-06-16", source: "oura", v: 4 },
    ];
    expect(
      pickRowsOneSourcePerDay(rows, PROVIDER_PREFERENCE, dateOf, sourceOf)
    ).toEqual([
      { date: "2026-06-15", source: "health-connect", v: 2 },
      { date: "2026-06-15", source: "health-connect", v: 3 },
      { date: "2026-06-16", source: "oura", v: 4 }, // lone source passes through
    ]);
  });

  it("without a preference hit, keeps the source with the most weight", () => {
    const rows: Row[] = [
      { date: "2026-06-15", source: "vendor-a", v: 10 },
      { date: "2026-06-15", source: "vendor-b", v: 1 },
      { date: "2026-06-15", source: "vendor-b", v: 1 },
    ];
    expect(
      pickRowsOneSourcePerDay(rows, PROVIDER_PREFERENCE, dateOf, sourceOf)
    ).toEqual([
      { date: "2026-06-15", source: "vendor-b", v: 1 },
      { date: "2026-06-15", source: "vendor-b", v: 1 },
    ]);
    // Explicit weight function: vendor-a's single heavy row now wins.
    expect(
      pickRowsOneSourcePerDay(
        rows,
        PROVIDER_PREFERENCE,
        dateOf,
        sourceOf,
        (r) => r.v
      )
    ).toEqual([{ date: "2026-06-15", source: "vendor-a", v: 10 }]);
  });

  it("breaks exact ties deterministically (lexicographic)", () => {
    const rows: Row[] = [
      { date: "2026-06-15", source: "vendor-b", v: 1 },
      { date: "2026-06-15", source: "vendor-a", v: 1 },
    ];
    expect(
      pickRowsOneSourcePerDay(rows, PROVIDER_PREFERENCE, dateOf, sourceOf)
    ).toEqual([{ date: "2026-06-15", source: "vendor-a", v: 1 }]);
  });

  it("picks independently per day", () => {
    const rows: Row[] = [
      { date: "2026-06-15", source: "health-connect", v: 1 },
      { date: "2026-06-15", source: "oura", v: 2 },
      { date: "2026-06-16", source: "oura", v: 3 },
    ];
    expect(
      pickRowsOneSourcePerDay(rows, PROVIDER_PREFERENCE, dateOf, sourceOf)
    ).toEqual([
      { date: "2026-06-15", source: "health-connect", v: 1 },
      { date: "2026-06-16", source: "oura", v: 3 },
    ]);
  });
});
