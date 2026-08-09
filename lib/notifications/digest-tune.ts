// Per-category digest DEMOTION — the ⚙️ Tune control (issue #1714, owner-designed
// 2026-07-30). PURE: no DB, no clock, no network, so every rule here is
// fixture-testable and the storage/keyboard/settings surfaces all read ONE
// vocabulary.
//
// WHAT DEMOTION MEANS. "Demote" is NOT "hide". A demoted category stops appearing
// ROUTINELY and still surfaces when it crosses its own notable threshold:
//
//   • demoted vitals  — a normal reading stops; an out-of-range one still appears;
//   • demoted sleep   — a typical night stops; a notably short/long one (the #1712
//                       verdict) still appears;
//   • demoted mood / symptoms — routine lines stop; the category's OWN notable
//                       definition (a shift from baseline, a severe symptom-day)
//                       still passes;
//   • demoted activities — an ordinary training day stops; a day that set a personal
//                       record still appears;
//   • demoted nutrition — a HEDGED shortfall stops (one measured from a floor basis,
//                       where untracked foods stay invisible); a shortfall measured
//                       from a tracked full-day total still appears. A day that MET
//                       its targets already says nothing at either setting (#2379);
//   • demoted labs    — nothing stops, because a lab line is never routine: every one
//                       the digest carries is flagged, i.e. floor class.
//
// Each predicate is the classification the line ALREADY computes (#221). Demotion
// never invents a second threshold, and it never reaches the safety floor: in
// applyRecentChangeDemotion `flagged` implies notable, so a flagged lab or an
// out-of-range vital survives every preference. That is the doctrine line this
// module exists to hold — a preference filter reduces ROUTINE contact and can never
// override a safety floor (docs/internals/findings.md).
//
// WHAT IS NOT TUNABLE, and why. Only ONE thing: the offer tail, the Today obligations
// and the minimal-digest guarantee (#1505) are the MESSAGE's job, not a category.
// Demoting everything still leaves the digest's non-demotable core; the message can get
// short, never vanish.
//
// EVERY CATEGORY IS TUNABLE (owner ruling 2026-08-01, #1797). #1774 shipped a
// deliberately conservative launch set — the collector's categories minus `labs`, with
// `activities` deferred — on the argument that a toggle over an all-floor category
// changes nothing visible and would therefore be a lie. That intersection is retired.
// The set is now DERIVED, per side, so there is no hand-maintained list to drift:
//
//   • the COLLECTOR owns its half — `RECENT_CHANGE_CATEGORIES`, so a category added to
//     the collector tomorrow is tunable the day it exists, with nothing to update here;
//   • this module owns the DIGEST'S OWN sections — `DIGEST_OWN_CATEGORIES` (`sleep`,
//     `activities`, `nutrition`), which the collector never produces and which apply
//     where their section is gathered.
//
// `labs` back in the set does NOT weaken the floor, it demonstrates it: every lab line
// the digest carries is `flagged`, `flagged` implies notable in
// applyRecentChangeDemotion, so a reader who tunes labs down still receives every
// flagged result. The toggle states the boundary rather than hiding it — the notable
// copy beside it says exactly that. Tuning reduces ROUTINE contact and can never
// override a safety floor (docs/internals/findings.md §8).

import {
  RECENT_CHANGE_CATEGORIES,
  type RecentChangeCategory,
} from "../recent-changes";
import { sleepVerdict } from "../sleep-summary";
import type { NotificationAction } from "./types";

// The digest's OWN sections, tuned by the same control because a reader does not think
// in terms of which module produced the line. NOT collector categories: the collector
// never emits them, `recentChangeDemotions` strips them before a preference reaches it,
// and each applies where its section is gathered (`gatherDigestSleep` for sleep, the
// Yesterday activity list for activities, `getNutritionDay` for nutrition).
export const DIGEST_OWN_CATEGORIES = [
  "sleep",
  "activities",
  "nutrition",
] as const;
export type DigestOwnCategory = (typeof DIGEST_OWN_CATEGORIES)[number];

// A category the digest's ⚙️ Tune control can demote: everything the collector
// produces, plus the digest's own sections.
export type DigestCategory = RecentChangeCategory | DigestOwnCategory;

// Declaration order = the order the Tune keyboard and the Settings mirror list them.
// Derived from both registries so neither side can silently become untunable.
export const DIGEST_TUNABLE_CATEGORIES: readonly DigestCategory[] = [
  // collector-owned
  ...RECENT_CHANGE_CATEGORIES,
  // digest-owned
  ...DIGEST_OWN_CATEGORIES,
];

const TUNABLE = new Set<string>(DIGEST_TUNABLE_CATEGORIES);

export function isDigestCategory(value: unknown): value is DigestCategory {
  return typeof value === "string" && TUNABLE.has(value);
}

// The button/row label for a category.
export const DIGEST_CATEGORY_LABELS: Record<DigestCategory, string> = {
  labs: "Lab results",
  visits: "Visits",
  growth: "Growth",
  intake: "Supplements & meds",
  vitals: "Vitals",
  symptoms: "Symptoms",
  mood: "Check-in",
  data: "Data arrival",
  sleep: "Sleep",
  activities: "Activities",
  nutrition: "Nutrition",
};

// What SURVIVES a demotion, stated in the reader's words. The Settings mirror renders
// it beside each row so "demote" can never be mistaken for "mute" — and so someone
// auditing why their digest looks thin can see exactly what is still guaranteed.
export const DIGEST_CATEGORY_NOTABLE: Record<DigestCategory, string> = {
  // Stated as the boundary it is: every lab line the digest carries is flagged, and a
  // flagged result is floor class, so this toggle cannot take one away.
  labs: "A flagged result always appears — turning this down never hides one.",
  visits: "Appointments still appear on Upcoming.",
  growth: "A percentile-band crossing still ranks above routine lines.",
  intake: "Dose reminders and refill nudges are unaffected.",
  vitals: "An out-of-range reading still appears.",
  symptoms: "A severe symptom day still appears.",
  mood: "A shift from your recent average still appears.",
  data: "Sync failures still surface on Data → Review.",
  sleep: "A notably short or long night still appears.",
  activities: "A day that set a personal record still appears.",
  // The line only ever states a SHORTFALL, so the demotion cannot be "routine days
  // stop" — those already say nothing. What it turns down is the HEDGED shortfall: one
  // measured from a floor (logged foods, quick-add grams, a fibre dose), which the copy
  // marks "84 g+" precisely because untracked foods stay invisible and the real intake
  // may already be there. A shortfall measured from a tracked full-day total is an
  // asserted fact about the day, and survives.
  nutrition: "A shortfall measured from tracked intake still appears.",
};

// Short button labels — a Telegram inline button has ~30 usable characters beside an
// icon, so the keyboard uses these rather than the Settings labels.
export const DIGEST_CATEGORY_SHORT: Record<DigestCategory, string> = {
  labs: "Labs",
  visits: "Visits",
  growth: "Growth",
  intake: "Supplements",
  vitals: "Vitals",
  symptoms: "Symptoms",
  mood: "Check-in",
  data: "Data",
  sleep: "Sleep",
  activities: "Training",
  nutrition: "Nutrition",
};

// ---- Stored form -----------------------------------------------------------

// Parse the stored `login_settings` value (a comma-separated category list) into a
// deduped, declaration-ordered set. Unknown/retired names are DROPPED rather than
// carried: a preference naming a category that no longer exists silences nothing, and
// keeping it would resurrect it if the name were ever reused.
export function parseDigestDemotions(
  raw: string | null | undefined
): DigestCategory[] {
  if (!raw) return [];
  const seen = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(isDigestCategory)
  );
  return DIGEST_TUNABLE_CATEGORIES.filter((c) => seen.has(c));
}

export function serializeDigestDemotions(
  cats: readonly DigestCategory[]
): string {
  return DIGEST_TUNABLE_CATEGORIES.filter((c) => cats.includes(c)).join(",");
}

// Flip one category. Declared-only doctrine (#1505): this is the WHOLE write — the
// user's tap decides, nothing infers a demotion on their behalf, and nothing here
// escalates (a toggle can always be flipped back, from either surface).
export function toggleDigestDemotion(
  current: readonly DigestCategory[],
  category: DigestCategory
): DigestCategory[] {
  const next = new Set(current);
  if (next.has(category)) next.delete(category);
  else next.add(category);
  return DIGEST_TUNABLE_CATEGORIES.filter((c) => next.has(c));
}

// The one-line state the Settings mirror shows COLLAPSED (#1868 §3). The mirror's ten
// always-rendered checkboxes moved behind a disclosure — the card is a mirror of the
// digest's own ⚙️ Tune control, so it should cost one line until someone opens it —
// and a collapsed control has to state what is actually stored, by name. Declaration
// order, so the summary matches the list underneath it.
export function digestTuneSummary(demoted: readonly DigestCategory[]): string {
  const named = DIGEST_TUNABLE_CATEGORIES.filter((c) => demoted.includes(c));
  if (named.length === 0)
    return "Every category on — nothing turned down to notable-only.";
  const labels = named.map((c) => DIGEST_CATEGORY_LABELS[c]).join(", ");
  return named.length === 1
    ? `1 category is notable-only: ${labels}.`
    : `${named.length} categories are notable-only: ${labels}.`;
}

// ---- One message, N readers ------------------------------------------------

// The digest is built ONCE per profile and dispatched to every managing login's
// channel, while the preference is per LOGIN. Those two facts have to be reconciled
// somewhere, and the only safe direction is the CONSERVATIVE one: a category is
// demoted for the message when EVERY login that receives it has declared that
// demotion. Nobody is ever shown less than they asked for, and no login's tap can
// quietly thin another login's digest.
//
// The overwhelmingly common cases — a single managing login, or several logins
// sharing one family chat — collapse to exactly the declared preference. A household
// where two logins genuinely disagree keeps the union of what they want to see, which
// is the honest answer for a single shared message.
//
// EMPTY INPUT IS EMPTY OUTPUT, not "everything". A profile with no managing login has
// declared nothing, and an intersection over no sets must not silently demote the
// world.
export function intersectDigestDemotions(
  perLogin: readonly (readonly DigestCategory[])[]
): DigestCategory[] {
  if (perLogin.length === 0) return [];
  const sets = perLogin.map((l) => new Set(l));
  return DIGEST_TUNABLE_CATEGORIES.filter((c) => sets.every((s) => s.has(c)));
}

// The subset the recent-changes collector understands. The digest's OWN sections
// (`sleep`, `activities`) are applied where they are gathered, so the collector never
// sees a preference it has no category for.
const OWN = new Set<string>(DIGEST_OWN_CATEGORIES);

export function recentChangeDemotions(
  cats: readonly DigestCategory[]
): RecentChangeCategory[] {
  return cats.filter((c): c is RecentChangeCategory => !OWN.has(c));
}

// Does last night's Sleep section survive the reader's preference? Demoted sleep keeps
// only a night the #1712 verdict calls notable — the SAME classification the line
// already prints ("▲ 41m above typical"), never a threshold invented here. A night
// with no baseline has no verdict and so reads as routine: the section states the
// figure alone, which is exactly the routine line a demotion is asking to stop.
export function sleepSurvivesDemotion(
  demoted: readonly DigestCategory[],
  lastNightMin: number,
  baselineMin: number | null | undefined
): boolean {
  if (!demoted.includes("sleep")) return true;
  const verdict = sleepVerdict(lastNightMin, baselineMin);
  return verdict === "above" || verdict === "below";
}

// Does yesterday's Activities list survive the reader's preference? Demoted activities
// keep only a day that set a PERSONAL RECORD — the predicate the #1714 design named
// ("a PR"), read from the SAME recentPRs/recentCardioPRs classification the weekly
// recap and the Trends fitness lens already render, never a threshold invented here. A
// day of ordinary training has no record and so reads as routine, which is exactly the
// line a demotion is asking to stop.
//
// The caller passes the COUNT rather than the records because resolving them costs two
// history reads; the digest only pays for them when this category is actually demoted.
export function activitiesSurviveDemotion(
  demoted: readonly DigestCategory[],
  personalRecords: number
): boolean {
  if (!demoted.includes("activities")) return true;
  return personalRecords > 0;
}

// Does yesterday's Nutrition line survive the reader's preference (#2379)? The line only
// ever states a SHORTFALL — a day that met its targets emits nothing at either setting —
// so the demotion cannot be "routine days stop". What it turns down is the HEDGED
// shortfall.
//
// The predicate is the classification the line ALREADY computes, never a threshold
// invented here: `isFloor` is the #767/#976 floor discipline, the same fact the copy
// prints as the trailing "+" on "84 g+". A floor-basis shortfall is explicitly NOT an
// assertion — untracked foods stay invisible, so the real intake may already be there —
// and that is exactly the line a reader who taps food groups sees most mornings. A
// shortfall measured from a tracked full-day total is an asserted fact about the day and
// survives every preference.
//
// Nutrition is coaching tier and carries no safety floor, so unlike `labs` this toggle
// genuinely reduces contact — which is the only direction the doctrine allows a
// preference to move on its own (docs/internals/findings.md §2, §8).
export function nutritionSurvivesDemotion(
  demoted: readonly DigestCategory[],
  shortfalls: readonly { isFloor: boolean }[]
): boolean {
  if (!demoted.includes("nutrition")) return true;
  return shortfalls.some((s) => !s.isFloor);
}

// ---- The keyboard ----------------------------------------------------------

// Callback token namespaces, kept beside the builders so the parser and the renderer
// can never disagree about the wire format (the ./offer-tail precedent).
export const TUNE_EXPAND_PREFIX = "tune";
export const TUNE_COLLAPSE_PREFIX = "tunec";
export const TUNE_TOGGLE_PREFIX = "tunet";

export function tuneExpandToken(profileId: number, date: string): string {
  return `${TUNE_EXPAND_PREFIX}:${profileId}:${date}`;
}

export function tuneCollapseToken(profileId: number, date: string): string {
  return `${TUNE_COLLAPSE_PREFIX}:${profileId}:${date}`;
}

export function tuneToggleToken(
  profileId: number,
  date: string,
  category: DigestCategory
): string {
  return `${TUNE_TOGGLE_PREFIX}:${profileId}:${date}:${category}`;
}

// The COLLAPSED control: one button, zero keyboard cost until used. It rides the
// digest itself — the escape hatch belongs on the surface that annoys you, not on a
// settings page you visit later (#1505's Take/Skip/Demote precedent).
export function collapsedTuneAction(
  profileId: number,
  date: string
): NotificationAction {
  return {
    label: "⚙️ Tune",
    data: tuneExpandToken(profileId, date),
    row: "digest-tune",
  };
}

// How many category buttons share one keyboard row. Two keeps every label readable on
// a phone; the ▲ Done button always gets its own row.
//
// SIZE. The set is 11 categories (#1797's widening, plus #2379's nutrition), so the
// largest keyboard this can produce is 6 rows + Done = 12 buttons — well inside
// Telegram's 100-button cap, which
// `capTelegramKeyboard` enforces for every keyboard anyway (whole leading rows kept, so
// a pair is never split). Nothing extra is needed here, and the practical keyboard is
// smaller still: `tunableCategoriesFor` offers only the categories in TODAY's message
// plus anything already demoted.
const TUNE_ROW_WIDTH = 2;

// The EXPANDED control: one toggle per category, then ▲ Done.
//
// THE ICON IS THE STATE, not the action: 🔔 = this category is in every digest, 🔕 =
// demoted to notable-only. A tap flips it and the keyboard re-renders showing the new
// state, so the control always answers "what am I set to now?" rather than "what will
// this button do?". The tap's answer text says the consequence in words, so neither
// reading of the icon can mislead.
export function expandedTuneActions(
  profileId: number,
  date: string,
  categories: readonly DigestCategory[],
  demoted: readonly DigestCategory[]
): NotificationAction[] {
  const shown = DIGEST_TUNABLE_CATEGORIES.filter((c) => categories.includes(c));
  const actions: NotificationAction[] = shown.map((c, i) => ({
    label: `${demoted.includes(c) ? "🔕" : "🔔"} ${DIGEST_CATEGORY_SHORT[c]}`,
    data: tuneToggleToken(profileId, date, c),
    row: `tune-${Math.floor(i / TUNE_ROW_WIDTH)}`,
  }));
  actions.push({
    label: "▲ Done",
    data: tuneCollapseToken(profileId, date),
    row: "digest-tune",
  });
  return actions;
}

// What the Tune keyboard OFFERS: the categories present in today's message, plus any
// this reader has already demoted. The second half is what makes the control
// reversible on Telegram — a demoted category that produced nothing today would
// otherwise disappear from its own toggle and could only be restored in Settings.
export function tunableCategoriesFor(
  present: readonly DigestCategory[],
  demoted: readonly DigestCategory[]
): DigestCategory[] {
  const set = new Set<DigestCategory>([...present, ...demoted]);
  return DIGEST_TUNABLE_CATEGORIES.filter((c) => set.has(c));
}

// The callback answer text. It states the CONSEQUENCE — including what still gets
// through — because "demote" and "mute" are one tap apart and only one of them is
// what this control does.
export function tuneToggleAnswer(
  category: DigestCategory,
  demoted: boolean
): string {
  const name = DIGEST_CATEGORY_LABELS[category];
  return demoted
    ? `${name}: notable only. ${DIGEST_CATEGORY_NOTABLE[category]}`
    : `${name}: back in every digest.`;
}
