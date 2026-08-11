"use client";

import Link from "next/link";
import { IconLogout, IconSearch, IconX } from "@tabler/icons-react";
import Nav from "@/components/Nav";
import { openGlobalSearch } from "@/components/CommandPalette";
import Wordmark from "@/components/Wordmark";
import ProfileIdentityBar from "@/components/ProfileIdentityBar";
import { clearEmergencyPayload } from "@/components/emergency-offline";
import { clearQueue } from "@/lib/offline/queue-db";
import { logoutAction } from "@/app/(app)/session-actions";
import LogActivityButton from "@/components/LogActivityButton";
import FrequentPages from "@/components/FrequentPages";
import JournalCalendar from "@/components/JournalCalendar";
import ThemeToggle from "@/components/ThemeToggle";
import WhatsNewLink from "@/components/WhatsNewLink";
import type { SessionProfile } from "@/lib/auth";
import type { AppVersion } from "@/lib/version";
import { DEFAULT_NAV_RELEVANCE, type NavRelevance } from "@/lib/nav-relevance";

// The single source of truth for the sidebar's contents. Rendered
// verbatim by BOTH the desktop sidebar (app/(app)/layout.tsx) and the mobile
// drawer (components/MobileNav.tsx), so anything added here appears on every
// viewport — the two responsive surfaces can no longer drift (which is how the
// mobile drawer silently lacked the profile switcher/logout).
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
//   - showIdentityBar: the desktop sidebar carries the #1801 identity bar at its
//     TOP; the drawer does NOT, because on a phone the bar lives in the top bar
//     itself (that is the whole point — the acting profile must be answerable
//     without opening anything). Same component either way, placed once.
//
// The profile MENU that used to sit at the bottom of this file is gone (#1801):
// the identity bar + its switcher panel are the one switcher now. What stayed at
// the bottom is the LOGIN half — "Signed in as <username>" (#1013) beside the
// control that ends the login — because login identity belongs with logout, not
// in a profile switcher.
export default function SidebarContent({
  activityDates,
  version,
  active,
  username,
  profiles,
  viewIds = [],
  readOnlyIds = [],
  showIdentityBar = true,
  restricted = false,
  isAdmin = false,
  multiProfile = false,
  foodLoggingRelevant = true,
  hasIntakeItems = false,
  relevance = DEFAULT_NAV_RELEVANCE,
  reviewCount = 0,
  readOnly = false,
  whatsNewUnseen = false,
  onNavigate,
  onClose,
}: {
  activityDates: string[];
  version: AppVersion;
  active: SessionProfile;
  // The signed-in login's username — shown as "Signed in as <username>" in the
  // profile-menu overlay (issue #1013), answering "which login am I?" without
  // cluttering the collapsed pill. Threaded through this ONE shared component so
  // both viewports carry it (never a hand-mirrored hidden md:* branch).
  username: string;
  profiles: SessionProfile[];
  // The session's multi-profile VIEW-SET (issue #1096) — threaded through to the
  // identity bar's stacked avatars and the panel's per-profile view toggles.
  // Defaults empty (single-view).
  viewIds?: number[];
  // Accessible profiles this login holds READ-only (issue #33); each carries the
  // hint on its switcher row.
  readOnlyIds?: number[];
  // See the note above: true for the desktop sidebar, false for the mobile
  // drawer (whose identity bar lives in the phone top bar).
  showIdentityBar?: boolean;
  restricted?: boolean;
  // Reveals any admin-only nav entries; the pages themselves still call
  // requireAdmin().
  isAdmin?: boolean;
  // True when the caller has >1 ACCESSIBLE profile; gates the Household overview
  // (issue #31), which is meaningless with a single profile.
  multiProfile?: boolean;
  // True unless the active profile is an infant (< 1 y); gates the Nutrition
  // entry (issue #591). Defaults true so a caller that doesn't thread it never
  // over-hides.
  foodLoggingRelevant?: boolean;
  // True when the active profile tracks any intake item (#746); keeps the
  // Nutrition entry (→ Supplements tab) reachable for an infant supplement user.
  hasIntakeItems?: boolean;
  // Server-resolved relevance bitset (issue #1042) gating the Cycle/Vision/
  // Dental nav entries. Resolved once by the layout (getNavRelevance) and
  // threaded through this ONE shared component so both viewports agree.
  relevance?: NavRelevance;
  // Count of integrations currently needing attention (failed syncs) — shown as
  // a badge on the profile menu, linking to Data → Review. Resolved server-side.
  reviewCount?: number;
  // The active profile is shared with this login as READ-ONLY (issue #33). On a
  // multi-profile instance the hint rides the identity bar; on a single-profile
  // one (where there is no bar) it rides the login footer beside "Signed in as",
  // so the hint never disappears just because there is nothing to switch to.
  // Server-side enforcement is the authority either way.
  readOnly?: boolean;
  // The bundled release notes hold something this LOGIN hasn't opened (issue
  // #1421) — resolved once by the layout from the ONE pure comparison
  // (hasUnseenNotes) and threaded through the shared content so both viewports
  // show the same calm dot. Defaults false so a caller that doesn't thread it
  // never over-hints.
  whatsNewUnseen?: boolean;
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
            title="Close menu"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-750"
          >
            <IconX className="h-5 w-5" stroke={1.75} />
          </button>
        )}
      </div>
      {/* The identity bar (#1801) at the TOP of the sidebar — "whose data am I
      looking at, and who am I acting as?" answered before anything else on the
      page. Gated on multiProfile: identity chrome when identity is ambiguous,
      brand chrome when it isn't. */}
      {showIdentityBar && multiProfile && (
        <ProfileIdentityBar
          profiles={profiles}
          actingProfileId={active.id}
          viewIds={viewIds}
          readOnlyIds={readOnlyIds}
          readOnly={readOnly}
          surface="sidebar"
        />
      )}
      {/* Global search trigger — lives in the shared content so it appears in
      both the desktop sidebar and the mobile drawer. Opens the
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
        <kbd className="hidden rounded-sm border border-black/10 px-1.5 py-0.5 font-mono text-xs text-slate-500 md:inline dark:border-white/10 dark:text-slate-400">
          ⌘K
        </kbd>
      </button>
      {!restricted && <LogActivityButton onClick={onNavigate} />}
      {/* Most-visited shortcuts (issue #1416, section E3). Client-side visit
      counts in localStorage — no schema change, no server round-trip — and it
      lives in the SHARED content, so the desktop sidebar and the mobile drawer
      offer the same jumps. Renders nothing until a page clears the "this is a
      habit" floor, so a fresh login sees no empty section. */}
      <FrequentPages onNavigate={onNavigate} />
      <JournalCalendar activeDates={activityDates} />
      <Nav
        restricted={restricted}
        isAdmin={isAdmin}
        multiProfile={multiProfile}
        foodLoggingRelevant={foodLoggingRelevant}
        hasIntakeItems={hasIntakeItems}
        relevance={relevance}
        reviewCount={reviewCount}
      />
      {/* The LOGIN block above one bordered box holding the theme toggle and
      version hash as equal, borderless halves (a single segmented control).
      "Signed in as <username>" (#1013) sits with logout because it names the
      thing logout ends — it was never a fact about the acting PROFILE, which is
      why it left the switcher in #1801. */}
      <div className="mt-auto flex flex-col gap-2">
        <div className="flex flex-col gap-1 rounded-lg border border-black/10 bg-white/70 p-1 dark:border-white/10 dark:bg-ink-850">
          <p
            data-testid="signed-in-as"
            className="px-2 pt-1 text-xs text-slate-500 dark:text-slate-400"
          >
            Signed in as{" "}
            <span className="font-semibold text-slate-700 dark:text-slate-200">
              {username}
            </span>
          </p>
          {/* On a single-profile instance there is no identity bar to carry the
          #33 hint, so it rides here instead — one fact, two mutually exclusive
          homes, never both. */}
          {readOnly && !multiProfile && (
            <p
              data-testid="read-only-badge"
              aria-label={`Viewing ${active.name} — read-only`}
              className="px-2 text-xs font-semibold text-amber-700 dark:text-amber-300"
            >
              Read-only
            </p>
          )}
          <form action={logoutAction}>
            <button
              type="submit"
              onClick={() => {
                // Wipe offline PHI on logout: the emergency card copy (#42) and
                // any queued offline writes (#28) — never leave them for the
                // next login.
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
        {/* Persistent footer link to the single Disclaimer surface (issue #1049).
        Lives in the shared content so it renders on BOTH the desktop sidebar and
        the mobile drawer (the responsive-surfaces rule) — the one always-reachable
        pointer to the app's medical-disclaimer posture, replacing the ~40 inline
        banners that used to hand-write it. */}
        {/* "What's new" sits with the version hash and the Disclaimer link (issue
        #1421): the bundled release notes answer "what did that pull bring?", and a
        subtle dot appears until this login has opened them. Calm by design — a
        display affordance only, never a notification or a finding. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-slate-500 dark:text-slate-400">
          <WhatsNewLink unseen={whatsNewUnseen} onNavigate={onNavigate} />
          <Link
            href="/disclaimer"
            onClick={onNavigate}
            className="underline-offset-2 transition hover:text-slate-700 hover:underline dark:hover:text-slate-200"
          >
            Disclaimer
          </Link>
        </div>
      </div>
    </>
  );
}
