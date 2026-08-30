// The phone's bottom dock (issue #2651) — the pure half.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// On a phone every daily verb lived outside the thumb. Navigation was a
// TOP-LEFT hamburger → drawer row: two taps, and the first of them in the corner
// furthest from a right thumb, so the real cost includes a regrip the tap census
// (#1510) never counted. This module is the registry behind the fix: four
// destination slots along the bottom edge, each ONE tap, plus a raised centre
// puck that opens the log sheet.
//
// ── WHY A REGISTRY AND NOT FOUR JSX ROWS ─────────────────────────────────────
//
// Because the slot set is a registry rather than four JSX rows, order and route
// matching stay pure and testable.
//
// ── WHAT IT DELIBERATELY IS NOT ──────────────────────────────────────────────
//
// It is not a second nav model. `isRouteActive` (lib/nav.ts) — the SAME
// predicate the sidebar's <Nav> lights its rows with, registry-parent map
// included — decides which slot is current, so the dock and the drawer can never
// disagree about where you are. And no slot carries a count, a dot or a badge:
// the dock never campaigns for attention (the findings reach policy is
// unchanged, and the owner's #2651 call 2 removed the only slot that raised the
// question).

import type { AppRoute } from "./hrefs";
import { isRouteActive } from "./nav";

// Icon keys resolved to real Tabler icons in components/MobileDock.tsx — the
// registry stays pure and serializable, like QUICK_LOG_ITEMS.
export type DockIcon =
  "dashboard" | "barbell" | "history" | "trending" | "menu";

export type DockSlotId = "home" | "training" | "history" | "trends" | "more";

export interface DockSlot {
  id: DockSlotId;
  /** The visible caption AND the link's accessible name — one string. */
  label: string;
  icon: DockIcon;
  /**
   * The destination, or null for the one slot that is a DISCLOSURE rather than a
   * place: "More" opens the existing drawer (the full nav, demoted to the long
   * tail) instead of navigating anywhere.
   */
  href: AppRoute | null;
}

/**
 * Four, always — two either side of the puck. A fifth would put a destination
 * under the raised centre control, and a third would leave the row visibly
 * unbalanced; the owner's resolution (#2651, 2026-08-13) fixes the set at
 * Home · Training · [puck] · Trends · More, with History replacing
 * Training through early childhood so the four-slot geometry stays balanced.
 */
export const DOCK_SLOT_COUNT = 4;

const HOME: DockSlot = {
  id: "home",
  label: "Home",
  icon: "dashboard",
  href: "/",
};
const TRAINING: DockSlot = {
  id: "training",
  label: "Training",
  icon: "barbell",
  href: "/training",
};
const HISTORY: DockSlot = {
  id: "history",
  label: "History",
  icon: "history",
  href: "/history",
};
const TRENDS: DockSlot = {
  id: "trends",
  label: "Trends",
  icon: "trending",
  href: "/trends",
};
const MORE: DockSlot = {
  id: "more",
  label: "More",
  icon: "menu",
  href: null,
};

/**
 * The dock's four slots, in tap order (left to right; the puck sits between
 * index 1 and index 2).
 * Training is replaced by History when the workout product is not relevant.
 *
 * THE SECOND SLOT'S OCCUPANT, RULED (#3343 Q5, owner 2026-08-29):
 * `trainingRelevant ? TRAINING : HISTORY`. `/timeline` held this slot and #3958
 * phase 2 retires the route, so the record — which absorbed the timeline's content
 * — is its literal successor and serves the audience the slot existed for. The dock
 * stays fixed at FOUR (#2651) and no other slot changes. Upcoming was considered and
 * rejected (a permanent slot is too big a bet on a surface the attention pipeline may
 * not be sending people to); Nutrition was rejected (it breaks the slot's
 * review-shaped identity mid-rebuild of #3987). Do not revisit either.
 */
export function dockSlots(trainingRelevant = true): DockSlot[] {
  return [HOME, trainingRelevant ? TRAINING : HISTORY, TRENDS, MORE];
}

/**
 * Which slot is the page being viewed, or null when the current route lives in
 * the long tail behind More.
 *
 * Null is the honest answer there and "More" is deliberately NOT it: More is a
 * disclosure button, and `aria-current="page"` on a control that opens a drawer
 * would claim the drawer is the page. A route with no slot lights nothing — the
 * same thing the sidebar does for a route with no nav row.
 */
export function activeDockSlotId(
  slots: readonly DockSlot[],
  pathname: string
): DockSlotId | null {
  for (const slot of slots) {
    if (slot.href !== null && isRouteActive(slot.href, pathname))
      return slot.id;
  }
  return null;
}
