// Pure rendering for the Telegram food-log nudge (issue #682) — DB-free so it's
// unit-tested (lib/__tests__). The gather (lib/notifications/food.ts) ranks the
// profile's food groups by recency-decayed frequency (getFoodGroupLogOrder — the
// SAME "most eaten leads" computation the /nutrition log bar uses, #591/#195) and
// hands the ranked list + today's serving counts here. One tap on a group button
// logs one serving; unlike a dose reminder the buttons are NOT consumed (you can eat
// several servings / several groups), so a rebuild after a tap keeps every button
// and only refreshes the per-button count + the tally line.

import { foodGroupBySlug, foodGroupName } from "../food-groups";
import {
  DEFAULT_PROTEIN_PRESET_GRAMS,
  isProteinNudgeKey,
  proteinNudgeButtonLabel,
} from "../protein-nudge";
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

// The protein "+Xg" quick-log button token (#1073):
//   foodprotein:<profileId>:<window>:<date>:<grams>
// Mirrors the food-log token (profileId is a cross-check; window + date let a late tap
// rebuild the right message and log to the right day); grams is the last-used scoop preset
// baked in at send time, applied by addProteinGramsCore on tap. Kept under Telegram's
// 64-byte callback cap.
export function foodProteinCallbackData(
  profileId: number,
  window: FoodNudgeWindow,
  date: string,
  grams: number
): string {
  return `foodprotein:${profileId}:${window}:${date}:${grams}`;
}

// The "➕ Show more" progressive-expansion token (#1075):
//   foodmore:<profileId>:<window>:<date>
// It carries NO count — expansion state IS the rendered keyboard, so the handler derives
// the current visible count by counting the ranked buttons already present and rebuilds at
// count + FOOD_NUDGE_BUTTON_COUNT (stateless; a fresh nudge always resets to the compact
// default).
export function foodMoreCallbackData(
  profileId: number,
  window: FoodNudgeWindow,
  date: string
): string {
  return `foodmore:${profileId}:${window}:${date}`;
}

// Count the ranked quick-log buttons currently in a nudge keyboard (#1075). Expansion is
// STATELESS — the number of visible ranked buttons IS the current visibleCount — so a
// handler reads it back off cq.message.reply_markup to preserve or extend the expansion.
// Counts food-group (food:…) AND protein (foodprotein:…) buttons; IGNORES the tally line
// (not a button), the "Show more" row (foodmore:…), the "More…" deep link (url, no
// callback_data), and any opt-in row.
export function countVisibleFoodButtons(
  keyboard:
    | readonly (readonly {
        text?: string;
        callback_data?: string;
        url?: string;
      }[])[]
    | undefined
): number {
  let n = 0;
  for (const row of keyboard ?? []) {
    for (const btn of row) {
      const d = btn.callback_data;
      if (
        typeof d === "string" &&
        (/^food:\d+:/.test(d) || /^foodprotein:\d+:/.test(d))
      )
        n++;
    }
  }
  return n;
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

// The day-total tally line (#1016): groups with a positive count TODAY, most-logged first
// (name breaks ties), labeled so a slot-framed message makes clear the tally answers "where
// am I on the DAY" (the buttons answer "what have I had this SLOT"): "✓ Today: Leafy greens
// ×2 · Berries ×1". Reads the DAY counter (food_log via getFoodServingsOnDate), never the
// slot counts. Empty string when nothing's been logged yet today (the caller shows the
// prompt instead). The reserved __protein__ key can't appear (it never lands in food_log),
// but is filtered defensively so it can never leak into the food-serving tally (#1073).
function tallyLine(dayServings: Map<string, number>): string {
  const logged = [...dayServings.entries()]
    .filter(([slug, n]) => n > 0 && !isProteinNudgeKey(slug))
    .map(([slug, n]) => ({ name: foodGroupName(slug), n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  if (logged.length === 0) return "";
  return `✓ Today: ${logged.map((x) => `${x.name} ×${x.n}`).join(" · ")}`;
}

// Options for renderFoodNudge (the growing set of #974/#1073/#1075 knobs), so the
// positional signature stays stable while behavior is added.
export interface FoodNudgeRenderOpts {
  // A configured public app URL → append a "More…" deep link to /nutrition.
  deepLinkBase?: string;
  // Today-vs-goal protein status line (issue #974 / day-grams line #1073), pre-rendered by
  // the gather. Null/omitted when there's no target and no logged protein, so the nudge
  // never carries a bare "0 g" nag. Rendered on its own line, distinct from the tally.
  proteinLine?: string | null;
  // How many ranked buttons to show (#1075 progressive expansion). Defaults to
  // FOOD_NUDGE_BUTTON_COUNT so every existing send starts compact; "Show more" bumps it.
  visibleCount?: number;
  // Grams for the "+Xg protein" button label (#1073) — the profile's last-used scoop
  // preset. Only used when the reserved __protein__ key falls within the visible window.
  proteinPresetGrams?: number;
}

// Build the food-log nudge for a window from the profile's RANKED keys (all of them,
// staples first, possibly including the reserved __protein__ pseudo-group, #1073), the
// SLOT-scoped per-group counts (#1016 button "(n)" suffix), and the DAY-total counts (the
// tally line). Renders the top `visibleCount` (default FOOD_NUDGE_BUTTON_COUNT) ranked keys
// as quick-log buttons — a food group logs one serving, the __protein__ key logs the grams
// preset — plus a "Show more" row while ranked keys remain below the fold (#1075) and, when
// a public app URL is configured, a "More…" deep link for the long tail.
export function renderFoodNudge(
  profileId: number,
  window: FoodNudgeWindow,
  date: string,
  // Ranked keys: catalog food-group slugs, possibly with the reserved __protein__ pseudo-
  // group at its ranked position (#1073).
  rankedKeys: string[],
  // Slot-scoped per-group serving counts (#1016) — the button "(n)" suffix, "n this slot".
  slotServings: Map<string, number>,
  // Day-total per-group counts (#1016) — the "✓ Today:" tally line.
  dayServings: Map<string, number>,
  opts: FoodNudgeRenderOpts = {}
): NotificationMessage {
  const visibleCount = opts.visibleCount ?? FOOD_NUDGE_BUTTON_COUNT;
  const visible = rankedKeys.slice(0, Math.max(0, visibleCount));
  const presetGrams = opts.proteinPresetGrams ?? DEFAULT_PROTEIN_PRESET_GRAMS;

  const actions: NotificationAction[] = [];
  visible.forEach((key, i) => {
    // The reserved protein pseudo-group (#1073) → the "+Xg protein" button (its own token,
    // its own write core). It carries NO serving-count suffix — its contribution is the
    // day's protein grams, shown on the protein line, never a serving "(n)".
    if (isProteinNudgeKey(key)) {
      actions.push({
        label: proteinNudgeButtonLabel(presetGrams),
        data: foodProteinCallbackData(profileId, window, date, presetGrams),
        row: rowFor(i),
      });
      return;
    }
    const g = foodGroupBySlug(key);
    if (!g) return; // a retired/unknown slug can't render a button (belt; rankedKeys are catalog)
    const n = slotServings.get(key) ?? 0;
    actions.push({
      label: n > 0 ? `${g.name} (${n})` : g.name,
      data: foodLogCallbackData(profileId, window, date, key),
      row: rowFor(i),
    });
  });

  // #1075: reveal the next FOOD_NUDGE_BUTTON_COUNT ranked buttons in place — present only
  // while ranked keys remain below the fold (drops automatically once all are shown).
  if (visibleCount < rankedKeys.length) {
    actions.push({
      label: "➕ Show more",
      data: foodMoreCallbackData(profileId, window, date),
      row: "food-showmore",
    });
  }

  const base = (opts.deepLinkBase ?? "").replace(/\/$/, "");
  if (base) {
    actions.push({
      label: "＋ More…",
      url: `${base}/nutrition`,
      row: "food-more",
    });
  }

  const tally = tallyLine(dayServings);
  const lines = ["Tap what you've eaten to log a serving."];
  if (tally) lines.push(tally);
  if (opts.proteinLine) lines.push(opts.proteinLine);
  const body = lines.join("\n");

  return { title: `🍽️ ${window} food log`, body, actions, kind: "food" };
}
