// RECORDS-RECENCY asks as Upcoming items (#2164 + #2176) — the DB half of
// lib/records-recency.ts.
//
// TWO LEGS, ONE GATHER. The archive leg (#2164) and the manual-upload leg (#2176) are
// the same question about two different person-operated sources, so they are two
// ADAPTERS over one pure decision (`recordsRecencyVerdict`) and one identity
// (`recordsRecencyDedupeKey`), distinguished by what they read as a frontier and what
// they declare as a horizon — never by two copies of a staleness rule.
//
// EVERY READ HERE IS A `date` COLUMN. That is the whole discipline (#2164 constraint 3,
// #2176's #557/#283 rule): the archive frontier is the newest archive-SOURCED DATA
// date, never the sync event's stamp, and the clinical frontier is the newest
// COLLECTION date, never `created_at` / `uploaded_at`. Importing a stale archive today
// or backfilling a decade of old results this afternoon moves neither frontier, and
// neither silences the ask.
//
// REACH: this list and nothing else. Joining `rawUpcoming` is deliberate and is the
// entire feature — the morning digest's Today section is a formatter over the SAME set,
// so the item and its digest line share one dedupe key and one dismissal (#221), and
// neither leg needs a send of its own. It is deliberately NOT joined to
// `getIntegrationAttention`, which feeds the hero and Data → Review's escalated card:
// that list is for a connection that is BROKEN, and a household being asked to download
// an export is not a fault to repair.

import { cache } from "../../request-cache";
import { db, hoistedStatement } from "../../db";
import type { UpcomingItem } from "../../upcoming";
import type { ArchiveStreamSelector } from "../../types";
import {
  archiveRecencySource,
  archiveRefreshCopy,
  clinicalRecencyCopy,
  clinicalRecencyHorizonDays,
  recencyIntervalPhrase,
  recordsRecencyDedupeKey,
  recordsRecencyVerdict,
} from "../../records-recency";
import { archiveRefreshProviders } from "../../integrations/archive-refresh";
import { integrationDetailHref, dataSectionHref } from "../../hrefs";
import { profileAgeMonths } from "../../settings";

// ── Frontier reads ───────────────────────────────────────────────────────────

// One prepared statement per DECLARED selector shape. The registry's selector is a
// discriminated union with a closed column set, so nothing here interpolates a value
// that came from data — the declaration picks a statement, it never builds SQL.
const BODY_METRIC_FRONTIER = {
  weight_kg: hoistedStatement(
    `SELECT MAX(date) AS d FROM body_metrics
      WHERE profile_id = ? AND source = ? AND weight_kg IS NOT NULL`
  ),
  body_fat_pct: hoistedStatement(
    `SELECT MAX(date) AS d FROM body_metrics
      WHERE profile_id = ? AND source = ? AND body_fat_pct IS NOT NULL`
  ),
} as const;

const METRIC_SAMPLE_FRONTIER = hoistedStatement(
  `SELECT MAX(date) AS d FROM metric_samples
    WHERE profile_id = ? AND source = ? AND metric = ?`
);

function streamFrontier(
  profileId: number,
  provider: string,
  selector: ArchiveStreamSelector
): string | null {
  const row =
    selector.table === "body_metrics"
      ? (BODY_METRIC_FRONTIER[selector.column].get(profileId, provider) as {
          d: string | null;
        })
      : (METRIC_SAMPLE_FRONTIER.get(profileId, provider, selector.metric) as {
          d: string | null;
        });
  return row.d ?? null;
}

/**
 * The newest date any of a provider's ARCHIVE-EXCLUSIVE streams carries, plus the
 * labels of the streams that have actually delivered something.
 *
 * MAX across the streams, not MIN, and deliberately: the question is "how fresh is the
 * last download", and one stream the household stopped feeding (a scale that broke, a
 * band worn only at night) must not be able to raise a permanent ask about all of them.
 *
 * The labels are the DELIVERING streams only, so a profile that never owned the scale
 * is told about its sleep score rather than about a weight it has never recorded.
 */
export function archiveExclusiveFrontier(
  profileId: number,
  provider: string,
  selectors: readonly { label: string; selector: ArchiveStreamSelector }[]
): { frontier: string | null; labels: string[] } {
  let frontier: string | null = null;
  const labels: string[] = [];
  for (const s of selectors) {
    const d = streamFrontier(profileId, provider, s.selector);
    if (!d) continue;
    labels.push(s.label);
    if (!frontier || d > frontier) frontier = d;
  }
  return { frontier, labels };
}

// The record categories that make up the CLINICAL FRONTIER (#2176). `lab` plus the
// legacy `biomarker` bucket — the same pair the canonical-flag reconciler, the
// qualitative-results read and the onboarding census use for "a biomarker reading on
// file", so this ask ages against exactly the rows the biomarker surfaces render.
// Imaging, dental and instrument records are deliberately OUT: #2176 constraint 2 keeps
// v1 to one profile-level ask on the lab/biomarker frontier, because those domains have
// different clinical rhythms and a per-domain matrix is where this becomes nagging.
const CLINICAL_FRONTIER_STMT = hoistedStatement(
  `SELECT MAX(date) AS d FROM medical_records
    WHERE profile_id = ? AND category IN ('lab','biomarker')`
);

/** The newest lab/biomarker COLLECTION date on file, or null when there is none. */
export function clinicalFrontier(profileId: number): string | null {
  return (
    (CLINICAL_FRONTIER_STMT.get(profileId) as { d: string | null }).d ?? null
  );
}

// ── The one-ask-per-problem exemption ────────────────────────────────────────

const MAPPED_PORTAL_STMT = hoistedStatement(
  `SELECT 1 FROM portal_identities
    WHERE profile_id = ? AND ignored = 0 LIMIT 1`
);

/**
 * Does #1757's machinery already own this profile's records-recency ask?
 *
 * The condition is a BOUND, non-ignored portal identity — precisely the state that
 * makes a portal sync request reachable for this profile: `isStalenessDue` refuses to
 * raise one without a mapped patient, and `syncRequestCarrierProfiles` routes the ask
 * to the profiles bound under the login. So a profile that satisfies this is one whose
 * stale records ALREADY have an ask with a better answer attached (run the tool and the
 * records arrive), and a second ask about the same gap would be noise.
 *
 * Note the deliberate silence in the corner case: a profile mapped to a portal whose
 * tool has never run gets neither ask, because #1757's setup carve-out (#2010) holds it
 * back too. That is right — installing the tool is a setup step the portal card asks for
 * in its own words, and it belongs to onboarding (#2173), not to staleness.
 */
export function portalOwnsRecordsAsk(profileId: number): boolean {
  return MAPPED_PORTAL_STMT.get(profileId) != null;
}

// ── The items ────────────────────────────────────────────────────────────────

/**
 * The archive refresh ask (#2164) — one item per archive provider that declares
 * exclusive streams and whose newest such data has aged past the declared horizon.
 *
 * No `ownedElsewhere` input: nothing else in the app can bring these streams in, which
 * is the entire premise of the facet. A provider the profile has never imported has no
 * frontier and is exempt by the shared `no-frontier` guard.
 */
export function archiveRefreshItems(
  profileId: number,
  today: string
): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  for (const p of archiveRefreshProviders()) {
    const { frontier, labels } = archiveExclusiveFrontier(
      profileId,
      p.provider,
      p.facet.streams
    );
    const verdict = recordsRecencyVerdict({
      frontier,
      today,
      horizonDays: p.facet.horizonDays,
      ownedElsewhere: false,
    });
    if (!verdict.due || labels.length === 0) continue;
    const copy = archiveRefreshCopy({
      providerName: p.providerName,
      streamLabels: labels,
      frontier: verdict.frontier,
      daysBehind: verdict.daysBehind,
    });
    const href = integrationDetailHref(p.provider);
    if (!href) continue;
    items.push({
      key: recordsRecencyDedupeKey(
        archiveRecencySource(p.provider),
        verdict.frontier
      ),
      domain: "records-recency",
      title: copy.title,
      detail: copy.detail,
      because: copy.because,
      href,
      // NO DEADLINE, so no due date to invent. An archive refresh is an errand with no
      // day on which it stops mattering — the opposite of #1757's request, which
      // expires. `band: "week"` files it calmly in "This week" instead of letting a
      // null due date band it as "Today" forever.
      dueDate: null,
      band: "week",
      dueText: `${recencyIntervalPhrase(verdict.daysBehind)} behind`,
      suppressible: true,
    });
  }
  return items;
}

/**
 * The manual-upload records ask (#2176) — one item per profile, on the lab/biomarker
 * frontier, for a household with no portal whose #1757 machinery already owns the ask.
 */
export function clinicalRecencyItems(
  profileId: number,
  today: string
): UpcomingItem[] {
  const verdict = recordsRecencyVerdict({
    frontier: clinicalFrontier(profileId),
    today,
    // The horizon reads the PREVENTIVE catalog's routine check-up cadence for this
    // profile's age (#2176 constraint 3) — reuse, not a fork, so a pediatric profile
    // ages against the well-child rhythm rather than the adult default.
    horizonDays: clinicalRecencyHorizonDays(profileAgeMonths(profileId, today)),
    ownedElsewhere: portalOwnsRecordsAsk(profileId),
  });
  if (!verdict.due) return [];
  const copy = clinicalRecencyCopy({
    frontier: verdict.frontier,
    daysBehind: verdict.daysBehind,
  });
  return [
    {
      key: recordsRecencyDedupeKey("clinical-records", verdict.frontier),
      domain: "records-recency",
      title: copy.title,
      detail: copy.detail,
      because: copy.because,
      // BOTH deep links (#2176): the upload flow as the row's own destination, and the
      // portal connect flow beside it — connecting a portal is the better fix and
      // retires this ask permanently for the profile (through `portalOwnsRecordsAsk`
      // above, not through any stored state).
      href: dataSectionHref("import"),
      altAction: {
        href: "/integrations/patient-portals",
        label: "Connect a portal",
        testId: "records-recency-portal-link",
      },
      dueDate: null,
      band: "week",
      dueText: `${recencyIntervalPhrase(verdict.daysBehind)} old`,
      suppressible: true,
    },
  ];
}

/**
 * Both legs, for one profile. The single entry point `rawUpcoming` calls, memoized per
 * request like its siblings.
 */
export const recordsRecencyItems = cache(
  (profileId: number, today: string): UpcomingItem[] => [
    ...archiveRefreshItems(profileId, today),
    ...clinicalRecencyItems(profileId, today),
  ]
);
