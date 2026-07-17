import { isNonOptimal, isOutOfRange } from "./reference-range";
import { currentGrowthBadge, type GrowthBadge } from "./growth-series";
import type { AllergyStatus, ConditionStatus, MedicalFlag, Sex } from "./types";
import {
  filterCategoryFor,
  resolveDoseLabels,
  seriesLengthForCode,
  type TiterStatus,
  type VaccineAssessment,
  type VaccineStatus,
} from "./immunization-status";
import { expandToComponents } from "./immunization-catalog";

// Pure view-model assembly for the profile summary / "medical passport".
// Every field the passport shows already exists as a query; this module
// takes the individual latest-value results and shapes them into one card model,
// with the interesting derivations — blood-type resolution, BMI, and the merge of
// flagged + starred biomarkers — done here so they're unit-testable without a DB
// (lib/__tests__/profile-summary.test.ts). The DB gathering lives in
// lib/profile-summary-load.ts.

// ---- Shared row shapes ----
export interface SummaryVital {
  name: string;
  value: string | null;
  unit: string | null;
  flag: MedicalFlag | null;
  date: string | null;
  starred: boolean;
}

export interface SummaryMedication {
  name: string;
  detail: string | null; // dose/value, when known
  // The date this medication was started (its open course's started_on, or the
  // item's created date as a fallback; an extracted prescription's record date).
  date: string | null;
}

export interface SummarySupplement {
  name: string;
  detail: string | null; // brand/product, when known
  // The date this supplement was started (its modeled start, else created_at).
  date: string | null;
}

// One recorded dose within a passport immunization row: its date plus the
// resolved dose label ("Dose 2 of 3", or a user-entered "Booster").
export interface SummaryImmunizationDose {
  date: string;
  label: string | null;
}

// A per-vaccine passport row: the vaccine's current status badge
// plus EVERY recorded dose date (not just the latest). One row per catalog
// vaccine that has at least one crediting dose (a combination shot credits each
// of its component vaccines), or a titer/override-driven immunity.
export interface SummaryImmunization {
  code: string;
  name: string;
  status: VaccineStatus;
  // True when the status reads as "Immune" (a titer/override-driven completion),
  // so the passport shows the emerald "Immune" pill rather than plain "Complete".
  isImmune: boolean;
  doses: SummaryImmunizationDose[];
}

// A stored immunization record, as the passport builder needs it: enough to
// expand combos to their component series, order doses, and label them.
export interface PassportImmunizationRecord {
  id: number;
  vaccine: string;
  date: string;
  dose_label: string | null;
}

export interface SummaryTiter {
  marker: string;
  status: TiterStatus;
  value: string | null;
  date: string | null;
}

export interface SummaryHistoryItem {
  name: string;
  value: string | null;
  unit: string | null;
  flag: MedicalFlag | null;
  date: string;
  category: string;
}

export interface SummaryAllergy {
  substance: string;
  reaction: string | null;
  severity: string | null;
  status: AllergyStatus | null;
  // Provenance: a clinically-documented allergy, a lab-derived IgE sensitization,
  // or both. Drives the "from labs" label on the passport.
  origin: "documented" | "labs" | "both";
  // Short evidence line for a lab-derived/corroborated allergy (e.g. "Peanut IgE
  // — class 3"), or null.
  evidence: string | null;
}

// One allergen cross-reactivity note on the passport (issue #153). Derived from
// the merged allergies view by the shared pure matcher (lib/allergen-cross-
// reactivity), so the passport and the Allergies page can never disagree.
export interface SummaryCrossReactivity {
  familyId: string;
  triggers: string[];
  related: string[];
  label: string;
  citation: string;
}

export interface SummaryCondition {
  name: string;
  code: string | null;
  status: ConditionStatus;
  onsetDate: string | null;
}

// One family-history entry on the passport: a relative + their condition, with the
// onset age when known.
export interface SummaryFamilyHistory {
  relation: string | null;
  condition: string;
  onsetAge: number | null;
  deceased: boolean;
}

// ---- The assembled card model ----
export interface ProfileSummary {
  identity: {
    name: string;
    age: number | null;
    sex: Sex | null;
    bloodType: string | null; // "O+", "AB-", … or null when unknown
    hasBirthdate: boolean;
    birthdate: string | null; // YYYY-MM-DD, when stored
  };
  body: {
    heightCm: number | null;
    weightKg: number | null;
    bmi: number | null;
    bodyFatPct: number | null;
    restingHr: number | null;
    // The date each raw reading was measured (YYYY-MM-DD), so the passport can
    // show "as of <date>" per stat. BMI is derived, so it carries no own date.
    heightDate: string | null;
    weightDate: string | null;
    bodyFatDate: string | null;
    restingHrDate: string | null;
    // Pediatric growth percentiles (WHO/CDC) at the current age, or null
    // for adults / out-of-range ages / unknown sex.
    growth: GrowthBadge | null;
  };
  vitals: SummaryVital[];
  allergies: SummaryAllergy[];
  crossReactivity: SummaryCrossReactivity[];
  conditions: SummaryCondition[];
  familyHistory: SummaryFamilyHistory[];
  medications: SummaryMedication[];
  supplements: SummarySupplement[];
  immunizations: SummaryImmunization[];
  titers: SummaryTiter[];
  history: SummaryHistoryItem[];
}

export interface ProfileSummaryInput {
  name: string;
  age: number | null;
  // Current age in whole months (for pediatric growth percentiles), when derivable.
  ageMonths: number | null;
  sex: Sex | null;
  hasBirthdate: boolean;
  birthdate: string | null;
  // Latest 'ABO Blood Group' and 'Rh Type' record VALUES (strings as stored).
  aboValue: string | null;
  rhValue: string | null;
  // The manually-entered blood type (profile setting), when set. It WINS over the
  // lab-derived value — the same precedence the Emergency Card uses — so the
  // passport and the break-glass card can never disagree on blood type (#385). A
  // person who typed their own type asserts it deliberately; without this the
  // passport could only read ABO/Rh labs and showed "Unknown" while the card
  // showed the typed value.
  manualBloodType: string | null;
  heightCm: number | null;
  weightKg: number | null;
  bodyFatPct: number | null;
  restingHr: number | null;
  // The measured date for each raw body reading, when known.
  heightDate: string | null;
  weightDate: string | null;
  bodyFatDate: string | null;
  restingHrDate: string | null;
  // Current flagged (out-of-range / non-optimal) biomarkers, and starred ones.
  flagged: SummaryVital[];
  starred: SummaryVital[];
  allergies: SummaryAllergy[];
  crossReactivity: SummaryCrossReactivity[];
  conditions: SummaryCondition[];
  familyHistory: SummaryFamilyHistory[];
  medications: SummaryMedication[];
  supplements: SummarySupplement[];
  immunizations: SummaryImmunization[];
  titers: SummaryTiter[];
  history: SummaryHistoryItem[];
}

// How many merged vitals to surface on the card (keeps a printed passport tidy).
const MAX_VITALS = 16;

// Normalize the ABO group from a stored value string to one of A/B/AB/O, or null.
// Tolerant of surrounding text ("Blood Group A", "Type O") and case; checks AB
// before A/B so "AB" isn't read as "A".
export function normalizeAbo(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.toUpperCase();
  if (/\bAB\b/.test(v) || /(^|[^A-Z])AB([^A-Z]|$)/.test(v)) return "AB";
  const hasA = /\bA\b/.test(v) || /(^|[^A-Z])A([^A-Z]|$)/.test(v);
  const hasB = /\bB\b/.test(v) || /(^|[^A-Z])B([^A-Z]|$)/.test(v);
  if (hasA && hasB) return "AB";
  if (hasA) return "A";
  if (hasB) return "B";
  if (/\bO\b/.test(v) || /(^|[^A-Z])O([^A-Z]|$)/.test(v)) return "O";
  return null;
}

// Normalize the Rh factor from a stored value string to "+", "-", or null.
export function normalizeRh(
  value: string | null | undefined
): "+" | "-" | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.includes("+") || v.includes("pos")) return "+";
  if (v.includes("-") || v.includes("neg")) return "-";
  return null;
}

// Resolve a printable blood type from the latest ABO + Rh record values. The ABO
// group is required (an Rh factor alone is meaningless); the Rh sign is appended
// when known, so "O" with unknown Rh still renders as "O".
export function resolveBloodType(
  aboValue: string | null | undefined,
  rhValue: string | null | undefined
): string | null {
  const group = normalizeAbo(aboValue);
  if (!group) return null;
  const rh = normalizeRh(rhValue);
  return rh ? `${group}${rh}` : group;
}

// A reading whose NAME marks it as carrying blood-group information. Deliberately
// broader than the qualitative classifier's IMMUTABLE_ATTRIBUTE regex, which keys on
// `\babo\b` and so misses Epic's real-world "ABORh Interpretation" (no word boundary
// between ABO and Rh) — the exact naming that leaves an imported blood type
// unrecognized today.
//
// The name gate is what makes the loose value parsing below safe: normalizeAbo reads
// a bare "A"/"B"/"O" as a group, which would be reckless against arbitrary analytes
// but is correct once the row is known to be about blood grouping.
const BLOOD_GROUP_NAME =
  /\babo\b|abo\s*rh|aborh|blood\s*(?:type|group)|rh\s*(?:type|factor)|rh\s*\(?d\)?\b/i;

// A minimal reading shape — what every import path already has on a record.
export interface BloodGroupReading {
  name: string;
  canonical?: string | null;
  value: string | null;
}

// The two INDEPENDENT halves of a blood group, each null when the document doesn't
// carry it.
export interface BloodGroupParts {
  abo: string | null; // "A" | "B" | "AB" | "O"
  rh: "+" | "-" | null;
}

// Read the blood-group halves out of a document's readings.
//
// Handles BOTH real-world shapes in one pass, with no special-casing:
//   • two rows — "ABO Blood Group" = "O" plus "Rh Type" = "RH(D) POSITIVE";
//   • one COMBINED row — Epic's "ABORh Interpretation" = "O Positive", which answers
//     both halves at once: it becomes the source for the ABO and the Rh alike, and
//     each normalizer reads its own half back out of the same string.
//
// Returns the halves SEPARATELY rather than a composed type, because they arrive
// separately: a document may carry only the ABO group (Rh not drawn, or not
// reported) and a later one completes it. Keeping them apart is what lets the caller
// store each half on its own, so successive imports accumulate instead of an
// incomplete result being dropped on the floor.
export function bloodGroupPartsFromReadings(
  readings: readonly BloodGroupReading[]
): BloodGroupParts {
  let aboSource: string | null = null;
  let rhSource: string | null = null;
  for (const r of readings) {
    if (!BLOOD_GROUP_NAME.test(`${r.canonical ?? ""} ${r.name ?? ""}`))
      continue;
    if (aboSource === null && normalizeAbo(r.value)) aboSource = r.value;
    if (rhSource === null && normalizeRh(r.value)) rhSource = r.value;
  }
  return { abo: normalizeAbo(aboSource), rh: normalizeRh(rhSource) };
}

// Resolve a printable blood type from a document's readings, or null when none of
// them carries an ABO group. The group alone still resolves ("O" with unknown Rh
// renders "O"); an Rh factor alone is meaningless — matching resolveBloodType.
export function bloodTypeFromReadings(
  readings: readonly BloodGroupReading[]
): string | null {
  const { abo, rh } = bloodGroupPartsFromReadings(readings);
  return abo ? resolveBloodType(abo, rh) : null;
}

// BMI from weight (kg) and height (cm), rounded to one decimal. Null unless both
// are present and height is a positive, plausible value.
export function computeBmi(
  weightKg: number | null,
  heightCm: number | null
): number | null {
  if (weightKg == null || heightCm == null || heightCm <= 0) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

// Resolve a medication's "started on" date for the passport:
// a currently-taken med has exactly one OPEN course (stopped_on IS NULL) by
// invariant, so its started_on is the start date. When several are open we take
// the most recent start; when no course is on file we fall back to the item's
// created date (date portion only, so it renders like the other date-only rows).
// Pure so it's unit-tested without a DB.
export function medicationStartDate(
  courses: readonly { started_on: string | null; stopped_on: string | null }[],
  createdAt: string | null
): string | null {
  const openStarts = courses
    .filter((c) => c.stopped_on == null && c.started_on != null)
    .map((c) => c.started_on as string)
    .sort((a, b) => b.localeCompare(a));
  if (openStarts.length > 0) return openStarts[0];
  return createdAt ? createdAt.slice(0, 10) : null;
}

// Severity rank for ordering vitals: out-of-range (high/low/abnormal) first, then
// non-optimal, then everything else. Lower sorts earlier.
function flagRank(flag: MedicalFlag | null): number {
  if (isOutOfRange(flag)) return 0;
  if (isNonOptimal(flag)) return 1;
  return 2;
}

// Merge the flagged + starred biomarker lists into one deduplicated vitals list,
// keyed case-insensitively by name. A biomarker that is both flagged and starred
// keeps its flag AND its star. Ordered by severity, then starred, then name; the
// most clinically relevant rows lead and the list is capped for print.
export function mergeVitals(
  flagged: readonly SummaryVital[],
  starred: readonly SummaryVital[]
): SummaryVital[] {
  const byName = new Map<string, SummaryVital>();
  const add = (v: SummaryVital, starredFlag: boolean) => {
    const key = v.name.trim().toLowerCase();
    if (!key) return;
    const existing = byName.get(key);
    if (existing) {
      // Prefer a concrete flag over a null one; OR the starred flags together.
      byName.set(key, {
        ...existing,
        flag: existing.flag ?? v.flag,
        value: existing.value ?? v.value,
        unit: existing.unit ?? v.unit,
        date: existing.date ?? v.date,
        starred: existing.starred || starredFlag,
      });
    } else {
      byName.set(key, { ...v, starred: starredFlag });
    }
  };
  for (const v of flagged) add(v, v.starred);
  for (const v of starred) add(v, true);

  return [...byName.values()]
    .sort((a, b) => {
      const r = flagRank(a.flag) - flagRank(b.flag);
      if (r !== 0) return r;
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    })
    .slice(0, MAX_VITALS);
}

// Assemble the full passport view-model from the individual latest-value inputs.
export function buildProfileSummary(
  input: ProfileSummaryInput
): ProfileSummary {
  return {
    identity: {
      name: input.name,
      age: input.age,
      sex: input.sex,
      // Manual blood type wins over the lab-derived one (same precedence as the
      // Emergency Card), so both surfaces agree (#385).
      bloodType:
        (input.manualBloodType?.trim() || null) ??
        resolveBloodType(input.aboValue, input.rhValue),
      hasBirthdate: input.hasBirthdate,
      birthdate: input.birthdate,
    },
    body: {
      heightCm: input.heightCm,
      weightKg: input.weightKg,
      bmi: computeBmi(input.weightKg, input.heightCm),
      bodyFatPct: input.bodyFatPct,
      restingHr: input.restingHr,
      heightDate: input.heightDate,
      weightDate: input.weightDate,
      bodyFatDate: input.bodyFatDate,
      restingHrDate: input.restingHrDate,
      growth: currentGrowthBadge({
        sex: input.sex,
        ageMonths: input.ageMonths,
        heightCm: input.heightCm,
        weightKg: input.weightKg,
      }),
    },
    vitals: mergeVitals(input.flagged, input.starred),
    allergies: input.allergies,
    crossReactivity: input.crossReactivity,
    conditions: input.conditions,
    familyHistory: input.familyHistory,
    medications: input.medications,
    supplements: input.supplements,
    immunizations: input.immunizations,
    titers: input.titers,
    history: input.history,
  };
}

// Build the passport's per-vaccine immunization rows from the raw
// stored records and the already-computed schedule assessments. Each assessment
// is a catalog vaccine; a stored dose credits it when the vaccine's code expands
// to (or is) that catalog code — so one combination shot (e.g. Vaxelis) surfaces
// under each component series it advanced, exactly as the schedule engine credits
// it. A row is kept only when the vaccine has at least one crediting dose OR a
// titer/override-driven immunity (so "no record" catalog entries don't clutter
// the card). Doses are ordered oldest→newest and labelled with the shared
// resolveDoseLabels numbering. Pure, so it's unit-tested without a DB.
export function buildPassportImmunizations(
  records: readonly PassportImmunizationRecord[],
  assessments: readonly VaccineAssessment[]
): SummaryImmunization[] {
  // Index the crediting records per catalog code (combo → its components).
  const byCode = new Map<string, PassportImmunizationRecord[]>();
  for (const r of records) {
    if (!r.date) continue;
    for (const code of expandToComponents(r.vaccine)) {
      const list = byCode.get(code);
      if (list) list.push(r);
      else byCode.set(code, [r]);
    }
  }

  const rows: SummaryImmunization[] = [];
  for (const a of assessments) {
    const crediting = byCode.get(a.code) ?? [];
    const isImmune = filterCategoryFor(a) === "immune";
    // Keep only vaccines the profile actually has doses for, or an immunity we
    // can attest (titer / manual immune override) even without a dose on file.
    if (crediting.length === 0 && !isImmune) continue;
    const labels = resolveDoseLabels(crediting, seriesLengthForCode(a.code));
    const doses = [...crediting]
      .sort((x, y) => x.date.localeCompare(y.date) || x.id - y.id)
      .map((r) => ({ date: r.date, label: labels.get(r.id) ?? null }));
    rows.push({
      code: a.code,
      name: a.name,
      status: a.status,
      isImmune,
      doses,
    });
  }

  // Stable, calm ordering for a printed card: by vaccine name.
  return rows.sort((x, y) =>
    x.name.localeCompare(y.name, undefined, { sensitivity: "base" })
  );
}
