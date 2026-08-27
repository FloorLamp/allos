// Canonical copy rendered by /disclaimer (issue #1049).
export const DISCLAIMER_SECTIONS: {
  id?: string;
  title: string;
  body: string;
}[] = [
  {
    title: "Informational, not medical advice",
    body: "Allos is a personal health-tracking tool. Everything it shows — trends, derived ranges, suggestions, interaction and safety flags — is informational and is not medical advice, diagnosis, or treatment. It is not a substitute for the judgment of a qualified clinician. Always talk to your own doctor, pharmacist, or other healthcare professional before making a decision about your health, medications, or care.",
  },
  {
    title: "Not a diagnosis",
    body: "Screening scores, flagged biomarkers, growth and percentile curves, cycle phases, and every other derived readout describe your recorded data — they do not diagnose a condition. A flag is a prompt to look closer with a professional, never a verdict. The absence of a flag is not clearance.",
  },
  {
    id: "suggestions-and-reference-ranges",
    title: "Suggestions and reference ranges",
    body: "Preventive suggestions are based on general guidelines. Reference and optimal ranges can be incomplete or inaccurate and may vary by age, sex, and clinical context. A clinician's guidance takes priority.",
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

// Shared by focused dataset/generator checks and runtime copy stripping (#2342).
export const DISCLAIMER_PHRASINGS: readonly RegExp[] = [
  /not\s+medical\s+advice/i,
  /informational[^.\n]*\badvice\b/i,
  /\binformational\s+only\b/i,
  /\bconsult\s+a\s+clinician\b/i,
  /not\s+a\s+diagnosis/i,
  /never\s+prescriptive/i,
];

// Whether copy contains a disclaimer phrasing.
export function hasDisclaimerPhrasing(
  text: string | null | undefined
): boolean {
  return !!text && DISCLAIMER_PHRASINGS.some((re) => re.test(text));
}

// Remove whole SENTENCES that carry a disclaimer phrasing, leaving the rest of the
// copy intact. Sentence-grained rather than phrase-grained on purpose: excising the
// phrase alone leaves a mangled clause ("It is a screening instrument, ."), and the
// sentences this fires on are pure boilerplate — the surrounding copy is what the
// reader came for. Returns the remaining text, whitespace-collapsed; "" when every
// sentence was boilerplate, which callers treat as "nothing worth storing".
export function stripDisclaimerSentences(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !hasDisclaimerPhrasing(sentence))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
