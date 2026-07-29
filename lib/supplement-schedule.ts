// Pure scheduling helpers for supplements (no DB access), shared by the
// supplements page, the dashboard widget, and any future notifier. Keeping the
// "is this due today?" / time-bucket / priority logic here (not inline in the
// page) means an alerting layer can reuse it directly.

import type {
  FoodTiming,
  Supplement,
  SupplementCondition,
  IntakeObligation,
} from "./types";

export type TimeBucket =
  "Morning" | "Midday" | "Evening" | "Before sleep" | "Anytime";

export const TIME_BUCKETS: TimeBucket[] = [
  "Morning",
  "Midday",
  "Evening",
  "Before sleep",
  "Anytime",
];

export const TIME_BUCKET_LABELS: Record<TimeBucket, string> = {
  Morning: "Morning",
  Midday: "Midday",
  Evening: "Evening",
  "Before sleep": "Bedtime",
  Anytime: "Anytime",
};

// Normalize a free-text time_of_day into one of the buckets. Existing free-text
// values ("with dinner", "post-workout", "am") map at render time, so no data
// migration is needed.
export function timeBucket(timeOfDay: string | null): TimeBucket {
  const t = (timeOfDay || "").toLowerCase();
  if (/\b(morning|am|breakfast|wake|sunrise|early)\b/.test(t)) return "Morning";
  if (/\b(noon|lunch|midday|afternoon)\b/.test(t)) return "Midday";
  if (/\b(before\s+sleep|bed(?:time)?|sleep|overnight)\b/.test(t))
    return "Before sleep";
  if (/\b(evening|night|dinner|dusk|pm|supper)\b/.test(t)) return "Evening";
  return "Anytime";
}

// The time bucket the given wall clock (HH:MM) currently falls into (issue #852
// item 1), so the Today panel can tell a PAST-bucket dose (the 8am dose seen at 6pm)
// from an upcoming one. The clock ranges approximate the free-text buckets timeBucket()
// maps WORDS to: Morning < 11:00, Midday < 15:00, Evening < 21:00, else Before sleep.
// It never returns "Anytime" — a clock always has a position — so a timeless "Anytime"
// dose (bucket rank 4, above every clock bucket) is never judged past-due.
export function currentTimeBucket(hhmm: string): TimeBucket {
  const [h, m] = hhmm.split(":");
  const mins = (Number(h) || 0) * 60 + (Number(m) || 0);
  if (mins < 11 * 60) return "Morning";
  if (mins < 15 * 60) return "Midday";
  if (mins < 21 * 60) return "Evening";
  return "Before sleep";
}

export const CONDITION_LABELS: Record<SupplementCondition, string> = {
  daily: "Daily",
  pre_workout: "Pre-workout",
  post_workout: "Post-workout",
  rest_day: "Rest day",
  situational: "Situational",
};

export const CONDITIONS = Object.keys(
  CONDITION_LABELS
) as SupplementCondition[];

// Conditions whose meaning depends on fitness/training tracking (workout vs rest
// day). They're hidden from the schedule dropdown when training is restricted for
// the profile, mirroring how the Journal/Training surfaces vanish (see age-gate.ts).
export const WORKOUT_CONDITIONS: SupplementCondition[] = [
  "pre_workout",
  "post_workout",
  "rest_day",
];

// Conditions offered in the add/edit form. When training is restricted the
// workout/rest-day options are dropped (meaningless without fitness tracking),
// except one already stored on the item being edited (`keep`), so its select
// value stays valid rather than silently blanking.
export function availableConditions(
  trainingRestricted: boolean,
  keep?: SupplementCondition | null
): SupplementCondition[] {
  if (!trainingRestricted) return CONDITIONS;
  return CONDITIONS.filter(
    (c) => !WORKOUT_CONDITIONS.includes(c) || c === keep
  );
}

// Whether a supplement applies given today's context. An as-needed (PRN)
// medication is never scheduled-due — it's taken on demand, so it generates no
// reminders/escalation/adherence-due and can never be "missed".
//
// Workout-conditioned items key on WHEN the training happens, not only on whether
// a session has already been logged (issue #558):
//   • pre_workout / rest_day consult `predictedWorkoutDay` (from the inferred
//     training cadence) so a "take before your workout" reminder can fire in the
//     morning of a predicted training day, not only AFTER the workout is logged.
//     When the cadence is unknown (`predictedWorkoutDay == null`) they fall back
//     to the logged signal, preserving the old behavior.
//   • post_workout keeps the ACTUAL logged-session gate (post = after), and when
//     the session's end time is known it stays hidden until the session is over
//     (`postWorkoutReady`, default true).
// This only ever gates workout-conditioned items — `daily` (the safety tier for
// scheduled meds) is unconditional, so no ordinary medication reminder becomes
// workout-dependent.
// The INVERSE situational condition (issue #1296): the situation NAME currently
// HOLDING this item, or null. An item is held while its `pause_situation` is in the
// active set — regardless of its `condition` (a `daily` medication paused during
// Pre-surgery is held). "Held" gates SURFACING only (the ledger is untouched, #558),
// so markDoseTaken still accepts a held item (you can log reality); it's this decision
// that keeps it off every due/reminder/digest path. Pure so the badge on the row and
// the dueness engine agree about "what's held" (one computation, #221). NULL
// pause_situation (or an item with no link) is never held.
export function heldBySituation(
  supp: { pause_situation?: string | null },
  activeSituations: ReadonlySet<string>
): string | null {
  return supp.pause_situation != null &&
    activeSituations.has(supp.pause_situation)
    ? supp.pause_situation
    : null;
}

export function isDueOn(
  supp: Pick<Supplement, "condition" | "situation"> & {
    obligation?: IntakeObligation;
    pause_situation?: string | null;
  },
  ctx: {
    isWorkoutDay: boolean;
    activeSituations: Set<string>;
    // Today IS a predicted training day per the inferred cadence; null/undefined
    // when no cadence could be inferred (fall back to the logged signal).
    predictedWorkoutDay?: boolean | null;
    // The logged session's end time has passed (post_workout timing). Default true.
    postWorkoutReady?: boolean;
  }
): boolean {
  // Held BEATS due (issue #1296): a situational hold suppresses the item on every
  // surfacing path before any condition is evaluated — including a `daily` med and a
  // situational-ON item whose on-situation is ALSO active (on-during A, paused-during
  // B → held). The active set is the SAME one the on-condition reads, so a pause
  // situation's active state flows in without a second lookup.
  if (heldBySituation(supp, ctx.activeSituations)) return false;
  // A `may` item has NO DUENESS at all (#1505). This is the single short-circuit that
  // used to be `as_needed`, widened to the obligation level that absorbed it: an item
  // the user owes nothing on cannot be due, so it cannot be missed, cannot be counted
  // in a fraction, and cannot be reminded. Its slot survives as an ACCESS HINT — read
  // by `slotHintCoversNow` and the offer surfaces, never by this function.
  if (supp.obligation === "may") return false;
  // "Is today a training day?" — predicted cadence when known, else logged reality.
  const trainingToday = ctx.predictedWorkoutDay ?? ctx.isWorkoutDay;
  switch (supp.condition) {
    case "daily":
      return true;
    case "pre_workout":
      return trainingToday;
    case "post_workout":
      // Post-workout stays gated on an actually-logged session, timed after it.
      return ctx.isWorkoutDay && (ctx.postWorkoutReady ?? true);
    case "rest_day":
      return !trainingToday;
    case "situational":
      return supp.situation != null && ctx.activeSituations.has(supp.situation);
    default:
      return true;
  }
}

// The count of situational intake items currently due BECAUSE their situation is
// active (issue #662 item 1). It reuses the SAME dueness computation the dose list
// and Upcoming use — isDueOn's `situational` branch — so the situations-bar
// activation acknowledgment can never disagree with the list it's acknowledging (a
// formatter over the shared count, never a second count). Counts active, non-`may`
// situational items; a paused item (active 0) is excluded.
export function countSituationalDue(
  supps: readonly (Pick<Supplement, "condition" | "situation"> & {
    active?: number | boolean;
    obligation?: IntakeObligation;
  })[],
  ctx: Parameters<typeof isDueOn>[1]
): number {
  return supps.filter(
    (s) =>
      (s.active ?? true) && s.condition === "situational" && isDueOn(s, ctx)
  ).length;
}

// One item HELD by an active pause situation (issue #1296) — the row's item plus the
// situation NAME doing the holding. `heldItemsBy` groups them so the visible held
// state (the "Held — Pre-surgery active" badge, the digest "N items held" count, the
// resume acknowledgment) all read ONE computation and can never disagree (#221). Only
// ACTIVE items are considered — a manually-paused item (active 0) is already off every
// surface, so surfacing it as "held" would be misleading. PRN items count: a PRN med a
// surgeon says to stop IS meaningfully held even though it's never scheduled-due.
export interface HeldItem<T> {
  item: T;
  situation: string;
}

export function heldItemsBy<
  T extends { active?: number | boolean; pause_situation?: string | null },
>(items: readonly T[], activeSituations: ReadonlySet<string>): HeldItem<T>[] {
  const out: HeldItem<T>[] = [];
  for (const item of items) {
    if (!(item.active ?? true)) continue;
    const situation = heldBySituation(item, activeSituations);
    if (situation) out.push({ item, situation });
  }
  return out;
}

// The count of active items a given (or any) situation is holding. Pure formatter
// source for the digest line and the badge summary.
export function countHeldItems<
  T extends { active?: number | boolean; pause_situation?: string | null },
>(items: readonly T[], activeSituations: ReadonlySet<string>): number {
  return heldItemsBy(items, activeSituations).length;
}

// The one-line "N items held by <situation>" summary (issue #1296) — the visible,
// discoverable held state so a forgotten-active pause situation is never a silent
// reminder blackout. Null when nothing is held. Pure.
export function heldSummaryLine(
  count: number,
  situation: string
): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "item" : "items"} held by ${situation}`;
}

// The deactivation reconcile ACKNOWLEDGMENT (issue #1296): when a pause situation
// clears, the same acknowledgment pattern as episode-med-reconcile — "Pre-surgery
// cleared — N items resume today." Resumption is AUTOMATIC (the hold is gone the moment
// the situation deactivates), so this is an acknowledgment, not a decision. Null when
// the situation held nothing (nothing to acknowledge). Pure.
export function heldResumeAcknowledgment(
  situation: string,
  resumingCount: number
): string | null {
  if (resumingCount <= 0) return null;
  const items = resumingCount === 1 ? "item resumes" : "items resume";
  return `${situation} cleared — ${resumingCount} ${items} today`;
}

// Whether linking a pause situation to this item warrants a CONFIRM at link time
// (issue #1296): a situational hold on a MEDICATION or a `must` item will silence its
// reminders while the situation is active, so the form asks first ("this will silence
// reminders for X while Y is active — sure?"). An ordinary supplement paused during a
// fasting day needs no confirm. Pure predicate so the form and any test agree on which
// links are consented. (Kind still appears here because a pause is a CLINICAL-identity
// question — silencing a medication is worth asking about whatever its obligation —
// which is exactly the job #1505 left kind holding.)
export function pauseLinkNeedsConfirm(
  item: Pick<Supplement, "kind" | "obligation">
): boolean {
  return item.kind === "medication" || item.obligation === "must";
}

// Whether an item's dose amounts count toward the DAILY Tolerable Upper Intake
// Level (UL) / RDA sum (issue #635). The UL is a chronic *daily* threshold, so only
// an item taken EVERY day contributes its full amount each day. A `may` item (which
// absorbed PRN, #1505) is taken on demand — never a standing daily intake (mirroring isDueOn's PRN
// short-circuit) — and a pre_workout / post_workout / rest_day / situational item
// applies only on some days; counting either as a full daily dose overstates the
// daily total and produces a standing false "above upper limit" (care-tier) alarm.
// Conservatively, only an unconditional `daily` item contributes — the safe choice
// for a care-tier gather where a false positive is worse than a missed occasional
// exceedance.
export function contributesToDailyLimit(
  item: Pick<Supplement, "condition"> & { obligation?: IntakeObligation }
): boolean {
  if (item.obligation === "may") return false;
  return item.condition === "daily";
}

// Parse an "HH:MM" / "HH:MM:SS" wall-clock time to minutes-since-midnight, or null.
function timeToMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// Whether a post_workout supplement's window has opened on a day with logged
// activity (issue #558). `nowMinutes` is the current profile-local minute-of-day;
// pass null for a past day (always ready). Ready once the EARLIEST logged session
// whose end time is known has ended; when no session carries an end time, ready as
// soon as any activity is logged (the reminder can't be timed, so it isn't held).
export function isPostWorkoutReady(
  endTimes: (string | null | undefined)[],
  nowMinutes: number | null
): boolean {
  if (nowMinutes == null) return true; // a past day — the session is over
  const ends = endTimes
    .map(timeToMinutes)
    .filter((m): m is number => m != null);
  if (ends.length === 0) return true; // no timing available — don't hold it
  return nowMinutes >= Math.min(...ends);
}

// The /medicine header's workout/rest-day label (#747). Three distinct states,
// keyed on the inferred-cadence prediction (`boolean | null`) and whether a
// session was actually logged today:
//   - a predicted training day             → "Workout day"
//   - a predicted REST day with a workout   → "Rest day — unplanned workout logged"
//     logged anyway (cadence says rest, but the user trained): the plain "Rest
//     day" contradicted a due post-workout supplement sitting right below it, so
//     the label names the mismatch. DUENESS is unchanged — the engine stays
//     conservative (post_workout still gates on a logged session); only the
//     header wording distinguishes this case.
//   - otherwise                             → "Rest day" (or, with no cadence yet,
//     the logged-session fallback the old `predictedWorkoutDay ?? isWorkoutDay`
//     used: a logged workout on a cadence-less day still reads "Workout day").
// Pure so the label has one definition and the three states are unit-pinned.
export type WorkoutDayLabel =
  "Workout day" | "Rest day" | "Rest day — unplanned workout logged";

export function workoutDaySubtitleLabel(
  predictedWorkoutDay: boolean | null,
  isWorkoutDay: boolean
): WorkoutDayLabel {
  if (predictedWorkoutDay === true) return "Workout day";
  if (predictedWorkoutDay === false && isWorkoutDay) {
    return "Rest day — unplanned workout logged";
  }
  // No cadence inferred yet: fall back to whether a session was logged today,
  // preserving the pre-#747 `predictedWorkoutDay ?? isWorkoutDay` behavior.
  if (predictedWorkoutDay === null && isWorkoutDay) return "Workout day";
  return "Rest day";
}

// Suggested situation labels for the form; free text is still allowed.
export const SUGGESTED_SITUATIONS = [
  "Illness",
  "Travel",
  "High stress",
  "Poor sleep",
];

// ---- Obligation semantics (issue #1505) -----------------------------------
//
// ONE table, three derived behaviors. Every surface that asks "do I contact about
// this / does a miss exist / does it escalate" reads THESE, never the raw string:
//
//   obligation   send                    adherence                escalation
//   ---------------------------------------------------------------------------
//   must         remind                  counted                  yes
//   should       remind                  counted                  never
//   may          never                   no dueness, no misses    n/a
//
// The three predicates below are deliberately separate rather than one "tier" number:
// they answer different questions and only two of the three boundaries coincide.
// `should` reminds but never escalates, which is precisely the distinction the old
// two-value model (`mandatory` vs `high`, both fully pushed) could not express.

// Descending weight, for the within-day sort and any ordering that reads it.
export const OBLIGATION_ORDER: Record<IntakeObligation, number> = {
  must: 0,
  should: 1,
  may: 2,
};

export const OBLIGATIONS = Object.keys(
  OBLIGATION_ORDER
) as IntakeObligation[];

export const OBLIGATION_LABELS: Record<IntakeObligation, string> = {
  must: "Must",
  should: "Should",
  may: "May",
};

// The one-line explanation of what each level actually does, shown beside the
// selector so the choice is never a bare adjective. Kept here so the form, the med
// confirm dialog and any doc-facing surface quote the SAME consequences.
export const OBLIGATION_HINTS: Record<IntakeObligation, string> = {
  must: "Reminders, and a follow-up nudge if a dose goes unconfirmed. A miss is an incident.",
  should: "Reminders and adherence tracking. A miss is a shortfall, never escalated.",
  may: "No reminders and no misses — kept on your list and one tap away when you want it.",
};

// THE push predicate. Whether this item may ride a SYSTEM-INITIATED surface at all:
// dose reminders, refill nudges, the digest's Today section, Upcoming's due rows, the
// dashboard hero. `may` means the user declared no expectation, so the system never
// initiates about it — it stays fully reachable through USER-initiated access (the
// Supplements page, quick log, the digest's "Log other…" tail, keyboards) exactly as
// the surface taxonomy in docs/internals/findings.md requires.
//
// This is the ONE gate every push surface consults; a surface that grows its own
// obligation check is the drift this predicate exists to prevent (#221).
//
// Note what is NO LONGER here: `kind`. Before #1505 this predicate had a medication
// carve-out because kind was doing pushability's job. Kind now decides CLINICAL
// IDENTITY (which safety engine, which surface, passport inclusion) and obligation
// decides push, so a medication is pushed because it is `must` — its default, and one
// it can only leave through an explicit consequence-stating confirm — not because of
// its kind. The safety tier is unchanged and stays obligation-BLIND: missed-dose
// escalation reads the unfiltered gather, and the interaction (#144) / PGx (#710) /
// UL (#148) warnings fire identically for a `may` member.
export function isPushedIntake(
  item: Pick<Supplement, "obligation">
): boolean {
  return item.obligation !== "may";
}

// Whether a MISSED occurrence exists for this item at all — the adherence half of the
// same boundary. A `may` item has no dueness (isDueOn short-circuits), so it has no
// misses, contributes to no fraction, and appears in the administrations ledger only.
// Separate from isPushedIntake on purpose: they coincide today, and they are answers
// to different questions ("do we contact?" vs "can this fail?").
export function accruesMisses(item: Pick<Supplement, "obligation">): boolean {
  return item.obligation !== "may";
}

// Whether an unconfirmed dose of this item may ESCALATE (the missed-dose follow-up
// nudge). `must` only: a `should` miss is a tracked shortfall, and chasing it with a
// second message is the over-contact this model exists to stop. The per-item
// `critical` opt-in still applies INSIDE must — this widens nothing, it narrows the
// eligible set.
export function escalatesOnMiss(item: Pick<Supplement, "obligation">): boolean {
  return item.obligation === "must";
}

// PRN shape (#798/#851): the amount-only dose row, the redose interval/max notice and
// the over-max finding all key off `may`, which absorbed `as_needed`. Named for what
// callers mean so the collapse reads as one concept rather than a magic string.
export function isPrn(item: Pick<Supplement, "obligation">): boolean {
  return item.obligation === "may";
}

// Tailwind accent for the obligation badge / row accent.
export function obligationClass(obligation: IntakeObligation): string {
  if (obligation === "must")
    return "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300";
  if (obligation === "should")
    return "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300";
  return "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400";
}

// ---- Food timing ----

export const FOOD_TIMINGS: FoodTiming[] = [
  "any",
  "with_food",
  "with_fat",
  "before_meal",
  "empty_stomach",
];

// Single source of truth for food-timing copy: `label` for selects, `hint` for
// the one-line guidance on the schedule row (empty hint = nothing to show).
const FOOD_TIMING_META: Record<FoodTiming, { label: string; hint: string }> = {
  any: { label: "With or without food", hint: "" },
  with_food: { label: "With food", hint: "Take with food" },
  with_fat: { label: "With fat", hint: "Take with a fat-containing meal" },
  before_meal: { label: "Before meal", hint: "Take before a meal" },
  empty_stomach: { label: "Empty stomach", hint: "Take on an empty stomach" },
};

export const FOOD_TIMING_LABELS = Object.fromEntries(
  FOOD_TIMINGS.map((ft) => [ft, FOOD_TIMING_META[ft].label])
) as Record<FoodTiming, string>;

export const FOOD_TIMING_HINTS = Object.fromEntries(
  FOOD_TIMINGS.map((ft) => [ft, FOOD_TIMING_META[ft].hint])
) as Record<FoodTiming, string>;

// Substances best absorbed with dietary fat — used to default food timing when a
// catalogued supplement doesn't specify one.
const FAT_SOLUBLE = [
  "vitamin d",
  "vitamin a",
  "vitamin e",
  "vitamin k",
  "d3",
  "k2",
  "omega",
  "fish oil",
  "krill",
  "coq10",
  "coenzyme q10",
  "ubiquinol",
  "curcumin",
  "turmeric",
  "astaxanthin",
  "lutein",
];

// Best-effort default food timing for a supplement name (catalog entries can
// override). Returns "any" when nothing clearly applies.
export function defaultFoodTiming(
  name: string,
  explicit?: FoodTiming | null
): FoodTiming {
  if (explicit) return explicit;
  const n = name.toLowerCase();
  if (FAT_SOLUBLE.some((k) => n.includes(k))) return "with_fat";
  return "any";
}

// ---- Dosage parsing ----

export interface ParsedDosage {
  amount: string | null; // quantity per intake, e.g. "5–10 g"
  perDay: number; // number of intakes per day
  timeOfDay: TimeBucket | null; // inferred from embedded timing words
}

// Frequency phrases → intakes per day (each intake is the stated amount).
const FREQ_PATTERNS: [RegExp, number][] = [
  [/\b(twice|2\s*(?:x|times))\b/i, 2],
  [/\b(thrice|three\s*times|3\s*(?:x|times)|tid)\b/i, 3],
  [/\b(four\s*times|4\s*(?:x|times)|qid)\b/i, 4],
  [/\b(once|1\s*(?:x|time)|qd|od)\b/i, 1],
];

// Frequency / timing / food phrases stripped out to leave just the amount.
const STRIP_PATTERNS: RegExp[] = [
  /\b(once|twice|thrice|three times|four times)\b/gi,
  /\b\d+\s*(?:x|times)\b/gi,
  /\b(per|a|each|every)\s*day\b/gi,
  /\bdaily\b/gi,
  /\/\s*day\b/gi,
  /\b(qd|bid|tid|qid|od)\b/gi,
  /\b(split|divided)\b(\s+(in(?:to)?|across))?(\s+\d+\s*[a-z]*)?/gi,
  /\bacross\s+\d+\s*[a-z]+/gi,
  /\bwith\s+(food|meals?|a meal|fat|water|breakfast|lunch|dinner)\b/gi,
  /\b(on\s+an?\s+)?empty\s+stomach\b/gi,
  /\bbefore\s+(a\s+)?(meals?|bed(time)?)\b/gi,
  /\bin\s+the\s+(morning|afternoon|evening)\b/gi,
  /\bat\s+(night|bedtime)\b/gi,
];

// Earliest marker after which the text is frequency/timing/separation prose
// rather than the amount, e.g. "once daily", "2-3 times daily", "taken 2+ hours
// away from…", "with food", "before bed". The amount is everything before it.
const CUT_RE =
  /\b(?:\d+\s*(?:[–-]\s*\d+)?\s*(?:x|times)|once|twice|thrice|three\s+times|four\s+times|every\s+day|per\s+day|a\s+day|daily|each\s+day|with\s|without\s|before\b|after\b|on\s+an?\s+empty|empty\s+stomach|taken\b|away\s+from|apart\s+from|split\b|divided\b|across\b|\d+\s*\+?\s*hours?|at\s+night|at\s+bedtime|in\s+the\s+(?:morning|afternoon|evening))/i;

// Split a free-text dosage ("5–10 g once daily", "500mg 2-3 times daily",
// "500–1000 mg, taken 2+ hours away from other supplements") into a clean
// per-intake amount, how many intakes per day, and any embedded time of day.
// "split/divided/across" describe a total to divide, so they don't multiply the
// intake count; a frequency range ("2-3 times") takes the lower bound.
export function parseDosage(text: string | null): ParsedDosage {
  if (!text) return { amount: null, perDay: 1, timeOfDay: null };
  const raw = text.trim();
  const lower = raw.toLowerCase();

  let perDay = 1;
  const nx = lower.match(/(\d+)\s*(?:[–-]\s*\d+)?\s*(?:x|times)\b/);
  if (nx)
    perDay = Number(nx[1]) || 1; // lower bound of any range
  else
    for (const [re, n] of FREQ_PATTERNS)
      if (re.test(lower)) {
        perDay = n;
        break;
      }
  if (/\b(split|divided|across)\b/i.test(lower)) perDay = 1;

  const tb = timeBucket(raw);
  const timeOfDay = tb === "Anytime" ? null : tb;

  // Amount = text before the first frequency/timing/separation marker.
  const cut = raw.match(CUT_RE);
  let amount = (cut ? raw.slice(0, cut.index) : raw)
    .replace(/[,;]+\s*$/, "")
    .replace(/\s*[–-]\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Fallback: if the marker sat at the very start, strip-clean the whole string.
  if (!amount) {
    amount = raw;
    for (const re of STRIP_PATTERNS) amount = amount.replace(re, " ");
    amount = amount
      .replace(/[(),;]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  return { amount: amount || null, perDay, timeOfDay };
}

// Spread N intakes across sensible time buckets (falling back to `fallback`).
export function spreadDoseTimes(
  n: number,
  fallback: string | null
): (string | null)[] {
  if (n <= 1) return [fallback];
  const presets: Record<number, TimeBucket[]> = {
    2: ["Morning", "Evening"],
    3: ["Morning", "Midday", "Evening"],
    4: ["Morning", "Midday", "Evening", "Evening"],
  };
  return presets[n] ?? Array(n).fill(fallback ?? "Anytime");
}

// PRN ⇒ amount-only dose shape (issue #851 item 9). A PRN (as-needed) medication and
// the scheduled time-slot / split-dose path are conceptually mutually exclusive: the
// redose interval owns "when", so a PRN med carries exactly ONE amount-only dose row
// (no time_of_day slot, no split). This enforces that invariant at the save boundary
// regardless of surface — a legacy hybrid row (a PRN med with time slots) is collapsed
// to its first dose's amount on the next save, keeping that dose's id so its
// administration history survives. `food_timing` is preserved (an NSAID stays "with
// food"); only the schedule slot is dropped. A no-op for a non-PRN item. Pure.
export interface CollapsibleDose {
  id?: number;
  amount: string | null;
  time_of_day: string | null;
  food_timing: FoodTiming;
}

export function collapsePrnDoses<T extends CollapsibleDose>(
  doses: T[],
  asNeeded: boolean
): CollapsibleDose[] {
  if (!asNeeded) return doses;
  const first = doses[0];
  return [
    {
      id: first?.id,
      amount: first?.amount ?? null,
      time_of_day: null,
      food_timing: first?.food_timing ?? "any",
    },
  ];
}
