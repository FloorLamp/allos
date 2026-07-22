// AI narrative layer (issue #20): the AI-powered weekly/monthly period recap.
// It narrates over ALREADY-GATHERED, structured facts — the rule-based WeeklyRecap —
// so the AI read is grounded and the prompt is compact. It reuses the existing
// guardrails: the shared model config (lib/ai-client), the ai.jsonl audit log
// (feature "narrative"), the per-profile daily usage cap (kind "narrative"), and
// graceful degradation to a deterministic offline composer whenever AI is
// unavailable (no key / disabled endpoint / rate-limited / failed / truncated).
//
// This module holds the IMPURE half (profile-scoped gather + the network call);
// the PURE prompt-assembly + offline composition live in lib/recap-narrative.ts,
// where they're unit-tested with no network. (The lab-trend interpretation, #20's
// second narrative, was removed with the Trends → Biomarkers tab — #1164.)

import Anthropic from "@anthropic-ai/sdk";
import { today } from "./db";
import { resolveTaskClient, isTaskConfigured } from "./ai-resolve";
import { recordAiEvent, capDetail, LOG_PROMPTS, usageFrom } from "./ai-log";
import { checkAndIncrementAiUsage, narrativeDailyLimit } from "./ai-usage";
import { getUnitPrefs, type WeightUnit } from "./settings";
import type { NarrativeKind } from "./types";
import { getPeriodRecap } from "./notifications/weekly-recap-data";
import {
  buildRecapNarrativePrompt,
  composeRecapNarrativeOffline,
  periodDaysFor,
  RECAP_NARRATIVE_SYSTEM,
  type NarrativePeriod,
} from "./recap-narrative";

// The saved shape a generator returns: the narrative text + its anchor, ready to
// hand to saveNarrative(profileId, …).
export interface NarrativeResult {
  kind: NarrativeKind;
  periodStart: string | null;
  periodEnd: string;
  summary: string;
  model: string;
}

// The one place the Claude call + guardrails live, shared by both narratives.
// Consumes one "narrative" usage unit BEFORE dispatching (no refund on failure,
// matching the insight path), logs every outcome, and always degrades to the
// caller's offline composer rather than throwing.
async function narrate(opts: {
  profileId: number;
  system: string;
  userContent: string;
  detailKey: string;
  offline: () => string;
  maxTokens?: number;
}): Promise<{ summary: string; model: string }> {
  const { profileId, system, userContent, detailKey, offline } = opts;
  const maxTokens = opts.maxTokens ?? 700;

  if (!isTaskConfigured("narrative")) {
    recordAiEvent({
      feature: "narrative",
      status: "skipped",
      detail: `${detailKey} — AI not configured`,
    });
    return { summary: offline(), model: "offline-fallback" };
  }

  if (
    !checkAndIncrementAiUsage(profileId, "narrative", narrativeDailyLimit())
      .allowed
  ) {
    recordAiEvent({
      feature: "narrative",
      status: "skipped",
      detail: `${detailKey} — daily AI narrative limit reached`,
    });
    return { summary: offline(), model: "offline-fallback" };
  }

  // Build the client only after the cap passed (the resolver is the sole
  // client-build seam, so a capped call never constructs the model client).
  const resolved = resolveTaskClient("narrative");
  if (!resolved) {
    recordAiEvent({
      feature: "narrative",
      status: "skipped",
      detail: `${detailKey} — AI not configured`,
    });
    return { summary: offline(), model: "offline-fallback" };
  }
  const { client, model: MODEL, tier, host } = resolved;

  const startedAt = Date.now();
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userContent }],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    // A truncated response is a partial narrative — log the failure and fall back
    // rather than persisting cut-off text (matching the daily insight path).
    if (msg.stop_reason === "max_tokens") {
      recordAiEvent({
        feature: "narrative",
        status: "failed",
        model: MODEL,
        tier,
        baseUrl: host,
        durationMs: Date.now() - startedAt,
        detail: detailKey,
        error: `Truncated at the output limit (${maxTokens} tokens).`,
      });
      return { summary: offline(), model: "offline-fallback" };
    }
    recordAiEvent({
      feature: "narrative",
      status: "ok",
      model: MODEL,
      tier,
      baseUrl: host,
      durationMs: Date.now() - startedAt,
      usage: usageFrom(msg),
      detail: capDetail(detailKey + (LOG_PROMPTS ? `\n${text}` : "")),
    });
    return { summary: text || offline(), model: MODEL };
  } catch (err) {
    recordAiEvent({
      feature: "narrative",
      status: "failed",
      model: MODEL,
      tier,
      baseUrl: host,
      durationMs: Date.now() - startedAt,
      detail: detailKey,
      error: err instanceof Error ? err.message : "unknown error",
    });
    return {
      summary:
        offline() +
        `\n\n(AI request failed: ${err instanceof Error ? err.message : "unknown error"})`,
      model: "offline-fallback",
    };
  }
}

// Generate (or fall back to) the AI period recap narrative for a profile. Gathers
// the SAME rule-based recap the dashboard shows (getPeriodRecap), narrates over
// it, and returns the text + anchor for storage. weightUnit resolves from the
// login's preference when a loginId is given, else canonical kg.
export async function generateRecapNarrative(
  profileId: number,
  period: NarrativePeriod,
  loginId?: number,
  weightUnit?: WeightUnit
): Promise<NarrativeResult> {
  const wu: WeightUnit =
    weightUnit ?? (loginId != null ? getUnitPrefs(loginId).weightUnit : "kg");
  const recap = getPeriodRecap(profileId, periodDaysFor(period), wu);
  const offline = () => composeRecapNarrativeOffline(recap, period);
  // Nothing logged this period — don't burn a usage unit / API call on an empty
  // recap; the deterministic composer already says the right quiet thing.
  if (recap.isEmpty) {
    recordAiEvent({
      feature: "narrative",
      status: "skipped",
      detail: `${period} recap ${recap.start}–${recap.end} — nothing to narrate`,
    });
    return {
      kind: period,
      periodStart: recap.start,
      periodEnd: recap.end,
      summary: offline(),
      model: "offline-fallback",
    };
  }
  const { summary, model } = await narrate({
    profileId,
    system: RECAP_NARRATIVE_SYSTEM,
    userContent: buildRecapNarrativePrompt(recap, period),
    detailKey: `${period} recap ${recap.start}–${recap.end}`,
    offline,
  });
  return {
    kind: period,
    periodStart: recap.start,
    periodEnd: recap.end,
    summary,
    model,
  };
}

