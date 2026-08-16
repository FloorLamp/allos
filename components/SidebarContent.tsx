"use client";

import Link from "next/link";
import { useRef } from "react";
import { IconLogout, IconSearch, IconX } from "@tabler/icons-react";
import Nav from "@/components/Nav";
import { openGlobalSearch } from "@/components/CommandPalette";
import Wordmark from "@/components/Wordmark";
import ProfileIdentityBar from "@/components/ProfileIdentityBar";
import { clearEmergencyPayload } from "@/components/emergency-offline";
import { unstable_rethrow } from "next/navigation";
import { clearQueue } from "@/lib/offline/queue-db";
import { reopenForFailedLogout } from "@/lib/offline/write-gate";

// How long the probe may take before its answer stops being worth waiting for.
//
// A DEAD LINK AND A FLAKY ONE ARE DIFFERENT FAILURES, and only the first is fast. A
// refused connection rejects immediately; a link that accepts the connection and then
// stops carrying it sits for the browser's own connect/read timeout, which is minutes.
// Everything downstream waits behind that: the undo does not run, and the rethrow that
// puts the person on the error boundary does not happen either — so the gate is shut,
// the screen is unchanged, and there is no feedback at all, in exactly the no-signal case
// this recovery exists for. The bound fails in the right direction: abort → catch →
// "not gone" → the undo runs (see R-A5 in e2e/offline-write-gate.spec.ts, which hangs the
// probe and watches the gate re-open anyway).
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Has the server ENDED this session? The only answer that keeps the write gate closed
 * after a logout attempt that did not obviously succeed.
 *
 * `?probe` on the snapshots route, which is the app's one cookie-authoritative GET —
 * `getCurrentSession()` rather than the coarse middleware cookie check — and answers the
 * auth question without building or returning a single payload. Only a positive 401/403
 * counts: any other status, any network failure, and the timeout above leave the
 * session's fate unknown, and unknown must not brick the device.
 */
async function sessionEndedOnServer(): Promise<boolean> {
  try {
    const res = await fetch("/api/offline-snapshots?probe=1", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}
import { logoutAction } from "@/app/(app)/session-actions";
import LogActivityButton from "@/components/LogActivityButton";
import FrequentPages from "@/components/FrequentPages";
import TrainingLogCalendar from "@/components/TrainingLogCalendar";
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
  viewIds?: readonly number[];
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
  const logoutFormRef = useRef<HTMLFormElement>(null);

  // Wipe this device's PHI, THEN log out.
  //
  // Three stores go: the emergency card copy (#42, localStorage — synchronous, which
  // is why this race never showed before), any queued offline writes plus their
  // dead-letter entries and form drafts (#28/#475/#1699), and the offline read
  // snapshots (#2908). clearQueue's own transaction covers the snapshot store too, so
  // the wipe holds even if this call site drifts.
  //
  // BOUNDED, and it logs out either way. A wedged or blocked IndexedDB must never trap
  // someone in a session they asked to leave — the server-side logout is what actually
  // ends the session, and it is not optional. If the wipe cannot finish in time the
  // logout still proceeds, and the next authenticated visit's identity check wipes what
  // is left.
  //
  // WHAT DOES NOT COVER THE LEFTOVER, corrected here because the claim was made and was
  // false: /offline does NOT refuse to render it. `resolveSnapshotProfile` refuses a
  // MIXED store — two profiles' payloads at once, which one login's leftover is not.
  // A store holding exactly one login's payloads is precisely what it CAN attribute, so
  // the common case renders, session-free, for whoever picks the phone up next. The
  // 2s bound is a liveness guarantee for the person logging out and nothing more.
  //
  // WHAT DOES COVER IT is `clearQueue` CLOSING THE DEVICE WRITE GATE in the same
  // transaction as the wipe (lib/offline/write-gate.ts). This page stays mounted,
  // authenticated and interactive for the whole duration of the logout POST below, and
  // that window admitted four different re-writes, each found after the previous fix:
  //   • a refresh already in flight — dropped by the generation the gate carries;
  //   • a refresh that STARTS after the wipe, whose generation is legitimately current,
  //     which finds an empty store, asks for all five kinds and is answered 200 because
  //     the session does not end until the POST lands;
  //   • the same thing from ANOTHER TAB, which shares the database and shares no memory;
  //   • a queue flush's retry write and a form draft's 600ms debounce, landing after.
  // Which is why the gate is neither in this component nor in a module variable: it is a
  // record in the database the writes land in, read inside each write's own transaction,
  // and it stays closed until a DIFFERENT session opens it — not merely until some tab
  // mounts, because every tab open right now is about to do exactly that.
  async function logoutAfterWipe(): Promise<void> {
    clearEmergencyPayload();
    try {
      await Promise.race([
        clearQueue(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      /* the logout below is not conditional on the wipe succeeding */
    }
    logoutFormRef.current?.requestSubmit();
  }

  // AND IF THE LOGOUT NEVER LANDS, THE CLOSE COMES BACK OFF.
  //
  // The wipe above closes the gate for THIS session before the POST is even sent, which
  // is what makes the whole logout window safe. It is also a bet: if the POST fails — no
  // signal, which is this app's own subject matter, or a 5xx mid-deploy — the session is
  // still alive and the gate is closed for it, and `openSessionAs` refuses to re-open for
  // the session that closed it. Nothing changes `sessionKey` short of a SUCCESSFUL logout
  // and a new login, so the device stayed shut: the #28 write queue stopped capturing
  // while a dose tap still toasted "saved offline — will sync when you reconnect", drafts
  // stopped saving, snapshots stopped refreshing. A shipped feature, silently dead, on
  // the path the error boundary invites the person onto — "Something went wrong … Reload
  // the app".
  //
  // ── "THE CALL THREW" IS NOT THE SIGNAL. IT IS TRUE ON BOTH OUTCOMES. ────────────────
  //
  // The first version of this undid the close in a bare `catch`, and that undid EVERY
  // logout, including every one that worked. `logoutAction` ends in `redirect("/login")`,
  // and Next rejects the client promise of a redirecting Server Action deliberately —
  // `server-action-reducer.js` says so in its own comment: "the action promise will be
  // rejected with a redirect so that it's handled by RedirectBoundary as we won't have a
  // valid action result to resolve the promise with." So the happy path arrived here as
  // an exception, the gate was re-opened behind a session that had just been destroyed,
  // and a surviving tab went on capturing doses under "Dose saved offline".
  //
  // Nothing caught it because every test of this window HOLDS THE LOGOUT POST OPEN for
  // the duration of its assertions — the fixture constrained the world to the interval in
  // which the mistake is invisible. R-A2 in e2e/offline-write-gate.spec.ts is the test
  // that runs PAST the POST instead.
  //
  // TWO BARRIERS, and neither is trusted on its own — WHICH IS A CLAIM, SO EACH IS PINNED
  // BY A TEST THAT FAILS WHEN ONLY THAT BARRIER IS REMOVED. It was not, for one round, and
  // both barriers were individually deletable with the whole suite green: R-A2 cannot tell
  // which one stopped the undo, so it stays green on either mutant. A redundancy nothing
  // observes is not redundancy — it is one mechanism and a comment.
  //
  //   1. `unstable_rethrow` — the framework's own public API for "catch, but never
  //      swallow the framework's control flow". A redirect leaves here immediately, so a
  //      successful logout never reaches the undo and costs no extra request.
  //      PINNED BY R-A3: a logout that SUCCEEDS issues ZERO probes. Delete this line and
  //      the redirect rejection falls through to the probe, so the count is 1.
  //   2. THE SERVER IS ASKED. A framework that stopped rejecting on redirect, or a new
  //      error shape, must not be able to make barrier 1 the whole defence. The undo runs
  //      only when the server has NOT said the session is gone, and a 401 is the only
  //      thing that says so — it means `destroySession` ran.
  //      PINNED BY R-A4: a logout DELIVERED and then robbed of its response, with the
  //      probe reachable, leaves the gate shut. Drop this condition and the undo re-opens
  //      the gate for a session the server has already destroyed.
  //
  // UNREACHABLE COUNTS AS "NOT GONE", deliberately — and that is a TRADE, not a proof.
  // The earlier version of this comment claimed it was a proof: "a probe that cannot reach
  // the server is the case in which the logout cannot have landed either". That is false,
  // and the case it waves away is reachable.
  //
  //   WHAT IT GETS RIGHT — pressing Log out with no signal. The POST never left, the
  //   session is alive, and treating unreachable as "gone" would leave the device with its
  //   queue, drafts and snapshots shut for a session that never ended. That is this app's
  //   own subject matter and the entire reason this recovery exists.
  //
  //   WHAT IT GETS WRONG — a destroy that COMMITTED and lost only its answer. The POST can
  //   reach the server, `destroySession` can run, and the response can be dropped on the
  //   way back; the probe that follows cannot reach the server either, so this device
  //   re-opens the gate for a session that is already dead. Its surviving tabs go on
  //   writing drafts and intents, and those survive into the NEXT login — exactly what
  //   `clearDrafts` in lib/offline/draft-db.ts says must never happen.
  //
  // The default stays this way round because the other way is worse: "unreachable counts
  // as gone" bricks every logout pressed in a dead zone, which is the common case, while
  // this way round is wrong only in a case that also loses the response. It is not a
  // regression either — on main there is no gate at all and those writes land in every
  // ordering.
  //
  // IF THIS IS EVER TO BE MITIGATED RATHER THAN ANNOTATED, the bounded shape is: mark the
  // gate that `reopenForFailedLogout` re-opened, and re-ask the probe ONCE on the next
  // `online` or document load, scoped to that marked gate only — an ordinary expired
  // session answering 401 must still never wipe this device's reads. It is not done here
  // because its trigger misses its own scenario: the closer's document is on the error
  // boundary or bounced to /login, so the re-ask needs a surviving authenticated tab that
  // regains signal before the device is closed. That is the same way the deleted
  // `LOGOUT_SETTLE_MS` clock failed to pay for itself, and a new barrier here would need
  // its own pair of mutant-red tests to be worth more than this paragraph.
  async function submitLogout(): Promise<void> {
    try {
      await logoutAction();
    } catch (err) {
      unstable_rethrow(err);
      if (!(await sessionEndedOnServer())) await reopenForFailedLogout();
      throw err;
    }
  }

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
      <TrainingLogCalendar activeDates={activityDates} />
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
          <form action={submitLogout} ref={logoutFormRef}>
            <button
              // NOT type="submit" (#2908). The wipe below is an ASYNC IndexedDB
              // transaction and the submit is a NAVIGATION: as a submit button
              // these raced, and the navigation won often enough to leave one
              // login's device-local PHI — a med list and a dose schedule,
              // readable session-free at /offline — sitting there for the next
              // person. Reproduced at 1-in-10 under CPU contention; it had
              // simply never been observed because localStorage (the emergency
              // card) is synchronous and the queue's own leftovers are invisible.
              // So: wipe first, await it, THEN submit.
              type="button"
              onClick={() => void logoutAfterWipe()}
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
