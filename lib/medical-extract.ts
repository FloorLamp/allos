import Anthropic, {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";
import type { MedicalCategory, MedicalFlag, Sex } from "./types";
import { MEDICAL_CATEGORIES, MEDICAL_FLAGS } from "./medical-categories";
import { AI_MODEL, aiConfigured, createAiClient } from "./ai-client";
import { createLogger } from "./log";
import { recordAiEvent, capDetail, LOG_PROMPTS } from "./ai-log";
import { strOrNull } from "./parse";
import { isRealIsoDate } from "./date";
import type { ImportDrop } from "./import-report";
import {
  buildCanonicalIndex,
  snapCanonicalName,
  distinguishVitaminDIsoform,
} from "./canonical-name";

// Prefix server logs so extraction activity is easy to grep in the dev/prod
// console. One line per lifecycle event (start / done / skipped / failed).
const log = createLogger("medical-extract");

// Turn a raw SDK/runtime error into an actionable, user-facing sentence while
// keeping the underlying detail. Order matters: timeout is a subclass of
// connection error, so check it first.
export function describeError(err: unknown): string {
  if (err instanceof APIConnectionTimeoutError) {
    return "The AI request timed out before responding. The document may be large or the model took too long — try again, or split it into smaller files.";
  }
  if (err instanceof APIConnectionError) {
    return "The connection to the AI dropped before a response came back. This is common when a large document is processed in a single long request. Try again; if it keeps failing the document may be too large to extract in one pass.";
  }
  if (err instanceof APIError) {
    const s = err.status;
    if (s === 401 || s === 403)
      return "AI authentication failed — check that ANTHROPIC_API_KEY (or the AI_BASE_URL endpoint's credentials) is set and valid.";
    if (s === 413)
      return "The document is too large for a single AI request. Try a smaller file or split it.";
    if (s === 429)
      return "Rate limited by the AI. Wait a moment, then delete this document and re-upload.";
    if (typeof s === "number" && s >= 500)
      return `The AI service returned a server error (${s}). Try again shortly. (${err.message})`;
    return `AI request failed${s ? ` (HTTP ${s})` : ""}: ${err.message}`;
  }
  return err instanceof Error ? err.message : "AI request failed.";
}

// Shared model knob. Needs a model with PDF + vision support (Claude 3.5+/4).
const MODEL = AI_MODEL;

// A full lab report can be ~80+ analytes; the structured tool output is large,
// so allow plenty of room. Override with HEALTH_AI_MAX_TOKENS if needed.
const MAX_TOKENS = Number(process.env.HEALTH_AI_MAX_TOKENS) || 16000;

// The category whitelist and the clinical-flag whitelist come from the single
// shared source (lib/medical-categories.ts) so this extractor and the medical
// write action can't drift. MEDICAL_FLAGS deliberately excludes the DERIVED
// "non-optimal*" flags: those are reconciled in code from the canonical optimal
// band, so the model must never set one (it would contradict that band).
const CATEGORIES = MEDICAL_CATEGORIES;
const FLAGS = MEDICAL_FLAGS;

export interface ExtractedResult {
  category: MedicalCategory;
  panel: string | null;
  name: string;
  canonical_name: string;
  value: string | null;
  value_num: number | null;
  unit: string | null;
  reference_range: string | null;
  flag: MedicalFlag | null;
  collected_date: string | null;
  notes: string | null;
}

// One vaccine administration extracted from an immunization record / vaccine
// card. `vaccine` is the name/brand exactly as printed; it's normalized to a
// catalog code by lib/immunization-extract (never dropped — slug fallback).
export interface ExtractedImmunization {
  vaccine: string;
  date: string | null; // YYYY-MM-DD
  dose_label: string | null;
  notes: string | null;
}

// The clinical-narrative domains the AI extractor now emits (parity with the
// deterministic CCD/FHIR importer). These are the PRE-persist AI shapes: statuses
// stay as the model's raw string (normalized to the CHECK sets in import-shape),
// dates are already coerced to strict ISO-or-null, and providers/facilities are
// captured as plain names (resolved into the shared providers registry on persist).
export interface ExtractedCondition {
  name: string;
  code: string | null;
  code_system: string | null;
  status: string | null; // raw clinical status; normalized in import-shape
  onset_date: string | null; // YYYY-MM-DD
  resolved_date: string | null; // YYYY-MM-DD
}

export interface ExtractedAllergy {
  substance: string;
  substance_code: string | null;
  substance_code_system: string | null;
  reaction: string | null;
  severity: string | null;
  status: string | null; // raw clinical status; normalized in import-shape
  onset_date: string | null; // YYYY-MM-DD
}

export interface ExtractedProcedure {
  name: string;
  code: string | null;
  code_system: string | null;
  date: string | null; // YYYY-MM-DD
}

export interface ExtractedEncounter {
  date: string; // YYYY-MM-DD (required — a dateless encounter is dropped)
  end_date: string | null; // YYYY-MM-DD
  type: string | null;
  class_code: string | null;
  reason: string | null;
  diagnoses: string[];
  provider: string | null; // attending clinician name (resolved on persist)
  location: string | null; // facility name (resolved on persist)
  notes: string | null;
}

export interface ExtractedFamilyHistory {
  relation: string | null;
  condition: string;
  code: string | null;
  code_system: string | null;
  onset_age: number | null;
  deceased: number | null; // 1/0/null
}

export interface ExtractedCarePlanItem {
  description: string;
  code: string | null;
  code_system: string | null;
  category: string | null;
  planned_date: string | null; // YYYY-MM-DD
  status: string | null; // free-text passthrough (no enum)
}

export interface ExtractedCareGoal {
  description: string;
  code: string | null;
  code_system: string | null;
  target_date: string | null; // YYYY-MM-DD
  status: string | null; // free-text passthrough (no enum)
}

export interface ExtractionMeta {
  document_type: string | null; // lab | dexa | imaging | immunization | other
  source: string | null;
  patient_name: string | null;
  patient_sex: Sex | null; // the patient's stated sex, when the document gives it
  patient_birthdate: string | null; // the patient's DOB (YYYY-MM-DD), when stated
  patient_age: number | null; // the patient's age in years, when stated without a DOB
  document_date: string | null; // YYYY-MM-DD
}

// Normalize a document's stated sex/gender ("M", "Female", "MALE", …) to our
// canonical Sex, or null when absent/unrecognized (e.g. "unknown", "other").
export function normalizeSex(raw: unknown): Sex | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "m" || s === "male" || s === "man") return "male";
  if (s === "f" || s === "female" || s === "woman") return "female";
  return null;
}

// Accept a birthdate only in strict ISO YYYY-MM-DD form; anything else (a bare
// year, a locale-formatted date, junk) is dropped rather than guessed.
export function normalizeBirthdate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Normalize a stated age to a plausible whole number of years, from either a
// number or a numeric string ("45", "45 years"). Null when absent/implausible.
export function normalizeAge(raw: unknown): number | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? parseInt(raw, 10)
        : NaN;
  return Number.isFinite(n) && n > 0 && n < 150 ? Math.round(n) : null;
}

export type ExtractionResult =
  | {
      status: "done";
      meta: ExtractionMeta;
      results: ExtractedResult[];
      immunizations: ExtractedImmunization[];
      conditions: ExtractedCondition[];
      allergies: ExtractedAllergy[];
      procedures: ExtractedProcedure[];
      encounters: ExtractedEncounter[];
      familyHistory: ExtractedFamilyHistory[];
      carePlanItems: ExtractedCarePlanItem[];
      careGoals: ExtractedCareGoal[];
      // Row-level drops (a clinical entity the model emitted but that was rejected
      // for want of its required identifier) — the AI path's drop accounting, folded
      // into a real ImportReport in import-shape. Parity with the deterministic
      // importer, which was previously the only path with a report.
      drops: ImportDrop[];
      model: string;
      raw: string;
    }
  | { status: "skipped"; message: string }
  | { status: "failed"; error: string };

// Map common file types to the kind of content block we send to the model.
const IMAGE_TYPES: Record<
  string,
  "image/png" | "image/jpeg" | "image/webp" | "image/gif"
> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function ext(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return m ? m[1].toLowerCase() : "";
}

export function isSupportedFile(filename: string, mime: string): boolean {
  const e = ext(filename);
  if (e === "pdf" || e === "csv" || e === "xlsx") return true;
  if (e in IMAGE_TYPES) return true;
  return (
    mime === "application/pdf" ||
    mime.startsWith("image/") ||
    mime === "text/csv"
  );
}

// Render a single exceljs cell value as plain text. exceljs surfaces rich
// cells as objects (formulas, hyperlinks, rich text, errors) and dates as JS
// Date, so flatten each to the text a reader would see.
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const o = value as unknown as {
      richText?: { text?: string }[];
      text?: unknown;
      result?: ExcelJS.CellValue;
      error?: unknown;
      formula?: unknown;
    };
    if (Array.isArray(o.richText)) {
      return o.richText.map((r) => r.text ?? "").join("");
    }
    if (o.text !== undefined) return String(o.text); // hyperlink
    if (o.result !== undefined) return cellText(o.result); // formula
    if (o.error !== undefined) return String(o.error);
    return "";
  }
  return String(value);
}

// CSV-quote a field the way a spreadsheet export would (RFC 4180): wrap in
// double quotes and double any interior quote when it contains a comma, quote,
// or newline.
function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Convert a spreadsheet buffer into a readable plain-text representation
// (one labelled CSV block per sheet) for the model to read. exceljs reads the
// OOXML .xlsx format only (legacy binary .xls is not supported).
export async function spreadsheetToText(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  // exceljs's `Buffer` type and Node 24's global `Buffer` resolve to
  // incompatible declarations; cast to the method's own parameter type.
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const parts: string[] = [];
  wb.eachSheet((ws) => {
    const colCount = ws.columnCount;
    const lines: string[] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= colCount; c++) {
        cells.push(csvField(cellText(row.getCell(c).value)));
      }
      lines.push(cells.join(","));
    });
    parts.push(`# Sheet: ${ws.name}\n${lines.join("\n")}`);
  });
  return parts.join("\n\n");
}

const SYSTEM = `You are a medical-records data-extraction engine. You are given a single
medical document (a lab report, DEXA/body-composition scan, imaging report, or a spreadsheet
of results). Extract every individual measurable result into structured rows by calling the
save_medical_data tool exactly once.

Rules:
- Emit ONE entry per analyte / metric / measurement (e.g. each lab test, each DEXA region's
  BMD/T-score/Z-score, each body-composition number). Do not summarise or merge rows.
- canonical_name: a clean, consistent biomarker name for grouping this analyte across
  documents — Title Case. Drop method/processing qualifiers that don't change WHAT is measured
  ("direct"/"calculated"/"serum"/"plasma"): name "LDL CHOL., DIRECT" → canonical_name
  "LDL Cholesterol". But KEEP qualifiers that make it a DIFFERENT measurement so they stay
  separate — especially the specimen/source: blood vs urine creatinine are different
  ("Creatinine" for blood/serum vs "Creatinine, Urine"); likewise random vs 24-hour, total vs
  free vs ratio vs percentage, and vitamin D2 (ergocalciferol) vs D3 (cholecalciferol) — keep
  the D2/D3 suffix so "25-OH Vitamin D2" and "25-OH Vitamin D3" never collapse onto one name.
  When a canonical name from the provided list matches this exact analyte, REUSE it; only coin
  a new one when none fits.
- category: use "lab" for blood/urine/serum lab analytes; "scan" for DEXA, body composition,
  and imaging metrics; "genomics" for genetic results; "prescription" for medications;
  "vitals" for vital signs (BP, HR, temp); "biomarker" only if nothing else fits.
- value: the result as shown. Keep qualitative values verbatim ("NEGATIVE", "YELLOW",
  "Pattern A", "RH(D) POSITIVE"). value_num: the same value as a number ONLY when it is
  purely numeric; otherwise null. For "<0.10" or "<10", set value as the string and
  value_num null.
- unit: the unit if present, else null.
- reference_range: the CONCISE range only (e.g. "<200", "50-180", ">=40", "NEGATIVE"). Do
  NOT copy surrounding guideline text, risk tables, methodology, or disclaimers.
- flag: "high" if marked H / above range, "low" if marked L / below range, "abnormal" for
  non-numeric out-of-range results, "normal" or null otherwise.
- panel: the panel/section heading it appeared under (e.g. "Lipid Panel", "CBC",
  "Comprehensive Metabolic Panel", "Body Composition"), else null.
- notes: leave null. Only set it for a short (<12 words) clinically meaningful note; never
  copy reference paragraphs, citations, methodology, or boilerplate disclaimers.
- collected_date / document_date: ISO YYYY-MM-DD when determinable, else null. Prefer the
  specimen collection date or scan date.
- immunizations: if the document is an immunization record / vaccine card / shot history, emit
  one entry per administered dose in the "immunizations" array — vaccine (the name or brand
  EXACTLY as printed, e.g. "Vaxelis", "Tdap", "Boostrix", "Shingrix", "Yellow Fever"), date
  (ISO YYYY-MM-DD of administration), dose_label (e.g. "Dose 1", "Booster") if shown else null,
  and a short note else null. Set document_type to "immunization" for such documents. A lab
  report with antibody TITERS (e.g. "Measles IgG", "Hepatitis B Surface Antibody") is NOT an
  immunization record — put those in results as normal lab analytes, not in immunizations.
- clinical entities: when the document is a CLINICAL NARRATIVE (a discharge / after-visit
  summary, progress note, or a problem / allergy / surgical-history printout) rather than a pure
  lab or scan report, ALSO extract its structured clinical entities into the matching arrays.
  Emit ONLY what the document actually states; never invent a code, status, or date — leave a
  field null when it isn't printed. Each array is empty for a plain lab/scan report:
  - conditions: problem-list diagnoses (name + ICD-10/SNOMED code when printed; status
    "active"/"inactive"/"resolved" when stated; onset/resolved dates ISO YYYY-MM-DD).
  - allergies: allergies / intolerances (substance + reaction + severity + status). Do NOT emit a
    row for an explicit "no known allergies" / "NKDA" statement — leave the array empty.
  - procedures: procedures / surgical history (name + code + performed date ISO YYYY-MM-DD).
  - encounters: the visit(s) the document describes (date, end/discharge date, type e.g.
    "Office Visit"/"Emergency", class_code AMB/IMP/EMER, reason, attending provider name, facility
    name). A document's own visit diagnoses ALSO go in conditions.
  - family_history: one entry per (relative, condition) pair (relation, condition, onset_age,
    deceased).
  - care_plan: planned / ordered FUTURE care — follow-ups, ordered tests, referrals, planned
    procedures (the "Plan" / "Follow-up" section).
  - care_goals: stated clinical goals / targets (e.g. "A1c < 7.0%").
- Be concise: emit only the structured fields above. Brevity matters — there may be 100+
  results and the response must fit in the output budget.
- Do not invent data. If the document has no extractable results, return empty arrays.`;

const TOOL: Anthropic.Tool = {
  name: "save_medical_data",
  description: "Save the structured data extracted from the medical document.",
  input_schema: {
    type: "object",
    properties: {
      document_type: {
        type: "string",
        description: "One of: lab, dexa, imaging, other",
      },
      source: {
        type: ["string", "null"],
        description:
          "Lab/provider that produced the document, e.g. 'Quest Diagnostics'",
      },
      patient_name: { type: ["string", "null"] },
      patient_sex: {
        type: ["string", "null"],
        description:
          "The patient's sex/gender as stated on the document, normalized to 'male' or 'female'. Null if not stated or not clearly one of those.",
      },
      patient_birthdate: {
        type: ["string", "null"],
        description:
          "The patient's date of birth as ISO YYYY-MM-DD, if the document states one. Null otherwise.",
      },
      patient_age: {
        type: ["number", "null"],
        description:
          "The patient's age in whole years, if the document states an age but not a date of birth. Null otherwise.",
      },
      document_date: {
        type: ["string", "null"],
        description: "Primary date of the document, ISO YYYY-MM-DD",
      },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: CATEGORIES },
            panel: { type: ["string", "null"] },
            name: { type: "string" },
            canonical_name: {
              type: "string",
              description:
                "Clean canonical biomarker name for cross-document grouping; reuse a provided one when it matches",
            },
            value: { type: ["string", "null"] },
            value_num: { type: ["number", "null"] },
            unit: { type: ["string", "null"] },
            reference_range: { type: ["string", "null"] },
            flag: { type: ["string", "null"], enum: [...FLAGS, null] },
            collected_date: { type: ["string", "null"] },
            notes: { type: ["string", "null"] },
          },
          required: ["category", "name", "canonical_name"],
        },
      },
      immunizations: {
        type: "array",
        description:
          "Vaccine administrations from an immunization record / vaccine card. Empty for lab reports, scans, and other documents.",
        items: {
          type: "object",
          properties: {
            vaccine: {
              type: "string",
              description:
                "Vaccine or brand name exactly as printed, e.g. 'Vaxelis', 'Tdap', 'Boostrix', 'Shingrix', 'Yellow Fever'",
            },
            date: {
              type: ["string", "null"],
              description: "Date administered, ISO YYYY-MM-DD",
            },
            dose_label: { type: ["string", "null"] },
            notes: { type: ["string", "null"] },
          },
          required: ["vaccine"],
        },
      },
      conditions: {
        type: "array",
        description:
          "Problem-list diagnoses / conditions stated on the document. Empty for a plain lab/scan report.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "The condition/diagnosis display name, e.g. 'Type 2 diabetes mellitus'",
            },
            code: {
              type: ["string", "null"],
              description: "ICD-10 / SNOMED code if printed, else null",
            },
            code_system: {
              type: ["string", "null"],
              description:
                "Code system, e.g. 'ICD-10-CM' or 'SNOMED', else null",
            },
            status: {
              type: ["string", "null"],
              description:
                "Clinical status if stated: active, inactive, or resolved. Null otherwise.",
            },
            onset_date: {
              type: ["string", "null"],
              description: "Onset date, ISO YYYY-MM-DD, else null",
            },
            resolved_date: {
              type: ["string", "null"],
              description: "Resolution date, ISO YYYY-MM-DD, else null",
            },
          },
          required: ["name"],
        },
      },
      allergies: {
        type: "array",
        description:
          "Allergies / intolerances stated on the document. Do NOT emit a row for an explicit 'no known allergies' statement — leave the array empty.",
        items: {
          type: "object",
          properties: {
            substance: {
              type: "string",
              description:
                "The offending agent (drug/food/environmental), e.g. 'Penicillin'",
            },
            substance_code: { type: ["string", "null"] },
            substance_code_system: { type: ["string", "null"] },
            reaction: {
              type: ["string", "null"],
              description: "Reaction / manifestation as printed, e.g. 'Hives'",
            },
            severity: {
              type: ["string", "null"],
              description: "mild / moderate / severe, or as printed",
            },
            status: {
              type: ["string", "null"],
              description: "active, inactive, or resolved. Null if not stated.",
            },
            onset_date: {
              type: ["string", "null"],
              description: "Onset date, ISO YYYY-MM-DD, else null",
            },
          },
          required: ["substance"],
        },
      },
      procedures: {
        type: "array",
        description: "Procedures / surgical history stated on the document.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Procedure display name, e.g. 'Appendectomy'",
            },
            code: {
              type: ["string", "null"],
              description:
                "CPT / SNOMED / ICD-10-PCS code if printed, else null",
            },
            code_system: { type: ["string", "null"] },
            date: {
              type: ["string", "null"],
              description: "Performed date, ISO YYYY-MM-DD, else null",
            },
          },
          required: ["name"],
        },
      },
      encounters: {
        type: "array",
        description:
          "Visits / encounters the document describes (an after-visit or discharge summary usually describes ONE). The visit's diagnoses ALSO go in conditions.",
        items: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "Visit/admission date, ISO YYYY-MM-DD",
            },
            end_date: {
              type: ["string", "null"],
              description: "Discharge/end date, ISO YYYY-MM-DD, else null",
            },
            type: {
              type: ["string", "null"],
              description:
                "Encounter type display, e.g. 'Office Visit', 'Emergency', 'Inpatient'",
            },
            class_code: {
              type: ["string", "null"],
              description:
                "HL7 encounter class if known: AMB (ambulatory), IMP (inpatient), EMER (emergency). Else null.",
            },
            reason: {
              type: ["string", "null"],
              description: "Chief complaint / reason for visit",
            },
            diagnoses: {
              type: "array",
              items: { type: "string" },
              description: "Visit diagnosis display names",
            },
            provider: {
              type: ["string", "null"],
              description:
                "Attending/treating clinician name, e.g. 'Grace Hopper, MD'",
            },
            location: {
              type: ["string", "null"],
              description: "Facility / clinic / hospital name",
            },
            notes: {
              type: ["string", "null"],
              description: "A short visit summary note, else null",
            },
          },
          required: ["date"],
        },
      },
      family_history: {
        type: "array",
        description:
          "Family medical history — one condition affecting one relative.",
        items: {
          type: "object",
          properties: {
            relation: {
              type: ["string", "null"],
              description: "Affected relative: mother / father / sibling / …",
            },
            condition: {
              type: "string",
              description: "The relative's condition display name",
            },
            code: { type: ["string", "null"] },
            code_system: { type: ["string", "null"] },
            onset_age: {
              type: ["number", "null"],
              description: "Relative's age (years) at onset, if stated",
            },
            deceased: {
              type: ["boolean", "null"],
              description: "Whether the relative is deceased, if stated",
            },
          },
          required: ["condition"],
        },
      },
      care_plan: {
        type: "array",
        description:
          "Planned / ordered FUTURE care — follow-ups, ordered tests, referrals, planned procedures (the 'Plan' / 'Follow-up' section).",
        items: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description:
                "The planned activity, e.g. 'Follow up in 3 months', 'Order lipid panel'",
            },
            code: { type: ["string", "null"] },
            code_system: { type: ["string", "null"] },
            category: {
              type: ["string", "null"],
              description:
                "procedure / encounter / medication / observation / … if classifiable",
            },
            planned_date: {
              type: ["string", "null"],
              description: "Scheduled/intended date, ISO YYYY-MM-DD, else null",
            },
            status: {
              type: ["string", "null"],
              description:
                "Lifecycle status if stated (planned / active / completed / …)",
            },
          },
          required: ["description"],
        },
      },
      care_goals: {
        type: "array",
        description:
          "Clinical goals / targets stated on the document (the 'Goals' section), e.g. 'A1c < 7.0%'.",
        items: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "The goal statement",
            },
            code: { type: ["string", "null"] },
            code_system: { type: ["string", "null"] },
            target_date: {
              type: ["string", "null"],
              description: "Target date, ISO YYYY-MM-DD, else null",
            },
            status: {
              type: ["string", "null"],
              description:
                "Lifecycle status if stated (proposed / active / achieved / …)",
            },
          },
          required: ["description"],
        },
      },
    },
    required: ["document_type", "results"],
  },
};

// Cap how many known canonical names we inject, to keep the prompt bounded.
const VOCAB_CAP = 400;

async function buildContent(
  buffer: Buffer,
  mime: string,
  filename: string,
  knownCanonical: string[] = []
): Promise<Anthropic.ContentBlockParam[]> {
  const e = ext(filename);
  const instruction: Anthropic.TextBlockParam = {
    type: "text",
    text: "Extract all structured results from this medical document using the save_medical_data tool.",
  };
  const vocab = knownCanonical.slice(0, VOCAB_CAP);
  const vocabBlock: Anthropic.TextBlockParam | null = vocab.length
    ? {
        type: "text",
        text: `Canonical biomarker names to reuse when an analyte matches (set canonical_name to the matching entry; only coin a new name when none fits):\n${vocab.join(
          ", "
        )}`,
      }
    : null;
  const tail = vocabBlock ? [instruction, vocabBlock] : [instruction];

  if (e === "pdf" || mime === "application/pdf") {
    return [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: buffer.toString("base64"),
        },
      },
      ...tail,
    ];
  }

  const imageType =
    IMAGE_TYPES[e] ?? (mime.startsWith("image/") ? (mime as any) : null);
  if (imageType) {
    return [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: imageType,
          data: buffer.toString("base64"),
        },
      },
      ...tail,
    ];
  }

  if (e === "xlsx") {
    return [
      {
        type: "text",
        text: `Spreadsheet "${filename}" contents:\n\n${await spreadsheetToText(buffer)}`,
      },
      ...tail,
    ];
  }

  // CSV / fallback: treat as UTF-8 text.
  return [
    {
      type: "text",
      text: `File "${filename}" contents:\n\n${buffer.toString("utf8")}`,
    },
    ...tail,
  ];
}

function normalizeResults(
  raw: any,
  knownCanonical: string[] = []
): ExtractedResult[] {
  const arr = Array.isArray(raw?.results) ? raw.results : [];
  const out: ExtractedResult[] = [];
  // The model is asked to reuse a canonical name but frequently mirrors the
  // report's spelling instead; snap it back onto the known vocabulary in code
  // so cross-document grouping doesn't depend on the model being consistent.
  const canonicalIndex = buildCanonicalIndex(knownCanonical);
  for (const r of arr) {
    const name = typeof r?.name === "string" ? r.name.trim() : "";
    if (!name) continue;
    const category: MedicalCategory = CATEGORIES.includes(r?.category)
      ? r.category
      : "lab";
    const flag: MedicalFlag | null = FLAGS.includes(r?.flag) ? r.flag : null;
    const valueNum =
      typeof r?.value_num === "number" && Number.isFinite(r.value_num)
        ? r.value_num
        : null;
    const str = strOrNull;
    // Fall back to the raw name when the model omits or blanks the canonical.
    // Recover the D2/D3 vitamin-D isoform from the verbatim lab name first (the
    // model tends to drop it and collapse both metabolites onto one series),
    // then snap onto a matching vocabulary entry when one exists.
    const canonicalName = snapCanonicalName(
      distinguishVitaminDIsoform(str(r?.canonical_name) ?? name, name),
      canonicalIndex
    );
    out.push({
      category,
      panel: str(r?.panel),
      name,
      canonical_name: canonicalName,
      value: str(r?.value),
      value_num: valueNum,
      unit: str(r?.unit),
      reference_range: str(r?.reference_range),
      flag,
      collected_date: str(r?.collected_date),
      notes: str(r?.notes),
    });
  }
  return out;
}

// Normalize the model's immunizations array into typed entries. Light-touch:
// vaccine-name matching and date validation happen downstream in
// lib/immunization-extract (shared with the manual path); here we only coerce
// shapes and drop entries with no vaccine name.
function normalizeImmunizations(raw: any): ExtractedImmunization[] {
  const arr = Array.isArray(raw?.immunizations) ? raw.immunizations : [];
  const out: ExtractedImmunization[] = [];
  for (const it of arr) {
    const vaccine = typeof it?.vaccine === "string" ? it.vaccine.trim() : "";
    if (!vaccine) continue;
    out.push({
      vaccine,
      date: strOrNull(it?.date),
      dose_label: strOrNull(it?.dose_label),
      notes: strOrNull(it?.notes),
    });
  }
  return out;
}

// Coerce a model-supplied date to strict ISO YYYY-MM-DD, else null. The DB stores
// dates as ISO strings, so a bare year / locale format / junk is dropped (a null
// date column) rather than guessed.
function isoDateOrNull(raw: unknown): string | null {
  const s = strOrNull(raw);
  return s && isRealIsoDate(s) ? s : null;
}

// A finite number from a number or numeric string, else null (family-history onset age).
function finiteOrNull(raw: unknown): number | null {
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

// The model may report `deceased` as a boolean, 0/1, or a yes/no string; collapse
// to the DB's 1/0/null. Unknown → null (not "alive").
function boolIntOrNull(raw: unknown): number | null {
  if (raw === true || raw === 1) return 1;
  if (raw === false || raw === 0) return 0;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "true" || v === "yes" || v === "y" || v === "deceased") return 1;
    if (v === "false" || v === "no" || v === "n" || v === "alive") return 0;
  }
  return null;
}

// Normalize the model's clinical-narrative arrays (conditions / allergies /
// procedures / encounters / family history / care plan / care goals) into typed
// entries, collecting an ImportDrop for every entry rejected for want of its
// required identifier (name / substance / condition / description / visit date).
// This is the AI path's strict validator + drop accounting: garbage entries drop
// with a reported reason rather than being silently dropped or silently landed.
// Status-enum normalization and provider resolution happen downstream in
// import-shape (extractionToPersistInput); this stays a pure shape coercion.
export function normalizeClinicalDomains(raw: any): {
  conditions: ExtractedCondition[];
  allergies: ExtractedAllergy[];
  procedures: ExtractedProcedure[];
  encounters: ExtractedEncounter[];
  familyHistory: ExtractedFamilyHistory[];
  carePlanItems: ExtractedCarePlanItem[];
  careGoals: ExtractedCareGoal[];
  drops: ImportDrop[];
} {
  const drops: ImportDrop[] = [];
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

  const conditions: ExtractedCondition[] = [];
  for (const c of arr(raw?.conditions)) {
    const name = strOrNull(c?.name);
    if (!name) {
      drops.push({
        kind: "condition",
        label: "(unnamed condition)",
        reason: "no_value",
      });
      continue;
    }
    conditions.push({
      name,
      code: strOrNull(c?.code),
      code_system: strOrNull(c?.code_system),
      status: strOrNull(c?.status),
      onset_date: isoDateOrNull(c?.onset_date),
      resolved_date: isoDateOrNull(c?.resolved_date),
    });
  }

  const allergies: ExtractedAllergy[] = [];
  for (const a of arr(raw?.allergies)) {
    const substance = strOrNull(a?.substance);
    if (!substance) {
      drops.push({
        kind: "allergy",
        label: "(unnamed allergy)",
        reason: "no_value",
      });
      continue;
    }
    allergies.push({
      substance,
      substance_code: strOrNull(a?.substance_code),
      substance_code_system: strOrNull(a?.substance_code_system),
      reaction: strOrNull(a?.reaction),
      severity: strOrNull(a?.severity),
      status: strOrNull(a?.status),
      onset_date: isoDateOrNull(a?.onset_date),
    });
  }

  const procedures: ExtractedProcedure[] = [];
  for (const p of arr(raw?.procedures)) {
    const name = strOrNull(p?.name);
    if (!name) {
      drops.push({
        kind: "procedure",
        label: "(unnamed procedure)",
        reason: "no_value",
      });
      continue;
    }
    procedures.push({
      name,
      code: strOrNull(p?.code),
      code_system: strOrNull(p?.code_system),
      date: isoDateOrNull(p?.date),
    });
  }

  const encounters: ExtractedEncounter[] = [];
  for (const e of arr(raw?.encounters)) {
    // A visit MUST carry a resolvable date (the encounters.date column is NOT NULL);
    // a dateless entry can't be placed on the timeline, so it drops.
    const date = isoDateOrNull(e?.date);
    if (!date) {
      drops.push({
        kind: "encounter",
        label: strOrNull(e?.type) ?? "(undated visit)",
        reason: "no_value",
      });
      continue;
    }
    encounters.push({
      date,
      end_date: isoDateOrNull(e?.end_date),
      type: strOrNull(e?.type),
      class_code: strOrNull(e?.class_code),
      reason: strOrNull(e?.reason),
      diagnoses: arr(e?.diagnoses)
        .map((d) => strOrNull(d))
        .filter((d): d is string => !!d),
      provider: strOrNull(e?.provider),
      location: strOrNull(e?.location),
      notes: strOrNull(e?.notes),
    });
  }

  const familyHistory: ExtractedFamilyHistory[] = [];
  for (const f of arr(raw?.family_history)) {
    const condition = strOrNull(f?.condition);
    if (!condition) {
      drops.push({
        kind: "family_history",
        label: strOrNull(f?.relation) ?? "(family history)",
        reason: "no_value",
      });
      continue;
    }
    familyHistory.push({
      relation: strOrNull(f?.relation),
      condition,
      code: strOrNull(f?.code),
      code_system: strOrNull(f?.code_system),
      onset_age: finiteOrNull(f?.onset_age),
      deceased: boolIntOrNull(f?.deceased),
    });
  }

  const carePlanItems: ExtractedCarePlanItem[] = [];
  for (const c of arr(raw?.care_plan)) {
    const description = strOrNull(c?.description);
    if (!description) {
      drops.push({
        kind: "care_plan",
        label: "(care plan item)",
        reason: "no_value",
      });
      continue;
    }
    carePlanItems.push({
      description,
      code: strOrNull(c?.code),
      code_system: strOrNull(c?.code_system),
      category: strOrNull(c?.category),
      planned_date: isoDateOrNull(c?.planned_date),
      status: strOrNull(c?.status),
    });
  }

  const careGoals: ExtractedCareGoal[] = [];
  for (const g of arr(raw?.care_goals)) {
    const description = strOrNull(g?.description);
    if (!description) {
      drops.push({
        kind: "care_goal",
        label: "(care goal)",
        reason: "no_value",
      });
      continue;
    }
    careGoals.push({
      description,
      code: strOrNull(g?.code),
      code_system: strOrNull(g?.code_system),
      target_date: isoDateOrNull(g?.target_date),
      status: strOrNull(g?.status),
    });
  }

  return {
    conditions,
    allergies,
    procedures,
    encounters,
    familyHistory,
    carePlanItems,
    careGoals,
    drops,
  };
}

export async function extractMedicalDocument(
  buffer: Buffer,
  mime: string,
  filename: string,
  knownCanonical: string[] = []
): Promise<ExtractionResult> {
  if (!aiConfigured()) {
    log.info("skipped (AI not configured)", { filename });
    recordAiEvent({
      feature: "extraction",
      status: "skipped",
      detail: `${filename} — AI not configured`,
    });
    return {
      status: "skipped",
      message:
        "AI not configured — file stored but not extracted. Set ANTHROPIC_API_KEY (or AI_BASE_URL for a local inference server) and re-upload to import results.",
    };
  }

  let content: Anthropic.ContentBlockParam[];
  try {
    content = await buildContent(buffer, mime, filename, knownCanonical);
  } catch (err) {
    log.error("failed to read file", { filename, err });
    recordAiEvent({
      feature: "extraction",
      status: "failed",
      detail: filename,
      error: `Could not read file: ${err instanceof Error ? err.message : "unknown error"}`,
    });
    return {
      status: "failed",
      error: `Could not read file: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  const startedAt = Date.now();
  log.info("extraction started", {
    filename,
    bytes: buffer.length,
    mime,
    model: MODEL,
  });

  try {
    const client = createAiClient();
    // Stream the request (then await the assembled message). Extraction of a
    // large document can run for minutes; a non-streaming request sends no
    // bytes during generation, so the connection is prone to being dropped
    // ("APIConnectionError: Connection error."). Streaming keeps token flow on
    // the wire to hold the connection open. We don't consume the deltas — the
    // final message has the same shape as messages.create — so there's no
    // incremental parsing here.
    const msg = await client.messages
      .stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "save_medical_data" },
        messages: [{ role: "user", content }],
      })
      .finalMessage();

    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (!toolUse) {
      log.error("failed: model returned no structured data", {
        filename,
        secs,
        stop_reason: msg.stop_reason,
      });
      recordAiEvent({
        feature: "extraction",
        status: "failed",
        model: MODEL,
        durationMs: Date.now() - startedAt,
        detail: filename,
        error: "Model returned no structured data.",
      });
      return { status: "failed", error: "Model returned no structured data." };
    }

    const input = toolUse.input as any;
    const results = normalizeResults(input, knownCanonical);
    const immunizations = normalizeImmunizations(input);
    const clinical = normalizeClinicalDomains(input);

    // If the model ran out of output budget, the results array is likely
    // truncated (or empty). Surface that instead of silently importing a
    // partial set as "done".
    if (msg.stop_reason === "max_tokens") {
      log.error("failed: truncated at output limit", {
        filename,
        secs,
        parsed: results.length,
        max_tokens: MAX_TOKENS,
      });
      recordAiEvent({
        feature: "extraction",
        status: "failed",
        model: MODEL,
        durationMs: Date.now() - startedAt,
        detail: `${filename} — ${results.length} parsed before truncation`,
        error: `Truncated at the output limit (${MAX_TOKENS} tokens).`,
      });
      return {
        status: "failed",
        error: `Extraction was truncated at the output limit (${MAX_TOKENS} tokens) with ${results.length} result(s) parsed. Raise HEALTH_AI_MAX_TOKENS or split the document, then re-upload.`,
      };
    }
    const meta: ExtractionMeta = {
      document_type:
        typeof input?.document_type === "string" ? input.document_type : null,
      source: typeof input?.source === "string" ? input.source : null,
      patient_name:
        typeof input?.patient_name === "string" ? input.patient_name : null,
      patient_sex: normalizeSex(input?.patient_sex),
      patient_birthdate: normalizeBirthdate(input?.patient_birthdate),
      patient_age: normalizeAge(input?.patient_age),
      document_date:
        typeof input?.document_date === "string" ? input.document_date : null,
    };

    const clinicalCount =
      clinical.conditions.length +
      clinical.allergies.length +
      clinical.procedures.length +
      clinical.encounters.length +
      clinical.familyHistory.length +
      clinical.carePlanItems.length +
      clinical.careGoals.length;

    log.info("extraction done", {
      filename,
      secs,
      results: results.length,
      clinical: clinicalCount,
      dropped: clinical.drops.length,
      usage: msg.usage
        ? { in: msg.usage.input_tokens, out: msg.usage.output_tokens }
        : undefined,
    });

    recordAiEvent({
      feature: "extraction",
      status: "ok",
      model: MODEL,
      durationMs: Date.now() - startedAt,
      detail: capDetail(
        `${filename} — ${results.length} record(s)` +
          (clinicalCount ? `, ${clinicalCount} clinical` : "") +
          (LOG_PROMPTS ? `\nresponse: ${JSON.stringify(input)}` : "")
      ),
    });
    return {
      status: "done",
      meta,
      results,
      immunizations,
      conditions: clinical.conditions,
      allergies: clinical.allergies,
      procedures: clinical.procedures,
      encounters: clinical.encounters,
      familyHistory: clinical.familyHistory,
      carePlanItems: clinical.carePlanItems,
      careGoals: clinical.careGoals,
      drops: clinical.drops,
      model: MODEL,
      raw: JSON.stringify(input),
    };
  } catch (err) {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const message = describeError(err);
    // Full detail to the server log; actionable summary to the user.
    log.error("extraction failed", {
      filename,
      secs,
      kind: err?.constructor?.name,
      err,
    });
    recordAiEvent({
      feature: "extraction",
      status: "failed",
      model: MODEL,
      durationMs: Date.now() - startedAt,
      detail: filename,
      error: message,
    });
    return { status: "failed", error: message };
  }
}
