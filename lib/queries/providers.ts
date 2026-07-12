import { db } from "../db";
import { encounterHref, type AppRoute } from "../hrefs";

// PER-PROFILE activity reads for the provider detail/index pages (issue #275).
//
// The providers registry itself is GLOBAL (a family shares one "Quest
// Diagnostics"), but everything a provider page shows BELOW the identity card is
// scoped to the ACTIVE profile: a member must never learn which OTHER profiles see
// a provider. So every read here filters `profile_id = ?` on the owned linking
// table (the profile-scoping test enforces it). The global identity card + the
// admin-only merge/impact live in lib/providers-db.ts, not here.

// One row in a provider's per-profile activity listing. `href` deep-links to where
// the record lives; `date` is the display date (may be null for an undated row).
export interface ProviderActivityItem {
  id: number;
  date: string | null;
  label: string;
  sublabel: string | null;
  href: AppRoute;
}

// Count chips shown on the detail page + index, all scoped to the active profile.
export interface ProviderActivityCounts {
  visits: number;
  labs: number;
  medications: number;
  immunizations: number;
  procedures: number;
  carePlan: number;
  appointments: number;
}

// The relationship strip: first time this profile saw the provider, the most
// recent completed visit, and the next scheduled appointment (any of them null).
export interface ProviderRelationship {
  firstSeen: string | null;
  lastVisit: string | null;
  nextAppointment: string | null;
}

function n(row: unknown): number {
  return (row as { n: number }).n;
}

// All per-profile count chips for one provider. Encounters count a row that names
// the provider as attending OR facility once (DISTINCT is implicit — a single row).
// Each statement is an inline literal filtering profile_id so the profile-scoping
// test verifies it directly (a shared prepare-a-variable helper would hide the SQL).
export function getProviderActivityCounts(
  profileId: number,
  providerId: number
): ProviderActivityCounts {
  return {
    visits: n(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM encounters
             WHERE profile_id = ? AND (provider_id = ? OR location_provider_id = ?)`
        )
        .get(profileId, providerId, providerId)
    ),
    labs: n(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM medical_records
             WHERE profile_id = ? AND provider_id = ?`
        )
        .get(profileId, providerId)
    ),
    medications: n(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM intake_items
             WHERE profile_id = ? AND provider_id = ?`
        )
        .get(profileId, providerId)
    ),
    immunizations: n(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM immunizations
             WHERE profile_id = ? AND provider_id = ?`
        )
        .get(profileId, providerId)
    ),
    procedures: n(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM procedures
             WHERE profile_id = ? AND provider_id = ?`
        )
        .get(profileId, providerId)
    ),
    carePlan: n(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM care_plan_items
             WHERE profile_id = ? AND provider_id = ?`
        )
        .get(profileId, providerId)
    ),
    appointments: n(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM appointments
             WHERE profile_id = ? AND provider_id = ?`
        )
        .get(profileId, providerId)
    ),
  };
}

// The sum of all count chips — used by the index to show one per-profile activity
// number per provider and to decide the detail page's empty state.
export function getProviderActivityTotal(
  profileId: number,
  providerId: number
): number {
  const c = getProviderActivityCounts(profileId, providerId);
  return (
    c.visits +
    c.labs +
    c.medications +
    c.immunizations +
    c.procedures +
    c.carePlan +
    c.appointments
  );
}

// The relationship strip. firstSeen is the earliest dated activity across the
// dated clinical tables; lastVisit the latest encounter; nextAppointment the
// soonest still-scheduled appointment on/after `todayDate`.
export function getProviderRelationship(
  profileId: number,
  providerId: number,
  todayDate: string
): ProviderRelationship {
  const firstSeen = db
    .prepare(
      `SELECT MIN(d) AS d FROM (
         SELECT date AS d FROM encounters
           WHERE profile_id = ? AND (provider_id = ? OR location_provider_id = ?) AND date IS NOT NULL
         UNION ALL
         SELECT date AS d FROM procedures
           WHERE profile_id = ? AND provider_id = ? AND date IS NOT NULL
         UNION ALL
         SELECT date AS d FROM medical_records
           WHERE profile_id = ? AND provider_id = ? AND date IS NOT NULL
         UNION ALL
         SELECT date AS d FROM immunizations
           WHERE profile_id = ? AND provider_id = ? AND date IS NOT NULL
       )`
    )
    .get(
      profileId,
      providerId,
      providerId,
      profileId,
      providerId,
      profileId,
      providerId,
      profileId,
      providerId
    ) as { d: string | null };

  const lastVisit = db
    .prepare(
      `SELECT MAX(date) AS d FROM encounters
         WHERE profile_id = ? AND (provider_id = ? OR location_provider_id = ?)`
    )
    .get(profileId, providerId, providerId) as { d: string | null };

  const nextAppt = db
    .prepare(
      `SELECT MIN(scheduled_at) AS d FROM appointments
         WHERE profile_id = ? AND provider_id = ?
           AND status = 'scheduled' AND scheduled_at >= ?`
    )
    .get(profileId, providerId, todayDate) as { d: string | null };

  return {
    firstSeen: firstSeen.d,
    lastVisit: lastVisit.d,
    nextAppointment: nextAppt.d,
  };
}

// ── Per-type listings (each profile-scoped) ──────────────────────────────────
// The detail page expands a count chip into one of these. Each returns display-
// ready rows with a deep link to where the record lives.

export function getProviderVisits(
  profileId: number,
  providerId: number
): ProviderActivityItem[] {
  const rows = db
    .prepare(
      `SELECT id, date, type, reason FROM encounters
         WHERE profile_id = ? AND (provider_id = ? OR location_provider_id = ?)
         ORDER BY date DESC, id DESC`
    )
    .all(profileId, providerId, providerId) as {
    id: number;
    date: string | null;
    type: string | null;
    reason: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    label: r.type || "Visit",
    sublabel: r.reason,
    href: encounterHref(r.id),
  }));
}

export function getProviderLabs(
  profileId: number,
  providerId: number
): ProviderActivityItem[] {
  const rows = db
    .prepare(
      `SELECT id, date, name, category FROM medical_records
         WHERE profile_id = ? AND provider_id = ?
         ORDER BY date DESC, id DESC`
    )
    .all(profileId, providerId) as {
    id: number;
    date: string | null;
    name: string;
    category: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    label: r.name,
    sublabel: r.category,
    href: "/biomarkers",
  }));
}

export function getProviderMedications(
  profileId: number,
  providerId: number
): ProviderActivityItem[] {
  const rows = db
    .prepare(
      `SELECT id, name, kind, active FROM intake_items
         WHERE profile_id = ? AND provider_id = ?
         ORDER BY active DESC, name`
    )
    .all(profileId, providerId) as {
    id: number;
    name: string;
    kind: string;
    active: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    date: null,
    label: r.name,
    sublabel: r.active ? r.kind : `${r.kind} · inactive`,
    href: "/medicine",
  }));
}

export function getProviderImmunizations(
  profileId: number,
  providerId: number
): ProviderActivityItem[] {
  const rows = db
    .prepare(
      `SELECT id, date, vaccine, dose_label FROM immunizations
         WHERE profile_id = ? AND provider_id = ?
         ORDER BY date DESC, id DESC`
    )
    .all(profileId, providerId) as {
    id: number;
    date: string | null;
    vaccine: string;
    dose_label: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    label: r.vaccine,
    sublabel: r.dose_label,
    href: "/immunizations",
  }));
}

export function getProviderProcedures(
  profileId: number,
  providerId: number
): ProviderActivityItem[] {
  const rows = db
    .prepare(
      `SELECT id, date, name, code FROM procedures
         WHERE profile_id = ? AND provider_id = ?
         ORDER BY date DESC, id DESC`
    )
    .all(profileId, providerId) as {
    id: number;
    date: string | null;
    name: string;
    code: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    label: r.name,
    sublabel: r.code,
    href: "/procedures",
  }));
}

export function getProviderCarePlan(
  profileId: number,
  providerId: number
): ProviderActivityItem[] {
  const rows = db
    .prepare(
      `SELECT id, planned_date, description, status FROM care_plan_items
         WHERE profile_id = ? AND provider_id = ?
         ORDER BY planned_date DESC, id DESC`
    )
    .all(profileId, providerId) as {
    id: number;
    planned_date: string | null;
    description: string;
    status: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    date: r.planned_date,
    label: r.description,
    sublabel: r.status,
    href: "/care-plan",
  }));
}

export function getProviderAppointments(
  profileId: number,
  providerId: number
): ProviderActivityItem[] {
  const rows = db
    .prepare(
      `SELECT id, scheduled_at, title, status FROM appointments
         WHERE profile_id = ? AND provider_id = ?
         ORDER BY scheduled_at DESC, id DESC`
    )
    .all(profileId, providerId) as {
    id: number;
    scheduled_at: string;
    title: string | null;
    status: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    date: r.scheduled_at,
    label: r.title || "Appointment",
    sublabel: r.status,
    href: "/encounters",
  }));
}

// ── Index page ───────────────────────────────────────────────────────────────

// A provider row for the /providers index, carrying this profile's activity total
// (0 for a provider only other profiles have seen — the row still lists, since the
// registry is global, but its per-profile count is honest for the acting profile).
export interface ProviderIndexRow {
  id: number;
  name: string;
  type: string;
  npi: string | null;
  activity: number;
}

// Every provider with the ACTIVE profile's activity total, alphabetical. The list
// itself is global (all providers); only the counts are per-profile.
export function getProvidersForIndex(profileId: number): ProviderIndexRow[] {
  const providers = db
    .prepare(
      `SELECT id, name, type, npi FROM providers ORDER BY name COLLATE NOCASE`
    )
    .all() as { id: number; name: string; type: string; npi: string | null }[];
  return providers.map((p) => ({
    ...p,
    activity: getProviderActivityTotal(profileId, p.id),
  }));
}
