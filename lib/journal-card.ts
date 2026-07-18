// Pure construction of the Journal feed's per-day cards (issue #334). This is the
// ~150 lines of derivation that used to live inline in
// app/(app)/training/HistorySection.tsx: set-grouping by lowercased exercise, the
// components-vs-legacy branch, the single-pure-effort header fold, the cardio
// distance/duration/speed detail string, and the imported metrics. Extracting
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
import {
  DEFAULT_FORMAT_PREFS,
  formatClock,
  type DisplayFormatPrefs,
  type TimeFormat,
} from "./format-date";
import type { SetStatus } from "./journal-format";
import { summarizeExercise, activityProvenanceLabel } from "./journal-format";
import { DOCUMENT_SOURCE_PREFIX } from "./body-metric-extract";
import { muscleFor } from "./lifts";
import { storedActivityFault } from "./activity-validate";
import { pickFoldValues } from "./import-review/conflicts";
import { formatLongDate } from "./format-date";
import { fmtDistance, fmtSpeed } from "./units";
import {
  activityCalorieDisplay,
  nearestBodyweightKg,
  formatActivityCalories,
  type DatedWeight,
} from "./calorie-estimate";
import {
  importedActivityDetails,
  pickImportedActivityMetrics,
} from "./activity-import-details";
import { zoneForBpm, type ZoneModel } from "./training-zones";

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
  timeText: string | null;
  durationText: string | null;
  distanceText: string | null;
  speedText: string | null;
  // Heart rate is a primary effort signal, shown with time/duration rather than
  // buried in the lower-priority provider-specific metrics row.
  heartRateText: string | null;
  // Measured active energy, or an explicitly approximate fallback when it is
  // missing, belongs with the primary summary rather than the rich-metrics row.
  calorieText: string | null;
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
    // True when this is a hand-edited INTEGRATION row (the user-edit lock, #133): the
    // sync leaves it untouched. Drives the "Resume sync updates" affordance (#659).
    // False for manual/document rows (never re-synced) and un-edited imports.
    editLocked: boolean;
  };
  // The row's fold-field values (issue #100) — the compact payload the manual-merge
  // conflict preview compares against a same-day sibling. Values are raw canonical
  // numbers/strings straight off the activity row.
  foldValues: Record<string, unknown>;
  // The activity's encoded GPS route polyline (issue #569), or null. Rendered as a
  // tile-free SVG route thumbnail on the card; only imported outdoor activities with
  // a captured route carry one.
  routePolyline: string | null;
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
  // The login's date/time display prefs (#964). Optional — pure-test call sites and
  // any caller that doesn't resolve prefs get the status-quo default (24h clock),
  // so the per-activity time label stays byte-identical unless a login opts into 12h.
  formatPrefs?: DisplayFormatPrefs;
  // The app's TZ-local "today"/"yesterday" (lib/db) for the day-group labels.
  today: string;
  yesterday: string;
  // activityId -> encoded GPS route polyline (issue #569), for the route thumbnail.
  // Optional (defaults to none) so existing pure-test call sites need no route data.
  routes?: Map<number, string>;
  // Device-measured active energy matched to each imported activity window.
  activeCalories?: Map<number, number>;
  // The active profile's canonical HR-zone model. The zone is resolved once per
  // activity and carried by ActivityEditData into both card and form renderers.
  zoneModel?: ZoneModel | null;
}

// Compact, unit-aware values for the richer per-activity metrics carried by pull
// integrations (Strava). Each appears only when its column is present, so manual
// entries and Health Connect imports render nothing extra. Power, cadence, and
// kilojoules are cycling-only; temperature is outdoor-only; workout_type is a
// label — all set by the parser, so this just formats whatever is non-null.
export function activityMetrics(
  a: Activity,
  distanceUnit: DistanceUnit
): string[] {
  const byKey = new Map(
    importedActivityDetails(a, distanceUnit).map((detail) => [
      detail.key,
      detail.value,
    ])
  );
  const m: string[] = [];
  const workoutType = byKey.get("workout_type");
  if (workoutType) m.push(workoutType);
  const elevation = byKey.get("elevation");
  if (elevation && a.elevation_m != null && a.elevation_m > 0)
    m.push(`↑ ${elevation}`);
  if (a.avg_power_w != null) {
    m.push(
      `${a.avg_power_w} W${a.weighted_avg_power_w != null ? ` (${a.weighted_avg_power_w} NP)` : ""}`
    );
  }
  for (const key of ["cadence", "kilojoules", "temperature"] as const) {
    const value = byKey.get(key);
    if (value) m.push(value);
  }
  const effort = byKey.get("relative_effort");
  if (effort) m.push(`Effort ${effort}`);
  return m;
}

export function activityHeartRateText(
  avgHr: number | null,
  maxHr: number | null
): string | null {
  if (avgHr == null) return null;
  return `♥ ${avgHr}${maxHr != null ? `/${maxHr}` : ""} bpm`;
}

// Compact stored wall-clock range for the Journal summary. Activity form values
// are HH:MM, while a few import/legacy paths may carry an ISO-like value; keep only
// the clock portion in either case and never invent a start from an end alone.
export function activityTimeText(
  startTime: string | null,
  endTime: string | null,
  timeFormat: TimeFormat = "24h"
): string | null {
  const clock = (value: string | null): string | null => {
    if (!value) return null;
    return (
      /^(\d{1,2}:\d{2})/.exec(value)?.[1] ??
      /T(\d{2}:\d{2})/.exec(value)?.[1] ??
      null
    );
  };
  // The stored wall-clock is 24-hour "HH:MM". The DEFAULT (24h) returns it verbatim
  // — byte-identical to today, with zero padding risk; only a 12h login reshapes it
  // via the shared clock seam (#964).
  const render = (hhmm: string): string => {
    if (timeFormat === "24h") return hhmm;
    const [h, m] = hhmm.split(":").map(Number);
    return formatClock("12h", h, m, "upper-space");
  };
  const start = clock(startTime);
  if (!start) return null;
  const end = clock(endTime);
  return end ? `${render(start)}–${render(end)}` : render(start);
}

// Bucket activities (already date-desc) into ordered day groups, building each
// activity's JournalCardData: display parts, header texts, metrics, fault, and
// provenance. Pure — every side input (sets, equipment names, weights, today) is
// passed in, so the same fixture always yields the same cards.
export function buildJournalCards({
  activities,
  sets,
  equipmentNames,
  weights,
  units,
  formatPrefs = DEFAULT_FORMAT_PREFS,
  today,
  yesterday,
  routes,
  activeCalories,
  zoneModel,
}: BuildJournalCardsInput): DayGroup[] {
  const wu = units.weightUnit;
  const timeFormat: TimeFormat = formatPrefs.timeFormat;

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
    // A pure cardio/sport activity keeps its canonical component as a clickable
    // row (so it opens detail, like strength exercises do), but its measurements
    // belong in the scan-first header summary rather than being repeated here.
    const multi = allParts.length > 1;
    const single = allParts.length === 1 ? allParts[0] : null;
    const singlePureEffort =
      single != null &&
      (single.kind === "cardio" || single.kind === "sport") &&
      (a.type === "cardio" || a.type === "sport");
    const parts = singlePureEffort
      ? [{ ...single, detail: "" }]
      : allParts.filter((p) => p.kind === "strength" || multi);

    const calorieDisplay = activityCalorieDisplay(
      a,
      nearestBodyweightKg(weights, a.date),
      activeCalories?.get(a.id)
    );
    const routePolyline = routes?.get(a.id) ?? null;
    const heartRateZone =
      zoneModel != null && a.avg_hr != null
        ? zoneForBpm(a.avg_hr, zoneModel)
        : null;
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
      imported_metrics: pickImportedActivityMetrics(
        a,
        activeCalories?.get(a.id) ?? null
      ),
      calorie_kcal: calorieDisplay?.kcal ?? null,
      calorie_estimated: calorieDisplay?.estimated ?? false,
      route_polyline: routePolyline,
      heart_rate_zone: heartRateZone,
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
        rpe: s.rpe,
      })),
    };

    const card: JournalCardData = {
      activity: editData,
      timeText: activityTimeText(a.start_time, a.end_time, timeFormat),
      durationText: a.duration_min == null ? null : `${a.duration_min} min`,
      distanceText:
        a.distance_km == null
          ? null
          : fmtDistance(a.distance_km, units.distanceUnit),
      speedText: fmtSpeed(a.distance_km, a.duration_min, units.distanceUnit),
      heartRateText: activityHeartRateText(a.avg_hr, a.max_hr),
      // Prefer device-measured active energy; when a provider omitted it, show
      // the same explicit "≈" MET estimate manual activities use whenever a
      // duration + nearby bodyweight make that possible.
      calorieText: formatActivityCalories(calorieDisplay),
      metrics: activityMetrics(a, units.distanceUnit),
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
        // Only an INTEGRATION row (not manual, not a document projection) can be
        // re-synced, so only those carry a clearable lock.
        editLocked:
          !!a.edited &&
          !!a.source &&
          a.source !== "manual" &&
          !a.source.startsWith(DOCUMENT_SOURCE_PREFIX),
      },
      // Fold-field values for the manual-merge conflict preview (issue #100).
      foldValues: pickFoldValues(a as unknown as Record<string, unknown>),
      // GPS route polyline for the tile-free SVG thumbnail (issue #569), or null.
      routePolyline,
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
