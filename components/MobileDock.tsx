"use client";

import { usePathname } from "next/navigation";
import {
  IconBarbell,
  IconLayoutDashboard,
  IconMenu2,
  IconPlus,
  IconTimelineEvent,
  IconTrendingUp,
} from "@tabler/icons-react";
import PendingNavLink from "./PendingNavLink";
import { useMobileChrome } from "./MobileChromeProvider";
import {
  activeDockSlotId,
  dockSlots,
  type DockIcon,
  type DockSlot,
} from "@/lib/mobile-dock";

// THE PHONE'S BOTTOM CHROME (issue #2651).
//
// Four destination slots and a raised log puck, along the bottom edge, below
// `md` only. The desktop sidebar is untouched — this is chrome, not a fork, and
// nothing about any page's CONTENT changes with it (the one-content-component
// rule holds: both viewports still render the same page and the same
// <SidebarContent>).
//
// ── WHY THE BOTTOM ───────────────────────────────────────────────────────────
//
// Because that is where the thumb is. Navigation used to start at the top-LEFT
// hamburger, the corner furthest from a right thumb, and cost two taps plus a
// regrip the #1510 tap census never counted. Four of the app's destinations are
// now one tap from resting position, and the drawer survives behind More as the
// long tail — demoted, not removed. Relevance-gating of nav rows is unchanged,
// because the drawer's rows are unchanged.
//
// ── IT NEVER CAMPAIGNS ───────────────────────────────────────────────────────
//
// No badge, no count, no dot on any slot or on the puck. Permanently-visible
// chrome is the worst possible place to raise attention: it is on screen for
// every second of every page, so anything it displays is displayed forever. The
// findings reach policy (docs/internals/findings.md) is unchanged by this file,
// and the owner's #2651 call 2 removed the only slot that raised the question.
//
// ── THE SLOTS ARE NAV ROWS, WITH THE NAV ROW'S DISCIPLINE ────────────────────
//
// `<PendingNavLink>`, not a bare `<Link>`, for exactly the reason the sidebar
// uses it (#1956): `(app)` ships no `loading.tsx`, so a tap has no visible
// consequence until the whole destination has rendered — which is what made
// people tap again, and each extra tap discards the render already in flight. A
// dock slot is if anything MORE exposed to that than a sidebar row, because it
// is reachable without opening anything. The spinner takes the icon's own slot
// (no layout shift in a 56px-tall bar) and `lib/nav-click.ts` decides which
// repeat taps are absorbed — never a modified or middle click.
//
// Which slot is current is `isRouteActive` through lib/mobile-dock.ts — the SAME
// predicate the sidebar lights its rows with, registry-parent map included, so
// the dock and the drawer can never disagree about where you are.

const ICONS: Record<DockIcon, typeof IconPlus> = {
  dashboard: IconLayoutDashboard,
  barbell: IconBarbell,
  timeline: IconTimelineEvent,
  trending: IconTrendingUp,
  menu: IconMenu2,
};

const SLOT_CLASS =
  "tap-target press flex h-full min-w-0 flex-col items-center justify-center gap-0.5 text-slate-500 transition hover:text-slate-800 aria-[current=page]:text-brand-600 dark:text-slate-400 dark:hover:text-slate-100 dark:aria-[current=page]:text-brand-400";

const CAPTION_CLASS = "max-w-full truncate text-xs leading-none font-medium";

export default function MobileDock({
  restricted = false,
}: {
  // The age gate the shell already resolves once (lib/age-gate.ts). A restricted
  // profile has no training surface, so its second slot is Timeline — and it gets
  // no puck, mirroring the top bar, which has hidden the quick-log cluster for a
  // restricted profile since #1416.
  restricted?: boolean;
}) {
  const pathname = usePathname();
  const { drawerOpen, setDrawerOpen, logSheetOpen, setLogSheetOpen } =
    useMobileChrome();
  const slots = dockSlots(restricted);
  const active = activeDockSlotId(slots, pathname);

  const renderSlot = (slot: DockSlot) => {
    const Icon = ICONS[slot.icon];
    if (slot.href === null) {
      // More is a DISCLOSURE, not a destination: it carries `aria-expanded`
      // (honest, because the provider owns the drawer's state) and deliberately
      // no `aria-current` — claiming the drawer is "the page" would be a lie on
      // every route. Its visible caption is its accessible name, so it is not an
      // icon-only button and needs no `aria-label`/`title` pair.
      return (
        <button
          key={slot.id}
          type="button"
          data-testid={`dock-slot-${slot.id}`}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
          className={SLOT_CLASS}
        >
          <Icon className="h-6 w-6" stroke={1.75} />
          <span className={CAPTION_CLASS}>{slot.label}</span>
        </button>
      );
    }
    return (
      <PendingNavLink
        key={slot.id}
        href={slot.href}
        label={slot.label}
        testId={`dock-slot-${slot.id}`}
        current={active === slot.id}
        icon={<Icon className="h-6 w-6 shrink-0" stroke={1.75} />}
        className={SLOT_CLASS}
      >
        <span className={CAPTION_CLASS}>{slot.label}</span>
      </PendingNavLink>
    );
  };

  const [first, second, third, fourth] = slots;

  return (
    <nav
      aria-label="Primary"
      data-testid="mobile-dock"
      data-active-slot={active ?? ""}
      // NOT inside <ShellChrome>: that wrapper transforms itself to hide on
      // scroll, and a transformed ancestor re-parents `position: fixed` to
      // itself — the dock would slide off the bottom of the screen with the top
      // bar. It is a sibling of <main> instead, which also means it renders on
      // the server like the rest of the shell (no portal, no first-paint gap).
      //
      // z-30 sits UNDER every overlay that must cover it: the nav drawer (z-40),
      // the bottom sheet (z-60) and the toasts (z-100). The one thing that also
      // owns the bottom edge — the minimized workout dock — is lifted clear of
      // this bar's height rather than stacked over it (see WorkoutDock).
      className="fixed inset-x-0 bottom-0 z-30 border-t border-black/10 bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden print:hidden dark:border-white/5 dark:bg-ink-950/90"
    >
      <div
        className={`grid h-14 items-stretch ${
          restricted ? "grid-cols-4" : "grid-cols-5"
        }`}
      >
        {renderSlot(first)}
        {renderSlot(second)}
        {!restricted && (
          <div className="relative">
            {/* The raised puck. It breaks the bar's plane on purpose: the one
            control here that WRITES rather than navigates should not look like a
            fifth destination. Icon-only, so it carries both an `aria-label` and a
            `title` per the icon-button rule. */}
            <button
              type="button"
              aria-label="Log"
              title="Log"
              aria-expanded={logSheetOpen}
              data-testid="dock-log-puck"
              onClick={() => setLogSheetOpen(true)}
              className="press absolute -top-5 left-1/2 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg ring-4 ring-white transition hover:bg-brand-700 dark:ring-ink-950"
            >
              <IconPlus className="h-7 w-7" stroke={2} />
            </button>
          </div>
        )}
        {renderSlot(third)}
        {renderSlot(fourth)}
      </div>
    </nav>
  );
}
