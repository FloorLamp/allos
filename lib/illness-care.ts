// The PURE illness-care findings engine (issue #805). Given ONE assembled illness
// episode (lib/illness-episode.ts — the #801 assembly, never re-gathered here) and
// the profile's age, it decides which cited duration/trajectory care findings the
// episode's symptom series cross. NO DB/network — unit-tested in lib/__tests__ over
// hand-built AssembledEpisode fixtures; the DB gather that feeds it lives in
// lib/illness-care-findings.ts.
//
// What it does — and deliberately does NOT — do (the hard non-goals, #805 /
// docs/internals/findings.md):
//   - It states the logged FACT + the cited LINE + the SOURCE. It never says "you
//     should", never names a condition, never triages a COMBINATION of symptoms
//     ("fever + rash + stiff neck") — combination red-flags are out of scope
//     ENTIRELY, not even informational. Every finding is one symptom crossing one
//     citable duration/trajectory line.
//   - Thresholds come ONLY from the committed, cited dataset (lib/illness-thresholds
//     .json). No dataset entry for a symptom ⇒ no finding for it, EVER.
//   - Age bands are the SOURCE's own (infant fever): below the source's floor the
//     finding renders the "contact a clinician" refusal, not a computed number.
//     An unknown age never triggers the infant band.
//
// Reach is CARE tier (#449) — the builder wires it to Upcoming + the non-hideable
// hero + the Telegram nudge through the shared dismissal bus. This module only
// DECIDES + phrases; it owns no surface.

import { MEDICAL_DISCLAIMER } from "@/lib/disclaimers";
import { daysBetweenDateStr } from "./date";
import type { AssembledEpisode, SymptomSeries } from "./illness-episode-format";
import {
  illnessThresholdFor,
  type IllnessThresholdEntry,
} from "./illness-thresholds";

// The dedupeKey namespace for every illness-care finding — registered in
// RULE_FINDING_PREFIXES so the #448 reflection guard can prove the keys are
// guardable and any surface's prefix-guarded dismiss action can match them.
export const ILLNESS_CARE_PREFIX = "illness-care:";

export type IllnessCareVariant = "duration" | "trajectory" | "infant";

// One neutral illness-care finding — the ONE computation every surface formats over
// (the care-tier Finding, the Upcoming item, the Telegram nudge), so they can never
// disagree (#221). `detail` is the fact + the cited line; `source` is quoted
// separately so each surface appends it + the "not medical advice" tail uniformly.
export interface IllnessCareFinding {
  symptom: string; // stored #799 slug
  label: string; // display label
  variant: IllnessCareVariant;
  runDays: number; // the consecutive-day run behind the finding (fact)
  dedupeKey: string;
  title: string;
  detail: string; // logged fact + the cited line (no source/disclaimer)
  source: string; // the cited label/guideline line
}

// Episode-anchored dedupeKey (#436): a dismiss follows THIS episode of THIS symptom
// in THIS variant, not the topic forever. Mirrors episodeConditionExternalId's
// `<situation>:<start|open>` anchor shape so a re-derived open episode keeps the key
// stable across ticks.
export function illnessCareDedupeKey(
  situation: string,
  start: string | null,
  symptom: string,
  variant: IllnessCareVariant
): string {
  const anchor = `${situation.trim().toLowerCase()}:${start ?? "open"}`;
  return `${ILLNESS_CARE_PREFIX}${variant}:${anchor}:${symptom}`;
}

// The maximal SUFFIX of a symptom's severity points whose consecutive dates are
// exactly one calendar day apart — the current, unbroken logging streak ending at
// the last logged day. A gap (a day the symptom wasn't logged) breaks the streak,
// so "logged N consecutive days" is a real run, not a span with holes. Points come
// oldest-first + one-per-day (the #801 assembly guarantees it).
function trailingConsecutivePoints(
  points: SymptomSeries["points"]
): SymptomSeries["points"] {
  if (points.length === 0) return [];
  const out = [points[points.length - 1]];
  for (let i = points.length - 1; i > 0; i--) {
    if (daysBetweenDateStr(points[i - 1].date, points[i].date) === 1) {
      out.unshift(points[i - 1]);
    } else break;
  }
  return out;
}

// The number of consecutive strictly-INCREASING severity steps ending at the last
// reading (over an already-consecutive-day run). [1,2,3] → 2 (two increases, i.e.
// three worsening days); [1,2,2] and [3,2,1] → 0. The trajectory finding fires when
// this reaches the dataset's `trajectory.days` floor.
export function trailingRisingRun(severities: readonly number[]): number {
  let run = 0;
  for (let i = severities.length - 1; i > 0; i--) {
    if (severities[i] > severities[i - 1]) run++;
    else break;
  }
  return run;
}

// Phrasing (the #798 discipline — quote, never generate). Kept together so every
// variant reads the same way and stays diagnosis-free.
function durationTitle(entry: IllnessThresholdEntry, runDays: number): string {
  return `${entry.label} logged ${runDays} days running`;
}
function durationDetail(entry: IllnessThresholdEntry, runDays: number): string {
  return `${entry.label} has been logged ${runDays} days running — ${entry.duration!.line}.`;
}
function trajectoryTitle(entry: IllnessThresholdEntry): string {
  return `${entry.label} getting worse`;
}
function trajectoryDetail(
  entry: IllnessThresholdEntry,
  risingDays: number
): string {
  return `${entry.label} severity has risen ${risingDays} day${risingDays === 1 ? "" : "s"} in a row — ${entry.trajectory!.line}.`;
}
function infantTitle(entry: IllnessThresholdEntry): string {
  return `${entry.label} logged for an infant`;
}
function infantDetail(entry: IllnessThresholdEntry): string {
  return `${entry.label} has been logged for an infant under ${entry.infantRule!.maxAgeMonths} months — ${entry.infantRule!.line}.`;
}

export interface DetectIllnessCareOptions {
  // Profile age in whole months, or null when unknown. Only the SOURCE-published
  // infant band consults it; unknown age never triggers a band (#805 non-goal).
  ageMonths: number | null;
  // Threshold lookup — injectable for tests; defaults to the committed dataset.
  thresholdFor?: (symptomKey: string) => IllnessThresholdEntry | null;
}

// The illness-care findings an assembled episode crosses. Pure: one pass over the
// episode's per-symptom series, each looked up in the cited dataset. A symptom with
// no dataset entry contributes nothing. Per symptom:
//   - infant band (source-published, age known & at/below the floor): ANY logged day
//     renders the refusal — and SUPERSEDES the adult duration count for that symptom.
//   - duration: logged MORE THAN `duration.days` consecutive days (run > days).
//   - trajectory: worst-severity risen for >= `trajectory.days` consecutive days.
// A symptom may cross both duration AND trajectory (distinct variants/keys).
export function detectIllnessCareFindings(
  episode: AssembledEpisode,
  opts: DetectIllnessCareOptions
): IllnessCareFinding[] {
  const thresholdFor = opts.thresholdFor ?? illnessThresholdFor;
  const out: IllnessCareFinding[] = [];
  for (const series of episode.symptoms) {
    const entry = thresholdFor(series.symptom);
    if (!entry) continue; // no cited line ⇒ no finding, ever

    const run = trailingConsecutivePoints(series.points);
    const runDays = run.length;
    if (runDays === 0) continue;

    // Infant band: the source's stricter age band. Any logged day fires the refusal,
    // and it replaces the adult duration count for this symptom (no "wait N days").
    const inInfantBand =
      entry.infantRule != null &&
      opts.ageMonths != null &&
      opts.ageMonths <= entry.infantRule.maxAgeMonths;
    if (inInfantBand) {
      out.push({
        symptom: series.symptom,
        label: entry.label,
        variant: "infant",
        runDays,
        dedupeKey: illnessCareDedupeKey(
          episode.situation,
          episode.start,
          series.symptom,
          "infant"
        ),
        title: infantTitle(entry),
        detail: infantDetail(entry),
        source: entry.infantRule!.source,
      });
      continue;
    }

    if (entry.duration && runDays > entry.duration.days) {
      out.push({
        symptom: series.symptom,
        label: entry.label,
        variant: "duration",
        runDays,
        dedupeKey: illnessCareDedupeKey(
          episode.situation,
          episode.start,
          series.symptom,
          "duration"
        ),
        title: durationTitle(entry, runDays),
        detail: durationDetail(entry, runDays),
        source: entry.source,
      });
    }

    if (entry.trajectory) {
      const risingRun = trailingRisingRun(run.map((p) => p.severity));
      if (risingRun >= entry.trajectory.days) {
        out.push({
          symptom: series.symptom,
          label: entry.label,
          variant: "trajectory",
          runDays,
          dedupeKey: illnessCareDedupeKey(
            episode.situation,
            episode.start,
            series.symptom,
            "trajectory"
          ),
          title: trajectoryTitle(entry),
          detail: trajectoryDetail(entry, risingRun),
          source: entry.source,
        });
      }
    }
  }
  return out;
}

// The self-contained secondary line every non-Finding surface shows (Upcoming item,
// Telegram nudge): the fact + line, then the source, then the mandatory
// "informational, not medical advice" tail. The Finding envelope keeps the source +
// tail in its own `evidence` slot instead (see the builder).
export function illnessCareFullDetail(f: IllnessCareFinding): string {
  return `${f.detail} Source: ${f.source} ${MEDICAL_DISCLAIMER}`;
}

// The Finding.evidence line: the source + the non-negotiable disclaimer tail.
export function illnessCareEvidence(f: IllnessCareFinding): string {
  return `Source: ${f.source} ${MEDICAL_DISCLAIMER}`;
}

// ---- Nudge episode-dedup planning (pure) -----------------------------------

export interface IllnessCareNudgePlan {
  toSend: string[]; // dedupeKeys to nudge now
  toClear: string[]; // stale markers to drop (no longer actionable)
}

// The "once per finding EPISODE" decision for the Telegram nudge, mirroring
// planPreventiveNudges (lib/preventive-nudge.ts): send a currently-actionable
// finding only when it isn't already marked and isn't bus-suppressed; clear a marker
// whose finding is no longer actionable. A SUPPRESSED (page-dismissed) finding
// FREEZES its episode — held out of BOTH sets — so a dismiss silences the push
// without burning the marker ("dismiss once, silence everywhere", #227/#245).
export function planIllnessCareNudges(
  actionableKeys: Iterable<string>,
  markedKeys: Iterable<string>,
  suppressedKeys: Iterable<string> = []
): IllnessCareNudgePlan {
  const actionable = new Set(actionableKeys);
  const marked = new Set(markedKeys);
  const frozen = new Set(suppressedKeys);
  const toSend = [...actionable].filter(
    (k) => !marked.has(k) && !frozen.has(k)
  );
  const toClear = [...marked]
    .filter((k) => !actionable.has(k) && !frozen.has(k))
    .sort();
  return { toSend: toSend.sort(), toClear };
}
