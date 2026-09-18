// PURE TIER — the sleeping breathing rate is NOT the clinical respiratory rate (#5409).
//
// THE DEFECT THIS GUARDS AGAINST IS A SHORTCUT, not an omission. Registering the
// wearable's nightly stream under canonical `Respiratory Rate` would have been one line
// shorter and would have granted an overnight average the 12-20 band curated for a spot
// count taken while awake — a healthy adult's 13.6 is ordinary, and so is a 21, and the
// band would have called the second one abnormal every time it happened.
//
// So the assertions below are stated from BOTH ends, because only one of them can fail
// if the shortcut is ever taken:
//
//   * the clinical identity still resolves the band (the shortcut does not break this);
//   * the nightly identity resolves NO band, through every door that reaches one.
//
// All fixtures come from the committed canonical dataset; no DB, no network.

import { describe, expect, it } from "vitest";
import {
  METRIC_KNOWLEDGE,
  metricJudgment,
  quantityKnowledge,
} from "@/lib/metric-judgment";
import {
  BREATHING_RATE_CANONICAL,
  BREATHING_RATE_METRIC,
  CLINICAL_RESPIRATORY_CANONICAL,
  WEARABLE_RESPIRATORY_SOURCES,
  breathingRateSourceRank,
  isWearableRespiratorySource,
  mainSessionForDay,
  sessionForStamp,
  type BreathingRateSession,
} from "@/lib/breathing-rate";
import { readingIdentity, streamSourcesForIdentity } from "@/lib/reading-model";
import { STREAM_READING_SOURCES } from "@/lib/reading-identity-map";
import { continuousReadingSlug } from "@/lib/reading-cadence";

describe("two quantities, and the clinical band reaches only one", () => {
  it("still judges a clinical respiratory rate at 12-20", () => {
    // The control in the other direction: if this goes red, the split took the band
    // away from the quantity that is supposed to keep it.
    expect(
      metricJudgment(readingIdentity(CLINICAL_RESPIRATORY_CANONICAL), {
        value: 16,
      })
    ).toMatchObject({ low: 12, high: 20, badge: "optimal" });
    expect(
      metricJudgment(readingIdentity(CLINICAL_RESPIRATORY_CANONICAL), {
        value: 26,
      })?.badge
    ).toBe("high");
  });

  it("never judges the nightly reading against that band", () => {
    const judgment = metricJudgment(
      readingIdentity(BREATHING_RATE_CANONICAL),
      // A value the clinical band would call LOW. A sleeping adult at 11.4 is having an
      // ordinary night; there is nothing here to call it anything.
      { value: 11.4 }
    );
    expect(judgment?.low ?? null).toBeNull();
    expect(judgment?.high ?? null).toBeNull();
    expect(judgment?.badge ?? "unknown").toBe("unknown");
  });

  it("declares WHY it has no band, rather than inheriting silence", () => {
    const knowledge = quantityKnowledge(BREATHING_RATE_CANONICAL);
    expect(knowledge?.source).toBe("none");
    expect(knowledge?.source === "none" ? knowledge.reason : "").toMatch(
      /12-20/
    );
  });

  it("keeps the two identities apart, so neither can resolve the other", () => {
    expect(readingIdentity(BREATHING_RATE_CANONICAL)).not.toBe(
      readingIdentity(CLINICAL_RESPIRATORY_CANONICAL)
    );
    // The clinical name reaches NO stream: a `Respiratory Rate` observation is an
    // observation, and the fold that would have put nightly rows on its chart cannot
    // find them.
    expect(
      streamSourcesForIdentity(readingIdentity(CLINICAL_RESPIRATORY_CANONICAL))
    ).toEqual([]);
    // ...and the nightly name reaches exactly one, the sample store.
    expect(
      streamSourcesForIdentity(readingIdentity(BREATHING_RATE_CANONICAL))
    ).toEqual([
      {
        store: "metric_samples",
        key: BREATHING_RATE_METRIC,
        canonical: BREATHING_RATE_CANONICAL,
        unit: "breaths/min",
      },
    ]);
  });

  it("routes `respiratory-rate` at the CLINICAL identity, unchanged", () => {
    // #5409 explicitly leaves this slug where it was: the nightly quantity got its OWN
    // surface, and the thing this pins is that it never borrowed this one.
    expect(METRIC_KNOWLEDGE["respiratory-rate"]).toEqual({
      source: "canonical",
      canonical: CLINICAL_RESPIRATORY_CANONICAL,
    });
    expect(continuousReadingSlug(CLINICAL_RESPIRATORY_CANONICAL)).toBe(
      "respiratory-rate"
    );
    // The nightly identity routes to its own surface — a DIFFERENT slug, asserted as a
    // difference rather than as two literals, so renaming either one cannot make the
    // two silently converge.
    expect(continuousReadingSlug(BREATHING_RATE_CANONICAL)).toBe(
      "breathing-rate"
    );
    expect(continuousReadingSlug(BREATHING_RATE_CANONICAL)).not.toBe(
      continuousReadingSlug(CLINICAL_RESPIRATORY_CANONICAL)
    );
    // And the surface brings no band with it: `none` is what makes the clinical 12–20
    // unreachable from the nightly reading, because a `none` entry names no canonical
    // entry for a range to be looked up through.
    expect(METRIC_KNOWLEDGE["breathing-rate"].source).toBe("none");
    expect(
      STREAM_READING_SOURCES.find((s) => s.key === BREATHING_RATE_METRIC)
        ?.canonical
    ).toBe(BREATHING_RATE_CANONICAL);
  });
});

describe("the source decides, not the analyte name", () => {
  it("counts the two wearable integrations and nothing else", () => {
    for (const source of WEARABLE_RESPIRATORY_SOURCES)
      expect(isWearableRespiratorySource(source)).toBe(true);
    // Every way a CLINICAL respiratory rate reaches the record.
    for (const source of [
      "manual",
      "document:17",
      "document:health-connect",
      "withings",
      "oura",
      "strava",
      null,
      undefined,
      "",
      // A prefix must not be enough: the test that would pass on `startsWith` fails here.
      "health-connect-legacy",
      "fitbit-takeout:2026",
    ])
      expect(isWearableRespiratorySource(source), `${source}`).toBe(false);
  });
});

describe("which night a stamp belongs to", () => {
  const session = (
    startedAt: string,
    endedAt: string,
    wakeDay: string,
    origin: string | null = "com.fitbit.FitbitMobile"
  ): BreathingRateSession => ({
    startedAt,
    endedAt,
    startMs: Date.parse(startedAt),
    endMs: Date.parse(endedAt),
    wakeDay,
    origin,
  });
  const NIGHT = session(
    "2026-09-05T02:52:00Z",
    "2026-09-05T08:53:00Z",
    "2026-09-05"
  );
  const FITBIT = "com.fitbit.FitbitMobile";

  it("claims a stamp ON the session end — the exporter's ordinary case", () => {
    expect(
      sessionForStamp(Date.parse("2026-09-05T08:53:00Z"), FITBIT, [NIGHT])
    ).toBe(NIGHT);
  });

  it("claims a stamp INSIDE it — what an extended log leaves behind", () => {
    expect(
      sessionForStamp(Date.parse("2026-09-05T05:56:00Z"), FITBIT, [NIGHT])
    ).toBe(NIGHT);
  });

  it("claims nothing outside it, however close", () => {
    expect(
      sessionForStamp(Date.parse("2026-09-05T08:53:01Z"), FITBIT, [NIGHT])
    ).toBeUndefined();
    expect(
      sessionForStamp(Date.parse("2026-09-05T02:51:59Z"), FITBIT, [NIGHT])
    ).toBeUndefined();
  });

  it("refuses another package's session", () => {
    expect(
      sessionForStamp(
        Date.parse("2026-09-05T08:53:00Z"),
        "com.garmin.android.apps.connectmobile",
        [NIGHT]
      )
    ).toBeUndefined();
    // Two unstated origins are one exporter's silence, not two devices.
    expect(
      sessionForStamp(Date.parse("2026-09-05T08:53:00Z"), null, [
        session(
          "2026-09-05T02:52:00Z",
          "2026-09-05T08:53:00Z",
          "2026-09-05",
          null
        ),
      ])
    ).toBeDefined();
  });

  it("takes the NIGHT over a nap nested inside it", () => {
    const nap = session(
      "2026-09-05T05:00:00Z",
      "2026-09-05T06:00:00Z",
      "2026-09-05"
    );
    expect(
      sessionForStamp(Date.parse("2026-09-05T05:56:00Z"), FITBIT, [nap, NIGHT])
    ).toBe(NIGHT);
  });

  it("gives a day label that day's MAIN session, and no other day's", () => {
    const nap = session(
      "2026-09-05T13:00:00Z",
      "2026-09-05T13:40:00Z",
      "2026-09-05"
    );
    expect(mainSessionForDay("2026-09-05", [nap, NIGHT])).toBe(NIGHT);
    expect(mainSessionForDay("2026-09-04", [nap, NIGHT])).toBeUndefined();
  });
});

describe("which reading a night with two sources shows", () => {
  it("prefers the real window over a day label", () => {
    expect(breathingRateSourceRank("health-connect")).toBeLessThan(
      breathingRateSourceRank("fitbit-takeout")
    );
    // An unknown source ranks last rather than throwing.
    expect(breathingRateSourceRank("some-future-wearable")).toBeGreaterThan(
      breathingRateSourceRank("fitbit-takeout")
    );
    expect(breathingRateSourceRank(null)).toBeGreaterThan(
      breathingRateSourceRank("fitbit-takeout")
    );
  });
});
