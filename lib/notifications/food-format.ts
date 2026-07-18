// Pure rendering for the Telegram food-log nudge (issue #682) — DB-free so it's
// unit-tested (lib/__tests__). The gather (lib/notifications/food.ts) ranks the
// profile's food groups by recency-decayed frequency (getFoodGroupLogOrder — the
// SAME "most eaten leads" computation the /nutrition log bar uses, #591/#195) and
// hands the ranked list + today's serving counts here. One tap on a group button
// logs one serving; unlike a dose reminder the buttons are NOT consumed (you can eat
// several servings / several groups), so a rebuild after a tap keeps every button
// and only refreshes the per-button count + the tally line.

import type { FoodGroup } from "../food-groups";
import type { NotificationAction, NotificationMessage } from "./types";

// The food nudge rides the morning/midday/evening supplement slots (issue #682) —
// NOT Bedtime (logging food at bedtime is noise). A distinct type from the
// supplement ReminderWindow so the two schedules can't be accidentally conflated.
export type FoodNudgeWindow = "Morning" | "Midday" | "Evening";
export const FOOD_NUDGE_WINDOWS: readonly FoodNudgeWindow[] = [
  "Morning",
  "Midday",
  "Evening",
];

// How many of the top-ranked groups become quick-log buttons. Kept small so the
// keyboard stays scannable on a phone; the long tail is reached via the "More…"
// deep link. Two buttons per row (see rowFor) → an even count fills rows cleanly.
export const FOOD_NUDGE_BUTTON_COUNT = 6;

// The callback token a food quick-log button carries:
//   food:<profileId>:<window>:<date>:<slug>
// profileId is a cross-check (the handler re-resolves the acting profile from the
// chat id); window + date let a late tap rebuild the right message and log to the
// right day; the slug (snake_case, no colons) is the greedy tail. Kept well under
// Telegram's 64-byte callback_data cap.
export function foodLogCallbackData(
  profileId: number,
  window: FoodNudgeWindow,
  date: string,
  slug: string
): string {
  return `food:${profileId}:${window}:${date}:${slug}`;
}

// The callback token for the one-time first-connection opt-in prompt (#682):
//   foodoptin:<profileId>:<yes|no>
// Answered by a button tap (inbound Telegram is callback-only — there's no /start or
// free-text parser), which flips the per-profile food_telegram_enabled flag.
export function foodOptInCallbackData(
  profileId: number,
  enable: boolean
): string {
  return `foodoptin:${profileId}:${enable ? "yes" : "no"}`;
}

// Two buttons per keyboard row, so six groups render as a tidy 3×2 grid.
function rowFor(index: number): string {
  return `food${Math.floor(index / 2)}`;
}

// The "logged so far today" tally line: groups with a positive count today, most-
// logged first (name breaks ties), as "✓ Leafy greens ×2 · Berries ×1". Empty
// string when nothing's been logged yet today (the caller shows the prompt instead).
function tallyLine(
  groups: FoodGroup[],
  servingsToday: Map<string, number>
): string {
  const logged = groups
    .map((g) => ({ g, n: servingsToday.get(g.slug) ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.g.name.localeCompare(b.g.name));
  if (logged.length === 0) return "";
  return `✓ ${logged.map((x) => `${x.g.name} ×${x.n}`).join(" · ")}`;
}

// Build the food-log nudge for a window from the profile's RANKED food groups (all
// of them, staples first) and today's per-group serving counts. Renders the top
// FOOD_NUDGE_BUTTON_COUNT groups as quick-log buttons (each labeled with today's
// running count when > 0) plus, when a public app URL is configured, a "More…" deep
// link to /nutrition for the long tail.
export function renderFoodNudge(
  profileId: number,
  window: FoodNudgeWindow,
  date: string,
  rankedGroups: FoodGroup[],
  servingsToday: Map<string, number>,
  deepLinkBase = "",
  // Today-vs-goal protein status line (issue #974), pre-rendered by the gather from the
  // SAME getProteinToday model the Food-tab gauge uses (#221 — a third formatter, never a
  // second engine). Null/omitted when there's no target (no bodyweight) or no protein data
  // at all, so the nudge never carries a bare "0 g" nag.
  proteinLine: string | null = null
): NotificationMessage {
  const buttons = rankedGroups.slice(0, FOOD_NUDGE_BUTTON_COUNT);
  const actions: NotificationAction[] = buttons.map((g, i) => {
    const n = servingsToday.get(g.slug) ?? 0;
    return {
      label: n > 0 ? `${g.name} (${n})` : g.name,
      data: foodLogCallbackData(profileId, window, date, g.slug),
      row: rowFor(i),
    };
  });

  const base = deepLinkBase.replace(/\/$/, "");
  if (base) {
    actions.push({
      label: "＋ More…",
      url: `${base}/nutrition`,
      row: "food-more",
    });
  }

  const tally = tallyLine(rankedGroups, servingsToday);
  const lines = ["Tap what you've eaten to log a serving."];
  if (tally) lines.push(tally);
  if (proteinLine) lines.push(proteinLine);
  const body = lines.join("\n");

  return { title: `🍽️ ${window} food log`, body, actions, kind: "food" };
}
