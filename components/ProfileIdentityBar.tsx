"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown } from "@tabler/icons-react";
import type { SessionProfile } from "@/lib/auth";
import Avatar from "@/components/Avatar";
import ProfileSwitcherPanel from "@/components/ProfileSwitcherPanel";
import { usePresence } from "@/components/usePresence";
import { useLockBodyScroll } from "@/components/useLockBodyScroll";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { useHydrated } from "@/components/useHydrated";
import { useFocusTrap } from "@/components/useFocusTrap";
import {
  OverlayDragHandle,
  overlayMotionClass,
  useOverlayDrag,
  OVERLAY_PANEL_BORDER,
  OVERLAY_PANEL_ELEVATION,
  OVERLAY_SCRIM,
} from "@/components/overlay";
import { motionMs } from "@/lib/motion";
import { identityBarLabel, identityBarView } from "@/lib/profile-identity";

// THE identity bar (issue #1801) — the app's one answer to "whose data is this,
// and who am I acting as?", on every viewport.
//
// It replaces three surfaces that each answered part of it their own way: the
// sidebar profile menu (acting only, at the BOTTOM of a scrolling drawer), the
// ProfileViewStrip (in-view only) and, on a phone, nothing at all — the mobile
// bar spent its left cluster on a wordmark.
//
// ── What it shows ────────────────────────────────────────────────────────────
//
// Stacked avatars of the IN-VIEW profiles plus a name line ("Alice", "Alice,
// Bob", "Alice, Bob +2 more"). Avatars have a fixed footprint, so a long name
// costs nothing: the text truncates and the stack never grows.
//
// THE SAFETY RULE. The bar shows who is VISIBLE, but writes (the contextual +,
// quick-log, dose confirms) land on who is ACTING. So the acting profile is
// always FIRST and visually distinct — a ring on the avatar, emphasis on the
// name — and that ordering is computed, not styled: lib/profile-identity.ts puts
// it at index 0, which is what makes "the first avatar IS the acting profile" a
// structural property a browser test can pin.
//
// ── Two presentations, ONE content component ─────────────────────────────────
//
//   * "mobile"  — the bar takes the wordmark's slot in the phone top bar, and
//     tapping it drops a TOP drawer: the panel appears where the finger already
//     is (a bottom sheet would send the thumb to the far end of the screen).
//     Built from the shared overlay primitives — scrim, motion tokens,
//     drag-to-dismiss (upward, back through the bar it came from),
//     reduced-motion — never a bespoke animation (#1469 chokepoint).
//   * "sidebar" — the bar sits at the TOP of the desktop sidebar and drops an
//     absolutely positioned container anchored below itself, OVERLAYING the
//     sidebar's contents (#1823). It used to be a normal flow child, which meant
//     opening the switcher pushed every nav entry below it down by up to 50vh and
//     snapped them back on close — desktop was the one viewport where identity
//     chrome moved unrelated content.
//
// Both render the SAME <ProfileSwitcherPanel>; the responsive-variants rule
// forbids a hidden `md:*` twin of the rows.
//
// The portal is required on mobile for the same reason MobileNav's drawer
// portals: the bar lives inside <ShellChrome>, which TRANSFORMS itself to hide
// on scroll, and a transformed ancestor turns `position: fixed` into "fixed
// relative to that ancestor" — which would drag the overlay along with the bar's
// slide.
//
// Gating lives in the CALLERS: the whole apparatus renders only on a
// multi-profile instance, so a single-profile phone keeps its wordmark and a
// single-profile sidebar gains nothing.

export type IdentitySurface = "mobile" | "sidebar";

export default function ProfileIdentityBar({
  profiles,
  actingProfileId,
  viewIds,
  readOnlyIds,
  readOnly,
  surface,
}: {
  // Every ACCESSIBLE profile with disambiguated names (#534), resolved once by
  // the app shell from ProfileScope.
  profiles: SessionProfile[];
  actingProfileId: number;
  // The persisted, access-validated view-set (#1096).
  viewIds: number[];
  // Profiles held READ-only by this login (#33) — the per-row hint in the panel.
  readOnlyIds: number[];
  // The ACTING profile is read-only for this login (#33). The hint rides the bar
  // itself, because that is where "who am I acting as" is already being read.
  readOnly: boolean;
  surface: IdentitySurface;
}) {
  const [open, setOpen] = useState(false);
  // Gate the trigger until hydration: pre-hydration a click on this button is
  // swallowed by the not-yet-hydrated tree, so the panel never opens (#830).
  // Server renders mounted=false → disabled; the client's first render matches;
  // the effect then enables it. Same idiom as ThemeToggle's mount gate.
  const mounted = useHydrated();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const reduceMotion = usePrefersReducedMotion();
  const isMobile = surface === "mobile";
  const drawer = usePresence(
    isMobile && open,
    motionMs("switcher", reduceMotion)
  );

  // Light-dismiss for the DESKTOP expando: an outside pointer-down or Escape.
  // The mobile drawer gets its own scrim/focus trap below.
  useEffect(() => {
    if (isMobile || !open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isMobile, open]);

  // Swipe the top drawer UP to dismiss — it retreats through the bar it dropped
  // from. The grab area is the HANDLE, not the whole panel: the list scrolls
  // vertically (an admin reaches every profile), so a panel-wide vertical grab
  // would race its own scroller. Same decision BottomSheet makes.
  const { suppressMotion } = useOverlayDrag({
    panelRef,
    grabRef: handleRef,
    direction: "up",
    onOutcome: () => setOpen(false),
    enabled: isMobile && open,
  });

  useLockBodyScroll(drawer.mounted);
  useFocusTrap({
    panelRef,
    onClose: () => setOpen(false),
    active: isMobile && open,
  });

  const view = identityBarView(profiles, viewIds, actingProfileId);
  // The auth boundary guarantees the acting profile is accessible; rendering
  // nothing is the honest fallback rather than a bar that cannot name it.
  if (!view) return null;

  // Two homes for one component means two stable hooks for the ROOT — the same
  // `-mobile` suffix convention the bar's other phone-only controls use
  // (search-mobile, start-workout-mobile). Both mounts exist in the DOM at every
  // width (one is `md:hidden`, the other `hidden md:flex`), so a shared testid on
  // the root would be ambiguous rather than convenient. Everything INSIDE the bar
  // is reached by scoping to the root instead of by suffixing again — except the
  // read-only badge, which predates this bar and is asserted unscoped by the #33
  // specs.
  const tid = (base: string) => (isMobile ? `${base}-mobile` : base);
  const phase = drawer.phase === "enter" ? "enter" : "exit";
  const backdropMotion = overlayMotionClass("scrim", phase, reduceMotion);
  // A hand-dragged panel owns its transform for the rest of its life (see
  // useOverlayDrag) — a keyframe class on top would outrank the inline transform
  // and freeze the drag mid-swipe.
  const panelMotion = suppressMotion
    ? ""
    : overlayMotionClass("top", phase, reduceMotion);

  const panel = (
    <ProfileSwitcherPanel
      profiles={profiles}
      actingProfileId={actingProfileId}
      viewIds={viewIds}
      readOnlyIds={readOnlyIds}
      // Closing on switch is safe here even though the row is a Server-Action
      // <form>: the desktop expando stays MOUNTED (it hides via a class), and
      // the mobile drawer stays mounted for its exit animation — in neither case
      // is the submitting form torn out from under React's dispatch.
      onSelect={() => setOpen(false)}
    />
  );

  const trigger = (
    <button
      type="button"
      data-testid={tid("profile-identity-bar")}
      data-view-count={view.ordered.length}
      data-acting-profile-id={view.acting.id}
      aria-expanded={open}
      disabled={!mounted}
      aria-busy={!mounted}
      // The accessible name states the ACTING fact, not the view — that is the
      // fact you need before tapping anything that writes.
      aria-label={identityBarLabel(view.acting.name)}
      title="Switch profile"
      onClick={() => setOpen((v) => !v)}
      className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
        isMobile
          ? "tap-target press -ml-1 flex-1 hover:bg-slate-100 dark:hover:bg-ink-750"
          : "w-full border border-black/10 bg-(--ghost) hover:bg-(--ghost-hover) dark:border-white/10"
      } ${mounted ? "" : "cursor-progress"}`}
    >
      <span aria-hidden className="flex shrink-0 items-center -space-x-2">
        {view.avatars.map((p) => {
          const isActing = p.id === view.acting.id;
          return (
            <span
              key={p.id}
              data-testid={`identity-avatar-${p.id}`}
              data-acting={isActing ? "true" : "false"}
              className="inline-flex"
            >
              {/* The ring is the acting profile's visual distinction. It rides
              the FIRST avatar because the ordering already put it there. */}
              <Avatar
                profile={p}
                size="sm"
                className={
                  isActing
                    ? "ring-2 ring-brand-500 ring-offset-1 ring-offset-white dark:ring-offset-ink-950"
                    : "opacity-90 ring-1 ring-white dark:ring-ink-950"
                }
              />
            </span>
          );
        })}
      </span>
      {/* A FLEX row, not a truncating block with inline children: the emphasized
      acting name and the quiet remainder are separate elements (one string cannot
      carry two weights), and an inline child of an `overflow:hidden` box still
      REPORTS a rect past the viewport even though it paints clipped — which is a
      real overflow to the containment guard (expectNoClippedContent) and, at
      390px, was one. As flex items with `min-w-0` they shrink instead. */}
      <span
        data-testid="identity-names"
        className="flex min-w-0 flex-1 items-baseline text-left"
      >
        <span className="min-w-0 truncate font-semibold text-slate-700 dark:text-slate-200">
          {view.acting.name}
        </span>
        {view.nameLine !== view.acting.name && (
          // The acting name is always the line's prefix (the ordering guarantees
          // it), so the remainder is the rest of the string.
          <span className="min-w-0 truncate font-normal text-slate-500 dark:text-slate-400">
            {view.nameLine.slice(view.acting.name.length)}
          </span>
        )}
      </span>
      {readOnly && (
        <span
          data-testid={tid("read-only-badge")}
          aria-label={`Viewing ${view.acting.name} — read-only`}
          className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-300"
        >
          Read-only
        </span>
      )}
      <IconChevronDown
        aria-hidden
        className={`h-4 w-4 shrink-0 text-slate-400 transition ${
          open ? "rotate-180" : "rotate-0"
        }`}
        stroke={1.75}
      />
    </button>
  );

  if (!isMobile) {
    // `relative` on the wrapper is the panel's containing block — the anchor the
    // overlay hangs from, and the whole reason the sidebar below stops moving.
    return (
      <div ref={rootRef} className="relative">
        {trigger}
        {/* Kept mounted (toggled via a class) rather than unmounted: closing on
        select must not tear down the <form> before React dispatches its Server
        Action, or the switch is silently dropped. `absolute` changes none of
        that — `hidden` is still display:none on a mounted subtree. Capped +
        scrollable because an admin can reach every profile.

        OVERLAY, not reflow (#1823). `absolute top-full inset-x-0` takes the
        panel out of flow so the nav, calendar and login footer below keep their
        positions; `z-20` puts it over them (nothing else in the sidebar is
        positioned, so this only has to beat the static painting order). `mt-1`
        keeps the gap the wrapper's old `gap-1` provided.

        On the containing scroller: the desktop <aside> is `overflow-y-auto`, and
        a scroll container clips its absolutely positioned descendants. It does
        not clip this one, because an abs-positioned box inside the scroller
        still CONTRIBUTES to its scrollable overflow — the bar sits at the
        sidebar's top and the panel is capped at 50vh, so it lands on screen, and
        the pathological short-window case scrolls into reach rather than
        vanishing. The heavier fallback (portal + anchor to the trigger's rect,
        the way the mobile branch does it) stays unspent: it would buy nothing
        here and would cost the simple focus/dismiss wiring below. */}
        <div
          data-testid="profile-switcher-panel"
          className={`${
            open ? "flex" : "hidden"
          } absolute inset-x-0 top-full z-20 mt-1 max-h-[50vh] flex-col overflow-y-auto overscroll-contain rounded-lg border border-black/10 bg-white p-2 shadow-lg dark:border-white/10 dark:bg-ink-850`}
        >
          {panel}
        </div>
      </div>
    );
  }

  return (
    <>
      {trigger}
      {drawer.mounted &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-40 md:hidden">
            <div
              className={`${OVERLAY_SCRIM} ${backdropMotion}`}
              onClick={() => setOpen(false)}
              aria-hidden
              data-testid="profile-switcher-backdrop"
            />
            <div
              ref={panelRef}
              data-testid="profile-switcher-panel-mobile"
              role="dialog"
              aria-modal="true"
              aria-label="Switch profile"
              className={`absolute inset-x-0 top-0 flex max-h-[85vh] flex-col rounded-b-2xl border-b bg-white pt-[max(0.5rem,env(safe-area-inset-top))] dark:bg-ink-950 ${OVERLAY_PANEL_BORDER} ${OVERLAY_PANEL_ELEVATION} ${panelMotion}`}
            >
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1">
                {panel}
              </div>
              {/* The handle sits at the BOTTOM of a TOP-anchored panel — the edge
              facing the reader is the edge you flick. */}
              <OverlayDragHandle
                handleRef={handleRef}
                testId="profile-switcher-drag-handle"
              />
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
