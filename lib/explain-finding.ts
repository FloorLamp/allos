// The "why is this flagged?" explainer (issue #878, Phase 1). Light-tier NARRATION
// over a finding's OWN typed reason payload (lib/reasons.ts, #656): the rule, the
// threshold, the citation, the profile facts that triggered it. The AI's ONLY job is
// to phrase what the deterministic engines already concluded — it NEVER computes a
// fact, re-derives a number, or judges. The prompt receives ONLY the typed reasons +
// the finding's own title/detail; there is no free retrieval.
//
// One gather, two renderers (#415): the SAME reason payload feeds both the AI prompt
// and the offline structured fallback, so a payload field the offline renderer can't
// show is a missing REASON field, not a prompt problem — and the paid path can never
// see more than the free one. Degrades gracefully: no tier configured → the structured
// fallback, verbatim from the reasons.

import Anthropic from "@anthropic-ai/sdk";
import { resolveTaskClient } from "./ai-resolve";
import { recordAiEvent, capDetail, LOG_PROMPTS, usageFrom } from "./ai-log";
import { REASON_CODES, type Reason, type ReasonCode } from "./reasons";

// The finding's own carried data — nothing re-derived. Exactly what the surfaces
// already render (title + detail) plus the structured reasons.
export interface ExplainInput {
  title: string;
  detail?: string | null;
  reasons: Reason[];
}

export const EXPLAIN_SYSTEM = `You explain, in plain and calm language, WHY a personal health app flagged or scheduled something. You are given the app's OWN structured reasons — the rules, thresholds, and citations it has ALREADY computed. Your only job is to restate them clearly in 1-3 short sentences.

Hard rules:
- Use ONLY the reasons and facts provided. Never introduce a number, threshold, range, date, diagnosis, or medication that isn't in them.
- Never give medical advice or tell the person what to do about it. You explain the "why", nothing more.
- If a reason carries a source/citation, you may name it. Do not invent one.
- No hedging, no reassurance, no alarm — just the plain reason.`;

// Validate + keep only reasons whose code is in the closed union — a client-supplied
// payload can't smuggle in an unknown code, and the prompt/fallback only ever see
// real reason fields.
export function sanitizeReasons(raw: unknown): Reason[] {
  if (!Array.isArray(raw)) return [];
  const codes = new Set<ReasonCode>(REASON_CODES);
  const out: Reason[] = [];
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    const code = o.code as ReasonCode;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (!codes.has(code) || !text) continue;
    const source =
      typeof o.source === "string" && o.source.trim()
        ? o.source.trim()
        : undefined;
    out.push(source ? { code, text, source } : { code, text });
  }
  return out;
}

// Build the narration prompt from ONLY the payload — the title/detail the surface
// shows and the typed reasons. No DB, no recomputation.
export function buildExplainPrompt(input: ExplainInput): string {
  const lines: string[] = [`Flagged item: ${input.title}`];
  if (input.detail && input.detail.trim())
    lines.push(`Shown detail: ${input.detail.trim()}`);
  lines.push("", "The app's reasons:");
  for (const r of input.reasons) {
    lines.push(`- ${r.text}${r.source ? ` (source: ${r.source})` : ""}`);
  }
  lines.push("", "Explain why this is flagged, using only the reasons above.");
  return lines.join("\n");
}

// The offline structured fallback (#415): render the reason payload verbatim as text.
// This is what a keyless instance shows, and the floor the AI narration can never
// undercut — every fact here comes straight from a reason field.
export function composeOfflineExplanation(input: ExplainInput): string {
  if (input.reasons.length === 0) {
    return input.detail?.trim()
      ? `${input.title}: ${input.detail.trim()}`
      : `${input.title} — no further explanation is recorded for this item.`;
  }
  const bullets = input.reasons.map(
    (r) => `• ${r.text}${r.source ? `\n  Source: ${r.source}` : ""}`
  );
  return `${input.title} is flagged because:\n${bullets.join("\n")}`;
}

export interface ExplainResult {
  text: string;
  // Whether the text came from the offline structured fallback (no AI) vs the model.
  offline: boolean;
  model?: string;
}

// Explain a finding: narrate its reasons via the Light tier, or fall back to the
// structured composition. `reasons` is sanitized here so a caller (a client-echoed
// payload) can't push an unknown code into the prompt.
export async function explainFinding(
  input: ExplainInput
): Promise<ExplainResult> {
  const reasons = sanitizeReasons(input.reasons);
  const clean: ExplainInput = { ...input, reasons };
  const offline = composeOfflineExplanation(clean);

  const resolved = resolveTaskClient("explain");
  if (!resolved) {
    recordAiEvent({
      feature: "explain",
      status: "skipped",
      detail: `${input.title} — AI not configured`,
    });
    return { text: offline, offline: true };
  }
  const { client, model, tier, host } = resolved;

  const startedAt = Date.now();
  try {
    const msg = await client.messages
      .stream({
        model,
        max_tokens: 300,
        system: EXPLAIN_SYSTEM,
        messages: [{ role: "user", content: buildExplainPrompt(clean) }],
      })
      .finalMessage();
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (msg.stop_reason === "max_tokens" || !text) {
      recordAiEvent({
        feature: "explain",
        status: "failed",
        model,
        tier,
        baseUrl: host,
        durationMs: Date.now() - startedAt,
        detail: input.title,
        error:
          msg.stop_reason === "max_tokens"
            ? "Truncated at the output limit."
            : "Empty explanation returned.",
      });
      return { text: offline, offline: true };
    }
    recordAiEvent({
      feature: "explain",
      status: "ok",
      model,
      tier,
      baseUrl: host,
      durationMs: Date.now() - startedAt,
      usage: usageFrom(msg),
      detail: capDetail(input.title + (LOG_PROMPTS ? `\n${text}` : "")),
    });
    return { text, offline: false, model };
  } catch (err) {
    recordAiEvent({
      feature: "explain",
      status: "failed",
      model,
      tier,
      baseUrl: host,
      durationMs: Date.now() - startedAt,
      detail: input.title,
      error: err instanceof Error ? err.message : "unknown error",
    });
    return { text: offline, offline: true };
  }
}
