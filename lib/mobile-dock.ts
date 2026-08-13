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
// Because the slot set is CONTEXTUAL and the contexts are the app's existing
// ones. An age-restricted profile (lib/age-gate.ts) has no training surface at
// all, so a Training slot there is a dock slot spent on a 404-in-spirit; it
// takes Timeline instead. Deciding that in the component would put an
// untestable `restricted ? … : …` inside a fixed-position element that only
// renders below `md`, which is precisely the shape nobody notices is wrong.
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
  "dashboard" | "barbell" | "timeline" | "trending" | "menu";

export type DockSlotId = "home" | "training" | "timeline" | "trends" | "more";

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
 * Home · Training · [puck] · Trends · More.
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
// The restricted-profile stand-in. Timeline is the right substitute rather than
// Nutrition or Medical: it is the one surface whose CONTENT is already
// age-filtered by the same gate (the layout passes `restricted` into
// getTimelineDates), so the slot leads somewhere honest for that profile instead
// of somewhere merely allowed.
const TIMELINE: DockSlot = {
  id: "timeline",
  label: "Timeline",
  icon: "timeline",
  href: "/timeline",
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
 *
 * `restricted` is the age gate the whole shell already resolves once
 * (lib/age-gate.ts) and threads into MobileNav — never re-derived here.
 */
export function dockSlots(restricted: boolean): DockSlot[] {
  return [HOME, restricted ? TIMELINE : TRAINING, TRENDS, MORE];
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
