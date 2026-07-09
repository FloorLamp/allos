"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconMenu2, IconPlus } from "@tabler/icons-react";
import Wordmark from "@/components/Wordmark";
import SidebarContent from "@/components/SidebarContent";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { useLockBodyScroll } from "@/components/useLockBodyScroll";
import type { SessionProfile } from "@/lib/auth";
import type { AppVersion } from "@/lib/version";

// Mobile-only top bar + slide-in drawer. The desktop sidebar in app/layout.tsx is
// hidden below `md`; this surfaces the same navigation on phones by rendering the
// shared <SidebarContent> (the single source of truth for the sidebar's contents)
// inside the drawer, so the two viewports can't drift apart (issue #106). Only the
// collapsed top bar — hamburger, wordmark and a quick "log activity" shortcut — is
// mobile-specific chrome and lives here.
export default function MobileNav({
  activityDates,
  version,
  active,
  profiles,
  restricted = false,
  isAdmin = false,
  multiProfile = false,
  reviewCount = 0,
}: {
  activityDates: string[];
  // Resolved on the server (git/env) and passed in — this client component
  // can't read the commit hash itself.
  version: AppVersion;
  // The active profile + accessible profiles feed the shared sidebar's profile
  // switcher/logout (UserMenu); resolved from the session on the server.
  active: SessionProfile;
  profiles: SessionProfile[];
  // When true, the fitness-oriented nav entries are hidden for the active
  // (age-restricted) profile. Resolved on the server; see lib/age-gate.ts.
  restricted?: boolean;
  // Reveals the admin-only nav entries (the household overview) in the drawer.
  isAdmin?: boolean;
  // True when the instance has >1 profile; gates the Household overview.
  multiProfile?: boolean;
  // Integrations-needing-attention count for the profile-menu badge (Data →
  // Review). Resolved on the server and threaded through the shared sidebar.
  reviewCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { openCreate } = useActivityEditor();

  // Close the drawer whenever navigation happens.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // While open: lock body scroll and allow Escape to close.
  useLockBodyScroll(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* pt + max() side padding keep the bar clear of the notch/status bar now
      that the viewport paints edge-to-edge (viewportFit cover in app/layout.tsx). */}
      <header className="sticky top-0 z-30 border-b border-black/10 bg-white/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl md:hidden print:hidden dark:border-white/5 dark:bg-ink-950/80">
        <div className="flex h-14 items-center gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="-ml-1 flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            <IconMenu2 className="h-6 w-6" stroke={1.75} />
          </button>
          <Link href="/" className="flex items-center gap-2">
            <Wordmark markClassName="h-5 w-9" />
          </Link>
          {!restricted && (
            <button
              type="button"
              aria-label="Log activity"
              onClick={() => openCreate()}
              className="ml-auto -mr-1 flex h-10 w-10 items-center justify-center rounded-lg text-brand-600 transition hover:bg-slate-100 dark:text-brand-400 dark:hover:bg-ink-750"
            >
              <IconPlus className="h-6 w-6" stroke={2} />
            </button>
          )}
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col gap-4 overflow-y-auto border-r border-black/10 bg-white pt-[max(1rem,env(safe-area-inset-top))] pr-4 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] dark:border-white/5 dark:bg-ink-950">
            <SidebarContent
              activityDates={activityDates}
              version={version}
              active={active}
              profiles={profiles}
              restricted={restricted}
              isAdmin={isAdmin}
              multiProfile={multiProfile}
              reviewCount={reviewCount}
              onNavigate={() => setOpen(false)}
              onClose={() => setOpen(false)}
            />
          </aside>
        </div>
      )}
    </>
  );
}
