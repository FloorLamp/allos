// Extraction orchestrator: read the file, call the model (streamed), and map its
// structured tool output into an ExtractionResult. Plus the SDK error-to-sentence
// mapper the workout extractor shares.
import Anthropic, {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from "@anthropic-ai/sdk";
import { aiConfigured, createAiClient } from "../ai-client";
import { createLogger } from "../log";
import { recordAiEvent, capDetail, LOG_PROMPTS, usageFrom } from "../ai-log";
import { MODEL, MAX_TOKENS } from "./constants";
import { SYSTEM, TOOL, buildContent } from "./prompt";
import {
  normalizeResults,
  normalizeImmunizations,
  normalizeClinicalDomains,
  normalizeSex,
  normalizeBirthdate,
  normalizeAge,
  unwrapExtractionInput,
  looksLikeExtractionInput,
} from "./normalize";
import { reconcileAgainstSource } from "./reconcile";
import type { ExtractionResult, ExtractionMeta } from "./types";

// Prefix server logs so extraction activity is easy to grep in the dev/prod
// console. One line per lifecycle event (start / done / skipped / failed).
const log = createLogger("medical-extract");

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

// The successful arm of the union — what a parsed tool input reduces to.
export type ExtractionSuccess = Extract<ExtractionResult, { status: "done" }>;

// Turn a model tool input into the ExtractionResult payload: normalize every
// domain + the patient metadata, and record the input verbatim as `raw`.
//
// Shared by the two paths that produce a result from the SAME shape — the live AI
// extraction (below) and the re-import of a document's STORED raw_extraction
// (reprocessFromRawById, lib/medical-pipeline) — so re-normalizing a saved
// extraction can never drift from how it was parsed the first time. Deliberately
// free of API concerns (token usage, stop_reason, AI-log events): those belong to
// the live call, not to a replay of its output.
//
// The caller is responsible for unwrapping + shape-guarding the input first
// (unwrapExtractionInput / looksLikeExtractionInput); this assumes a payload.
export function resultFromExtractionInput(
  input: any,
  knownCanonical: string[],
  model: string
): ExtractionSuccess {
  const results = normalizeResults(input, knownCanonical);
  const immunizations = normalizeImmunizations(input);
  const clinical = normalizeClinicalDomains(input);
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
    genomicVariants: clinical.genomicVariants,
    imagingStudies: clinical.imagingStudies,
    drops: clinical.drops,
    model,
    raw: JSON.stringify(input),
  };
}

// How many clinical-domain rows a result carries (logging / detail lines).
export function clinicalCountOf(r: ExtractionSuccess): number {
  return (
    r.conditions.length +
    r.allergies.length +
    r.procedures.length +
    r.encounters.length +
    r.familyHistory.length +
    r.carePlanItems.length +
    r.careGoals.length +
    (r.genomicVariants?.length ?? 0) +
    (r.imagingStudies?.length ?? 0)
  );
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

    // The tool schema is flat, but a model sometimes nests the whole payload under
    // one envelope key ({document_data: {…}}). Lift it — every normalizer below
    // reads `input.results` / `input.conditions` / … directly, so a wrapper used to
    // yield ZERO records with no error.
    const input = unwrapExtractionInput(toolUse.input) as any;

    // If the model ran out of output budget, the results array is likely
    // truncated (or empty). Surface that instead of silently importing a
    // partial set as "done".
    //
    // Checked BEFORE the shape guard below: a truncated response can also be
    // unparseable (cut off before the schema's keys accumulated), and "raise the
    // limit or split the document" is the actionable advice — a shape complaint
    // would send the user to re-extract, which fails identically every time.
    if (msg.stop_reason === "max_tokens") {
      // Count only what's countable: a truncation cut short enough to leave an
      // unrecognizable payload parses to nothing.
      const parsed = looksLikeExtractionInput(input)
        ? normalizeResults(input, knownCanonical).length
        : 0;
      log.error("failed: truncated at output limit", {
        filename,
        secs,
        parsed,
        max_tokens: MAX_TOKENS,
      });
      recordAiEvent({
        feature: "extraction",
        status: "failed",
        model: MODEL,
        durationMs: Date.now() - startedAt,
        detail: `${filename} — ${parsed} parsed before truncation`,
        error: `Truncated at the output limit (${MAX_TOKENS} tokens).`,
      });
      return {
        status: "failed",
        error: `Extraction was truncated at the output limit (${MAX_TOKENS} tokens) with ${parsed} result(s) parsed. Raise HEALTH_AI_MAX_TOKENS or split the document, then re-upload.`,
      };
    }

    // A response that names none of the schema's keys is MISSHAPEN, not empty: the
    // normalizers would return [] for it, which is indistinguishable from a document
    // that genuinely had nothing to extract (that still answers with the schema's
    // keys and empty arrays). Fail loudly instead of finalizing 'done' with 0 rows —
    // a silent zero-import is the worst outcome here, since nothing signals that the
    // document needs another look.
    if (!looksLikeExtractionInput(input)) {
      const keys = Object.keys((toolUse.input as object) ?? {})
        .slice(0, 5)
        .join(", ");
      log.error("failed: unrecognized extraction shape", {
        filename,
        secs,
        keys,
      });
      recordAiEvent({
        feature: "extraction",
        status: "failed",
        model: MODEL,
        durationMs: Date.now() - startedAt,
        // The payload is NOT persisted on a failure (raw_extraction is only written
        // on the success path), so when prompt logging is on, carry it here — it is
        // the only evidence of what the next envelope variant looked like.
        detail: capDetail(
          `${filename} — unrecognized shape (top-level keys: ${keys || "none"})` +
            (LOG_PROMPTS ? `\nresponse: ${JSON.stringify(toolUse.input)}` : "")
        ),
        error: "Model returned an unrecognized response shape.",
      });
      return {
        status: "failed",
        error: `The model returned data in an unrecognized shape (top-level keys: ${keys || "none"}), so nothing could be imported. Reprocess the document to try again.`,
      };
    }

    // Normalize through the SHARED builder, so a later re-import of this
    // document's stored raw_extraction parses identically (#903). The truncation
    // and shape checks above already ran — this point is reached only with a
    // complete, recognized payload.
    const result = resultFromExtractionInput(input, knownCanonical, MODEL);
    const results = result.results;

    // Cross-check the extraction against the source PDF's own text layer — a value the
    // model transcribed wrong or invented, or a name that never appears in the report,
    // is caught deterministically without a second model call (#918 follow-up). Null
    // for a non-PDF or scanned source (nothing to verify); errors are swallowed so a
    // reconciliation problem never fails the import.
    const reconciliation = await reconcileAgainstSource(
      buffer,
      mime,
      results.map((r) => ({
        name: r.name,
        value: r.value,
        value_num: r.value_num,
      }))
    );
    if (reconciliation) {
      const { confirmed, valueMismatch, nameNotFound, total } = reconciliation;
      const fields = {
        filename,
        confirmed,
        valueMismatch,
        nameNotFound,
        total,
      };
      if (valueMismatch || nameNotFound)
        log.warn("source reconciliation flagged rows", fields);
      else log.info("source reconciliation clean", fields);
    }

    const clinicalCount = clinicalCountOf(result);

    log.info("extraction done", {
      filename,
      secs,
      results: results.length,
      clinical: clinicalCount,
      dropped: result.drops.length,
      usage: msg.usage
        ? { in: msg.usage.input_tokens, out: msg.usage.output_tokens }
        : undefined,
    });

    recordAiEvent({
      feature: "extraction",
      status: "ok",
      model: MODEL,
      durationMs: Date.now() - startedAt,
      usage: usageFrom(msg),
      detail: capDetail(
        `${filename} — ${results.length} record(s)` +
          (clinicalCount ? `, ${clinicalCount} clinical` : "") +
          (LOG_PROMPTS ? `\nresponse: ${JSON.stringify(input)}` : "")
      ),
    });
    return result;
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
