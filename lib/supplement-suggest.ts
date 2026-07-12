import Anthropic from "@anthropic-ai/sdk";
import { db, writeTx } from "./db";
import {
  biomarkerFamilyKey,
  getActivities,
  getGoals,
  getMedicalRecords,
  getSupplements,
} from "./queries";
import { biomarkerFamily } from "./canonical-name";
import type {
  FoodTiming,
  MedicalRecord,
  SupplementCondition,
  SupplementPriority,
} from "./types";
import {
  CONDITIONS,
  PRIORITIES,
  TIME_BUCKETS,
  FOOD_TIMINGS,
} from "./supplement-schedule";
import { isNonOptimal, isOutOfRange } from "./reference-range";
import { getAiPrefs } from "./settings";
import { AI_MODEL, aiConfigured, createAiClient } from "./ai-client";
import { createLogger } from "./log";
import { recordAiEvent, capDetail, LOG_PROMPTS } from "./ai-log";
import { checkAndIncrementAiUsage, insightDailyLimit } from "./ai-usage";
import { strOrNull } from "./parse";

const MODEL = AI_MODEL;

const log = createLogger("supplement-suggest");

// A single proposed supplement as returned by the model + normalized.
export interface SuggestionDraft {
  name: string;
  dosage: string | null;
  time_of_day: string | null;
  food_timing: FoodTiming;
  condition: SupplementCondition;
  situation: string | null;
  priority: SupplementPriority;
  brand: string | null;
  product: string | null;
  rationale: string;
}

export interface SuggestResult {
  suggestions: SuggestionDraft[];
  model: string;
  note?: string; // surfaced when nothing could be generated (e.g. no API key)
}

const SYSTEM = `You are a cautious clinical-nutrition assistant that proposes over-the-counter
dietary supplements for a single user based on their lab results, goals, and a free-text note.

Rules:
- Suggest ONLY common, over-the-counter supplements with conservative, typical dosing. Never
  prescription drugs or megadoses.
- Tie EVERY suggestion's rationale to a specific lab value or to the user's feedback. Be concrete
  (name the lab and its value/flag).
- Do NOT duplicate a supplement the user already takes (the active list is provided).
- priority: set "mandatory" ONLY when the suggestion directly addresses an out-of-range LOW lab (a
  confirmed deficiency) and cite that lab in the rationale. Otherwise use "high" (strong evidence)
  or "low" (nice-to-have).
- condition: "daily" unless the supplement is clearly tied to training ("pre_workout"/"post_workout")
  or to a temporary situation ("situational", with a short situation label like "Illness").
- dosage: the amount per intake (e.g. "5 g", "5–10 g", "2000 IU"). State frequency
  like "twice daily" only when it matters; prefer time_of_day for timing.
- time_of_day: one of Morning / Midday / Evening / Before sleep / Anytime.
- brand / product: usually leave null; only set if a specific product is genuinely warranted.
- For concerning values, note that the user should consult a clinician. Do not diagnose.
- If nothing is clearly warranted, return an empty suggestions array. Do not pad.`;

const TOOL: Anthropic.Tool = {
  name: "suggest_supplements",
  description: "Return supplement suggestions for the user to review.",
  input_schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            dosage: { type: ["string", "null"] },
            time_of_day: {
              type: ["string", "null"],
              enum: [...TIME_BUCKETS, null],
            },
            food_timing: {
              type: ["string", "null"],
              enum: [...FOOD_TIMINGS, null],
              description:
                "How to take it relative to food: with_fat for fat-soluble vitamins/oils, before_meal, empty_stomach, with_food, or any.",
            },
            condition: { type: "string", enum: CONDITIONS },
            situation: {
              type: ["string", "null"],
              description:
                "Short label when condition is 'situational' (e.g. 'Illness')",
            },
            priority: { type: "string", enum: PRIORITIES },
            brand: { type: ["string", "null"] },
            product: { type: ["string", "null"] },
            rationale: {
              type: "string",
              description:
                "Why this is suggested; cite the specific lab or feedback.",
            },
          },
          required: ["name", "condition", "priority", "rationale"],
        },
      },
    },
    required: ["suggestions"],
  },
};

// Render a labelled context block the model reasons over. `records` overrides the
// lab set (used by the auto-trigger to scope to just-changed biomarkers).
function buildContext(
  profileId: number,
  opts: { feedback?: string; records?: MedicalRecord[] }
): {
  text: string;
  lowLabNames: string[];
} {
  const oorLabs =
    opts.records ??
    getMedicalRecords(profileId, { range: "nonoptimal" }).slice(0, 30);
  const recentLabs = getMedicalRecords(profileId).slice(0, 12);
  const supplements = getSupplements(profileId).filter((s) => s.active);
  const goals = getGoals(profileId).filter(
    (g) => g.status === "active" && !g.archived
  );
  const activities = getActivities(profileId, 10);

  // Out-of-range LOW labs anchor the "mandatory" (deficiency) safeguard below.
  const lowLabNames = oorLabs
    .filter((r) => r.flag === "low")
    .map((r) => (r.canonical_name || r.name).toLowerCase());

  const lines: string[] = [];

  lines.push("## Out-of-range / non-optimal labs");
  if (oorLabs.length === 0) lines.push("None.");
  for (const r of oorLabs)
    lines.push(
      `- ${r.canonical_name || r.name}: ${r.value ?? ""} ${r.unit ?? ""} [${r.flag ?? "?"}] (ref ${r.reference_range ?? "n/a"})`.trim()
    );

  lines.push("\n## Recent labs");
  for (const r of recentLabs)
    lines.push(
      `- ${r.date} ${r.canonical_name || r.name}: ${r.value ?? ""} ${r.unit ?? ""}`.trim()
    );

  lines.push("\n## Supplements already taken (do not duplicate)");
  if (supplements.length === 0) lines.push("None.");
  for (const s of supplements) lines.push(`- ${s.name}`);

  lines.push("\n## Active goals");
  if (goals.length === 0) lines.push("None.");
  for (const g of goals) lines.push(`- ${g.title}`);

  lines.push("\n## Recent activity");
  if (activities.length === 0) lines.push("None.");
  for (const a of activities) lines.push(`- ${a.date} [${a.type}] ${a.title}`);

  if (opts.feedback) lines.push(`\n## User note\n${opts.feedback}`);

  return { text: lines.join("\n"), lowLabNames };
}

const str = strOrNull;

function normalizeDrafts(raw: any, lowLabNames: string[]): SuggestionDraft[] {
  const arr = Array.isArray(raw?.suggestions) ? raw.suggestions : [];
  const out: SuggestionDraft[] = [];
  for (const s of arr) {
    const name = str(s?.name);
    const rationale = str(s?.rationale);
    if (!name || !rationale) continue;
    const condition: SupplementCondition = CONDITIONS.includes(s?.condition)
      ? s.condition
      : "daily";
    let priority: SupplementPriority = PRIORITIES.includes(s?.priority)
      ? s.priority
      : "high";
    // Belt-and-suspenders: "mandatory" must reference a real out-of-range-low
    // lab. Downgrade hallucinated mandatory suggestions to "high".
    if (priority === "mandatory") {
      const hay = `${rationale} ${str(s?.product) ?? ""}`.toLowerCase();
      const cited = lowLabNames.some((n) => n && hay.includes(n));
      if (!cited) priority = "high";
    }
    out.push({
      name,
      dosage: str(s?.dosage),
      time_of_day: str(s?.time_of_day),
      food_timing: FOOD_TIMINGS.includes(s?.food_timing)
        ? s.food_timing
        : "any",
      condition,
      situation: condition === "situational" ? str(s?.situation) : null,
      priority,
      brand: str(s?.brand),
      product: str(s?.product),
      rationale,
    });
  }
  return out;
}

async function runModel(
  profileId: number,
  context: { text: string; lowLabNames: string[] },
  feature: "suggestions" | "auto-suggest" = "suggestions"
): Promise<SuggestResult> {
  if (!aiConfigured()) {
    recordAiEvent({
      feature,
      status: "skipped",
      detail: "AI not configured",
    });
    return {
      suggestions: [],
      model: "offline",
      note: "AI not configured — set ANTHROPIC_API_KEY (or AI_BASE_URL) to get AI supplement suggestions.",
    };
  }
  // Per-profile daily AI cap (rate-limiting Fix 1). A key is present, so a real
  // Claude call is about to dispatch — consume one 'insight' unit (insights and
  // suggestions share this bucket). On exhaustion, return the SAME degraded shape
  // the no-key path uses: empty suggestions + a note the UI surfaces inline.
  if (
    !checkAndIncrementAiUsage(profileId, "insight", insightDailyLimit()).allowed
  ) {
    recordAiEvent({
      feature,
      status: "skipped",
      detail: "daily AI limit reached",
    });
    return {
      suggestions: [],
      model: "offline",
      note: "Daily AI limit reached — try again tomorrow.",
    };
  }
  const startedAt = Date.now();
  try {
    const client = createAiClient();
    const msg = await client.messages
      .stream({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "suggest_supplements" },
        messages: [
          {
            role: "user",
            content: `Here is my health data. Suggest supplements I should consider.\n\n${context.text}`,
          },
        ],
      })
      .finalMessage();
    // If the model ran out of output budget the tool input is likely truncated
    // (invalid/partial JSON), so treat it as a failure rather than persisting a
    // partial set — mirrors the medical-extract truncation handling.
    if (msg.stop_reason === "max_tokens") {
      const note = "AI request truncated at the output limit (2000 tokens).";
      log.error("failed: truncated at output limit");
      recordAiEvent({
        feature,
        status: "failed",
        model: MODEL,
        durationMs: Date.now() - startedAt,
        error: note,
      });
      return { suggestions: [], model: "offline", note };
    }
    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const drafts = toolUse
      ? normalizeDrafts(toolUse.input as any, context.lowLabNames)
      : [];
    log.info("done", { suggestions: drafts.length });
    recordAiEvent({
      feature,
      status: "ok",
      model: MODEL,
      durationMs: Date.now() - startedAt,
      detail: capDetail(
        `${drafts.length} suggestion(s): ${drafts.map((d) => d.name).join(", ")}` +
          (LOG_PROMPTS ? `\nprompt:\n${context.text}` : "")
      ),
    });
    return { suggestions: drafts, model: MODEL };
  } catch (err) {
    log.error("failed", { err });
    const note = `AI request failed: ${err instanceof Error ? err.message : "unknown error"}`;
    recordAiEvent({
      feature,
      status: "failed",
      model: MODEL,
      durationMs: Date.now() - startedAt,
      error: note,
    });
    return { suggestions: [], model: "offline", note };
  }
}

// On-demand suggestions from current labs + an optional free-text note.
export async function suggestSupplements(
  profileId: number,
  { feedback }: { feedback?: string } = {}
): Promise<SuggestResult> {
  return runModel(profileId, buildContext(profileId, { feedback }));
}

// Lowercased names already represented (active supplements + pending
// suggestions) so we never propose a duplicate.
function existingNames(profileId: number): Set<string> {
  const supp = getSupplements(profileId).map((s) => s.name.toLowerCase());
  const pending = (
    db
      .prepare(
        "SELECT name FROM intake_item_suggestions WHERE profile_id = ? AND status = 'pending'"
      )
      .all(profileId) as { name: string }[]
  ).map((r) => r.name.toLowerCase());
  return new Set([...supp, ...pending]);
}

function insertSuggestions(
  profileId: number,
  drafts: SuggestionDraft[],
  model: string,
  trigger: string,
  sourceDetail: string | null
): number {
  const taken = existingNames(profileId);
  const fresh = drafts.filter((d) => !taken.has(d.name.toLowerCase()));
  if (fresh.length === 0) return 0;
  const insert = db.prepare(
    `INSERT INTO intake_item_suggestions
       (profile_id, name, dosage, time_of_day, food_timing, condition, priority, brand, product,
        situation, rationale, trigger, source_detail, model)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  writeTx(() => {
    for (const d of fresh) {
      insert.run(
        profileId,
        d.name,
        d.dosage,
        d.time_of_day,
        d.food_timing,
        d.condition,
        d.priority,
        d.brand,
        d.product,
        d.situation,
        d.rationale,
        trigger,
        sourceDetail,
        model
      );
    }
  });
  return fresh.length;
}

// On-demand entry used by the server action: generate + persist pending rows.
export async function generateAndStoreSuggestions(
  profileId: number,
  feedback?: string
): Promise<{ inserted: number; note?: string }> {
  const result = await suggestSupplements(profileId, { feedback });
  const trigger = feedback?.trim() ? "feedback" : "labs";
  const sourceDetail = feedback?.trim() ? feedback.trim() : null;
  const inserted = insertSuggestions(
    profileId,
    result.suggestions,
    result.model,
    trigger,
    sourceDetail
  );
  return { inserted, note: result.note };
}

// Auto-trigger used after a document extraction: look at the just-imported
// records, keep only those that are NEW (the only reading for that canonical
// name) or out-of-range, and if any remain ask the engine for suggestions
// scoped to them. No-ops silently when nothing relevant changed, no API key,
// or the auto-suggestions setting is off (on-demand generation is unaffected).
export async function autoSuggestFromBiomarkers(
  profileId: number,
  recordIds: number[]
): Promise<number> {
  if (!aiConfigured() || recordIds.length === 0) return 0;
  if (!getAiPrefs().autoSupplementSuggestions) {
    // Leave a trace in the AI log so "why no suggestions after import?" is
    // answerable from Settings → AI logs.
    recordAiEvent({
      feature: "auto-suggest",
      status: "skipped",
      detail: "auto supplement suggestions disabled in Settings → AI",
    });
    return 0;
  }

  const placeholders = recordIds.map(() => "?").join(",");
  const records = db
    .prepare(
      `SELECT * FROM medical_records WHERE profile_id = ? AND id IN (${placeholders})`
    )
    .all(profileId, ...recordIds) as MedicalRecord[];

  // "Flagged" here means clinically out-of-range OR merely non-optimal — a
  // relevant reading either way (broader than the shared isOutOfRange predicate).
  const isFlagged = (r: MedicalRecord) =>
    isOutOfRange(r.flag) || isNonOptimal(r.flag);

  // "New" = this biomarker FAMILY has only one reading total (this one). Count by
  // the #482 family identity — the SAME key the biomarkers table partitions on
  // (biomarkerFamilyKey / biomarkerFamily) — NOT the raw name, so a fresh reading
  // under a different family member's spelling (e.g. "Vitamin D, 25-Hydroxy Total"
  // when the profile already has a "Vitamin D2" history) is correctly seen as a prior
  // reading, not a brand-new biomarker eligible for a first-ever suggestion. Legacy
  // rows with a NULL/blank canonical_name still count via the display-name fallback.
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM medical_records WHERE profile_id = ? AND ${biomarkerFamilyKey()} = ? COLLATE NOCASE`
  );
  const relevant = records.filter((r) => {
    if (isFlagged(r)) return true;
    const key = biomarkerFamily((r.canonical_name ?? "").trim() || r.name);
    const c = (countStmt.get(profileId, key) as { c: number }).c;
    return c <= 1;
  });
  if (relevant.length === 0) return 0;

  const context = buildContext(profileId, { records: relevant });
  const result = await runModel(profileId, context, "auto-suggest");
  if (result.suggestions.length === 0) return 0;

  const names = relevant.map((r) => r.canonical_name || r.name);
  const sourceDetail = `New/changed biomarkers: ${[...new Set(names)].join(", ")}`;
  return insertSuggestions(
    profileId,
    result.suggestions,
    result.model,
    "labs",
    sourceDetail
  );
}
