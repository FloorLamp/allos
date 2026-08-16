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
//   • A study with no `study_date` can't be placed on the timeline and is excluded.
//   • EVERY exclusion is NAMED, not silent (#2970). A total a reader cannot decompose
//     is the defect this module's breakdown exists to remove, so `doseContributions`
//     returns the studies that counted AND the ones that did not, each with its reason.
//   • The tone is INFORMATIONAL, never alarmist: this is a quantified-self signal, not
//     a "you've had too much" verdict — dose is a provider conversation.

import type { ImagingModality } from "./types/medical";
import {
  RADIATION_DOSE_ENTRIES,
  RADIATION_DOSE_META,
  type RadiationDoseEntry,
} from "./datasets/radiation-dose";

// The trailing window for the RECENT-INTENSITY lens — a SECONDARY framing, never the
// headline (#2970). Three years is a recent-imaging horizon, nothing more: it came from
// #703's "~40 mSv over 3 years" phrase, which was an illustration that serial imaging is
// worth tracking, not a recommended window, and no dataset or guideline in this repo
// justifies the number.
//
// It is deliberately NOT the cumulative total, because a trailing window makes a
// cumulative figure GO DOWN — stochastic radiation risk accumulates over a lifetime and
// nothing resets at 36 months, so a study aging past the boundary would drop the headline
// with no event and no explanation. The headline is ALL RECORDS, carrying the honest
// completeness caveat in its LABEL ("since <earliest contributing study>") rather than in
// its arithmetic: Allos only knows what has been imported, which is a labelling problem,
// not a reason to truncate the data.
//
// Calendar-anchored (see windowStartDate), not 365-day.
export const DOSE_WINDOW_YEARS = 3;

// Modalities that use IONIZING radiation (an effective dose worth tracking). MRI and
// ultrasound are non-ionizing (0); 'other' is unclassifiable and never estimated.
// PET / nuclear medicine / fluoroscopy joined in #1034 — they are among the
// HIGHEST-dose modalities, and before they existed on the enum they normalized to
// 'other' and silently contributed 0 to the cumulative total.
const IONIZING_MODALITIES: ReadonlySet<ImagingModality> =
  new Set<ImagingModality>([
    "x-ray",
    "ct",
    "dexa",
    "pet",
    "nuclear-medicine",
    "fluoroscopy",
  ]);

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

// Why a study did NOT contribute to the total. Each one is a fact about the record that
// the surface states plainly (#2970) — never a scolding, and never silence.
//   • no-date       — no study date, so it can't be placed on the timeline. User-fixable.
//   • no-entry      — the refusal gate: an unclassifiable study is never estimated.
//   • non-ionizing  — MRI / ultrasound, a true 0 by physics. Reassuring, not apologetic.
export type DoseExclusionReason = "no-date" | "no-entry" | "non-ionizing";

// One study that DID contribute, with the resolved dose that explains its share. Generic
// over the study row so a caller keeps its own type (an ImagingStudy row carries the id
// and laterality a surface needs to label the row) without this module importing it.
export interface DoseContribution<S extends DoseStudyInput = DoseStudyInput> {
  study: S;
  date: string; // never null — an undated study is an exclusion, not a contribution
  dose: StudyDose;
  inWindow: boolean; // also inside the trailing-window lens
}

// One study that did NOT contribute, and why.
export interface DoseExclusion<S extends DoseStudyInput = DoseStudyInput> {
  study: S;
  date: string | null;
  reason: DoseExclusionReason;
}

// A study counts toward a total when it resolved to a recorded dose (a fact from the
// report, even a recorded 0) or to a NON-ZERO typical estimate. Everything else is an
// exclusion with a named reason. The ONE predicate — the fold and the breakdown share it,
// so a total and its rows cannot disagree about what is in it.
function classifyStudy<S extends DoseStudyInput>(
  study: S
): { dose: StudyDose; counts: true } | { reason: DoseExclusionReason } {
  const dose = estimateStudyDose(study);
  if (dose.source === "recorded" || (dose.source === "estimate" && dose.msv > 0))
    return { dose, counts: true };
  // A zero-dose ESTIMATE means the dataset placed it: that is the non-ionizing case.
  // Anything else (the 'other' refusal, or a hypothetical 0-valued ionizing entry) is
  // reported as not estimated rather than claimed to carry no radiation.
  if (dose.source === "estimate" && !IONIZING_MODALITIES.has(study.modality))
    return { reason: "non-ionizing" };
  return { reason: "no-entry" };
}

// The cumulative dose over a scope. Recorded and estimated sums are kept SEPARATE (see
// the header). Studies with no date are always excluded; a `windowYears` of null means
// ALL RECORDS (the headline framing), and a number means the trailing lens.
export interface CumulativeDose {
  windowYears: number | null; // null = all records, no trailing window
  since: string | null; // window start (inclusive); null when all records
  // The oldest CONTRIBUTING study's date — what the headline's completeness caveat
  // names ("since Apr 2021"). Null when nothing contributed.
  earliest: string | null;
  recordedMsv: number;
  recordedCount: number;
  estimatedMsv: number;
  estimatedCount: number; // studies contributing a NON-ZERO estimate
  studiesInWindow: number; // dated studies in scope, contributing or not
  hasAnyDose: boolean; // any recorded or non-zero estimated dose in scope
}

export function cumulativeDose(
  studies: DoseStudyInput[],
  now: string,
  windowYears: number | null = DOSE_WINDOW_YEARS
): CumulativeDose {
  const since = windowYears == null ? null : windowStartDate(now, windowYears);
  let recordedMsv = 0;
  let recordedCount = 0;
  let estimatedMsv = 0;
  let estimatedCount = 0;
  let studiesInWindow = 0;
  let earliest: string | null = null;

  for (const s of studies) {
    if (!s.study_date) continue;
    if (since != null && s.study_date < since) continue;
    studiesInWindow++;
    const verdict = classifyStudy(s);
    if (!("counts" in verdict)) continue;
    if (verdict.dose.source === "recorded") {
      recordedMsv += verdict.dose.msv;
      recordedCount++;
    } else {
      estimatedMsv += verdict.dose.msv;
      estimatedCount++;
    }
    if (earliest == null || s.study_date < earliest) earliest = s.study_date;
  }

  return {
    windowYears,
    since,
    earliest,
    recordedMsv: round(recordedMsv),
    recordedCount,
    estimatedMsv: round(estimatedMsv),
    estimatedCount,
    studiesInWindow,
    hasAnyDose: recordedCount > 0 || estimatedCount > 0,
  };
}

// The whole answer to "where does this number come from" (#2970): the all-records
// headline, the trailing-window lens beside it, the studies that made up the headline,
// and the studies that did NOT with the reason each was left out. ONE pure computation
// (#221) — the card, the study list and any later surface format this rather than
// re-deriving a total or a per-study figure of their own.
//
// Rows are newest first; undated exclusions sort last, since they have no place on the
// timeline at all. This function does no de-duplication: overlapping portal exports are
// collapsed upstream by the representative-id read (#2919/#2952), and a second
// de-duplication here would be a parallel concept for a question that already has one.
export interface DoseBreakdown<S extends DoseStudyInput = DoseStudyInput> {
  allRecords: CumulativeDose;
  window: CumulativeDose;
  contributions: DoseContribution<S>[];
  exclusions: DoseExclusion<S>[];
}

export function doseContributions<S extends DoseStudyInput>(
  studies: S[],
  now: string,
  windowYears: number | null = DOSE_WINDOW_YEARS
): DoseBreakdown<S> {
  const windowSince =
    windowYears == null ? null : windowStartDate(now, windowYears);
  const contributions: DoseContribution<S>[] = [];
  const exclusions: DoseExclusion<S>[] = [];

  for (const study of studies) {
    const date = study.study_date;
    if (!date) {
      exclusions.push({ study, date: null, reason: "no-date" });
      continue;
    }
    const verdict = classifyStudy(study);
    if ("counts" in verdict) {
      contributions.push({
        study,
        date,
        dose: verdict.dose,
        inWindow: windowSince == null || date >= windowSince,
      });
    } else {
      exclusions.push({ study, date, reason: verdict.reason });
    }
  }

  contributions.sort((a, b) => b.date.localeCompare(a.date));
  exclusions.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  return {
    allRecords: cumulativeDose(studies, now, null),
    window: cumulativeDose(studies, now, windowYears),
    contributions,
    exclusions,
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

// The same comparator as a readable span. Months stop being readable once a lifetime
// total is in play — "roughly 148 months of natural background" is arithmetic, not a
// comparison — so past two years it reads in years to one decimal. Null when there's
// nothing to compare. Pure.
export function backgroundEquivalentLabel(cum: CumulativeDose): string | null {
  const months = backgroundEquivalentMonths(cum);
  if (months == null || months <= 0) return null;
  if (months < 24) return `${months} ${months === 1 ? "month" : "months"}`;
  const years = Math.round((months / 12) * 10) / 10;
  return `${years} ${years === 1 ? "year" : "years"}`;
}

// The dose chip for ONE study, as the study list and the breakdown rows both show it —
// or null when there is nothing honest to print. A recorded dose is a bare figure (a
// fact from the report); an estimate is marked as one, at the figure, every time. Named
// here so the two surfaces cannot label the same study differently. Pure.
export function doseChipLabel(dose: StudyDose): string | null {
  if (dose.source === "recorded") return formatMsv(dose.msv);
  if (dose.source === "estimate" && dose.msv > 0)
    return `≈ ${formatMsv(dose.msv)} est.`;
  return null;
}

// Where one contributing study's figure came from — the report, or the named dataset
// entry behind the estimate. This is the per-study half of the recorded-vs-estimate
// split (#703): the aggregate already says "includes estimates", and the breakdown says
// WHICH. Pure.
export function doseSourceNote(dose: StudyDose): string {
  if (dose.source === "recorded") return "Recorded in the report";
  // The dataset label stays verbatim — it is coded record vocabulary ("CT chest",
  // "PET/CT (FDG, whole body)"), and lower-casing it would mangle the acronyms.
  if (dose.label) return `Typical for ${dose.label}`;
  return "Estimated";
}

// Why a study did not count, said plainly. Each is a fact about the record, in the same
// informational register as the rest of the card — an exclusion line reports what the
// record contains, it never scolds the reader for it. Pure so the copy can't drift
// across surfaces.
export function doseExclusionNote(reason: DoseExclusionReason): string {
  switch (reason) {
    case "no-date":
      return "No date recorded, so it isn't counted. Add a date to include it.";
    case "no-entry":
      return "Type unclear, so it isn't estimated.";
    case "non-ionizing":
      return "No ionizing radiation.";
  }
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
      "was needed — a conversation for this child's care team."
    );
  }
  return (
    "A running estimate for context, not a limit. Whether imaging is worthwhile is a " +
    "conversation to have with your provider, who weighs it against why the study was " +
    "needed."
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
