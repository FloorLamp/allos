// DOMAIN DORMANCY (#2652, behavior 2 — "dormancy collapses, loudly"). PURE — no DB,
// no clock, no JSX.
//
// THE QUESTION. "Has this domain stopped arriving?" It is NOT the same question as
// "is this reading still current?" (lib/freshness.ts and the presentation floors that
// adapt it), and the difference is the whole reason this module exists:
//
//   • A PRESENTATION FLOOR is framing. A blood pressure past six months stops being
//     rendered as current-shaped copy and gains an as-of stamp; the value stays where
//     it is, at full prominence (`VITAL_PRESENTATION_FLOORS`,
//     `TREND_METRIC_PRESENTATION_FLOORS`, `RECENT_LAB_STALE_DAYS`). Nothing is hidden.
//   • DORMANCY is a claim about the PIPELINE. Nothing has arrived in this domain for
//     long enough that the section presenting it has stopped being about today, so it
//     spends one line instead of a card — and that line says how long, and offers the
//     thing that would end it.
//
// THE LINE BETWEEN THEM, and it is a hard one. A presentation floor exists precisely so
// a stale value can STAY ON SCREEN honestly — "still your latest reading, but not a
// current one" (#1216/#2303) — and the freshness doctrine's rule is that the fix is what
// an aggregate CLAIMS, never what it hides. So a section that is showing a real value
// under a floor may NEVER be collapsed: the collapse would hide exactly what the floor
// deliberately keeps. Dormancy is available only where there is nothing to hide —
// a section whose populated render is WINDOW-BOUNDED and therefore already shows
// nothing once its domain goes quiet. There, the collapse replaces an empty card with
// an honest line and hides not one number.
//
// That is why this registry is small. `recent-labs` is still an exemption on exactly
// that ground: its readout renders the latest row of every biomarker at any age, so a
// collapse would hide values.
//
// `vitals-latest` USED TO BE the other exemption, on the same ground, and #3226 retired
// it — not by weakening the rule but by making the section window-bounded, which is what
// the rule actually asks for. A blood pressure past a YEAR stops being rendered as a
// value at all, so past that point the row is already showing nothing and the collapse
// hides nothing. The interval is deliberately far outside the quantity's presentation
// floor (180 days for BP), so the amber as-of treatment #2303 established still owns the
// whole span where the reading is merely old: dormancy begins only where the reading has
// stopped being a description of the body. Each vital quantity is its OWN domain, so a
// resting HR that arrived this morning is untouched by a blood pressure from 2022.
//
// WHAT THE LINE MAY CLAIM. Dormancy is a fact about the RECORD, never about the body.
// "No sleep recorded in 152 days" is true; "you have not slept in 152 days" is not, and
// a quiet domain is quiet for two very different reasons — nothing was logged, or
// nothing happened. Every string this module produces names the record, so the
// collapsed state cannot be read as the other. The ABSENT case (nothing has EVER been
// recorded) is a THIRD state with its own onboarding copy, and is deliberately not
// folded into dormant: telling somebody with three years of weigh-ins that they have
// never weighed themselves is the defect this replaces, not a rounding error.
//
// WHAT DORMANCY MAY NEVER DO. Change reach. The collapsed line is one tap from the full
// surface, states the age, and carries the fix — and where the fix is a WRITE rather
// than a link (log a reading), the collapsed line carries the write. A section that
// carries an OBLIGATION never collapses at all (owner ruling, 2026-08-13): active
// medications and care follow-ups are out of this registry's reach by construction —
// nothing here is consulted by a finding, a notification, or the Upcoming bus.

import {
  freshnessAgeDays,
  freshnessState,
  type FreshnessState,
} from "./freshness";

// The owner-resolved default (2026-08-13): a domain with nothing in 90 days is dormant.
// A domain may declare a LONGER interval when its own cadence makes 90 days ordinary;
// it may not declare a shorter one than a presentation floor it already has.
export const DORMANCY_DEFAULT_DAYS = 90;

// Trailing window for the dashboard weight-trend glance (#395): a deliberate date
// window, not a row cap, so the widget matches the full deduped body-census series it
// links to instead of silently truncating at N readings.
//
// It lives here rather than in the page because the weight domain's dormancy
// declaration below has to NAME it: the collapse is only honest because past this many
// days the chart has no points left to hide.
export const WEIGHT_TREND_WINDOW_DAYS = 90;

// Past this, an EPISODIC vital stops being rendered as a value and becomes a dormant
// line (#3226). It is the year that `RECENT_LAB_STALE_DAYS` already argues for one card
// over: a reading whose own floor lapsed a year ago has stopped being a stale
// description of the body and become a historical fact about the ledger.
//
// ONE OF THE TWO VITAL ROWS TAKES IT (owner ruling, #3250). The year was written for a
// cuff reading and inherited by the wearable stream beside it, and the two cadences have
// nothing in common: a season of silence on a daily stream is the sync broken, which is
// an actionable fact, while the same silence between physicals is an ordinary gap. So
// blood pressure keeps the year and resting HR takes the registry default below.
//
// It is named here rather than in `vitals-latest` because the declaration has to BE it:
// the collapse is only honest because past this many days the row renders no value, so
// the interval and the render window are the same number by construction.
export const VITAL_DORMANCY_DAYS = 365;

// The domains a section can be dormant IN. Adding one is a deliberate edit with a
// declaration and a test to update, never an inheritance.
//
// The two vital quantities are SEPARATE domains, and that is the point rather than an
// accident of naming: they arrive on entirely different cadences (a wearable stream and
// an episodic cuff reading), so one going quiet says nothing about the other. A single
// "vitals" domain would let a 2022 blood pressure collapse this morning's resting heart
// rate, which is the family-level defect #3226 exists to prevent.
export type DormancyDomain =
  "sleep" | "weight" | "blood-pressure" | "resting-hr";

export interface DormancyDeclaration {
  // What the collapsed line calls the missing RECORD — never the activity. "sleep
  // recorded", "weigh-in recorded": a statement about the ledger.
  readonly record: string;
  // Days of silence after which the section collapses. Strictly after (the
  // `freshnessState` boundary), so a domain that last arrived exactly this many days
  // ago is still awake and comes dormant tomorrow.
  readonly collapseAfterDays: number;
  // Why THIS number. A domain taking the default says so; a domain overriding it says
  // what about its cadence makes the default wrong.
  readonly reason: string;
  // WHY THIS DOMAIN MAY COLLAPSE AT ALL: the window its section renders over, past which
  // the section is already showing nothing. Naming it here is the check that keeps the
  // registry inside the rule above — a section with no window has a value on screen, and
  // a value on screen is never collapsed.
  readonly renderWindowDays: number;
}

export const DORMANCY_DOMAINS: Record<DormancyDomain, DormancyDeclaration> = {
  // A nightly stream. Ninety nights of silence is the device off the wrist or the
  // integration disconnected, not a sleep pattern. The tile renders LAST NIGHT, so a
  // quiet domain leaves it with nothing on screen well before the interval elapses.
  sleep: {
    record: "sleep",
    collapseAfterDays: DORMANCY_DEFAULT_DAYS,
    reason: "A nightly stream; the default is the right size for it.",
    renderWindowDays: 1,
  },
  // Self-measured: weeks between step-ons is an ordinary cadence and not a lapse, which
  // is why the trend card's own window is 90 days — the same 90. Past it the chart has
  // no points at all, so the collapse costs the reader nothing and gains them the one
  // fact the empty card withheld: how long it has been.
  weight: {
    record: "weigh-in",
    collapseAfterDays: DORMANCY_DEFAULT_DAYS,
    reason:
      "Self-measured; weeks apart is ordinary, a season of silence is the scale going unused.",
    renderWindowDays: WEIGHT_TREND_WINDOW_DAYS,
  },
  // Episodic: a weekly logger or an annual physical, so the 90-day default would collapse
  // an ordinary cadence. A year is the interval past which the number has stopped being a
  // description — and past which this row renders no value, which is what lets it
  // collapse at all.
  "blood-pressure": {
    record: "blood pressure",
    collapseAfterDays: VITAL_DORMANCY_DAYS,
    reason:
      "Episodic by nature; a year is where a cuff reading stops describing the body and becomes history.",
    renderWindowDays: VITAL_DORMANCY_DAYS,
  },
  // A daily wearable stream, whose 14-day presentation floor already withdraws the
  // currency claim. Dormancy is the far end of the same span, not a second staleness: it
  // fires only once the stream has been silent long enough that the last number is a
  // record rather than a reading — and on something that arrives nightly, a season is
  // already long enough (#3250). At the year it inherited from blood pressure the line
  // was an epitaph; at 90 days it is the sentence that tells someone their sync broke,
  // while the amber as-of span the 14-day floor owns is still 76 days of it.
  "resting-hr": {
    record: "resting heart rate",
    collapseAfterDays: DORMANCY_DEFAULT_DAYS,
    reason:
      "A daily stream whose own floor is 14 days; the default season of silence is the source gone, not a gap.",
    renderWindowDays: DORMANCY_DEFAULT_DAYS,
  },
};

export const DORMANCY_DOMAIN_KEYS = Object.keys(
  DORMANCY_DOMAINS
) as DormancyDomain[];

// The three states, and the reason there are three rather than two:
//   • "absent"  — nothing has EVER been recorded. The onboarding case; its copy is a
//                 first-run invitation and it must never claim an age.
//   • "current" — something arrived inside the interval.
//   • "dormant" — something DID arrive, and then stopped.
export type DormancyState = "absent" | "current" | "dormant";

export interface DormancyInput {
  // The newest recorded day in the domain, profile-local `YYYY-MM-DD`, or null when the
  // domain has never recorded anything.
  lastRecordDate: string | null | undefined;
  // The PROFILE-local today (#1186), never the server's.
  today: string;
  domain: DormancyDomain;
}

// The one dormancy decision. The staleness comparison itself is `freshnessState`'s —
// never re-derived here — so the boundary is the shared one (dormant STRICTLY after the
// interval). `not-applicable` is never folded into dormant: an unparseable or absent
// date is "absent", which has different copy and a different affordance.
export function dormancyState({
  lastRecordDate,
  today,
  domain,
}: DormancyInput): DormancyState {
  if (!lastRecordDate) return "absent";
  const age = freshnessAgeDays(lastRecordDate, today);
  const state: FreshnessState = freshnessState(
    age,
    DORMANCY_DOMAINS[domain].collapseAfterDays
  );
  if (state === "not-applicable") return "absent";
  return state === "due" ? "dormant" : "current";
}

// The collapsed line's sentence. Names the RECORD and states the age in whole days, so
// the reader is told the thing they would otherwise have to reconstruct from an axis.
// Never a claim about the body, and never a claim about why.
export function dormantRecordLine(
  domain: DormancyDomain,
  ageDays: number
): string {
  const { record } = DORMANCY_DOMAINS[domain];
  const days = Math.max(0, Math.trunc(ageDays));
  return `No ${record} recorded in ${days} ${days === 1 ? "day" : "days"}`;
}

// The same sentence for a domain whose silence is measured in YEARS, which is the only
// reason this exists beside `dormantRecordLine`: "No blood pressure recorded in 1,642
// days" is a number nobody can read as a duration, and the reader has to do arithmetic to
// recover the one fact they wanted. At year scale the SOURCE MONTH is the legible form of
// exactly the same claim — still the record, never the body, and still never a guess at
// why. Domains on a 90-day interval keep the day count, where days are the natural unit.
//
// Returns null for a date it cannot read, so a caller can fall back rather than render a
// sentence with a hole in it.
export function dormantRecordSince(
  domain: DormancyDomain,
  lastRecordDate: string | null | undefined
): string | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(lastRecordDate ?? "");
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `No ${DORMANCY_DOMAINS[domain].record} recorded since ${MONTH_ABBREVIATIONS[month - 1]} ${match[1]}`;
}

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// Domains that would collapse while their section could still be showing something —
// i.e. an interval LONGER than the window the section renders over would be fine, but an
// interval that elapses while the window still has points would hide a value. Empty by
// construction; kept as a runtime census so the completeness test reads the way the
// freshness ones do and a hand-edited registry cannot quietly shed the guarantee.
export function dormancyWindowConflicts(
  domains: readonly DormancyDomain[] = DORMANCY_DOMAIN_KEYS
): DormancyDomain[] {
  return domains.filter(
    (d) =>
      DORMANCY_DOMAINS[d].collapseAfterDays <
      DORMANCY_DOMAINS[d].renderWindowDays
  );
}
