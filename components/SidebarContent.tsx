"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconLogout, IconSearch, IconX } from "@tabler/icons-react";
import Nav from "@/components/Nav";
import IconButton from "@/components/IconButton";
import { openGlobalSearch } from "@/components/CommandPalette";
import Wordmark from "@/components/Wordmark";
import ProfileIdentityBar from "@/components/ProfileIdentityBar";
import { unstable_rethrow } from "next/navigation";
import {
  reopenUnlessSessionEnded,
  wipeDeviceForSignOut,
} from "@/components/device-wipe";
import { logoutAction } from "@/app/(app)/session-actions";
import {
  clearQueuedLogoutTap,
  hasQueuedLogoutTap,
  LOGOUT_BUTTON_ATTR,
  LOGOUT_PENDING_ATTR,
} from "@/lib/logout-tap";
import SidebarLogButton from "@/components/SidebarLogButton";
import ThemeToggle from "@/components/ThemeToggle";
import WhatsNewLink from "@/components/WhatsNewLink";
import type { SessionProfile } from "@/lib/auth";
import type { SegmentLogDays } from "@/lib/log-sheet";
import { DEFAULT_NAV_RELEVANCE, type NavRelevance } from "@/lib/nav-relevance";
import {
  clearProfileToastsForLogout,
  restoreToastProfileAfterFailedLogout,
} from "@/components/Toast";

// ── THE LOGOUT'S FAILURE RELAY, AT MODULE SCOPE ON PURPOSE (#3605) ───────────────────
//
// A logout OUTLIVES the control that started it, and used not to. `logoutAfterWipe`
// wiped this device and then issued the sign-out with
// `logoutFormRef.current?.requestSubmit()` — a DOM read, on a node that is gone if the
// mobile drawer unmounts while the async wipe is in flight, which four ordinary
// gestures do (components/MobileNav.tsx: the scrim, Escape, the ✕, the drag). The `?.`
// then made that a SILENT no-op: PHI wiped, write gate shut, no POST, no error, no
// rejection, and a session still alive behind someone who believes they left.
//
// So the sign-out is now issued by CALLING `submitLogout` — a plain async function on
// the same closure, which the unmount cannot take away. What the form was also giving,
// and what therefore had to be replaced rather than dropped, is measured and specific:
// `<form action={fn}>` + `requestSubmit()` runs the action inside `startHostTransition`
// and hands a REJECTED action to the nearest error boundary, re-thrown in render. That
// is the entire difference — nothing in this form reads `useFormStatus` or
// `useActionState`, and the pending state here is hand-rolled — and it is not
// cosmetic: it is the only reason a logout that FAILS is visible at all, since
// `submitLogout` reports both of its outcomes by throwing (a redirect for the one that
// worked, the real error for the one that did not).
//
// This is that, without the node. Every mounted SidebarContent subscribes a setter;
// the raiser hands the error to each, and the next render throws it — reaching the
// SAME boundaries the form's rejection reached (RedirectBoundary for the redirect,
// app/global-error.tsx for a failure, since app/(app)/error.tsx sits inside the layout
// that renders this and so cannot see it).
//
// A SET, AND NOT A REF OR A SINGLE SLOT, because this component renders TWICE on a
// phone: the drawer's copy and the layout's `<aside>`, which is `hidden … md:flex` —
// display:none below `md`, but MOUNTED. That is what makes the relay reach a listener
// in exactly the case the defect is about: the drawer's instance can go, the layout's
// cannot without the whole app layout going. When the set is empty the app layout is
// already gone (bounced to /login, or on global-error) and there is no tree left to
// throw into; that is the honest end of this path, not a swallow.
const logoutFailureListeners = new Set<(err: unknown) => void>();

function raiseLogoutFailure(err: unknown): void {
  for (const raise of logoutFailureListeners) raise(err);
}

// The single source of truth for the sidebar's contents. Rendered
// verbatim by BOTH the desktop sidebar (app/(app)/layout.tsx) and the mobile
// drawer (components/MobileNav.tsx), so anything added here appears on every
// viewport — the two responsive surfaces can no longer drift (which is how the
// mobile drawer silently lacked the profile switcher/logout).
//
// The footer carries no commit hash (#3154). It was the one sidebar element a
// non-technical person never reads, and "what am I running?" already has an
// answer where "what changed?" is asked — the What's new page renders
// <AppVersion /> in its own subtitle, as do Settings and Settings → Server. So
// this is a deletion and not a move: nothing had to be built to receive it.
//
// Drawer-specific behavior is opt-in via props, so the desktop sidebar renders
// the same content without it:
//   - onNavigate: closes the drawer after an action that doesn't itself navigate
//     (e.g. "log activity" opens a modal); navigations already close it via the
//     drawer's pathname effect.
//   - onClose: when set, renders the drawer's close (✕) button beside the wordmark.
//   - inDrawer: ONE boolean naming the HOST, not a per-difference style knob, and
//     the only one this component gets. Three behaviors read it, all of them the
//     same shape of decision — "a phone is not a small desktop":
//       · nav groups fold on the sidebar and render inline in the drawer
//         (#3343 Q4 — see components/Nav.tsx);
//       · the Search… ⌘K row and the "+ Log" row are SIDEBAR-ONLY (#4102). On a
//         phone the dock owns both triggers — a Search slot and the raised puck —
//         and a drawer row that re-opens the same shared surface is a second
//         permanently-listed trigger for a thing already one tap away. The rows
//         were deleted from the drawer rather than from the app: desktop has no
//         dock, so there they are the ONLY triggers and they stay.
//     The identity bar used to read it too, in the opposite direction, and #4102
//     removed that difference: the bar now rides the top of BOTH surfaces,
//     because the phone top bar it used to live in has retired. `brandChrome` is
//     the surviving rule and it is #1801's own, not a host fact — identity chrome
//     when identity is ambiguous, brand chrome when it isn't.
//     Anything else that differs by surface belongs behind this same boolean; a
//     second one would be the parallel contract this repo keeps refusing.
//
// The profile MENU that used to sit at the bottom of this file is gone (#1801):
// the identity bar + its switcher panel are the one switcher now. What stayed at
// the bottom is the LOGIN half — "Signed in as <username>" (#1013) beside the
// control that ends the login — because login identity belongs with logout, not
// in a profile switcher.
export default function SidebarContent({
  active,
  username,
  profiles,
  viewIds = [],
  readOnlyIds = [],
  inDrawer = false,
  adultContentAvailable = true,
  trainingRelevant = true,
  isAdmin = false,
  multiProfile = false,
  foodLoggingRelevant = true,
  hasIntakeItems = false,
  relevance = DEFAULT_NAV_RELEVANCE,
  reviewCount = 0,
  substanceRelevant = false,
  logHabitDays = null,
  readOnly = false,
  whatsNewUnseen = false,
  onNavigate,
  onClose,
}: {
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
  // See the note above: false for the desktop sidebar, true for the mobile
  // drawer. The one fact about the HOST this shared content is allowed to know.
  inDrawer?: boolean;
  // Known-adult predicate for the Longevity nav entry. Logging stays available.
  adultContentAvailable?: boolean;
  // Workout product relevance for the active profile (false below age 5).
  trainingRelevant?: boolean;
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
  // The two inputs the log menu needs beyond `relevance` (#3327, #2709), resolved
  // once by the shell and threaded through this ONE shared component so the
  // desktop panel and the phone sheet offer the same rows in the same order.
  substanceRelevant?: boolean;
  logHabitDays?: SegmentLogDays | null;
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
  const logoutButtonRef = useRef<HTMLButtonElement>(null);
  const activeProfileIdRef = useRef(active.id);
  useEffect(() => {
    activeProfileIdRef.current = active.id;
  }, [active.id]);
  // A logout STARTS ONCE. Two callers can reach `logoutAfterWipe` (the queued-tap
  // effect below and the button's own onClick), and there is a real interval —
  // React attached, its effect not yet run — in which a single tap reaches both.
  // A ref rather than the `pending` state because the guard must hold WITHIN one
  // render, before any re-render could have been committed.
  const logoutStarted = useRef(false);
  const [logoutPending, setLogoutPending] = useState(false);
  // How an in-flight logout reports back once nobody is holding it — see the relay
  // above. Stored as a thunk because a React setter treats a bare function argument
  // as an updater, and an error is only ever handed on, never applied to.
  const [logoutFailure, setLogoutFailure] = useState<(() => unknown) | null>(
    null
  );

  useEffect(() => {
    const raise = (err: unknown) => setLogoutFailure(() => () => err);
    logoutFailureListeners.add(raise);
    return () => {
      logoutFailureListeners.delete(raise);
    };
  }, []);

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
  //   the logout wipe (`clearQueue` in lib/offline/queue-db.ts) says must never happen.
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
  //
  // AND THE RESET BELOW IS BOOKKEEPING, NOT THE THING THE PERSON SEES — corrected
  // here (#3605) because this paragraph used to claim otherwise. It said the reset
  // was what stops the control claiming to be working, and that was true of an
  // earlier shape. It is not true now: the `throw err` two lines later leaves this
  // component, and app/(app)/error.tsx sits INSIDE the layout that renders the
  // sidebar, so nothing here catches it — it reaches app/global-error.tsx, which
  // replaces the whole document (measured: the control is not in the DOM
  // afterwards). The person sees the error boundary. Nobody ever sees the reset
  // control.
  //
  // It stays anyway, and the reason is narrower than the one it replaced: this
  // function's catch is no longer the only place that learns a logout did not land,
  // because #3515 moved the outstanding-POST case UPSTREAM to the guard release in
  // `logoutAfterWipe` — the sign-out is issued and returns long before the action
  // settles, so a retry is already possible without waiting for this. What is left
  // for these three lines is to leave no false "working on it" behind on the paths
  // where the document is NOT replaced: a boundary that recovers, or a second
  // SidebarContent instance (the phone renders two) that outlives this throw.
  async function submitLogout(): Promise<void> {
    try {
      await logoutAction();
    } catch (err) {
      unstable_rethrow(err);
      await reopenUnlessSessionEnded();
      restoreToastProfileAfterFailedLogout(activeProfileIdRef.current);
      logoutStarted.current = false;
      setLogoutPending(false);
      restoreToastProfileAfterFailedLogout(activeProfileIdRef.current);
      clearQueuedLogoutTap(logoutButtonRef.current);
      throw err;
    }
  }

  // Wipe this device's PHI, THEN log out. `wipeDeviceForSignOut` (components/device-wipe)
  // is the shared one — the family screen's "delete your own login" and "sign my login out
  // of every device" end this device's session too and call exactly the same thing.
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
  //
  // PENDING IS SET FIRST, AND ON EVERY PATH, not only the queued one (#3515). The
  // person who taps early and the person who taps late must see the same control
  // do the same thing; a pending state that appeared only after a tap that was
  // nearly lost would be a tell about the app's internals and nothing else. The
  // accessible NAME is deliberately unchanged — it is still "Log out", because the
  // control has not become a different control, and `aria-busy` is the attribute
  // that carries "working on it".
  const logoutAfterWipe = useCallback(async (): Promise<void> => {
    if (logoutStarted.current) return;
    logoutStarted.current = true;
    setLogoutPending(true);
    clearProfileToastsForLogout();
    try {
      await wipeDeviceForSignOut();
      // ISSUED BY CALLING IT, NOT BY REACHING FOR A NODE (#3605). See the relay at the
      // top of this file for the whole argument; the shape here is the part that must
      // not drift. NOT awaited, because `requestSubmit()` returned the instant the
      // action was dispatched and the guard release below depends on that: awaiting the
      // POST would hold the guard for the minutes a dead link takes, which is precisely
      // the latch #3515 exists to prevent. The rejection is handed to the relay because
      // NOTHING ELSE WILL NOW CONSUME IT — `submitLogout` reports both outcomes by
      // throwing, so an unattended promise here would make a SUCCESSFUL logout emit an
      // unhandled rejection on every single sign-out.
      void submitLogout().catch(raiseLogoutFailure);
      // AND THE GUARD IS RELEASED THE INSTANT THE SUBMIT IS ISSUED — deliberately
      // narrow, because the wide version reintroduces #3515's own harm. It exists
      // to stop the effect and the onClick both firing for ONE tap, and that window
      // is exactly the async wipe above; once the sign-out has been issued there is
      // no second caller left to collide with.
      //
      // Held any longer, it is held FOREVER on the case this app is about. Its only
      // other releases are in the two catches, and `submitLogout`'s cannot run while
      // the POST is outstanding — "a link that accepts the connection and then stops
      // carrying it sits for the browser's own connect/read timeout, which is
      // minutes" (components/device-wipe.ts). So an unanswered logout would latch
      // the control shut: every retry swallowed behind a spinner that says "working
      // on it" indefinitely, on a device whose PHI is already wiped and whose write
      // gate is already shut, with the session still alive and no escape but a
      // reload. That is the silence #3515 exists to remove, wearing the costume of
      // the fix for it.
      //
      // A LATER TAP RE-SUBMITTING IS CORRECT, and is what main does: four taps in a
      // dead zone are four attempts, and any one of them can land when signal
      // returns. Re-wiping costs nothing — `clearQueue` is idempotent and the gate
      // is already closed. `logoutPending` deliberately STAYS true: the attempt is
      // still open and the control should still say so.
      // Pinned by components/__tests__/logout-retry.test.tsx.
      logoutStarted.current = false;
    } catch (err) {
      // Nothing is in flight any more, so stop claiming otherwise — and drop the
      // boot script's marker too, since it is the other half of the same claim and
      // React does not own it. The happy path never lands here: it navigates away
      // still pending, which is the truth.
      logoutStarted.current = false;
      setLogoutPending(false);
      clearQueuedLogoutTap(logoutButtonRef.current);
      throw err;
    }
  }, []);

  // REPLAY A TAP THAT ARRIVED BEFORE THE HANDLER DID (#3515). `LOGOUT_BOOT_SCRIPT`
  // (lib/logout-tap.ts) marks the control from the document head; this is the first
  // moment the click could have done anything at all, so it is when it happens.
  //
  // Reading the marker off THIS instance's own node is what keeps it correct on a
  // phone: SidebarContent renders TWICE — the desktop sidebar and the mobile drawer
  // are the same component — and the mark sits on whichever button was actually
  // tapped, so the other instance sees nothing and does nothing.
  useEffect(() => {
    if (hasQueuedLogoutTap(logoutButtonRef.current)) void logoutAfterWipe();
  }, [logoutAfterWipe]);

  // Re-thrown in RENDER, and AFTER every hook above has run, which is what makes a
  // boundary see it — the same thing React does with a form action's rejection, and
  // the only way to reach a boundary from a promise that settled outside React's own
  // call stack.
  if (logoutFailure) throw logoutFailure();

  // IDENTITY CHROME **OR** BRAND CHROME, NEVER BOTH — #1801's own rule, applied
  // here in #3154 where it had only ever been applied to the phone top bar.
  //
  // The sidebar rendered the wordmark line AND the identity bar stacked, which is
  // 48px (a 32px row plus the column's gap) of a 768px viewport spent saying the
  // app's name directly above a bar that already says whose data this is. On the
  // seeded multi-profile admin at 1366x768 the refit's other four moves land the
  // column at 796px against 768 of room, and this is the 48 that closes it — so
  // the last thing still below the fold (the What's new / Disclaimer line) comes
  // back above it. A single-profile instance grows no identity bar, so it keeps
  // the wordmark exactly as before.
  //
  // AND THE DRAWER IS NO LONGER AN EXCEPTION TO IT (#4102). It used to be —
  // `inDrawer || !multiProfile` — because on a phone the acting profile was
  // readable in the top bar without opening anything, so repeating it inside the
  // drawer would have said the same thing twice. That bar has retired, and with
  // it the reason: the drawer is now the only place the question is answerable,
  // so the identity bar rides ITS top too, and the ✕ that used to sit beside the
  // wordmark sits beside whichever of the two this instance renders. A
  // single-profile instance still shows the wordmark row there, which is the XOR
  // holding rather than an omission.
  const brandChrome = !multiProfile;
  // The drawer's dismissal rides the identity/brand row, so that row must exist
  // whenever `onClose` does — it always does, since both branches render one.
  const closeButton = onClose ? (
    <IconButton type="button" label="Close menu" onClick={onClose}>
      <IconX className="h-5 w-5" stroke={1.75} />
    </IconButton>
  ) : null;
  return (
    <>
      {brandChrome ? (
        <div className="flex items-center justify-between gap-2">
          <Link href="/" className="flex items-center gap-2 rounded-lg px-2">
            <Wordmark markClassName="h-6 w-10" />
          </Link>
          {closeButton}
        </div>
      ) : (
        /* The identity bar (#1801) at the TOP of the sidebar and of the drawer —
        "whose data am I looking at, and who am I acting as?" answered before
        anything else on the surface, and it opens the switcher panel in place. */
        <div className="flex items-center justify-between gap-2">
          {/* `min-w-0 flex-1` is load-bearing, not tidying. A flex item's default
          `min-width: auto` is its MIN-CONTENT width, so without this the bar sizes
          itself to the widest it would like to be — two stacked avatars plus both
          profile names — and overflows its column instead of truncating inside it.
          Measured when the bar moved into the drawer (#4102): 337.6px of bar in a
          288px content box, hanging ~50px past the panel's right edge. The sidebar
          never showed it because the bar had no flex-row parent there. */}
          <div className="min-w-0 flex-1">
            <ProfileIdentityBar
              profiles={profiles}
              actingProfileId={active.id}
              viewIds={viewIds}
              readOnlyIds={readOnlyIds}
              readOnly={readOnly}
            />
          </div>
          {closeButton}
        </div>
      )}
      {/* Global search and the log affordance are the SIDEBAR'S triggers, and
      since #4102 only the sidebar's. On a phone the dock carries both — a Search
      slot opening this same palette, and the raised puck opening this same sheet
      — so a drawer row for either is a second listed trigger for a surface that
      is already one tap away with the drawer shut. Desktop has no dock, so there
      these are the only triggers and they are unchanged: the ⌘K palette (mounted
      once in the app layout, reached here through a custom event) and the #3154
      anchored log panel, ungated because the per-entry gates inside it decide the
      content (#2651). */}
      {!inDrawer && (
        <>
          <button
            type="button"
            onClick={() => {
              openGlobalSearch();
              onNavigate?.();
            }}
            className="flex items-center gap-2 rounded-lg border border-(--border) bg-surface px-3 py-2 text-sm text-slate-500 transition hover:bg-(--ghost-hover) dark:text-slate-400"
          >
            <IconSearch className="h-4 w-4 shrink-0" stroke={1.75} />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="hidden rounded-sm border border-black/10 px-1.5 py-0.5 font-mono text-xs text-slate-500 md:inline dark:border-white/10 dark:text-slate-400">
              ⌘K
            </kbd>
          </button>
          <SidebarLogButton
            onNavigate={onNavigate}
            cycleRelevant={relevance.cycle}
            substanceRelevant={substanceRelevant}
            logHabitDays={logHabitDays}
          />
        </>
      )}
      {/* The Frequent shortcuts are GONE (#4102), machinery included. With the
      dock covering the daily set and Search covering lookups they duplicated
      both — and they were the nav's only non-deterministic element, which is the
      dashboard arc's "a system that quietly changes is indistinguishable from a
      bug" applied to chrome. #1042's "no pinned/frecent nav machinery" now holds
      without exception. */}
      <Nav
        inDrawer={inDrawer}
        adultContentAvailable={adultContentAvailable}
        trainingRelevant={trainingRelevant}
        isAdmin={isAdmin}
        multiProfile={multiProfile}
        foodLoggingRelevant={foodLoggingRelevant}
        hasIntakeItems={hasIntakeItems}
        relevance={relevance}
        reviewCount={reviewCount}
      />
      {/* THE CALENDAR ROW IS GONE, from here and from the drawer (#4102/#4280).
      A day grid is a way of reading a history and the chrome is a way of reaching
      a page, so the grid opens from /history's own control row now — which is
      also why this component no longer takes an `eventDates` prop, and why
      `getTimelineDates` is no longer run for every page in the app shell. */}
      {/* The LOGIN block above the bordered box holding the theme toggle.
      "Signed in as <username>" (#1013) sits with logout because it names the
      thing logout ends — it was never a fact about the acting PROFILE, which is
      why it left the switcher in #1801. */}
      <div className="mt-auto flex flex-col gap-2">
        <div className="flex flex-col gap-1 rounded-lg border border-(--border) bg-surface p-1">
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
          {/* NO <form> (#3605). It had one job left — `requestSubmit()` — and that
          was the defect: the submit went through a DOM node the mobile drawer can
          unmount mid-wipe. It never carried a progressive-enhancement path either,
          for the three reasons lib/logout-tap.ts enumerates (type="button", a React
          onClick, and a CLIENT action React SSRs no usable attribute for), so what is
          left of it would be markup that only looks like a fallback. */}
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
            //
            // THAT TRADE COST THIS CONTROL ITS PRE-HYDRATION FALLBACK, and
            // #3515 is what was put back in its place. type="button" + a React
            // onClick + a client `action` means a tap before React attaches
            // used to do nothing at all and say nothing either. It is now
            // CAPTURED by LOGOUT_BOOT_SCRIPT and replayed by the effect above,
            // and the two markers below are what makes it visible meanwhile.
            ref={logoutButtonRef}
            type="button"
            // The boot script's selector, the effect's marker, and the CSS
            // hook for the pending state — one attribute, three readers.
            {...{ [LOGOUT_BUTTON_ATTR]: "" }}
            {...(logoutPending ? { [LOGOUT_PENDING_ATTR]: "" } : {})}
            aria-busy={logoutPending || undefined}
            // The boot script may have set data-logout-tapped and aria-busy on
            // this node before React ever saw it. That disagreement with the
            // server HTML is the feature, not a bug to be warned about.
            suppressHydrationWarning
            onClick={() => void logoutAfterWipe()}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-ink-750 dark:hover:text-slate-200"
          >
            {/* Both icons are always in the DOM and CSS decides which one shows
                  (app/globals.css). It has to be CSS: the pending state must be
                  paintable by an inline script in the head, with no React and no
                  bundle, which rules out rendering the spinner conditionally. */}
            <IconLogout
              className="logout-idle-icon h-4 w-4 shrink-0"
              stroke={1.75}
            />
            <svg
              data-testid="logout-pending"
              className="logout-pending-spinner h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            Log out
          </button>
        </div>
        {/* The theme toggle keeps the box; the commit hash that shared it as the
        second half is gone (#3154). */}
        <div className="flex rounded-lg border border-(--border) bg-surface p-1">
          <ThemeToggle bare />
        </div>
        {/* Persistent footer link to the single Disclaimer surface (issue #1049).
        Lives in the shared content so it renders on BOTH the desktop sidebar and
        the mobile drawer (the responsive-surfaces rule) — the one always-reachable
        pointer to the app's medical-disclaimer posture, replacing the ~40 inline
        banners that used to hand-write it. */}
        {/* "What's new" sits beside the Disclaimer link (issue #1421): the
        bundled release notes answer "what did that pull bring?" — and since #3154
        they also carry the running commit hash, which is where the footer's own
        copy went. A
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
