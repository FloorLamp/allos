"use client";

import { useEffect, useRef, useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import type { SessionProfile } from "@/lib/auth";
import Avatar from "@/components/Avatar";
import ProfileSwitcherPanel from "@/components/ProfileSwitcherPanel";
import { useHydrated } from "@/components/useHydrated";
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
// Gating lives in the CALLERS: the whole apparatus renders only on a
// multi-profile instance, so a single-profile phone keeps its wordmark and a
// single-profile sidebar gains nothing.

export default function ProfileIdentityBar({
  profiles,
  actingProfileId,
  viewIds,
  readOnlyIds,
  readOnly,
}: {
  // Every ACCESSIBLE profile with disambiguated names (#534), resolved once by
  // the app shell from ProfileScope.
  profiles: SessionProfile[];
  actingProfileId: number;
  // The persisted, access-validated view-set (#1096).
  viewIds: readonly number[];
  // Profiles held READ-only by this login (#33) — the per-row hint in the panel.
  readOnlyIds: number[];
  // The ACTING profile is read-only for this login (#33). The hint rides the bar
  // itself, because that is where "who am I acting as" is already being read.
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Gate the trigger until hydration: pre-hydration a click on this button is
  // swallowed by the not-yet-hydrated tree, so the panel never opens (#830).
  // Server renders mounted=false → disabled; the client's first render matches;
  // the effect then enables it. Same idiom as ThemeToggle's mount gate.
  const mounted = useHydrated();
  const rootRef = useRef<HTMLDivElement>(null);

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

  const view = identityBarView(profiles, viewIds, actingProfileId);
  // The auth boundary guarantees the acting profile is accessible; rendering
  // nothing is the honest fallback rather than a bar that cannot name it.
  if (!view) return null;

  const panel = (
    <ProfileSwitcherPanel
      profiles={profiles}
      actingProfileId={actingProfileId}
      viewIds={viewIds}
      readOnlyIds={readOnlyIds}
      // Closing on switch is safe here even though the row is a Server-Action
      // <form>: the desktop expando stays MOUNTED (it hides via a class), so neither
      // is the submitting form torn out from under React's dispatch.
      onSelect={() => setOpen(false)}
    />
  );

  const trigger = (
    <button
      type="button"
      data-testid="profile-identity-bar"
      data-view-count={view.ordered.length}
      data-acting-profile-id={view.acting.id}
      aria-expanded={open}
      disabled={!mounted}
      aria-busy={!mounted}
      // The accessible name states the ACTING fact, not the view — that is the
      // fact you need before tapping anything that writes.
      aria-label={identityBarLabel(view.acting.name)}
      onClick={() => setOpen((v) => !v)}
      className={`flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg border border-black/10 bg-(--ghost) px-2 py-1.5 text-sm transition hover:bg-(--ghost-hover) sm:min-h-0 dark:border-white/10 ${mounted ? "" : "cursor-progress"}`}
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
          data-testid="read-only-badge"
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
        now unused) would buy nothing
        here and would cost the simple focus/dismiss wiring below. */}
      <div
        data-testid="profile-switcher-panel"
        className={`${
          open ? "flex" : "hidden"
        } absolute inset-x-0 top-full z-20 mt-1 max-h-[50vh] flex-col overflow-y-auto overscroll-contain rounded-lg border border-(--border) bg-surface p-2 shadow-lg`}
      >
        {panel}
      </div>
    </div>
  );
}
