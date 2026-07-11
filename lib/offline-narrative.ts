// Offline narrative composer (issue #39, phase 4). Pure, no DB/network.
//
// When ANTHROPIC_API_KEY is absent (or AI is disabled / rate-limited / failing),
// the daily insight falls back to a deterministic summary. Historically that
// summary was bare counts ("3 activities, 2 metrics"). This module composes a
// coherent, specific narrative from the day's ACTUAL findings — the same findings
// bus the rest of the app reads: strength/cardio PRs, "what's trending" digest
// items, supplement/med adherence, and forward-looking Upcoming items — so the
// offline path reads like "You hit a Back Squat PR at 120 kg × 5; LDL trended into
// high range; magnesium adherence slipped to 4/7." with zero inference.
//
// Design:
//   - Template composition over the shared `Finding` envelope. lib/ai.ts gathers
//     the findings (profile-scoped reads + the existing adapters in lib/findings)
//     and hands typed arrays here; this module only phrases them. That keeps the
//     narrator pure and unit-testable, and reuses one model instead of forking.
//   - Findings already carry display-formatted, self-contained clauses in their
//     `detail` (PR loads in the reader's units, TrendItem.text, UpcomingItem due
//     text), so composition is just selection + joining, never re-deriving numbers.
//   - Degrades gracefully: with nothing meaningful logged it returns one sensible
//     short line, never an error or an awkward empty template.

import type { Finding } from "./findings";

export interface NarrativeActivitySummary {
  count: number;
  // Distinct activity types logged (e.g. ["strength", "cardio"]).
  types: string[];
}

export interface NarrativeAdherence {
  taken: number;
  total: number;
}

export interface NarrativeInput {
  // The day the summary is for (YYYY-MM-DD).
  date: string;
  activity: NarrativeActivitySummary;
  // Celebratory PR findings for the day (domain "pr"), already adapted + unit-
  // formatted. Order preserved; the composer caps how many it names.
  prs: Finding[];
  // "What's trending" digest findings (domain "digest"), already adapted.
  trends: Finding[];
  // Supplement/med adherence for the day, or null when nothing is scheduled.
  adherence: NarrativeAdherence | null;
  // Forward-looking Upcoming findings, pre-sorted soonest-first by the caller.
  upcoming: Finding[];
  // Count of active, non-archived goals.
  goalCount: number;
}

// Why the daily insight fell back to the offline composer (issue #411). Threaded
// from generateInsight so the surfaced copy states the ACTUAL cause instead of
// always blaming a missing key — the DoseTakenOutcome honesty pattern (#280)
// applied to the insight fallback: never diagnose a cause you didn't check.
export type OfflineReason = "no-key" | "cap-exhausted" | "failed";

// The one-line note appended to an offline insight, matched to WHY it ran. The
// cap-exhausted user already has a key set, so "set ANTHROPIC_API_KEY" would be a
// lie; the failed path errored mid-call, so "temporarily unavailable" is honest.
export function offlineReasonNote(reason: OfflineReason): string {
  switch (reason) {
    case "no-key":
      return "(Generated offline — set ANTHROPIC_API_KEY for AI-powered coaching analysis.)";
    case "cap-exhausted":
      return "(Generated offline — daily AI limit reached; try again tomorrow.)";
    case "failed":
      return "(Generated offline — AI coaching was temporarily unavailable; try again later.)";
  }
}

// A distinct stored model tag per offline reason (issue #411), so the Insights
// list's model badge stays honest after the fact instead of collapsing all three
// causes into one indistinguishable "offline-fallback".
export function offlineModelTag(reason: OfflineReason): string {
  return `offline/${reason}`;
}

// Max findings named in a single sentence before collapsing to "+N more".
const MAX_NAMED = 3;

// "a", "a and b", "a, b and c" — a readable English list join.
function joinClauses(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// The clause a finding contributes to a sentence: its self-contained detail, or
// the title as a fallback for findings without one.
function clauseOf(f: Finding): string {
  return (f.detail && f.detail.trim()) || f.title;
}

// Take at most MAX_NAMED clauses, appending a "(plus N more)" tail when clipped.
function namedWithOverflow(findings: Finding[]): string {
  const named = findings.slice(0, MAX_NAMED).map(clauseOf);
  const joined = joinClauses(named);
  const extra = findings.length - named.length;
  return extra > 0 ? `${joined} (plus ${extra} more)` : joined;
}

function activitySentence(input: NarrativeInput): string {
  const { count, types } = input.activity;
  if (count === 0) {
    return `No activities logged for ${input.date} — a rest day, or one to fill in.`;
  }
  const uniqueTypes = [...new Set(types.filter(Boolean))];
  const typeList = uniqueTypes.length ? ` (${joinClauses(uniqueTypes)})` : "";
  const noun = count === 1 ? "activity" : "activities";
  return `You logged ${count} ${noun}${typeList} on ${input.date} — nice work staying consistent.`;
}

function prSentence(prs: Finding[]): string | null {
  if (prs.length === 0) return null;
  if (prs.length === 1) {
    return `You hit a new personal record — ${clauseOf(prs[0])}.`;
  }
  return `New personal records: ${namedWithOverflow(prs)}.`;
}

// Rank trends so a clinically meaningful crossing leads: caution (out of range)
// first, then a return into range (positive), then plain neutral moves.
function trendRank(tone: Finding["tone"]): number {
  if (tone === "caution") return 0;
  if (tone === "positive") return 1;
  return 2;
}

function trendSentence(trends: Finding[]): string | null {
  if (trends.length === 0) return null;
  const ordered = [...trends].sort(
    (a, b) => trendRank(a.tone) - trendRank(b.tone)
  );
  return `On the trends side, ${namedWithOverflow(ordered)}.`;
}

function adherenceSentence(
  adherence: NarrativeAdherence | null
): string | null {
  if (!adherence || adherence.total === 0) return null;
  const { taken, total } = adherence;
  if (taken >= total) {
    return `Supplements & meds: ${taken}/${total} taken — full adherence, great.`;
  }
  if (taken === 0) {
    return `Supplements & meds: none of ${total} logged as taken yet — worth catching up.`;
  }
  return `Supplement & med adherence slipped to ${taken}/${total} — try to close the gap tomorrow.`;
}

function upcomingSentence(upcoming: Finding[]): string | null {
  if (upcoming.length === 0) return null;
  const first = upcoming[0];
  const due = first.dueText ? ` (${first.dueText})` : "";
  if (upcoming.length === 1) {
    return `Coming up: ${first.title}${due}.`;
  }
  return `Coming up: ${upcoming.length} items on deck, soonest ${first.title}${due}.`;
}

function goalSentence(goalCount: number): string | null {
  if (goalCount === 0) return null;
  const noun = goalCount === 1 ? "goal" : "goals";
  return `You have ${goalCount} active ${noun} in flight — keep logging so progress stays visible.`;
}

// True when there's genuinely nothing to narrate: no activity, no PRs, no trends,
// no scheduled adherence, no upcoming, no goals.
function isEmpty(input: NarrativeInput): boolean {
  return (
    input.activity.count === 0 &&
    input.prs.length === 0 &&
    input.trends.length === 0 &&
    (!input.adherence || input.adherence.total === 0) &&
    input.upcoming.length === 0 &&
    input.goalCount === 0
  );
}

// Compose the day's offline narrative from its findings. Returns the narrative
// body only (no offline marker — the caller appends that). Never throws; an empty
// day yields one sensible short line.
export function composeOfflineNarrative(input: NarrativeInput): string {
  if (isEmpty(input)) {
    return `Not much logged for ${input.date} yet — even a short walk or a single logged set keeps momentum going. Add one entry and tomorrow's summary will have more to say.`;
  }

  const sentences = [
    activitySentence(input),
    prSentence(input.prs),
    trendSentence(input.trends),
    adherenceSentence(input.adherence),
    upcomingSentence(input.upcoming),
    goalSentence(input.goalCount),
    "Tomorrow: pick one small, measurable action that moves a goal forward.",
  ].filter((s): s is string => s !== null);

  return sentences.join(" ");
}
