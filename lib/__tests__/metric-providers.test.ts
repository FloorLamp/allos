import { describe, expect, it } from "vitest";
import {
  pickOneProviderPerDay,
  PROVIDER_PREFERENCE,
} from "@/lib/metric-providers";

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

describe("MULTI_PROVIDER metric list", () => {
  it("prefers health-connect over strava", () => {
    expect(PROVIDER_PREFERENCE.indexOf("health-connect")).toBeLessThan(
      PROVIDER_PREFERENCE.indexOf("strava")
    );
  });
});
