import { matchRuleKeys, normalizeMatchText } from "./preventive-inference";
import { icd10CodeOf, type CodedConditionRef } from "./condition-codes";

// The SPECIALTY LENS (issue #2921) — a READ-SIDE classification of a profile's
// visits and conditions into the four anatomical service lines the Specialty panes
// already exist for. PURE: no DB, no network; the gather lives in
// lib/queries/specialty-lens.ts.
//
// Why a lens and not a column: a visit's service line is a READING of the record,
// not a fact the record asserts. Storing it would freeze a guess — correcting a
// provider's specialty in the registry has to reflow every pane that groups by it,
// which it does only while the classification is derived at read. So nothing here
// is written anywhere, and no membership is cached.
//
// ONE CLASSIFICATION, NOT TWO. The free-text tier delegates to the #515 provider-
// specialty/facility matcher — `matchRuleKeys` over lib/preventive-concept-map.ts —
// rather than restating its curated vocabulary. The preventive engine and this
// surface therefore read the SAME list: a term added for one is seen by the other,
// and neither can drift. The lens adds no term to that map (which would change what
// the preventive engine infers), only its own reading of two STRUCTURED fields the
// preventive path never looks at: the provider's NUCC taxonomy code and its
// specialty label.
//
// CONSERVATIVE, on #86/#515 discipline: an unclassifiable visit stays out of every
// lens rather than being guessed into one. There is no "other" line and no
// lowest-confidence fallback.

export const SPECIALTY_LINES = ["vision", "dental", "hearing", "skin"] as const;

export type SpecialtyLine = (typeof SPECIALTY_LINES)[number];

// The catalog rule whose curated names/codes ARE this line's free-text vocabulary
// (lib/preventive-concept-map.ts). This is the whole of the sharing: the lens owns
// no synonym list of its own for free text.
const LINE_RULE_KEY: Record<SpecialtyLine, string> = {
  vision: "vision_exam",
  dental: "dental_cleaning",
  hearing: "hearing_screening",
  skin: "skin_check",
};

const RULE_KEY_LINE = new Map<string, SpecialtyLine>(
  SPECIALTY_LINES.map((line) => [LINE_RULE_KEY[line], line])
);

// The STRUCTURED specialty vocabulary — read only from `providers.specialty_code`
// (NUCC taxonomy, the standard NPI companion captured by #1056) and
// `providers.specialty` (its human label, offered as a datalist on the manual
// provider form and imported verbatim from FHIR PractitionerRole).
//
// A curated subset of lib/nucc-taxonomy.ts, not a second copy of it: only the codes
// whose taxonomy IS one of the four anatomical lines appear. Otolaryngology is
// deliberately absent — an ENT practice is throat and sinus care as often as ear
// care, so a specialty match would put unrelated visits in the Hearing lens.
//
// `terms` are whole-word terms for the LABEL when no code arrived (a hand-typed
// specialty, or an import that carried text only). They may be single words because
// the field they read is the provider's declared specialty — unlike free text,
// where a single word is the over-match #86 forbids.
const LINE_SPECIALTY_SIGNALS: Record<
  SpecialtyLine,
  { nucc: string[]; terms: string[] }
> = {
  vision: {
    nucc: ["207W00000X", "152W00000X"], // Ophthalmology, Optometry
    terms: ["ophthalmology", "optometry"],
  },
  dental: {
    // Dentistry, General Practice Dentistry, Orthodontics, Oral & Maxillofacial
    // Surgery. The label terms carry this line because the concept map's dental
    // names are visit words ("dentist", "dental cleaning") that whole-word matching
    // never finds inside the specialty string "Dentistry".
    nucc: ["122300000X", "1223G0001X", "1223X0400X", "1223S0112X"],
    terms: ["dentistry", "dental", "orthodontics", "endodontics", "periodontics"],
  },
  hearing: {
    nucc: ["231H00000X"], // Audiologist
    terms: ["audiology"],
  },
  skin: {
    nucc: ["207N00000X"], // Dermatology
    terms: ["dermatology"],
  },
};

// Precomputed ` term ` needles, the same space-wrapped whole-word shape
// lib/preventive-inference.ts matches with.
const LABEL_NEEDLES: { line: SpecialtyLine; needles: string[] }[] =
  SPECIALTY_LINES.map((line) => ({
    line,
    needles: LINE_SPECIALTY_SIGNALS[line].terms.map((t) => normalizeMatchText(t)),
  }));

const LINE_BY_NUCC = new Map<string, SpecialtyLine>(
  SPECIALTY_LINES.flatMap((line) =>
    LINE_SPECIALTY_SIGNALS[line].nucc.map(
      (code) => [code.toUpperCase(), line] as const
    )
  )
);

// One visit as the lens reads it. The two provider sides are separate because
// their PRECEDENCE differs: the attending clinician's own specialty outranks the
// facility's (#1055's org↔individual bridge is a fallback — a dermatologist seen
// at a multi-specialty clinic is still a skin visit).
export interface SpecialtyVisitSignals {
  /** encounters.code — the imported visit TYPE code (CPT/CDT), #1035. */
  code?: string | null;
  /** type + reason + notes + provider name + facility name, as #515 folds them. */
  text?: string | null;
  providerSpecialty?: string | null;
  providerSpecialtyCode?: string | null;
  facilitySpecialty?: string | null;
  facilitySpecialtyCode?: string | null;
}

function lineFromSpecialty(
  code: string | null | undefined,
  label: string | null | undefined
): SpecialtyLine | null {
  const byCode = LINE_BY_NUCC.get((code ?? "").trim().toUpperCase());
  if (byCode) return byCode;
  const text = normalizeMatchText(label);
  if (!text.trim()) return null;
  for (const { line, needles } of LABEL_NEEDLES) {
    if (needles.some((n) => text.includes(n))) return line;
  }
  return null;
}

/**
 * The service line a visit belongs to, or null when nothing identifies one.
 *
 * Precedence, strongest evidence first:
 *   1. the attending provider's NUCC code, then their specialty label;
 *   2. the facility's, same two (the #1055 affiliated-org fallback — the observed
 *      household's ophthalmology org carries its specialty only in its name);
 *   3. the #515 free-text/code matcher over the visit's own words.
 *
 * A visit reaching none of those is unclassified and appears in no lens.
 */
export function specialtyLineForVisit(
  visit: SpecialtyVisitSignals
): SpecialtyLine | null {
  const byProvider = lineFromSpecialty(
    visit.providerSpecialtyCode,
    visit.providerSpecialty
  );
  if (byProvider) return byProvider;
  const byFacility = lineFromSpecialty(
    visit.facilitySpecialtyCode,
    visit.facilitySpecialty
  );
  if (byFacility) return byFacility;
  // The shared matcher, asked the SAME question the preventive engine asks of an
  // encounter (`allow: ["visit"]`). Rules outside the four lines match plenty of
  // visits — an annual physical satisfies adult_physical — and are simply not lines.
  for (const ruleKey of matchRuleKeys(
    { code: visit.code, name: visit.text },
    ["visit"]
  )) {
    const line = RULE_KEY_LINE.get(ruleKey);
    if (line) return line;
  }
  return null;
}

// ICD-10 CHAPTER ranges that ARE a service line — the "condition-code families as
// corroboration" half. Chapter-level is the right grain here (unlike
// lib/condition-codes.ts, whose families identify one clinical concept): the
// question is which body system a diagnosis belongs to, and ICD-10 answers exactly
// that in its block structure.
//
//   H00–H59  eye and adnexa           → vision (the anchor case: H50 strabismus)
//   H60–H95  ear and mastoid process  → hearing
//   K00–K08  teeth and supporting structures → dental. STOPS at K08: K09–K14 are
//            jaw cysts, stomatitis, salivary glands and tongue — oral, but not the
//            Dental pane's subject.
//   L00–L99  skin and subcutaneous tissue → skin
//
// A condition with no code, a non-ICD-10 vocabulary, or a code outside these ranges
// is unclassified — conditions are never name-matched into a lens, because a
// diagnosis name has no curated synonym list behind it the way a visit does.
const ICD10_LINE_BLOCKS: {
  line: SpecialtyLine;
  letter: string;
  from: number;
  to: number;
}[] = [
  { line: "vision", letter: "H", from: 0, to: 59 },
  { line: "hearing", letter: "H", from: 60, to: 95 },
  { line: "dental", letter: "K", from: 0, to: 8 },
  { line: "skin", letter: "L", from: 0, to: 99 },
];

/** The service line a coded condition belongs to, or null. */
export function specialtyLineForCondition(
  condition: CodedConditionRef
): SpecialtyLine | null {
  const code = icd10CodeOf(condition);
  if (!code) return null;
  const letter = code[0];
  const block = Number(code.slice(1, 3));
  if (!Number.isInteger(block)) return null;
  return (
    ICD10_LINE_BLOCKS.find(
      (b) => b.letter === letter && block >= b.from && block <= b.to
    )?.line ?? null
  );
}

// The strip's heading per line — "Eye care history" reads to a person; "Vision
// lens" reads to whoever wrote the code.
export const SPECIALTY_LINE_HISTORY_TITLE: Record<SpecialtyLine, string> = {
  vision: "Eye care history",
  dental: "Dental care history",
  hearing: "Hearing care history",
  skin: "Skin care history",
};
