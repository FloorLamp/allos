import { db, today } from "./db";
import {
  getUserAge,
  getUserSex,
  getUserBirthdate,
  getUserFullName,
  getBloodType,
} from "./settings";
import { ageInMonthsFromBirthdate } from "./date";
import {
  getLatestMetricSample,
  getLatestBodyMetricDated,
} from "./queries/metrics";
import {
  getMedicalRecords,
  getStarredBiomarkers,
  getImmunizations,
  getImmunityTiters,
  getImmunizationOverrides,
  getLatestMedicalRecordByCanonical,
} from "./queries/medical";
import {
  getSupplements,
  getSupplementDoses,
  getMedicationCourses,
} from "./queries/intake";
import {
  getAllergiesView,
  getConditions,
  getCrossReactivityNotes,
  getFamilyHistory,
} from "./queries/clinical";
import { assessSchedule } from "./immunization-status";
import { cleanMedicationName } from "./prescription-parse";
import {
  buildProfileSummary,
  buildPassportImmunizations,
  medicationStartDate,
  type ProfileSummary,
  type SummaryAllergy,
  type SummaryCrossReactivity,
  type SummaryCondition,
  type SummaryFamilyHistory,
  type SummaryVital,
} from "./profile-summary";
import type { MedicationCourse } from "./types";
import type { MedicalRecord } from "./types";

// Server-side gathering for the profile passport: it runs the
// individual profile-scoped latest-value queries and hands the raw results to the
// pure buildProfileSummary(). Shared verbatim by the authenticated page and the
// public share render, so both show the identical model.

// Canonical names the blood type is read from (existing canonicalized records —
// no new field, per the issue).
const ABO_CANONICAL = "ABO Blood Group";
const RH_CANONICAL = "Rh Type";

// Display identity for a record: its canonical name when set, else the raw name.
function recordName(r: MedicalRecord): string {
  return r.canonical_name?.trim() || r.name;
}

// Recent-history count kept small so a printed passport stays tidy.
const MAX_HISTORY = 15;

// The profiles.name for a profile id (a global table — not profile-scoped). Used
// as the passport heading's fallback when no full name is stored, and to name a
// shared render that has no session.
export function getProfileNameById(profileId: number): string | null {
  const row = db
    .prepare("SELECT name FROM profiles WHERE id = ?")
    .get(profileId) as { name: string } | undefined;
  return row?.name ?? null;
}

export function getProfileSummary(
  profileId: number,
  fallbackName: string
): ProfileSummary {
  // Age (months) + sex drive both the pediatric growth badges and the
  // immunization schedule assessment; resolve them up front.
  const birthdate = getUserBirthdate(profileId);
  const now = today(profileId);
  const ageMonths = birthdate ? ageInMonthsFromBirthdate(birthdate, now) : null;
  const sex = getUserSex(profileId);

  const abo = getLatestMedicalRecordByCanonical(profileId, ABO_CANONICAL);
  const rh = getLatestMedicalRecordByCanonical(profileId, RH_CANONICAL);

  const flagged: SummaryVital[] = getMedicalRecords(profileId, {
    current: true,
    range: "nonoptimal",
  }).map((r) => ({
    name: recordName(r),
    value: r.value ?? (r.value_num != null ? String(r.value_num) : null),
    unit: r.unit,
    flag: r.flag,
    date: r.date,
    starred: false,
  }));

  const starred: SummaryVital[] = getStarredBiomarkers(profileId).map((s) => ({
    name: s.canonical_name,
    value:
      s.latest_value ??
      (s.latest_value_num != null ? String(s.latest_value_num) : null),
    unit: s.latest_unit,
    flag: s.latest_flag,
    date: s.latest_date,
    starred: true,
  }));

  // Medications: structured medication rows
  // (kind='medication') are the primary source — including the ones now
  // auto-structured from prescription documents (source='extracted'). Extracted
  // prescription *records* remain a fallback only for prescriptions NOT yet
  // represented as a structured med. Dedup on the cleaned/grouping name (the same
  // normalization the structuring uses), so a structured "Lisinopril" hides its
  // raw "Lisinopril 10 mg" medical_records twin and no med double-lists. `active`
  // splits the two kinds.
  const allSupps = getSupplements(profileId);
  const medDoseAmounts = new Map<number, string[]>();
  for (const d of getSupplementDoses(profileId)) {
    if (!d.amount) continue;
    const arr = medDoseAmounts.get(d.item_id) ?? [];
    arr.push(d.amount);
    medDoseAmounts.set(d.item_id, arr);
  }
  // Group each medication's courses by item so the passport can date a med by its
  // current open course (the med's active course), per medicationStartDate().
  const coursesByItem = new Map<number, MedicationCourse[]>();
  for (const c of getMedicationCourses(profileId)) {
    const arr = coursesByItem.get(c.item_id) ?? [];
    arr.push(c);
    coursesByItem.set(c.item_id, arr);
  }
  const medSeen = new Set<string>();
  const structuredMeds = allSupps
    .filter((s) => s.active && s.kind === "medication")
    .map((s) => {
      medSeen.add(cleanMedicationName(s.name).toLowerCase());
      const strength = [...new Set(medDoseAmounts.get(s.id) ?? [])].join(", ");
      const detail =
        [strength, s.as_needed === 1 ? "as needed" : null]
          .filter(Boolean)
          .join(" · ") || null;
      return {
        name: s.name,
        detail,
        date: medicationStartDate(coursesByItem.get(s.id) ?? [], s.created_at),
      };
    });
  const extractedMeds = getMedicalRecords(profileId, {
    category: "prescription",
    sort: "date",
    dir: "desc",
  })
    .filter((r) => {
      const key = cleanMedicationName(recordName(r)).toLowerCase();
      if (medSeen.has(key)) return false;
      medSeen.add(key);
      return true;
    })
    .map((r) => ({
      name: recordName(r),
      detail: [r.value, r.unit].filter(Boolean).join(" ") || null,
      date: r.date,
    }));
  const medications = [...structuredMeds, ...extractedMeds];

  const supplements = allSupps
    .filter((s) => s.active && s.kind !== "medication")
    .map((s) => ({
      name: s.name,
      detail: [s.brand, s.product].filter(Boolean).join(" · ") || null,
      // Supplements carry no modeled start date, so the created date stands in
      // (date portion only, to render like the other date-only rows).
      date: s.created_at ? s.created_at.slice(0, 10) : null,
    }));

  // Immunizations passport table: one row per catalog vaccine the profile
  // has doses for, each carrying its schedule status badge and EVERY dose date.
  // Built from the same assessSchedule() the immunizations page uses, so the two
  // surfaces can't drift; a combination shot credits each component series.
  const immunizationRecords = getImmunizations(profileId);
  const titerRows = getImmunityTiters(profileId);
  const overrides = getImmunizationOverrides(profileId);
  const assessments = assessSchedule(
    immunizationRecords.map((r) => ({ vaccine: r.vaccine, date: r.date })),
    ageMonths,
    sex,
    now,
    titerRows.map((t) => ({ marker: t.marker, status: t.status })),
    overrides.map((o) => ({ vaccine: o.vaccine, kind: o.kind }))
  ).assessments;
  const immunizations = buildPassportImmunizations(
    immunizationRecords.map((r) => ({
      id: r.id,
      vaccine: r.vaccine,
      date: r.date,
      dose_label: r.dose_label,
    })),
    assessments
  );

  const titers = titerRows.map((t) => ({
    marker: t.marker,
    status: t.status,
    value: t.value ?? (t.value_num != null ? String(t.value_num) : null),
    date: t.date,
  }));

  const history = getMedicalRecords(profileId, { sort: "date", dir: "desc" })
    .slice(0, MAX_HISTORY)
    .map((r) => ({
      name: recordName(r),
      value: r.value ?? (r.value_num != null ? String(r.value_num) : null),
      unit: r.unit,
      flag: r.flag,
      date: r.date,
      category: r.category,
    }));

  // Allergies: documented allergies merged with positive lab-derived IgE
  // sensitizations (dedup by allergen). Conditions: the active problem list.
  const allergies: SummaryAllergy[] = getAllergiesView(profileId).map((a) => ({
    substance: a.substance,
    reaction: a.reaction,
    severity: a.severity,
    status: a.status,
    origin: a.origin,
    evidence: a.evidence
      ? `${a.evidence.marker}${
          a.evidence.rastClass != null ? ` — class ${a.evidence.rastClass}` : ""
        }`
      : null,
  }));
  // Informational allergen cross-reactivity notes over the SAME merged allergen
  // set (shared pure matcher — the Allergies page uses the identical query).
  const crossReactivity: SummaryCrossReactivity[] = getCrossReactivityNotes(
    profileId
  ).map((c) => ({
    familyId: c.familyId,
    triggers: c.triggers,
    related: c.related,
    label: c.label,
    citation: c.citation,
  }));
  const conditions: SummaryCondition[] = getConditions(profileId, {
    status: "active",
  }).map((c) => ({
    name: c.name,
    code: c.code,
    status: c.status,
    onsetDate: c.onset_date,
  }));
  // Family history: hereditary-risk context (all relatives). Grouped by relative in
  // the query order.
  const familyHistory: SummaryFamilyHistory[] = getFamilyHistory(profileId).map(
    (f) => ({
      relation: f.relation,
      condition: f.condition,
      onsetAge: f.onset_age,
      deceased: f.deceased === 1,
    })
  );

  const height = getLatestMetricSample(profileId, "height_cm");
  const weight = getLatestBodyMetricDated(profileId, "weight");
  const bodyFat = getLatestBodyMetricDated(profileId, "body_fat");
  const restingHr = getLatestBodyMetricDated(profileId, "resting_hr");

  return buildProfileSummary({
    name: getUserFullName(profileId) ?? fallbackName,
    age: getUserAge(profileId),
    ageMonths,
    sex,
    hasBirthdate: birthdate != null,
    birthdate,
    aboValue: abo?.value ?? null,
    rhValue: rh?.value ?? null,
    manualBloodType: getBloodType(profileId),
    heightCm: height?.value ?? null,
    weightKg: weight?.value ?? null,
    bodyFatPct: bodyFat?.value ?? null,
    restingHr: restingHr?.value ?? null,
    heightDate: height?.date ?? null,
    weightDate: weight?.date ?? null,
    bodyFatDate: bodyFat?.date ?? null,
    restingHrDate: restingHr?.date ?? null,
    flagged,
    starred,
    allergies,
    crossReactivity,
    conditions,
    familyHistory,
    medications,
    supplements,
    immunizations,
    titers,
    history,
  });
}
