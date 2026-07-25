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
// No new write paths: every entry either opens the shared activity editor
// through the ActivityEditor context (the same `openCreate` the bar always
// called) or navigates to an EXISTING form, reusing the `FOCUS_PARAM`
// convention (lib/palette-actions.ts) where the destination already honors it.
// The target union is deliberately the palette's own `PaletteActionTarget`
// shape — the palette and the bar are two surfaces over the same idea, and a
// third divergent "how do I open a create form" encoding is how surfaces drift.

import type { AppRoute } from "./hrefs";
import { MEDICATIONS_HREF, nutritionTabHref } from "./hrefs";
import { FOCUS_PARAM } from "./palette-actions";

// Icon keys resolved to real Tabler icons in components/QuickLogSheet.tsx (the
// registry stays pure/serializable, like PALETTE_ACTIONS).
export type QuickLogIcon = "barbell" | "salad" | "pill" | "scale";

export type QuickLogTarget =
  // Open the shared activity editor overlay in place (no navigation).
  | { kind: "activity" }
  // Navigate to the existing create surface.
  | { kind: "navigate"; href: AppRoute };

export interface QuickLogItem {
  id: string;
  // The bar button's accessible name AND the sheet row's label — one string, so
  // "the + on Nutrition" and "Log food in the sheet" can never disagree.
  label: string;
  // One-line "what this opens", shown in the sheet only.
  hint: string;
  icon: QuickLogIcon;
  target: QuickLogTarget;
  // True for the entries only a training-capable profile should see. An
  // age-restricted profile (lib/age-gate.ts) has no training surface at all, so
  // the bar hides its create actions entirely there — same posture as today.
  training?: boolean;
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
    training: true,
  },
  {
    id: "log-food",
    label: "Log food",
    hint: "Today's servings by food group",
    icon: "salad",
    // The Food tab IS the quick-add form; no focus param exists there, and
    // inventing one would be a new surface contract for no gain.
    target: { kind: "navigate", href: nutritionTabHref("food") },
  },
  {
    id: "log-dose",
    label: "Log dose",
    hint: "Confirm a scheduled or as-needed dose",
    icon: "pill",
    // The Medications page's Today panel holds the dose-confirm buttons — the
    // existing write path (markDoseTaken), reached, not re-implemented.
    target: { kind: "navigate", href: MEDICATIONS_HREF },
  },
  {
    id: "log-weight",
    label: "Log weight",
    hint: "Bodyweight and vitals",
    icon: "scale",
    // The SAME href the palette's "Log weight" action uses — BodyQuickAdd reads
    // `?new=weight` and focuses its weight field on arrival.
    target: {
      kind: "navigate",
      href: `/trends?tab=body&${FOCUS_PARAM}=weight`,
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
  // Body metrics live behind /trends?tab=body — the tab, not the route, is the
  // thing that makes "log weight" the obvious action.
  if (under(pathname, "/trends") && tab === "body") {
    return quickLogItem("log-weight");
  }
  return quickLogItem(LOG_ACTIVITY_ID);
}

// The bar shows the activity-specific pair (start a live workout, repeat last)
// ONLY where the primary action is itself the activity editor — on Nutrition or
// Medications they are noise competing for a 390px-wide bar.
export function showsActivityShortcuts(primary: QuickLogItem): boolean {
  return primary.target.kind === "activity";
}

// The sheet's menu for a given profile: an age-restricted profile has no
// training surface, so the training-only entries are dropped (the same gate the
// bar's create actions have always carried).
export function quickLogMenu(restricted: boolean): QuickLogItem[] {
  return restricted
    ? QUICK_LOG_ITEMS.filter((i) => !i.training)
    : QUICK_LOG_ITEMS;
}
