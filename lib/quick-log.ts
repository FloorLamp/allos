// The mobile top bar's contextual primary action + the quick-log sheet's menu
// (issue #1416, sections B and E).
//
// The phone bar used to carry ONE hard-coded create action — "log activity" —
// so logging food, a dose, or a weight meant a full nav through the drawer even
// while standing on the very page that owns that form. This module is the pure
// registry behind both halves of the fix:
//
//   * `primaryQuickLog(pathname, tab)` — the route → primary-action map. The
//     bar's **+** does the CURRENT page's obvious thing, falling back to the
//     historical "log activity" everywhere else (so nothing regresses on the ~60
//     routes with no opinion).
//   * `QUICK_LOG_ITEMS` — the caret-opened sheet's full menu, so the actions the
//     current route DOESN'T promote are still one tap away.
//
// No new write paths: every entry opens an EXISTING form — the shared activity
// editor through the ActivityEditor context (the same `openCreate` the bar
// always called), or one of the existing quick-add form components mounted in
// the shared quick-entry overlay (components/QuickEntryProvider.tsx). The target
// union is deliberately the palette's own `PaletteActionTarget` shape — the
// palette and the bar are two surfaces over the same idea, and a third divergent
// "how do I open a create form" encoding is how surfaces drift.
//
// **Navigation is not a quick-log outcome (issue #1468, owner direction).** The
// sheet used to be two-tier: activity opened in place while food/dose/weight
// were `{kind:"navigate"}` `router.push`es, so a sheet that promises "log from
// anywhere" dumped you on the Nutrition page mid-morning-check. Every SHEET item
// is now an overlay target — the whole point of a quick logger is returning you
// to where you were. `{kind:"navigate"}` stays in the union because the
// CommandPalette shares it and the desktop keyboard flow may keep navigating in
// v1 (deliberately a separate decision); the sheet ships zero navigate items,
// and `lib/__tests__/quick-log.test.ts` pins that.

import type { AppRoute } from "./hrefs";
import { MEDICATIONS_HREF } from "./hrefs";
import {
  arguedExclusion,
  type ArguedExclusion,
  type LoggableDomain,
} from "./loggable-domains";
import type { MeasurementGroup } from "./measurements-deeplink";
import { DEFAULT_TRENDS_TAB, parseTab } from "./trends-tabs";

// Icon keys resolved to real Tabler icons in components/QuickLogSheet.tsx (the
// registry stays pure/serializable, like PALETTE_ACTIONS).
export type QuickLogIcon =
  | "barbell"
  | "salad"
  | "pill"
  | "scale"
  | "heartbeat"
  | "sparkles"
  | "droplet"
  | "mood"
  | "document";

// Which existing form the shared quick-entry overlay mounts (issue #1468). The
// overlay host owns the form→component map; this stays a serializable key so the
// registry is pure. `dose` is the today's-due-doses list whose confirm buttons
// answer from the typed DoseTakenOutcome — the existing action, reached, never
// re-implemented.
// `practice` is the tracked wellness practices with the SAME one-tap LogPracticeButton
// the Wellness card carries (#1633); `document` mounts the SAME UploadForm Data → File
// upload renders, camera input included (#1525).
// `cycle` is the ONE period offer (#1892) — the overlay renders the SAME
// `cycleControlState` the Cycle page control and the dashboard phase widget render,
// gathered on open so a sheet opened this morning cannot offer yesterday's verb.
// `mood` is the daily check-in's face row + backfill day chips (#2130/#2128) —
// the SAME MoodValencePicker and `logMood` action the dashboard card runs, in a
// second mounting context.
export type QuickEntryForm =
  "food" | "measurements" | "dose" | "practice" | "cycle" | "mood" | "document";

// What the CALLER's context implies about the form it opens (#2014): the vitals
// card's "Log reading" opens Vitals, a palette pick named "Log weight" opens the
// weight group (#2184), the Nutrition page's promoted food row lands on its
// group. A context-free open (the sheet's rows) passes nothing and the form
// falls back to its own memory/default. Lives HERE — beside the form vocabulary —
// because both quick-entry surfaces (the sheet's overlay host and the palette's
// registry) speak it; components/QuickEntryProvider.tsx re-exports it for its
// callers.
export interface QuickEntryPrefill {
  foodGroup?: string;
  measurementGroup?: MeasurementGroup;
}

export type QuickLogTarget =
  // Open the shared activity editor in place (the DOCK — a live workout is a
  // SESSION lifecycle, not a transactional one, so it deliberately stays off the
  // bottom sheet; see the #1428 decision rule).
  | { kind: "activity" }
  // Open the existing form in the shared quick-entry overlay, in place.
  | { kind: "overlay"; form: QuickEntryForm }
  // Navigate to the existing create surface. Retained for the CommandPalette;
  // NO sheet item uses it (#1468).
  | { kind: "navigate"; href: AppRoute };

// ---- THE TIME-SEMANTIC DECLARATION (issue #2019 §7) ----
//
// Two features needed eating time and both routed around the food ledger, because
// nothing in the app said what a one-tap log's TIME means. Every entry now answers that
// question up front, and `lib/__tests__/quick-log.test.ts` fails a new entry that does
// not — the same completeness discipline `RECONCILE_PREFIXES` applies to buttons and
// `KIND_REISSUE` to message kinds.
//
//   • `instant`  — the log carries a real moment and some consumer reads it. A ONE-TAP
//                  instant additionally needs a correction affordance whose UNIT matches
//                  that consumer's tolerance; an instant the FORM asks for is stated
//                  right the first time and has nothing to correct afterwards.
//   • `day-only` — the log is about a DAY. This is not a gap and it is not laziness:
//                  capturing precision nothing consumes is how a later reader comes to
//                  invent a meaning for it.
//
// ADMISSION TEST FOR `instant`, all three required: (1) some consumer reads the instant;
// (2) the tap contract is "this is happening now"; (3) the correction unit matches the
// consumer's tolerance. Failing any one of them means `day-only` with the reason written
// down, so "we decided against it" and "nobody looked" stay distinguishable. (2) and (3)
// are about a TAP: an entry that opens a form STATING the time answers both by asking,
// and declares `correctionUnit: "none"` rather than naming a correction it does not have.
export type QuickLogTimeSemantic = "instant" | "day-only";

// How an `instant` entry's time gets corrected — required for one, so the third leg of
// the admission test is answered out loud rather than left to a reader's guess (the
// METRIC_KNOWLEDGE discipline: an explicit `none`, with the reason beside it).
//
//   • "hour" — the CONSUMER reads hours, so an hour is the unit a correction has to be
//              able to move. The unit names that grain; it does not name a widget.
//              Example mechanisms: the correction chips of lib/correction-time.ts
//              (food, dose), and the practice session's own dated edit form (#2204).
//              Those chips reach half an hour at the small end since #2206 and the
//              picker stays hourly; the unit still names the TOLERANCE the admission
//              test asked about, which is the hour.
//   • "day"  — corrected a DAY at a time, through the dated form that owns the
//              exception (a period start that actually began yesterday).
//   • "none" — the form STATES the time on entry, so there is no correction affordance
//              at all. It was `"hour"` on the activity and measurements entries until
//              #2062, whose own `why` text said in the same breath that no chip exists
//              for them — an unenforced field is still documentation, and it read as a
//              promise of a correction UI those two forms have never had.
export type QuickLogCorrectionUnit = "hour" | "day" | "none";

export interface QuickLogTime {
  semantic: QuickLogTimeSemantic;
  // Required in BOTH directions. For `instant`, WHICH consumer reads it and at what
  // grain; for `day-only`, why an instant would be precision nothing consumes.
  why: string;
  // How an `instant` entry is corrected (required for one). A `day-only` entry leaves it
  // unset: there is no instant to correct.
  correctionUnit?: QuickLogCorrectionUnit;
}

// The sheet's id vocabulary, const-asserted so the domain census below can be
// checked at the type level (#2130): an entry's `id` must come from here, and a
// census row naming a retired id fails `tsc`. (`lib/__tests__/quick-log.test.ts`
// pins the reverse — every id here is carried by exactly one entry.)
export const QUICK_LOG_IDS = [
  "log-activity",
  "log-food",
  "log-dose",
  "log-measurements",
  "log-practice",
  "log-mood",
  "log-period",
  "add-document",
] as const;

export type QuickLogId = (typeof QUICK_LOG_IDS)[number];

export interface QuickLogItem {
  id: QuickLogId;
  // The bar button's accessible name AND the sheet row's label — one string, so
  // "the + on Nutrition" and "Log food in the sheet" can never disagree.
  label: string;
  // One-line "what this opens", shown in the sheet only.
  hint: string;
  icon: QuickLogIcon;
  target: QuickLogTarget;
  // What this entry's TIME means (#2019 §7). Required — see QuickLogTime.
  time: QuickLogTime;
  // True for the entries only a training-capable profile should see. An
  // age-restricted profile (lib/age-gate.ts) has no training surface at all, so
  // the bar hides its create actions entirely there — same posture as today.
  training?: boolean;
  // True for the entries only a CYCLE-RELEVANT profile should see (#1892). Gated on
  // the SAME `cycle` relevance bit as the Cycle nav entry and the dashboard phase
  // widget (lib/nav-relevance.cycleTrackingRelevant), so a period row can never leak
  // into the sheet of a profile the whole domain does not apply to.
  cycle?: boolean;
}

export const LOG_ACTIVITY_ID = "log-activity";

// The sheet's menu, in tap order. Activity leads (it is the fallback primary and
// the most-used), then the three the bar can promote contextually.
export const QUICK_LOG_ITEMS: QuickLogItem[] = [
  {
    id: LOG_ACTIVITY_ID,
    label: "Log activity",
    hint: "Strength, cardio, or sport",
    icon: "barbell",
    target: { kind: "activity" },
    time: {
      semantic: "instant",
      why: "A session already carries start and end instants, and the whole training model reads them — duration, the live-session presence, the post-workout dose window. It is not a one-TAP log at all: the editor asks for the times, so there is nothing to correct afterwards.",
      correctionUnit: "none",
    },
    training: true,
  },
  {
    id: "log-food",
    label: "Log food",
    hint: "Today's servings by food group",
    icon: "salad",
    // The SAME FoodLogBar the Nutrition → Food tab renders, mounted in the
    // overlay — one component, two mounting contexts.
    target: { kind: "overlay", form: "food" },
    time: {
      semantic: "instant",
      why: "#2019: `eaten_at` is read by eating-window length and protein distribution, both of which tolerate about half an hour, and the Telegram button's contract is 'I am eating now'. Corrected in hour chips. The WEB bar states a time or leaves it null — it never defaults to now, because a backfill has no instant to offer.",
      correctionUnit: "hour",
    },
  },
  {
    id: "log-dose",
    label: "Log dose",
    hint: "Confirm a scheduled or as-needed dose",
    icon: "pill",
    // Today's due doses with the existing confirm control (markDoseTaken, whose
    // typed DoseTakenOutcome the buttons answer from) — reached, never
    // re-implemented.
    target: { kind: "overlay", form: "dose" },
    time: {
      semantic: "instant",
      why: "#2020: `given_at` arms the PRN redose window and keys the phantom-dose proximity guard — the safety-relevant instant in the app. Hour chips, because redose intervals are measured in hours.",
      correctionUnit: "hour",
    },
  },
  {
    id: "log-measurements",
    label: "Log measurements",
    hint: "Weight, blood pressure, oxygen, sleep",
    icon: "scale",
    // ONE row, not two (issue #1506). The sheet used to carry "Log weight" and
    // "Log vitals" side by side because the app had two forms on two Trends tabs.
    // #1486 merged those into a single "Log measurements" form, so a second row
    // would just be a second door onto the same fields — the exact duplication the
    // shared-content rule exists to prevent. Same MeasurementsQuickAdd component
    // the Body tab's desktop expander mounts; only the mount changes.
    target: { kind: "overlay", form: "measurements" },
    time: {
      semantic: "instant",
      why: "A reading time is part of the reading and the form ASKS for it — body temperature has carried one since #800/#843, and morning-vs-evening weight is a real difference. Stated on entry rather than corrected afterwards, so no correction affordance exists.",
      correctionUnit: "none",
    },
  },
  {
    id: "log-practice",
    label: "Log practice",
    hint: "Sauna, meditation, or another tracked practice",
    icon: "sparkles",
    // One-tap practice logging, which the Telegram bot has had since #1259 while the web
    // app made you find /wellness first (#1633). The overlay mounts the SAME
    // LogPracticeButton the Wellness card renders over the same logPractice action — no
    // second write path, and the sheet lists exactly the practices you track.
    target: { kind: "overlay", form: "practice" },
    time: {
      // REWRITTEN by #2204, because the old declaration became factually wrong the
      // moment `practice_logs.time` acquired a reader. It said "nothing reads when in
      // the day it happened, so capturing an instant would be precision with no
      // consumer" — correct when written, and the admission test it was failing is
      // leg 1 (a consumer). #2202 supplied one, so the entry has to state the new
      // meaning rather than inherit the old words: that is the whole point of this
      // file (#2019 §7).
      semantic: "instant",
      why: "#2202: `lib/weekly-rhythm.ts` reads practice_logs.time — modalHour() picks each practice's typical session hour from its logged times, which is what schedules the retimed pace nudge and what the cards' rhythm note is inferred from. A one-tap log is a statement that the session is happening now, so the write core stamps the profile-local tap instant (#450 — the server's zone, never the device's); the expanded form's own time input still wins, and an explicitly emptied one still means no instant.",
      // The MECHANISM, named: the session's own dated edit form, on the Wellness card's
      // history table and the protocol detail's, which owns date and time together
      // (`editPracticeSession` → `updatePracticeSession`). The UNIT is "hour" because
      // that is the grain the consumer reads — modalHour buckets by hour — not because
      // this entry borrows the food/dose chips, which it does not. This is not #2062's
      // case in reverse: that ruling retired a declared correction affordance that did
      // not EXIST, and this one does.
      correctionUnit: "hour",
    },
  },
  {
    id: "log-mood",
    label: "Log mood",
    hint: "How are you — today or an earlier day",
    icon: "mood",
    // #2130: mood and symptom were the two remaining daily-loop one-tap logs —
    // each with its own Telegram command, reminder and offline flow — and #1892's
    // membership argument ("#1506's charter is exactly 'logging actions'")
    // reaches them both. Mood joins here; symptom's exclusion is argued in the
    // domain census below. The overlay mounts the SAME MoodValencePicker over the
    // SAME `logMood` action the dashboard card runs — one write core, a second
    // mounting context — with the #2128 backfill chips choosing the day.
    target: { kind: "overlay", form: "mood" },
    time: {
      semantic: "day-only",
      why: "A check-in is about a DAY — the store upserts on UNIQUE(profile_id, date) and nothing reads an instant. The #2128 backfill chips choose WHICH day before the write, which is a statement, not a correction.",
    },
  },
  {
    id: "log-period",
    label: "Log period",
    hint: "Start or end today's period",
    icon: "droplet",
    // #1892 — the missing quick-log path. #1506's charter is exactly "logging
    // actions", and period day 1 is the app's most time-sensitive one: both the phase
    // derivation and the regularity data depend on catching it.
    //
    // The ROW names the domain; the VERB lives one tap in, on the offer button the
    // overlay renders from the freshly-gathered `cycleControlState` — the same state,
    // and the same <PeriodOfferButton>, the Cycle page control and the dashboard
    // widget render. It is deliberately not a dynamic row label: that would need a
    // LAYOUT-TIME snapshot of the state on every one of ~60 routes, and a snapshot is
    // exactly as stale as the page (the #1468 reason the overlay gathers on open).
    target: { kind: "overlay", form: "cycle" },
    time: {
      semantic: "instant",
      why: "A period start is DAY-granular but genuinely correctable — 'it started yesterday' is the common case, and the #1892 duration sanity checks judge the corrected date. So the semantic is instant with a DAY unit, and the correction flows through the stateful write core rather than around it.",
      correctionUnit: "day",
    },
    cycle: true,
  },
  {
    id: "add-document",
    label: "Add document",
    hint: "Lab report, visit summary, or a photo of one",
    icon: "document",
    // The other thing people do on a phone: FILE something (#1525). The in-app twin of
    // the #1423 share target — the same UploadForm Data → File upload renders, so the
    // same ingest engine, size/type gates, per-profile storage and dedup apply, and the
    // camera input (`capture="environment"`) comes along for free.
    target: { kind: "overlay", form: "document" },
    time: {
      semantic: "day-only",
      why: "A document's meaningful date is the one PRINTED ON IT, which extraction reads from the document itself; when you happened to upload it is filing metadata that nothing clinical consumes.",
    },
  },
];

export function quickLogItem(id: string): QuickLogItem {
  return (
    QUICK_LOG_ITEMS.find((i) => i.id === id) ??
    QUICK_LOG_ITEMS.find((i) => i.id === LOG_ACTIVITY_ID)!
  );
}

// Does `pathname` sit under `route`? Exact match or a child segment — never a
// prefix-string match, so `/medications-archive` can't claim `/medications`.
function under(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

// The route → primary-action rule. `tab` is the page's `?tab=` value (the app's
// tabbed surfaces are URL-driven), passed in by the caller rather than read here
// so this stays a pure function of its inputs.
//
// Deliberately SHORT: an entry earns its place only when the page has one
// obvious primary log. Everything else falls back to "Log activity" — the bar's
// behavior before this issue — so an unlisted route is never a regression.
export function primaryQuickLog(
  pathname: string,
  tab?: string | null
): QuickLogItem {
  // Nutrition promotes food on BOTH tabs: the Supplements tab's own add form is
  // right there on screen, so spending the bar's one slot on it buys nothing,
  // while food logging is what people reach the phone for.
  if (under(pathname, "/nutrition")) return quickLogItem("log-food");
  if (under(pathname, MEDICATIONS_HREF)) return quickLogItem("log-dose");
  // Body metrics live in the Trends body census, which #1644 moved onto the DEFAULT
  // (Overview) tab — so the rule is still a tab rule, it just names a different
  // tab: `?tab=body` is gone, and the census now rides the view a paramless /trends
  // shows. Resolved through parseTab so a retired `?tab=body`/`?tab=vitals` link
  // (which lands on that same default) gets the same answer, and so a Fitness or
  // Nutrition tab still falls through to "log activity". (#1486 folded the former
  // Vitals tab into this census, so the one form covers both.)
  if (
    under(pathname, "/trends") &&
    parseTab(tab ?? undefined) === DEFAULT_TRENDS_TAB
  ) {
    return quickLogItem("log-measurements");
  }
  return quickLogItem(LOG_ACTIVITY_ID);
}

// The bar shows the activity-specific shortcut — since #1509 that is the
// live-workout button ALONE (the ⟳ repeat-last twin left the bar; repeat-last
// keeps exactly two homes, the command palette and the Journal card's ⋯ menu) —
// ONLY where the primary action is itself the activity editor. On Nutrition or
// Medications it would be noise competing for a 390px-wide bar.
export function showsActivityShortcuts(primary: QuickLogItem): boolean {
  return primary.target.kind === "activity";
}

// The sheet's menu for a given profile. Two per-entry gates, both mirroring a gate the
// app already applies elsewhere:
//
//   • `restricted` — an age-restricted profile has no training surface, so the
//     training-only entries drop (the gate the bar's create actions have always
//     carried).
//   • `cycleRelevant` — the #1042 `cycle` relevance bit, the SAME one gating the Cycle
//     nav entry and the dashboard phase widget (#1892). Defaults TRUE for the same
//     reason DEFAULT_NAV_RELEVANCE does: a caller that hasn't threaded the bitset must
//     never over-hide. The overlay re-checks it server-side, so a deep link cannot
//     reach the offer on a profile the domain does not apply to either.
export function quickLogMenu(
  restricted: boolean,
  cycleRelevant = true
): QuickLogItem[] {
  return QUICK_LOG_ITEMS.filter(
    (i) => !(i.training && restricted) && !(i.cycle && !cycleRelevant)
  );
}

// ── THE DOMAIN CENSUS (#2130) ────────────────────────────────────────────────
//
// The sheet's menu was a membership list with no membership rule: #1892 argued
// the period row IN on grounds that reached mood and symptom too, and nothing
// recorded that they were never argued against them. This record is the
// declare-or-argue fix, type-checked because both sides are const-asserted
// (#2130 owner direction): every loggable domain maps to the sheet entry that
// serves it or to an `arguedExclusion(...)` whose reason is structurally
// required. A new `LoggableDomain` fails `tsc` here until someone decides.
//
// Proven on the defect: on the pre-#2130 tree this record has no honest value
// for `mood` or `symptom` — the audit's exact quick-log gaps — and deleting
// either row fails typecheck with "Property '<domain>' is missing".
export const QUICK_LOG_DOMAIN_CENSUS = {
  activity: "log-activity",
  food: "log-food",
  dose: "log-dose",
  // #1486/#1506: one measurements form is the sheet's single door to all three.
  weight: "log-measurements",
  vitals: "log-measurements",
  temperature: "log-measurements",
  practice: "log-practice",
  period: "log-period",
  mood: "log-mood",
  symptom: arguedExclusion(
    "Symptom logging is a state-routed PAIR, not one form: on a well day it is the #1300 quick bar behind the check-in card's reveal, and during an illness episode the hero cockpit owns it (#858 — one lifecycle, one door). A context-free sheet row would need the episode gather just to pick a form, and #1860 is actively reshaping that capture; membership waits on it rather than freezing one of the two halves here."
  ),
  substance: arguedExclusion(
    "Deliberate-access surface by doctrine: substance-use logging lives under Medical → Substance use with its #998 cap verdict rendered beside the tap, and the findings reach policy keeps it off general-purpose quick surfaces. A sheet row would detach the tap from the cap context that makes it honest."
  ),
  document: "add-document",
} as const satisfies Record<LoggableDomain, QuickLogId | ArguedExclusion>;
