// The pediatric blood-pressure interpretation (#150), gathered once for whichever
// surface renders a BP reading.
//
// A child's blood pressure is judged by the AAP 2017 age/sex/height percentile, not
// the adult 90–120 / 60–80 cutoffs — which call an elevated child reading fine. That
// judgement needs four inputs from three different stores (the reading, the subject's
// sex, their age ON the reading date, and their height percentile), so it lived
// inline on the reading detail page. #1932 moved blood pressure to the metric detail
// surface, where it renders as the continuous trend it is; this module is the
// gathering that travelled with it, so the card is a call rather than a second copy
// of the four lookups.
//
// Auth-blind and profile-scoped like every reader here: `profileId` first, no
// lib/auth import.

import { getLatestMetricSample } from "@/lib/queries/metrics";
import { getUserAgeOn, getUserBirthdate, getUserSex } from "@/lib/settings";
import { ageInMonthsFromBirthdate } from "@/lib/date";
import { measurementPercentile } from "@/lib/growth";
import {
  bpComponentFor,
  pediatricBpContext,
  type PediatricBpContext,
} from "@/lib/bp-percentiles";
import type { Sex } from "@/lib/types";

// The profile's latest height as a growth-chart percentile (WHO/CDC LMS). Null when
// sex/height/birthdate is missing — pediatricBpContext then assumes the 50th height
// percentile.
function latestHeightPercentile(
  profileId: number,
  sex: Sex | null
): number | null {
  if (sex !== "male" && sex !== "female") return null;
  const h = getLatestMetricSample(profileId, "height_cm");
  if (!h) return null;
  const birthdate = getUserBirthdate(profileId);
  const months = birthdate ? ageInMonthsFromBirthdate(birthdate, h.date) : null;
  if (months == null) return null;
  return (
    measurementPercentile(sex, months, "height", h.value)?.percentile ?? null
  );
}

/**
 * The pediatric BP percentile + AAP category for one reading, or `null` when the
 * interpretation does not apply: a non-BP canonical name, no reading, or an adult
 * subject (pediatricBpContext itself returns null past the pediatric age ceiling).
 *
 * `value` is the reading in the canonical unit (mmHg); `onDate` is the reading's
 * date, because the subject's age is taken ON the collection date, never today.
 */
export function pediatricBpContextFor(
  profileId: number,
  canonicalName: string,
  value: number | null,
  onDate: string | null
): PediatricBpContext | null {
  const component = bpComponentFor(canonicalName);
  if (!component || value == null) return null;
  const sex = getUserSex(profileId);
  return pediatricBpContext(component, value, {
    sex,
    ageYears: getUserAgeOn(profileId, onDate),
    heightPercentile: latestHeightPercentile(profileId, sex),
  });
}
