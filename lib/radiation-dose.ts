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

// The modalities that are NON-ionizing by physics — the only ones about which the card
// may say "No ionizing radiation."
//
// This list was an IONIZING list until #2970's review: every ionizing modality carries a
// non-zero typical dose, so that set was never consulted for one, and its only real job
// was what it did NOT contain. That fails in the dangerous direction — a modality with a
// 0-valued entry that nobody remembered to add would have been reported as carrying no
// radiation. Inverted, an unlisted modality reads as NOT ESTIMATED (an honest gap)
// instead, and adding a modality to the enum can no longer make the card lie.
export const NON_IONIZING_MODALITIES: ReadonlySet<ImagingModality> =
  new Set<ImagingModality>(["mri", "ultrasound"]);

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
}

// One study that did NOT contribute, and why.
export interface DoseExclusion<S extends DoseStudyInput = DoseStudyInput> {
  study: S;
  date: string | null;
  reason: DoseExclusionReason;
}

// A study counts toward a total when it resolved to a recorded dose or to a NON-ZERO
// typical estimate. Everything else is an exclusion with a named reason. The ONE
// predicate — the fold and the breakdown share it, so a total and its rows cannot
// disagree about what is in it.
//
// A RECORDED 0 COUNTS, and a NULL dose on the same study does not. That fork is
// deliberate: a recorded 0 is a measurement the report printed, so it is attributable
// and the card names it as a contributing study at 0 mSv; a NULL dose is the absence of
// a measurement, and what the card can say then is about the modality ("No ionizing
// radiation") rather than about the study. So an ultrasound with a recorded 0 gives a
// "0 mSv" headline, and the same ultrasound with no recorded dose gives none — both
// records render the card, and both name the study (#2970).
function classifyStudy<S extends DoseStudyInput>(
  study: S
): { dose: StudyDose; counts: true } | { reason: DoseExclusionReason } {
  const dose = estimateStudyDose(study);
  if (
    dose.source === "recorded" ||
    (dose.source === "estimate" && dose.msv > 0)
  )
    return { dose, counts: true };
  // "No ionizing radiation" is a claim about PHYSICS, so it comes from the modality
  // being named non-ionizing — never from a 0 the dataset happened to carry. Everything
  // else (the 'other' refusal, a 0-valued entry on any other modality) is reported as
  // not estimated: an honest gap, never false reassurance.
  if (NON_IONIZING_MODALITIES.has(study.modality))
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
  // names ("since Apr 2021"). Null when nothing contributed, and null when the oldest
  // contributing study is in the FUTURE: a record that starts next year has no "since"
  // (#2970), and "From your records, since January 1, 2099." is not a sentence.
  earliest: string | null;
  // Every mSv figure below is the exact sum of the figures its ROWS print, and this is
  // the number of decimals they were rounded at — so a surface prints these totals with
  // formatScopeMsv and the reader's addition comes out (#2970 R5). 0 when nothing
  // contributed.
  decimals: number;
  recordedMsv: number;
  recordedCount: number;
  estimatedMsv: number;
  estimatedCount: number; // studies contributing a NON-ZERO estimate
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
  let earliest: string | null = null;
  let decimals = 0;

  for (const s of studies) {
    if (!s.study_date) continue;
    if (since != null && s.study_date < since) continue;
    const verdict = classifyStudy(s);
    if (!("counts" in verdict)) continue;
    // ROUND ONCE, AT THE ROW. The fold adds the figure the row PRINTS, never the raw
    // one, so the total is the sum of what the reader can see (#2970 R5).
    const shown = displayMsv(verdict.dose.msv);
    decimals = Math.max(decimals, msvDecimals(verdict.dose.msv));
    if (verdict.dose.source === "recorded") {
      recordedMsv += shown;
      recordedCount++;
    } else {
      estimatedMsv += shown;
      estimatedCount++;
    }
    if (earliest == null || s.study_date < earliest) earliest = s.study_date;
  }

  return {
    windowYears,
    since,
    earliest: earliest != null && earliest > now ? null : earliest,
    decimals,
    // Both sums are exact at `decimals` by construction; this only trims float noise.
    recordedMsv: roundTo(recordedMsv, decimals),
    recordedCount,
    estimatedMsv: roundTo(estimatedMsv, decimals),
    estimatedCount,
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
// timeline at all. This function does no de-duplication, and a repeated study is summed
// AS GIVEN. The representative-id read (#2919/#2952) collapses overlapping portal
// exports only when they agree on a study id or carry none — it partitions on
// `external_id` WHEN PRESENT — so three exports that each mint their own accession still
// arrive here as three studies and still triple the headline. That is the collapse's
// question, not this module's: a second de-duplication here would be a parallel concept
// for a question that already has an owner, and the breakdown is what lets a reader SEE
// the repeat instead of only its sum.
export interface DoseBreakdown<S extends DoseStudyInput = DoseStudyInput> {
  allRecords: CumulativeDose;
  window: CumulativeDose;
  contributions: DoseContribution<S>[];
  exclusions: DoseExclusion<S>[];
}

// Whether the card has anything to say about this record: a contribution to explain or
// an exclusion to name. NOT `hasAnyDose` (#2970 R1) — a profile whose imaging is entirely
// undated, unclassified or non-ionizing has named exclusions and no total, and gating the
// card on the total deleted the one surface that could explain them while the study list
// still showed the undated X-ray's estimate chip. Named, not silent, applies hardest to
// the record where nothing counted.
export function describesAnyStudy<S extends DoseStudyInput>(
  breakdown: DoseBreakdown<S>
): boolean {
  return breakdown.contributions.length > 0 || breakdown.exclusions.length > 0;
}

export function doseContributions<S extends DoseStudyInput>(
  studies: S[],
  now: string,
  windowYears: number | null = DOSE_WINDOW_YEARS
): DoseBreakdown<S> {
  const contributions: DoseContribution<S>[] = [];
  const exclusions: DoseExclusion<S>[] = [];

  for (const study of studies) {
    const verdict = classifyStudy(study);
    const date = study.study_date;
    if (!date) {
      // R2 (#2970): "Add a date to include it" is only true for a study a date would
      // actually let count. An undated ultrasound is non-ionizing whatever its date,
      // and an undated 'other' is still unclassifiable — so an undated study reports
      // the reason it would STILL not count, and only the rest read as no-date.
      exclusions.push({
        study,
        date: null,
        reason: "counts" in verdict ? "no-date" : verdict.reason,
      });
      continue;
    }
    if ("counts" in verdict) {
      contributions.push({ study, date, dose: verdict.dose });
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
  return roundTo(cum.recordedMsv + cum.estimatedMsv, cum.decimals);
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

// Where the comparator stops counting months and starts counting years. Months stop
// being readable once a lifetime total is in play — "roughly 148 months of natural
// background" is arithmetic, not a comparison. Two years is the judgement call; it is a
// named constant so it is pinned by tests at 23 and 24 months rather than by nothing.
export const BACKGROUND_YEARS_CUTOVER_MONTHS = 24;

// The same comparator as a readable span: months below the cutover, years to one decimal
// from it on. Null when there's nothing to compare. Pure.
//
// The years figure is derived from the DOSE, not from the rounded month count: rounding
// to whole months and dividing again drifted up to 0.092 y (~34 days) on a one-decimal
// figure — 48.625 mSv read "16.3 years" against a true 16.208. Above the cutover the span
// is always ≥ 2 years, so there is no singular case to spell.
export function backgroundEquivalentLabel(cum: CumulativeDose): string | null {
  const months = backgroundEquivalentMonths(cum);
  if (months == null || months <= 0) return null;
  if (months < BACKGROUND_YEARS_CUTOVER_MONTHS)
    return `${months} ${months === 1 ? "month" : "months"}`;
  const perYear = RADIATION_DOSE_META.naturalBackgroundMsvPerYear;
  const years = Math.round((combinedMsv(cum) / perYear) * 10) / 10;
  return `${years} years`;
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

// How many decimals ONE figure prints at: three significant figures, so a 0.1 mSv chest
// X-ray never rounds to 0 and a 1.44 mSv recorded dose is not flattened to 1.4.
function msvDecimals(msv: number): number {
  if (msv <= 0) return 0;
  return Math.min(20, Math.max(0, 2 - Math.floor(Math.log10(msv))));
}

// The VALUE a row prints — one dose rounded to its display precision. This is the whole
// of the rounding: every total is a sum of these, so a figure is rounded exactly once,
// where the reader can see it (#2970 R5).
export function displayMsv(msv: number): number {
  if (msv <= 0) return 0;
  return Number(msv.toFixed(msvDecimals(msv)));
}

function trimZeros(fixed: string): string {
  return fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
}

// Format ONE study's mSv figure — the chip on a list row and on a breakdown row, which
// is why both surfaces print the same study identically. Pure.
export function formatMsv(msv: number): string {
  if (msv <= 0) return "0 mSv";
  return `${trimZeros(msv.toFixed(msvDecimals(msv)))} mSv`;
}

// Format a SCOPE's figure — the headline, the recorded/estimated split, the 3-year lens.
// Printed at the precision its rows were rounded at, and never re-rounded, because the
// scope's total already IS the sum of those rows (#2970 R5).
//
// The card puts the decomposition beside the total, and rounding the rows independently
// of the sum broke the addition in ordinary cases: two recorded 10.05 mSv CTs printed
// rows of 10.1 under a headline of 20.1, and an estimate-only record of ten 10 mSv CTs
// plus a 0.1 mSv chest X-ray printed rows summing to 100.1 under a headline of 100. A
// re-rounded total is not an explanation of its parts, so the fold adds the printed
// figures and this prints their sum — additive by construction, at every scope.
//
// THE TRADE, RATIFIED ON PURPOSE — read this before "fixing" the total to the true sum.
// Adding the ROUNDED rows means the printed total is not the sum of the TRUE doses. The
// display carries three significant figures, which quantises at half a decade-quantum,
// so the worst case is 0.5% (0.4965%, measured): nineteen studies recorded at 1.00499
// mSv print a 19 mSv total against a true sum of 19.0948. That gap is two orders of
// magnitude inside the uncertainty this figure already declares — the dataset calls its
// values "order of magnitude, never a measurement of an individual scan", the card
// labels any combined figure "≈ … includes estimates", and no report prints a dose to a
// precision the gap could reach. An accuracy no reader can check was traded for an
// addition every reader can, deliberately and with the numbers on the table. Restoring a
// true-sum total re-opens #2970 R5 — rows that do not add up to the headline printed
// beside them, which is the defect this whole change exists to remove.
export function formatScopeMsv(cum: CumulativeDose, msv: number): string {
  if (msv <= 0) return "0 mSv";
  return `${trimZeros(msv.toFixed(Math.min(20, cum.decimals)))} mSv`;
}

// THE SPLIT ONLY EARNS ITS LINES WHEN IT SPLITS SOMETHING (#3498 item 2).
//
// The card states an all-records headline, then a Recorded/Estimated split, then a
// trailing-3-year lens. With ONE estimated study every one of those is the same
// number: "≈ 0.4 mSv", "Estimated: 0.4 mSv (1 study)", "Last 3 years: ≈ 0.4 mSv" —
// a stat block asserting more structure than its n supports (the #3482 class). The
// reader is asked to compare three figures that cannot differ.
//
// So the DECISION lives here, beside the arithmetic it is about, rather than as a
// conditional in the card: does the split, or the lens, print a figure the headline
// has not already printed? It is stated over the PRINTED strings because "states
// the figure twice" is a claim about what a reader sees, and formatScopeMsv is
// where a figure becomes visible.
//
// It generalises past n=1 on purpose: a record of five studies that are all
// estimates and all inside the window has the same three identical figures, and
// the same nothing to compare.
function scopeFigure(cum: CumulativeDose): string {
  return `${isCombinedEstimated(cum) ? "≈ " : ""}${formatScopeMsv(cum, combinedMsv(cum))}`;
}

export function doseSplitIsRedundant<S extends DoseStudyInput>(
  breakdown: DoseBreakdown<S>
): boolean {
  const all = breakdown.allRecords;
  if (!all.hasAnyDose) return false;
  // Both sides populated means the two sub-lines are genuinely parts of a whole.
  if (all.recordedCount > 0 && all.estimatedCount > 0) return false;
  // The one populated side sums to the headline by construction; assert it rather
  // than assume it, since that is the property the collapse is claiming.
  const side = all.recordedCount > 0 ? all.recordedMsv : all.estimatedMsv;
  if (formatScopeMsv(all, side) !== formatScopeMsv(all, combinedMsv(all)))
    return false;
  // A lens that reaches a different figure is the one comparison worth drawing.
  if (breakdown.window.windowYears == null) return true;
  return scopeFigure(breakdown.window) === scopeFigure(all);
}

// "1 estimated study" / "4 recorded studies" — the clause the headline carries when
// the split collapses into it. Null when there is nothing to count.
//
// The word is the SOURCE the studies came in as, not a verdict about them: it is the
// same distinction the split lines drew, kept because it is the half of those lines
// that was not a restatement of the total.
export function doseScopeCountLabel(cum: CumulativeDose): string | null {
  const recorded = cum.recordedCount > 0;
  const count = recorded ? cum.recordedCount : cum.estimatedCount;
  if (count === 0) return null;
  return `${count} ${recorded ? "recorded" : "estimated"} ${count === 1 ? "study" : "studies"}`;
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

// Float-noise trim on a sum of display-rounded rows: 0.1 + 0.2 must not leave
// 0.30000000000000004 in `recordedMsv`. The rows are all multiples of 10^-decimals, so
// their exact sum is too — this restores that value and rounds nothing away (#2970 R5).
//
// It is about the NUMBER, not the printing: `formatScopeMsv` would hide the dust anyway,
// so the job here is that the CumulativeDose fields — public numbers, read by
// `combinedMsv` and `backgroundEquivalentMonths` and by any later surface — are the exact
// decimal a reader adding the rows arrives at. Pinned as such: the sum of a recorded 0.1
// and a recorded 0.2 is 0.3, and combining a recorded 0.1 with an estimated 0.7 is 0.8.
function roundTo(n: number, decimals: number): number {
  const scale = 10 ** Math.min(20, decimals);
  return Math.round(n * scale) / scale;
}
