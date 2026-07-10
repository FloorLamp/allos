import { db } from "../db";
import { isTrainingRestricted } from "../age-gate";
import { vaccineDisplayName } from "../immunization-catalog";
import {
  matchTier,
  rankAndGroup,
  type SearchGroup,
  type SearchHit,
} from "../search-rank";
import { ENCOUNTER_REPRESENTATIVE_IDS } from "./medical";
import {
  CONDITION_REPRESENTATIVE_IDS,
  PROCEDURE_REPRESENTATIVE_IDS,
  FAMILY_HISTORY_REPRESENTATIVE_IDS,
} from "./clinical";

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

const PER_DOMAIN_CAP = 5;
const CANDIDATE_LIMIT = 25;

// Escape LIKE wildcards so a literal % or _ (or \) in the query matches itself,
// then wrap for a substring match. Paired with `ESCAPE '\'` in the SQL.
function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (c) => "\\" + c);
  return `%${escaped}%`;
}

// Trim a stored datetime ("2026-07-06 12:00:00") down to its ISO date part for
// the recency tiebreak.
function isoDate(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

function biomarkerHits(profileId: number, like: string): SearchHit[] {
  // One row per distinct canonical biomarker. Only canonical-named records are
  // returned because the detail page (/biomarkers/view) resolves its series by
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
    href: `/biomarkers/view?name=${encodeURIComponent(r.title)}`,
    date: isoDate(r.date),
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
      href: `/import/${r.id}`,
      date,
    };
  });
}

function activityHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, title, type, date
         FROM activities
        WHERE profile_id = ?
          AND (title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')
        ORDER BY date DESC
        LIMIT ?`
    )
    .all(profileId, like, like, CANDIDATE_LIMIT) as {
    id: number;
    title: string;
    type: string;
    date: string;
  }[];
  return rows.map((r) => ({
    domain: "activity",
    key: `activity:${r.id}`,
    title: r.title,
    subtitle: `${r.type[0].toUpperCase()}${r.type.slice(1)} · ${r.date}`,
    href: "/training",
    date: r.date,
  }));
}

function supplementHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, name, active
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
  }[];
  return rows.map((r) => ({
    domain: "supplement",
    key: `supplement:${r.id}`,
    title: r.name,
    subtitle: r.active ? "Active" : "Inactive",
    href: "/medicine",
    date: null,
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
      href: "/immunizations",
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
    href: "/training",
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
    href: "/conditions",
    date: isoDate(r.onset_date),
  }));
}

// Documented, stored allergy records only. The derived-IgE allergies view
// (lib/allergy-ige.ts buildAllergiesView) re-runs a lab derivation the /allergies
// page renders, but running it per keystroke would be wasteful; those derived
// entries are surfaced on the allergies page itself. We match the substance AND
// the reaction text so "hives" finds the allergy it's a reaction to.
function allergyHits(profileId: number, like: string): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, substance, reaction, severity, status, onset_date
         FROM allergies
        WHERE profile_id = ?
          AND (substance LIKE ? ESCAPE '\\'
               OR reaction LIKE ? ESCAPE '\\'
               OR notes LIKE ? ESCAPE '\\')
        ORDER BY (status = 'active') DESC, substance
        LIMIT ?`
    )
    .all(profileId, like, like, like, CANDIDATE_LIMIT) as {
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
    href: "/allergies",
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
    href: "/procedures",
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
      href: `/encounters/${r.id}`,
      date: isoDate(r.date),
    };
  });
}

function appointmentHits(profileId: number, like: string): SearchHit[] {
  // Match the appointment title/location/notes and the provider's name.
  const rows = db
    .prepare(
      `SELECT a.id, a.title, a.location, a.scheduled_at, a.status, p.name AS provider
         FROM appointments a
         LEFT JOIN providers p ON p.id = a.provider_id
        WHERE a.profile_id = ?
          AND (a.title LIKE ? ESCAPE '\\'
               OR a.location LIKE ? ESCAPE '\\'
               OR a.notes LIKE ? ESCAPE '\\'
               OR p.name LIKE ? ESCAPE '\\')
        ORDER BY a.scheduled_at DESC
        LIMIT ?`
    )
    .all(profileId, like, like, like, like, CANDIDATE_LIMIT) as {
    id: number;
    title: string | null;
    location: string | null;
    scheduled_at: string;
    status: string;
    provider: string | null;
  }[];
  return rows.map((r) => {
    const title = r.title || r.provider || "Appointment";
    const subtitle =
      [
        r.provider !== title ? r.provider : null,
        r.location,
        isoDate(r.scheduled_at),
      ]
        .filter(Boolean)
        .join(" · ") || r.status;
    return {
      domain: "appointment" as const,
      key: `appointment:${r.id}`,
      title,
      subtitle,
      href: "/appointments",
      date: isoDate(r.scheduled_at),
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
    href: "/family-history",
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
    href: "/care-plan",
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
    href: "/care-goals",
    date: isoDate(r.target_date),
  }));
}

// Static navigation destinations, so the palette doubles as a jump-to-page bar.
// `restricted` entries are hidden for age-restricted profiles (see age-gate.ts /
// Nav's RESTRICTED_HREFS).
const PAGES: {
  title: string;
  href: string;
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
    title: "Training",
    href: "/training",
    keywords: "workouts strength cardio sport exercise lifts",
    restricted: true,
  },
  {
    title: "Body Metrics",
    href: "/trends?tab=body",
    keywords: "weight body fat resting heart rate steps sleep",
  },
  {
    title: "Passport",
    href: "/profile",
    keywords: "health passport summary medical overview conditions medications",
  },
  { title: "Biomarkers", href: "/biomarkers", keywords: "labs bloodwork" },
  {
    title: "Procedures",
    href: "/procedures",
    keywords: "surgery surgical operation procedure history cpt",
  },
  {
    title: "Family History",
    href: "/family-history",
    keywords: "family history hereditary relatives genetic risk mother father",
  },
  {
    title: "Care Plan",
    href: "/care-plan",
    keywords: "care plan treatment planned orders upcoming procedures tests",
  },
  {
    title: "Health Goals",
    href: "/care-goals",
    keywords:
      "care goals clinical targets a1c blood pressure goal from records",
  },
  {
    title: "Supplements & Medications",
    href: "/medicine",
    keywords: "vitamins medications meds prescriptions medicine",
  },
  {
    title: "Immunizations",
    href: "/immunizations",
    keywords: "vaccines shots",
  },
  {
    title: "Appointments",
    href: "/appointments",
    keywords: "visits doctor scheduled booking calendar",
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
      "data import export manage upload download csv paste documents labs mychart integrations health connect strava garmin devices",
  },
  { title: "Settings", href: "/settings", keywords: "preferences" },
  {
    title: "Settings: Profile",
    href: "/settings/profile",
    keywords: "sex birthdate timezone notifications telegram",
  },
  {
    title: "Settings: Equipment",
    href: "/settings/equipment",
    keywords: "plates barbell dumbbell",
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
    ...documentHits(profileId, like),
    ...conditionHits(profileId, like),
    ...allergyHits(profileId, like),
    ...procedureHits(profileId, like),
    ...immunizationHits(profileId, query),
    ...encounterHits(profileId, like),
    ...appointmentHits(profileId, like),
    ...supplementHits(profileId, like),
    ...familyHistoryHits(profileId, like),
    ...carePlanHits(profileId, like),
    ...careGoalHits(profileId, like),
    ...pageHits(query, restricted),
  ];
  // Training history/goals live behind the age-gated Training page; skip their
  // links for restricted profiles, matching Nav.
  if (!restricted) {
    hits.push(...activityHits(profileId, like), ...goalHits(profileId, like));
  }

  return rankAndGroup(hits, query, PER_DOMAIN_CAP);
}
