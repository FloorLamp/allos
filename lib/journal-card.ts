// Pure construction of the Journal feed's per-day cards (issue #334). This is the
// ~150 lines of derivation that used to live inline in
// app/(app)/training/HistorySection.tsx: set-grouping by lowercased exercise, the
// components-vs-legacy branch, the single-pure-effort header fold, the cardio
// distance/duration/speed detail string, and the imported-metric chips. Extracting
// it here (like lib/activity-form-model.ts did for form parsing) makes the whole
// derivation unit-testable and keeps HistorySection a thin data-fetch + render.
//
// The header's durationText/distanceText/speedText and a single cardio part's
// `detail` string are now BOTH produced here from the SAME activity, so the "one
// question, one computation" rule holds — a folded single cardio/sport effort
// surfaces as a clickable row and its now-redundant header meta is suppressed.

import type { Activity, ExerciseSet, ActivityComponent } from "./types";
import { parseComponents } from "./types";
import type { ActivityEditData } from "./activity-form-model";
import type { DistanceUnit, UnitPrefs } from "./settings";
import type { SetStatus } from "./journal-format";
import { summarizeExercise, activityProvenanceLabel } from "./journal-format";
import { muscleFor } from "./lifts";
import { storedActivityFault } from "./activity-validate";
import { pickFoldValues } from "./import-review/conflicts";
import { formatLongDate } from "./format-date";
import { fmtDistance, fmtSpeed } from "./units";
import {
  activityEstimateKcal,
  nearestBodyweightKg,
  formatEstimatedKcal,
  type DatedWeight,
} from "./calorie-estimate";

// One rendered line under a card: a strength exercise (with its summary + status),
// or a cardio/sport effort (with its distance/duration/speed detail string). The
// JournalCard component is a thin renderer over these.
export type DisplayPart =
  | {
      kind: "strength";
      name: string;
      muscle: string | null;
      text: string;
      status: SetStatus;
      // User-defined implement used for this exercise (e.g. "Trap Bar"), or null.
      equipment?: string | null;
    }
  | { kind: "cardio"; name: string; detail: string }
  | { kind: "sport"; name: string; detail: string };

export interface JournalCardData {
  activity: ActivityEditData;
  durationText: string | null;
  distanceText: string | null;
  speedText: string | null;
  // Compact chips for richer imported metrics (HR, elevation, power, etc.).
  metrics: string[];
  // Session-level gear name (issue #342), e.g. "Road Bike" for a ride — resolved
  // from activity.equipment_id via the equipmentNames map (retired gear still
  // labels), or null when the activity has no gear linked.
  gear: string | null;
  parts: DisplayPart[];
  // Why this row can't be re-saved by the editor as-is (imports, legacy
  // data), or null. See lib/activity-validate.
  fault: string | null;
  // Provenance chip + created/updated timestamps (issue #11).
  provenance: {
    // "Manual" | "Strava" | "Google Health Connect" | "Document" | "<Source> · edited"
    label: string;
    createdAt: string;
    // NULL until the row has been edited since creation.
    updatedAt: string | null;
  };
  // The row's fold-field values (issue #100) — the compact payload the manual-merge
  // conflict preview compares against a same-day sibling. Values are raw canonical
  // numbers/strings straight off the activity row.
  foldValues: Record<string, unknown>;
}

export interface DayGroup {
  date: string;
  label: string;
  cards: JournalCardData[];
}

// Append a newer-first page of day groups onto the already-loaded ones as the Journal
// feed pages older windows in from the server (issue #451). The server pages by whole
// day, so `incoming` dates are normally disjoint from and strictly older than
// `existing` — a plain concat. This still merges by date (deduping cards by activity
// id) so a boundary re-fetch or an overlapping window can't duplicate a card or split
// a day into two groups. Pure: same inputs → same output, unit-tested.
export function appendDayGroups(
  existing: DayGroup[],
  incoming: DayGroup[]
): DayGroup[] {
  if (incoming.length === 0) return existing;
  const out = existing.map((g) => ({ ...g, cards: [...g.cards] }));
  const indexByDate = new Map(out.map((g, i) => [g.date, i]));
  for (const g of incoming) {
    const at = indexByDate.get(g.date);
    if (at == null) {
      indexByDate.set(g.date, out.length);
      out.push({ ...g, cards: [...g.cards] });
    } else {
      const seen = new Set(out[at].cards.map((c) => c.activity.id));
      for (const c of g.cards)
        if (!seen.has(c.activity.id)) out[at].cards.push(c);
    }
  }
  return out;
}

// Reconcile the client's "load more" cursor when the server re-renders the newest
// page (issue #503). The Journal's first page and its `nextBefore` cursor are
// refreshed server-side on every auto-save (via revalidatePath). When that cursor
// MOVES — e.g. logging an activity on a day outside the loaded window rolls the oldest
// loaded day out of the first page, shifting the whole newest window — the locally
// held cursor (seeded only at mount) and any fetched older pages are stale: "load
// more" would fetch `date < oldBoundary`, which by construction never re-includes the
// day that just rolled out, so it silently disappears from the feed until a reload.
//
// Given the cursor the client last synced to (`seeded`) and the fresh server cursor
// (`next`), returns whether they diverged and the paging state to apply. On a change,
// the cursor resets to the new boundary and loaded older pages are dropped — their
// `nextBefore` chain spans the now-invalid gap the window shift opened, so paging must
// resume cleanly from the refreshed first page (where the rolled-out day is reachable
// again via `date < newBoundary`). Pure so the reset decision is unit-tested without
// the React component.
export function reconcileJournalPaging(
  seeded: string | null,
  next: string | null
): { changed: boolean; cursor: string | null } {
  if (seeded === next) return { changed: false, cursor: seeded };
  return { changed: true, cursor: next };
}

export interface BuildJournalCardsInput {
  // Activities newest-first (as getActivities returns them); grouped by date here.
  activities: Activity[];
  // Every exercise_set across `activities` (getSetsForActivities), bucketed here.
  sets: ExerciseSet[];
  // equipment_id -> implement name, for the per-set equipment labels.
  equipmentNames: Map<number, string>;
  // Bodyweight series for the per-activity calorie ESTIMATE (issue #151): each
  // manual activity is scored against the weigh-in nearest its own date.
  weights: DatedWeight[];
  units: UnitPrefs;
  // The app's TZ-local "today"/"yesterday" (lib/db) for the day-group labels.
  today: string;
  yesterday: string;
}

// Compact, unit-aware chips for the richer per-activity metrics carried by pull
// integrations (Strava). Each appears only when its column is present, so manual
// entries and Health Connect imports render nothing extra. Power, cadence, and
// kilojoules are cycling-only; temperature is outdoor-only; workout_type is a
// label — all set by the parser, so this just formats whatever is non-null.
export function activityMetrics(
  a: Activity,
  distanceUnit: DistanceUnit,
  estKcal: number | null = null
): string[] {
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
  // Estimated calories (issue #151) — the "≈" marks it as an estimate, visually
  // distinct from a device-measured value. Only present for manual activities.
  const est = formatEstimatedKcal(estKcal);
  if (est) m.push(est);
  return m;
}

// Bucket activities (already date-desc) into ordered day groups, building each
// activity's JournalCardData: display parts, header texts, metric chips, fault, and
// provenance. Pure — every side input (sets, equipment names, weights, today) is
// passed in, so the same fixture always yields the same cards.
export function buildJournalCards({
  activities,
  sets,
  equipmentNames,
  weights,
  units,
  today,
  yesterday,
}: BuildJournalCardsInput): DayGroup[] {
  const wu = units.weightUnit;

  const setsByActivity = new Map<number, ExerciseSet[]>();
  for (const s of sets) {
    const arr = setsByActivity.get(s.activity_id) ?? [];
    arr.push(s);
    setsByActivity.set(s.activity_id, arr);
  }

  // "Today"/"Yesterday" labels relative to the calendar/db notion of today
  // (TZ-local, matching lib/db).
  const dayLabel = (date: string): string => {
    if (date === today) return "Today";
    if (date === yesterday) return "Yesterday";
    return formatLongDate(date);
  };

  const groups: DayGroup[] = [];
  const byDate = new Map<string, DayGroup>();

  for (const a of activities) {
    const aSets = setsByActivity.get(a.id) ?? [];

    // Group sets by exercise, preserving first-seen order. Keyed lowercased so
    // component-name casing drift (imports) still matches, like the editor.
    const exOrder: string[] = [];
    const byExercise = new Map<string, ExerciseSet[]>();
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
      const equipment =
        eqId != null ? (equipmentNames.get(eqId) ?? null) : null;
      return {
        kind: "strength",
        name,
        muscle: muscleFor(name),
        text,
        status,
        equipment,
      };
    };

    // Prefer the stored components list; fall back to legacy (strength only). A
    // present-but-unparseable string is treated as an (empty) list — the same
    // structured path an empty "[]" takes; a truly absent string is legacy.
    const components: ActivityComponent[] | null = a.components
      ? parseComponents(a.components)
      : null;

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
      est_calories: a.est_calories,
      equipment_id: a.equipment_id,
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
        warmup: s.warmup,
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
      metrics: activityMetrics(
        a,
        units.distanceUnit,
        // Estimated calories for a manual activity, scored against the bodyweight
        // nearest its date (issue #151). null (no chip) for imported rows and when
        // no estimate can be computed.
        activityEstimateKcal(a, nearestBodyweightKg(weights, a.date))
      ),
      gear:
        a.equipment_id != null
          ? (equipmentNames.get(a.equipment_id) ?? null)
          : null,
      parts,
      // Flag rows the editor couldn't re-save as-is (imports, legacy data).
      fault: storedActivityFault(a, aSets),
      // Provenance chip + created/updated timestamps (issue #11).
      provenance: {
        label: activityProvenanceLabel(a.source, a.edited),
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      },
      // Fold-field values for the manual-merge conflict preview (issue #100).
      foldValues: pickFoldValues(a as unknown as Record<string, unknown>),
    };

    let group = byDate.get(a.date);
    if (!group) {
      group = { date: a.date, label: dayLabel(a.date), cards: [] };
      byDate.set(a.date, group);
      groups.push(group);
    }
    group.cards.push(card);
  }

  return groups;
}
