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
} from "./normalize";
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
      clinical.careGoals.length +
      clinical.genomicVariants.length;

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
      usage: usageFrom(msg),
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
      genomicVariants: clinical.genomicVariants,
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
