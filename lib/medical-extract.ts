import Anthropic, {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";
import type { MedicalCategory, MedicalFlag, Sex } from "./types";
import { AI_MODEL, aiConfigured, createAiClient } from "./ai-client";
import { createLogger } from "./log";
import { recordAiEvent, capDetail, LOG_PROMPTS } from "./ai-log";
import { strOrNull } from "./parse";
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

const CATEGORIES: MedicalCategory[] = [
  "vitals",
  "lab",
  "genomics",
  "biomarker",
  "scan",
  "prescription",
];
// The AI emits only clinical flags from the lab's reference range. "non-optimal"
// is NOT here on purpose: it's a DERIVED flag we reconcile from the canonical
// optimal band, so the model can't set it (which would contradict that band).
const FLAGS: MedicalFlag[] = ["normal", "high", "low", "abnormal"];

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

    log.info("extraction done", {
      filename,
      secs,
      results: results.length,
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
          (LOG_PROMPTS ? `\nresponse: ${JSON.stringify(input)}` : "")
      ),
    });
    return {
      status: "done",
      meta,
      results,
      immunizations,
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
