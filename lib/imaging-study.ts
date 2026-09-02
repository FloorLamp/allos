// Pure normalization + display helpers for structured imaging studies (#702).
//
// The ONE place raw imaging strings (from the AI report extractor OR a manual form)
// are coerced onto the DB's CHECK vocabularies, plus the display labels the UI
// reads. No DB/network imports, so both the Server Actions and the import persist
// path share the same coercion (the "one question, one computation" rule) and it
// unit-tests without a handle.
//
// Scope: nothing here interprets a study's meaning — it maps a stated modality /
// laterality / contrast onto our enums and formats what the report already said.
// Image pixels / DICOM are out of scope (Allos holds the report, not the images).

import type { ImagingModality, ImagingLaterality } from "./types/medical";

export const IMAGING_MODALITIES: readonly ImagingModality[] = [
  "x-ray",
  "ct",
  "mri",
  "ultrasound",
  "dexa",
  "pet",
  "nuclear-medicine",
  "fluoroscopy",
  "other",
];

export const IMAGING_LATERALITIES: readonly ImagingLaterality[] = [
  "left",
  "right",
  "bilateral",
  "na",
];

// Normalize a stated modality onto the enum. Unknown / absent → 'other' (the safe
// default: an unclassified study is still stored). Accepts the report's looser
// phrasings ("radiograph", "CAT scan", "sonogram", "bone density", …).
export function normalizeModality(raw: unknown): ImagingModality {
  if (typeof raw !== "string") return "other";
  const s = raw.trim().toLowerCase();
  if (!s) return "other";
  // PET FIRST, before CT/x-ray: a hybrid "PET/CT" (or "PET-CT", "FDG PET/CT")
  // resolves to `pet` — the tracer study dominates the dose, the same reason MRI
  // is checked before CT below (#1034).
  if (/\bpet\b/.test(s) || s.includes("positron emission") || /\bfdg\b/.test(s))
    return "pet";
  // Nuclear medicine BEFORE CT/dexa/x-ray: "SPECT/CT" rides the tracer study,
  // and a "bone scan" (scintigraphy) must never fall to the dexa/x-ray branches.
  if (
    s.includes("nuclear") ||
    /\bspect\b/.test(s) ||
    s.includes("scintigra") ||
    s.includes("myocardial perfusion") ||
    s.includes("bone scan") ||
    /\bhida\b/.test(s) ||
    s.includes("thyroid uptake") ||
    /\bv\/?q\b/.test(s) ||
    (s.includes("ventilation") && s.includes("perfusion"))
  )
    return "nuclear-medicine";
  if (
    s.includes("mri") ||
    s.includes("magnetic resonance") ||
    s.includes("mr ")
  )
    return "mri";
  // Check CT after MRI so "MR" phrasings don't fall through; guard against matching
  // the "ct" inside other words by requiring a word-ish boundary.
  if (
    /\bct\b/.test(s) ||
    s.includes("cat scan") ||
    s.includes("computed tomography") ||
    s.includes("computerized tomography")
  )
    return "ct";
  if (
    s.includes("dexa") ||
    s.includes("dxa") ||
    s.includes("bone density") ||
    s.includes("bone densitometry") ||
    s.includes("densitometry")
  )
    return "dexa";
  if (
    s.includes("ultrasound") ||
    s.includes("sonogram") ||
    s.includes("sonography") ||
    s.includes("doppler") ||
    s.includes("echocardiogram") ||
    s.includes("echo ") ||
    /\bus\b/.test(s)
  )
    return "ultrasound";
  // Fluoroscopy AFTER MRI/CT — "CT angiography" / "MR angiography" ride their
  // cross-sectional modality (their dose mechanism) — but BEFORE x-ray, so a
  // "barium swallow x-ray" resolves to the fluoroscopic exam it is. Catheter
  // angiography / interventional work lands here too (#1034): its dose mechanism
  // is fluoroscopic, so it must never fall to `other`.
  if (
    s.includes("fluoro") ||
    s.includes("angiogra") ||
    s.includes("arteriogra") ||
    s.includes("interventional") ||
    s.includes("barium") ||
    s.includes("upper gi") ||
    /\bvcug\b/.test(s) ||
    s.includes("cystourethrogra") ||
    s.includes("cardiac cath") ||
    s.includes("heart cath")
  )
    return "fluoroscopy";
  if (
    s.includes("x-ray") ||
    s.includes("xray") ||
    s.includes("x ray") ||
    s.includes("radiograph") ||
    s.includes("plain film") ||
    s.includes("mammogram") ||
    s.includes("mammograph")
  )
    return "x-ray";
  return "other";
}

// Normalize a stated laterality onto the enum, or null when the report gives none.
// "bilateral" / "both" → bilateral; an explicit not-applicable / midline → 'na';
// anything unrecognized → null (unstated).
export function normalizeLaterality(raw: unknown): ImagingLaterality | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("bilateral") || s === "both" || s.includes("both sides"))
    return "bilateral";
  if (s.startsWith("left") || s === "l" || s === "lt") return "left";
  if (s.startsWith("right") || s === "r" || s === "rt") return "right";
  if (
    s === "na" ||
    s === "n/a" ||
    s.includes("not applicable") ||
    s.includes("midline")
  )
    return "na";
  return null;
}

// Normalize a stated contrast value onto a boolean. Explicit "without" / "non" wins
// over a bare "contrast" mention. Unknown / absent → false (the safe default: a
// study is presumed non-contrast unless the report says otherwise).
export function normalizeContrast(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  if (typeof raw !== "string") return false;
  const s = raw.trim().toLowerCase();
  if (!s) return false;
  if (
    s.includes("without") ||
    s.includes("non-contrast") ||
    s.includes("noncontrast") ||
    s.includes("no contrast") ||
    s === "false" ||
    s === "no" ||
    s === "0"
  )
    return false;
  if (
    s.includes("with contrast") ||
    s.includes("contrast-enhanced") ||
    s.includes("gadolinium") ||
    s.includes("iodinated") ||
    s === "contrast" ||
    s === "true" ||
    s === "yes" ||
    s === "1"
  )
    return true;
  return false;
}

// Parse an effective-radiation-dose value (millisieverts) onto a finite, non-negative
// number, or null (#703). The ONE shared coercion for the manual form AND the import
// path, so a report's "8 mSv" / a form's "8" both land the same way and an off-value
// (blank, negative, NaN, a stray unit) degrades to null (no recorded dose → the typical
// estimate takes over). Strips a trailing "mSv"/"msv" unit if the extractor left it on.
export function parseDoseMsv(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/m?sv$/i, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Human labels for the UI (pickers + list badges). Kept here so the page, the import
// listing, and the passport can't disagree about how a term reads.
export function modalityLabel(m: ImagingModality): string {
  switch (m) {
    case "x-ray":
      return "X-ray";
    case "ct":
      return "CT";
    case "mri":
      return "MRI";
    case "ultrasound":
      return "Ultrasound";
    case "dexa":
      return "DEXA";
    case "pet":
      return "PET";
    case "nuclear-medicine":
      return "Nuclear medicine";
    case "fluoroscopy":
      return "Fluoroscopy";
    case "other":
      return "Other";
  }
}

export function lateralityLabel(l: ImagingLaterality): string {
  switch (l) {
    case "left":
      return "Left";
    case "right":
      return "Right";
    case "bilateral":
      return "Bilateral";
    case "na":
      return "N/A";
  }
}

// The one-line identity a study shows in a list / tab / passport: the modality, the
// body region, and the laterality when it's a side (left/right/bilateral) — e.g.
// "MRI Left Knee", "CT Chest", "X-ray". Purely factual — no interpretation.
export function studyDisplayLabel(s: {
  modality: ImagingModality;
  body_region: string | null;
  laterality: ImagingLaterality | null;
}): string {
  const parts: string[] = [modalityLabel(s.modality)];
  const side =
    s.laterality && s.laterality !== "na"
      ? lateralityLabel(s.laterality)
      : null;
  const region = s.body_region?.trim();
  // Imported and manually entered regions sometimes already carry their side
  // ("Left Knee"). Keep laterality as structured data without repeating it in
  // the shared display identity ("MRI Left Left Knee").
  const regionAlreadyHasSide =
    side != null &&
    region != null &&
    region.toLocaleLowerCase().startsWith(`${side.toLocaleLowerCase()} `);
  if (side && !regionAlreadyHasSide) parts.push(side);
  if (region) parts.push(region);
  return parts.join(" ");
}

// THE SECTION LABEL IS NOT PART OF THE IMPRESSION (#3498 item 3).
//
// A radiology extract regularly carries its own section heading into the field:
// "OVERALL IMPRESSION: Findings suggestive of a left breast…". On the study list the
// impression is a one-line subtitle under a row that ALREADY says what the field is,
// so the heading spends the only line the finding has — the phone review met a row
// that clamped to "OVERALL IMPRESSION: Findings suggestive of a left breast…" and
// cut exactly where the clinical payload begins.
//
// This strips a LEADING section label and nothing else. It does not summarise, does
// not truncate, and does not touch a label that appears mid-text (a second section
// inside a multi-section impression is content, and dropping it would change what the
// report says). The stored value is untouched — the study form still shows and edits
// the record as imported (#3480's posture: the record keeps the source string, the
// display shows the clean one).
const IMPRESSION_SECTION_LABEL =
  /^\s*(?:overall\s+)?impression\s*(?:\/\s*conclusion\s*)?[:\-–—]\s*/i;

export function impressionDisplayText(
  impression: string | null | undefined
): string | null {
  if (!impression) return null;
  const stripped = impression.replace(IMPRESSION_SECTION_LABEL, "").trim();
  // A field that was ONLY the label says nothing; render no subtitle rather than an
  // empty one.
  return stripped.length > 0 ? stripped : null;
}

// WHAT THE REPORT SAID (#3594). A study carries the parsed impression when the import
// could isolate one, and the report narrative it was parsed out of. Rows imported
// before the split — and every report whose impression could not be isolated — carry
// only the narrative, so every surface that asks "what did this report say" reads the
// impression first and falls back to the narrative rather than going silent.
export function studyFindingText(study: {
  impression: string | null;
  report_narrative?: string | null;
}): string | null {
  return study.impression ?? study.report_narrative ?? null;
}

// THE IMPRESSION SECTION OF A RENDERED REPORT (#3594), or null.
//
// The rendered form of a radiology report is a whole document — banner, header,
// technique, findings, impression, signature — and the only signal we trust for
// where the impression starts and stops is a section heading that OWNS ITS LINE.
//
// A MID-LINE "WORD:" IS NOT A HEADING, and this is the rule the whole parser turns
// on. Clinical sentences are full of capitalised tokens that end in a colon — spine
// levels ("L4-L5:"), hyphenated disease names ("COVID-19:"), quadrant abbreviations
// ("RLQ:") — so treating any of them as the next section cuts the finding in half
// and stores a sentence torso the report never said. That fragment then OUTRANKS the
// intact narrative everywhere, because studyFindingText prefers the impression. A
// verbose impression is at least true; a truncated one is not, so "err toward storing
// less" means answering NULL, never answering a fragment.
//
// Both ends therefore anchor to a line: a heading is a label at the start of a line
// (optionally indented), and the section runs to the next line that starts with an
// ALL-CAPS label — or to the end of the text when none does. A document the decoders
// collapsed onto ONE line has no line structure left to read, so unless it BEGINS
// with the impression label there is nothing here to trust and the answer is null.
//
// NO HEADING, NO PARSE. A report that does not label its impression on a line of its
// own contributes nothing to this field and is read through the narrative fallback
// above, which shows the whole report — so declining hides nothing from anybody.
const IMPRESSION_HEADING =
  /(?:^|\n)[ \t]*(?:overall[ \t]+)?(?:impression|conclusion)(?:[ \t]*\/[ \t]*(?:conclusion|impression))?[ \t]*[:\-\u2013\u2014][ \t]*/i;
// The next section's heading: a line whose first token is an ALL-CAPS run ending in a
// colon ("RECOMMENDATION:", "ELECTRONICALLY SIGNED BY:"). Anchored to the newline, so
// a capitalised token INSIDE a sentence can never end the section.
const NEXT_SECTION_HEADING = /\n[ \t]*(?=[A-Z][A-Z0-9 /&'-]{2,}:)/;

export function parseImpressionSection(
  narrative: string | null | undefined
): string | null {
  if (!narrative) return null;
  const match = IMPRESSION_HEADING.exec(narrative);
  if (!match) return null;
  const after = narrative.slice(match.index + match[0].length);
  const cut = NEXT_SECTION_HEADING.exec(after);
  const section = (cut ? after.slice(0, cut.index) : after).trim();
  return section.length > 0 ? section : null;
}
