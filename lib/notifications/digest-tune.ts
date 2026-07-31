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
//                       still passes.
//
// Each predicate is the classification the line ALREADY computes (#221). Demotion
// never invents a second threshold, and it never reaches the safety floor: in
// applyRecentChangeDemotion `flagged` implies notable, so a flagged lab or an
// out-of-range vital survives every preference. That is the doctrine line this
// module exists to hold — a preference filter reduces ROUTINE contact and can never
// override a safety floor (docs/internals/findings.md).
//
// WHAT IS NOT TUNABLE, and why.
//   • `labs` — the digest's collector already excludes it (the flagged-lab lines come
//     from the digest's own send cursor), and every lab line it would carry is
//     `flagged`, i.e. floor class. A toggle that provably changes nothing is a lie.
//   • the offer tail, the Today obligations and the minimal-digest guarantee (#1505)
//     — they are the MESSAGE's job, not a category. Demoting everything still leaves
//     the digest's non-demotable core; the message can get short, never vanish.
//   • `activities` — named in the design's examples, deliberately deferred: its
//     notable predicate ("a PR") does not exist on the digest's activity line today,
//     and minting one here would be exactly the "second threshold" the design forbids.
//     It joins the set the day the classification does.

import {
  RECENT_CHANGE_CATEGORIES,
  type RecentChangeCategory,
} from "../recent-changes";
import { sleepVerdict } from "../sleep-summary";
import type { NotificationAction } from "./types";

// A category the digest's ⚙️ Tune control can demote. Seven come from the
// recent-changes collector (everything it collects except `labs`); `sleep` is the
// digest's OWN section, tuned by the same control because a reader does not think in
// terms of which module produced the line.
export type DigestCategory = Exclude<RecentChangeCategory, "labs"> | "sleep";

// Declaration order = the order the Tune keyboard and the Settings mirror list them.
// Derived from the collector's own list so a new collector category cannot silently
// become untunable.
export const DIGEST_TUNABLE_CATEGORIES: readonly DigestCategory[] = [
  ...RECENT_CHANGE_CATEGORIES.filter(
    (c): c is Exclude<RecentChangeCategory, "labs"> => c !== "labs"
  ),
  "sleep",
];

const TUNABLE = new Set<string>(DIGEST_TUNABLE_CATEGORIES);

export function isDigestCategory(value: unknown): value is DigestCategory {
  return typeof value === "string" && TUNABLE.has(value);
}

// The button/row label for a category.
export const DIGEST_CATEGORY_LABELS: Record<DigestCategory, string> = {
  visits: "Visits",
  growth: "Growth",
  intake: "Supplements & meds",
  vitals: "Vitals",
  symptoms: "Symptoms",
  mood: "Check-in",
  data: "Data arrival",
  sleep: "Sleep",
};

// What SURVIVES a demotion, stated in the reader's words. The Settings mirror renders
// it beside each row so "demote" can never be mistaken for "mute" — and so someone
// auditing why their digest looks thin can see exactly what is still guaranteed.
export const DIGEST_CATEGORY_NOTABLE: Record<DigestCategory, string> = {
  visits: "Appointments still appear on Upcoming.",
  growth: "A percentile-band crossing still ranks above routine lines.",
  intake: "Dose reminders and refill nudges are unaffected.",
  vitals: "An out-of-range reading still appears.",
  symptoms: "A severe symptom day still appears.",
  mood: "A shift from your recent average still appears.",
  data: "Sync failures still surface on Data → Review.",
  sleep: "A notably short or long night still appears.",
};

// Short button labels — a Telegram inline button has ~30 usable characters beside an
// icon, so the keyboard uses these rather than the Settings labels.
export const DIGEST_CATEGORY_SHORT: Record<DigestCategory, string> = {
  visits: "Visits",
  growth: "Growth",
  intake: "Supplements",
  vitals: "Vitals",
  symptoms: "Symptoms",
  mood: "Check-in",
  data: "Data",
  sleep: "Sleep",
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

// The subset the recent-changes collector understands (`sleep` is the digest's own
// section and is applied there instead).
export function recentChangeDemotions(
  cats: readonly DigestCategory[]
): RecentChangeCategory[] {
  return cats.filter(
    (c): c is Exclude<DigestCategory, "sleep"> => c !== "sleep"
  );
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
