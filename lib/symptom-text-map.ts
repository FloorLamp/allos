// Free-text symptom intake (issue #877): map a typed/Telegram sentence onto the
// EXISTING symptom vocabulary via the Light tier (#875). EXTRACTION, NEVER
// INTERPRETATION — the output is a set of SUGGESTIONS the user confirms with one tap;
// nothing writes here. No triage, no advice, no diagnosis: the same line every AI
// feature holds. The escalation engines react to what gets LOGGED, exactly as if it
// had been tapped.
//
// The pure seam (prompt builder + response parser) is fixture-tested with no network;
// the model call resolves the Light tier and reuses the shared fake-client seam.

import Anthropic from "@anthropic-ai/sdk";
import { resolveTaskClient } from "./ai-resolve";
import { recordAiEvent, capDetail, LOG_PROMPTS, usageFrom } from "./ai-log";
import {
  MAX_SYMPTOM_SEVERITY,
  MIN_SYMPTOM_SEVERITY,
  normalizeSymptomName,
} from "./symptoms";

// The vocabulary the model is constrained to: curated slugs + their labels, plus the
// profile's previously-used custom names (so "tummy ache" re-uses an existing custom).
export interface SymptomVocabulary {
  slugs: string[];
  labels: Record<string, string>;
  customNames: string[];
}

// One mapped symptom SUGGESTION (pre-fill for the bar; not yet written).
export interface MappedSymptom {
  // The stored key: a curated slug, or a normalized custom name.
  slug: string;
  label: string;
  severity: number; // 1..4, conservative default 1
  note?: string;
  // True when this is a proposed CUSTOM (not one of the curated slugs) — surfaced
  // distinctly so the user knows it will create a new custom symptom.
  isCustom: boolean;
}

export interface SymptomTextMapping {
  symptoms: MappedSymptom[];
  temperature?: { value: number; unit: "F" | "C" };
  // Fragments the model couldn't map to a slug — surfaced as "couldn't map: '…'" with
  // the custom-add affordance, never silently dropped.
  unmapped: string[];
  // A relative day hint ("since yesterday") → 0 today, -1 yesterday. Undefined = today.
  dayOffset?: number;
}

export const SYMPTOM_MAP_SYSTEM = `You map a person's plain-language description of how they feel onto a FIXED symptom vocabulary. You are an extraction tool, not a clinician.

Rules:
- Only choose symptoms from the provided vocabulary list. If a described symptom clearly isn't in the list, you MAY propose ONE custom entry per fragment by setting slug to "custom" and custom_name to a short lowercase name — but prefer an existing vocabulary slug whenever one fits.
- Anything you cannot map to a vocabulary slug or a clear custom goes in "unmapped" verbatim, so the person can add it themselves.
- Severity: 1 (mild) to 4 (very severe). Set it ABOVE 1 only on an EXPLICIT cue ("terrible", "severe", "really bad", "10/10"). With no cue, use 1. Never infer alarm.
- Temperature: only when a number is stated (e.g. "fever of 101" → 101 °F, "38.5" → °C if clearly Celsius). Otherwise null.
- Day: "today"/null unless the text says otherwise ("since yesterday" → yesterday).
- Do NOT diagnose, triage, or advise. Do not invent symptoms that weren't described.`;

export const SYMPTOM_MAP_TOOL: Anthropic.Tool = {
  name: "map_symptoms",
  description:
    "Return the symptoms, temperature, and unmapped fragments extracted from the text.",
  input_schema: {
    type: "object",
    properties: {
      symptoms: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description:
                "A vocabulary slug, or 'custom' to propose a new custom symptom named in custom_name.",
            },
            custom_name: {
              type: ["string", "null"],
              description:
                "The custom symptom name when slug is 'custom'; else null.",
            },
            severity: {
              type: ["integer", "null"],
              description: "1-4; 1 unless the text explicitly signals worse.",
            },
            note: { type: ["string", "null"] },
          },
          required: ["slug"],
        },
      },
      temperature: {
        type: ["object", "null"],
        properties: {
          value: { type: "number" },
          unit: { type: "string", enum: ["F", "C"] },
        },
      },
      unmapped: {
        type: "array",
        items: { type: "string" },
        description: "Fragments that couldn't be mapped to a slug.",
      },
      day: {
        type: ["string", "null"],
        enum: ["today", "yesterday", null],
      },
    },
    required: ["symptoms"],
  },
};

// Build the vocabulary block the prompt enumerates: "slug — label" lines + the
// profile's custom names.
export function buildSymptomVocabPrompt(vocab: SymptomVocabulary): string {
  const lines = vocab.slugs.map((s) => `- ${s} — ${vocab.labels[s] ?? s}`);
  const customs =
    vocab.customNames.length > 0
      ? `\n\nPreviously-used custom symptoms (reuse the exact name when it fits): ${vocab.customNames.join(", ")}`
      : "";
  return `Vocabulary (choose slugs from these):\n${lines.join("\n")}${customs}`;
}

function clampSeverity(v: unknown): number {
  const n = typeof v === "number" ? Math.round(v) : Number(v);
  if (!Number.isFinite(n) || n < MIN_SYMPTOM_SEVERITY)
    return MIN_SYMPTOM_SEVERITY;
  if (n > MAX_SYMPTOM_SEVERITY) return MAX_SYMPTOM_SEVERITY;
  return n;
}

function strOrUndef(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

// PURE: parse the model's tool input into vocabulary-constrained suggestions. An
// out-of-vocabulary slug (not curated, not a valid custom) CANNOT survive — it's
// dropped and, where the model flagged it, appears under unmapped. Severity defaults
// conservatively to 1. Deterministic + fixture-tested (no network).
export function parseSymptomMapping(
  input: unknown,
  vocab: SymptomVocabulary
): SymptomTextMapping {
  const raw = (input ?? {}) as Record<string, unknown>;
  const slugSet = new Set(vocab.slugs);
  const customSet = new Set(vocab.customNames.map((c) => c.toLowerCase()));
  const seen = new Set<string>();
  const symptoms: MappedSymptom[] = [];
  const unmapped: string[] = [];

  const arr = Array.isArray(raw.symptoms) ? raw.symptoms : [];
  for (const entry of arr) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const slug = typeof e.slug === "string" ? e.slug.trim() : "";
    const severity = clampSeverity(e.severity);
    const note = strOrUndef(e.note);

    if (slug && slug !== "custom" && slugSet.has(slug)) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      symptoms.push({
        slug,
        label: vocab.labels[slug] ?? slug,
        severity,
        note,
        isCustom: false,
      });
      continue;
    }

    // A proposed custom: slug 'custom' with a name, OR a non-vocabulary slug the model
    // used as a name. Normalize; reuse an existing custom name's exact spelling.
    const rawName =
      strOrUndef(e.custom_name) ??
      (slug && slug !== "custom" ? slug : undefined);
    const name = rawName ? normalizeSymptomName(rawName) : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // If it collides with a curated slug's spelling, treat as that curated symptom.
    if (slugSet.has(key)) {
      symptoms.push({
        slug: key,
        label: vocab.labels[key] ?? key,
        severity,
        note,
        isCustom: false,
      });
      continue;
    }
    // Reuse an existing custom's EXACT stored spelling (so a star/dismiss/history keyed
    // on that name stays aligned), else propose it as a brand-new custom.
    const existing = customSet.has(key)
      ? vocab.customNames.find((c) => c.toLowerCase() === key)
      : undefined;
    const storedName = existing ?? name;
    symptoms.push({
      slug: storedName,
      label: storedName,
      severity,
      note,
      isCustom: existing === undefined,
    });
  }

  // Unmapped fragments: verbatim strings the model couldn't place.
  if (Array.isArray(raw.unmapped)) {
    for (const u of raw.unmapped) {
      const s = strOrUndef(u);
      if (s) unmapped.push(s);
    }
  }

  const mapping: SymptomTextMapping = { symptoms, unmapped };

  // Temperature — only when a finite value + a valid unit are present.
  const temp = raw.temperature as { value?: unknown; unit?: unknown } | null;
  if (temp && typeof temp === "object") {
    const value =
      typeof temp.value === "number" ? temp.value : Number(temp.value);
    const unit = temp.unit === "C" ? "C" : temp.unit === "F" ? "F" : null;
    if (Number.isFinite(value) && unit) mapping.temperature = { value, unit };
  }

  if (raw.day === "yesterday") mapping.dayOffset = -1;
  else if (raw.day === "today") mapping.dayOffset = 0;

  return mapping;
}

// Whether a parsed mapping carries anything actionable.
export function mappingIsEmpty(m: SymptomTextMapping): boolean {
  return m.symptoms.length === 0 && !m.temperature && m.unmapped.length === 0;
}

export type SymptomTextOutcome =
  | { status: "ok"; mapping: SymptomTextMapping }
  | { status: "not-configured" }
  | { status: "empty" }
  | { status: "failed"; error: string };

// The impure entry: resolve the Light tier and map the text. Degrades gracefully —
// no tier configured yields "not-configured" (the caller hides the affordance).
export async function mapSymptomText(
  text: string,
  vocab: SymptomVocabulary
): Promise<SymptomTextOutcome> {
  const trimmed = text.trim();
  if (!trimmed) return { status: "empty" };

  const resolved = resolveTaskClient("symptom-map");
  if (!resolved) {
    recordAiEvent({
      feature: "symptom-map",
      status: "skipped",
      detail: "AI not configured",
    });
    return { status: "not-configured" };
  }
  const { client, model, tier, host } = resolved;

  const startedAt = Date.now();
  try {
    const msg = await client.messages
      .stream({
        model,
        max_tokens: 700,
        system: SYMPTOM_MAP_SYSTEM,
        tools: [SYMPTOM_MAP_TOOL],
        tool_choice: { type: "tool", name: "map_symptoms" },
        messages: [
          {
            role: "user",
            content: `${buildSymptomVocabPrompt(vocab)}\n\nText to map:\n${trimmed}`,
          },
        ],
      })
      .finalMessage();

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (!toolUse) {
      recordAiEvent({
        feature: "symptom-map",
        status: "failed",
        model,
        tier,
        baseUrl: host,
        durationMs: Date.now() - startedAt,
        error: "Model returned no structured data.",
      });
      return {
        status: "failed",
        error: "Couldn't read that — try rephrasing.",
      };
    }

    const mapping = parseSymptomMapping(toolUse.input, vocab);
    recordAiEvent({
      feature: "symptom-map",
      status: "ok",
      model,
      tier,
      baseUrl: host,
      durationMs: Date.now() - startedAt,
      usage: usageFrom(msg),
      detail: capDetail(
        `${mapping.symptoms.length} symptom(s), ${mapping.unmapped.length} unmapped` +
          (LOG_PROMPTS ? `\n${JSON.stringify(toolUse.input)}` : "")
      ),
    });
    if (mappingIsEmpty(mapping)) return { status: "empty" };
    return { status: "ok", mapping };
  } catch (err) {
    const error = err instanceof Error ? err.message : "unknown error";
    recordAiEvent({
      feature: "symptom-map",
      status: "failed",
      model,
      tier,
      baseUrl: host,
      durationMs: Date.now() - startedAt,
      error,
    });
    return { status: "failed", error: "Couldn't reach the AI. Try again." };
  }
}
