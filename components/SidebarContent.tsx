"use client";

import Link from "next/link";
import { IconSearch, IconX } from "@tabler/icons-react";
import Nav from "@/components/Nav";
import { openGlobalSearch } from "@/components/CommandPalette";
import Wordmark from "@/components/Wordmark";
import UserMenu from "@/components/UserMenu";
import LogActivityButton from "@/components/LogActivityButton";
import JournalCalendar from "@/components/JournalCalendar";
import ThemeToggle from "@/components/ThemeToggle";
import type { SessionProfile } from "@/lib/auth";
import type { AppVersion } from "@/lib/version";

// The single source of truth for the sidebar's contents (issue #106). Rendered
// verbatim by BOTH the desktop sidebar (app/(app)/layout.tsx) and the mobile
// drawer (components/MobileNav.tsx), so anything added here appears on every
// viewport — the two responsive surfaces can no longer drift (which is how the
// mobile drawer silently lacked the profile switcher/logout for all of #67).
//
// The version hash is rendered from a passed-in value rather than the AppVersion
// server component: this is a client component (the drawer that hosts it is), so
// it can't read git itself; the layout resolves the hash once and hands it to
// both surfaces.
//
// Drawer-specific behavior is opt-in via props, so the desktop sidebar renders
// the same content without it:
//   - onNavigate: closes the drawer after an action that doesn't itself navigate
//     (e.g. "log activity" opens a modal); navigations already close it via the
//     drawer's pathname effect.
//   - onClose: when set, renders the drawer's close (✕) button beside the wordmark.
export default function SidebarContent({
  activityDates,
  version,
  active,
  profiles,
  restricted = false,
  isAdmin = false,
  multiProfile = false,
  reviewCount = 0,
  readOnly = false,
  onNavigate,
  onClose,
}: {
  activityDates: string[];
  version: AppVersion;
  active: SessionProfile;
  profiles: SessionProfile[];
  restricted?: boolean;
  // Reveals any admin-only nav entries; the pages themselves still call
  // requireAdmin().
  isAdmin?: boolean;
  // True when the caller has >1 ACCESSIBLE profile; gates the Household overview
  // (issue #31), which is meaningless with a single profile.
  multiProfile?: boolean;
  // Count of integrations currently needing attention (failed syncs) — shown as
  // a badge on the profile menu, linking to Data → Review. Resolved server-side.
  reviewCount?: number;
  // The active profile is shared with this login as READ-ONLY (issue #33); shows
  // a "read-only" badge in the profile menu. Server-side enforcement is authority.
  readOnly?: boolean;
  onNavigate?: () => void;
  onClose?: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Link href="/" className="flex items-center gap-2 rounded-lg px-2">
          <Wordmark markClassName="h-6 w-10" />
        </Link>
        {onClose && (
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-750"
          >
            <IconX className="h-5 w-5" stroke={1.75} />
          </button>
        )}
      </div>
      {/* Global search trigger — lives in the shared content so it appears in
      both the desktop sidebar and the mobile drawer (issue #133). Opens the
      Cmd-K command palette (mounted once in the app layout) via a custom event;
      closes the drawer afterward on mobile. */}
      <button
        type="button"
        onClick={() => {
          openGlobalSearch();
          onNavigate?.();
        }}
        className="flex items-center gap-2 rounded-lg border border-black/10 bg-white/70 px-3 py-2 text-sm text-slate-500 transition hover:bg-slate-100 dark:border-white/10 dark:bg-ink-850 dark:text-slate-400 dark:hover:bg-ink-750"
      >
        <IconSearch className="h-4 w-4 shrink-0" stroke={1.75} />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="hidden rounded border border-black/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 md:inline dark:border-white/10 dark:text-slate-500">
          ⌘K
        </kbd>
      </button>
      {!restricted && <LogActivityButton onClick={onNavigate} />}
      <JournalCalendar activeDates={activityDates} />
      <Nav
        restricted={restricted}
        isAdmin={isAdmin}
        multiProfile={multiProfile}
      />
      {/* Profile switcher/logout above one bordered box holding the theme toggle
      and version hash as equal, borderless halves (a single segmented control). */}
      <div className="mt-auto flex flex-col gap-2">
        <UserMenu
          active={active}
          profiles={profiles}
          reviewCount={reviewCount}
          readOnly={readOnly}
          onNavigate={onNavigate}
        />
        <div className="grid grid-cols-2 rounded-lg border border-black/10 bg-white/70 p-1 dark:border-white/10 dark:bg-ink-850">
          <ThemeToggle bare />
          {/* The wrapper (not the link) fills the cell, so the clickable area
          stays as small as the hash itself. */}
          <div className="flex items-center justify-end px-3">
            {/* commitUrl is non-null only when sha is (see lib/version.ts), so
            the link branch always has a hash; the span mirrors AppVersion's
            "cell" variant, falling back to "unknown" when the sha is missing. */}
            {version.commitUrl ? (
              <a
                href={version.commitUrl}
                target="_blank"
                rel="noreferrer"
                title={version.commitMessage ?? undefined}
                className="font-mono text-xs text-slate-500 underline-offset-2 transition hover:text-slate-700 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
              >
                {version.sha}
              </a>
            ) : (
              <span
                title={version.commitMessage ?? undefined}
                className="font-mono text-xs text-slate-500 dark:text-slate-400"
              >
                {version.sha ?? "unknown"}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
