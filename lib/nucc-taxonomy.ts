// Curated NUCC (National Uniform Claim Committee) provider-taxonomy code → display
// label map (issue #1056). PURE — no DB/network.
//
// Providers carry a `specialty_code` (the NUCC taxonomy code, verbatim) + a
// `specialty` (a human display string). The code is the standard companion to the
// NPI, carried by CCDA performers (`<code codeSystem="2.16.840.1.113883.6.101">`)
// and FHIR PractitionerRole.specialty / Practitioner.qualification. This module
// is the #860 curated-dataset envelope: a PRACTICAL subset of the ~850-code
// taxonomy covering the common outpatient specialties, NOT the full set. The
// document's own `displayName` is the fallback for a code we don't curate, and an
// unknown code with no display text is kept verbatim so nothing is dropped.
//
// Code-first identity, display for humans — the two-track pattern. The map is the
// authority for a display we can improve over time; the stored `specialty` string
// is what the document said (or what a human typed), so a curated-label change
// never rewrites stored data (display is derived at capture, then editable).

// The NUCC provider-taxonomy code system OID (CCDA) / URI (FHIR).
export const NUCC_OID = "2.16.840.1.113883.6.101";
export const NUCC_SYSTEM_URI = "http://nucc.org/provider-taxonomy";

// Curated code → label. Kept alphabetical-ish by label for scanability; extend
// freely — this is a convenience map, not a source of truth for identity.
export const NUCC_LABELS: Record<string, string> = {
  "207K00000X": "Allergy & Immunology",
  "207L00000X": "Anesthesiology",
  "207RC0000X": "Cardiology",
  "207RI0011X": "Interventional Cardiology",
  "2081P0301X": "Sports Medicine",
  "207N00000X": "Dermatology",
  "122300000X": "Dentistry",
  "1223G0001X": "General Practice Dentistry",
  "1223X0400X": "Orthodontics",
  "1223S0112X": "Oral & Maxillofacial Surgery",
  "133V00000X": "Registered Dietitian",
  "207RE0101X": "Endocrinology",
  "207P00000X": "Emergency Medicine",
  "207Q00000X": "Family Medicine",
  "207RG0100X": "Gastroenterology",
  "208D00000X": "General Practice",
  "207RH0003X": "Hematology & Oncology",
  "207RI0200X": "Infectious Disease",
  "207R00000X": "Internal Medicine",
  "207RX0202X": "Medical Oncology",
  "207RN0300X": "Nephrology",
  "2084N0400X": "Neurology",
  "207T00000X": "Neurological Surgery",
  "207V00000X": "Obstetrics & Gynecology",
  "207W00000X": "Ophthalmology",
  "152W00000X": "Optometry",
  "207X00000X": "Orthopaedic Surgery",
  "207Y00000X": "Otolaryngology",
  "207ZP0105X": "Pathology",
  "208000000X": "Pediatrics",
  "2081P2900X": "Physical Medicine & Rehabilitation",
  "225100000X": "Physical Therapist",
  "183500000X": "Pharmacist",
  "2084P0800X": "Psychiatry",
  "103T00000X": "Psychologist",
  "207RP1001X": "Pulmonary Disease",
  "2085R0202X": "Diagnostic Radiology",
  "207RR0500X": "Rheumatology",
  "208600000X": "Surgery",
  "208G00000X": "Thoracic Surgery",
  "208800000X": "Urology",
  "363L00000X": "Nurse Practitioner",
  "363A00000X": "Physician Assistant",
  "261Q00000X": "Clinic / Center",
  "282N00000X": "General Acute Care Hospital",
  "291U00000X": "Clinical Medical Laboratory",
  "333600000X": "Pharmacy",
};

// The sorted, de-duplicated list of curated labels — powers the manual specialty
// field's <datalist> (free text still allowed). Stable order for a stable UI.
export const NUCC_LABEL_OPTIONS: string[] = Array.from(
  new Set(Object.values(NUCC_LABELS))
).sort((a, b) => a.localeCompare(b));

// Resolve a NUCC code (+ the document's own displayName, if any) to a display
// string. Precedence: curated label → the document's displayName → null. The
// caller stores the RESULT as `specialty` and the raw `code` as `specialty_code`,
// so an unknown code still carries the document's own text, and a bare unknown code
// with no display keeps `specialty` null (the code alone is retained for identity).
export function nuccLabel(
  code: string | null | undefined,
  displayName?: string | null
): string | null {
  const c = (code ?? "").trim().toUpperCase();
  if (c && NUCC_LABELS[c]) return NUCC_LABELS[c];
  const d = (displayName ?? "").replace(/\s+/g, " ").trim();
  return d || null;
}
