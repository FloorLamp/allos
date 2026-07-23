"use client";

import { useEffect, useRef, useState } from "react";
import {
  IconChevronDown,
  IconLogout,
  IconInbox,
  IconEye,
  IconEyeOff,
} from "@tabler/icons-react";
import type { SessionProfile } from "@/lib/auth";
import { dataSectionHref } from "@/lib/hrefs";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import Avatar from "@/components/Avatar";
import { clearEmergencyPayload } from "@/components/emergency-offline";
import { clearQueue } from "@/lib/offline/queue-db";
import {
  logoutAction,
  switchProfileAction,
  setViewProfileAction,
} from "@/app/(app)/user-actions";

// Active-profile display + profile switcher + logout, rendered in the layout
// chrome. Collapsed by default to a pill showing the active profile; clicking it
// opens a floating overlay panel *above* the pill (so it sits over the
// sidebar/drawer rather than pushing its layout) holding the profile switcher
// (when more than one profile is accessible) and the log-out button. Client
// component so the overlay light-dismisses on an outside click or Escape; the
// switch/logout controls are still plain <form>s bound to Server Actions.
export default function UserMenu({
  active,
  profiles,
  viewIds = [],
  reviewCount = 0,
  readOnly = false,
  onNavigate,
}: {
  active: SessionProfile;
  profiles: SessionProfile[];
  // The session's multi-profile VIEW-SET (issue #1096) — the profiles currently
  // toggled INTO the merged view. Each accessible-profile row gets a view toggle
  // driving setViewProfileAction; the acting profile is always in-view (its toggle
  // is shown checked + inert — you can't hide the profile you're acting as).
  viewIds?: number[];
  // Integrations needing attention (failed syncs); rendered as a badge on the
  // pill and beside the "Import review" link. Resolved server-side (Data → Review).
  reviewCount?: number;
  // The caller holds only READ access on the active profile (issue #33). Shows a
  // "read-only" badge on the pill + a note in the overlay so the missing edit
  // affordances read as intentional. Server-side requireWriteAccess() is the real
  // boundary — this is purely a hint.
  readOnly?: boolean;
  // Closes the mobile drawer after tapping a link that navigates within it.
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Gate the trigger until hydration: pre-hydration a click on this button is
  // swallowed by the not-yet-hydrated tree, so the popover never opens and the
  // (already-safe) links inside are unreachable (#830). Unlike the tab strip,
  // a light-dismissing popover with Server-Action forms genuinely needs JS —
  // it can't be a bare anchor — so we render it inert until mounted instead.
  // Server renders mounted=false → disabled; the client's first render matches
  // (no hydration mismatch); the effect then enables it. Same idiom as
  // ThemeToggle's mount gate.
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Two accessible profiles can share a name (no uniqueness constraint) — append a
  // "(2)" ordinal so the switcher pill + rows name a specific profile (#534).
  const displayNames = disambiguateProfileNames(profiles);
  const activeLabel = displayNames.get(active.id) ?? active.name;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="user-menu-trigger"
        aria-expanded={open}
        disabled={!mounted}
        aria-busy={!mounted}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 rounded-lg border border-black/10 bg-white/70 px-2 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-white dark:border-white/10 dark:bg-ink-850 dark:text-slate-200 dark:hover:bg-ink-800 ${
          mounted ? "" : "cursor-progress"
        }`}
      >
        <Avatar profile={active} size="sm" />
        <span className="min-w-0 flex-1 truncate text-left">{activeLabel}</span>
        {readOnly && (
          <span
            data-testid="read-only-badge"
            aria-label={`Viewing ${active.name} — read-only`}
            className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-300"
          >
            Read-only
          </span>
        )}
        {reviewCount > 0 && (
          <span
            data-testid="review-badge"
            aria-label={`${reviewCount} import ${
              reviewCount === 1 ? "item" : "items"
            } need attention`}
            className="flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-rose-500 px-1.5 text-xs font-semibold text-white"
          >
            {reviewCount}
          </span>
        )}
        <IconChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition ${
            open ? "rotate-0" : "rotate-180"
          }`}
          stroke={1.75}
        />
      </button>
      {/* Kept mounted (toggled via display) rather than unmounted: closing on
      select must not tear down the <form> before React dispatches its Server
      Action, or the switch/logout is silently dropped. The testid scopes e2e
      profile-switch clicks to THIS popover — the dashboard's household-strip
      chips are also profile-named form buttons, so an unscoped page-wide
      locator would be ambiguous. Cap + scroll the panel because admins can see
      every profile; an uncapped list can place the earliest rows above the
      viewport and make them unreachable. */}
      <div
        data-testid="user-menu-popover"
        className={`absolute inset-x-0 bottom-full z-20 mb-2 ${
          open ? "flex" : "hidden"
        } max-h-[calc(100vh-5rem)] flex-col gap-1 overflow-y-auto overscroll-contain rounded-lg border border-black/10 bg-white p-2 shadow-xl dark:border-white/10 dark:bg-ink-850`}
      >
        {readOnly && (
          <p className="px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
            Viewing <span className="font-semibold">{active.name}</span> —
            read-only. You can browse everything but can&apos;t make changes.
          </p>
        )}
        {profiles.length > 1 && (
          <>
            <p className="px-2 pb-0.5 pt-1 section-label">Profiles</p>
            <p className="px-2 pb-1 text-xs text-slate-500 dark:text-slate-400">
              Tap a name to act as them. Toggle the eye to show a profile in
              your view.
            </p>
          </>
        )}
        {profiles.length > 1 &&
          profiles.map((p) => {
            const isActive = p.id === active.id;
            const inView = isActive || viewIds.includes(p.id);
            const name = displayNames.get(p.id) ?? p.name;
            return (
              // Two controls per row (#1096): the ACT-AS switch (the name) and the
              // in/out-of-VIEW toggle (the eye). Kept as sibling forms so each posts
              // its own Server Action — the switch changes the write target, the
              // toggle changes only the read overlay.
              <div key={p.id} className="flex items-center gap-1">
                <form action={switchProfileAction} className="min-w-0 flex-1">
                  <input type="hidden" name="profileId" value={p.id} />
                  <button
                    type="submit"
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => {
                      // The switch-time device-local cleanup is centralized in
                      // ProfileSwitchWatcher (#600) — it wipes the previous profile's
                      // emergency card whenever the active profile id changes, so EVERY
                      // switch affordance is covered by construction rather than each
                      // hand-mirroring the wipe here. The offline queue is deliberately
                      // NOT wiped on switch anymore: its intents are profile-stamped
                      // (#599) and replay onto their own profile.
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium transition ${
                      isActive
                        ? "bg-gradient-to-r from-brand-500 to-brand-600 text-white shadow-sm"
                        : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
                    }`}
                  >
                    <Avatar profile={p} size="sm" />
                    <span className="min-w-0 truncate">{name}</span>
                  </button>
                </form>
                <form action={setViewProfileAction} className="shrink-0">
                  <input type="hidden" name="profileId" value={p.id} />
                  <button
                    type="submit"
                    disabled={isActive}
                    data-testid={`view-toggle-${p.id}`}
                    aria-pressed={inView}
                    aria-label={
                      isActive
                        ? `${name} is always in your view`
                        : inView
                          ? `Remove ${name} from view`
                          : `Add ${name} to view`
                    }
                    title={
                      isActive
                        ? "Always in view"
                        : inView
                          ? "In view — tap to hide"
                          : "Not in view — tap to show"
                    }
                    className={`flex h-8 w-8 items-center justify-center rounded-md border transition disabled:opacity-40 ${
                      inView
                        ? "border-brand-300 bg-brand-50 text-brand-600 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300"
                        : "border-black/10 text-slate-400 hover:bg-slate-100 dark:border-white/10 dark:hover:bg-ink-750"
                    }`}
                  >
                    {inView ? (
                      <IconEye className="h-4 w-4" stroke={1.75} />
                    ) : (
                      <IconEyeOff className="h-4 w-4" stroke={1.75} />
                    )}
                  </button>
                </form>
              </div>
            );
          })}
        {/* A plain <a>, NOT a Next <Link>, on purpose (#830). Reached only after
        the menu is opened, this link's App-Router SOFT navigation (router.push,
        run inside a low-priority transition) is dropped ~half the time when
        clicked in the still-settling window right after the open re-render — a
        real user-facing lost click, only masked in e2e by a retry (#730). A
        native full-page navigation can't be preempted by React's scheduler, so
        it lands every time (pre- and post-hydration) — the same progressive-
        enhancement guarantee the tab strip gets from its <a href>, at the small
        cost of a full reload for this one low-frequency menu link. The href
        stays typed via dataSectionHref so a dead route is still a build error
        (#285). setOpen(false)/onNavigate here is safe: a native nav (unlike a
        transition) isn't preempted by the state update. */}
        <a
          href={dataSectionHref("review")}
          onClick={() => {
            setOpen(false);
            onNavigate?.();
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
        >
          <IconInbox className="h-4 w-4 shrink-0" stroke={1.75} />
          <span className="flex-1">Import review</span>
          {reviewCount > 0 && (
            <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-rose-500 px-1.5 text-xs font-semibold text-white">
              {reviewCount}
            </span>
          )}
        </a>
        <form action={logoutAction}>
          <button
            type="submit"
            onClick={() => {
              // Wipe offline PHI on logout: the emergency card copy (#42) and any
              // queued offline writes (#28) — never leave them for the next login.
              clearEmergencyPayload();
              void clearQueue();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-ink-750 dark:hover:text-slate-200"
          >
            <IconLogout className="h-4 w-4 shrink-0" stroke={1.75} />
            Log out
          </button>
        </form>
      </div>
    </div>
  );
}
