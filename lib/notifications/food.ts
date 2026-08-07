// The food-log nudge + first-connection opt-in prompt (issue #682). This is the
// GATHER half (DB reads → the pure renderer in ./food-format), mirroring how
// supplements.ts gathers for supplement-format.ts. The nudge rides the profile's
// morning/midday/evening supplement slots (wired in scripts/notify.ts) and is
// opt-in per profile (food_telegram_enabled) — so a household that doesn't want it
// never sees it.

import {
  getFoodCorrectionBursts,
  rankFoodGroups,
  getFoodServingsOnDate,
  getProteinLoggedGrams,
  getProteinTapsOnDate,
  getProteinQuickAddPreset,
  getProteinToday,
} from "../queries";
import { getTimezone, getUserAge } from "../settings";
import { isFoodLoggingRelevant } from "../life-stage";
import { now as clockNow } from "../clock";
import type { CorrectionBurst } from "../correction-time";
import { proteinTodayNudgeParts } from "../protein";
import { PROTEIN_NUDGE_KEY } from "../protein-nudge";
import {
  foodOptInCallbackData,
  renderFoodNudge,
  type FoodNudgeWindow,
} from "./food-format";
import { telegramChannel } from "./telegram";
import { prefixForProfile } from "./attribution";
import {
  prefixMessage,
  type NotificationAction,
  type NotificationMessage,
} from "./types";

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
  // How many ranked buttons to render (#1075). Defaults to the compact FOOD_NUDGE_BUTTON_COUNT
  // for a fresh send; the "Show more"/"Show less" handler, a food/protein tap after expansion,
  // and the tick-time reconcile (#1779/#1807) all pass the current visible count (read off the
  // live keyboard) so no rebuild silently resizes a keyboard the user sized.
  visibleCount?: number,
  // The eating-time ride-along's two knobs (#2019). `now` is the instant tap freshness is
  // judged against — injected rather than read from the clock here so the send, the
  // rebuild and the sweep can all be pinned to one time in a test. `picker` renders the
  // open absolute-hour drill-down in place of the chip rows.
  opts: { now?: Date; picker?: CorrectionBurst } = {}
): NotificationMessage | null {
  const now = opts.now ?? clockNow();
  if (!isFoodLoggingRelevant(getUserAge(profileId))) return null;
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
  // The protein button's own day count (#1379's sibling consistency, on #2019's day
  // meaning). The reserved key never lands in the food_log counter `dayServings` reads,
  // so its taps are counted off the ledger and merged in here — the renderer then applies
  // ONE suffix rule to every button on the keyboard.
  const proteinTaps = getProteinTapsOnDate(profileId, date);
  if (proteinTaps > 0) dayServings.set(PROTEIN_NUDGE_KEY, proteinTaps);
  // Today-vs-goal protein status line (#974) from the SAME gather the gauge reads (#221).
  // Null when there's no target or no protein data — the renderer then omits the line.
  const pt = getProteinToday(profileId);
  // Gathered as PARTS (#1710) so the "reached / below" conclusion is decided once in
  // lib/protein and the renderer only decides emphasis.
  let proteinLine: ReturnType<typeof proteinTodayNudgeParts> | string | null =
    pt ? proteinTodayNudgeParts(pt) : null;
  // A protein-tracker with no target (no bodyweight) still gets a day-grams line when
  // they've logged protein today, so the "+Xg protein" button's contribution is visible and
  // distinct from the food-serving tally (#1073). getProteinLoggedGrams is a raw stored
  // total — no second engine (#221).
  if (!proteinLine && rankedKeys.includes(PROTEIN_NUDGE_KEY)) {
    const grams = getProteinLoggedGrams(profileId, date);
    if (grams > 0) proteinLine = `Protein ${grams} g today`;
  }
  const presetGrams = getProteinQuickAddPreset(profileId) ?? undefined;
  // The eating-time correction ride-along (#2019), derived from ledger state — so it
  // rides EVERY food keyboard the builder produces: the send, a tap rebuild, an
  // expansion, and the hourly reconcile, with no send path of its own.
  const corrections = getFoodCorrectionBursts(profileId, now);
  return renderFoodNudge(profileId, window, date, rankedKeys, dayServings, {
    proteinLine,
    visibleCount,
    proteinPresetGrams: presetGrams,
    corrections,
    tz: getTimezone(profileId),
    now,
    ...(opts.picker ? { picker: { burst: opts.picker, now } } : {}),
  });
}

// The one-time prompt sent the first time a profile connects Telegram, asking
// whether to turn on food logging. Pure enough to unit-test the token shape; the
// send wrapper below applies attribution + the channel.
export function buildFoodOptInPrompt(profileId: number): NotificationMessage {
  const actions: NotificationAction[] = [
    {
      label: "🍽️ Enable food logging",
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
    title: "🍽️ Log food from Telegram?",
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
  const msg = prefixMessage(
    buildFoodOptInPrompt(profileId),
    prefixForProfile(profileId)
  );
  await telegramChannel.send(profileId, msg);
}
