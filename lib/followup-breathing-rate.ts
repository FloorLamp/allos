// The BREATHING-RATE domain adapter for the finding → follow-up → resolution chain
// (issue #5409) — the fifth adapter, and the first whose source reading is a
// `metric_samples` row rather than a clinical record. PURE: it reasons over nightly
// sample shapes, no DB/network, and it answers the same domain questions the imaging,
// labs, IOP, dental and skin adapters answer.
//
// WHY IT EXISTS. #5409 moves a wearable breathing rate out of `medical_records` and
// into the sleep-window stream where it belongs. A person who had tapped "Track
// follow-up" on one of those readings has a `care_plan_items` row naming it, and the
// owner's 2026-09-11 ruling says such a link is CARRIED rather than orphaned — so the
// adoption re-points it at the night's sample (`source_metric_sample_id`, migration
// 20260916-care-plan-metric-sample-links) and re-stamps its `source_kind` to this
// adapter's. Without an adapter the carried row would still be in the care plan, but it
// would have stopped being a follow-up — "the link survived and the loop did not" is
// the degradation carrying exists to avoid.
//
// THE KIND IS THE DOMAIN; THE COLUMN PAIR IS NOT. `labs` and `iop` already share
// `source_medical_record_id` with two different kinds, because the discriminator names
// WHICH adapter reads the row, not which table it points at. The metric-sample pair is
// general over `metric_samples`, and this adapter claims exactly one metric on it — the
// nightly breathing rate — so its copy can say "br/min" and its resolution rule can
// mean "a later night". A second metric wanting the loop adds its own kind beside this
// one and reuses the same columns, which is what the fourth pair already demonstrates.
//
// RESOLUTION: A LATER NIGHT. The clinical adapters match by #482 biomarker family
// because a repeat draw can be spelled a dozen ways. A nightly sample has no such
// problem: the stream is one metric with one canonical spelling, so the later reading
// of the same metric IS the repeat, and the most recent one wins.

import { formatBreathingRate } from "./breathing-rate";
import type { FollowUpAdapter, FollowUpItemLike } from "./followup";

// The breathing-rate source kind stored in care_plan_items.source_kind.
export const BREATHING_RATE_FOLLOWUP_KIND = "breathing-rate";

// The narrow nightly-sample shape the adapter reasons over: the row's identity, the
// wake day it is stated on, its metric and its value. `date` is NOT NULL in
// `metric_samples`, which is what lets candidates order.
export interface BreathingRateFollowUpSample {
  id: number;
  date: string;
  metric: string;
  value: number | null;
}

// YYYY-MM of a night (for the compact "(2026-09)" reason tail).
function nightMonth(sample: BreathingRateFollowUpSample): string {
  return sample.date ? sample.date.slice(0, 7) : "";
}

// A compact value label ("13.6 br/min"), in the ONE spelling every breathing-rate
// surface uses (#221) — the hero, the record's Sleep row and the chart all read
// formatBreathingRate, and so does this.
export function breathingRateValueLabel(
  sample: BreathingRateFollowUpSample
): string {
  return formatBreathingRate(sample.value) ?? "";
}

// The "for the …" reason line ("flagged 13.6 br/min (2026-09)"). Names the value and
// the month, so the follow-up says WHY it exists.
export function breathingRateSourceLabel(
  sample: BreathingRateFollowUpSample
): string {
  const value = breathingRateValueLabel(sample) || "breathing rate";
  const month = nightMonth(sample);
  return month ? `flagged ${value} (${month})` : `flagged ${value}`;
}

// A short label for a resolving night ("13.6 br/min · 2026-09-14").
export function breathingRateResolvingLabel(
  sample: BreathingRateFollowUpSample
): string {
  const value = breathingRateValueLabel(sample);
  return value ? `${value} · ${sample.date}` : sample.date;
}

// The later night that resolves a follow-up for `source`, or null when none has
// landed. A candidate qualifies when it is a DIFFERENT reading of the SAME metric
// whose date is STRICTLY AFTER the source's. The most recent qualifying night wins.
// Confirm-first: returning a candidate only OFFERS the resolution.
export function findResolvingBreathingRateNight(
  source: BreathingRateFollowUpSample,
  _followUp: FollowUpItemLike,
  candidates: readonly BreathingRateFollowUpSample[]
): BreathingRateFollowUpSample | null {
  if (!source.date) return null;
  let best: BreathingRateFollowUpSample | null = null;
  for (const c of candidates) {
    if (c.id === source.id) continue;
    if (c.metric !== source.metric) continue;
    if (!c.date || c.date <= source.date) continue;
    if (!best || c.date > best.date || (c.date === best.date && c.id > best.id))
      best = c;
  }
  return best;
}

export const breathingRateFollowUpAdapter: FollowUpAdapter<
  BreathingRateFollowUpSample,
  BreathingRateFollowUpSample
> = {
  kind: BREATHING_RATE_FOLLOWUP_KIND,
  describeSource: breathingRateSourceLabel,
  // The noun is the reading, not the analyte name: the stream's canonical name is
  // "Breathing Rate (sleep)" and "Recheck Breathing Rate (sleep)" reads as a form
  // field. This is the title the carried follow-up already had.
  followUpTitle: () => "Recheck breathing rate",
  findResolvingRecord: findResolvingBreathingRateNight,
  describeResolvingRecord: breathingRateResolvingLabel,
};
