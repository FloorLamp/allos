// DB INTEGRATION TIER — a `category = 'vitals'` row reaching the surface #1932
// routes it to, with the shape that surface renders.
//
// The pure tier (lib/__tests__/reading-cadence.test.ts) pins WHICH readings are
// continuous. This pins that the destination is real: for every continuous reading,
// the metric-detail kind it names actually stores that canonical name, charts those
// rows, and lists them in its readings table — so routing can never trade one wrong
// page for a dead end. Then it walks one seeded Oxygen Saturation reading (the
// reported case) from `medical_records` to that page's three inputs.
//
// All fixtures SYNTHETIC.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  CONTINUOUS_READING_METRIC,
  continuousReadingSlug,
} from "@/lib/reading-cadence";
import { readingDetailHref } from "@/lib/hrefs";
import {
  TREND_METRIC_SLUGS,
  trendMetricPeriodStats,
} from "@/lib/trend-metrics";
import { METRIC_READING_STORE, getMetricReadings } from "@/lib/metric-readings";
import { placeReading } from "@/lib/reading-placement";
import { metricObservationFoldIdentity } from "@/lib/metric-judgment";
import { fullTrendMetricSeries } from "@/lib/trend-metric-series";
import { getPanelSiblings } from "@/lib/queries/panel-siblings";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

function addVital(
  canonical: string,
  unit: string,
  date: string,
  value: number
) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num)
     VALUES (?, ?, 'vitals', ?, ?, ?, ?, ?)`
  ).run(p.profileId, date, canonical, String(value), unit, canonical, value);
}

beforeAll(() => {
  p = seedProfile("VITALS-SURFACE");
  const d = (n: number) => shiftDateStr(p.todayStr, n);
  // The reported history shape: one old imported reading and a run of recent daily
  // ones — the spread that made the lab page's whole-history spline draw a
  // trajectory through years where nothing was measured.
  addVital("Oxygen Saturation", "%", d(-2900), 96);
  for (let i = 5; i >= 1; i--)
    addVital("Oxygen Saturation", "%", d(-i), 96 + i);
  // A panel sibling, so the cross-reference card has something to point at.
  addVital("Blood Pressure Systolic", "mmHg", d(-1), 118);
});

describe("every continuous reading has a real metric-detail destination", () => {
  it.each(Object.entries(CONTINUOUS_READING_METRIC))(
    "%s renders through /trends/metric/%s",
    (canonical, slug) => {
      // A registered kind…
      expect(TREND_METRIC_SLUGS).toContain(slug);
      // …whose readings store holds readings of THIS IDENTITY. Generalized in #2032
      // from "this canonical name in medical_records": with the write path routing by
      // row rather than by slug, a destination whose own store is the identity's
      // registered STREAM (resting heart rate → body_metrics.resting_hr) both charts
      // the identity's clinical observations, through the #1996 fold, and corrects
      // them. What must still hold is that the page's store is a store OF THE SAME
      // QUANTITY — one identity per destination, never a dead end.
      expect(METRIC_READING_STORE[slug]).toEqual(
        placeReading({ name: canonical }).placed
      );
      // …and the fold is what supplies the other store's rows on a stream destination,
      // so no reading of the identity is stranded off the page it routes to.
      const observationsFold =
        metricObservationFoldIdentity(slug) != null ||
        METRIC_READING_STORE[slug]?.table === "medical_records";
      expect(observationsFold).toBe(true);
    }
  );
});

describe("a category='vitals' reading reaches the metric detail surface", () => {
  it("routes there from the link helper every call site uses", () => {
    const row = db
      .prepare(
        `SELECT canonical_name, name, category FROM medical_records
          WHERE profile_id = ? AND canonical_name = 'Oxygen Saturation'
          ORDER BY date DESC LIMIT 1`
      )
      .get(p.profileId) as {
      canonical_name: string;
      name: string;
      category: string;
    };
    expect(row.category).toBe("vitals");
    expect(readingDetailHref(row.canonical_name, row.name)).toBe(
      "/trends/metric/spo2"
    );
  });

  it("charts the stored rows as that page's series", () => {
    const slug = continuousReadingSlug("Oxygen Saturation");
    expect(slug).toBe("spo2");
    const series = fullTrendMetricSeries("spo2", p.profileId, "kg", p.todayStr);
    expect(series.map((s) => s.value)).toEqual([96, 101, 100, 99, 98, 97]);
    // Oldest first, so the page's "Latest" is the most recent daily reading, not
    // the eight-year-old import.
    expect(series[series.length - 1].value).toBe(97);
  });

  it("lists the same rows in that page's readings table", () => {
    const readings = getMetricReadings(p.profileId, "spo2");
    expect(readings).toHaveLength(6);
    // Newest first, each carrying the id the row actions edit and delete by.
    expect(readings[0].value).toBe(97);
    for (const r of readings) expect(r.id).toBeGreaterThan(0);
  });

  it("summarizes the recent readings rather than the whole history", () => {
    const series = fullTrendMetricSeries("spo2", p.profileId, "kg", p.todayStr);
    const stats = trendMetricPeriodStats(series, p.todayStr, 0);
    // The trailing windows all hold the same five daily readings here, so they
    // collapse into one card — over the five, not the eight-year span. This is the
    // cadence-appropriate read the lab page could not give the metric.
    expect(stats[0].windows).toContain(7);
    expect(stats[0].count).toBe(5);
    expect(stats[0].avg).toBe(99);
  });

  it("keeps the panel cross-reference across the cadence split", () => {
    const siblings = getPanelSiblings(p.profileId, "Oxygen Saturation");
    expect(siblings?.panelId).toBe("vital-signs");
    expect(siblings?.names).toContain("Blood Pressure Systolic");
    // …and each chip lands on ITS own surface.
    expect(readingDetailHref("Blood Pressure Systolic")).toBe(
      "/trends/metric/systolic"
    );
  });
});
