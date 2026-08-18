import type { WeatherDay } from "./weather-situations";

export interface SessionDistributionInput {
  date: string;
}

export interface SessionMonthDistribution {
  month: number;
  label: string;
  shortLabel: string;
  sessions: number;
  observedMonths: number;
  sessionsPerObservedMonth: number;
}

export type SessionSeasonKey = "winter" | "spring" | "summer" | "autumn";

export interface SessionSeasonDistribution {
  key: SessionSeasonKey;
  label: string;
  sessions: number;
  observedMonths: number;
  sessionsPerObservedMonth: number;
  percent: number;
}

export interface SessionQuietPeriod {
  startMonth: string;
  endMonth: string;
  months: number;
}

export type SessionWeatherConditionKey = "clear" | "cloudy" | "wet" | "wintry";

export interface SessionWeatherCondition {
  key: SessionWeatherConditionKey;
  label: string;
  availableDays: number;
  sessionDays: number;
  sessionDayRate: number;
}

export interface SessionTemperatureBand {
  key: "cold" | "cool" | "warm" | "hot";
  label: string;
  sessionDays: number;
  percent: number;
}

export interface SessionWeatherDistribution {
  coverageDays: number;
  coveredSessionDays: number;
  conditions: SessionWeatherCondition[];
  temperatureBands: SessionTemperatureBand[];
  insight: string | null;
}

export interface SessionDistribution {
  firstSessionDate: string | null;
  lastSessionDate: string | null;
  observedCalendarMonths: number;
  months: SessionMonthDistribution[];
  seasons: SessionSeasonDistribution[];
  longestQuietPeriod: SessionQuietPeriod | null;
  highlights: string[];
  weather: SessionWeatherDistribution;
}

export interface SessionDistributionLabels {
  singular: string;
  plural: string;
  verb: string;
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

const SEASONS: { key: SessionSeasonKey; label: string }[] = [
  { key: "winter", label: "Winter" },
  { key: "spring", label: "Spring" },
  { key: "summer", label: "Summer" },
  { key: "autumn", label: "Autumn" },
];

const CONDITION_LABELS: Record<SessionWeatherConditionKey, string> = {
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

function seasonForMonth(month: number): SessionSeasonKey {
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
): SessionWeatherConditionKey | null {
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

function temperatureBand(tempMaxC: number): SessionTemperatureBand["key"] {
  if (tempMaxC < 10) return "cold";
  if (tempMaxC < 20) return "cool";
  if (tempMaxC < 30) return "warm";
  return "hot";
}

function quietPeriod(
  sessionsByMonth: ReadonlyMap<string, number>,
  firstMonth: string,
  todayStr: string
): SessionQuietPeriod | null {
  // A partial current month is not called a quiet month. The user has not had
  // the whole opportunity to log a session yet.
  const completedEnd = addMonths(monthKey(todayStr), -1);
  let currentStart: string | null = null;
  let currentLength = 0;
  let best: SessionQuietPeriod | null = null;

  for (const key of monthKeys(firstMonth, completedEnd)) {
    if ((sessionsByMonth.get(key) ?? 0) === 0) {
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
  sessionDates: ReadonlySet<string>,
  weatherDays: readonly WeatherDay[],
  labels: SessionDistributionLabels
): SessionWeatherDistribution {
  const byCondition = new Map<
    SessionWeatherConditionKey,
    { availableDays: number; sessionDays: number }
  >();
  const temperatureSessionDays = new Map<
    SessionTemperatureBand["key"],
    number
  >();
  let coveredSessionDays = 0;
  let temperatureTotal = 0;

  for (const key of Object.keys(
    CONDITION_LABELS
  ) as SessionWeatherConditionKey[]) {
    byCondition.set(key, { availableDays: 0, sessionDays: 0 });
  }

  for (const day of weatherDays) {
    const isSessionDay = sessionDates.has(day.date);
    if (isSessionDay) coveredSessionDays += 1;
    const condition = weatherCondition(day);
    if (condition) {
      const totals = byCondition.get(condition)!;
      totals.availableDays += 1;
      if (isSessionDay) totals.sessionDays += 1;
    }
    if (isSessionDay && day.tempMaxC != null) {
      const band = temperatureBand(day.tempMaxC);
      temperatureSessionDays.set(
        band,
        (temperatureSessionDays.get(band) ?? 0) + 1
      );
      temperatureTotal += 1;
    }
  }

  const conditions = (
    Object.keys(CONDITION_LABELS) as SessionWeatherConditionKey[]
  ).map((key) => {
    const totals = byCondition.get(key)!;
    return {
      key,
      label: CONDITION_LABELS[key],
      ...totals,
      sessionDayRate:
        totals.availableDays > 0
          ? round1((totals.sessionDays / totals.availableDays) * 100)
          : 0,
    };
  });

  const tempLabels: Record<SessionTemperatureBand["key"], string> = {
    cold: "Below 10°C",
    cool: "10–19°C",
    warm: "20–29°C",
    hot: "30°C+",
  };
  const temperatureBands = (
    Object.keys(tempLabels) as SessionTemperatureBand["key"][]
  ).map((key) => {
    const sessionDays = temperatureSessionDays.get(key) ?? 0;
    return {
      key,
      label: tempLabels[key],
      sessionDays,
      percent:
        temperatureTotal > 0
          ? Math.round((sessionDays / temperatureTotal) * 100)
          : 0,
    };
  });

  const clear = byCondition.get("clear")!;
  const nonClear = conditions
    .filter((condition) => condition.key !== "clear")
    .reduce(
      (sum, condition) => ({
        availableDays: sum.availableDays + condition.availableDays,
        sessionDays: sum.sessionDays + condition.sessionDays,
      }),
      { availableDays: 0, sessionDays: 0 }
    );
  const clearRate =
    clear.availableDays > 0 ? clear.sessionDays / clear.availableDays : 0;
  const nonClearRate =
    nonClear.availableDays > 0
      ? nonClear.sessionDays / nonClear.availableDays
      : 0;
  let insight: string | null = null;
  if (
    weatherDays.length >= 60 &&
    coveredSessionDays >= 3 &&
    clear.availableDays >= 10 &&
    nonClear.availableDays >= 20 &&
    clearRate > 0 &&
    nonClearRate > 0
  ) {
    const ratio = clearRate / nonClearRate;
    if (ratio >= 1.5) {
      insight = `You ${labels.verb} ${round1(ratio)}× as often on clear days as on other days.`;
    } else if (ratio <= 2 / 3) {
      insight = `Your ${labels.singular} rate is ${Math.round((1 - ratio) * 100)}% lower on clear days than on other days.`;
    } else {
      insight = `Your ${labels.singular} rate is similar on clear and non-clear days.`;
    }
  }

  return {
    coverageDays: weatherDays.length,
    coveredSessionDays,
    conditions,
    temperatureBands,
    insight,
  };
}

// One pure answer to “when do I train?” The month/season rates normalize for
// partial history, while weather uses cached days as its opportunity denominator
// so a common condition does not masquerade as a preference.
export function sessionDistribution(
  sessions: readonly SessionDistributionInput[],
  weatherDays: readonly WeatherDay[],
  todayStr: string,
  labels: SessionDistributionLabels = {
    singular: "session",
    plural: "sessions",
    verb: "train",
  }
): SessionDistribution {
  const dates = sessions.map((session) => session.date).sort();
  const firstSessionDate = dates[0] ?? null;
  const lastSessionDate = dates.at(-1) ?? null;
  const firstMonth = firstSessionDate
    ? monthKey(firstSessionDate)
    : monthKey(todayStr);
  const endMonth =
    lastSessionDate && lastSessionDate > todayStr
      ? monthKey(lastSessionDate)
      : monthKey(todayStr);
  const observedKeys = firstSessionDate ? monthKeys(firstMonth, endMonth) : [];
  const sessionsByMonth = new Map<string, number>();
  for (const date of dates) {
    const key = monthKey(date);
    sessionsByMonth.set(key, (sessionsByMonth.get(key) ?? 0) + 1);
  }

  const months = MONTHS.map(([label, shortLabel], index) => {
    const month = index + 1;
    const matchingKeys = observedKeys.filter(
      (key) => Number(key.slice(5, 7)) === month
    );
    const sessionCount = matchingKeys.reduce(
      (sum, key) => sum + (sessionsByMonth.get(key) ?? 0),
      0
    );
    return {
      month,
      label,
      shortLabel,
      sessions: sessionCount,
      observedMonths: matchingKeys.length,
      sessionsPerObservedMonth:
        matchingKeys.length > 0
          ? round1(sessionCount / matchingKeys.length)
          : 0,
    };
  });

  const seasonRows = new Map<
    SessionSeasonKey,
    { sessions: number; observedMonths: number }
  >();
  for (const { key } of SEASONS)
    seasonRows.set(key, { sessions: 0, observedMonths: 0 });
  for (const key of observedKeys) {
    const season = seasonForMonth(Number(key.slice(5, 7)));
    const row = seasonRows.get(season)!;
    row.observedMonths += 1;
    row.sessions += sessionsByMonth.get(key) ?? 0;
  }
  const seasons = SEASONS.map(({ key, label }) => {
    const row = seasonRows.get(key)!;
    return {
      key,
      label,
      ...row,
      sessionsPerObservedMonth:
        row.observedMonths > 0 ? round1(row.sessions / row.observedMonths) : 0,
      percent:
        sessions.length > 0
          ? Math.round((row.sessions / sessions.length) * 100)
          : 0,
    };
  });

  const highlights: string[] = [];
  const winter = seasons.find((season) => season.key === "winter")!;
  if (winter.sessions === 0 && winter.observedMonths >= 3) {
    highlights.push(
      `No winter ${labels.plural} across ${winter.observedMonths} observed winter months.`
    );
  }
  const busiest = [...seasons]
    .filter((season) => season.observedMonths >= 2 && season.sessions >= 3)
    .sort(
      (a, b) =>
        b.sessionsPerObservedMonth - a.sessionsPerObservedMonth ||
        b.sessions - a.sessions
    )[0];
  const overallRate =
    observedKeys.length > 0 ? sessions.length / observedKeys.length : 0;
  if (busiest && busiest.sessionsPerObservedMonth >= overallRate * 1.25) {
    highlights.push(
      `${busiest.label} is your busiest season at ${busiest.sessionsPerObservedMonth} ${labels.plural} per observed month.`
    );
  }

  const sessionDates = new Set(dates);
  return {
    firstSessionDate,
    lastSessionDate,
    observedCalendarMonths: observedKeys.length,
    months,
    seasons,
    longestQuietPeriod: firstSessionDate
      ? quietPeriod(sessionsByMonth, firstMonth, todayStr)
      : null,
    highlights,
    weather: weatherDistribution(sessionDates, weatherDays, labels),
  };
}
