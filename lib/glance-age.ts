// HOW A GLANCE CARD LABELS A DATED READING'S AGE (#2332).
//
// THE DIVERGENCE. Two dashboard cards answer the same question — "how old is this
// reading, and may it still be read as current?" — and answered it two ways. Recent
// labs (#1216) put a compact age in a narrow right-hand column and recolored it amber
// past its floor, with a `title` reading "Older than a year — not a recent result".
// Latest vitals (#2303) put the ISO date on a prose provenance line, swapped it for
// "4 years ago" past its floor, and explained itself with "Older than six months —
// still your latest reading, but not a current one". Both were reasonable alone; the
// pair meant the NEXT glance surface needing a recency floor would find two
// precedents and have to pick.
//
// So the decision moves here, once, and both cards read it. What each card still
// supplies is only what is genuinely its own: WHICH interval applies (its floor, which
// #1216 and #2303 each argued separately and correctly), how that interval reads in
// words, and the FORM its layout can hold.
//
// STALENESS IS NOT RE-DERIVED. The caller passes the `FreshnessState` its own floor
// already produced through `freshnessState` (lib/freshness.ts), and only `due` earns
// the age treatment. `not-applicable` — an undatable reading — states its date plainly
// and claims nothing either way; folding it into `due` would age-label a reading whose
// age nobody knows.
//
// THE FORM IS A LAYOUT FACT, NOT A SECOND OPINION. A glance card's age token lives
// either in a narrow fixed-width column or on a full-width provenance line, and the
// two cannot carry the same string: "4 years ago" does not fit a `w-14` column, and a
// bare "4y" throws away room the prose line has. So the form is declared per surface
// while the DECISION — when to say an age at all, when to go amber, what the hover
// sentence is — is shared. A third glance surface picks a form; it does not pick a
// treatment.

import { daysBetweenDateStr } from "./date";
import { formatCompactAge, formatRelativeDate } from "./format-date";
import type { FreshnessState } from "./freshness";

// Which typographic form this surface's layout can hold.
//   "compact" — a narrow fixed-width column (Recent labs). The age is the only thing
//     that fits, and on a glance surface it is also the more useful of the two facts,
//     so it shows at every state: "Today", "3d", "4y".
//   "long"    — a prose provenance line (Latest vitals). A current reading states its
//     DATE, because for a recent reading the exact day is the more useful fact and
//     "3 days ago" is a downgrade; a stale one states its AGE, because "2022-03-08"
//     does not read as "four years ago" at a glance, which is how that card came to
//     look like a snapshot of "my vitals now" (#2303). The two freshest days are the
//     exception (#4757): "Wednesday, September 2" IS today, and a reader should not
//     have to do calendar math to learn a reading is current, so today and yesterday
//     say so in words. The day after yesterday is already a date worth naming.
//   "as-of"   — a qualifier tucked under a headline NUMBER (the Trends body chart
//     cards, #2615 item 3). It states the DATE at every state, never the age: "2 weeks
//     ago" sitting beside "99.2 °F" reads as a second quantity, and "as of" means a
//     day. Two things are declared at that call site rather than here, because both are
//     layout facts of a chart-card header and neither is a second opinion on staleness:
//     the card renders the token ONLY when the claim needs withdrawing (it has one
//     spare line, and a current reading's date is already the plot's right edge), and
//     it passes `dateLabel` so the day reads in the login's own date format.
export type GlanceAgeForm = "compact" | "long" | "as-of";

export interface GlanceAgeToken {
  /** What the token reads. Never null: a dated reading always states something. */
  text: string;
  /** Past the surface's floor — `due` and only `due`. Drives the amber treatment. */
  stale: boolean;
  /** The token's text color. Amber only when the age is the stale one. */
  className: string;
  /** Hover text naming the floor that was crossed; null unless stale. */
  title: string | null;
}

// The two treatments, shared so the cards cannot drift on the color the way they drifted
// on the wording. Same amber pair #1216 established and #2303 copied.
const AGE_CLASS_CURRENT = "text-slate-500 dark:text-slate-400";
const AGE_CLASS_STALE = "font-medium text-amber-600 dark:text-amber-400";

// THE SAME DECISION, WORN BY A SERIES (#3252). The Standing sparkline sits inches from
// the age label for the same reading, so the two cannot be allowed to disagree about
// whether that reading is current: an amber "4y" beside a confident green plot is the
// card contradicting itself in one glance. The sparkline therefore inherits `stale`
// from the token above rather than re-deciding — this is the treatment, not a second
// opinion, which is why it lives here beside the text classes.
//
// The green is the BRAND green, not emerald: #1445 folded emerald out of the palette
// on contrast grounds. Both tones are ONE STEP DARKER than the label's on light, and
// that is measured rather than taste: a 2px stroke is a graphical object and owes 3:1,
// and against this app's light surface (#f4f8f0) amber-600 lands at 2.96:1 — under the
// floor — while amber-700 is 4.67:1 and brand-700 4.66:1. Dark mode keeps the label's
// own 400 steps, which are already ~10:1 there. Same hues as the age beside it, so the
// pair still reads as one statement about one reading.
const SERIES_CLASS_CURRENT = "text-brand-700 dark:text-brand-400";
const SERIES_CLASS_STALE = "text-amber-700 dark:text-amber-400";

/** The tone a series drawn beside a glance age must take. `currentColor` does the rest. */
export function glanceSeriesToneClass(stale: boolean): string {
  return stale ? SERIES_CLASS_STALE : SERIES_CLASS_CURRENT;
}

interface GlanceAgeCommon {
  /** The reading's own day (YYYY-MM-DD) — a profile-local DAY, never an instant. */
  date: string;
  /** The PROFILE-local day the age is measured against (#1186), never the server's. */
  today: string;
  /** The verdict this surface's own floor already produced. */
  freshness: FreshnessState;
  /**
   * How this surface's floor reads in a sentence ("a year", "six months") — the one
   * thing the hover sentence cannot know on its own, and the reason the sentence is
   * worth sharing at all: naming the interval is the work the relative date does not
   * do.
   */
  floorLabel: string;
}

// THE MACHINE-TO-DISPLAY BOUNDARY, MADE UNSKIPPABLE (#3492).
//
// `dateLabel` used to be OPTIONAL, with `input.dateLabel ?? input.date` standing the
// raw ISO day in when a caller omitted it. That fallback is how "112/72 mmHg
// 2026-07-22" reached the dashboard: both Standing vitals rows ask for the `long`
// form and neither passed a label, so the ONE surface in this module that prints a
// day printed the storage format. Nothing was broken — the escape hatch was taken,
// silently, by the only callers that could take it.
//
// So the shape below makes the two questions inseparable: a form that STATES A DAY
// (`long`, `as-of`) cannot be constructed without the day already rendered through
// the login's date prefs, and a form that states only an AGE (`compact`) has no
// place to put one. The next glance surface inherits the boundary from the type
// rather than from anybody remembering — which is the whole difference between this
// and a fourth per-site format call.
//
// This module stays PURE and prefs-free on purpose: the caller holds the prefs
// (`useFormatPrefs()` in a client component, `getDisplayFormatPrefs(login.id)` at a
// server page's boundary) and hands in the finished string from lib/format-date's
// display vocabulary. Formatting here would need the prefs threaded into a pure
// model, and would put a second date formatter beside the one that already exists.
export type GlanceAgeInput =
  | (GlanceAgeCommon & {
      /** A narrow fixed-width column: the age is the only thing that fits. */
      form: "compact";
    })
  | (GlanceAgeCommon & {
      form: "long" | "as-of";
      /**
       * The reading's day ALREADY rendered in the login's date format ("Jul 29",
       * "Friday, July 24"). Required, not defaulted — see the note above.
       */
      dateLabel: string;
    });

// The long form's two spoken days. Lowercase because the token follows the value on
// one line ("63 bpm today"); the compact form's "Today" heads a column cell instead.
function recentDayWord(date: string, today: string): string | null {
  const days = daysBetweenDateStr(date, today);
  return days == null || days > 1 ? null : days <= 0 ? "today" : "yesterday";
}

export function glanceAgeToken(input: GlanceAgeInput): GlanceAgeToken {
  const stale = input.freshness === "due";
  const text =
    input.form === "compact"
      ? formatCompactAge(input.date, input.today)
      : input.form === "as-of"
        ? `as of ${input.dateLabel}`
        : stale
          ? formatRelativeDate(input.date, input.today)
          : (recentDayWord(input.date, input.today) ?? input.dateLabel);
  return {
    text,
    stale,
    className: stale ? AGE_CLASS_STALE : AGE_CLASS_CURRENT,
    // ONE sentence for every surface. It says the two things a bare date cannot: which
    // interval was crossed, and that this is still the latest reading — the card is
    // withdrawing a claim about currency, not hiding a value or reporting a gap.
    title: stale
      ? `Older than ${input.floorLabel} — still your latest reading, but not a current one`
      : null,
  };
}
