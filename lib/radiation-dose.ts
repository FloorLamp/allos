// Cumulative radiation-dose tracking for imaging studies (issue #703). The ONE pure
// computation (#221) the Imaging section renders and any other surface would reuse: it
// estimates a study's effective dose (RECORDED when the report printed one, else a
// curated typical-by-exam ESTIMATE) and sums a calm, trailing-window CUMULATIVE total.
//
// No DB, no network — every function takes the study rows it needs as arguments, so it
// unit-tests directly (lib/__tests__/radiation-dose.test.ts) and the page/component
// are thin formatters over its result.
//
// DESIGN DECISIONS, stated on purpose:
//   • RECORDED vs ESTIMATE stay SEPARATE (never one summed figure). A recorded dose is
//     a fact from the report; an estimate is a population-typical fallback that varies
//     widely with scanner/protocol/body. Mixing them into a single "total" launders the
//     estimate's uncertainty into the recorded fact, so the model keeps two sums and
//     the UI labels a combined figure as an estimate whenever ANY estimate is present.
//   • Non-ionizing modalities (MRI, ultrasound) carry a dose of 0 by physics — they
//     resolve to a 0-mSv entry and never count as "an estimated dose".
//   • An unclassified 'other' study has NO dataset entry (the refusal gate) and is
//     never estimated — a fabricated number would be worse than an honest gap.
//   • A study with no `study_date` can't be placed in the window and is excluded.
//   • The tone is INFORMATIONAL, never alarmist: this is a quantified-self signal, not
//     a "you've had too much" verdict — dose is a provider conversation.

import type { ImagingModality } from "./types/medical";
import {
  RADIATION_DOSE_ENTRIES,
  RADIATION_DOSE_META,
  type RadiationDoseEntry,
} from "./datasets/radiation-dose";

// The trailing window for the cumulative total. A documented constant: three years is
// a common quantified-self horizon for serial imaging and matches the issue's "~40 mSv
// over 3 years" framing. Calendar-anchored (see windowStartDate), not 365-day.
export const DOSE_WINDOW_YEARS = 3;

// Modalities that use IONIZING radiation (an effective dose worth tracking). MRI and
// ultrasound are non-ionizing (0); 'other' is unclassifiable and never estimated.
const IONIZING_MODALITIES: ReadonlySet<ImagingModality> =
  new Set<ImagingModality>(["x-ray", "ct", "dexa"]);

export type DoseSource = "recorded" | "estimate" | "none";

// One study's resolved dose. `msv` is the effective dose in millisieverts (0 for a
// non-ionizing study or when unresolved). `source` is how we got it. `entryKey`/`label`
// name the dataset entry an estimate came from (null for a recorded dose or when none).
export interface StudyDose {
  msv: number;
  source: DoseSource;
  entryKey: string | null;
  label: string | null;
}

// The minimal study shape the estimator reads (structural — a full ImagingStudy row
// satisfies it, and so does a test fixture).
export interface DoseStudyInput {
  modality: ImagingModality;
  body_region: string | null;
  dose_msv: number | null;
  study_date: string | null;
}

function normRegion(s: string | null): string {
  return (s ?? "").toLowerCase();
}

// Resolve a study to its typical-dose dataset entry by modality + body region. Among
// the modality's entries, a region-specific entry whose LONGEST matching token appears
// in the study's body_region wins (most specific); otherwise the modality's generic
// (empty-regions) fallback; otherwise null (no coverage — e.g. 'other'). Pure.
export function resolveDoseEntry(
  modality: ImagingModality,
  bodyRegion: string | null
): RadiationDoseEntry | null {
  const region = normRegion(bodyRegion);
  const forModality = RADIATION_DOSE_ENTRIES.filter(
    (e) => e.modality === modality
  );
  if (forModality.length === 0) return null;

  let best: RadiationDoseEntry | null = null;
  let bestTokenLen = -1;
  let generic: RadiationDoseEntry | null = null;
  for (const e of forModality) {
    if (e.regions.length === 0) {
      generic = e;
      continue;
    }
    if (!region) continue;
    for (const tok of e.regions) {
      if (tok && region.includes(tok) && tok.length > bestTokenLen) {
        best = e;
        bestTokenLen = tok.length;
      }
    }
  }
  return best ?? generic;
}

// A finite, non-negative recorded dose, else null. Guards a stray negative / NaN /
// non-finite value in the column so it can't corrupt the total.
function cleanRecorded(v: number | null): number | null {
  if (v == null || !Number.isFinite(v) || v < 0) return null;
  return v;
}

// Resolve ONE study's dose. A recorded dose always wins; otherwise the curated typical
// estimate; otherwise none. Pure.
export function estimateStudyDose(study: DoseStudyInput): StudyDose {
  const recorded = cleanRecorded(study.dose_msv);
  if (recorded != null) {
    return { msv: recorded, source: "recorded", entryKey: null, label: null };
  }
  const entry = resolveDoseEntry(study.modality, study.body_region);
  if (!entry) {
    return { msv: 0, source: "none", entryKey: null, label: null };
  }
  return {
    msv: entry.msv,
    source: "estimate",
    entryKey: entry.key,
    label: entry.label,
  };
}

// The window start for a trailing N-year cumulative, calendar-anchored: `now`'s
// month/day, N years earlier. A study dated exactly on this day is INCLUDED (>=).
// Feb-29 anchors clamp to Feb-28 in a non-leap target year. Pure; `now` is an ISO
// YYYY-MM-DD string in the profile's timezone.
export function windowStartDate(now: string, years: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(now);
  if (!m) return now;
  const y = Number(m[1]) - years;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Clamp the day to the target month's length (handles Feb-29 → Feb-28).
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const day = Math.min(d, daysInMonth);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${pad(mo)}-${pad(day)}`;
}

// The trailing-window cumulative dose. Recorded and estimated sums are kept SEPARATE
// (see the header). Studies with no date, or dated before the window start, are
// excluded. Pure — the page passes the profile's studies + its "today".
export interface CumulativeDose {
  windowYears: number;
  since: string; // window start (inclusive)
  recordedMsv: number;
  recordedCount: number;
  estimatedMsv: number;
  estimatedCount: number; // studies contributing a NON-ZERO estimate
  studiesInWindow: number;
  hasAnyDose: boolean; // any recorded or non-zero estimated dose in the window
}

export function cumulativeDose(
  studies: DoseStudyInput[],
  now: string,
  windowYears: number = DOSE_WINDOW_YEARS
): CumulativeDose {
  const since = windowStartDate(now, windowYears);
  let recordedMsv = 0;
  let recordedCount = 0;
  let estimatedMsv = 0;
  let estimatedCount = 0;
  let studiesInWindow = 0;

  for (const s of studies) {
    if (!s.study_date || s.study_date < since) continue;
    studiesInWindow++;
    const dose = estimateStudyDose(s);
    if (dose.source === "recorded") {
      recordedMsv += dose.msv;
      recordedCount++;
    } else if (dose.source === "estimate" && dose.msv > 0) {
      estimatedMsv += dose.msv;
      estimatedCount++;
    }
  }

  return {
    windowYears,
    since,
    recordedMsv: round(recordedMsv),
    recordedCount,
    estimatedMsv: round(estimatedMsv),
    estimatedCount,
    studiesInWindow,
    hasAnyDose: recordedCount > 0 || estimatedCount > 0,
  };
}

// The combined figure — recorded + estimated — used ONLY when labeled as an estimate
// (the UI shows it as "≈" whenever estimatedCount > 0). Kept as a derived helper so no
// surface sums the two by hand.
export function combinedMsv(cum: CumulativeDose): number {
  return round(cum.recordedMsv + cum.estimatedMsv);
}

// Whether the combined figure must read as an estimate (any estimated component).
export function isCombinedEstimated(cum: CumulativeDose): boolean {
  return cum.estimatedCount > 0;
}

// The combined dose expressed as an equivalent span of natural background radiation
// (US average ~3 mSv/yr), rounded to whole months — a calm, relatable comparator, NEVER
// a threshold. Returns null when there's no dose to compare. Pure.
export function backgroundEquivalentMonths(cum: CumulativeDose): number | null {
  const total = combinedMsv(cum);
  if (total <= 0) return null;
  const perMonth = RADIATION_DOSE_META.naturalBackgroundMsvPerYear / 12;
  if (perMonth <= 0) return null;
  return Math.round(total / perMonth);
}

// Format an mSv figure for display: small doses keep more precision (a 0.1 mSv chest
// X-ray shouldn't round to 0), larger ones round to one decimal. Pure.
export function formatMsv(msv: number): string {
  if (msv <= 0) return "0 mSv";
  if (msv < 0.1)
    return `${msv.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} mSv`;
  if (msv < 1)
    return `${msv.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} mSv`;
  return `${msv.toFixed(1).replace(/\.0$/, "")} mSv`;
}

// The INFORMATIONAL framing line under the cumulative total. Deliberately calm and
// non-alarmist (no "too much", no threshold). For a CHILD profile it mirrors the tone
// the app already applies to age-gated / pediatric surfaces (#150, #489): radiation
// matters more in childhood, so the note names that and points to the child's care
// team — without ever implying a specific study was wrong. Pure so the copy can't
// drift across surfaces.
export function doseFramingNote(pediatric: boolean): string {
  if (pediatric) {
    return (
      "A running estimate for context, not a limit. Children are more sensitive to " +
      "radiation than adults, and imaging decisions weigh that against why the study " +
      "was needed — a conversation for this child's care team. Informational, not " +
      "medical advice."
    );
  }
  return (
    "A running estimate for context, not a limit. Whether imaging is worthwhile is a " +
    "conversation to have with your provider, who weighs it against why the study was " +
    "needed. Informational, not medical advice."
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
