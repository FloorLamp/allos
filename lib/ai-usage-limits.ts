// PURE decision + limit logic for the per-profile daily AI cap (rate-limiting
// Fix 1). Split out of lib/ai-usage.ts (the DB wrapper) so it imports NOTHING —
// no db, no network — and can be unit-tested in the pure suite
// (lib/__tests__/ai-usage.test.ts) without opening SQLite. lib/ai-usage.ts
// re-exports everything here, so callers can import from either place.

// Kinds tracked today: document extraction, insight/suggestion generation, and
// the AI narrative layer (weekly/monthly recap + lab-trend interpretation, #20).
// Insights and supplement suggestions share the "insight" bucket — both are
// coaching-style generations distinct from document extraction. Narratives get
// their OWN bucket because they're heavier, on-demand generations whose cap
// should tune independently of the per-day insight cap.
export type AiUsageKind = "extraction" | "insight" | "narrative";

// Defaults are generous for a real single user across a day, but tight enough to
// bound abuse. Overridable per deploy via env; the default stays the source of
// truth in code (these are plain integers — never a model identifier).
export const DEFAULT_DAILY_EXTRACTION_LIMIT = 50;
export const DEFAULT_DAILY_INSIGHT_LIMIT = 100;
// Period recaps + lab-trend reads are heavier and more deliberate than a daily
// insight, so a lower default cap is plenty for a real user while still bounding
// a runaway loop.
export const DEFAULT_DAILY_NARRATIVE_LIMIT = 30;

// Parse a non-negative integer env override, falling back to the code default when
// unset/blank/invalid (so a typo can't silently disable the cap — only a
// deliberate, valid integer changes it).
function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function extractionDailyLimit(): number {
  return envLimit("AI_DAILY_EXTRACTION_LIMIT", DEFAULT_DAILY_EXTRACTION_LIMIT);
}

export function insightDailyLimit(): number {
  return envLimit("AI_DAILY_INSIGHT_LIMIT", DEFAULT_DAILY_INSIGHT_LIMIT);
}

export function narrativeDailyLimit(): number {
  return envLimit("AI_DAILY_NARRATIVE_LIMIT", DEFAULT_DAILY_NARRATIVE_LIMIT);
}

// Resolve the daily limit for a kind from env/defaults.
export function dailyLimitFor(kind: AiUsageKind): number {
  if (kind === "extraction") return extractionDailyLimit();
  if (kind === "narrative") return narrativeDailyLimit();
  return insightDailyLimit();
}

export interface AiUsageDecision {
  allowed: boolean;
  // The count AFTER this call: current + 1 when allowed, unchanged when denied.
  nextCount: number;
  // How many calls remain in the window after this one (0 when denied).
  remaining: number;
}

// PURE decision: given the profile's current count for the day/kind and the limit,
// decide whether one more call is allowed and what the stored count becomes. A
// non-finite/negative current is treated as 0 (defensive). A limit <= 0 denies
// everything (a deploy that sets the limit to 0 disables that AI operation).
export function decideAiUsage(current: number, limit: number): AiUsageDecision {
  const safeCurrent =
    Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;
  if (safeCurrent < limit) {
    const nextCount = safeCurrent + 1;
    return {
      allowed: true,
      nextCount,
      remaining: Math.max(0, limit - nextCount),
    };
  }
  return { allowed: false, nextCount: safeCurrent, remaining: 0 };
}

export interface AiUsageResult {
  allowed: boolean;
  remaining: number;
}

// PURE refund decision (issue #135, item 3): a transient extraction FAILURE
// (timeout / 429 / 5xx / crash) burned a unit at dispatch but imported nothing, so
// the unit is handed back. Returns the count AFTER the refund: current - 1, floored
// at 0 (a refund can never drive the counter negative, and a non-finite/≤0 current —
// nothing to refund — yields 0). Refunds apply ONLY to `failed` outcomes, never
// `skipped` (a skip means the model deliberately declined, or the daily cap already
// prevented the charge). Keeping this pure lets the DB wrapper stay a thin
// transactional decrement and mirrors decideAiUsage.
export function decideAiRefund(current: number): number {
  const safeCurrent =
    Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;
  return Math.max(0, safeCurrent - 1);
}
