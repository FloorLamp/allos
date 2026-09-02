import { hoistedStatement } from "../db";
import { cache } from "../request-cache";
import { encounterHref, RECORDS_CONDITIONS_HREF, type AppRoute } from "../hrefs";
import {
  specialtyLineForCondition,
  specialtyLineForVisit,
  type SpecialtyLine,
} from "../specialty-lens";
import { ENCOUNTER_REPRESENTATIVE_IDS } from "./medical/encounters";
import { getConditions } from "./clinical";

// The GATHER half of the specialty lens (#2921). The classification itself is pure
// (lib/specialty-lens.ts); this module does the profile-scoped reads it needs and
// projects each match into the one row shape the history strip renders.
//
// NOTHING IS STORED. There is no membership table and no specialty column: every
// call re-reads the encounters and re-asks the classifier, so correcting a
// provider's specialty in the registry reflows every lens on the next render.
//
// The encounter read is its OWN lean projection rather than getEncounters(): the
// lens needs each side's provider SPECIALTY (which the display-shaped Encounter row
// does not carry) and none of the diagnoses/document/provenance columns it does. It
// reuses the shared representative-id substrate (#71/#2035), so a visit that arrived
// in three overlapping documents is one row here exactly as it is on the Visits pane.

const LENS_ENCOUNTERS_STMT = hoistedStatement(
  `SELECT e.id, e.date, e.type, e.reason, e.notes, e.code,
          p.name AS provider_name, p.specialty AS provider_specialty,
          p.specialty_code AS provider_specialty_code,
          l.name AS location_name, l.specialty AS location_specialty,
          l.specialty_code AS location_specialty_code
     FROM encounters e
     LEFT JOIN providers p ON p.id = e.provider_id
     LEFT JOIN providers l ON l.id = e.location_provider_id
    WHERE e.profile_id = ? AND e.id IN (${ENCOUNTER_REPRESENTATIVE_IDS})
    ORDER BY e.date DESC, e.id DESC`
);

interface LensEncounterRow {
  id: number;
  date: string;
  type: string | null;
  reason: string | null;
  notes: string | null;
  code: string | null;
  provider_name: string | null;
  provider_specialty: string | null;
  provider_specialty_code: string | null;
  location_name: string | null;
  location_specialty: string | null;
  location_specialty_code: string | null;
}

// One row of a pane's history strip. `kind` is what it is, not how it was matched —
// the strip groups by it, and each row deep-links to the surface that already owns
// the record (#662's non-causal linked-context posture: this GROUPS existing rows,
// it never asserts a relationship between them).
export interface SpecialtyLensEntry {
  kind: "visit" | "condition";
  id: number;
  /** The visit date, or a condition's onset date when it has one. */
  date: string | null;
  label: string;
  detail: string | null;
  href: AppRoute;
}

// The lens's visits for a profile, newest first. Profile-scoped.
const lensVisits = cache(function lensVisits(
  profileId: number
): { line: SpecialtyLine; entry: SpecialtyLensEntry }[] {
  const rows = LENS_ENCOUNTERS_STMT.all(
    profileId,
    profileId
  ) as LensEncounterRow[];
  const out: { line: SpecialtyLine; entry: SpecialtyLensEntry }[] = [];
  for (const r of rows) {
    const line = specialtyLineForVisit({
      code: r.code,
      // The SAME fold #515 gives the preventive matcher (lib/queries/upcoming/
      // preventive.ts): a specialty visit's evidence lives in the notes and the
      // provider/facility name as often as in its type.
      text:
        [r.type, r.reason, r.notes, r.provider_name, r.location_name]
          .filter(Boolean)
          .join(" ") || null,
      providerSpecialty: r.provider_specialty,
      providerSpecialtyCode: r.provider_specialty_code,
      facilitySpecialty: r.location_specialty,
      facilitySpecialtyCode: r.location_specialty_code,
    });
    if (!line) continue;
    out.push({
      line,
      entry: {
        kind: "visit",
        id: r.id,
        date: r.date,
        label: r.type?.trim() || r.reason?.trim() || "Visit",
        detail: r.provider_name ?? r.location_name,
        href: encounterHref(r.id),
      },
    });
  }
  return out;
});

// The lens's conditions for a profile. Reads the shared, deduped conditions list
// rather than a second query of its own. Profile-scoped through it.
const lensConditions = cache(function lensConditions(
  profileId: number
): { line: SpecialtyLine; entry: SpecialtyLensEntry }[] {
  const out: { line: SpecialtyLine; entry: SpecialtyLensEntry }[] = [];
  for (const c of getConditions(profileId)) {
    const line = specialtyLineForCondition({
      name: c.name,
      code: c.code,
      codeSystem: c.code_system,
    });
    if (!line) continue;
    out.push({
      line,
      entry: {
        kind: "condition",
        id: c.id,
        date: c.onset_date,
        label: c.name,
        detail: c.status === "active" ? "Active" : c.status,
        href: RECORDS_CONDITIONS_HREF,
      },
    });
  }
  return out;
});

/**
 * A profile's care history in one service line — its classified visits and coded
 * conditions, newest first, undated rows last. Derived at read; nothing cached
 * beyond the request.
 */
export function getSpecialtyLensEntries(
  profileId: number,
  line: SpecialtyLine
): SpecialtyLensEntry[] {
  return [...lensVisits(profileId), ...lensConditions(profileId)]
    .filter((m) => m.line === line)
    .map((m) => m.entry)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/**
 * Whether the lens has anything for this profile in this line — the widened
 * Vision/Dental pane gate (#2921). Asks the same classification the strip renders,
 * so a pane can never be gated open on content the strip won't list.
 */
export function hasSpecialtyLensContent(
  profileId: number,
  line: SpecialtyLine
): boolean {
  return (
    lensVisits(profileId).some((m) => m.line === line) ||
    lensConditions(profileId).some((m) => m.line === line)
  );
}
