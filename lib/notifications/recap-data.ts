// Recap DB gather + send orchestration (issues #32 / #2178). Pulls the per-profile
// facts the recap summarizes from the already-scoped query layer, hands them to the
// pure `buildRecap`, and dispatches the rendered message. Called from the notify tick
// at the profile's ONE configured recap slot (weekday + minute).
//
// WHICH SCALE speaks at that slot is decided by the pure `planRecapSend`
// (lib/recap-scale.ts) and nothing here: this module reads the three period-anchored
// markers, obeys the plan, and writes the markers back. Every scale rides the same
// slot, so a longer period REPLACES the shorter one's send instead of adding a second.
//
// The SAME gatherRecapInput powers the dashboard recap widget, so the card and the
// notification always show identical numbers (#221) — the card on the in-progress
// period, the send on the one that closed (#1021).

import { today } from "../db";
import { daysBetweenDateStr, shiftDateStr, weekdayOfDateStr } from "../date";
import {
  getActivitiesSince,
  getStrengthByExercise,
  getCardioByActivity,
  getWeights,
  getGoals,
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getActivitiesByDate,
  getZone2MinutesInWindow,
  getSleepRegularity,
  getMoodLogs,
} from "../queries";
import { recentPRs, recentCardioPRs } from "../coaching";
import { loadContextLabel } from "../lifts";
import { doseDueOn } from "../supplement-schedule";
import { getIntakeDeltaLine } from "../intake-history";
import {
  buildRecap,
  lineSpeaksAt,
  periodFor,
  renderRecapMessage,
  pickRecapNarrative,
  resolveWeekPeriod,
  inWindow,
  type Recap,
  type RecapAdherenceDay,
  type RecapInput,
  type RecapLineKey,
  type RecapWorkout,
  type WorkoutType,
} from "../recap";
import {
  planRecapSend,
  recapScaleEntry,
  RECAP_SCALES,
  type RecapScale,
} from "../recap-scale";
import type { ActivityType } from "../types/training";
import { getRecentNarratives } from "../queries";
import {
  getActiveSituations,
  getSituationEvents,
  getWeekMode,
  getProfileMoodRecap,
  getWeekStart,
  getZone2WeeklyTargetMin,
  getProfileSetting,
  setProfileSetting,
  getPublicUrl,
  getRecapScale,
} from "../settings";
import { situationHistoryResolver } from "../trend-annotations";
import { illnessDaysInWindow } from "../illness-episode-store";
import { getLatestFitnessAssessmentDate } from "../fitness-assessment";
import { assembleFitnessCheckModel } from "../fitness-check-assemble";
import { batteryCompletion } from "../fitness-outcome";
import type { WeightUnit } from "../settings";
import { dispatch } from "./index";
import { recapMarkerKey } from "./send-markers";
import { createLogger } from "../log";

const log = createLogger("notify");

// Which BREAKDOWN bucket each activity type contributes to, declared per type (#2272)
// rather than derived from an else-branch. The else-branch swept every unmatched type
// into `strength`, so a session whose source declined to classify it would have been
// reported to the user as strength training — the same invented claim this issue is
// about. `null` means "counts as a workout, contributes no bucket".
const RECAP_WORKOUT_BUCKET: Record<ActivityType, WorkoutType | null> = {
  strength: "strength",
  cardio: "cardio",
  sport: "sport",
  // Pre-#2272 behavior, preserved deliberately: a mobility session has counted in the
  // strength bucket since the recap shipped, and re-cutting that line is its own
  // decision, not a side effect of adding a type.
  recovery: "strength",
  unclassified: null,
};

function asWorkout(a: { date: string; type: string }): RecapWorkout {
  const type = RECAP_WORKOUT_BUCKET[a.type as ActivityType] ?? null;
  return { date: a.date, type };
}

// Supplement adherence (taken / skipped / due) across the window, using the same
// due-dose derivation as the digest (isDueOn honoring workout-day + active
// situations). Deliberate skips (#232) are tallied separately so the recap can
// show them alongside taken and exclude them from the percentage denominator.
function windowAdherence(
  profileId: number,
  start: string,
  end: string
): {
  total: { taken: number; skipped: number; due: number };
  days: RecapAdherenceDay[];
} | null {
  const active = getSupplements(profileId).filter((s) => s.active);
  if (active.length === 0) return null;
  const suppById = new Map(active.map((s) => [s.id, s]));
  const doses = getSupplementDoses(profileId).filter((d) =>
    suppById.has(d.item_id)
  );
  if (doses.length === 0) return null;
  // Per-day situation resolver (#654): each past day in the recap window is scored
  // against the situations active THAT day, not today's toggle applied retroactively.
  const situationsOn = situationHistoryResolver(
    getActiveSituations(profileId),
    getSituationEvents(profileId)
  );

  let taken = 0;
  let skipped = 0;
  let due = 0;
  // The per-day rows the month/quarter PATTERN line reads (#2178). Produced by this
  // SAME loop, so the percentage and the shape can never describe different days.
  const days: RecapAdherenceDay[] = [];
  for (let d = start; d <= end; d = shiftDateStr(d, 1)) {
    const isWorkoutDay = getActivitiesByDate(profileId, d).length > 0;
    const dueIds = doses
      .filter((dose) =>
        doseDueOn(suppById.get(dose.item_id)!, dose, {
          date: d,
          isWorkoutDay,
          activeSituations: situationsOn(d),
        })
      )
      .map((dose) => dose.id);
    if (dueIds.length === 0) continue;
    const takenSet = getTakenDoseIds(profileId, d);
    const skippedSet = getSkippedDoseIds(profileId, d);
    const dayTaken = dueIds.filter((id) => takenSet.has(id)).length;
    const daySkipped = dueIds.filter((id) => skippedSet.has(id)).length;
    due += dueIds.length;
    taken += dayTaken;
    skipped += daySkipped;
    days.push({
      date: d,
      due: dueIds.length,
      taken: dayTaken,
      skipped: daySkipped,
    });
  }
  return due > 0 ? { total: { taken, skipped, due }, days } : null;
}

// Gather the recap facts for one profile over the declared SCALE's period. weightUnit
// controls how the values render (the dashboard passes the login's preference; the
// notification uses canonical kg).
//
// `completed` (issue #1021, generalized by #2178) is the notification's window
// selection: the last CLOSED period instead of the dashboard's in-progress one — same
// gather, one window-selection parameter (#221).
//
// The scale also drives WHICH READS HAPPEN: a query whose line does not speak at this
// scale is skipped rather than gathered and thrown away, so the declaration in
// RECAP_LINE_MODEL is load-bearing for cost as well as for content.
//
// `asOf` is the profile-local day the recap is being asked about. It defaults to the
// profile's today (every rendered surface), and the SEND passes the same date it planned
// with — so the period a recap is GATHERED for can never differ from the period the tick
// decided had closed. Before #2178 the gather re-derived its own `today()`, which agreed
// with the tick only because they were called a moment apart; a plan and a gather that
// can disagree about which period they are talking about is a defect waiting for a tick
// that straddles local midnight.
export function gatherRecapInput(
  profileId: number,
  weightUnit: WeightUnit = "kg",
  scale: RecapScale = "week",
  completed = false,
  asOf?: string
): RecapInput {
  const td = asOf ?? today(profileId);
  // "This week" per the profile's week_mode for the 7-day recap (issue #223), so
  // the recap window matches the routine counters / journal. Months and quarters are
  // always calendar — week_mode defines only weeks.
  const weekMode = getWeekMode(profileId);
  const weekStart = getWeekStart(profileId);
  const win = periodFor(scale, td, weekMode, weekStart, completed);
  const speaks = (key: RecapLineKey) => lineSpeaksAt(key, scale);

  // Only the recap's two windows (current + previous) reduce these, and win.prevStart
  // is the earliest bound of either, so bound the load there (issue #389) instead of
  // pulling all history (SELECT *, incl. the components TEXT) to discard all but ~14
  // days. Nothing in the recap walks back past that bound any more — the streak
  // lines that needed full activity history were retired (#1935/#1937).
  const allActivities = getActivitiesSince(profileId, win.prevStart);
  const activities = allActivities.map(asWorkout);
  const workouts = activities.filter((w) =>
    inWindow(w.date, win.start, win.end)
  );
  const prevWorkouts = activities.filter((w) =>
    inWindow(w.date, win.prevStart, win.prevEnd)
  );

  // PRs (strength + cardio) set within the recap window; labels are canonical
  // exercise / activity display names, de-duplicated in first-seen order. The PR
  // helpers' `within` is INCLUSIVE both ends, so it must be the number of days from
  // the window start to its end — both derived from `win` so they track whichever
  // window resolveRecapWindow produced (a calendar week can be a partial, <7-day
  // span; the notification's completed week, #1021, ends BEFORE today). This
  // matches the workout window exactly, so a PR dated on `win.prevEnd` (whose
  // workout lands in the *previous* window) never leaks in (issues #190/#223), and
  // a PR set after a completed window's end (the in-progress week) never leaks
  // back in either (`within` excludes dates past its anchor).
  const withinDays =
    daysBetweenDateStr(win.start, win.end) ?? recapScaleEntry(scale).approxDays;
  // byLoadContext (#1610): two machines' records are two records, and the label
  // below names the implement so the recap doesn't repeat one bare lift name twice.
  const strengthPRs = speaks("prs")
    ? recentPRs(getStrengthByExercise(profileId, true), win.end, withinDays)
    : [];
  const cardioPRs = speaks("prs")
    ? recentCardioPRs(getCardioByActivity(profileId, "km"), win.end, withinDays)
    : [];
  const prLabels: string[] = [];
  const seen = new Set<string>();
  for (const p of strengthPRs) {
    // Named by load context (#1610): two machines' records are two labels, and one
    // implement's two record kinds still collapse to a single mention.
    const label = loadContextLabel(p.exercise, p.equipment);
    if (!seen.has(label)) {
      seen.add(label);
      prLabels.push(label);
    }
  }
  for (const p of cardioPRs) {
    if (!seen.has(p.activity)) {
      seen.add(p.activity);
      prLabels.push(p.activity);
    }
  }

  // Pull enough recent rows to cover BOTH windows even at a few weigh-ins per day —
  // the previous window feeds the weight line's period-over-period comparison
  // (#1935/#2178), so the cap has to cover the whole span from prevStart to end.
  const spanDays = (daysBetweenDateStr(win.prevStart, win.end) ?? 13) + 1;
  const weighIns = getWeights(profileId, Math.max(60, spanDays * 4))
    .filter((w) => w.weight_kg != null)
    .map((w) => ({ date: w.date, weightKg: w.weight_kg as number }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const weights = weighIns.filter((w) => inWindow(w.date, win.start, win.end));
  const prevWeights = weighIns.filter((w) =>
    inWindow(w.date, win.prevStart, win.prevEnd)
  );

  const goalsCompleted = getGoals(profileId)
    .filter(
      (g) =>
        g.status === "achieved" &&
        !g.archived &&
        g.target_date != null &&
        inWindow(g.target_date, win.start, win.end)
    )
    .map((g) => g.title);

  // ONE per-day dose walk feeds BOTH the week-scale percentage and the month/quarter
  // pattern — the percentage and the shape are two readings of the same rows, never
  // two gathers that could disagree. Skipped entirely when neither line speaks here.
  const adh =
    speaks("adherence") || speaks("adherence-pattern")
      ? windowAdherence(profileId, win.start, win.end)
      : null;

  return {
    today: td,
    weightUnit,
    scale,
    weekMode,
    weekStart,
    completed,
    workouts,
    prevWorkouts,
    prLabels,
    adherence: adh?.total ?? null,
    adherenceDays: adh?.days ?? [],
    // The pushed tier's state changes (#1505 part 3), from the ONE shared classifier
    // the morning digest and the household card also read — so the recap can never
    // report a different "what changed" than they do. Week scale only: the shared line
    // is itself a few-day delta, and a monthly recap must not present it as a month's.
    intakeDeltaLine: speaks("intake-deltas")
      ? getIntakeDeltaLine(profileId, td)
      : null,
    weights,
    prevWeights,
    goalsCompleted,
    // Sick days within the window (issue #837) — the recovery-context honesty line,
    // from the SAME illness_episodes rows the illness surfaces use (one derivation).
    illnessDays: speaks("recovery")
      ? illnessDaysInWindow(profileId, win.start, win.end)
      : 0,
    // Zone 2 aerobic-base minutes over the SAME window (win is a days-1 inclusive
    // range, #190) — null when no HR zone model exists (line then omitted).
    zone2Min: speaks("zone2")
      ? getZone2MinutesInWindow(profileId, win.start, win.end)
      : null,
    zone2Target: speaks("zone2") ? getZone2WeeklyTargetMin(profileId) : null,
    // Sleep Regularity Index (#160) over the trailing 28-night window — the SAME
    // pure computeSleepRegularity the Trends sleep card renders (one computation).
    // Null (line omitted) below the minimum-nights gate.
    ...(() => {
      const reg = getSleepRegularity(profileId);
      return {
        sri: reg?.sri ?? null,
        socialJetlagMin: reg?.socialJetlagMin ?? null,
      };
    })(),
    // Mood summary (#992): OPT-IN (mood_recap_enabled, off by default) and a
    // summary only — the widget and the notification render this ONE gather, so
    // they can never disagree. Null (line omitted) when opted out or unlogged.
    mood: (() => {
      if (!speaks("mood") || !getProfileMoodRecap(profileId)) return null;
      const logs = getMoodLogs(profileId, win.start).filter(
        (m) => m.date <= win.end
      );
      if (logs.length === 0) return null;
      return {
        avgValence: logs.reduce((acc, m) => acc + m.valence, 0) / logs.length,
        daysLogged: logs.length,
      };
    })(),
    // Fitness check completed this window (#1307): the most recent check landed inside
    // the window AND the battery is now complete (the SAME batteryCompletion definition
    // the check page's finale uses). Reports the completed check's fitness age; null when
    // no check completed in the window (line omitted).
    fitnessCheck: (() => {
      if (!speaks("fitness-check")) return null;
      const lastCheck = getLatestFitnessAssessmentDate(profileId);
      if (!lastCheck || !inWindow(lastCheck, win.start, win.end)) return null;
      const { model, equipmentMissingKeys } =
        assembleFitnessCheckModel(profileId);
      if (!batteryCompletion(model.results, equipmentMissingKeys).complete)
        return null;
      return {
        fitnessAge: model.headlineFitnessAge?.fitnessAge ?? null,
        priorFitnessAge: model.priorHeadlineFitnessAge?.fitnessAge ?? null,
      };
    })(),
  };
}

// The dashboard card: the profile's chosen scale, IN PROGRESS. The card and the send
// are the same gather (#221) and differ only in which period they name — the card shows
// the period you are living in (so it keeps matching the routine counters, #223), the
// send narrates the one that closed.
export function getRecapCard(
  profileId: number,
  weightUnit: WeightUnit = "kg"
): Recap {
  return buildRecap(
    gatherRecapInput(profileId, weightUnit, getRecapScale(profileId))
  );
}

// Gather + build a recap at an explicit scale (issue #20, #2178): the AI narrative
// generator reuses this so the weekly/monthly/quarterly AI read narrates over the SAME
// rule-based recap facts the dashboard widget and the notification already show.
export function getScaleRecap(
  profileId: number,
  scale: RecapScale,
  weightUnit: WeightUnit = "kg"
): Recap {
  return buildRecap(gatherRecapInput(profileId, weightUnit, scale));
}

// Build + send this profile's recap for `date`. Called from the tick only at the
// profile's configured recap slot (weekday + minute), which is the ONE slot every scale
// arrives in — that is what makes "replace, never stack" true by construction rather
// than by discipline.
//
// THE DECISION IS PURE AND LIVES IN lib/recap-scale.ts. This function reads the three
// period-anchored markers, hands them to `planRecapSend`, and does what it says:
//
//   • send the winning scale's recap (the LONGEST applicable period), and
//   • mark EVERY applicable scale spent for its own period — including the ones the
//     winner outranked. A superseded scale's news is inside the message that went out,
//     so leaving it armed would deliver the same days again at the next slot.
//
// A nothing-to-say period still marks spent (#32's quiet-by-default), so it is not
// recomputed at the retry attempt an hour later. A period with NO channel configured
// leaves the markers alone, exactly as the weekly recap always has, so the first recap
// after a channel is added is not silently lost.
export async function runRecap(
  profileId: number,
  profileName: string,
  date: string
): Promise<{ failed: boolean }> {
  const plan = planRecapSend({
    floor: getRecapScale(profileId),
    today: date,
    weekday: weekdayOfDateStr(date),
    weekMode: getWeekMode(profileId),
    weekStart: getWeekStart(profileId),
    sentPeriodEnd: Object.fromEntries(
      RECAP_SCALES.map((e) => [
        e.scale,
        getProfileSetting(profileId, recapMarkerKey(e.scale)) ?? null,
      ])
    ),
    resolveWeek: resolveWeekPeriod,
  });
  if (!plan.send) return { failed: false };

  const spend = () => {
    for (const c of plan.spend)
      setProfileSetting(profileId, recapMarkerKey(c.scale), c.period.end);
  };

  const scale = plan.send.scale;
  // The SAME `date` the plan above was decided on, not a second `today()` read.
  const recap = buildRecap(
    gatherRecapInput(profileId, "kg", scale, true, date)
  );
  // Surface the stored AI recap narrative when one exists for this window (#421).
  // READ-ONLY — the tick must never call Claude (quota atomicity assumes a single
  // AI-calling process); it only SELECTs a narrative the web process already
  // generated, falling back to the bullet lines when there is none. The picker keys on
  // the recap's OWN window and the kinds are read at the SENT scale, so a weekly
  // narrative can never be pasted under a monthly heading.
  const narrative = pickRecapNarrative(
    getRecentNarratives(profileId, [scale], 5),
    recap
  );
  const msg = renderRecapMessage(recap, profileName, narrative, getPublicUrl());
  if (!msg) {
    spend();
    log.info("recap: nothing to send", { profile: profileId, scale });
    return { failed: false };
  }

  const results = await dispatch(profileId, msg);
  if (results.length === 0) {
    // No channel configured — leave unmarked so it can send once configured.
    return { failed: false };
  }
  const delivered = results.some((r) => r.ok);
  const failed = results.some((r) => !r.ok);
  if (delivered) {
    spend();
    if (plan.superseded.length > 0)
      log.info("recap superseded smaller scales", {
        profile: profileId,
        scale,
        superseded: plan.superseded.join(","),
      });
  }
  return { failed };
}
