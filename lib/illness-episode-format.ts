// Pure shapes + formatters for the illness-episode view (issue #801). NO DB/network
// imports, so these are unit-tested in lib/__tests__ and shared by EVERY surface
// (timeline card, dashboard header, "Sick in the household" chip, share/print page) —
// the one-question-one-computation discipline (#221). The DB gather that fills an
// `AssembledEpisode` lives in lib/illness-episode.ts; this module never touches the DB.
//
// "Day N" is computed off the profile-TZ calendar-day boundaries the caller passes in
// (start day = day 1), matching the symptom-episode derivation's [start, end) semantics
// (lib/symptom-episode.ts): `end` is EXCLUSIVE (the first inactive day), so the last
// active day is `end` minus one; an ongoing episode (`end` null) runs through today.

import { daysBetweenDateStr } from "./date";
import type { TemperatureUnit } from "./settings";
import { fmtTemp } from "./units";

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
  date: string;
  time: string | null;
  degF: number;
  flag: string | null; // reference-range flag ("high" for a fever), or null
}

// One PRN administration (#797) within the episode, with its snapshotted amount.
export interface AdministrationPoint {
  date: string;
  time: string | null; // profile-local clock of given_at, or null
  amount: string | null; // snapshot at confirm time ("200 mg")
}

// A medication administered during the episode, with its per-administration ledger.
export interface EpisodeMedication {
  itemId: number;
  name: string;
  count: number;
  administrations: AdministrationPoint[];
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

// Deterministic external_id stamped on a condition promoted FROM an episode, so a
// re-promote is an idempotent no-op and the "promoted" state / undo are detectable
// without a side table (the row-op side-state discipline #202). Pure so both the DB
// gather and the write core key on the identical string.
export function episodeConditionExternalId(
  situation: string,
  start: string | null
): string {
  return `episode:${situation.trim().toLowerCase()}:${start ?? "open"}`;
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

// The most-recent PRN administration across the episode's meds, as a "last ibuprofen
// 4:02pm" clause — the co-caregiver coordination signal on the household accordion line
// (issue #858). Derived from the SAME #801 assembly the cockpit's PRN control formats
// over (one question, one computation, #221) — never a second dose query. The clock
// comes straight from the administration point; when it's unknown the clause degrades
// to "last ibuprofen". Null when nothing was administered this episode.
export function episodeLastDoseClause(ep: AssembledEpisode): string | null {
  let best: { name: string; date: string; time: string | null } | null = null;
  for (const med of ep.medications) {
    for (const a of med.administrations) {
      // Order by (date, time); a timed reading outranks an untimed one on the same day.
      const better =
        best == null ||
        a.date > best.date ||
        (a.date === best.date && (a.time ?? "") > (best.time ?? ""));
      if (better) best = { name: med.name, date: a.date, time: a.time };
    }
  }
  if (!best) return null;
  const name = best.name.toLowerCase();
  return best.time ? `last ${name} ${best.time}` : `last ${name}`;
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
  tempUnit: TemperatureUnit = "F"
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
  const lastDose = episodeLastDoseClause(ep);
  if (lastDose) parts.push(lastDose);
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
