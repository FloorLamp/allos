// The PURE single-reading temperature red-flag engine (issue #859 item 3). Given ONE
// assembled illness episode (the #801 assembly, never re-gathered here) and the
// profile's age, it decides whether the episode's LATEST temperature reading crosses a
// cited, age-banded red flag (lib/datasets/temperature-red-flags). NO DB/network —
// unit-tested in lib/__tests__ over hand-built fixtures; the DB gather that feeds it
// lives in lib/temp-red-flag-findings.ts.
//
// The hard non-goals (the #798/#805 refusal posture, held here too):
//   - It states the logged FACT (the reading) + the source's own cited LINE + the
//     SOURCE. It never computes a judgment, never names a condition, never triages a
//     COMBINATION of symptoms — a SINGLE reading crossing a SINGLE cited threshold.
//   - Thresholds/age bands come ONLY from the committed, cited dataset. No entry ⇒ no
//     finding, ever. An unknown age never triggers a source-published age band.
//
// Reach is CARE tier (#449) — the builder wires it to Upcoming, dashboard placement,
// and the Telegram nudge through the shared dismissal bus. This module only DECIDES
// + phrases; it owns no surface.

import type { AssembledEpisode } from "./illness-episode-format";
import type { TemperatureUnit } from "./settings";
import { fmtTemp, fmtTempDual } from "./units";
import {
  detectTempRedFlag,
  type TempRedFlagEntry,
} from "./datasets/temperature-red-flags";

// The dedupeKey namespace for every temperature red-flag finding — registered in
// RULE_FINDING_PREFIXES so the #448 reflection guard can prove the keys are guardable.
export const TEMP_RED_FLAG_PREFIX = "temp-red-flag:";

// One neutral single-reading red-flag finding — the ONE computation every surface
// formats over (the care-tier Finding, the Upcoming item, the Telegram nudge, the
// inline toast). `title` carries the reading; `detail` is the cited line; `source` is
// quoted separately.
export interface TempRedFlagFinding {
  ruleKey: string; // dataset key ("infant_fever" | "hyperpyrexia")
  label: string;
  degF: number;
  date: string; // the reading's day
  dedupeKey: string;
  title: string;
  detail: string; // the cited line alone (no reading, no source)
  source: string;
}

// Episode-anchored dedupeKey (#436): a dismiss follows THIS reading (its day + rule),
// so a fresh crossing reading re-notifies but the same reading doesn't nag. Mirrors
// illnessCareDedupeKey's `<situation>:<start|open>` anchor shape.
export function tempRedFlagDedupeKey(
  situation: string,
  start: string | null,
  date: string,
  ruleKey: string
): string {
  const anchor = `${situation.trim().toLowerCase()}:${start ?? "open"}`;
  return `${TEMP_RED_FLAG_PREFIX}${anchor}:${date}:${ruleKey}`;
}

// How a finding's APP-AUTHORED reading renders (#1019): the viewer's login unit on
// web surfaces (the display-unit policy — web always follows the viewer's pref), or
// "dual" for the Telegram nudge (both scales — a mixed-pref household reads a safety
// message correctly either way). The cited threshold line quoted from the source
// dataset (`entry.line`) is NEVER converted — those are the source's own words; only
// the app-authored reading in the title converts. The dedupeKey is independent of
// display (pinned in lib/__tests__).
export type TempRedFlagDisplay = TemperatureUnit | "dual";

function fmtRedFlagTemp(degF: number, display: TempRedFlagDisplay): string {
  return display === "dual" ? fmtTempDual(degF) : fmtTemp(degF, display);
}

// Phrasing (quote, never generate). The title names WHAT crossed and the reading that
// crossed it; the detail is the source's own instruction and nothing else.
export function tempRedFlagTitle(
  entry: TempRedFlagEntry,
  degF: number,
  display: TempRedFlagDisplay = "F"
): string {
  return `${entry.label} — ${fmtRedFlagTemp(degF, display)}`;
}

// The detail carries NO reading, deliberately: every surface that renders it renders
// the title above it (the care-tier Finding, the Upcoming item, the push body under
// its own title), so restating the temperature here said the same number twice in one
// message. What the reader needs second is the instruction, not the fact again — which
// is why this takes no display unit.
export function tempRedFlagDetail(entry: TempRedFlagEntry): string {
  return `${entry.line}.`;
}

// The self-contained secondary line every non-Finding surface shows. The citation
// TRAILS the instruction (copy.md rule 10 — provenance findable, never leading).
export function tempRedFlagFullDetail(f: TempRedFlagFinding): string {
  return `${f.detail} Source: ${f.source}.`;
}

// The Finding.evidence line.
export function tempRedFlagEvidence(f: TempRedFlagFinding): string {
  return `Source: ${f.source}.`;
}

// The inline note shown at the MOMENT of logging (the temperature toast/card), or
// null when the just-logged reading crosses no red flag. Same source-quoting posture
// as the finding surfaces — the source's own line, then the source. The reading is
// already on the card this note sits under. One helper so the toast and the finding
// never phrase the same crossing differently.
export function inlineTempRedFlagNote(
  degF: number,
  ageMonths: number | null
): string | null {
  const entry = detectTempRedFlag(degF, ageMonths);
  if (!entry) return null;
  return `${entry.line}. Source: ${entry.source}.`;
}

export interface DetectTempRedFlagOptions {
  // Profile age in whole months, or null when unknown. Only the source-published
  // infant band consults it; unknown age never triggers a band (#805 non-goal).
  ageMonths: number | null;
  // How the finding's app-authored reading renders (#1019): the viewer's login
  // unit on web surfaces, "dual" for the Telegram nudge. Defaults to canonical
  // °F. Display only — degF/dedupeKey are unaffected.
  display?: TempRedFlagDisplay;
  // Detection lookup — injectable for tests; defaults to the committed dataset.
  detect?: (degF: number, ageMonths: number | null) => TempRedFlagEntry | null;
}

// The red-flag finding an assembled episode's LATEST reading crosses, or null. Uses
// the latest reading ("at the moment of logging" — the just-logged value governs) so
// a subsided fever doesn't keep nagging. A single reading, a single cited threshold.
export function detectEpisodeTempRedFlag(
  episode: AssembledEpisode,
  opts: DetectTempRedFlagOptions
): TempRedFlagFinding | null {
  const latest = episode.latestTemp;
  if (!latest) return null;
  const detect = opts.detect ?? detectTempRedFlag;
  const entry = detect(latest.degF, opts.ageMonths);
  if (!entry) return null;
  const display = opts.display ?? "F";
  return {
    ruleKey: entry.key,
    label: entry.label,
    degF: latest.degF,
    date: latest.date,
    // Identity is display-independent: the SAME dedupeKey whatever unit the
    // viewer sees, so a dismiss on a °C surface silences the °F/Telegram twins.
    dedupeKey: tempRedFlagDedupeKey(
      episode.situation,
      episode.start,
      latest.date,
      entry.key
    ),
    title: tempRedFlagTitle(entry, latest.degF, display),
    detail: tempRedFlagDetail(entry),
    source: entry.source,
  };
}
