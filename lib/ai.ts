import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import {
  getActivitiesByDate,
  getGoals,
  getSupplementLogsForDate,
  getSupplements,
  getStrengthByExercise,
  getCardioByActivity,
  getConditions,
  collectUpcoming,
} from "./queries";

import { resolveTaskClient, isTaskConfigured } from "./ai-resolve";
import { recordAiEvent, capDetail, LOG_PROMPTS, usageFrom } from "./ai-log";
import { checkAndIncrementAiUsage, insightDailyLimit } from "./ai-usage";
import { recentPRs, recentCardioPRs } from "./coaching";
import { isGoalLive } from "./goals";
import {
  prToFinding,
  cardioPrToFinding,
  upcomingToFinding,
  trendItemToFinding,
  groupFindings,
} from "./findings";
import { buildDigestSeries } from "./trends-series";
import { summarizeTrends } from "./trends-digest";
import { isTrainingRestricted } from "./age-gate";
import { getUnitPrefs, getUserSex, getUserAge } from "./settings";
import { quickRanges } from "./timeline-format";
import {
  composeOfflineNarrative,
  buildInsightPrompt,
  offlineReasonNote,
  offlineModelTag,
  type InsightContext,
  type OfflineReason,
} from "./offline-narrative";

export interface InsightResult {
  summary: string;
  model: string;
}

const SYSTEM = `You are a knowledgeable, encouraging personal health and fitness coach.
Given a single user's daily health data, write a concise daily analysis (about 120-200 words).
Structure it as:
1. A one-line summary of the day.
2. 2-4 specific, actionable observations tied to their data and goals.
3. One concrete suggestion for tomorrow.
Be specific and reference the actual numbers. Do not give medical diagnoses; for concerning lab values, suggest consulting a clinician. Use a warm, motivating tone.`;

// The ONE daily-insight gather (issue #415): profile-scoped reads via the existing
// query layer + the findings-bus adapters, plus the clinical/demographic context,
// handed to BOTH renderers — composeOfflineNarrative (offline summary) and
// buildInsightPrompt (the Claude prompt). One gather, two renderers, so the paid
// AI path can no longer see LESS than the free offline path. loginId (when present)
// resolves the reader's display units so PR loads/distances and trend deltas read
// in kg/lb / km/mi correctly; background/notify contexts without a login fall back
// to canonical units.
function gatherInsightContext(
  profileId: number,
  date: string,
  loginId?: number
): InsightContext {
  const units =
    loginId != null
      ? getUnitPrefs(loginId)
      : { weightUnit: "kg" as const, distanceUnit: "km" as const };

  const activities = getActivitiesByDate(profileId, date);

  // PRs set ON the day (withinDays = 0), as celebratory findings.
  const strengthPrs = recentPRs(getStrengthByExercise(profileId), date, 0).map(
    (pr) => prToFinding(pr, units.weightUnit)
  );
  const cardioPrs = recentCardioPRs(
    getCardioByActivity(profileId, units.distanceUnit),
    date,
    0
  ).map((pr) => cardioPrToFinding(pr, units.distanceUnit));

  // "What's trending" digest over the trailing 90-day window, adapted to findings.
  const restricted = isTrainingRestricted(profileId);
  const range = quickRanges(date)[2]; // 90D window (label/from/to)
  const series = buildDigestSeries(profileId, loginId ?? 0, range, restricted);
  const trends = summarizeTrends(series, { limit: 5 }).map(trendItemToFinding);

  // Supplement/med adherence for the day.
  const activeIntake = getSupplements(profileId).filter((s) => s.active);
  const takenToday = getSupplementLogsForDate(profileId, date);
  const adherence =
    activeIntake.length > 0
      ? { taken: takenToday.size, total: activeIntake.length }
      : null;

  // Forward-looking Upcoming items (already snooze/dismiss-filtered), banded and
  // flattened soonest-first so the composer can name the nearest one.
  const upcoming = groupFindings(
    collectUpcoming(profileId, date).map(upcomingToFinding),
    date
  ).flatMap((g) => g.items);

  const goalCount = getGoals(profileId).filter((g) => isGoalLive(g)).length;

  // Clinical/demographic context (issue #415): active conditions, active intake
  // (kind-labelled so the model tells a medication from a supplement), and profile
  // sex/age — all reached the DB but none reached the coach until now.
  const conditions = getConditions(profileId, { status: "active" }).map(
    (c) => c.name
  );
  const intake = getSupplements(profileId)
    .filter((s) => s.active)
    .map((s) => ({ name: s.name, kind: s.kind }));

  return {
    date,
    activity: {
      count: activities.length,
      types: activities.map((a) => a.type),
    },
    prs: [...strengthPrs, ...cardioPrs],
    trends,
    adherence,
    upcoming,
    goalCount,
    profile: {
      sex: getUserSex(profileId),
      age: getUserAge(profileId),
      conditions,
      intake,
    },
  };
}

// The offline daily summary: a coherent narrative composed from the day's actual
// findings (PRs, trending metrics/biomarkers, adherence, upcoming), used whenever
// the AI path is unavailable. Takes the ALREADY-gathered context (so the fallback
// reasons over the identical inputs the AI prompt saw) and the typed reason WHY it
// fell back, so the appended note states the real cause (issue #411) instead of
// always telling the user to set a key they may already have.
function fallbackInsight(
  context: InsightContext,
  reason: OfflineReason
): string {
  return composeOfflineNarrative(context) + "\n\n" + offlineReasonNote(reason);
}

export async function generateInsight(
  profileId: number,
  date: string,
  loginId?: number
): Promise<InsightResult> {
  const context = gatherInsightContext(profileId, date, loginId);

  if (!isTaskConfigured("insight")) {
    recordAiEvent({
      feature: "insight",
      status: "skipped",
      detail: `${date} — AI not configured`,
    });
    return {
      summary: fallbackInsight(context, "no-key"),
      model: offlineModelTag("no-key"),
    };
  }

  // Per-profile daily AI cap (rate-limiting Fix 1). A key is present, so a real
  // Claude call is about to dispatch — consume one 'insight' unit. On exhaustion,
  // fall back to the same offline COMPOSITION the no-key path uses (graceful
  // degrade, never a hard error) but with the cap-exhausted reason so the surfaced
  // note is honest, and leave a trace in the AI log.
  if (
    !checkAndIncrementAiUsage(profileId, "insight", insightDailyLimit()).allowed
  ) {
    recordAiEvent({
      feature: "insight",
      status: "skipped",
      detail: `${date} — daily AI insight limit reached`,
    });
    // The key IS set; the user is rate-limited, not unconfigured (issue #411).
    return {
      summary: fallbackInsight(context, "cap-exhausted"),
      model: offlineModelTag("cap-exhausted"),
    };
  }

  // Build the client only after the cap passed (the resolver is the sole
  // client-build seam, so a capped call never constructs the model client).
  const resolved = resolveTaskClient("insight");
  if (!resolved) {
    recordAiEvent({
      feature: "insight",
      status: "skipped",
      detail: `${date} — AI not configured`,
    });
    return {
      summary: fallbackInsight(context, "no-key"),
      model: offlineModelTag("no-key"),
    };
  }
  const { client, model: MODEL, tier, host } = resolved;

  const startedAt = Date.now();
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Here is my health data for the day. Please give me my daily coaching analysis.\n\n${buildInsightPrompt(context)}`,
        },
      ],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    // A truncated response is a partial (mid-sentence) insight — log it as a
    // failure and fall back gracefully rather than persisting the cut-off text.
    if (msg.stop_reason === "max_tokens") {
      recordAiEvent({
        feature: "insight",
        status: "failed",
        model: MODEL,
        tier,
        baseUrl: host,
        durationMs: Date.now() - startedAt,
        detail: date,
        error: "Truncated at the output limit (600 tokens).",
      });
      // A configured-but-errored call (truncation) — "temporarily unavailable",
      // not "set a key" (issue #411).
      return {
        summary: fallbackInsight(context, "failed"),
        model: offlineModelTag("failed"),
      };
    }
    recordAiEvent({
      feature: "insight",
      status: "ok",
      model: MODEL,
      tier,
      baseUrl: host,
      durationMs: Date.now() - startedAt,
      usage: usageFrom(msg),
      detail: capDetail(`${date}` + (LOG_PROMPTS ? `\n${text}` : "")),
    });
    return {
      summary: text || fallbackInsight(context, "failed"),
      model: text ? MODEL : offlineModelTag("failed"),
    };
  } catch (err) {
    recordAiEvent({
      feature: "insight",
      status: "failed",
      model: MODEL,
      tier,
      baseUrl: host,
      durationMs: Date.now() - startedAt,
      detail: date,
      error: err instanceof Error ? err.message : "unknown error",
    });
    // The key is set and the call errored — an honest "temporarily unavailable"
    // note (issue #411), not the misleading "set ANTHROPIC_API_KEY". The specific
    // error stays in the AI log above, not in the surfaced coaching copy.
    return {
      summary: fallbackInsight(context, "failed"),
      model: offlineModelTag("failed"),
    };
  }
}

export function saveInsight(
  profileId: number,
  date: string,
  result: InsightResult
) {
  db.prepare(
    `INSERT INTO insights (profile_id, date, summary, model) VALUES (?,?,?,?)
     ON CONFLICT(profile_id, date) DO UPDATE SET summary = excluded.summary, model = excluded.model, created_at = datetime('now')`
  ).run(profileId, date, result.summary, result.model);
}
