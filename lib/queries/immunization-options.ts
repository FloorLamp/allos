// The query boundary for the age-aware vaccine picker options (#1677). It assembles
// the SAME `assessSchedule()` inputs the immunizations surfaces already use — the
// profile's doses, its age (birthdate first, stored whole-year age as the documented
// #310 fallback), sex, immunity titers, and manual overrides — and hands the resulting
// statuses to the pure ranker (lib/immunization-rank.ts).
//
// One question, one computation: the picker's order comes from the same status engine
// that draws the schedule grid, so the form can never suggest a vaccine the grid calls
// age-inappropriate.

import { today } from "../db";
import { ageMonthsFrom } from "../date";
import { assessSchedule } from "../immunization-status";
import { rankedVaccineOptions } from "../immunization-rank";
import { getProfileBirthdate, getProfileSex, getStoredAge } from "../settings";
import {
  getImmunizations,
  getImmunityTiters,
  getImmunizationOverrides,
} from "./medical/immunizations";

// The vaccine picker order for one profile (#1677): the plausible next doses lead,
// finished and out-of-window vaccines sink, ACIP order breaks ties. Same membership as
// `PICKER_NAMES`; every vaccine stays reachable by search.
export function getRankedVaccineOptions(profileId: number): string[] {
  const now = today(profileId);
  const ageMonths = ageMonthsFrom(
    getProfileBirthdate(profileId),
    getStoredAge(profileId),
    now
  );
  const summary = assessSchedule(
    getImmunizations(profileId).map((r) => ({
      vaccine: r.vaccine,
      date: r.date,
    })),
    ageMonths,
    getProfileSex(profileId),
    now,
    getImmunityTiters(profileId).map((t) => ({
      marker: t.marker,
      status: t.status,
    })),
    getImmunizationOverrides(profileId).map((o) => ({
      vaccine: o.vaccine,
      kind: o.kind,
    }))
  );
  return rankedVaccineOptions(
    summary.assessments.map((a) => ({ code: a.code, status: a.status }))
  );
}
