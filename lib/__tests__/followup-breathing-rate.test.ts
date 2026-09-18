import { describe, it, expect } from "vitest";
import {
  breathingRateFollowUpAdapter,
  breathingRateSourceLabel,
  breathingRateResolvingLabel,
  findResolvingBreathingRateNight,
  BREATHING_RATE_FOLLOWUP_KIND,
  type BreathingRateFollowUpSample,
} from "@/lib/followup-breathing-rate";
import { BREATHING_RATE_METRIC } from "@/lib/breathing-rate";

function night(
  p: Partial<BreathingRateFollowUpSample>
): BreathingRateFollowUpSample {
  return {
    id: 1,
    date: "2026-09-05",
    metric: BREATHING_RATE_METRIC,
    value: 13.6,
    ...p,
  };
}

const followUp = {
  id: 1,
  title: "Recheck breathing rate",
  plannedDate: "2026-12-04",
  recommendedIntervalDays: 90,
  source: { kind: BREATHING_RATE_FOLLOWUP_KIND, recordId: 1 },
  resolution: null,
};

describe("breathing-rate follow-up adapter (#5409)", () => {
  it("states the value in the one spelling every breathing-rate surface uses", () => {
    expect(breathingRateSourceLabel(night({}))).toBe(
      "flagged 13.6 br/min (2026-09)"
    );
    // No trailing zero, the same rule formatBreathingRate applies everywhere else.
    expect(breathingRateSourceLabel(night({ value: 14 }))).toBe(
      "flagged 14 br/min (2026-09)"
    );
    expect(breathingRateResolvingLabel(night({ date: "2026-12-06" }))).toBe(
      "13.6 br/min · 2026-12-06"
    );
  });

  it("names the reading, not the canonical analyte", () => {
    // "Recheck Breathing Rate (sleep)" is the canonical name, and it reads as a form
    // field; this is the title the carried follow-up already had.
    expect(breathingRateFollowUpAdapter.followUpTitle(night({}))).toBe(
      "Recheck breathing rate"
    );
    expect(breathingRateFollowUpAdapter.kind).toBe("breathing-rate");
  });

  it("resolves on a LATER night of the same metric, most recent first", () => {
    const source = night({ id: 1, date: "2026-09-05" });
    const earlier = night({ id: 2, date: "2026-09-04" });
    const later = night({ id: 3, date: "2026-11-02", value: 12.8 });
    const latest = night({ id: 4, date: "2026-12-06", value: 12.4 });
    expect(
      findResolvingBreathingRateNight(source, followUp, [
        source,
        earlier,
        later,
        latest,
      ])
    ).toBe(latest);
    // Nothing later has landed: the follow-up is still open, never self-resolving.
    expect(
      findResolvingBreathingRateNight(source, followUp, [source, earlier])
    ).toBeNull();
  });

  it("never resolves across metrics", () => {
    // The column pair is general over `metric_samples`; the adapter is not. A later
    // HRV night is not a repeat of a breathing rate.
    const source = night({ id: 1 });
    const other = night({ id: 2, date: "2026-11-02", metric: "hrv_ms" });
    expect(
      findResolvingBreathingRateNight(source, followUp, [source, other])
    ).toBeNull();
  });

  it("states a night with no value as the date alone rather than inventing one", () => {
    expect(breathingRateResolvingLabel(night({ value: null }))).toBe(
      "2026-09-05"
    );
    expect(breathingRateSourceLabel(night({ value: null }))).toBe(
      "flagged breathing rate (2026-09)"
    );
  });
});
