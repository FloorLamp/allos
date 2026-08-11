import { db } from "../db";
import { SETTINGS_GROUPS, type SettingsGroupId } from "../settings-groups";
import {
  isTrainingRestricted,
  restrictedActivityTypeClause,
} from "../age-gate";
import { vaccineDisplayName } from "../immunization-catalog";
import {
  matchTier,
  rankAndGroup,
  flattenHits,
  type SearchGroup,
  type SearchHit,
} from "../search-rank";
import {
  extractQueryTerms,
  buildRetrievalSet,
  MAX_CITATIONS,
  type RecordCitation,
} from "../record-qa";
import type { SupplementKind } from "../types";
import { ENCOUNTER_REPRESENTATIVE_IDS } from "./medical";
import {
  CONDITION_REPRESENTATIVE_IDS,
  PROCEDURE_REPRESENTATIVE_IDS,
  FAMILY_HISTORY_REPRESENTATIVE_IDS,
  ALLERGY_REPRESENTATIVE_IDS,
} from "./clinical";
import {
  readingDetailHref,
  encounterHref,
  episodeHref,
  equipmentHref,
  immunizationHref,
  importHref,
  intakeHref,
  medicationHref,
  nutritionTabHref,
  protocolHref,
  providerHref,
  timelineDayHref,
  MEDICATIONS_HREF,
  type AppRoute,
} from "../hrefs";
import {
  medicationHitActions,
  appointmentHitActions,
  biomarkerHitActions,
} from "../hit-actions";
import { skinLesionDisplayLabel, skinLesionIdentityKey } from "../skin-lesion";
import {
  dentalHitText,
  episodeHitText,
  equipmentHitText,
  genomicHitText,
  imagingHitText,
  isoDay,
  likePattern,
  practiceHitText,
  protocolHitText,
  providerHitText,
  skinHitText,
} from "../search-projections";
import { getProviderRecordCounts } from "./providers";
import { getPracticeSearchRows } from "./wellness";
import type {
  DentalProcedure,
  GenomicVariant,
  ImagingStudy,
  SkinLesion,
} from "../types";
import { rideDetailHref } from "../ride-detail";

// Global (Cmd-K) search fan-out. One entry point, searchAll(),
// runs a small capped LIKE query per domain — each PROFILE-SCOPED (every
// statement filters profile_id, per the scoping rule) — collects the matches
// into a flat SearchHit[], and hands them to the pure ranker (lib/search-rank)
// for ordering/grouping. Read-only: results are navigation targets only.
//
// LIKE (not FTS5) by design: at personal-app scale an indexed substring scan is
// plenty. SQLite's built-in LIKE is case-insensitive for ASCII, so no COLLATE is
// needed. We over-fetch (CANDIDATE_LIMIT) per domain and let the ranker pick the
// best PER_DOMAIN_CAP, so an exact-but-older match isn't cut off by a date-only
// SQL LIMIT.
//
// HREF RULE (#1568): a hit's href is the most PRECISE destination its row data
// supports — the per-record page (biomarker/document/encounter/medication/vaccine,
// and since #1595 provider/episode/protocol/equipment) or a day/tab-scoped hub link
// (a non-ride activity's timeline day, the goals tab). A bare hub route is correct ONLY where
// no precise target exists: the passport list surfaces
// (condition/allergy/procedure/appointment/family-history/care plan/care goal) and
// the record surfaces added in #1595 that render no per-row anchor either (imaging,
// genomics, dental, skin, practices) land on their list/tab page until one exists.
// This is the class typed routes CANNOT catch — `/training` is a live pathname, just
// the wrong one — so it's pinned by data-level tests instead
// (lib/__db_tests__/search-hrefs.test.ts).

const PER_DOMAIN_CAP = 5;
const CANDIDATE_LIMIT = 25;

// Trim a stored datetime ("2026-07-06 12:00:00") down to its ISO date part for
// the recency tiebreak. Delegates to the pure projection helper so a hit's `date`
// and the date printed in its subtitle are trimmed by ONE function.
function isoDate(value: string | null): string | null {
  return isoDay(value);
}

function biomarkerHits(profileId: number, like: string): SearchHit[] {
  // One row per distinct canonical biomarker. Only canonical-named records are
  // returned because the detail page (/results/readings/view) resolves its series by
  // canonical_name alone — a raw, uncanonicalized name has no viewable
  // destination (the biomarkers list renders those as non-clickable text), so
  // surfacing it here would be a dead link. A query still matches on the raw
  // `name`, but the hit is shown/linked under its canonical identity.
  // MAX(date) with bare value/unit uses SQLite's documented min/max bare-column
  // rule: value/unit come from the latest-dated matching row.
  const rows = db
    .prepare(
      `SELECT canonical_name AS title, MAX(date) AS date, value, unit
         FROM medical_records
        WHERE profile_id = ?
          AND TRIM(COALESCE(canonical_name, '')) != ''
          AND (canonical_name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
        GROUP BY title COLLATE NOCASE
        ORDER BY date DESC
        LIMIT ?`
    )
    .all(profileId, like, like, CANDIDATE_LIMIT) as {
    title: string;
    date: string | null;
    value: string | null;
    unit: string | null;
  }[];
  return rows.map((r) => ({
    domain: "biomarker",
    key: `biomarker:${r.title.toLowerCase()}`,
    title: r.title,
    subtitle:
      [r.value, r.unit].filter(Boolean).join(" ").trim() || isoDate(r.date),
    href: readingDetailHref(r.title),
    date: isoDate(r.date),
    // "Add result" — navigate to the add form prefilled with this analyte (#662).
    actions: biomarkerHitActions(r.title),
  }));
}

function documentHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, filename, doc_type, source, document_date, uploaded_at
         FROM medical_documents
        WHERE profile_id = ?
          AND (filename LIKE ? ESCAPE '\\'
               OR patient_name LIKE ? ESCAPE '\\'
               OR doc_type LIKE ? ESCAPE '\\')
        ORDER BY COALESCE(document_date, uploaded_at) DESC
        LIMIT ?`
    )
    .all(profileId, like, like, like, CANDIDATE_LIMIT) as {
    id: number;
    filename: string;
    doc_type: string | null;
    source: string | null;
    document_date: string | null;
    uploaded_at: string;
  }[];
  return rows.map((r) => {
    // Mirror documentLabel(): lab/provider, else doc type, else filename.
    const title = r.source || r.doc_type || r.filename || "Document";
    const date = isoDate(r.document_date ?? r.uploaded_at);
    return {
      domain: "document",
      key: `document:${r.id}`,
      title,
      subtitle: title !== r.filename ? r.filename : (r.doc_type ?? date),
      href: importHref(r.id),
      date,
    };
  });
}

// For a restricted profile only the age-neutral duration activities (sport/cardio)
// that /training's RestrictedActivityView shows are searchable; strength (and
// goals, skipped entirely in searchAll) stay gated (#489/#618).
function activityHits(
  profileId: number,
  like: string,
  restricted: boolean
): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, title, type, date, components
         FROM activities
        WHERE profile_id = ?${restrictedActivityTypeClause(restricted)}
          AND (title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')
        ORDER BY date DESC
        LIMIT ?`
    )
    .all(profileId, like, like, CANDIDATE_LIMIT) as {
    id: number;
    title: string;
    type: string;
    date: string;
    components: string | null;
  }[];
  return rows.map((r) => ({
    domain: "activity",
    key: `activity:${r.id}`,
    title: r.title,
    subtitle: `${r.type[0].toUpperCase()}${r.type.slice(1)} · ${r.date}`,
    // A ride now has a guaranteed per-record detail. Other activities use their
    // DAY on the timeline (#1568), not the /training hub. A hub
    // href here was invisible as a bug: searching from /training — the natural
    // place to look for a workout — made the selection a same-route push, so the
    // palette closed and nothing moved, reading as a dead control.
    //
    // NOT the journal anchor (`#activity-<id>` in JournalCard): HistorySection
    // renders one newest window with "Load more" (#451), so an older activity's
    // anchor isn't on the page you land on. timelineDayHref filters the feed BY
    // the date, so it resolves for an activity of any age.
    href: rideDetailHref(r) ?? timelineDayHref(r.date),
    date: r.date,
  }));
}

function supplementHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, name, active, kind, quantity_on_hand
         FROM intake_items
        WHERE profile_id = ?
          AND (name LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')
        ORDER BY active DESC, name
        LIMIT ?`
    )
    .all(profileId, like, like, CANDIDATE_LIMIT) as {
    id: number;
    name: string;
    active: number;
    kind: SupplementKind;
    quantity_on_hand: number | null;
  }[];
  return rows.map((r) => ({
    domain: "supplement",
    key: `supplement:${r.id}`,
    title: r.name,
    subtitle: r.active ? "Active" : "Inactive",
    // A medication has a real per-record detail page (#817), so the hit lands ON
    // the med rather than the daily list (#1568). A supplement has no per-item
    // page — it keeps the kind-level surface intakeHref resolves (#746).
    href: r.kind === "medication" ? medicationHref(r.id) : intakeHref(r.kind),
    date: null,
    // Contextual actions on a FOUND medication (#662): log a dose, and refill when
    // it tracks supply. Supplements get none (issue-scoped to meds/appt/biomarker).
    ...(r.kind === "medication"
      ? {
          actions: medicationHitActions(r.id, r.quantity_on_hand != null),
        }
      : {}),
  }));
}

function immunizationHits(profileId: number, query: string): SearchHit[] {
  // Stored `vaccine` is a short catalog code (e.g. "influenza", "dtap"), so a
  // raw LIKE on it misses human queries. Pull the recent scoped set and filter
  // in JS on the human display name (+ notes). Immunization rows are few, so a
  // bounded recent fetch is fine.
  const rows = db
    .prepare(
      `SELECT id, vaccine, date, dose_label, notes
         FROM immunizations
        WHERE profile_id = ?
        ORDER BY date DESC
        LIMIT 200`
    )
    .all(profileId) as {
    id: number;
    vaccine: string;
    date: string;
    dose_label: string | null;
    notes: string | null;
  }[];
  return rows
    .map((r) => ({ r, display: vaccineDisplayName(r.vaccine) }))
    .filter(
      ({ r, display }) =>
        matchTier(display, query) > 0 ||
        (r.notes ? matchTier(r.notes, query) > 0 : false)
    )
    .map(({ r, display }) => ({
      domain: "immunization" as const,
      key: `immunization:${r.id}`,
      title: display,
      subtitle: r.dose_label ? `${r.dose_label} · ${r.date}` : r.date,
      // The per-vaccine page (#1568) — dose history, schedule assessment, titers
      // and overrides for THIS vaccine — instead of the immunizations list hub.
      href: immunizationHref(r.vaccine),
      date: r.date,
    }));
}

function goalHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, title, status, category
         FROM goals
        WHERE profile_id = ?
          AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .all(profileId, like, like, CANDIDATE_LIMIT) as {
    id: number;
    title: string;
    status: string;
    category: string | null;
  }[];
  return rows.map((r) => ({
    domain: "goal",
    key: `goal:${r.id}`,
    title: r.title,
    subtitle: r.category ? `${r.category} · ${r.status}` : r.status,
    // The Goals tab, not the Training hub's default Log tab (#1568) — `goals` is
    // the tab vocabulary's own id (lib/training-tabs.ts), the same deep link the
    // dashboard widget and the goal-pacing finding use.
    href: "/training?tab=goals",
    date: null,
  }));
}

// ── Clinical passport domains (#19) ──────────────────────────────────────────
// The passport tables were absent from the fan-out, so "penicillin" (an allergy)
// or a condition/procedure/visit name never surfaced in Cmd-K. Each helper below
// mirrors the existing per-domain pattern: a capped, PROFILE-SCOPED LIKE scan over
// the columns a user would search, mapped to a hit that links to the domain's list
// page (these passport surfaces are list pages, like /immunizations — there is no
// per-row detail route). Provider matches (encounters/appointments) LEFT JOIN the
// GLOBAL providers registry; the row itself is still scoped by its parent's
// profile_id, so the scoping rule holds.

function conditionHits(profileId: number, like: string): SearchHit[] {
  // De-duplicated across documents (#134): only representative rows, so two
  // overlapping CCDs collapse to ONE hit (its profile_id bind comes first).
  const rows = db
    .prepare(
      `SELECT id, name, status, onset_date
         FROM conditions
        WHERE profile_id = ?
          AND id IN (${CONDITION_REPRESENTATIVE_IDS})
          AND (name LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')
        ORDER BY COALESCE(onset_date, created_at) DESC
        LIMIT ?`
    )
    .all(profileId, profileId, like, like, CANDIDATE_LIMIT) as {
    id: number;
    name: string;
    status: string;
    onset_date: string | null;
  }[];
  return rows.map((r) => ({
    domain: "condition",
    key: `condition:${r.id}`,
    title: r.name,
    subtitle: r.onset_date
      ? `${r.status} · ${isoDate(r.onset_date)}`
      : r.status,
    href: "/records/problems/conditions",
    date: isoDate(r.onset_date),
  }));
}

// Documented, stored allergy records only. The derived-IgE allergies view
// (lib/allergy-ige.ts buildAllergiesView) re-runs a lab derivation the /allergies
// page renders, but running it per keystroke would be wasteful; those derived
// entries are surfaced on the allergies page itself. We match the substance AND
// the reaction text so "hives" finds the allergy it's a reaction to.
function allergyHits(profileId: number, like: string): SearchHit[] {
  // De-duplicated across documents (#134/#384/#617): representative rows only, so
  // the per-document duplicates two overlapping CCDs produce collapse to ONE hit,
  // matching the /allergies page and Timeline. Its profile_id bind comes first.
  const rows = db
    .prepare(
      `SELECT id, substance, reaction, severity, status, onset_date
         FROM allergies
        WHERE profile_id = ?
          AND id IN (${ALLERGY_REPRESENTATIVE_IDS})
          AND (substance LIKE ? ESCAPE '\\'
               OR reaction LIKE ? ESCAPE '\\'
               OR notes LIKE ? ESCAPE '\\')
        ORDER BY (status = 'active') DESC, substance
        LIMIT ?`
    )
    .all(profileId, profileId, like, like, like, CANDIDATE_LIMIT) as {
    id: number;
    substance: string;
    reaction: string | null;
    severity: string | null;
    status: string;
    onset_date: string | null;
  }[];
  return rows.map((r) => ({
    domain: "allergy",
    key: `allergy:${r.id}`,
    title: r.substance,
    subtitle:
      [r.reaction, r.severity].filter(Boolean).join(" · ").trim() || r.status,
    href: "/records/problems/allergies",
    date: isoDate(r.onset_date),
  }));
}

function procedureHits(profileId: number, like: string): SearchHit[] {
  // De-duplicated across documents (#134): representative rows only, so the
  // per-document duplicates two overlapping CCDs produce collapse to ONE hit.
  const rows = db
    .prepare(
      `SELECT id, name, code, date
         FROM procedures
        WHERE profile_id = ?
          AND id IN (${PROCEDURE_REPRESENTATIVE_IDS})
          AND (name LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')
        ORDER BY date DESC
        LIMIT ?`
    )
    .all(profileId, profileId, like, like, CANDIDATE_LIMIT) as {
    id: number;
    name: string;
    code: string | null;
    date: string | null;
  }[];
  return rows.map((r) => ({
    domain: "procedure",
    key: `procedure:${r.id}`,
    title: r.name,
    subtitle: isoDate(r.date) ?? r.code,
    href: "/records/history/procedures",
    date: isoDate(r.date),
  }));
}

function encounterHits(profileId: number, like: string): SearchHit[] {
  // Match the visit type/reason/diagnoses/notes and the attending provider's name.
  // Constrained to representative rows so the per-document duplicates two overlapping
  // CCDs produce collapse to ONE hit (its profile_id bind comes first).
  const rows = db
    .prepare(
      `SELECT e.id, e.type, e.reason, e.date, p.name AS provider
         FROM encounters e
         LEFT JOIN providers p ON p.id = e.provider_id
        WHERE e.profile_id = ?
          AND e.id IN (${ENCOUNTER_REPRESENTATIVE_IDS})
          AND (e.type LIKE ? ESCAPE '\\'
               OR e.reason LIKE ? ESCAPE '\\'
               OR e.diagnoses LIKE ? ESCAPE '\\'
               OR e.notes LIKE ? ESCAPE '\\'
               OR p.name LIKE ? ESCAPE '\\')
        ORDER BY e.date DESC
        LIMIT ?`
    )
    .all(
      profileId,
      profileId,
      like,
      like,
      like,
      like,
      like,
      CANDIDATE_LIMIT
    ) as {
    id: number;
    type: string | null;
    reason: string | null;
    date: string;
    provider: string | null;
  }[];
  return rows.map((r) => {
    const title = r.type || r.reason || "Visit";
    const subtitle =
      [title !== r.reason ? r.reason : null, r.provider, isoDate(r.date)]
        .filter(Boolean)
        .join(" · ") || null;
    return {
      domain: "encounter" as const,
      key: `encounter:${r.id}`,
      title,
      subtitle,
      href: encounterHref(r.id),
      date: isoDate(r.date),
    };
  });
}

function appointmentHits(profileId: number, like: string): SearchHit[] {
  // Match the appointment title/location/notes and the provider's name.
  const rows = db
    .prepare(
      `SELECT a.id, a.title, a.location, a.date, a.status, p.name AS provider
         FROM appointments a
         LEFT JOIN providers p ON p.id = a.provider_id
        WHERE a.profile_id = ?
          AND (a.title LIKE ? ESCAPE '\\'
               OR a.location LIKE ? ESCAPE '\\'
               OR a.notes LIKE ? ESCAPE '\\'
               OR p.name LIKE ? ESCAPE '\\')
        ORDER BY a.date DESC, a.time_of_day DESC
        LIMIT ?`
    )
    .all(profileId, like, like, like, like, CANDIDATE_LIMIT) as {
    id: number;
    title: string | null;
    location: string | null;
    date: string;
    status: string;
    provider: string | null;
  }[];
  return rows.map((r) => {
    const title = r.title || r.provider || "Appointment";
    const subtitle =
      [r.provider !== title ? r.provider : null, r.location, r.date]
        .filter(Boolean)
        .join(" · ") || r.status;
    return {
      domain: "appointment" as const,
      key: `appointment:${r.id}`,
      title,
      subtitle,
      href: "/records/history/visits",
      date: r.date,
      // "Mark complete" on a still-scheduled appointment (#662).
      actions: appointmentHitActions(r.id, r.status),
    };
  });
}

function familyHistoryHits(profileId: number, like: string): SearchHit[] {
  // De-duplicated across documents (#134): representative rows only, so the
  // per-document duplicates two overlapping CCDs produce collapse to ONE hit.
  const rows = db
    .prepare(
      `SELECT id, relation, condition
         FROM family_history
        WHERE profile_id = ?
          AND id IN (${FAMILY_HISTORY_REPRESENTATIVE_IDS})
          AND (condition LIKE ? ESCAPE '\\'
               OR relation LIKE ? ESCAPE '\\'
               OR notes LIKE ? ESCAPE '\\')
        ORDER BY condition
        LIMIT ?`
    )
    .all(profileId, profileId, like, like, like, CANDIDATE_LIMIT) as {
    id: number;
    relation: string | null;
    condition: string;
  }[];
  return rows.map((r) => ({
    domain: "family-history" as const,
    key: `family-history:${r.id}`,
    title: r.condition,
    subtitle: r.relation,
    href: "/records/care/overview",
    date: null,
  }));
}

function carePlanHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, description, category, status, planned_date
         FROM care_plan_items
        WHERE profile_id = ?
          AND (description LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')
        ORDER BY COALESCE(planned_date, created_at) DESC
        LIMIT ?`
    )
    .all(profileId, like, like, CANDIDATE_LIMIT) as {
    id: number;
    description: string;
    category: string | null;
    status: string | null;
    planned_date: string | null;
  }[];
  return rows.map((r) => ({
    domain: "care-plan" as const,
    key: `care-plan:${r.id}`,
    title: r.description,
    subtitle:
      [r.category, r.status, isoDate(r.planned_date)]
        .filter(Boolean)
        .join(" · ") || null,
    href: "/records/care/overview",
    date: isoDate(r.planned_date),
  }));
}

function careGoalHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, description, status, target_date
         FROM care_goals
        WHERE profile_id = ?
          AND (description LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')
        ORDER BY COALESCE(target_date, created_at) DESC
        LIMIT ?`
    )
    .all(profileId, like, like, CANDIDATE_LIMIT) as {
    id: number;
    description: string;
    status: string | null;
    target_date: string | null;
  }[];
  return rows.map((r) => ({
    domain: "care-goal" as const,
    key: `care-goal:${r.id}`,
    title: r.description,
    subtitle:
      [r.status, isoDate(r.target_date)].filter(Boolean).join(" · ") || null,
    href: "/records/care/overview",
    date: isoDate(r.target_date),
  }));
}

// ── Second-generation entity domains (#1595) ─────────────────────────────────
// Everything the app grew AFTER #19 closed the passport set: the provider directory
// (#1055), the specialty/result record types (imaging #702, genomics #709, dental
// #705, skin #715), illness episodes (#856), protocols (#344), wellness practices
// (#1591), and the equipment registry (#343). They were unsearchable — and because
// grounded record Q&A retrieves SOLELY through this fan-out (lib/record-qa.ts), a
// question like "when was her last MRI" or "which dentist did the crown" could not
// cite a row even with the data sitting in the table.
//
// Each helper keeps the established shape: one capped, PROFILE-SCOPED scan over the
// columns a person would type, projected through the domain's pure text function
// (lib/search-projections.ts) so the hit names the record exactly as its own page
// does. Hrefs follow the #1568 rule — the per-record route where one exists
// (provider / episode / protocol / equipment), the owning list surface where the
// domain renders no per-row anchor (imaging / genomics / dental / skin / practices).

// Providers the ACTIVE profile's records actually name (#1055). The registry is
// GLOBAL, so scope comes from the per-profile link counts (getProviderRecordCounts,
// itself profile-scoped) rather than from the providers table — searching the bare
// registry would surface clinicians this profile has never seen, which is noise in
// the palette and wrong in Q&A, where a citation must be one of the person's own
// records. Same-named providers are disambiguated in the label (#134/#617's lesson
// applied to a table whose collapse is an admin MERGE, not a read-time
// representative): the NPI, else the address's first line.
function providerHits(profileId: number, like: string): SearchHit[] {
  const counts = getProviderRecordCounts(profileId);
  if (counts.length === 0) return [];
  const records = new Map(counts.map((c) => [c.providerId, c.records]));
  const ids = [...records.keys()];
  const rows = db
    .prepare(
      `SELECT id, name, type, specialty, npi, address
         FROM providers
        WHERE id IN (${ids.map(() => "?").join(", ")})
          AND (name LIKE ? ESCAPE '\\'
               OR specialty LIKE ? ESCAPE '\\'
               OR npi LIKE ? ESCAPE '\\')
        ORDER BY name COLLATE NOCASE
        LIMIT ?`
    )
    .all(...ids, like, like, like, CANDIDATE_LIMIT) as {
    id: number;
    name: string;
    type: string | null;
    specialty: string | null;
    npi: string | null;
    address: string | null;
  }[];
  // Which matched names are shared by more than one provider — the labels those rows
  // need their distinguishing attribute on.
  const nameCounts = new Map<string, number>();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  return rows.map((r) => {
    const text = providerHitText(
      { ...r, recordCount: records.get(r.id) ?? 0 },
      { ambiguousName: (nameCounts.get(r.name.trim().toLowerCase()) ?? 0) > 1 }
    );
    return {
      domain: "provider" as const,
      key: `provider:${r.id}`,
      ...text,
      // The provider's registry detail page (#275) — its per-profile record listing,
      // relationship strip, and affiliations.
      href: providerHref(r.id),
      // A provider is an entity, not an event: undated, so it sorts by match quality
      // then name within its group.
      date: null,
    };
  });
}

// Imaging studies (#702). `modality` is stored as its enum code ("mri", "x-ray"), and
// LIKE is case-insensitive for ASCII, so a typed "MRI" reaches it directly.
function imagingHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, modality, body_region, laterality, study_date, impression, indication
         FROM imaging_studies
        WHERE profile_id = ?
          AND (modality LIKE ? ESCAPE '\\'
               OR body_region LIKE ? ESCAPE '\\'
               OR impression LIKE ? ESCAPE '\\'
               OR indication LIKE ? ESCAPE '\\'
               OR notes LIKE ? ESCAPE '\\')
        ORDER BY COALESCE(study_date, '') DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, like, like, like, like, like, CANDIDATE_LIMIT) as Pick<
    ImagingStudy,
    | "id"
    | "modality"
    | "body_region"
    | "laterality"
    | "study_date"
    | "impression"
    | "indication"
  >[];
  return rows.map((r) => ({
    domain: "imaging" as const,
    key: `imaging:${r.id}`,
    ...imagingHitText(r),
    // Results › Imaging renders the study list with no per-row anchor, so the tab
    // route is the most precise destination the row supports.
    href: "/results/imaging",
    date: isoDate(r.study_date),
  }));
}

// Genomic variants (#709). Matches the gene, the call (genotype/star allele), the
// variant id, the lab, and the report's own interpretation text.
function genomicHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, gene, variant, genotype, star_allele, zygosity, significance,
              result_type, source_lab, report_date
         FROM genomic_variants
        WHERE profile_id = ?
          AND (gene LIKE ? ESCAPE '\\'
               OR variant LIKE ? ESCAPE '\\'
               OR genotype LIKE ? ESCAPE '\\'
               OR star_allele LIKE ? ESCAPE '\\'
               OR interpretation LIKE ? ESCAPE '\\'
               OR source_lab LIKE ? ESCAPE '\\'
               OR notes LIKE ? ESCAPE '\\')
        ORDER BY COALESCE(report_date, '') DESC, id DESC
        LIMIT ?`
    )
    .all(
      profileId,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      CANDIDATE_LIMIT
    ) as Pick<
    GenomicVariant,
    | "id"
    | "gene"
    | "variant"
    | "genotype"
    | "star_allele"
    | "zygosity"
    | "significance"
    | "result_type"
    | "source_lab"
    | "report_date"
  >[];
  return rows.map((r) => ({
    domain: "genomic" as const,
    key: `genomic:${r.id}`,
    ...genomicHitText(r),
    href: "/results/genomics",
    date: isoDate(r.report_date),
  }));
}

// Dental procedures and findings (#705). The tooth designation is searchable as
// typed ("14" or "#14"), and the CDT code is matched for the people who know it.
function dentalHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, name, status, tooth, surface, procedure_date, finding
         FROM dental_procedures
        WHERE profile_id = ?
          AND (name LIKE ? ESCAPE '\\'
               OR tooth LIKE ? ESCAPE '\\'
               OR surface LIKE ? ESCAPE '\\'
               OR cdt_code LIKE ? ESCAPE '\\'
               OR finding LIKE ? ESCAPE '\\'
               OR notes LIKE ? ESCAPE '\\')
        ORDER BY COALESCE(procedure_date, '') DESC, id DESC
        LIMIT ?`
    )
    .all(
      profileId,
      like,
      like,
      like,
      like,
      like,
      like,
      CANDIDATE_LIMIT
    ) as Pick<
    DentalProcedure,
    | "id"
    | "name"
    | "status"
    | "tooth"
    | "surface"
    | "procedure_date"
    | "finding"
  >[];
  return rows.map((r) => ({
    domain: "dental" as const,
    key: `dental:${r.id}`,
    ...dentalHitText(r),
    href: "/records/specialty/dental",
    date: isoDate(r.procedure_date),
  }));
}

// Skin lesions (#715) — ONE hit per LESION, not per observation. Serial observations
// of the same mole share the #482 identity, and the Skin list groups them into a
// single card headed by the newest record; search collapses them identically, so a
// mole photographed five times is one result whose subtitle says so (that is #134's
// lesson in the shape this domain's read layer already defines).
//
// The scan is a bounded recent fetch filtered in JS (the immunizationHits pattern)
// rather than a LIKE in SQL: a group's observation count and its head record must be
// resolved over ALL of the lesion's rows, not only the rows that happened to match.
// Lesion rows are few, so a capped fetch is the honest cheap answer.
const SKIN_LESION_SCAN_LIMIT = 300;

function skinHits(profileId: number, query: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, label, body_region, body_side, size_mm, status,
              observed_date, finding, notes
         FROM skin_lesions
        WHERE profile_id = ?
        ORDER BY COALESCE(observed_date, '') DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, SKIN_LESION_SCAN_LIMIT) as (Pick<
    SkinLesion,
    | "id"
    | "label"
    | "body_region"
    | "body_side"
    | "size_mm"
    | "status"
    | "observed_date"
    | "finding"
    | "notes"
  > & { notes: string | null })[];

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = skinLesionIdentityKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const hits: SearchHit[] = [];
  for (const [identity, group] of groups) {
    // Rows arrive newest-first, so the first is the group head (as on the page).
    const head = group[0];
    const matched = group.some(
      (r) =>
        matchTier(skinLesionDisplayLabel(r), query) > 0 ||
        (r.finding ? matchTier(r.finding, query) > 0 : false) ||
        (r.notes ? matchTier(r.notes, query) > 0 : false) ||
        (r.body_region ? matchTier(r.body_region, query) > 0 : false)
    );
    if (!matched) continue;
    hits.push({
      domain: "skin",
      key: `skin:${identity}`,
      ...skinHitText(head, group.length),
      href: "/records/specialty/skin",
      date: isoDate(head.observed_date),
    });
  }
  return hits;
}

// Illness episodes (#856): the situation name, the user's note, and the outcome
// annotation are what someone types ("when was her flu?", "how did that cold go?").
function episodeHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, situation, start_date, end_date, outcome
         FROM illness_episodes
        WHERE profile_id = ?
          AND (situation LIKE ? ESCAPE '\\'
               OR note LIKE ? ESCAPE '\\'
               OR outcome LIKE ? ESCAPE '\\')
        ORDER BY COALESCE(start_date, '') DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, like, like, like, CANDIDATE_LIMIT) as {
    id: number;
    situation: string;
    start_date: string | null;
    end_date: string | null;
    outcome: string | null;
  }[];
  return rows.map((r) => ({
    domain: "episode" as const,
    key: `episode:${r.id}`,
    ...episodeHitText(r),
    // The episode detail page (#856) — its ledger, fever curve, and linked visits.
    href: episodeHref(r.id),
    date: isoDate(r.start_date),
  }));
}

// Protocols (#344): "what protocol was I running in March" — the name, the notes,
// and the situation the protocol activates.
function protocolHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, name, start_date, end_date, situation
         FROM protocols
        WHERE profile_id = ?
          AND (name LIKE ? ESCAPE '\\'
               OR notes LIKE ? ESCAPE '\\'
               OR situation LIKE ? ESCAPE '\\')
        ORDER BY (end_date IS NULL) DESC, start_date DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, like, like, like, CANDIDATE_LIMIT) as {
    id: number;
    name: string;
    start_date: string;
    end_date: string | null;
    situation: string | null;
  }[];
  return rows.map((r) => ({
    domain: "protocol" as const,
    key: `protocol:${r.id}`,
    ...protocolHitText(r),
    href: protocolHref(r.id),
    date: isoDate(r.start_date),
  }));
}

// Wellness practices (#1591/#1622). A practice is not a row but an IDENTITY over a
// weekly target and its logged sessions, so the reader folds spellings first
// (getPracticeSearchRows) and the query is matched against the resolved display name
// in JS — the same reason immunizations filter on their display name.
function practiceHits(profileId: number, query: string): SearchHit[] {
  return getPracticeSearchRows(profileId)
    .filter((row) => matchTier(row.name, query) > 0)
    .map((row) => ({
      domain: "practice" as const,
      key: `practice:${row.identity}`,
      ...practiceHitText(row),
      // The Wellness page renders one card per practice with no per-practice route.
      href: "/wellness",
      date: row.lastUsed,
    }));
}

// Equipment (#343). Retired gear stays searchable — it still labels historical sets,
// so "which bar did I PR on" has to resolve — and its hit says "Retired".
function equipmentHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, name, category, retired
         FROM equipment
        WHERE profile_id = ?
          AND (name LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')
        ORDER BY retired ASC, name COLLATE NOCASE
        LIMIT ?`
    )
    .all(profileId, like, like, CANDIDATE_LIMIT) as {
    id: number;
    name: string;
    category: string | null;
    retired: number;
  }[];
  return rows.map((r) => ({
    domain: "equipment" as const,
    key: `equipment:${r.id}`,
    ...equipmentHitText(r),
    href: equipmentHref(r.id),
    date: null,
  }));
}

// Extra search words per settings group — the terms people type that a one-sentence
// summary doesn't contain. Keyed by group id so a renamed group can't strand them.
const SETTINGS_SEARCH_KEYWORDS: Partial<Record<SettingsGroupId, string>> = {
  account: "password 2fa two-factor sessions sign out devices login security",
  display: "units kilograms pounds miles kilometers date time format 24h",
  health:
    "sex birthdate timezone week start photo name age home location skin type",
  training: "hr zones max heart rate zone 2 target",
  nutrition: "dietary preferences food groups exclude vegetarian",
  coaching: "recommendations cadence ai check-in scales anxiety mood",
  notifications:
    "notifications telegram web push home assistant reminders schedule channels quiet hours digest recap",
  privacy: "mental health sharing crisis resources",
};

// Static navigation destinations, so the palette doubles as a jump-to-page bar.
// `restricted` entries are hidden for age-restricted profiles (see age-gate.ts /
// Nav's RESTRICTED_HREFS).
const PAGES: {
  title: string;
  href: AppRoute;
  keywords?: string;
  restricted?: boolean;
}[] = [
  { title: "Dashboard", href: "/", keywords: "home overview" },
  {
    title: "Timeline",
    href: "/timeline",
    keywords: "history chronological events",
  },
  {
    title: "Trends",
    href: "/trends",
    keywords: "analytics charts biomarkers body fitness insights trends",
  },
  {
    title: "Upcoming",
    href: "/upcoming",
    keywords: "due soon reminders doses refills retests deadlines",
  },
  {
    title: "Training history",
    href: "/training?tab=log",
    restricted: true,
  },
  {
    // Not restricted: #489 un-gated the Training page for restricted profiles (it
    // renders RestrictedActivityView with sport/cardio logging), so its palette
    // entry must stay reachable (#618). The adult "Training history" tab below
    // stays restricted.
    title: "Training",
    href: "/training",
    keywords: "workouts strength cardio sport exercise lifts",
  },
  {
    title: "Body Metrics",
    href: "/trends#body",
    keywords: "weight body fat resting heart rate steps sleep",
  },
  {
    title: "Passport",
    href: "/profile",
    keywords: "health passport summary medical overview conditions medications",
  },
  {
    // The merged Results page (#1042 phase 5) — Biomarkers + Imaging + Genomics.
    title: "Results",
    href: "/results",
    keywords: "labs bloodwork biomarkers imaging radiology genomics variants",
  },
  {
    title: "Procedures",
    href: "/records/history/procedures",
    keywords: "surgery surgical operation procedure history cpt",
  },
  {
    title: "Family History",
    href: "/records/care/overview",
    keywords: "family history hereditary relatives genetic risk mother father",
  },
  {
    title: "Care Plan",
    href: "/records/care/overview",
    keywords: "care plan treatment planned orders upcoming procedures tests",
  },
  {
    title: "Health Goals",
    href: "/records/care/overview",
    keywords:
      "care goals clinical targets a1c blood pressure goal from records",
  },
  {
    title: "Supplements",
    href: nutritionTabHref("supplements"),
    keywords: "vitamins supplements stack nutrition medicine",
  },
  {
    title: "Medications",
    href: MEDICATIONS_HREF,
    keywords: "medications meds prescriptions rx drugs medicine",
  },
  {
    title: "Immunizations",
    href: "/records/history/immunizations",
    keywords: "vaccines shots",
  },
  {
    title: "Visits",
    href: "/records/history/visits",
    keywords:
      "visits encounters appointments doctor scheduled booking calendar history",
  },
  {
    title: "AI Insights",
    href: "/trends?tab=insights",
    keywords: "insights analysis coaching",
    restricted: true,
  },
  {
    // The single "Data" umbrella (import + manage/export folded into one hub at
    // /data). One palette entry covers both halves.
    title: "Data",
    href: "/data",
    keywords:
      "data import export manage upload download csv paste documents labs mychart patient portals integrations health connect strava garmin devices",
  },
  { title: "Settings", href: "/settings", keywords: "preferences" },
  // The per-group settings destinations come from the ONE settings registry (#1462)
  // rather than a hand-kept second list, so a new group is searchable the day it
  // ships. Admin-only groups stay out of the palette (a member must never be offered
  // a door that redirects them); the extra keywords below cover the words people
  // actually type, which the registry summaries alone don't.
  ...SETTINGS_GROUPS.filter((g) => !g.adminOnly).map((g) => ({
    title: `Settings: ${g.label}`,
    href: g.route,
    keywords: `${g.summary.toLowerCase()} ${SETTINGS_SEARCH_KEYWORDS[g.id] ?? ""}`,
  })),
  {
    // Person-level medical context moved off Settings → Profile (#928): smoking
    // history, health risk factors, and the emergency card.
    title: "Background",
    href: "/records/care/overview",
    keywords:
      "background smoking history pack years risk factors emergency card blood type contact",
  },
  {
    // Equipment moved out of Settings to the top-level /equipment registry (#343);
    // this is the one ungated, discoverable door to it (#592). Keywords span every
    // gear kind so "sauna"/"barbell"/"bike" all surface it.
    title: "Equipment",
    href: "/equipment",
    keywords:
      "equipment gear inventory registry plates barbell dumbbell kettlebell machine bike shoes sauna cold plunge red light massage recovery bar",
  },
];

function pageHits(query: string, restricted: boolean): SearchHit[] {
  const q = query.trim().toLowerCase();
  return PAGES.filter((p) => !(restricted && p.restricted))
    .filter(
      (p) =>
        matchTier(p.title, query) > 0 ||
        (p.keywords ? p.keywords.includes(q) : false)
    )
    .map((p) => ({
      domain: "page" as const,
      key: `page:${p.href}:${p.title}`,
      title: p.title,
      subtitle: null,
      href: p.href,
      date: null,
    }));
}

// Fan out across every domain for the active profile and return ranked, grouped
// results. profileId comes from the session's active profile (see the server
// action); an empty query yields no results.
export function searchAll(profileId: number, rawQuery: string): SearchGroup[] {
  // Cap length defensively: a search box never needs more, and it bounds the
  // LIKE pattern fed to every per-domain scan.
  const query = rawQuery.trim().slice(0, 100);
  if (query.length < 1) return [];
  const like = likePattern(query);
  const restricted = isTrainingRestricted(profileId);

  const hits: SearchHit[] = [
    ...biomarkerHits(profileId, like),
    ...imagingHits(profileId, like),
    ...genomicHits(profileId, like),
    ...documentHits(profileId, like),
    ...conditionHits(profileId, like),
    ...allergyHits(profileId, like),
    ...procedureHits(profileId, like),
    ...immunizationHits(profileId, query),
    ...encounterHits(profileId, like),
    ...appointmentHits(profileId, like),
    ...providerHits(profileId, like),
    ...episodeHits(profileId, like),
    ...dentalHits(profileId, like),
    ...skinHits(profileId, query),
    ...supplementHits(profileId, like),
    ...protocolHits(profileId, like),
    ...practiceHits(profileId, query),
    ...equipmentHits(profileId, like),
    ...familyHistoryHits(profileId, like),
    ...carePlanHits(profileId, like),
    ...careGoalHits(profileId, like),
    ...pageHits(query, restricted),
    // Type-aware (#489/#618): a restricted profile keeps sport/cardio activities
    // (the set /training still shows), so activityHits is always included but
    // filters to those types when restricted. Goals stay fully gated.
    ...activityHits(profileId, like, restricted),
  ];
  if (!restricted) {
    hits.push(...goalHits(profileId, like));
  }

  return rankAndGroup(hits, query, PER_DOMAIN_CAP);
}

// The DETERMINISTIC retrieval seam for grounded record Q&A (issue #878, Phase 2). Turn
// a natural-language question into a capped, numbered citation set for the ACTIVE
// profile — the model never touches the DB. Pure `extractQueryTerms` picks the salient
// search terms (plus their folded singulars, #1597, appended AFTER the asked-for terms
// so the fan-out below reaches them only when the terms themselves didn't fill the cap
// — `LIKE '%term%'` bridges singular→plural but not plural→singular); each runs the
// SAME profile-scoped `searchAll` fan-out every surface
// uses (so profile scoping is inherited, not re-implemented — no new `.prepare`); the
// per-term hits are unioned (de-duped by the hit's stable key), pages are dropped (they
// aren't records), and the pure `buildRetrievalSet` numbers the top MAX_CITATIONS.
// profileId comes from the session's active profile (see the server action) — the
// prompt built downstream carries ONLY these rows, so there is no cross-profile leak.
export function retrieveRecordCitations(
  profileId: number,
  question: string
): RecordCitation[] {
  const terms = extractQueryTerms(question);
  if (terms.length === 0) return [];
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const term of terms) {
    for (const hit of flattenHits(searchAll(profileId, term))) {
      // Pages are navigation targets, not the person's records — never a citation.
      if (hit.domain === "page") continue;
      if (seen.has(hit.key)) continue;
      seen.add(hit.key);
      hits.push(hit);
    }
    // Enough candidates gathered — the ranker already ordered each term's hits, so
    // stop fanning out once we can fill the cap.
    if (hits.length >= MAX_CITATIONS) break;
  }
  return buildRetrievalSet(hits);
}
