// The SERVER-ONLY half of grounded record Q&A (issue #878, Phase 2). Split out of
// lib/record-qa.ts precisely so the pure/client-safe half (the RecordCitation type, the
// DOMAIN_LABEL map, and the pure assembly helpers) can be imported by the command
// palette (a "use client" component) WITHOUT pulling the AI SDK / node:fs into the
// browser bundle. This module resolves an AI client and writes the ai-log, mirroring
// lib/explain-finding.ts — it is Node-only and must never be imported from a client
// component.

import Anthropic from "@anthropic-ai/sdk";
import { resolveTaskClient } from "./ai-resolve";
import { recordAiEvent, capDetail, LOG_PROMPTS, usageFrom } from "./ai-log";
import {
  ASK_SYSTEM,
  buildAskPrompt,
  composeOfflineAnswer,
  type AskInput,
  type AskResult,
} from "./record-qa";

// Answer a grounded record question — narrate over the retrieved citations via the
// Light tier, or fall back to the offline composition. The EMPTY-RETRIEVAL REFUSAL is
// enforced HERE and takes precedence over everything: no citations ⇒ "Nothing found",
// and the model is never called (retrieval-empty must never reach a prompt, or the
// model could answer from memory). `citations` is the caller's already-gathered,
// profile-scoped set; this function does no DB work and no auth.
export async function answerRecordQuestion(
  input: AskInput
): Promise<AskResult> {
  const { question, citations } = input;

  // Deterministic refusal — never speculate, never call the model on an empty set.
  if (citations.length === 0) {
    recordAiEvent({
      feature: "ask",
      status: "skipped",
      detail: `${question} — no matching records`,
    });
    return {
      answer: composeOfflineAnswer(question, citations),
      citations,
      offline: true,
    };
  }

  const offline = composeOfflineAnswer(question, citations);
  const resolved = resolveTaskClient("ask");
  if (!resolved) {
    recordAiEvent({
      feature: "ask",
      status: "skipped",
      detail: `${question} — AI not configured`,
    });
    return { answer: offline, citations, offline: true };
  }
  const { client, model, tier, host } = resolved;

  const startedAt = Date.now();
  try {
    const msg = await client.messages
      .stream({
        model,
        max_tokens: 400,
        system: ASK_SYSTEM,
        messages: [
          { role: "user", content: buildAskPrompt(question, citations) },
        ],
      })
      .finalMessage();
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (msg.stop_reason === "max_tokens" || !text) {
      recordAiEvent({
        feature: "ask",
        status: "failed",
        model,
        tier,
        baseUrl: host,
        durationMs: Date.now() - startedAt,
        detail: question,
        error:
          msg.stop_reason === "max_tokens"
            ? "Truncated at the output limit."
            : "Empty answer returned.",
      });
      return { answer: offline, citations, offline: true };
    }
    recordAiEvent({
      feature: "ask",
      status: "ok",
      model,
      tier,
      baseUrl: host,
      durationMs: Date.now() - startedAt,
      usage: usageFrom(msg),
      detail: capDetail(question + (LOG_PROMPTS ? `\n${text}` : "")),
    });
    return { answer: text, citations, offline: false, model };
  } catch (err) {
    recordAiEvent({
      feature: "ask",
      status: "failed",
      model,
      tier,
      baseUrl: host,
      durationMs: Date.now() - startedAt,
      detail: question,
      error: err instanceof Error ? err.message : "unknown error",
    });
    return { answer: offline, citations, offline: true };
  }
}
