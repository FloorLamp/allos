// AI narrative layer (issue #20): the AI-powered weekly/monthly period recap and
// the lab-trend interpretation. Both narrate over ALREADY-GATHERED, structured
// facts — the rule-based WeeklyRecap and the biomarker trajectory findings — so
// the AI read is grounded and the prompt is compact. Both reuse the existing
// guardrails: the shared model config (lib/ai-client), the ai.jsonl audit log
// (feature "narrative"), the per-profile daily usage cap (kind "narrative"), and
// graceful degradation to a deterministic offline composer whenever AI is
// unavailable (no key / disabled endpoint / rate-limited / failed / truncated).
//
// This module holds the IMPURE half (profile-scoped gather + the network call);
// the PURE prompt-assembly + offline composition live in lib/recap-narrative.ts
// and lib/lab-trend-narrative.ts, where they're unit-tested with no network.

import Anthropic from "@anthropic-ai/sdk";
import { today } from "./db";
import { AI_MODEL as MODEL, aiConfigured, createAiClient } from "./ai-client";
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
import { buildTrajectoryFindings } from "./trajectory-series";
import {
  getConditions,
  getMedicalRecords,
  getMedicationCourses,
  getSupplements,
} from "./queries";
import {
  buildLabTrendPrompt,
  composeLabTrendOffline,
  hasLabTrendSignal,
  LAB_TREND_SYSTEM,
  type LabTrendInput,
} from "./lab-trend-narrative";

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

  if (!aiConfigured()) {
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

  const startedAt = Date.now();
  try {
    const client = createAiClient();
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

// Gather the structured lab-trend context: the rule-engine trajectory findings,
// recent non-optimal readings, the medication course timeline (names + dates),
// and active conditions. All reads are profile-scoped via the query layer.
export function gatherLabTrendInput(profileId: number): LabTrendInput {
  const td = today(profileId);

  const findings = buildTrajectoryFindings(profileId, td).map((f) => ({
    label: f.title,
    detail: (f.detail ?? f.evidence ?? "").trim(),
    tone: f.tone ?? null,
  }));

  // Recent notable readings: non-optimal biomarker rows, newest first (the query
  // defaults to date DESC), capped so the prompt stays compact.
  const readings = getMedicalRecords(profileId, { range: "nonoptimal" })
    .slice(0, 10)
    .map((r) => ({
      name: r.canonical_name || r.name,
      date: r.date,
      value: r.value ?? "",
      unit: r.unit,
      reference: r.reference_range,
      flag: r.flag,
    }));

  // Intake timeline: name + kind (from the intake item) + start/stop dates (from
  // its courses), most-recently-started first, capped. Includes BOTH medications
  // and supplements (#421) — a supplement started months ago (vitamin D, iron) is
  // often the best explanation for a moving 25-OH-D or ferritin trend, so it must
  // reach the interpretation; each row is kind-tagged so the model can tell an OTC
  // supplement from a prescription.
  const intakeById = new Map(
    getSupplements(profileId).map((s) => [
      s.id,
      {
        name: s.name,
        kind: s.kind === "medication" ? "medication" : "supplement",
      },
    ])
  );
  const medications = getMedicationCourses(profileId)
    .filter((c) => intakeById.has(c.item_id))
    .sort((a, b) => (b.started_on ?? "").localeCompare(a.started_on ?? ""))
    .slice(0, 10)
    .map((c) => {
      const item = intakeById.get(c.item_id)!;
      return {
        name: item.name,
        kind: item.kind as "medication" | "supplement",
        startedOn: c.started_on,
        stoppedOn: c.stopped_on,
      };
    });

  const conditions = getConditions(profileId, { status: "active" })
    .slice(0, 8)
    .map((c) => ({
      name: c.name,
      status: c.status,
      onsetDate: c.onset_date,
    }));

  return { today: td, findings, readings, medications, conditions };
}

// Generate (or fall back to) the AI lab-trend interpretation for a profile. The
// anchor (period_end) is the latest notable reading's date, else today, so a
// regenerate after new labs land upserts a fresh read at the new anchor.
export async function generateLabTrendInterpretation(
  profileId: number
): Promise<NarrativeResult> {
  const input = gatherLabTrendInput(profileId);
  const periodEnd = input.readings[0]?.date ?? input.today;
  const offline = () => composeLabTrendOffline(input);
  // No trajectory findings and no notable readings — there's no trend to read, so
  // skip the API call and store the deterministic "nothing to interpret" line.
  if (!hasLabTrendSignal(input)) {
    recordAiEvent({
      feature: "narrative",
      status: "skipped",
      detail: `lab-trend ${periodEnd} — nothing to interpret`,
    });
    return {
      kind: "labs",
      periodStart: null,
      periodEnd,
      summary: offline(),
      model: "offline-fallback",
    };
  }
  const { summary, model } = await narrate({
    profileId,
    system: LAB_TREND_SYSTEM,
    userContent: buildLabTrendPrompt(input),
    detailKey: `lab-trend ${periodEnd}`,
    offline,
  });
  return { kind: "labs", periodStart: null, periodEnd, summary, model };
}
