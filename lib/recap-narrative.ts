// Period-recap narrative (issue #20). Pure, no DB/network.
//
// The AI weekly/monthly narrative narrates over the SAME rule-based WeeklyRecap
// the dashboard widget and Telegram digest already compute (lib/weekly-recap.ts)
// — so the AI read is grounded in the exact facts the rest of the app shows, the
// prompt is compact (a handful of pre-computed lines, not a raw data dump), and
// the offline fallback degrades to a deterministic prose rendering of those same
// lines. This module owns three pure pieces:
//   - RECAP_NARRATIVE_SYSTEM: the system prompt (medical tone: observations, not
//     diagnoses; suggest discussing concerns with a clinician).
//   - buildRecapNarrativePrompt: assembles the user prompt from a WeeklyRecap.
//   - composeRecapNarrativeOffline: the deterministic fallback prose.
// All three are unit-tested with no network (lib/__tests__/recap-narrative.test.ts).

import type { WeeklyRecap, RecapLine } from "./weekly-recap";

// The AI narrative periods (issue #20). "week" = trailing 7 days, "month" = 30.
export type NarrativePeriod = "week" | "month";

// The recap window length in days for a period. The weekly/monthly split is the
// only place these magic numbers live for the AI path.
export function periodDaysFor(period: NarrativePeriod): number {
  return period === "month" ? 30 : 7;
}

// A human label for the period ("This week" / "This month"), for headings.
export function periodLabel(period: NarrativePeriod): string {
  return period === "month" ? "This month" : "This week";
}

// The adjective form ("weekly" / "monthly"), for prose.
export function periodAdjective(period: NarrativePeriod): string {
  return period === "month" ? "monthly" : "weekly";
}

export const RECAP_NARRATIVE_SYSTEM = `You are a knowledgeable, encouraging personal health and fitness coach writing a short PERIOD recap (weekly or monthly) for a single user.
You are given a pre-computed set of factual recap lines (training, volume, PRs, adherence, body-weight trend, streak, goals). Write a concise, warm narrative (about 120-180 words) that:
1. Opens with a one-line summary of the period.
2. Connects 2-4 of the actual numbers into observations about momentum and consistency (reference the real figures and deltas you were given).
3. Ends with one concrete, encouraging suggestion for the next period.
Only use facts present in the provided lines — never invent numbers, workouts, or trends. Do not give medical diagnoses; for any concerning body-metric change, gently suggest discussing it with a clinician. Use a motivating, human tone; no bullet lists in your reply.`;

// One "Label: value (delta)" clause per recap line, in the recap's own order.
function lineClause(line: RecapLine): string {
  const delta = line.delta ? ` (${line.delta})` : "";
  return `${line.label}: ${line.value}${delta}`;
}

// Assemble the user prompt from a rule-based recap. The recap facts are fenced in
// a labeled block so they read as DATA the model narrates, mirroring the daily
// insight's document fencing; the period + date window frame the ask.
export function buildRecapNarrativePrompt(
  recap: WeeklyRecap,
  period: NarrativePeriod,
  profileName?: string
): string {
  const who = profileName ? ` for ${profileName}` : "";
  const lines: string[] = [];
  lines.push(
    `Here is my ${periodAdjective(period)} recap${who}, covering ${recap.start} to ${recap.end}. Please write my ${periodAdjective(period)} coaching narrative.`
  );
  lines.push("");
  lines.push(`Headline: ${recap.headline || "a quiet period"}`);
  lines.push("");
  lines.push("<<<BEGIN RECAP FACTS>>>");
  if (recap.lines.length === 0) {
    lines.push(
      "No workouts, adherence, or body-weight readings were logged this period."
    );
  } else {
    for (const l of recap.lines) lines.push(`- ${lineClause(l)}`);
  }
  lines.push("<<<END RECAP FACTS>>>");
  return lines.join("\n");
}

// A readable English list join ("a", "a and b", "a, b and c").
function joinClauses(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// A single line rendered as an inline prose clause ("4 workouts (3 last week)").
function proseClause(line: RecapLine): string {
  const delta = line.delta ? ` (${line.delta})` : "";
  return `${line.value}${delta} ${line.label.toLowerCase()}`;
}

// The deterministic offline fallback: turn the recap lines into a short prose
// paragraph. Used when AI is unavailable (no key / disabled / rate-limited /
// failed). Never throws; an empty recap yields one sensible nudge line.
export function composeRecapNarrativeOffline(
  recap: WeeklyRecap,
  period: NarrativePeriod
): string {
  const adj = periodAdjective(period);
  if (recap.isEmpty || recap.lines.length === 0) {
    return `Your ${adj} recap for ${recap.start} – ${recap.end} is quiet — no workouts, adherence, or weigh-ins logged yet. Log an activity or a weight and next ${period}'s recap will have more to say.`;
  }

  const clauses = recap.lines.map(proseClause);
  const body = joinClauses(clauses);
  const opener = recap.headline
    ? `Your ${adj} recap (${recap.start} – ${recap.end}): ${recap.headline}.`
    : `Your ${adj} recap for ${recap.start} – ${recap.end}.`;
  return `${opener} Over the period you logged ${body}. Next ${period}: pick one small, measurable action that keeps the momentum going.`;
}
