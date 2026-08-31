"use client";

import { useRef } from "react";
import { usePathname } from "next/navigation";
import {
  IconBarbell,
  IconLayoutDashboard,
  IconMenu2,
  IconPlus,
  IconSearch,
  IconTimelineEvent,
} from "@tabler/icons-react";
import PendingNavLink from "./PendingNavLink";
import { openGlobalSearch } from "./CommandPalette";
import { useMobileChrome } from "./MobileChromeProvider";
import {
  BOTTOM_EDGE_NAV_ROW_HEIGHT,
  useBottomEdgeClaim,
} from "@/components/overlay";
import {
  activeDockSlotId,
  dockSlots,
  type DockIcon,
  type DockSlot,
} from "@/lib/mobile-dock";

// THE PHONE'S BOTTOM CHROME (issue #2651).
//
// Four slots and a raised log puck, along the bottom edge, below `md` only. The
// desktop sidebar is untouched — this is chrome, not a fork, and nothing about
// any page's CONTENT changes with it (the one-content-component rule holds: both
// viewports still render the same page and the same <SidebarContent>).
//
// ── IT IS NOW THE PHONE'S *ONLY* CHROME (#4102) ──────────────────────────────
//
// The top bar retired. There is no longer a second permanently-visible strip
// holding a magnifier and an identity bar, so this bar carries the two things it
// took over: SEARCH is a slot (it replaced Trends — "i realize i don't actually
// use trends that much"), and the identity bar moved to the top of the drawer
// that More opens. Everything above the first record on a phone is now spent by
// the PAGE, not by the shell.
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
//
// ── IT IS THE BOTTOM EDGE'S FLOOR ────────────────────────────────────────────
//
// LAYER 0 in components/overlay/tokens.ts: flush to `bottom-0`, below `md` only,
// and up for the whole session on every route. So it CLAIMS the edge
// (useBottomEdgeClaim) exactly as the workout dock does, and every notice — the
// toast stack, the offline pill, the rejected-writes panel, the update offer —
// clears it without knowing it exists. Without that claim a toast confirming a
// log would land on the very bar the log was tapped from, which is #1520's
// defect with a new occupant.
//
// ── THE PUCK IS FOR EVERY PROFILE ───────────────────────────────────────
//
// The puck remains useful at every life stage for food, body, and care logs. Its
// Train segment is removed while the workout product is not relevant.

const ICONS: Record<DockIcon, typeof IconPlus> = {
  dashboard: IconLayoutDashboard,
  barbell: IconBarbell,
  history: IconTimelineEvent,
  search: IconSearch,
  menu: IconMenu2,
};

const SLOT_CLASS =
  "press flex h-full min-w-0 flex-col items-center justify-center gap-0.5 text-slate-500 transition hover:text-slate-800 aria-[current=page]:text-brand-600 dark:text-slate-400 dark:hover:text-slate-100 dark:aria-[current=page]:text-brand-400";

const CAPTION_CLASS = "max-w-full truncate text-xs leading-none font-medium";

export default function MobileDock({
  trainingRelevant = true,
}: {
  trainingRelevant?: boolean;
}) {
  const pathname = usePathname();
  const { drawerOpen, setDrawerOpen, logSheetOpen, setLogSheetOpen } =
    useMobileChrome();
  const slots = dockSlots(trainingRelevant);
  const active = activeDockSlotId(slots, pathname);
  const edgeRef = useRef<HTMLElement>(null);
  useBottomEdgeClaim(edgeRef);

  const renderSlot = (slot: DockSlot) => {
    const Icon = ICONS[slot.icon];
    if (slot.href === null) {
      // The two slots that OPEN something rather than go somewhere. Both are
      // buttons, both deliberately carry no `aria-current` — claiming the drawer
      // or the search surface is "the page" would be a lie on every route — and
      // both have their visible caption as their accessible name, so neither is
      // an icon-only button needing an `aria-label`/`title` pair.
      //
      // More reports `aria-expanded` HONESTLY, because the provider owns the
      // drawer's boolean. Search does not, and that omission is the honest one:
      // the palette owns its own open state behind a window event
      // (`openGlobalSearch`), so any `aria-expanded` here would be a value this
      // component invented. `aria-haspopup="dialog"` is the part it can actually
      // vouch for — the surface it opens is a dialog.
      const isMore = slot.id === "more";
      return (
        <button
          key={slot.id}
          type="button"
          data-testid={`dock-slot-${slot.id}`}
          {...(isMore
            ? { "aria-expanded": drawerOpen }
            : { "aria-haspopup": "dialog" as const })}
          onClick={() => (isMore ? setDrawerOpen(true) : openGlobalSearch())}
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
      ref={edgeRef}
      // z-30 sits UNDER every overlay that must cover it: the nav drawer (z-40),
      // the bottom sheet (z-60) and the toasts (z-100). The one thing that also
      // owns the bottom edge — the minimized workout dock — is lifted clear of
      // this bar's height rather than stacked over it (BOTTOM_EDGE_ABOVE_NAV).
      className="fixed inset-x-0 bottom-0 z-30 border-t border-black/10 bg-(--nav) pb-[env(safe-area-inset-bottom)] md:hidden print:hidden dark:border-white/5"
    >
      {/* Five columns for every profile — four slots and the puck's own column. */}
      <div
        className={`grid ${BOTTOM_EDGE_NAV_ROW_HEIGHT} grid-cols-5 items-stretch`}
      >
        {renderSlot(first)}
        {renderSlot(second)}
        <div className="relative">
          {/* The raised puck. It breaks the bar's plane on purpose: the one
          control here that WRITES rather than navigates should not look like a
          fifth destination. Icon-only, so it carries both an `aria-label` and a
          `title` per the icon-button rule. */}
          <button
            type="button"
            aria-label="Log"
            aria-expanded={logSheetOpen}
            data-testid="dock-log-puck"
            onClick={() => setLogSheetOpen(true)}
            className="press absolute -top-5 left-1/2 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full bg-(--btn) text-(--btn-fg) shadow-lg ring-4 ring-(--nav) transition hover:bg-(--btn-hover)"
          >
            <IconPlus className="h-7 w-7" stroke={2} />
          </button>
        </div>
        {renderSlot(third)}
        {renderSlot(fourth)}
      </div>
    </nav>
  );
}
