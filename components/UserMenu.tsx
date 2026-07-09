"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconChevronDown, IconLogout, IconInbox } from "@tabler/icons-react";
import type { SessionProfile } from "@/lib/auth";
import Avatar from "@/components/Avatar";
import { clearEmergencyPayload } from "@/components/emergency-offline";
import { logoutAction, switchProfileAction } from "@/app/(app)/user-actions";

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
  reviewCount = 0,
  readOnly = false,
  onNavigate,
}: {
  active: SessionProfile;
  profiles: SessionProfile[];
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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="user-menu-trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-black/10 bg-white/70 px-2 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-white dark:border-white/10 dark:bg-ink-850 dark:text-slate-200 dark:hover:bg-ink-800"
      >
        <Avatar profile={active} size="sm" />
        <span className="min-w-0 flex-1 truncate text-left">{active.name}</span>
        {readOnly && (
          <span
            data-testid="read-only-badge"
            aria-label={`Viewing ${active.name} — read-only`}
            className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-300"
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
      Action, or the switch/logout is silently dropped. */}
      <div
        className={`absolute inset-x-0 bottom-full z-20 mb-2 ${
          open ? "flex" : "hidden"
        } flex-col gap-1 rounded-lg border border-black/10 bg-white p-2 shadow-xl dark:border-white/10 dark:bg-ink-850`}
      >
        {readOnly && (
          <p className="px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
            Viewing <span className="font-semibold">{active.name}</span> —
            read-only. You can browse everything but can&apos;t make changes.
          </p>
        )}
        {profiles.length > 1 &&
          profiles.map((p) => {
            const isActive = p.id === active.id;
            return (
              <form key={p.id} action={switchProfileAction}>
                <input type="hidden" name="profileId" value={p.id} />
                <button
                  type="submit"
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => {
                    // Switching profiles must not leak the previous profile's
                    // offline emergency card; drop it before the switch action
                    // navigates (#42). The new profile re-caches on its next
                    // /emergency visit.
                    clearEmergencyPayload();
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium transition ${
                    isActive
                      ? "bg-gradient-to-r from-brand-500 to-brand-600 text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
                  }`}
                >
                  <Avatar profile={p} size="sm" />
                  <span className="min-w-0 truncate">{p.name}</span>
                </button>
              </form>
            );
          })}
        <Link
          href="/data?section=review"
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
        </Link>
        <form action={logoutAction}>
          <button
            type="submit"
            onClick={() => clearEmergencyPayload()}
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
