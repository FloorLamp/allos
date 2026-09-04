// Pure shapes + formatters for the illness-episode view (issue #801). NO DB/network
// imports, so these are unit-tested in lib/__tests__ and shared by EVERY surface
// (timeline card, dashboard illness Now group, Household page "sick day" chip, share/print) —
// the one-question-one-computation discipline (#221). The DB gather that fills an
// `AssembledEpisode` lives in lib/illness-episode.ts; this module never touches the DB.
//
// "Day N" is computed off the profile-TZ calendar-day boundaries the caller passes in
// (start day = day 1), matching the symptom-episode derivation's inclusive [start, end]
// semantics (lib/symptom-episode.ts, #2232): `end` IS the last active day; an ongoing
// episode (`end` null) runs through today.

import { daysBetweenDateStr, shiftDateStr, zonedWallTimeToUtc } from "./date";
import {
  formatClockValue,
  formatCompactRelativeTime,
  type TimeFormat,
} from "./format-date";
import type { IntakeItemKind } from "./types/intake";
import type { TemperatureUnit } from "./settings";
import { fmtTemp } from "./units";
import { formatMedicationDoseProduct } from "./medication-dose-format";
import { SUMMARY_NAME_LIMIT, summarizeNames } from "./summarize-names";
import { symptomLabel } from "./symptoms";

// A single severity reading of one symptom on one day.
export interface SymptomSeriesPoint {
  date: string;
  severity: number; // 1–4
  note: string | null;
  // Present for DB-backed rows. Legacy/unlinked facts remain eligible for stable
  // first-episode presentation ownership.
  episodeId?: number | null;
}

// One symptom's severity-over-time series within the episode (oldest day first), as
// the person LOGGED it.
export interface LoggedSymptomSeries {
  source: "logged";
  symptom: string; // stored key (curated slug or custom name)
  label: string; // display label
  points: SymptomSeriesPoint[];
  maxSeverity: number;
}

// One day a derived symptom held, and the measurement that says so.
export interface DerivedSymptomDay {
  date: string;
  // The day's PEAK reading — the fact the row states ("peaked 103.4").
  peakDegF: number;
  // The reading itself, so the row's tap can go to it. Undefined only for a synthetic
  // assembly whose TemperaturePoints carry no row id.
  readingId: number | undefined;
  // The peak reading's profile-local clock, or null when it was stored untimed.
  time: string | null;
}

// A symptom COMPOSED AT READ TIME from measurements, never stored — the owner's
// 2026-09-01 ruling on #4712: derive, never write. A written copy would drift the
// moment a reading is corrected, and mapping degrees onto the 1-4 severity scale
// would fabricate a judgment nobody made.
//
// THE ABSENCE OF `points` AND `maxSeverity` IS THE LOAD-BEARING PART. This arm cannot
// be handed to a severity editor, or counted in a worst-severity sort, or written back
// through `setSymptomSeverityCore`, because it carries nothing any of them read. That
// is the invariant as a TYPE rather than as a guard every surface has to remember.
export interface DerivedSymptomSeries {
  source: "derived";
  symptom: string; // the curated vocabulary key this derives onto
  label: string;
  days: DerivedSymptomDay[]; // oldest day first
}

export type SymptomSeries = LoggedSymptomSeries | DerivedSymptomSeries;

// The union's narrowing. Every consumer that predates the derived arm asks a question
// only a LOGGED series can answer — a severity, a day's note, a run of consecutive
// logged days — so each narrows through this rather than growing an arm that would
// have to invent one.
export const isLoggedSymptomSeries = (
  series: SymptomSeries
): series is LoggedSymptomSeries => series.source === "logged";

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

// THE DERIVED FEVER ROW (#4712 item 4, owner-ruled 2026-09-01). One symptom row
// composed from the episode's own fever-range readings — the SAME `temperatures`
// series the fever-free clock reads (#4685), so this is one computation over one set
// of facts and a correction to a reading moves the row with no reconciliation write.
//
// A day qualifies when it holds at least one reading the reference range flagged
// "high"; `flag` is the derivation's whole input, so the fever thresholds stay owned
// by `reconcileFlags` and are not re-spelled here. The day's PEAK reading is the one
// the row states and the one its tap goes to. Ties keep the EARLIER reading, because
// `temperatures` arrives date-then-time ascending and the first crossing of the day is
// the one a caregiver is looking for.
//
// It derives onto the CURATED `fever` slug rather than minting a parallel key: it is
// the same clinical concept the vocabulary already names, and the `source` discriminant
// is what tells the two apart. On a day carrying BOTH a stated `fever` row and
// fever-range readings, THE DERIVED ROW YIELDS (owner-ruled 2026-09-03, #4712
// judgement 3): the person's own statement wins and only that one row shows. This is
// PER-DAY, not per-episode — `statedFeverDates` is the caller's set of days already
// carrying a stated row, and a day outside it still derives normally. The readings
// themselves are untouched either way; the temperature fold reads `temperatures`
// directly and never consults this suppression.
export const DERIVED_FEVER_SYMPTOM = "fever";

export function deriveFeverSeries(
  temperatures: readonly TemperaturePoint[],
  statedFeverDates: ReadonlySet<string> = new Set()
): DerivedSymptomSeries | null {
  const byDate = new Map<string, DerivedSymptomDay>();
  for (const reading of temperatures) {
    if (reading.flag !== "high") continue;
    if (statedFeverDates.has(reading.date)) continue;
    const held = byDate.get(reading.date);
    if (held && held.peakDegF >= reading.degF) continue;
    byDate.set(reading.date, {
      date: reading.date,
      peakDegF: reading.degF,
      readingId: reading.id,
      time: reading.time,
    });
  }
  if (byDate.size === 0) return null;
  return {
    source: "derived",
    symptom: DERIVED_FEVER_SYMPTOM,
    label: symptomLabel(DERIVED_FEVER_SYMPTOM),
    days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// The episode's WORST derived-fever day — the one the summary's leading row states,
// so the row and the "Peak temp" figure printed a few lines above it come from the
// same readings. Ties keep the EARLIER day, the same rule the per-day peak uses.
export function derivedFeverPeakDay(
  series: DerivedSymptomSeries
): DerivedSymptomDay | null {
  let peak: DerivedSymptomDay | null = null;
  for (const day of series.days) {
    if (!peak || day.peakDegF > peak.peakDegF) peak = day;
  }
  return peak;
}

// The union's other narrowing, for the surfaces that render the READING arm. Callers
// asking for the derived row want the one series that carries days and no severity.
export const isDerivedSymptomSeries = (
  series: SymptomSeries
): series is DerivedSymptomSeries => series.source === "derived";

// One PRN administration (#797) within the episode, with its snapshotted dose.
export interface AdministrationPoint {
  // Present for DB-backed episode assemblies; optional for synthetic summaries/tests.
  id?: number;
  date: string;
  time: string | null; // profile-local clock of the best-known instant, or null
  time24?: string | null; // profile-local HH:MM for the edit control
  // True when `time` came from the recorded_at capture rather than a
  // stated administration instant (`occurred_at`). The timeline is a clinical
  // document, so it marks such a clock "recorded 7:02am" instead of presenting a
  // filing timestamp as an administration time (#2228 decision 4). Optional so
  // synthetic/test points default to an unmarked clock.
  timeRecorded?: boolean;
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
      // Whether `time` is a record-chain clock rather than a stated administration
      // instant — see AdministrationPoint.timeRecorded (#2228 decision 4).
      timeRecorded: boolean;
      label: string;
      detail: string;
      itemId: number;
      // The parent item's clinical kind, carried onto the row so the History's
      // Illness view can drop the routine supplement stack without dropping the
      // medicine given for the illness (#2612). `kind` is already this union's own
      // discriminant, hence the longer name. Absent ⇒ treated as a medication.
      itemKind?: IntakeItemKind;
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
        timeRecorded: a.timeRecorded ?? false,
        label: m.name,
        detail:
          formatMedicationDoseProduct(a.amount, a.product ?? m.product) ||
          "Amount not recorded",
        itemId: m.itemId,
        itemKind: m.kind,
        amount: a.amount,
      }))
    ),
    // LOGGED ROWS ONLY. The ledger's symptom event carries a severity label, which
    // the derived arm has nothing to answer with; the fever it derives from is already
    // in this ledger as its own temperature events.
    ...episode.symptoms.filter(isLoggedSymptomSeries).flatMap((s) =>
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
  // The intake item's CLINICAL identity (#2612). The episode gather is already
  // narrowed to `obligation = 'may'`, so within this set the split reads as "a PRN
  // medication taken during the illness" against "the profile's routine supplement
  // stack, which happens to be filed `may` too" — the distinction the History's
  // Illness view needs, and the "kind-based" half of what #2612's fix direction
  // named. It is NOT the fuller episode-relevance model that issue defers.
  // Optional so a payload assembled before this field existed still types; a
  // missing kind is treated as a medication, i.e. never hidden.
  kind?: IntakeItemKind;
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
  end: string | null; // inclusive last active day (#2232), or null (ongoing)
  ongoing: boolean;
  // The concrete day window the data was gathered over (inclusive both ends). `firstDay`
  // falls back to the earliest data day when `start` is null; `lastActiveDay` is the
  // inclusive `end` for a closed episode, else `asOf` (today) for an ongoing one.
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

// ── The fever chart's dose-lane LEGEND (#2612) ───────────────────────────────
//
// A legend explains MARKS. The caption under the chart used to enumerate every
// administration in the window — "◆ Ibuprofen · 200 mg · 19:03 · Aug 9" once per
// dose, ~28 wrapped entries on a 4-day episode — which is a table wearing a
// legend's clothes: the same rows, with the same name/amount/clock, already render
// as the per-day History table directly beneath it (`illnessTimelineEvents` emits
// one row per administration), so the page paid that height twice and both halves
// grew linearly with doses × illness days.
//
// So the enumeration is DELETED rather than folded — folding a duplicate keeps the
// duplicate — and what remains is what the marks actually need: which medications
// the ◆ lane holds, and how many doses of each. Bounded by DISTINCT medication
// (not by dose), and then by `summarizeNames`'s "and N more" tail on top of that,
// so a week-long illness on a fuller stack costs one wrapped line instead of
// several hundred px. Amount and clock are one glance below, in the table that
// owns them.
export function doseLaneRoster(
  medications: readonly Pick<EpisodeMedication, "name" | "administrations">[],
  limit: number = SUMMARY_NAME_LIMIT
): string {
  const named = medications
    .filter((medication) => medication.administrations.length > 0)
    .map((medication) => ({
      name: medication.name,
      count: medication.administrations.length,
    }))
    // Most-administered first, so the truncated tail drops the least-used items.
    // The assembly already sorts this way; the legend does not depend on it having.
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map((medication) => `${medication.name} ×${medication.count}`);
  return summarizeNames(named, limit);
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
  // The SAME day, without the situation's name — for a host whose own header already
  // says "Illness" one line above (#3238). The full `dayLabel` stays the default and is
  // what a surface showing this status ALONE renders: on /encounters and the dashboard's
  // illness state card the situation is the only thing naming what the day belongs to.
  // Two fields rather than a flag because both are read on the same page at once.
  // NULL when the episode has no derivable day number: the full label is then just the
  // situation's name, and a host that already printed that name has nothing left to say.
  dayOnlyLabel: string | null;
  temperature: {
    id: number | string;
    value: string;
    when: string | null;
    high: boolean;
  } | null;
  lastMeds: {
    id: number | string;
    name: string;
    dose: string | null;
    when: string | null;
  } | null;
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
  if (!instant) return clock;
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
    dayOnlyLabel: day != null ? `Day ${day}` : null,
    temperature: temperature
      ? {
          id:
            temperature.id ??
            `${temperature.date}:${temperature.time ?? "day"}`,
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
          id:
            lastDose.id ??
            `${lastDose.itemId}:${lastDose.date}:${lastDose.time ?? "day"}`,
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
// illness cockpit and Household page — it is NOT the cited illness-care finding (that lives in
// lib/illness-care.ts, dataset-gated per symptom) and asserts nothing clinical.
export function episodeIsWorsening(ep: AssembledEpisode): boolean {
  if (feverTrend(ep.temperatures) === "rising") return true;
  for (const s of ep.symptoms) {
    // The fever half of "worsening" is `feverTrend` above, over the same readings the
    // derived row is composed from — asking this arm again would double-count it.
    if (!isLoggedSymptomSeries(s)) continue;
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
  // The dose is bound to the DRUG, and the clock is what follows the pair (#2615
  // item 4). The clause used to read "last ibuprofen · 200 mg 17:33", which put its
  // two part boundaries in the wrong places twice over: a separator split the drug
  // from its own dose, and then the clock was concatenated onto the dose with no
  // boundary at all. Worse, that separator was the SAME " · " the household line
  // joins its clauses with, so "200 mg" read as a sibling of "sick day 3" — and
  // `formatMedicationDoseProduct` can itself return a " · "-joined string
  // ("160 mg · Chewable tablet"), which a third level of the same separator would
  // have made unreadable. Parentheses close the dose off, and the no-dose clause
  // ("last ibuprofen 4:02 PM") is unchanged.
  const medication = dose ? `${name} (${dose})` : name;
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

// Order the illness cockpits: all acting-profile episodes first, then household
// profiles by numeric id, preserving the owning gather's episode order and key.
// Pure so ordering is tested independently of the DB gather that fills each cockpit.
export function orderIllnessCockpits<
  T extends {
    profileId: number;
    isActive: boolean;
    episodeOrder: number;
    episodeKey: string;
  },
>(cockpits: readonly T[]): T[] {
  return [...cockpits].sort(
    (a, b) =>
      Number(b.isActive) - Number(a.isActive) ||
      a.profileId - b.profileId ||
      a.episodeOrder - b.episodeOrder ||
      a.episodeKey.localeCompare(b.episodeKey)
  );
}

// Overlapping open episode windows can contain the same stored symptom, temperature,
// or administration. Assign each atom to the first already-ordered episode so the
// dashboard never renders or keys one stored fact twice (#3138). Episode state and
// episode-specific conditions remain per episode.
export function assignOrderedEpisodeFacts<
  T extends { profileId: number; episode: AssembledEpisode },
>(ordered: readonly T[]): T[] {
  const symptoms = new Set<string>();
  const temperatures = new Set<string>();
  const administrations = new Set<string>();
  return ordered.map((entry) => {
    const { profileId, episode } = entry;
    const ownedSymptoms = episode.symptoms.flatMap((series) => {
      // Exact-once ownership is keyed on a LOGGED point's (symptom, date); the derived
      // arm has no points to key on, and its readings are de-duplicated by
      // `ownedTemperatures` below, on the reading's own id.
      if (!isLoggedSymptomSeries(series)) return [];
      const points = series.points.filter((point) => {
        if (point.episodeId != null && point.episodeId !== episode.id)
          return false;
        const key = `${profileId}:${series.symptom}:${point.date}`;
        if (symptoms.has(key)) return false;
        symptoms.add(key);
        return true;
      });
      return points.length > 0
        ? [
            {
              ...series,
              points,
              maxSeverity: Math.max(...points.map((p) => p.severity)),
            },
          ]
        : [];
    });
    const ownedTemperatures = episode.temperatures.filter((temperature) => {
      const key = `${profileId}:${temperature.id ?? `${temperature.date}:${temperature.time ?? "day"}`}`;
      if (temperatures.has(key)) return false;
      temperatures.add(key);
      return true;
    });
    const ownedMedications = episode.medications.flatMap((medication) => {
      const owned = medication.administrations.filter((administration) => {
        const key = `${profileId}:${administration.id ?? `${medication.itemId}:${administration.date}:${administration.time ?? "day"}`}`;
        if (administrations.has(key)) return false;
        administrations.add(key);
        return true;
      });
      return owned.length > 0
        ? [{ ...medication, count: owned.length, administrations: owned }]
        : [];
    });
    return {
      ...entry,
      episode: {
        ...episode,
        symptoms: ownedSymptoms,
        distinctSymptomCount: ownedSymptoms.length,
        temperatures: ownedTemperatures,
        maxTempF: ownedTemperatures.reduce<number | null>(
          (max, reading) =>
            max == null || reading.degF > max ? reading.degF : max,
          null
        ),
        latestTemp: ownedTemperatures.at(-1) ?? null,
        medications: ownedMedications,
        totalAdministrations: ownedMedications.reduce(
          (count, medication) => count + medication.administrations.length,
          0
        ),
      },
    };
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

// ── THE RECOVERY-LED COCKPIT HEADER (#4752 item 1) ──────────────────────────
//
// The cockpit's header IS the status, so the three things it says are computed here
// rather than assembled in JSX: a headline about the person, one summary line folding
// last-temp and last-meds into prose, and the fraction the progress ring draws. All
// three read the SAME `EpisodeCollapsedStatus` the collapsed accordion line already
// renders, so an expanded cockpit and its own collapsed line can never disagree.
export interface CockpitRecovery {
  /** Hours cleared of the convention's clock, or null with no measured normal. */
  clearedForHours: number | null;
  thresholdHours: number;
  met: boolean;
  /** The shared compact clause (lib/school-return.ts) — one spelling, every surface. */
  label: string;
}

// THE HEADLINE, AND WHAT IT REFUSES TO SAY. It states only what the fever-free clock
// already establishes; with no clock — no fever this episode, or nothing measured
// since one — it is the person's NAME and nothing else, because every other sentence
// available at that point would be a judgement the data has not made.
export function cockpitRecoveryHeadline(
  name: string,
  recovery: CockpitRecovery | null
): string {
  if (!recovery || recovery.clearedForHours == null) return name;
  if (recovery.met) return `${name} is fever-free`;
  return recovery.clearedForHours * 2 >= recovery.thresholdHours
    ? `${name} is nearly there`
    : `${name} is on the mend`;
}

// ONE LINE, THREE CLAUSES. The stat grid it replaces spread the same three facts
// across a monitor's width under three headings; as prose they read in one pass and
// an absent fact says so in the same breath instead of printing "Not logged" under a
// heading of its own.
//
// IT COMES BACK IN PARTS BECAUSE TWO OF THEM CARRY IDENTITY. The last temperature and
// the last dose are dashboard CANDIDATES in their own right, and a candidate's
// identity attributes have to ride on an element; a single joined string has no
// elements. The line is `cockpitSummaryLine` below, over these same parts, so the
// prose and the marked-up rendering can never drift.
export type CockpitSummaryPart = "recovery" | "temperature" | "medication";

export function cockpitSummaryParts(
  status: EpisodeCollapsedStatus,
  recovery: CockpitRecovery | null
): { key: CockpitSummaryPart; text: string }[] {
  return [
    ...(recovery ? [{ key: "recovery" as const, text: recovery.label }] : []),
    {
      key: "temperature" as const,
      text: status.temperature
        ? `last reading ${status.temperature.value}${
            status.temperature.when ? ` ${status.temperature.when}` : ""
          }`
        : "no temperature logged",
    },
    {
      key: "medication" as const,
      text: status.lastMeds
        ? `last med ${status.lastMeds.name}${
            status.lastMeds.when ? ` ${status.lastMeds.when}` : ""
          }`
        : "no meds logged",
    },
  ];
}

export function cockpitSummaryLine(
  status: EpisodeCollapsedStatus,
  recovery: CockpitRecovery | null
): string {
  return cockpitSummaryParts(status, recovery)
    .map((part) => part.text)
    .join(" · ");
}

// The ring's filled fraction, 0..1. Null where there is no clock to draw: a ring at
// zero and a ring that does not apply look identical, and only one of them is true.
export function cockpitRecoveryFraction(
  recovery: CockpitRecovery | null
): number | null {
  if (!recovery || recovery.clearedForHours == null) return null;
  if (recovery.thresholdHours <= 0) return 1;
  return Math.max(
    0,
    Math.min(1, recovery.clearedForHours / recovery.thresholdHours)
  );
}
