import { isNotableFlag } from "./reference-range";
import type {
  MedicalCategory,
  MedicalFlag,
  ClinicalObservation,
} from "./types";
import { clinicalResultDetailHref, type AppRoute } from "./hrefs";
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

// FRESH ENOUGH TO CLAIM THE GLANCE (owner ruling #4232, 2026-08-30). A clinical
// result COLLECTED within this many days is relevant whether or not it is notable —
// "the main goal of this page is to show what's relevant; if clinical results are
// fresh, they are relevant" — and its claim ends on acknowledgment or when the window
// lapses, whichever comes first.
//
// KEYED ON THE COLLECTION DATE, not on when the record landed, which is the whole
// reason a window works here: a backfilled import of old results claims nothing,
// because the person has already handled those results. The window is what stops a
// never-acknowledged result claiming forever.
//
// 30 is a RULED number, not an inferred one: #3934 flagged this gap and deliberately
// declined to guess it so the owner could set it.
export const CLINICAL_RESULT_FRESH_DAYS = 30;

// That interval said in words, for the hover sentence the glance cards share
// (lib/glance-age). Kept beside the number so the copy and the floor it explains
// cannot drift — the same pairing VITAL_PRESENTATION_FLOORS makes on the other card.
export const RECENT_LAB_STALE_LABEL = "a year";

// Which medical-record categories count as "labs" for the recent-labs surfaces:
// `lab` ONLY (#1076). Vitals, screening instruments, derived composites, and
// immutable facts each have their own home and must not appear in a recent-labs
// list.
export const LAB_CATEGORIES: ReadonlySet<MedicalCategory> =
  new Set<MedicalCategory>(["lab"]);

// FRESH ENOUGH TO CLAIM, as ONE decision (#4232). The ruling composes two halves —
// the collection-date window above and the acknowledge lifecycle #3225 already runs —
// and says the claim ends at "whichever is first". Split across two call sites that is
// a rule nobody can state; here it is one function with one table behind it.
//
// `collectedOn` is the reading's own COLLECTION date. An undatable reading is not
// fresh: `freshnessState` answers "not-applicable" for it, which is honestly neither
// current nor lapsed, and a claim needs a positive answer.
export function clinicalResultClaimsFreshness(
  collectedOn: string | null | undefined,
  today: string,
  acknowledged: boolean
): boolean {
  if (acknowledged) return false;
  return (
    freshnessState(
      freshnessAgeDays(collectedOn, today),
      CLINICAL_RESULT_FRESH_DAYS
    ) === "current"
  );
}

// WHERE A RESULT HOSTS ITS OWN ACKNOWLEDGE CONTROL (#3225, generalising #4232).
//
// An acknowledgment SPENDS A CLAIM, so the control goes on a row that has one to
// spend — freshness, or the notable-first precedence this issue's reorder takes away
// — and nowhere a second control would post the same signal, which is a key already
// carrying an attention item.
//
// #4232 wrote the first half as freshness ALONE, and its reasoning ("its only mount
// is the attention row's menu — which a non-flagged result never has") holds only
// inside FLAGGED_ATTENTION_WINDOW_DAYS: that window bounds the reading's COLLECTION
// date, so a months-old notable has no attention item either. That left this issue's
// own population — 37 chronic notables from one June panel — with no acknowledge
// control on the dashboard at all, only on the detail page each row links to.
export function clinicalResultHostsAcknowledge(args: {
  collectedOn: string | null | undefined;
  today: string;
  flag: MedicalFlag | null;
  acknowledged: boolean;
  hasAttentionItem: boolean;
}): boolean {
  if (args.acknowledged || args.hasAttentionItem) return false;
  return (
    clinicalResultClaimsFreshness(args.collectedOn, args.today, false) ||
    isNotableFlag(args.flag)
  );
}

// One latest lab reading, flattened for display by a surface.
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
// Of the current (latest-per-marker) lab readings, pick the few to
// surface: out-of-range markers float to the top, then newest-first, then take
// the first `limit`. A flagged marker being the headline is the whole point, so
// the flag precedence leads and the date tie-break is only among equally-flagged
// rows. Pure over the `{ current: true }` clinical-observations read so a digest,
// weekly recap, or HA "recent labs" read shares the identical policy.
export function recentLabHighlights(
  records: LabRecord[],
  limit = 6,
  todayStr?: string,
  acknowledged?: (name: string) => boolean
): RecentLabRow[] {
  // "Notable" = the canonical notability predicate (issue #544/#551, #2799):
  // out-of-range (high/low/abnormal), non-optimal, or outside the lab's own reported
  // range. A loose `flag !== "normal"` test would sort the neutral "immune" flag (a
  // good durable-immunity titer) to the top as if abnormal — exactly the "good result
  // reads as needs-attention" behavior #544 eliminates. Route through the shared
  // isNotableFlag so a new neutral flag value can't be miscategorized here, and a new
  // notable one can't be silently omitted.
  const notable = (flag: MedicalFlag | null): boolean => isNotableFlag(flag);
  // Notability is what a marker CLAIMS the lead with, and an acknowledgment spends
  // that claim (#3225): the owner's 37 chronic notables all came from one panel, so
  // notable-first alone seats the same six rows until the next draw and the family is
  // a poster rather than a glance. An acknowledged marker sorts with the ordinary
  // results — newest-first among them — so the seats go to what has not been seen.
  // The row's FLAG is untouched: the reading still renders "High", still lists on
  // /results, still counts as notable everywhere else. Only its precedence moves.
  //
  // Callers that pass nothing are byte-identical to the pre-#3225 order, which is
  // what keeps the digest and the weekly recap out of scope here.
  const claims = (r: LabRecord): boolean =>
    notable(r.flag) && !acknowledged?.(r.canonical_name?.trim() || r.name);
  return records
    .filter((r) => r.category !== null && LAB_CATEGORIES.has(r.category))
    .slice()
    .sort((a, b) => {
      const af = claims(a) ? 0 : 1;
      const bf = claims(b) ? 0 : 1;
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
        href: clinicalResultDetailHref(r.canonical_name, r.name),
        freshness: freshnessState(age, RECENT_LAB_STALE_DAYS),
      };
    });
}
