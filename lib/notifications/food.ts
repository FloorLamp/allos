// The food-log nudge + first-connection opt-in prompt (issue #682). This is the
// GATHER half (DB reads → the pure renderer in ./food-format), mirroring how
// intake.ts gathers for intake-format.ts. The nudge rides the profile's
// morning/midday/evening supplement slots (wired in scripts/notify.ts) and is
// opt-in per profile (food_telegram_enabled) — so a household that doesn't want it
// never sees it.

import {
  getRecentFoodTaps,
  rankFoodGroups,
  getFoodServingsOnDate,
  getProteinDailyGrams,
  getProteinTapsOnDate,
  getProteinQuickAddPreset,
  getProteinToday,
  getLoggedFoodWindows,
  hasCorrectedAnyTime,
} from "../queries";
import { getTimezone, getProfileAge } from "../settings";
import { getProfileSubstanceTelegram } from "../settings/notifications";
import { ALCOHOL_FOOD_GROUP } from "../substance-use";
import type { FoodTapRow } from "../food-log-write";
import { isFoodLoggingRelevant } from "../life-stage";
import { now as clockNow } from "../clock";
import { dateStrInTz, minuteOfDayInTz } from "../date";
import { today } from "../db";
import { profileFoodSlotBoundaries } from "../profile-food-slot";
import { foodWindowGap, foodWindowGapDates } from "../food-window-gap";
import {
  correctionBursts,
  type CorrectionBurst,
  type CorrectionDay,
} from "../correction-time";
import { proteinTodayLineParts } from "../protein";
import { PROTEIN_NUDGE_KEY } from "../protein-nudge";
import {
  foodOptInCallbackData,
  renderFoodNudge,
  type FoodNudgeWindow,
} from "./food-format";
import {
  correctionMessageBinding,
  type CorrectionMessageRef,
} from "./message-pointers";
import { telegramChannel } from "./telegram";
import { composeForSend } from "./compose";
import type { NotificationAction, NotificationMessage } from "./types";
import { GLYPH } from "./glyphs";

// THE CONSENTED TAP GATHER (#3330) — the ONE read every chat-facing eating-time
// correction surface takes, so the substance opt-in is asked once and cannot be missed by
// a caller that reaches the ledger a different way. That is the failure this replaced: the
// first fix gated the nudge's BUTTONS and TALLY and left the correction ride-along, which
// re-reads `food_log_events` thirty lines further down and labels each burst with its food
// group — so an ordinary web-logged drink and an ordinary proactive send still produced
// "🕐 Alcohol 07:50" — a wall-clock time, strictly more identifying than the tally.
//
// FILTERED BEFORE THE COLLAPSE, deliberately. `collapseBursts` names a burst only when it
// has exactly ONE member, so dropping the substance rows first leaves a mixed burst
// naming a neighbour or naming nothing at all ("2 entries") — never a redacted row and
// never a gap someone can read backwards. A burst that was ALL substance disappears, and
// a chip or picker token pointing at it then resolves to no burst and gets the refusal
// that already exists for a burst that has aged out.
//
// The WRITE core is deliberately not gated: `restampFoodEventsCore` re-derives the burst
// from the ledger, so a chip on a mixed burst still moves every row of the meal it names.
// Consent governs what is SENT; leaving one row of an eating event behind at the old time
// would be a corruption of the record, not a protection of it.
export function consentedFoodTaps(profileId: number, now: Date): FoodTapRow[] {
  const taps = getRecentFoodTaps(profileId, now);
  if (getProfileSubstanceTelegram(profileId)) return taps;
  return taps.filter((t) => t.groupKey !== ALCOHOL_FOOD_GROUP);
}

// Build the food-log nudge for a window, or null when the profile shouldn't get one.
// The only gate here is life stage — food-group serving logging is meaningless for
// an infant (< 1 y — milk/formula only), so the nudge hides on a positive infant
// match exactly like the /nutrition page/nav do (isFoodLoggingRelevant, #591). The
// per-profile opt-in (food_telegram_enabled) is checked by the tick before it even
// asks for a nudge. Ranking + today's counts come from the SAME reads the web log
// bar uses, so the buttons lead with the profile's staples (one computation).
export function buildFoodNudge(
  profileId: number,
  window: FoodNudgeWindow,
  date: string,
  // How many ranked buttons to render (#1075). Defaults to the compact FOOD_QUICK_COUNT
  // for a fresh send; the "Show more"/"Show less" handler, a food/protein tap after expansion,
  // and the tick-time reconcile (#1779/#1807) all pass the current visible count (read off the
  // live keyboard) so no rebuild silently resizes a keyboard the user sized.
  visibleCount?: number,
  // The eating-time ride-along's knobs (#2019). `now` is the instant tap freshness is
  // judged against — injected rather than read from the clock here so the send, the
  // rebuild and the sweep can all be pinned to one time in a test. `picker` renders the
  // open absolute-hour drill-down in place of the chip rows. `ref` is the MESSAGE being
  // rebuilt (#2264) — every rebuild site passes its own (chat, message), so the
  // correction rows are bound to the message that produced their bursts; a fresh send
  // omits it and carries only unattributed bursts, being about to be the newest live
  // food message in every chat it lands in.
  opts: {
    now?: Date;
    picker?: CorrectionBurst;
    // Which day level the open picker is showing (#3010).
    pickerLevel?: CorrectionDay;
    ref?: CorrectionMessageRef | null;
  } = {}
): NotificationMessage | null {
  const now = opts.now ?? clockNow();
  if (!isFoodLoggingRelevant(getProfileAge(profileId))) return null;
  // Slot-aware ranking (#950/#1073): the nudge knows its window, so it passes it through —
  // the buttons lead with what this profile eats at THIS time of day (fish at lunch), and
  // the reserved __protein__ pseudo-group joins the ranked keys for a protein-logging
  // profile so it surfaces in the slots they shake. This is THE ranking function the web
  // log bar calls too (#1980) — not a parallel one that claims to agree — and it carries
  // the #2019 proximity weighting for every surface at once.
  const rankedKeys = rankFoodGroups(profileId, window);
  // Buttons AND the tally line both read the DAY total (#2019 retired the slot-scoped
  // "(n)" suffix along with the read-time window derivation it depended on).
  const dayServings = getFoodServingsOnDate(profileId, date);
  // THE SUBSTANCE REACH GATE, half one (#3330, #3279 ruling 4). Alcohol is the one food
  // group whose `food_daily_totals` counter IS the substance ledger, so it arrives through
  // the ordinary ranking and rendered as a chat BUTTON and a "🍷 Alcohol ×2" tally entry.
  // Half two is `consentedFoodTaps` above, which the correction ride-along below reads —
  // two data sources, one consent, and the first version of this gate had only this half.
  //
  // Removing, not redacting: the key leaves both inputs and the nudge still sends with
  // every other group intact. Only `kind: "food"` passes through this builder, so no dose
  // reminder, escalation, redose notice — or the "avoid alcohol" food-interaction line on
  // a dose tail, which is a fact about the medication and not a record of anyone's
  // drinking — is reachable from this branch.
  //
  // ONE CONSTANT, NOT A FIRST MEMBER: every other substance (curated or custom) lives in
  // `substance_daily_totals` and has no food-group row to reach this list. A second
  // `ledger: "food-log"` substance would have to be filtered in both halves.
  if (!getProfileSubstanceTelegram(profileId)) {
    const i = rankedKeys.indexOf(ALCOHOL_FOOD_GROUP);
    if (i >= 0) rankedKeys.splice(i, 1);
    dayServings.delete(ALCOHOL_FOOD_GROUP);
  }
  // The protein button's own day count (#1379's sibling consistency, on #2019's day
  // meaning). The reserved key never lands in the food_daily_totals counter `dayServings` reads,
  // so its taps are counted off the ledger and merged in here — the renderer then applies
  // ONE suffix rule to every button on the keyboard.
  const proteinTaps = getProteinTapsOnDate(profileId, date);
  if (proteinTaps > 0) dayServings.set(PROTEIN_NUDGE_KEY, proteinTaps);
  // Day-vs-goal protein status line (#974) from the SAME gather the gauge reads (#221).
  // Null when there's no target or no protein data — the renderer then omits the line.
  //
  // `date`, NOT TODAY (#4118). Every other figure on this message is already read for the
  // day the message is FOR — the tally, the button counts, the protein taps, the day
  // grams, the empty-window notice — and this one line resolved its own `today()`
  // inside. Unreachable while a food nudge could only be live on its own date; the
  // moment the sweep began rebuilding a message up to two days old, the hourly tick
  // started repainting a past day's nudge with the CURRENT day's protein figure and its
  // "goal reached" verdict. `food` is `reissuable: false`, so that message stays live
  // and keeps being repainted until the next food nudge — permanently, if they stop.
  const pt = getProteinToday(profileId, date);
  // WHOSE DAY THE MESSAGE IS ABOUT, in the words it uses. A past-day rebuild must not
  // say "Today" — that is the same defect as the wrong figure, in the label rather than
  // in the number.
  const isToday = date === today(profileId);
  // Gathered as PARTS (#1710) so the "reached / below" conclusion is decided once in
  // lib/protein and the renderer only decides emphasis.
  let proteinLine: ReturnType<typeof proteinTodayLineParts> | string | null = pt
    ? proteinTodayLineParts(pt)
    : null;
  // A protein-tracker with no target (no bodyweight) still gets a day-grams line when
  // they've logged protein today, so the "+Xg protein" button's contribution is visible and
  // distinct from the food-serving tally (#1073). getProteinDailyGrams is a raw stored
  // total — no second engine (#221).
  if (!proteinLine && rankedKeys.includes(PROTEIN_NUDGE_KEY)) {
    const grams = getProteinDailyGrams(profileId, date);
    if (grams > 0)
      proteinLine = isToday
        ? `Protein ${grams} g today`
        : `Protein ${grams} g on ${date}`;
  }
  const presetGrams = getProteinQuickAddPreset(profileId) ?? undefined;
  // The eating-time correction ride-along (#2019), derived from ledger state and BOUND
  // to the message being rendered (#2264): a burst renders only on the message whose
  // tap produced it, and an unattributed burst (web, offline replay, pruned pointer)
  // rides only the newest live food message in the chat — never an older one, whose
  // subject it is not and whose chips would restamp servings it never mentioned.
  const corrections = correctionBursts(
    consentedFoodTaps(profileId, now),
    now,
    correctionMessageBinding(profileId, "food", opts.ref ?? null)
  );
  const tz = getTimezone(profileId);
  // The empty-window notice (#2376). A RIDE-ALONG, exactly like the correction rows
  // above: no nudge is ever sent because a window closed empty — this clause only ever
  // appears on the message the next window was already going to send, which is what
  // keeps it inside the contact-consent rule (docs/internals/findings.md §2). The whole
  // decision, including the habit gate that keeps a window nobody logs silent, is
  // lib/food-window-gap.ts; the gather's only job is to hand it the ledger slice IT says
  // it needs, so the query window and the decision can never drift apart.
  //
  // Recomputed on every rebuild rather than snapshotted at send: a serving logged into
  // the window in the meantime makes the line disappear, which is the "recovery clears
  // it" property the notice has instead of any stored state.
  const gapDates = foodWindowGapDates(window, date);
  const gap = foodWindowGap({
    window,
    date,
    now: { date: dateStrInTz(tz, now), minuteOfDay: minuteOfDayInTz(tz, now) },
    boundaries: profileFoodSlotBoundaries(profileId),
    logged: getLoggedFoodWindows(profileId, gapDates.from, gapDates.to),
  });
  return renderFoodNudge(profileId, window, date, rankedKeys, dayServings, {
    // The tally's own label, decided HERE because only this side can ask the clock
    // (food-format is the DB-free renderer). "Today" on a message the sweep rebuilt
    // two days later is the same false claim as a wrong figure, worn as a word.
    dayLabel: isToday ? "Today" : date,
    proteinLine,
    visibleCount,
    proteinPresetGrams: presetGrams,
    corrections: {
      bursts: corrections,
      now,
      // The hint's retirement gate (#2874). Asked only when there is something to hint
      // ABOUT — a nudge with no correctable burst renders no sentence either way, so a
      // profile that has never tapped a chip never pays for the probe.
      hasCorrectedAnyTime:
        corrections.length > 0 ? hasCorrectedAnyTime(profileId) : false,
    },
    gap,
    tz,
    ...(opts.picker
      ? {
          picker: {
            burst: opts.picker,
            now,
            level: opts.pickerLevel ?? "today",
          },
        }
      : {}),
  });
}

// The one-time prompt sent the first time a profile connects Telegram, asking
// whether to turn on food logging. Pure enough to unit-test the token shape; the
// send wrapper below applies attribution + the channel.
export function buildFoodOptInPrompt(profileId: number): NotificationMessage {
  const actions: NotificationAction[] = [
    {
      label: `${GLYPH.food} Enable food logging`,
      data: foodOptInCallbackData(profileId, true),
      row: "foodoptin",
    },
    {
      label: "No thanks",
      data: foodOptInCallbackData(profileId, false),
      row: "foodoptin",
    },
  ];
  return {
    title: `${GLYPH.food} Log food from Telegram?`,
    body: "Want to log what you eat right from here? I'll show your most-eaten foods at your reminder times. You can change this any time in Settings → Profile.",
    actions,
    kind: "food",
  };
}

// Send the first-connection opt-in prompt to the profile's Telegram chat. Telegram-
// only (the prompt is answered by inline buttons, which only Telegram renders), so it
// goes straight through the channel chokepoint rather than dispatch() — a push/HA
// "want to log food?" with no tappable button would be noise. No-op when Telegram
// isn't actually configured (belt-and-suspenders; the caller already checks).
export async function sendFoodOptInPrompt(profileId: number): Promise<void> {
  if (!telegramChannel.isConfigured(profileId)) return;
  // The ONE send in the app that reaches a channel without going through `dispatch`
  // (see above), so it composes explicitly (#4538) rather than inheriting it. Unbidden,
  // like every dispatch send, so the origin is the same one.
  await telegramChannel.send(
    profileId,
    composeForSend(profileId, buildFoodOptInPrompt(profileId), "telegram-nudge")
  );
}
