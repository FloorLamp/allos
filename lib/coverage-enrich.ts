// The AI DESCRIPTIVE-enrichment fill path for a coverage gap (issue #550, fill
// path 1). Calls the configured AI backend — which, when AI_BASE_URL points at a
// local inference server (#43), keeps every request on the box (zero egress) — to
// generate a short, neutral "what is this" blurb for an uncatalogued item, then
// stores it on the registry row labeled "AI-generated, unverified — not curated."
//
// SAFETY BOUNDARY (issue #550 decision A): the prompt (COVERAGE_ENRICH_SYSTEM in
// lib/coverage-gaps.ts) hard-bars the model from emitting reference ranges, flag
// thresholds, retest cadences, doses, or interaction severities — those drive the
// flag/retest/interaction engines and stay curated. This path only ever produces
// descriptive text; it never touches canonical_biomarkers or any clinical logic.
//
// Degrades gracefully with no AI (returns a typed "not configured" outcome, stores
// nothing), and every call + outcome is logged (#410) and counted against the
// per-profile daily cap (reusing the 'narrative' bucket — a heavier on-demand
// generation, like the recap/lab-trend narratives).

import Anthropic from "@anthropic-ai/sdk";
import { AI_MODEL as MODEL, aiConfigured, createAiClient } from "./ai-client";
import { endpointHost } from "./ai-client";
import { recordAiEvent, capDetail, usageFrom, LOG_PROMPTS } from "./ai-log";
import { checkAndIncrementAiUsage, narrativeDailyLimit } from "./ai-usage";
import {
  getCoverageGap,
  setCoverageGapAiDescription,
} from "./queries/coverage";
import {
  COVERAGE_ENRICH_SYSTEM,
  buildEnrichPrompt,
  clampAiDescription,
} from "./coverage-gaps";

export type EnrichOutcome =
  | { status: "ok"; description: string }
  | { status: "not-configured" }
  | { status: "cap-exhausted" }
  | { status: "not-found" }
  | { status: "failed" };

// Generate + store descriptive context for one tracked gap. profileId-first and
// profile-scoped: the read and the write both filter profile_id, so a forged id
// can't enrich another profile's row.
export async function enrichCoverageGap(
  profileId: number,
  gapId: number
): Promise<EnrichOutcome> {
  const gap = getCoverageGap(profileId, gapId);
  if (!gap) return { status: "not-found" };

  if (!aiConfigured()) {
    recordAiEvent({
      feature: "coverage",
      status: "skipped",
      detail: `${gap.kind}:${gap.itemKey} — AI not configured`,
    });
    return { status: "not-configured" };
  }

  if (
    !checkAndIncrementAiUsage(profileId, "narrative", narrativeDailyLimit())
      .allowed
  ) {
    recordAiEvent({
      feature: "coverage",
      status: "skipped",
      detail: `${gap.kind}:${gap.itemKey} — daily AI limit reached`,
    });
    return { status: "cap-exhausted" };
  }

  const startedAt = Date.now();
  try {
    const client = createAiClient();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: COVERAGE_ENRICH_SYSTEM,
      messages: [
        { role: "user", content: buildEnrichPrompt(gap.kind, gap.label) },
      ],
    });
    const text = clampAiDescription(
      msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    );
    if (!text) {
      recordAiEvent({
        feature: "coverage",
        status: "failed",
        model: MODEL,
        durationMs: Date.now() - startedAt,
        detail: `${gap.kind}:${gap.itemKey}`,
        error: "Empty description returned.",
      });
      return { status: "failed" };
    }
    const source = endpointHost(process.env) ?? "Anthropic API";
    setCoverageGapAiDescription(profileId, gapId, text, source);
    recordAiEvent({
      feature: "coverage",
      status: "ok",
      model: MODEL,
      durationMs: Date.now() - startedAt,
      usage: usageFrom(msg),
      detail: capDetail(
        `${gap.kind}:${gap.itemKey}` + (LOG_PROMPTS ? `\n${text}` : "")
      ),
    });
    return { status: "ok", description: text };
  } catch (err) {
    recordAiEvent({
      feature: "coverage",
      status: "failed",
      model: MODEL,
      durationMs: Date.now() - startedAt,
      detail: `${gap.kind}:${gap.itemKey}`,
      error: err instanceof Error ? err.message : "unknown error",
    });
    return { status: "failed" };
  }
}
