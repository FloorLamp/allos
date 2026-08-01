// The query boundary for the ranked ProviderCombobox rows (#1677). It resolves this
// profile's own dated provider links ONCE and hands them to the pure ranker
// (lib/provider-rank.ts), so a family's PCP leads the picker instead of "Aaronson".
//
// The `providers` registry itself is shared across profiles, so nothing here changes
// membership or the alphabetical fallback — only the order a given profile sees.

import { db, today } from "../db";
import { getPickerProviders } from "../providers-db";
import {
  rankedSpecialtyOptions,
  rankProvidersByUse,
  type ProviderUse,
} from "../provider-rank";
import type { Provider } from "../types";

// Every dated link from a profile-owned record to a provider, as one flat list. Each
// table contributes its own date column; the two-provider tables (an encounter's
// performer + location, an imaging study's ordering + reading radiologist) contribute
// both links, because seeing a clinician in either role is seeing them. Rows with no
// provider or no date are dropped by the WHERE clauses — an undated row can't be
// recency-weighted, and counting it as "today" would be the raw-recency jitter the
// rank-core discipline (#1490) exists to avoid.
function providerUses(profileId: number): ProviderUse[] {
  return db
    .prepare(
      `SELECT provider_id AS providerId, date FROM encounters
         WHERE profile_id = ? AND provider_id IS NOT NULL AND date IS NOT NULL
       UNION ALL
       SELECT location_provider_id, date FROM encounters
         WHERE profile_id = ? AND location_provider_id IS NOT NULL
           AND date IS NOT NULL
       UNION ALL
       SELECT provider_id, date FROM medical_records
         WHERE profile_id = ? AND provider_id IS NOT NULL AND date IS NOT NULL
       UNION ALL
       SELECT provider_id, date FROM immunizations
         WHERE profile_id = ? AND provider_id IS NOT NULL AND date IS NOT NULL
       UNION ALL
       SELECT provider_id, date FROM procedures
         WHERE profile_id = ? AND provider_id IS NOT NULL AND date IS NOT NULL
       UNION ALL
       SELECT provider_id, planned_date FROM care_plan_items
         WHERE profile_id = ? AND provider_id IS NOT NULL
           AND planned_date IS NOT NULL
       UNION ALL
       SELECT provider_id, substr(scheduled_at, 1, 10) FROM appointments
         WHERE profile_id = ? AND provider_id IS NOT NULL
       UNION ALL
       SELECT ordering_provider_id, study_date FROM imaging_studies
         WHERE profile_id = ? AND ordering_provider_id IS NOT NULL
           AND study_date IS NOT NULL
       UNION ALL
       SELECT reading_provider_id, study_date FROM imaging_studies
         WHERE profile_id = ? AND reading_provider_id IS NOT NULL
           AND study_date IS NOT NULL
       UNION ALL
       SELECT provider_id, issued_date FROM optical_prescriptions
         WHERE profile_id = ? AND provider_id IS NOT NULL
           AND issued_date IS NOT NULL
       UNION ALL
       SELECT provider_id, procedure_date FROM dental_procedures
         WHERE profile_id = ? AND provider_id IS NOT NULL
           AND procedure_date IS NOT NULL
       UNION ALL
       SELECT provider_id, observed_date FROM skin_lesions
         WHERE profile_id = ? AND provider_id IS NOT NULL
           AND observed_date IS NOT NULL
       UNION ALL
       SELECT provider_id, substr(created_at, 1, 10) FROM intake_items
         WHERE profile_id = ? AND provider_id IS NOT NULL`
    )
    .all(...(Array(13).fill(profileId) as number[]))
    .map((r) => r as ProviderUse)
    .filter((u) => !!u.date);
}

// The ProviderCombobox rows for one profile, most-relevant first (#1677). Same rows
// `getPickerProviders()` offers (archived still excluded), reordered by recency-decayed
// use across every provider-bearing domain; a profile with no links gets the
// alphabetical list back unchanged.
export function getRankedPickerProviders(profileId: number): Provider[] {
  return rankProvidersByUse(
    getPickerProviders(),
    providerUses(profileId),
    today(profileId)
  );
}

// The specialty picker order for one profile (#1677): the specialties its own providers
// already carry lead, then the curated common head, then the rest of the NUCC labels
// A–Z. Only providers this profile actually links to count, so a shared registry full
// of other households' specialists doesn't decide this person's picker.
export function getRankedSpecialtyOptions(profileId: number): string[] {
  const linked = new Set(providerUses(profileId).map((u) => u.providerId));
  const used = getPickerProviders()
    .filter((p) => linked.has(p.id) && p.specialty)
    .map((p) => p.specialty as string);
  return rankedSpecialtyOptions(used);
}
