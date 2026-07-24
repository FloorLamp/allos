// Set-based cross-profile flat-list readers (#1328 — the Tier-1 multi-view fan-out).
//
// The FIRST registered cross-profile SQL module (lib/cross-profile.ts): the Tier-1
// lists whose per-profile reader is TRULY FLAT — no representative-id dedup CTE, no
// per-profile `today()`/age derivation — read the whole view-set in ONE query with a
// bound `profile_id IN (…)` tuple instead of looping the per-profile reader. Health
// goals (care_goals), Genomics (genomic_variants), and Imaging (imaging_studies) are
// each a durable dated fact read straight from the table, so a set-based read is exact
// and cannot mis-collapse rows across members.
//
// The id list MUST originate from a resolved ProfileScope (`scope.viewIds` ⊆
// `scope.ids`, already ∩ the caller's grants) — never a raw request value. Each row is
// tagged with `profileId` (the SQL `profile_id AS profileId`) so stampSubjects can
// attach subject identity, matching the shape readForProfiles produces for the
// loop-composed lists. A single-profile view (`ids = [acting]`) yields exactly the
// per-profile reader's rows in the same order, so the page renders byte-identical.
//
// Registered in CROSS_PROFILE_SQL_MODULES so the profile-scoping scanner permits the
// `profile_id IN` shape HERE and nowhere else — the reviewed-registry rule (#1095 §3).

import { db } from "@/lib/db";
import { profileIdsIn } from "@/lib/cross-profile";
import type { CareGoal, GenomicVariant, ImagingStudy } from "@/lib/types";

type WithProfile<T> = T & { profileId: number };

// Care goals across the view-set (soonest target date first, undated last) — the
// set-based twin of getCareGoals. Matches its ORDER BY exactly so a single-view read
// is byte-identical; in multi-view the members interleave by target date.
export function getCareGoalsForProfiles(
  ids: readonly number[]
): WithProfile<CareGoal>[] {
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT *, profile_id AS profileId FROM care_goals
        WHERE profile_id IN ${profileIdsIn(ids)}
        ORDER BY (target_date IS NULL) ASC, target_date ASC,
                 description COLLATE NOCASE ASC, id DESC`
    )
    .all(...ids) as WithProfile<CareGoal>[];
}

// Genomic variants across the view-set (newest report first) — the set-based twin of
// getGenomicVariants, same column set + ORDER BY.
export function getGenomicVariantsForProfiles(
  ids: readonly number[]
): WithProfile<GenomicVariant>[] {
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT id, gene, variant, genotype, star_allele, zygosity, significance,
              result_type, interpretation, source_lab, report_date, notes,
              source, document_id, external_id, created_at,
              profile_id AS profileId
         FROM genomic_variants
        WHERE profile_id IN ${profileIdsIn(ids)}
        ORDER BY COALESCE(report_date, '') DESC, gene COLLATE NOCASE ASC, id DESC`
    )
    .all(...ids) as WithProfile<GenomicVariant>[];
}

// Imaging studies across the view-set (newest study first) — the set-based twin of
// getImagingStudies, same column set + ORDER BY. `contrast` is stored 0/1 and surfaced
// as a boolean, exactly as the per-profile reader does.
export function getImagingStudiesForProfiles(
  ids: readonly number[]
): WithProfile<ImagingStudy>[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, modality, body_region, laterality, contrast, contrast_agent,
              study_date, dose_msv, impression, indication, status,
              ordering_provider_id, reading_provider_id,
              (SELECT p.name FROM providers p WHERE p.id = imaging_studies.ordering_provider_id)
                AS ordering_provider_name,
              (SELECT p.name FROM providers p WHERE p.id = imaging_studies.reading_provider_id)
                AS reading_provider_name,
              notes, source, document_id, external_id, created_at,
              profile_id AS profileId
         FROM imaging_studies
        WHERE profile_id IN ${profileIdsIn(ids)}
        ORDER BY COALESCE(study_date, '') DESC, id DESC`
    )
    .all(...ids) as (Omit<WithProfile<ImagingStudy>, "contrast"> & {
    contrast: number;
  })[];
  return rows.map((r) => ({ ...r, contrast: r.contrast === 1 }));
}
