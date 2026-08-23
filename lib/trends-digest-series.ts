// Pure supplemental series builders for the Trends digest (#3397).
//
// These series are digest candidates only: they do not join TREND_METRIC_SLUGS,
// create tiles, or acquire detail pages. The shared news gate in trends-digest.ts
// remains the only admission decision.

import { shiftDateStr } from "./date";
import { FOOD_GROUPS, foodGroupShortName } from "./food-groups";
import {
  SOURCE_PREFERENCE,
  pickOneSourcePerDay,
  pickRowsOneOriginPerSourceDay,
} from "./metric-sources";
import {
  parseMetricSourcePriority,
  resolveMetricSources,
} from "./metric-source-priority";
import { mergeProteinSources, buildMacroFiberSeries } from "./nutrition-trends";
import { practiceDisplayName, practiceIdentity } from "./practice";
import { filterSeriesByRange } from "./trends";
import type { DigestSeries } from "./trends-digest";
import type { DateRange } from "./timeline-format";
import {
  practiceDigestEligible,
  practiceDigestKey,
  PRACTICE_DIGEST_MIN_CHANGE,
} from "./trends-practices";
import type { CadenceWindow } from "./queries/cadence-ledger";
import type { TrendsDigestGatherRow } from "./queries/trends-digest";

// Protein is continuous grams and already rounded to whole grams by the Nutrition
// chart. A 20% endpoint move must still pass #3389's dispersion/behavior gate.
export const NUTRITION_PROTEIN_DIGEST_MIN_CHANGE = 0.2;
// Servings are small integers. A one-serving move from a two-serving baseline is
// the smallest useful magnitude; smaller relative jitter stays quiet.
export const NUTRITION_SERVINGS_DIGEST_MIN_CHANGE = 0.5;
// Like practice cadence, one extra day in an ordinary 3/week rhythm is only 33%.
// Requiring 34% prevents that single-day edge from clearing materiality by itself;
// a larger shift must then also pass the shared news gate.
export const LOGGING_CADENCE_DIGEST_MIN_CHANGE = 0.34;
export const LOGGING_CADENCE_DIGEST_MIN_WEEKS = 4;

export const NUTRITION_DIGEST_PREFIX = "nutrition:";
export const LOGGING_DIGEST_PREFIX = "logging:";

export interface SupplementalDigestInputs {
  practiceTargets: {
    identity: string;
    name: string;
    perWeek: number | null;
    weeks: { start: string; count: number }[];
  }[];
  proteinDays: { date: string; value: number }[];
  foodServings: { date: string; group: string; servings: number }[];
  foodDates: string[];
  doseDates: string[];
  weighingDates: string[];
}

const datesFor = (
  rows: readonly TrendsDigestGatherRow[],
  kind: TrendsDigestGatherRow["kind"]
): string[] =>
  rows.flatMap((row) => (row.kind === kind && row.date ? [row.date] : []));

function countsByWindow(
  dates: readonly string[],
  windows: readonly CadenceWindow[]
): number[] {
  const unique = new Set(dates);
  return windows.map(
    (window) =>
      [...unique].filter((date) => date >= window.start && date <= window.end)
        .length
  );
}

// Turn the one query-layer union into the exact inputs the pure family builders
// consume. Source election and manual-vs-tracked precedence are the SAME primitives
// getMacroFiberDays uses for the Nutrition chart.
export function supplementalDigestInputs(
  rows: readonly TrendsDigestGatherRow[],
  windows: readonly CadenceWindow[],
  range: DateRange
): SupplementalDigestInputs {
  const trackedRows = rows.flatMap((row) =>
    row.kind === "macro-tracked" && row.key && row.date && row.value != null
      ? [
          {
            metric: row.key,
            date: row.date,
            source: row.source,
            origin: row.origin,
            value: row.value,
          },
        ]
      : []
  );
  const priority = parseMetricSourcePriority(
    rows.find((row) => row.kind === "source-priority")?.key
  );
  const trackedFor = (metric: string) => {
    const candidates = trackedRows.filter((row) => row.metric === metric);
    return pickOneSourcePerDay(
      pickRowsOneOriginPerSourceDay(
        candidates,
        (row) => row.date,
        (row) => row.source,
        (row) => row.origin,
        (row) => row.value
      ),
      resolveMetricSources(metric, priority, SOURCE_PREFERENCE)
    ).sort((a, b) => a.date.localeCompare(b.date));
  };
  const logged = rows.flatMap((row) =>
    row.kind === "protein-logged" && row.date && row.value != null
      ? [{ date: row.date, value: row.value }]
      : []
  );
  const proteinDays = filterSeriesByRange(
    buildMacroFiberSeries({
      protein: mergeProteinSources(trackedFor("protein_g"), logged),
      carbs: trackedFor("carbs_g"),
      fat: trackedFor("fat_g"),
      fiber: trackedFor("fiber_g"),
    }).map((day) => ({ date: day.date, value: day.protein })),
    range
  );

  const practiceLogDates = rows.filter(
    (row) => row.kind === "practice-log" && row.date
  );
  const practiceTargets = rows
    .filter((row) => row.kind === "practice-target" && row.key)
    .map((target) => {
      const identity = practiceIdentity(target.key!);
      const dates = practiceLogDates.flatMap((row) =>
        practiceIdentity(row.key ?? "") === identity && row.date
          ? [row.date]
          : []
      );
      const counts = countsByWindow(dates, windows);
      return {
        identity,
        name: practiceDisplayName({
          targetSpelling: target.key,
          identity,
        }),
        perWeek: target.value,
        weeks: windows.map((window, index) => ({
          start: window.start,
          count: counts[index],
        })),
      };
    });

  return {
    practiceTargets,
    proteinDays,
    foodServings: rows.flatMap((row) =>
      row.kind === "food-serving" && row.date && row.key && row.value != null
        ? (!range.from || row.date >= range.from) &&
          (!range.to || row.date <= range.to)
          ? [{ date: row.date, group: row.key, servings: row.value }]
          : []
        : []
    ),
    foodDates: datesFor(rows, "food-serving"),
    doseDates: datesFor(rows, "dose-log"),
    weighingDates: datesFor(rows, "weight-log"),
  };
}

export function buildPracticeDigestSeriesFromInputs(
  practices: readonly SupplementalDigestInputs["practiceTargets"][number][]
): DigestSeries[] {
  return practices
    .filter((practice) =>
      practiceDigestEligible({
        perWeek: practice.perWeek,
        weeks: practice.weeks,
      })
    )
    .map((practice) => ({
      key: practiceDigestKey(practice.identity),
      label: `${practice.name} cadence`,
      unit: "/wk",
      points: practice.weeks.map((week) => ({
        date: week.start,
        value: week.count,
      })),
      minPctChange: PRACTICE_DIGEST_MIN_CHANGE,
    }));
}

export function buildNutritionDigestSeries(input: {
  proteinDays: readonly { date: string; value: number }[];
  foodServings: readonly { date: string; group: string; servings: number }[];
}): DigestSeries[] {
  const out: DigestSeries[] = [];
  if (input.proteinDays.length > 0) {
    out.push({
      key: `${NUTRITION_DIGEST_PREFIX}protein`,
      label: "Protein",
      unit: " g",
      points: [...input.proteinDays],
      minPctChange: NUTRITION_PROTEIN_DIGEST_MIN_CHANGE,
    });
  }

  // A missing group on a day where some food WAS logged is a real zero in the
  // Nutrition matrix. A day with no food rows remains absent; logging cadence owns
  // that separate fact.
  const dates = [...new Set(input.foodServings.map((row) => row.date))].sort();
  const groups = [...new Set(input.foodServings.map((row) => row.group))];
  const values = new Map(
    input.foodServings.map((row) => [
      `${row.date}\u0000${row.group}`,
      row.servings,
    ])
  );
  for (const group of groups) {
    const meta = FOOD_GROUPS.find((candidate) => candidate.slug === group);
    out.push({
      key: `${NUTRITION_DIGEST_PREFIX}food-group:${group}`,
      label: meta ? foodGroupShortName(group) : group,
      unit: " servings/day",
      points: dates.map((date) => ({
        date,
        value: values.get(`${date}\u0000${group}`) ?? 0,
      })),
      minPctChange: NUTRITION_SERVINGS_DIGEST_MIN_CHANGE,
    });
  }
  return out;
}

export function buildLoggingCadenceDigestSeries(input: {
  windows: readonly CadenceWindow[];
  foodDates: readonly string[];
  doseDates: readonly string[];
  weighingDates: readonly string[];
}): DigestSeries[] {
  if (input.windows.length < LOGGING_CADENCE_DIGEST_MIN_WEEKS) return [];
  const domains = [
    { key: "food", label: "Food logging", dates: input.foodDates },
    { key: "dose", label: "Dose logging", dates: input.doseDates },
    { key: "weighing", label: "Weighing", dates: input.weighingDates },
  ] as const;
  return domains.flatMap((domain) => {
    const counts = countsByWindow(domain.dates, input.windows);
    if (!counts.some((count) => count > 0)) return [];
    return [
      {
        key: `${LOGGING_DIGEST_PREFIX}${domain.key}`,
        label: domain.label,
        unit: "/wk",
        points: input.windows.map((window, index) => ({
          date: window.start,
          value: counts[index],
        })),
        minPctChange: LOGGING_CADENCE_DIGEST_MIN_CHANGE,
      },
    ];
  });
}

export function digestGatherBounds(
  range: DateRange,
  windows: readonly CadenceWindow[],
  todayStr: string
): {
  practiceFrom: string;
  proteinFrom: string;
  foodFrom: string;
  doseFrom: string;
  to: string;
} {
  const practiceFrom = windows[0]?.start ?? shiftDateStr(todayStr, -27);
  return {
    practiceFrom,
    proteinFrom: range.from ?? "0000-01-01",
    foodFrom: practiceFrom,
    doseFrom: practiceFrom,
    to: range.to && range.to < todayStr ? range.to : todayStr,
  };
}
