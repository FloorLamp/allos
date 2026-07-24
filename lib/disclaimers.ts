// The ONE place the app's disclaimer copy is maintained (issue #1049).
//
// Disclaimer text used to live as ~40 inline literals across app/ and components/,
// drifted into ~15 near-variants of one sentence ("Informational only, not medical
// advice", "not medical advice", "informational — not medical advice", …). That is
// the "one question, one computation" discipline (#221) unapplied to legal copy: the
// same statement maintained in 40 places drifts, and there was no single authoritative
// place a user (or an auditor) could read the app's actual medical-disclaimer posture.
//
// This module is the canonical source. Every surface renders a REFERENCE to one of
// these constants, never its own copy. A pure source-scan guard
// (lib/__tests__/disclaimers.test.ts) fails CI on a new inline disclaimer literal
// under app/ or components/, so the 40→1 consolidation can't silently regrow.
//
// Pure string module: NO imports, no DB, no network — client-safe and importable from
// any tier (a Server Component page, a client card, a lib finding builder).

// The canonical app-wide medical-disclaimer line. This exact wording is asserted by
// e2e (illness-care.spec.ts) and is the tail of several finding `evidence` strings, so
// it stays "Informational, not medical advice." — the shortest phrasing that carries
// the posture.
export const MEDICAL_DISCLAIMER = "Informational, not medical advice.";

// The interpretive framing for screening scores, derived ranges, and biomarker
// readouts: the app records and organizes, it does not diagnose.
export const NOT_A_DIAGNOSIS = "Informational, not a diagnosis.";

// The interpretive framing for suggestion/interaction surfaces: the app describes and
// flags, it never tells you what to take or change.
export const NEVER_PRESCRIPTIVE = "Informational, never prescriptive.";

// The curated-dataset framing (#860/#1032): the reference datasets are a hand-reviewed
// subset for personal tracking, not exhaustive clinical software — so the ABSENCE of a
// flag is never clearance.
export const DATASET_DISCLAIMER =
  "A curated subset for personal tracking — not clinical software.";

// The point-of-action clause carried by a medication-safety finding's `evidence`: the
// finding is a prompt to talk to a professional, not an instruction to change anything.
export const DISCUSS_WITH_PRESCRIBER =
  "discuss with your prescriber or pharmacist";

// The long-form legal text rendered by the single Disclaimer surface (/disclaimer),
// reachable from the persistent footer link and Settings. Structured as titled
// sections so the page can render them as headed paragraphs; DISCLAIMER_FULL is the
// same content joined to plain text (the guard/test asserts the page renders it).
export const DISCLAIMER_SECTIONS: { title: string; body: string }[] = [
  {
    title: "Informational, not medical advice",
    body: "Allos is a personal health-tracking tool. Everything it shows — trends, derived ranges, suggestions, interaction and safety flags — is informational and is not medical advice, diagnosis, or treatment. It is not a substitute for the judgment of a qualified clinician. Always talk to your own doctor, pharmacist, or other healthcare professional before making a decision about your health, medications, or care.",
  },
  {
    title: "Not a diagnosis",
    body: "Screening scores, flagged biomarkers, growth and percentile curves, cycle phases, and every other derived readout describe your recorded data — they do not diagnose a condition. A flag is a prompt to look closer with a professional, never a verdict. The absence of a flag is not clearance.",
  },
  {
    title: "Reference data is a curated subset",
    body: "The reference datasets Allos ships — drug interactions, biomarker ranges, immunization schedules, radiation-dose figures, and the rest — are a curated, hand-reviewable subset for personal tracking, not exhaustive clinical software. They will not contain every drug, interaction, condition, or guideline, and coverage is deliberately narrow rather than complete. Do not treat a quiet screen as a guarantee that nothing applies.",
  },
  {
    title: "Automated extraction can be wrong",
    body: "When Allos reads a document you upload (a lab report, an imaging summary, a health-record export), the extracted values are produced by automated tools and can be incomplete or incorrect. Check anything important against the original source document.",
  },
  {
    title: "In an emergency",
    body: "If you are in immediate danger, or think you may be having a medical emergency, call your local emergency number or go to the nearest emergency department. Allos does not monitor you, cannot detect an emergency, and never contacts anyone on your behalf.",
  },
  {
    title: "Your data stays with your instance",
    body: "Allos is self-hosted. Your health records live in the database on the server running this instance and are not sent anywhere except the services you explicitly connect (for example, an AI provider you enable for document extraction, or a health integration you link).",
  },
];

export const DISCLAIMER_FULL: string = DISCLAIMER_SECTIONS.map(
  (s) => `${s.title}. ${s.body}`
).join("\n\n");
