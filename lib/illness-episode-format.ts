// Pure shapes + formatters for the illness-episode view (issue #801). NO DB/network
// imports, so these are unit-tested in lib/__tests__ and shared by EVERY surface
// (timeline card, dashboard illness hero, Household page "sick day" chip, share/print) —
// the one-question-one-computation discipline (#221). The DB gather that fills an
// `AssembledEpisode` lives in lib/illness-episode.ts; this module never touches the DB.
//
// "Day N" is computed off the profile-TZ calendar-day boundaries the caller passes in
// (start day = day 1), matching the symptom-episode derivation's [start, end) semantics
// (lib/symptom-episode.ts): `end` is EXCLUSIVE (the first inactive day), so the last
// active day is `end` minus one; an ongoing episode (`end` null) runs through today.

import { daysBetweenDateStr, shiftDateStr, zonedWallTimeToUtc } from "./date";
import {
  formatClockValue,
  formatCompactRelativeTime,
  type TimeFormat,
} from "./format-date";
import type { TemperatureUnit } from "./settings";
import { fmtTemp } from "./units";
import { formatMedicationDoseProduct } from "./medication-dose-format";

// A single severity reading of one symptom on one day.
export interface SymptomSeriesPoint {
  date: string;
  severity: number; // 1–4
  note: string | null;
}

// One symptom's severity-over-time series within the episode (oldest day first).
export interface SymptomSeries {
  symptom: string; // stored key (curated slug or custom name)
  label: string; // display label
  points: SymptomSeriesPoint[];
  maxSeverity: number;
}

// A temperature reading on the fever curve. `degF` is canonical (#800); `time` is the
// bare "HH:MM" the reading rides in medical_records.notes (day-granular date + clock).
export interface TemperaturePoint {
  // Present for DB-backed episode assemblies; optional for synthetic summaries/tests.
  id?: number;
  date: string;
  time: string | null;
  degF: number;
  flag: string | null; // reference-range flag ("high" for a fever), or null
}

// One PRN administration (#797) within the episode, with its snapshotted dose.
export interface AdministrationPoint {
  // Present for DB-backed episode assemblies; optional for synthetic summaries/tests.
  id?: number;
  date: string;
  time: string | null; // profile-local clock of given_at, or null
  time24?: string | null; // profile-local HH:MM for the edit control
  amount: string | null; // snapshot at confirm time ("200 mg")
  product?: string | null; // formulation/concentration at confirm time
}

export type IllnessTimelineEvent =
  | {
      kind: "temperature";
      id: number | string;
      date: string;
      time: string | null;
      time24: string | null;
      label: "Temperature";
      detail: string;
      degF: number;
      flag: string | null;
    }
  | {
      kind: "medication";
      id: number | string;
      date: string;
      time: string | null;
      time24: string | null;
      label: string;
      detail: string;
      itemId: number;
      amount: string | null;
    }
  | {
      kind: "symptom";
      id: string;
      date: string;
      time: null;
      time24: null;
      label: string;
      detail: string;
      symptom: string;
      severity: number;
      note: string | null;
    };

// One chronological ledger for the episode page and its read-only share. Timed
// readings sort within their day; day-only symptom observations sit after them.
export function illnessTimelineEvents(
  episode: Pick<AssembledEpisode, "temperatures" | "medications" | "symptoms">
): IllnessTimelineEvent[] {
  const events: IllnessTimelineEvent[] = [
    ...episode.temperatures.map((t, index) => ({
      kind: "temperature" as const,
      id: t.id ?? `temperature:${t.date}:${t.time ?? "none"}:${index}`,
      date: t.date,
      time: t.time,
      time24: t.time,
      label: "Temperature" as const,
      detail: t.degF.toFixed(1),
      degF: t.degF,
      flag: t.flag,
    })),
    ...episode.medications.flatMap((m) =>
      m.administrations.map((a, index) => ({
        kind: "medication" as const,
        id: a.id ?? `medication:${m.itemId}:${a.date}:${index}`,
        date: a.date,
        time: a.time,
        time24: a.time24 ?? null,
        label: m.name,
        detail:
          formatMedicationDoseProduct(a.amount, a.product ?? m.product) ||
          "Amount not recorded",
        itemId: m.itemId,
        amount: a.amount,
      }))
    ),
    ...episode.symptoms.flatMap((s) =>
      s.points.map((p) => ({
        kind: "symptom" as const,
        id: `${s.symptom}:${p.date}`,
        date: p.date,
        time: null,
        time24: null,
        label: s.label,
        detail: severityLabelForTimeline(p.severity),
        symptom: s.symptom,
        severity: p.severity,
        note: p.note,
      }))
    ),
  ];
  return events.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time24 ?? "99:99").localeCompare(b.time24 ?? "99:99") ||
      a.label.localeCompare(b.label)
  );
}

export function relativeEpisodeDateLabel(
  date: string,
  asOf: string
): string | null {
  const daysAgo = daysBetweenDateStr(date, asOf);
  if (daysAgo == null) return null;
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo > 1) return `${daysAgo} days ago`;
  if (daysAgo === -1) return "Tomorrow";
  return `In ${Math.abs(daysAgo)} days`;
}

function severityLabelForTimeline(severity: number): string {
  return (
    ["", "Mild", "Moderate", "Severe", "Very severe"][severity] ??
    `Severity ${severity}`
  );
}

// A medication administered during the episode, with its per-administration ledger.
export interface EpisodeMedication {
  itemId: number;
  name: string;
  product?: string | null;
  count: number;
  administrations: AdministrationPoint[];
}

export interface LatestEpisodeDose extends AdministrationPoint {
  itemId: number;
  name: string;
  product?: string | null;
}

// A condition whose onset falls inside the episode window — bridged/promoted context.
export interface EpisodeCondition {
  id: number;
  name: string;
  status: string;
  onset_date: string | null;
  resolved_date: string | null;
  fromEpisode: boolean; // promoted FROM this episode (external_id marker)
}

// The one assembled model every surface formats over.
export interface AssembledEpisode {
  // The stored episode row id (#856), when assembled from a row — the [id] route +
  // links key on it. Null for a synthetic/derived assembly with no backing row.
  id: number | null;
  situation: string;
  start: string | null; // inclusive first active day, or null (active before the log)
  end: string | null; // EXCLUSIVE end (first inactive day), or null (ongoing)
  ongoing: boolean;
  // The concrete day window the data was gathered over (inclusive both ends). `firstDay`
  // falls back to the earliest data day when `start` is null; `lastActiveDay` is
  // `end`-minus-one for a closed episode, else `asOf` (today) for an ongoing one.
  firstDay: string | null;
  lastActiveDay: string | null;
  asOf: string; // the profile-local day the assembly was taken "as of"
  dayCount: number | null; // inclusive day span, when firstDay is known

  symptoms: SymptomSeries[]; // worst-severity-first
  distinctSymptomCount: number;

  temperatures: TemperaturePoint[]; // date then time ascending
  maxTempF: number | null;
  latestTemp: TemperaturePoint | null;

  medications: EpisodeMedication[];
  totalAdministrations: number;

  conditions: EpisodeCondition[];

  // Free notes, date-tagged, oldest first (symptom notes + timed temperature notes).
  notes: { date: string; text: string }[];
}

// Stable external_id stamped on a condition promoted FROM an episode. The episode row
// id — unlike its editable situation/start boundary — is the identity, so correcting
// "first day sick" cannot detach the condition, make undo miss it, or permit a duplicate.
// Pure so the gather, migration, and write paths share the same representation.
export function episodeConditionExternalId(episodeId: number): string {
  return `illness-episode:${episodeId}`;
}

// Optional previous-day quick-log target for the episode page. A closed episode uses
// its explicit day picker; an open episode may offer yesterday only when that day is
// inside its range. A null start means the known episode extends before the log.
export function episodeAlternateLogDate(
  ongoing: boolean,
  rangeStart: string | null,
  logDate: string
): string | null {
  if (!ongoing) return null;
  const yesterday = shiftDateStr(logDate, -1);
  return rangeStart == null || yesterday >= rangeStart ? yesterday : null;
}

// "Day N" of the episode as of a given day (start day = day 1). Null when the start is
// unknown (before-log episode) or the dates don't parse.
export function episodeDayNumber(
  start: string | null,
  asOf: string
): number | null {
  if (!start) return null;
  const d = daysBetweenDateStr(start, asOf);
  if (d == null) return null;
  return Math.max(1, d + 1);
}

export type FeverTrend = "rising" | "falling" | "steady" | null;

// Direction of the fever curve: compares the mean of the earlier half of FEVER-flagged
// readings to the later half. Null when there aren't at least two fever readings (no
// curve to speak of). A ≥0.5°F gap is needed to read as rising/falling, else steady.
export function feverTrend(temps: readonly TemperaturePoint[]): FeverTrend {
  const fevers = temps.filter((t) => t.flag === "high");
  if (fevers.length < 2) return null;
  const mid = Math.floor(fevers.length / 2);
  const early = fevers.slice(0, mid);
  const late = fevers.slice(fevers.length - mid);
  const mean = (xs: TemperaturePoint[]) =>
    xs.reduce((s, t) => s + t.degF, 0) / xs.length;
  const delta = mean(late) - mean(early);
  if (delta >= 0.5) return "rising";
  if (delta <= -0.5) return "falling";
  return "steady";
}

// The fever phrase for a headline ("fever trending down"), or null when there's no
// fever curve (so the caller omits the clause).
export function feverTrendLabel(trend: FeverTrend): string | null {
  switch (trend) {
    case "rising":
      return "fever trending up";
    case "falling":
      return "fever trending down";
    case "steady":
      return "fever steady";
    default:
      return null;
  }
}

// A compact "3×" style count phrase for a med, or the med name with its count.
function medCountPhrase(m: EpisodeMedication): string {
  return `${m.name.toLowerCase()} ${m.count}×`;
}

// The one-line episode headline shared by the timeline card and the episode header:
//   "Illness · day 4 · fever trending down · 3 symptoms · ibuprofen 3×"
// Clauses are omitted when their data is absent, so a bare episode reads "Illness · day 1".
export function episodeHeadline(ep: AssembledEpisode): string {
  const parts: string[] = [ep.situation];
  const day = episodeDayNumber(ep.start, ep.lastActiveDay ?? ep.asOf);
  if (day != null) parts.push(`day ${day}`);
  const fever = feverTrendLabel(feverTrend(ep.temperatures));
  if (fever) parts.push(fever);
  if (ep.distinctSymptomCount > 0) {
    parts.push(
      `${ep.distinctSymptomCount} symptom${ep.distinctSymptomCount === 1 ? "" : "s"}`
    );
  }
  // Up to two most-administered meds, so the line stays short.
  const meds = ep.medications
    .filter((m) => m.count > 0)
    .slice(0, 2)
    .map(medCountPhrase);
  parts.push(...meds);
  return parts.join(" · ");
}

export interface EpisodeCollapsedStatus {
  dayLabel: string;
  temperature: {
    value: string;
    when: string | null;
    high: boolean;
  } | null;
  lastMeds: { name: string; dose: string | null; when: string | null } | null;
  worsening: boolean;
}

function collapsedReadingWhen(
  date: string,
  time: string | null,
  asOf: string,
  todayPrefix: string,
  timeContext?: EpisodeReadingTimeContext
): string | null {
  const relative = relativeEpisodeDateLabel(date, asOf);
  const clock = time ? formatClockValue(time, timeContext?.timeFormat) : null;
  if (relative === "Today") {
    if (time && clock) {
      return `${todayPrefix}${readingClockWithRelativeAge(date, time, timeContext)}`;
    }
    return "today";
  }
  if (relative && clock) return `${relative}, ${clock}`;
  return relative ?? clock;
}

export interface EpisodeReadingTimeContext {
  timeZone?: string;
  timeFormat?: TimeFormat;
  now?: Date;
}

// Pair a profile-local reading clock with its current age for today's illness status
// ("5:00 PM (2 hrs ago)"). Stored illness readings carry a local date + clock rather
// than an absolute timestamp, so the profile timezone is required to derive the instant.
// Invalid/imported clocks keep their exact display and simply omit relative age.
export function readingClockWithRelativeAge(
  date: string,
  time: string,
  context?: EpisodeReadingTimeContext
): string {
  const clock = formatClockValue(time, context?.timeFormat);
  if (!context?.timeZone) return clock;
  const storedClock = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(time.trim());
  const displayClock = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(time.trim());
  if (!storedClock && !displayClock) return clock;
  const match = storedClock ?? displayClock!;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (displayClock) {
    if (hour < 1 || hour > 12) return clock;
    hour = (hour % 12) + (displayClock[3].toLowerCase() === "p" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return clock;

  const instant = zonedWallTimeToUtc(
    context.timeZone,
    date,
    `${String(hour).padStart(2, "0")}:${match[2]}`
  );
  if (Number.isNaN(instant.getTime())) return clock;
  const age = formatCompactRelativeTime(
    instant.toISOString(),
    context.now ?? new Date()
  );
  return `${clock} (${age})`;
}

// The dashboard cockpit's compact safety summary. It deliberately favors the latest
// reading and administration times over aggregate symptom/med counts: those are the
// facts a collapsed card must answer without making the user reopen it. Color remains
// a rendering concern, but the high/worsening booleans ensure every host applies the
// same existing semantic treatment.
export function episodeCollapsedStatus(
  ep: AssembledEpisode,
  tempUnit: TemperatureUnit = "F",
  timeContext?: EpisodeReadingTimeContext
): EpisodeCollapsedStatus {
  const day = episodeDayNumber(ep.start, ep.lastActiveDay ?? ep.asOf);
  const temperature = ep.latestTemp;
  const lastDose = episodeLatestDose(ep);
  return {
    dayLabel: day != null ? `${ep.situation} · Day ${day}` : ep.situation,
    temperature: temperature
      ? {
          value: fmtTemp(temperature.degF, tempUnit),
          when: collapsedReadingWhen(
            temperature.date,
            temperature.time,
            ep.asOf,
            "at ",
            timeContext
          ),
          high: temperature.flag === "high",
        }
      : null,
    lastMeds: lastDose
      ? {
          name: lastDose.name,
          dose: formatMedicationDoseProduct(lastDose.amount, lastDose.product),
          when: collapsedReadingWhen(
            lastDose.date,
            lastDose.time,
            ep.asOf,
            "",
            timeContext
          ),
        }
      : null,
    worsening: episodeIsWorsening(ep),
  };
}

// Whether an OPEN episode is trending WORSE right now — a pure VISIBILITY signal over
// the same #801 assembly (no second engine, no medical claim, issue #805): the fever
// curve is rising, OR some symptom's most-recent severity rose vs the prior
// consecutive day. This is only a caregiver-facing "the trend is up" arrow on the
// household chip — it is NOT the cited illness-care care finding (that lives in
// lib/illness-care.ts, dataset-gated per symptom) and asserts nothing clinical.
export function episodeIsWorsening(ep: AssembledEpisode): boolean {
  if (feverTrend(ep.temperatures) === "rising") return true;
  for (const s of ep.symptoms) {
    const pts = s.points;
    if (pts.length < 2) continue;
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    if (
      daysBetweenDateStr(prev.date, last.date) === 1 &&
      last.severity > prev.severity
    )
      return true;
  }
  return false;
}

// The most-recent PRN administration across the episode's meds. Derived from the SAME
// #801 assembly the cockpit's PRN control formats over (one question, one computation,
// #221) — never a second dose query. Consumers use the full point for the at-a-glance
// latest reading and the compact clause below for the household accordion line.
export function episodeLatestDose(
  ep: AssembledEpisode
): LatestEpisodeDose | null {
  let best: LatestEpisodeDose | null = null;
  for (const med of ep.medications) {
    for (const a of med.administrations) {
      // `time24` is the canonical sort clock. Synthetic/legacy points may only carry
      // the display clock, so retain that as a deterministic fallback.
      const clock = a.time24 ?? a.time ?? "";
      const bestClock = best?.time24 ?? best?.time ?? "";
      const better =
        best == null ||
        a.date > best.date ||
        (a.date === best.date && clock > bestClock);
      if (better) {
        best = {
          ...a,
          itemId: med.itemId,
          name: med.name,
          product: a.product ?? med.product,
        };
      }
    }
  }
  return best;
}

export function episodeLastDoseClause(
  ep: AssembledEpisode,
  timeFormat?: TimeFormat
): string | null {
  const best = episodeLatestDose(ep);
  if (!best) return null;
  const name = best.name.toLowerCase();
  const dose = formatMedicationDoseProduct(best.amount, best.product);
  const medication = dose ? `${name} · ${dose}` : name;
  return best.time
    ? `last ${medication} ${formatClockValue(best.time, timeFormat)}`
    : `last ${medication}`;
}

// The cross-profile accordion line: "Mia · sick day 3 · 101.3 °F · worsening ↑ · last
// ibuprofen 4:02pm". `name` is the profile's (disambiguated) name; every clause drops
// out when its data is absent. The temperature renders in the VIEWER's login unit
// preference (#857) via fmtTemp — storage is canonical °F; `tempUnit` defaults to °F for
// callers without a pref. The "worsening ↑" marker is a visibility-only trend arrow
// (episodeIsWorsening) — no medical claim (issue #805). The last-dose clause (#858) is
// the passive co-caregiver double-dose guard: both parents' dashboards show it.
export function householdSickLine(
  name: string,
  ep: AssembledEpisode,
  tempUnit: TemperatureUnit = "F",
  // Optional precomputed compact clause appended last (issue #859 item 2 — the
  // school-return "fever-free 18h/24h" clause). The caller computes it from the ONE
  // school-return gather (schoolReturnCompactClause) so the household line, hero, and
  // episode page never disagree (#221). Null/omitted keeps the line unchanged.
  extraClause: string | null = null,
  timeFormat?: TimeFormat
): string {
  const parts: string[] = [name];
  const day = episodeDayNumber(ep.start, ep.lastActiveDay ?? ep.asOf);
  parts.push(day != null ? `sick day ${day}` : "sick");
  if (ep.latestTemp) {
    parts.push(fmtTemp(ep.latestTemp.degF, tempUnit));
  }
  if (episodeIsWorsening(ep)) {
    parts.push("worsening ↑");
  }
  const lastDose = episodeLastDoseClause(ep, timeFormat);
  if (lastDose) parts.push(lastDose);
  if (extraClause) parts.push(extraClause);
  return parts.join(" · ");
}

// Order the illness-hero cockpits (issue #858): the acting profile's own open episode
// first (it's the full cockpit at hero position), then every other accessible profile's
// open episode by episode start (earliest first — longest-running patient leads), with a
// stable profileId tie-break. Pure so the ordering is unit-tested independent of the DB
// gather that fills each cockpit.
export function orderIllnessCockpits<
  T extends { profileId: number; isActive: boolean; start: string | null },
>(cockpits: readonly T[]): T[] {
  return [...cockpits].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    // A known start outranks a before-log null start; then earliest start first.
    const an = a.start == null;
    const bn = b.start == null;
    if (an !== bn) return an ? 1 : -1;
    if (a.start != null && b.start != null && a.start !== b.start)
      return a.start < b.start ? -1 : 1;
    return a.profileId - b.profileId;
  });
}

// Whether an episode should surface as "currently sick" on cross-profile cards — an
// ONGOING episode (no stop yet) with at least one signal (symptom/temp/med) logged.
export function isOpenEpisode(ep: AssembledEpisode): boolean {
  return (
    ep.ongoing &&
    (ep.distinctSymptomCount > 0 ||
      ep.temperatures.length > 0 ||
      ep.totalAdministrations > 0)
  );
}

// One administration for the Emergency Card's active-episode section (issue #859
// item 6): the med name, its profile-local clock, and the snapshotted amount.
export interface EmergencyEpisodeAdministration {
  name: string;
  time: string | null;
  amount: string | null;
  product?: string | null;
}

// The Emergency Card's conditional active-episode section — the ER intake answer to
// "what have they taken today?". Present only while an episode is OPEN.
export interface EmergencyEpisodeSection {
  situation: string;
  dayNumber: number | null;
  // "Illness · day 4" — the episode headline for a first responder.
  headline: string;
  // TODAY's administrations (the asOf day) with clock + amount, oldest first.
  todaysAdministrations: EmergencyEpisodeAdministration[];
  // The latest temperature, preformatted in the viewer's unit ("101.3 °F"), or null.
  latestTemp: string | null;
}

// Build the Emergency Card active-episode section from the ONE assembly (#221), or
// null when the episode is closed (the card renders nothing then). `tempUnit` renders
// the temperature in the viewer's preference (storage is canonical °F). Pure — the
// server gather passes an assembled OPEN episode; the printable/offline card formats
// over the result unchanged.
export function emergencyEpisodeSection(
  ep: AssembledEpisode,
  tempUnit: TemperatureUnit = "F",
  timeFormat?: TimeFormat
): EmergencyEpisodeSection | null {
  if (!ep.ongoing) return null;
  const dayNumber = episodeDayNumber(ep.start, ep.lastActiveDay ?? ep.asOf);
  const headline =
    dayNumber != null ? `${ep.situation} · day ${dayNumber}` : ep.situation;
  const todaysAdministrations: EmergencyEpisodeAdministration[] = [];
  for (const med of ep.medications) {
    for (const a of med.administrations) {
      if (a.date === ep.asOf) {
        todaysAdministrations.push({
          name: med.name,
          time: a.time ? formatClockValue(a.time, timeFormat) : null,
          amount: a.amount,
          product: a.product ?? med.product,
        });
      }
    }
  }
  todaysAdministrations.sort((a, b) =>
    (a.time ?? "").localeCompare(b.time ?? "")
  );
  return {
    situation: ep.situation,
    dayNumber,
    headline,
    todaysAdministrations,
    latestTemp: ep.latestTemp ? fmtTemp(ep.latestTemp.degF, tempUnit) : null,
  };
}
