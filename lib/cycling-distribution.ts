import type { WeatherDay } from "./weather-situations";

export interface CyclingDistributionRide {
  date: string;
}

export interface CyclingMonthDistribution {
  month: number;
  label: string;
  shortLabel: string;
  rides: number;
  observedMonths: number;
  ridesPerObservedMonth: number;
}

export type CyclingSeasonKey = "winter" | "spring" | "summer" | "autumn";

export interface CyclingSeasonDistribution {
  key: CyclingSeasonKey;
  label: string;
  rides: number;
  observedMonths: number;
  ridesPerObservedMonth: number;
  percent: number;
}

export interface CyclingQuietPeriod {
  startMonth: string;
  endMonth: string;
  months: number;
}

export type CyclingWeatherConditionKey = "clear" | "cloudy" | "wet" | "wintry";

export interface CyclingWeatherCondition {
  key: CyclingWeatherConditionKey;
  label: string;
  availableDays: number;
  rideDays: number;
  rideDayRate: number;
}

export interface CyclingTemperatureBand {
  key: "cold" | "cool" | "warm" | "hot";
  label: string;
  rideDays: number;
  percent: number;
}

export interface CyclingWeatherDistribution {
  coverageDays: number;
  coveredRideDays: number;
  conditions: CyclingWeatherCondition[];
  temperatureBands: CyclingTemperatureBand[];
  insight: string | null;
}

export interface CyclingDistribution {
  firstRideDate: string | null;
  lastRideDate: string | null;
  observedCalendarMonths: number;
  months: CyclingMonthDistribution[];
  seasons: CyclingSeasonDistribution[];
  longestQuietPeriod: CyclingQuietPeriod | null;
  highlights: string[];
  weather: CyclingWeatherDistribution;
}

const MONTHS = [
  ["January", "J"],
  ["February", "F"],
  ["March", "M"],
  ["April", "A"],
  ["May", "M"],
  ["June", "J"],
  ["July", "J"],
  ["August", "A"],
  ["September", "S"],
  ["October", "O"],
  ["November", "N"],
  ["December", "D"],
] as const;

const SEASONS: { key: CyclingSeasonKey; label: string }[] = [
  { key: "winter", label: "Winter" },
  { key: "spring", label: "Spring" },
  { key: "summer", label: "Summer" },
  { key: "autumn", label: "Autumn" },
];

const CONDITION_LABELS: Record<CyclingWeatherConditionKey, string> = {
  clear: "Clear",
  cloudy: "Cloudy",
  wet: "Wet",
  wintry: "Wintry",
};

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function addMonths(key: string, amount: number): string {
  const [year, month] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthKeys(start: string, end: string): string[] {
  if (start > end) return [];
  const keys: string[] = [];
  for (let key = start; key <= end; key = addMonths(key, 1)) keys.push(key);
  return keys;
}

function seasonForMonth(month: number): CyclingSeasonKey {
  if (month === 12 || month <= 2) return "winter";
  if (month <= 5) return "spring";
  if (month <= 8) return "summer";
  return "autumn";
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function weatherCondition(
  day: Pick<WeatherDay, "weatherCode" | "precipitationMm">
): CyclingWeatherConditionKey | null {
  const code = day.weatherCode;
  const precipitation = day.precipitationMm;
  if (code == null && precipitation == null) return null;
  if (
    code != null &&
    ((code >= 71 && code <= 77) || (code >= 85 && code <= 86))
  ) {
    return "wintry";
  }
  if (
    (precipitation != null && precipitation > 0.2) ||
    (code != null && ((code >= 51 && code <= 69) || (code >= 80 && code <= 99)))
  ) {
    return "wet";
  }
  if (code === 0) return "clear";
  return "cloudy";
}

function temperatureBand(tempMaxC: number): CyclingTemperatureBand["key"] {
  if (tempMaxC < 10) return "cold";
  if (tempMaxC < 20) return "cool";
  if (tempMaxC < 30) return "warm";
  return "hot";
}

function quietPeriod(
  ridesByMonth: ReadonlyMap<string, number>,
  firstMonth: string,
  todayStr: string
): CyclingQuietPeriod | null {
  // A partial current month is not called a quiet month. The user has not had
  // the whole opportunity to ride yet.
  const completedEnd = addMonths(monthKey(todayStr), -1);
  let currentStart: string | null = null;
  let currentLength = 0;
  let best: CyclingQuietPeriod | null = null;

  for (const key of monthKeys(firstMonth, completedEnd)) {
    if ((ridesByMonth.get(key) ?? 0) === 0) {
      currentStart ??= key;
      currentLength += 1;
      if (!best || currentLength > best.months) {
        best = {
          startMonth: currentStart,
          endMonth: key,
          months: currentLength,
        };
      }
    } else {
      currentStart = null;
      currentLength = 0;
    }
  }
  return best;
}

function weatherDistribution(
  rideDates: ReadonlySet<string>,
  weatherDays: readonly WeatherDay[]
): CyclingWeatherDistribution {
  const byCondition = new Map<
    CyclingWeatherConditionKey,
    { availableDays: number; rideDays: number }
  >();
  const temperatureRideDays = new Map<CyclingTemperatureBand["key"], number>();
  let coveredRideDays = 0;
  let temperatureTotal = 0;

  for (const key of Object.keys(
    CONDITION_LABELS
  ) as CyclingWeatherConditionKey[]) {
    byCondition.set(key, { availableDays: 0, rideDays: 0 });
  }

  for (const day of weatherDays) {
    const isRideDay = rideDates.has(day.date);
    if (isRideDay) coveredRideDays += 1;
    const condition = weatherCondition(day);
    if (condition) {
      const totals = byCondition.get(condition)!;
      totals.availableDays += 1;
      if (isRideDay) totals.rideDays += 1;
    }
    if (isRideDay && day.tempMaxC != null) {
      const band = temperatureBand(day.tempMaxC);
      temperatureRideDays.set(band, (temperatureRideDays.get(band) ?? 0) + 1);
      temperatureTotal += 1;
    }
  }

  const conditions = (
    Object.keys(CONDITION_LABELS) as CyclingWeatherConditionKey[]
  ).map((key) => {
    const totals = byCondition.get(key)!;
    return {
      key,
      label: CONDITION_LABELS[key],
      ...totals,
      rideDayRate:
        totals.availableDays > 0
          ? round1((totals.rideDays / totals.availableDays) * 100)
          : 0,
    };
  });

  const tempLabels: Record<CyclingTemperatureBand["key"], string> = {
    cold: "Below 10°C",
    cool: "10–19°C",
    warm: "20–29°C",
    hot: "30°C+",
  };
  const temperatureBands = (
    Object.keys(tempLabels) as CyclingTemperatureBand["key"][]
  ).map((key) => {
    const rideDays = temperatureRideDays.get(key) ?? 0;
    return {
      key,
      label: tempLabels[key],
      rideDays,
      percent:
        temperatureTotal > 0
          ? Math.round((rideDays / temperatureTotal) * 100)
          : 0,
    };
  });

  const clear = byCondition.get("clear")!;
  const nonClear = conditions
    .filter((condition) => condition.key !== "clear")
    .reduce(
      (sum, condition) => ({
        availableDays: sum.availableDays + condition.availableDays,
        rideDays: sum.rideDays + condition.rideDays,
      }),
      { availableDays: 0, rideDays: 0 }
    );
  const clearRate =
    clear.availableDays > 0 ? clear.rideDays / clear.availableDays : 0;
  const nonClearRate =
    nonClear.availableDays > 0 ? nonClear.rideDays / nonClear.availableDays : 0;
  let insight: string | null = null;
  if (
    weatherDays.length >= 60 &&
    coveredRideDays >= 3 &&
    clear.availableDays >= 10 &&
    nonClear.availableDays >= 20 &&
    clearRate > 0 &&
    nonClearRate > 0
  ) {
    const ratio = clearRate / nonClearRate;
    if (ratio >= 1.5) {
      insight = `You ride ${round1(ratio)}× as often on clear days as on other days.`;
    } else if (ratio <= 2 / 3) {
      insight = `Your ride rate is ${Math.round((1 - ratio) * 100)}% lower on clear days than on other days.`;
    } else {
      insight = "Your ride rate is similar on clear and non-clear days.";
    }
  }

  return {
    coverageDays: weatherDays.length,
    coveredRideDays,
    conditions,
    temperatureBands,
    insight,
  };
}

// One pure answer to “when do I ride?” The month/season rates normalize for
// partial history, while weather uses cached days as its opportunity denominator
// so a common condition does not masquerade as a preference.
export function cyclingDistribution(
  rides: readonly CyclingDistributionRide[],
  weatherDays: readonly WeatherDay[],
  todayStr: string,
  labels: { singular: string; plural: string } = {
    singular: "ride",
    plural: "rides",
  }
): CyclingDistribution {
  const dates = rides.map((ride) => ride.date).sort();
  const firstRideDate = dates[0] ?? null;
  const lastRideDate = dates.at(-1) ?? null;
  const firstMonth = firstRideDate
    ? monthKey(firstRideDate)
    : monthKey(todayStr);
  const endMonth =
    lastRideDate && lastRideDate > todayStr
      ? monthKey(lastRideDate)
      : monthKey(todayStr);
  const observedKeys = firstRideDate ? monthKeys(firstMonth, endMonth) : [];
  const ridesByMonth = new Map<string, number>();
  for (const date of dates) {
    const key = monthKey(date);
    ridesByMonth.set(key, (ridesByMonth.get(key) ?? 0) + 1);
  }

  const months = MONTHS.map(([label, shortLabel], index) => {
    const month = index + 1;
    const matchingKeys = observedKeys.filter(
      (key) => Number(key.slice(5, 7)) === month
    );
    const rideCount = matchingKeys.reduce(
      (sum, key) => sum + (ridesByMonth.get(key) ?? 0),
      0
    );
    return {
      month,
      label,
      shortLabel,
      rides: rideCount,
      observedMonths: matchingKeys.length,
      ridesPerObservedMonth:
        matchingKeys.length > 0 ? round1(rideCount / matchingKeys.length) : 0,
    };
  });

  const seasonRows = new Map<
    CyclingSeasonKey,
    { rides: number; observedMonths: number }
  >();
  for (const { key } of SEASONS)
    seasonRows.set(key, { rides: 0, observedMonths: 0 });
  for (const key of observedKeys) {
    const season = seasonForMonth(Number(key.slice(5, 7)));
    const row = seasonRows.get(season)!;
    row.observedMonths += 1;
    row.rides += ridesByMonth.get(key) ?? 0;
  }
  const seasons = SEASONS.map(({ key, label }) => {
    const row = seasonRows.get(key)!;
    return {
      key,
      label,
      ...row,
      ridesPerObservedMonth:
        row.observedMonths > 0 ? round1(row.rides / row.observedMonths) : 0,
      percent:
        rides.length > 0 ? Math.round((row.rides / rides.length) * 100) : 0,
    };
  });

  const highlights: string[] = [];
  const winter = seasons.find((season) => season.key === "winter")!;
  if (winter.rides === 0 && winter.observedMonths >= 3) {
    highlights.push(
      `No winter ${labels.plural} across ${winter.observedMonths} observed winter months.`
    );
  }
  const busiest = [...seasons]
    .filter((season) => season.observedMonths >= 2 && season.rides >= 3)
    .sort(
      (a, b) =>
        b.ridesPerObservedMonth - a.ridesPerObservedMonth || b.rides - a.rides
    )[0];
  const overallRate =
    observedKeys.length > 0 ? rides.length / observedKeys.length : 0;
  if (busiest && busiest.ridesPerObservedMonth >= overallRate * 1.25) {
    highlights.push(
      `${busiest.label} is your busiest season at ${busiest.ridesPerObservedMonth} ${labels.plural} per observed month.`
    );
  }

  const rideDates = new Set(dates);
  return {
    firstRideDate,
    lastRideDate,
    observedCalendarMonths: observedKeys.length,
    months,
    seasons,
    longestQuietPeriod: firstRideDate
      ? quietPeriod(ridesByMonth, firstMonth, todayStr)
      : null,
    highlights,
    weather: weatherDistribution(rideDates, weatherDays),
  };
}
