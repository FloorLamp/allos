import {
  getActivities,
  getSetsForActivities,
  getStrengthByExercise,
  getCardioByActivity,
  getSportByActivity,
  getGoals,
  getGoalProgressMap,
  getFrequencyTargetProgress,
  getLatestBodyMetric,
  getJournalWeekSummary,
  getRecentByExercise,
} from "@/lib/queries";
import { today as todayFn, yesterday as yesterdayFn } from "@/lib/db";
import { frequencyScopeLabel } from "@/lib/goals";
import { getUnitPrefs, getUserSex, type DistanceUnit } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { fmtDistance, fmtSpeed } from "@/lib/units";
import { muscleFor } from "@/lib/lifts";
import type { Activity } from "@/lib/types";
import { getEquipment } from "@/lib/equipment";
import {
  summarizeExercise,
  activityProvenanceLabel,
} from "@/lib/journal-format";
import { storedActivityFault } from "@/lib/activity-validate";
import { formatLongDate } from "@/lib/format-date";
import type { ActivityComponent } from "@/lib/types";
import { EmptyState } from "@/components/ui";
import type { ActivityEditData } from "@/components/ActivityForm";
import type { DisplayPart } from "../journal/JournalCard";
import JournalView, {
  type DayGroup,
  type JournalCardData,
} from "../journal/JournalView";

export default function HistorySection() {
  const { login, profile } = requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;
  const activities = getActivities(profile.id);

  if (activities.length === 0) {
    return (
      <EmptyState message="No activities logged yet. Use “Log activity” to start." />
    );
  }

  const sets = getSetsForActivities(
    profile.id,
    activities.map((a) => a.id)
  );
  // Resolve per-set equipment_id -> implement name for the journal's labels.
  const equipName = new Map(
    getEquipment(profile.id).map((e) => [e.id, e.name])
  );
  const setsByActivity = new Map<number, typeof sets>();
  for (const s of sets) {
    const arr = setsByActivity.get(s.activity_id) ?? [];
    arr.push(s);
    setsByActivity.set(s.activity_id, arr);
  }

  // "Today"/"Yesterday" labels relative to the calendar/db notion of today
  // (TZ-local, matching lib/db).
  const today = todayFn(profile.id);
  const yesterday = yesterdayFn(profile.id);
  const dayLabel = (date: string): string => {
    if (date === today) return "Today";
    if (date === yesterday) return "Yesterday";
    return formatLongDate(date);
  };

  // Bucket activities (already date-desc) into ordered day groups, reusing the
  // existing per-activity display-part / edit-data construction.
  const groups: DayGroup[] = [];
  const byDate = new Map<string, DayGroup>();

  for (const a of activities) {
    const aSets = setsByActivity.get(a.id) ?? [];

    // Group sets by exercise, preserving first-seen order. Keyed lowercased so
    // component-name casing drift (imports) still matches, like the editor.
    const exOrder: string[] = [];
    const byExercise = new Map<string, typeof aSets>();
    for (const s of aSets) {
      const key = s.exercise.trim().toLowerCase();
      if (!byExercise.has(key)) {
        byExercise.set(key, []);
        exOrder.push(s.exercise);
      }
      byExercise.get(key)!.push(s);
    }

    const strengthLine = (name: string): DisplayPart => {
      const grp = byExercise.get(name.trim().toLowerCase())!;
      const { text, status } = summarizeExercise(grp, wu);
      const eqId =
        grp.find((s) => s.equipment_id != null)?.equipment_id ?? null;
      const equipment = eqId != null ? (equipName.get(eqId) ?? null) : null;
      return {
        kind: "strength",
        name,
        muscle: muscleFor(name),
        text,
        status,
        equipment,
      };
    };

    // Prefer the stored components list; fall back to legacy (strength only).
    let components: ActivityComponent[] | null = null;
    if (a.components) {
      try {
        components = JSON.parse(a.components);
      } catch {
        components = null;
      }
    }

    let allParts: DisplayPart[] = [];
    if (components) {
      for (const c of components) {
        if (c.type === "strength") {
          if (byExercise.has(c.name.trim().toLowerCase()))
            allParts.push(strengthLine(c.name));
        } else {
          const bits: string[] = [];
          if (c.distance_km != null)
            bits.push(fmtDistance(c.distance_km, units.distanceUnit));
          if (c.duration_min != null) bits.push(`${c.duration_min} min`);
          const sp = fmtSpeed(
            c.distance_km,
            c.duration_min,
            units.distanceUnit
          );
          if (sp) bits.push(sp);
          allParts.push({
            kind: c.type === "sport" ? "sport" : "cardio",
            name: c.name,
            detail: bits.join(" · "),
          });
        }
      }
    } else {
      allParts = exOrder.map(strengthLine);
    }
    // A single cardio/sport part is normally folded into the header meta. For a
    // pure cardio/sport activity, surface it as a clickable row instead (so it
    // opens its detail, like strength exercises do) and drop the now-redundant
    // header meta below.
    const multi = allParts.length > 1;
    const single = allParts.length === 1 ? allParts[0] : null;
    const singlePureEffort =
      single != null &&
      (single.kind === "cardio" || single.kind === "sport") &&
      (a.type === "cardio" || a.type === "sport");
    const parts = singlePureEffort
      ? allParts
      : allParts.filter((p) => p.kind === "strength" || multi);

    const editData: ActivityEditData = {
      id: a.id,
      type: a.type,
      title: a.title,
      date: a.date,
      duration_min: a.duration_min,
      distance_km: a.distance_km,
      intensity: a.intensity,
      start_time: a.start_time,
      end_time: a.end_time,
      components: a.components,
      notes: a.notes,
      // Provenance for the editor header (issue #11).
      source: a.source,
      edited: a.edited,
      created_at: a.created_at,
      updated_at: a.updated_at,
      sets: aSets.map((s) => ({
        exercise: s.exercise,
        set_number: s.set_number,
        weight_kg: s.weight_kg,
        reps: s.reps,
        weight_kg_right: s.weight_kg_right,
        reps_right: s.reps_right,
        duration_sec: s.duration_sec,
        duration_sec_right: s.duration_sec_right,
        equipment_id: s.equipment_id,
        target_reps: s.target_reps,
        to_failure: s.to_failure,
      })),
    };

    const card: JournalCardData = {
      activity: editData,
      durationText:
        singlePureEffort || a.duration_min == null
          ? null
          : `${a.duration_min} min`,
      distanceText:
        singlePureEffort || a.distance_km == null
          ? null
          : fmtDistance(a.distance_km, units.distanceUnit),
      speedText: singlePureEffort
        ? null
        : fmtSpeed(a.distance_km, a.duration_min, units.distanceUnit),
      metrics: activityMetrics(a, units.distanceUnit),
      parts,
      // Flag rows the editor couldn't re-save as-is (imports, legacy data).
      fault: storedActivityFault(a, aSets),
      // Provenance chip + created/updated timestamps (issue #11).
      provenance: {
        label: activityProvenanceLabel(a.source, a.edited),
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      },
    };

    let group = byDate.get(a.date);
    if (!group) {
      group = { date: a.date, label: dayLabel(a.date), cards: [] };
      byDate.set(a.date, group);
      groups.push(group);
    }
    group.cards.push(card);
  }

  // Per-exercise recent sessions (last 10) for the exercise detail pane.
  const recentByExercise = getRecentByExercise(profile.id, wu);

  const summary = getJournalWeekSummary(profile.id);
  const goals = getGoals(profile.id);
  // Map → plain object so it can cross the server/client boundary.
  const goalProgress = Object.fromEntries(
    getGoalProgressMap(profile.id, goals)
  );
  const targets = getFrequencyTargetProgress(profile.id).map((t) => ({
    label: frequencyScopeLabel(t.target.scope_kind, t.target.scope_value),
    count: t.count,
    perWeek: t.per_week,
    met: t.met,
  }));

  return (
    <JournalView
      groups={groups}
      exerciseStats={getStrengthByExercise(profile.id)}
      cardioStats={getCardioByActivity(profile.id, units.distanceUnit)}
      sportStats={getSportByActivity(profile.id)}
      goals={goals}
      goalProgress={goalProgress}
      bodyweightKg={getLatestBodyMetric(profile.id, "weight")}
      units={units}
      recentByExercise={recentByExercise}
      weekSummary={{
        sessions: summary.sessions,
        activeDays: summary.activeDays,
        streak: summary.streak,
        targets,
      }}
      showHeader={false}
      sex={getUserSex(profile.id)}
    />
  );
}

// Compact, unit-aware chips for the richer per-activity metrics carried by pull
// integrations (Strava). Each appears only when its column is present, so manual
// entries and Health Connect imports render nothing extra. Power, cadence, and
// kilojoules are cycling-only; temperature is outdoor-only; workout_type is a
// label — all set by the parser, so this just formats whatever is non-null.
function activityMetrics(a: Activity, distanceUnit: DistanceUnit): string[] {
  const m: string[] = [];
  if (a.workout_type)
    m.push(a.workout_type.replace(/\b\w/, (c) => c.toUpperCase()));
  if (a.avg_hr != null) {
    m.push(`♥ ${a.avg_hr}${a.max_hr != null ? `/${a.max_hr}` : ""} bpm`);
  }
  if (a.elevation_m != null && a.elevation_m > 0) {
    m.push(
      distanceUnit === "mi"
        ? `↑ ${Math.round(a.elevation_m * 3.28084)} ft`
        : `↑ ${Math.round(a.elevation_m)} m`
    );
  }
  if (a.avg_power_w != null) {
    m.push(
      `${a.avg_power_w} W${a.weighted_avg_power_w != null ? ` (${a.weighted_avg_power_w} NP)` : ""}`
    );
  }
  if (a.avg_cadence != null) m.push(`${a.avg_cadence} rpm`);
  if (a.kilojoules != null) m.push(`${a.kilojoules} kJ`);
  if (a.avg_temp_c != null) m.push(`${Math.round(a.avg_temp_c)}°C`);
  if (a.relative_effort != null) m.push(`Effort ${a.relative_effort}`);
  return m;
}
