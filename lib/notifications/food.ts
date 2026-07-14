// The food-log nudge + first-connection opt-in prompt (issue #682). This is the
// GATHER half (DB reads → the pure renderer in ./food-format), mirroring how
// supplements.ts gathers for supplement-format.ts. The nudge rides the profile's
// morning/midday/evening supplement slots (wired in scripts/notify.ts) and is
// opt-in per profile (food_telegram_enabled) — so a household that doesn't want it
// never sees it.

import { getFoodGroupLogOrder, getFoodServingsOnDate } from "../queries";
import { getPublicUrl, getUserAge } from "../settings";
import { isFoodLoggingRelevant } from "../life-stage";
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
  date: string
): NotificationMessage | null {
  if (!isFoodLoggingRelevant(getUserAge(profileId))) return null;
  const ranked = getFoodGroupLogOrder(profileId);
  const servingsToday = getFoodServingsOnDate(profileId, date);
  return renderFoodNudge(
    profileId,
    window,
    date,
    ranked,
    servingsToday,
    getPublicUrl()
  );
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
