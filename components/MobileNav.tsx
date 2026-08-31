"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import SidebarContent from "@/components/SidebarContent";
import QuickLogSheet from "@/components/QuickLogSheet";
import { useLockBodyScroll } from "@/components/useLockBodyScroll";
import { useFocusTrap } from "@/components/useFocusTrap";
import { usePresence } from "@/components/usePresence";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { useMobileChrome } from "@/components/MobileChromeProvider";
import {
  overlayMotionClass,
  useDragGesture,
  useOverlayDrag,
  OVERLAY_SCRIM,
} from "@/components/overlay";
import { motionMs } from "@/lib/motion";
import type { SegmentLogDays } from "@/lib/log-sheet";
import type { SessionProfile } from "@/lib/auth";
import { DEFAULT_NAV_RELEVANCE, type NavRelevance } from "@/lib/nav-relevance";

// The phone's slide-in nav drawer and its quick-log sheet. The desktop sidebar in
// app/layout.tsx is hidden below `md`; this surfaces the same navigation on
// phones by rendering the shared <SidebarContent> (the single source of truth for
// the sidebar's contents) inside the drawer, so the two viewports can't drift
// apart. The dock owns both visible triggers (#2745/#2746).
//
// ── THE TOP BAR IS GONE, AND THIS FILE NOW RENDERS NO CHROME AT ALL (#4102) ──
//
// It used to open with a `md:hidden` <header> holding an identity bar (or the
// wordmark) and a magnifier. #2746 deferred one question — whether that remnant
// should fold into the dock too — and the 2026-08-29 ruling answered it: yes. The
// dock is the phone's ONE chrome. Search became a dock slot, the identity bar
// moved to the TOP OF THE DRAWER below (where the ✕ already lives), and the
// mobile chrome budget above the first record is spent by pages rather than by
// the shell — a tab-first page keeps its own sticky strip, mounted standalone.
//
// What is left here is two OVERLAYS and the gestures that drive them, so the file
// contributes zero pixels until something opens. It is therefore no longer a
// child of <ShellChrome> (which exists to make the sticky bar hide on scroll, and
// has no bar to hide any more); it is a sibling of <main>, like the dock.
//
// The identity bar's #1801 rule survives the move INTACT rather than being
// dropped: identity chrome when identity is ambiguous, brand chrome when it is
// not — the XOR now resolves inside the drawer instead of inside the bar, which
// is what <SidebarContent>'s `brandChrome` does. What changed is only WHERE the
// answer is read, and the cost of that is one tap on More.
//
// Edge-swipe-right remains a gesture route to the drawer.
//
// IT IS A MODAL, AND IT SAYS SO (#3463). The drawer is a hand-rolled modal
// surface — it portals to <body>, covers the viewport with its own scrimmed
// `fixed inset-0`, locks the body behind it and takes a click-to-dismiss
// backdrop — and for a long time it declared none of that: no `role`, no
// `aria-modal`, no focus trap, so a keyboard or screen-reader user could tab
// straight out of it into the scroll-locked page underneath. Its presentation
// exception in docs/internals/overlays.md is about the edge anatomy below, which
// a centred host cannot express, and never was a licence to skip the a11y floor.
// So it now declares the role and
// takes the SHARED useFocusTrap, which owns initial focus, the Tab trap,
// capture-phase Escape and focus restore to the control that opened it. The edge
// swipe, the backdrop and the drag are untouched.
//
// The drawer slides in and out (issue #1416, section F): usePresence keeps it
// mounted for the length of its exit animation and then unmounts it for real, so
// it animates both ways without leaving a second copy of the whole navigation in
// the accessibility tree. Reduced motion collapses both durations to 0 — same
// states, no travel.

export default function MobileNav({
  active,
  username,
  profiles,
  viewIds = [],
  readOnlyIds = [],
  adultContentAvailable = true,
  trainingRelevant = true,
  isAdmin = false,
  multiProfile = false,
  foodLoggingRelevant = true,
  hasIntakeItems = false,
  relevance = DEFAULT_NAV_RELEVANCE,
  reviewCount = 0,
  readOnly = false,
  whatsNewUnseen = false,
  substanceRelevant = false,
  logHabitDays = null,
}: {
  // The active profile + accessible profiles feed the shared sidebar's profile
  // bar + switcher panel (#1801); resolved from the session on the server.
  active: SessionProfile;
  // The signed-in login's username — threaded into the shared SidebarContent so the
  // drawer's profile menu shows "Signed in as <username>" like the desktop (#1013).
  username: string;
  profiles: SessionProfile[];
  // The session's multi-profile VIEW-SET (issue #1096) — the stacked avatars on
  // the bar and the panel's view toggles read the same validated set.
  viewIds?: readonly number[];
  // Accessible profiles held READ-only by this login (issue #33) — the per-row
  // hint in the switcher panel.
  readOnlyIds?: number[];
  // Known-adult predicate for the Longevity nav entry.
  adultContentAvailable?: boolean;
  // False through early childhood; hides workout logging and navigation.
  trainingRelevant?: boolean;
  // Reveals the admin-only nav entries (the household overview) in the drawer.
  isAdmin?: boolean;
  // True when the instance has >1 profile; gates the Household overview.
  multiProfile?: boolean;
  // True unless the active profile is an infant (< 1 y); gates Nutrition (#591).
  foodLoggingRelevant?: boolean;
  // True when the active profile tracks any intake item (#746); keeps Nutrition
  // (→ Supplements tab) reachable for an infant supplement user.
  hasIntakeItems?: boolean;
  // Server-resolved relevance bitset (issue #1042) gating Cycle/Vision/Dental;
  // threaded into the shared SidebarContent so the drawer matches the desktop.
  relevance?: NavRelevance;
  // Integrations-needing-attention count for the profile-menu badge (Data →
  // Review). Resolved on the server and threaded through the shared sidebar.
  reviewCount?: number;
  // Active profile shared read-only with this login (issue #33) — badge hint.
  readOnly?: boolean;
  // Unopened bundled release notes for this login (issue #1421); threaded into the
  // shared SidebarContent so the drawer shows the same calm "What's new" dot.
  whatsNewUnseen?: boolean;
  // Days-logged per sheet segment over the trailing quarter (#2709), resolved once
  // by the shell. Passed straight through to the sheet, which consults it on the
  // DASHBOARD only; null means "not gathered", and the route's own default stands.
  substanceRelevant?: boolean;
  logHabitDays?: SegmentLogDays | null;
}) {
  // The dock's More slot and puck own the two visible triggers (#2745/#2746), and
  // the dock is rendered outside <ShellChrome> (a transformed ancestor re-parents
  // `position: fixed`). The booleans therefore live in the shared provider one
  // level up; the OVERLAYS still live here, and navigation owns their lifetime.
  const {
    drawerOpen: open,
    setDrawerOpen: setOpen,
    logSheetOpen: sheetOpen,
    setLogSheetOpen: setSheetOpen,
  } = useMobileChrome();
  const reduceMotion = usePrefersReducedMotion();
  const drawer = usePresence(open, motionMs("drawer", reduceMotion));
  const drawerRef = useRef<HTMLElement>(null);

  // Swipe-left on the open drawer closes it — the shared recognizer, the
  // drawer's own outcome (#1425/#1469). The whole panel is the grab area rather
  // than a handle: its only scrollable axis is vertical, so a leftward drag has
  // no rival, and the axis lock abandons anything that turns out to be the
  // vertical scroll the drawer's own content needs. Enabled only while open, so
  // the exit animation can't be re-grabbed.
  const { suppressMotion } = useOverlayDrag({
    panelRef: drawerRef,
    direction: "left",
    onOutcome: () => setOpen(false),
    // The latch expires with the panel it protects (#2725): this drawer's panel
    // unmounts between opens, so a remounted one is owed its slide again.
    panelMounted: drawer.mounted,
    enabled: open,
  });

  // Edge-swipe-right from the left screen edge OPENS it. The dock's More slot is
  // the discoverable, pointer- and keyboard-reachable route.
  //
  // Unlike the close drag this one does not follow the finger: the drawer is not
  // mounted when the gesture starts, and mounting the entire navigation tree
  // mid-gesture to chase a thumb trades a guaranteed frame drop for a few
  // millimetres of polish. It commits at the same threshold and then plays the
  // ordinary enter animation.
  useDragGesture({
    direction: "right",
    requireEdgeStart: true,
    enabled: !open,
    onCommit: () => {
      // The drawer IS the phone's navigation — the portal below is `md:hidden`,
      // so opening it on a wide touchscreen would lock the page's scroll behind
      // an overlay nobody can see.
      if (window.matchMedia("(min-width: 768px)").matches) return;
      setOpen(true);
    },
  });

  // While mounted (including through the exit animation): lock body scroll.
  useLockBodyScroll(drawer.mounted);
  // The a11y floor, from the shared hook rather than hand-rolled (#3463). It
  // replaces this file's own `document` keydown listener for Escape, and brings
  // the three things that listener never had: initial focus into the panel, a Tab
  // trap so focus cannot leave it for the page it has scroll-locked, and focus
  // restored to the opener (the dock's More slot) on close.
  //
  // ACTIVE ON `open`, NOT ON `drawer.mounted`: the panel outlives `open` by the
  // length of its exit animation, and trapping focus inside a panel that is on its
  // way out would hold the keyboard hostage for 240ms. Deactivating on `open` is
  // also what RUNS the restore, so focus lands back on More as the drawer starts
  // to leave rather than after it has gone.
  //
  // Escape still reaches a layer opened INSIDE or OVER the drawer first: the hook
  // yields to `[data-escape-layer="true"]` and to any nearer `[role="dialog"]`
  // (#3409/#3425), which is the seam that keeps the quick-log sheet closing by
  // itself while the drawer stays open behind it.
  useFocusTrap({
    panelRef: drawerRef,
    onClose: () => setOpen(false),
    active: open,
  });

  const phase = drawer.phase === "enter" ? "enter" : "exit";
  // A hand-dragged panel owns its transform for the rest of its life (see
  // useOverlayDrag) — a keyframe class on top would outrank the inline transform
  // and freeze the drag mid-swipe.
  const backdropMotion = overlayMotionClass("scrim", phase, reduceMotion);
  const panelMotion = suppressMotion
    ? ""
    : overlayMotionClass("left", phase, reduceMotion);

  return (
    <>
      {/* Portalled to <body> ON PURPOSE, and still, after the bar retired. The
      reason used to be <ShellChrome>'s hide-on-scroll transform re-parenting
      `position: fixed` to itself; this component has left that wrapper, so the
      surviving reasons are the ordinary ones — a full-screen overlay must escape
      every ancestor's stacking context, overflow clip and transform, whatever
      the shell later grows. (BottomSheet portals for the same reason.) */}
      {drawer.mounted &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-40 md:hidden">
            <div
              className={`${OVERLAY_SCRIM} ${backdropMotion}`}
              onClick={() => setOpen(false)}
              aria-hidden
              data-testid="mobile-drawer-backdrop"
            />
            <aside
              ref={drawerRef}
              data-testid="mobile-drawer"
              // A DIALOG, DECLARED (#3463). `aria-modal` is what tells assistive
              // technology that the scroll-locked page behind the scrim is out of
              // play; the label is the one the close control already uses, so the
              // surface and its dismissal name the same thing.
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
              // 20rem, AND NOTHING ELSE (#4102's anti-drop census, owner
              // 2026-08-29: "its width floor drops the `--week-grid-min` term —
              // #3452's calendar arithmetic leaves with the calendar; 20rem
              // preferred stands alone"). The drawer was as wide as a week plus
              // its own border and the left inset because the calendar band
              // inside it had to render seven 44px columns; that band is on
              // /history now, and this was its ONLY remaining claim on the width.
              // MEASURED, because the term looked load-bearing and was not: at
              // both a 320px and a 390px viewport the drawer rendered 320px
              // before this change and 320px after — `max(20rem, 308px + 1px +
              // 0)` was already 20rem wherever the safe-area inset is under 11px,
              // which is every headless run and every un-notched device. What
              // actually changes is the notched case, where the drawer stops
              // widening past 20rem to buy columns it no longer draws.
              // `max-w-full` still clamps it on a viewport narrower than that.
              className={`absolute inset-y-0 left-0 flex w-80 max-w-full flex-col gap-4 overflow-y-auto overscroll-contain border-r border-black/10 bg-(--nav) pt-[max(1rem,env(safe-area-inset-top))] pr-4 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] dark:border-white/5 ${panelMotion}`}
            >
              <SidebarContent
                active={active}
                username={username}
                profiles={profiles}
                viewIds={viewIds}
                readOnlyIds={readOnlyIds}
                // THE HOST, named once (#3343 Q4). It carries both of the
                // drawer's departures from the sidebar: no identity bar (on a
                // phone that bar lives in the top bar, readable without opening
                // anything — #1801), and nav groups inline rather than folded.
                inDrawer
                adultContentAvailable={adultContentAvailable}
                trainingRelevant={trainingRelevant}
                isAdmin={isAdmin}
                multiProfile={multiProfile}
                foodLoggingRelevant={foodLoggingRelevant}
                hasIntakeItems={hasIntakeItems}
                relevance={relevance}
                reviewCount={reviewCount}
                readOnly={readOnly}
                whatsNewUnseen={whatsNewUnseen}
                substanceRelevant={substanceRelevant}
                logHabitDays={logHabitDays}
                onNavigate={() => setOpen(false)}
                onClose={() => setOpen(false)}
              />
            </aside>
          </div>,
          document.body
        )}

      <QuickLogSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        // The same server-resolved relevance bitset the drawer's nav entries gate on,
        // so the sheet's period row and the Cycle nav entry appear together (#1892).
        cycleRelevant={relevance.cycle}
        // #3327: the substance row appears only for a profile that actually tracks
        // one. Resolved by the shell beside the bitset above rather than living in
        // it — it is not a nav gate, and no nav entry reads it.
        substanceRelevant={substanceRelevant}
        logHabitDays={logHabitDays}
      />
    </>
  );
}
