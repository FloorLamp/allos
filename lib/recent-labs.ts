import { isNonOptimal, isOutOfRange } from "./reference-range";
import type {
  MedicalCategory,
  MedicalFlag,
  ClinicalObservation,
} from "./types";
import { readingDetailHref, type AppRoute } from "./hrefs";
import {
  freshnessAgeDays,
  freshnessState,
  type FreshnessState,
} from "./freshness";

// Recency floor (#1216): a reading older than this many days is "stale" — still
// worth surfacing (a latest-per-marker highlight, and an unresolved abnormal never
// expires), but it must be visibly age-labeled rather than dressed as recent. A
// year is the natural window for routine labs; a value beyond it read as "current"
// on a glance dashboard is the dishonesty this closes.
export const RECENT_LAB_STALE_DAYS = 365;

// Which medical-record categories count as "labs" for the recent-labs surfaces:
// `lab` ONLY (#1076). Vitals, screening instruments, derived composites, and
// immutable facts each have their own home and must not appear in a recent-labs
// list; the legacy `biomarker` bucket is emptied of real labs (Glucose is now `lab`).
export const LAB_CATEGORIES: ReadonlySet<MedicalCategory> =
  new Set<MedicalCategory>(["lab"]);

// One latest lab/biomarker reading, flattened for display by a surface.
export interface RecentLabRow {
  name: string;
  value: string | null;
  unit: string | null;
  flag: MedicalFlag | null;
  date: string;
  href: AppRoute;
  // The reading's presentation verdict against RECENT_LAB_STALE_DAYS, resolved by the
  // shared `freshnessState` (#2303 — this floor predates lib/freshness.ts and used to
  // compare by hand here). `due` is the one the render layer age-labels distinctly.
  // `not-applicable` covers an undatable reading and a caller that supplied no
  // `todayStr`: no age is knowable, so no claim either way — and never a fold into
  // "fresh", which is what the boolean did.
  freshness: FreshnessState;
}

// The visible severity label a compact lab row pairs with its flag color — the
// non-color channel (WCAG 1.4.1, issue #1220) — used to live here as
// `recentLabStatus`, rendered as a SECOND label beside `MedicalValue`. #2315 folded
// it into `MedicalValue` itself (`showFlagLabel`, decided by
// lib/medical-value.medicalValueFlagText), so one component owns "value + flag +
// severity word" for every surface that wants it and the word is announced once.
// The policy it carried is unchanged: every non-normal flag gets a word, normal/null
// gets none, through the one flagLabel/flagTone chokepoint (#306).

// The subset of a clinical observation the highlight selection reads. `getClinicalObservations`
// rows satisfy it; tests can build the minimal shape.
type LabRecord = Pick<
  ClinicalObservation,
  "category" | "flag" | "date" | "canonical_name" | "name" | "value" | "unit"
>;

// Recent-labs highlight selection (issue #313, extracted from the dashboard).
// Of the current (latest-per-marker) lab/biomarker readings, pick the few to
// surface: out-of-range markers float to the top, then newest-first, then take
// the first `limit`. A flagged marker being the headline is the whole point, so
// the flag precedence leads and the date tie-break is only among equally-flagged
// rows. Pure over the `{ current: true }` clinical-observations read so a digest,
// weekly recap, or HA "recent labs" read shares the identical policy.
export function recentLabHighlights(
  records: LabRecord[],
  limit = 6,
  todayStr?: string
): RecentLabRow[] {
  // "Notable" = the canonical notability predicate (issue #544/#551): out-of-range
  // (high/low/abnormal) OR non-optimal. A loose `flag !== "normal"` test would sort
  // the neutral "immune" flag (a good durable-immunity titer) to the top as if
  // abnormal — exactly the "good result reads as needs-attention" behavior #544
  // eliminates. Route through isOutOfRange/isNonOptimal so a new neutral flag value
  // can't be miscategorized here.
  const notable = (flag: MedicalFlag | null): boolean =>
    isOutOfRange(flag) || isNonOptimal(flag);
  return records
    .filter((r) => LAB_CATEGORIES.has(r.category))
    .slice()
    .sort((a, b) => {
      const af = notable(a.flag) ? 0 : 1;
      const bf = notable(b.flag) ? 0 : 1;
      return af - bf || b.date.localeCompare(a.date);
    })
    .slice(0, limit)
    .map((r) => {
      const name = r.canonical_name?.trim() || r.name;
      const age = freshnessAgeDays(r.date, todayStr);
      return {
        name,
        value: r.value,
        unit: r.unit,
        flag: r.flag,
        date: r.date,
        href: readingDetailHref(r.canonical_name, r.name),
        freshness: freshnessState(age, RECENT_LAB_STALE_DAYS),
      };
    });
}
