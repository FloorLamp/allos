"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { IconSearch } from "@tabler/icons-react";
import Wordmark from "@/components/Wordmark";
import ProfileIdentityBar from "@/components/ProfileIdentityBar";
import SidebarContent from "@/components/SidebarContent";
import QuickLogSheet from "@/components/QuickLogSheet";
import { openGlobalSearch } from "@/components/CommandPalette";
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
import type { AppVersion } from "@/lib/version";
import { DEFAULT_NAV_RELEVANCE, type NavRelevance } from "@/lib/nav-relevance";

// Mobile-only top bar + slide-in drawer. The desktop sidebar in app/layout.tsx is
// hidden below `md`; this surfaces the same navigation on phones by rendering the
// shared <SidebarContent> (the single source of truth for the sidebar's contents)
// inside the drawer, so the two viewports can't drift apart. Only the
// collapsed top bar — identity and search — is mobile-specific chrome and lives
// here. The dock owns the drawer and quick-log triggers (#2745/#2746).
//
// The bar is no longer sticky ITSELF: <ShellChrome> wraps it in the one sticky,
// auto-hiding element (issue #1416). Everything about scroll behavior lives
// there; this file owns the bar's contents and the drawer.
//
// The left cluster (issue #1801): the identity bar takes the WORDMARK'S slot on
// a multi-profile instance, so "whose data is this, and who am I acting as?" is
// answerable without opening anything. A single-profile instance keeps the
// wordmark — identity chrome when identity is ambiguous, brand chrome when it
// isn't.
//
// Search remains one tap from every page. The former contextual +, caret, and
// workout bolt were a second permanently-visible logging cluster beside the dock
// puck; #2745 moved the workout offer into the sheet's Train segment and retired
// all three. #2746 likewise made the dock's More slot the sole visible drawer
// trigger. Edge-swipe-right remains a gesture route to that same drawer.
//
// IT IS A MODAL, AND IT SAYS SO (#3463). The drawer is a hand-rolled modal
// surface — it portals to <body>, covers the viewport with its own scrimmed
// `fixed inset-0`, locks the body behind it and takes a click-to-dismiss
// backdrop — and for a long time it declared none of that: no `role`, no
// `aria-modal`, no focus trap, so a keyboard or screen-reader user could tab
// straight out of it into the scroll-locked page underneath. Its RECORDED
// EXCEPTION (scripts/dialog-census-core.ts, docs/internals/overlays.md) is about
// PRESENTATION — the edge anatomy below, which a centred host cannot express —
// and never was a licence to skip the a11y floor. So it now declares the role and
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
  activityDates,
  version,
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
  activityDates: string[];
  // Resolved on the server (git/env) and passed in — this client component
  // can't read the commit hash itself.
  version: AppVersion;
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
  // to leave rather than after it has gone. Same call ProfileIdentityBar makes.
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
      {/* pt + max() side padding keep the bar clear of the notch/status bar now
      that the viewport paints edge-to-edge (viewportFit cover in app/layout.tsx).
      Stickiness lives on the <ShellChrome> wrapper, not here. */}
      <header className="border-b border-black/10 bg-(--nav) pt-[env(safe-area-inset-top)] md:hidden print:hidden dark:border-white/5">
        <div className="flex h-14 items-center gap-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
          {/* The identity bar takes the WORDMARK'S SLOT on a multi-profile
              instance (issue #1801). In a personal health app the brand line
              spends ~90px of a 390px bar saying nothing, while "whose data is
              this?" had no answer on this screen at all; home stays one tap away
              in the drawer, and the desktop sidebar and login screen keep the
              wordmark. On a single-profile instance identity is unambiguous, so
              the wordmark stays exactly as it was. */}
          {multiProfile ? (
            <ProfileIdentityBar
              profiles={profiles}
              actingProfileId={active.id}
              viewIds={viewIds}
              readOnlyIds={readOnlyIds}
              readOnly={readOnly}
              surface="mobile"
            />
          ) : (
            <Link href="/" className="flex items-center gap-2">
              <Wordmark markClassName="h-5 w-9" />
            </Link>
          )}
          <div className="ml-auto -mr-1 flex items-center">
            {/* Global search, one tap from every page (issue #1416). Opens the
                same CommandPalette the drawer's search button and ⌘K do. */}
            <button
              type="button"
              aria-label="Search"
              data-testid="search-mobile"
              onClick={() => openGlobalSearch()}
              className="tap-target press flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
            >
              <IconSearch className="h-5 w-5" stroke={1.75} />
            </button>
          </div>
        </div>
      </header>

      {/* Portalled to <body> ON PURPOSE. The bar lives inside <ShellChrome>,
      which TRANSFORMS itself to hide on scroll — and a transformed ancestor turns
      `position: fixed` into "fixed relative to that ancestor", which would drag
      the full-screen drawer along with the bar's slide. Rendering it at the body
      keeps the overlay anchored to the viewport no matter what the chrome is
      doing. (BottomSheet portals for the same reason.) */}
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
              // AT LEAST AS WIDE AS A WEEK, plus this drawer's own 1px right
              // border and the left safe-area inset. `--week-grid-min` is where
              // seven tap-floor columns are costed (app/globals.css, #3452); the
              // navigation shell no longer restates the calendar's arithmetic, it
              // just pays the bill. 20rem is still the PREFERRED width — the token
              // only raises it once a safe-area inset eats into the content box.
              // At that width the drawer may fill a small viewport; the explicit
              // close button and the swipe remain the dismissal paths (#3536).
              // Desktop is unaffected.
              className={`absolute inset-y-0 left-0 flex w-[max(20rem,calc(var(--week-grid-min)+1px+env(safe-area-inset-left)))] max-w-full flex-col gap-4 overflow-y-auto overscroll-contain border-r border-black/10 bg-(--nav) pt-[max(1rem,env(safe-area-inset-top))] pr-4 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] dark:border-white/5 ${panelMotion}`}
            >
              <SidebarContent
                activityDates={activityDates}
                version={version}
                active={active}
                username={username}
                profiles={profiles}
                viewIds={viewIds}
                readOnlyIds={readOnlyIds}
                // The drawer does NOT carry the identity bar: on a phone the bar
                // lives in the top bar, where it is readable without opening
                // anything (#1801). Same component, placed once per viewport.
                showIdentityBar={false}
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
