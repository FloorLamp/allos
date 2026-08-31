import MobileNav from "@/components/MobileNav";
import MobileDock from "@/components/MobileDock";
import MobileChromeProvider from "@/components/MobileChromeProvider";
import SidebarContent from "@/components/SidebarContent";
import CommandPalette from "@/components/CommandPalette";
import ActivityEditorProvider from "@/components/ActivityEditorProvider";
import QuickEntryProvider from "@/components/QuickEntryProvider";
import { measurementsQuickEntry } from "@/lib/quick-entry-measurements";
import PullToRefresh from "@/components/PullToRefresh";
import QuickShortcutHandler from "@/components/QuickShortcutHandler";
import ExtractionToaster from "@/components/ExtractionToaster";
import ImportJobsToaster from "@/components/ImportJobsToaster";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import OfflineQueueProvider from "@/components/OfflineQueueProvider";
import DirtyFormProvider from "@/components/DirtyFormRegistry";
import { ActiveProfileProvider } from "@/components/ActiveProfileProvider";
import ProfileSwitchWatcher from "@/components/ProfileSwitchWatcher";
import OfflineSnapshotRefresher from "@/components/OfflineSnapshotRefresher";
import ShellChrome from "@/components/ShellChrome";
import OnboardingReturnBanner from "@/components/OnboardingReturnBanner";
import TravelTimezoneBanner from "@/components/TravelTimezoneBanner";
import {
  hasUnseenNotes,
  loadReleaseNotes,
  newestNoteDate,
} from "@/lib/release-notes";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { WeekStartProvider } from "@/components/WeekStartProvider";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";
import {
  getOnboardingState,
  getUnitPrefs,
  getDisplayFormatPrefs,
  getTimezone,
  getWeekStart,
  getWhatsNewSeenDate,
  getHomeTimezone,
  getDismissedTravelZone,
} from "@/lib/settings";
import { getProfileAge } from "@/lib/settings/profile-attrs";
import { isMinor } from "@/lib/life-stage";
import { hasLoggedSubstance } from "@/lib/queries/substance";
import { getEquipment } from "@/lib/equipment";
import {
  isFoodLoggingRelevant,
  isLongevityRelevant,
  isStrengthTrainingRelevant,
  isTrainingRelevant,
} from "@/lib/life-stage";
import { requireSession } from "@/lib/auth";
import { requireScope } from "@/lib/scope";
import { isViewingSelf, writeSubjectName } from "@/lib/own-profile";
import {
  getActivitySuggestions,
  getRecentExerciseHistory,
  getLatestBodyMetric,
  getImportReviewCount,
  getRecentActivityEquipmentIds,
  getMostRecentActivityEditData,
  getActivityEditData,
  getWorkoutPresence,
  getNiggleContext,
  profileHasIntakeItems,
  getNavRelevance,
} from "@/lib/queries";
import { getSegmentLogDays } from "@/lib/queries/log-sheet";
import { getFormDeloadContext } from "@/lib/routines";
import { getFormRecoveringContext } from "@/lib/injuries";
import { excludedRegions } from "@/lib/injury-model";
import { niggleTempers } from "@/lib/niggle-model";
import { buildActivePlateauHints } from "@/lib/rule-findings";
import { getRpeTracking } from "@/lib/rpe-tracking";
import { today } from "@/lib/db";
import { requestNowMs } from "@/lib/request-now";

// Authenticated app shell. requireSession() is the authoritative gate for the
// entire (app) route group — it redirects to /login when there's no live
// session. Every page under here is dynamic (it reads cookies() transitively),
// which is intended: it prevents the full-route cache from leaking one session's
// rendered data to another.
//
// NO `loading.tsx` here (or in child segments) — deliberately. A route-segment
// loading.tsx wraps the page in a Suspense boundary and opts it into streamed
// rendering: on a SLOW server render (loaded CI runners) React flushes the
// skeleton fallback first, then streams the real page into a `<div hidden
// id="S:…">` that an inline `$RC(…)` script relocates into place. When the
// client bundle hydrates and reaches that boundary while it is still showing the
// fallback (its content chunk hasn't arrived yet), React client-renders the
// boundary content — and for a window the server-streamed subtree and the
// client-rendered subtree COEXIST in the DOM (the classic tell: two copies of a
// server-action `<form>`, one carrying react-dom-server's short "React form
// unexpectedly submitted." error and one carrying react-dom-client's long
// variant). Playwright strict-mode locators then resolve that transient hidden
// duplicate as "2 elements" — the Next-16 e2e flake class in issue #530.
// Because better-sqlite3 is synchronous the pages have nothing to progressively
// stream toward anyway, and this layout already blocks TTFB on its own queries,
// so dropping the streamed boundary renders each page inline in the shell and
// hydrates it in a single non-racing pass. Do not re-introduce loading.tsx
// under (app) without solving that race (verified in #530: with loading.tsx a
// slow render emits S:…/$RC/hidden-div; without it the same slow render sends
// the page inline with no boundary).
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nowMs = requestNowMs();
  const session = await requireSession();
  const { login, profile } = session;
  // The cross-profile scope (issue #1096): the persisted view-set (∩ accessible),
  // resolved once at the shell so the identity bar's stacked avatars and the
  // switcher panel's view toggles read the SAME validated viewIds. Its
  // disambiguated `profiles` (#534) name every row and avatar.
  const scope = await requireScope();
  // Accessible profiles this login holds only READ access on (issue #33) — the
  // per-row hint in the switcher panel. Read off the scope's already-resolved
  // access map, so no surface re-runs accessForProfile.
  const readOnlyIds = scope.profiles
    .filter((p) => scope.access.get(p.id) === "read")
    .map((p) => p.id);
  // Own-profile link (#1013): the acting profile's subject name when the login is
  // acting as someone OTHER than its own profile (null when acting as self / no
  // own-profile set). Threaded to the live workout editor + dock — the fastest-
  // tapping surface, where wrong-profile writes happen — so "Finish workout" becomes
  // "Finish workout — Mia". Disambiguated names come from the scope (#534).
  const actingSubjectName = writeSubjectName(
    scope.ownProfileId,
    scope.actingProfileId,
    scope.profiles.find((p) => p.id === scope.actingProfileId)?.name ??
      profile.name
  );

  const units = getUnitPrefs(login.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const timezone = getTimezone(profile.id);
  const weekStart = getWeekStart(profile.id);
  const profileAge = getProfileAge(profile.id);
  const adultContentAvailable = isLongevityRelevant(profileAge);
  const trainingRelevant = isTrainingRelevant(profileAge);
  const strengthTrainingAvailable = isStrengthTrainingRelevant(profileAge);
  const suggestions = getActivitySuggestions(profile.id);
  // One extra session per exercise: the editor filters out the activity being
  // logged (which auto-save inserts into its own history) and still shows 3.
  const exerciseHistory = getRecentExerciseHistory(profile.id, 4);
  const equipment = getEquipment(profile.id);
  // Recently-used session gear, most-recent-first (issues #342/#339) — defaults the
  // activity form's equipment picker on a new non-strength log, narrowed per-activity
  // (last-used shoes for a run, last-used bike for a ride) by the form.
  const recentActivityEquipment = getRecentActivityEquipmentIds(profile.id);
  const bodyweightKg = getLatestBodyMetric(profile.id, "weight");
  // The most recent activity seeds the "Repeat last activity" palette command +
  // mobile quick action (issue #337).
  const lastActivity = getMostRecentActivityEditData(profile.id);
  // The strength editor's two deload/plateau inputs (#923).
  // `deloadContext` shaves the next-set suggestion on a
  // routine deload week; `plateauHints` renders the calm inline plateau hint. Both read
  // the SAME gathers the Training-watch / session-card surfaces use, so nothing drifts.
  const now = today(profile.id);
  const deloadContext = getFormDeloadContext(profile.id, now);
  // The recovering-injury context the form tempers by (#1144): the coarse regions
  // returning from a RECOVERING injury (#838), read from the SAME temperedRegions gather
  // the Analyze/detail panel uses so the live logger and its deep-link target agree on
  // the injury axis (#221/#1115).
  const injuryContext = getFormRecoveringContext(profile.id);
  const recoveringContext = {
    ...injuryContext,
    niggleTempers: niggleTempers(
      getNiggleContext(profile.id),
      excludedRegions(injuryContext.constraints),
      now
    ),
  };
  const plateauHints = buildActivePlateauHints(profile.id, now);
  // The set grid's effort column is opted into (#3335): this is null unless the
  // profile holds the opt-in row, and null is the whole reason no surface can render
  // an RPE control for someone who never asked for one.
  const rpeTracking = getRpeTracking(profile.id);
  // Derived workout presence (#921) for the app-wide minimized dock: on a fresh load
  // (or another device) the dock hydrates from this gather + the persisted #451 draft
  // instead of client memory. Acting-profile-scoped. `liveStartEpochMs` places the elapsed clock off the real
  // session start.
  const presence = getWorkoutPresence(profile.id);
  const liveEditData =
    presence?.state === "active" && presence.activityId != null
      ? getActivityEditData(profile.id, presence.activityId)
      : null;
  const liveStartEpochMs =
    presence?.state === "active" ? nowMs - presence.sinceMin * 60_000 : null;
  // Unopened bundled release notes for this LOGIN (issue #1421) — the ONE pure
  // comparison (hasUnseenNotes over the newest bundled note date vs the login's
  // stored seen marker), resolved once here and threaded into the shared sidebar
  // content so both viewports render the same calm dot. Login-scoped, so it does
  // not change when the acting profile does.
  const whatsNewUnseen = hasUnseenNotes(
    newestNoteDate(loadReleaseNotes()),
    getWhatsNewSeenDate(login.id)
  );
  // Gates any admin-only nav entries in both surfaces.
  const isAdmin = login.role === "admin";
  // The Household overview is cross-profile; show it only when the caller can
  // reach 2+ profiles (issue #31) — an admin sees every profile, a caregiver
  // member sees their granted set, and a single-profile login never sees it.
  const multiProfile = scope.profiles.length > 1;
  // Hides the Nutrition nav entry for an infant profile (< 1 y) — the adult
  // food-group serving catalog is meaningless there (issue #591). Cosmetic; the
  // /nutrition page independently gates on the same predicate. Eligible on
  // unknown age (hide only on a positive infant match).
  const foodLoggingRelevant = isFoodLoggingRelevant(profileAge);
  // Keeps the Nutrition nav entry (→ Supplements tab) reachable for an infant who
  // takes a supplement even though food-group logging isn't relevant (#746). The
  // Food tab still gates server-side on isFoodLoggingRelevant.
  const hasIntakeItems = profileHasIntakeItems(profile.id);
  // The nav-relevance bitset (issue #1042): Cycle relevance (data wins; else
  // female + premenopausal via explicit status or the #494 age fallback) and the
  // Vision/Dental data-presence gates. Resolved ONCE here and threaded through
  // the shared SidebarContent so both viewports agree; cosmetic — the pages
  // never hard-block on a direct URL.
  const relevance = getNavRelevance(profile.id);
  // Count of integrations currently in a failed state — drives the header
  // "import review" badge (Data → Review). Self-clearing on the next good sync.
  const reviewCount = getImportReviewCount(profile.id);
  // The caller holds only READ access on the active profile (issue #33) — a
  // member with a read-only grant. Drives the "read-only" hint in the profile
  // menu; every mutating action is independently gated server-side.
  const readOnly = session.access === "read";
  // Which domain this profile actually logs in, as DAYS-LOGGED per sheet segment
  // over the trailing quarter (#2709). It decides the log sheet's opening segment
  // on the DASHBOARD only — every other route either promotes its own domain or
  // keeps the historical activity fallback — but the menu is mounted by this
  // shell on every route, so the gather is here rather than on the page. ONE
  // hoisted statement; the decision, the window and the no-history fallback all
  // live in lib/log-sheet.ts, never in a component.
  //
  // Its COST is unconditional, and that was weighed rather than overlooked
  // (#2720). The reason used to be that it stays unconditional DESPITE desktop,
  // "where the sheet does not exist and nothing reads the result" — #3154 made
  // that sentence false: the desktop sidebar's "+ Log" panel renders the same
  // menu and opens on the same segment. It is now read at both widths. It stays
  // unconditional for the other half of the original reason — the layout cannot
  // see the pathname, which is exactly why `pathname === "/"` is decided
  // client-side in the menu — and because a lazy fetch would cost more than it
  // saves. EXPLAIN QUERY PLAN on the migrated schema: all eight
  // arms are index SEARCHes, six of them seeking straight to (profile, date) and
  // four covering; `metric_samples` and the `intake_item_logs` join seek on the
  // profile alone and filter the date, so those two read a profile's own history
  // rather than a quarter's slice, which is the only part of this that grows.
  // Against one compiled statement on a synchronous local SQLite that is cheaper
  // than the round trip deferring it would add, on the hottest path there is. So
  // the trigger for revisiting this is an arm losing its index — or those two
  // gaining a date-leading one, if a heavy profile ever makes it worth measuring.
  const logHabitDays = getSegmentLogDays(profile.id, now);
  // Whether the log menu offers a SUBSTANCE row (#3327), which is two facts and not
  // a nav bit — no nav entry reads it, so it deliberately does not join `relevance`.
  //
  //   • the #1174 life-stage gate the whole substance surface carries (`isMinor`, the
  //     same predicate `getRecordsSpecialtyRelevance().substanceUse` applies — spelled
  //     from `profileAge` here rather than re-running that whole bitset for one bit);
  //   • data presence. #3279 ruling 3 admits a substance to the quick surfaces on the
  //     dashboard's data-presence rule, not for the vocabulary at large — and a
  //     profile that tracks none must get no row at all, because an empty offer is
  //     worse than no offer. One indexed EXISTS probe per shell render, the cheap half
  //     of the question; the LIST is gathered later, on open, by the overlay's own read
  //     action, which is both cheaper and fresher (#1468).
  const substanceRelevant =
    !isMinor(profileAge) && hasLoggedSubstance(profile.id);
  // Travel (#3263). The banner is for the login's OWN profile only — a member
  // acting for someone else must see nothing, because this device's location says
  // nothing about where THAT person's day should run. Resolved here so the client
  // never has to decide whose profile it is looking at.
  const ownProfileActing = isViewingSelf(scope);
  const travelHomeZone = ownProfileActing ? getHomeTimezone(profile.id) : null;
  const travelDismissedZone = ownProfileActing
    ? getDismissedTravelZone(profile.id)
    : null;
  const onboarding = getOnboardingState(profile.id);
  const showOnboardingReturn =
    onboarding?.status === "in_progress" &&
    onboarding.basicsComplete &&
    !onboarding.notificationsReviewed;
  return (
    <TimezoneProvider tz={timezone}>
      <WeekStartProvider weekStart={weekStart}>
        <FormatPrefsProvider prefs={formatPrefs}>
          <ConfirmProvider>
            {/* The acting profile, for device-local state that must be keyed by
                SUBJECT — form drafts above all (#1699), so a profile switch can
                never surface another subject's half-typed entry. */}
            <ActiveProfileProvider profileId={profile.id}>
              {/* The dirty-form registry (#1878). Outermost of the client
                  providers because every chrome actor that repaints the page —
                  the offline queue's post-sync refresh, the import and
                  extraction toasters — sits inside it and routes its
                  `router.refresh()` through `useChromeRefresh`, so a background
                  repaint can never land on a half-typed record form. It defers
                  those refreshes; it never adds one, never removes one, and
                  never touches a refresh the USER asked for. */}
              <DirtyFormProvider>
                <OfflineQueueProvider
                  activeProfileId={profile.id}
                  deviceSessionKey={session.deviceSessionKey}
                >
                  <ProfileSwitchWatcher activeProfileId={profile.id} />
                  {/* Offline read snapshots (#2908): an authenticated visit
                  refreshes whatever the device holds that is absent or past its
                  clock, and nothing else — no background sync, no service-worker
                  credentials. Mounted here beside the write queue because the two
                  are halves of one offline story and share one IndexedDB
                  perimeter. */}
                  <OfflineSnapshotRefresher activeProfileId={profile.id} />
                  {/* The shared quick-entry overlay host (#1468). Inside
                  OfflineQueueProvider by necessity: the forms it mounts
                  (MeasurementsQuickAdd) queue offline writes, and it
                  renders them as its OWN children, so they must sit under that
                  provider. It gathers nothing until a sheet row is tapped —
                  except the measurements props, resolved HERE (#4091) because a
                  Server Action cannot be on the critical path of a surface people
                  are expected to reach with no connection. */}
                  <QuickEntryProvider
                    measurements={measurementsQuickEntry(login.id, profile.id)}
                  >
                    <ActivityEditorProvider
                      units={units}
                      suggestions={suggestions}
                      history={exerciseHistory}
                      equipment={equipment}
                      recentActivityEquipment={recentActivityEquipment}
                      bodyweightKg={bodyweightKg}
                      trainingRelevant={trainingRelevant}
                      strengthTrainingAvailable={strengthTrainingAvailable}
                      lastActivity={lastActivity}
                      deloadContext={deloadContext}
                      recoveringContext={recoveringContext}
                      plateauHints={plateauHints}
                      rpeTracking={rpeTracking}
                      presence={presence}
                      liveEditData={liveEditData}
                      liveStartEpochMs={liveStartEpochMs}
                      subjectName={actingSubjectName}
                    >
                      {/* The phone chrome's shared open/closed state (#2651):
                      the drawer and the log sheet each have two triggers now —
                      the top bar's hamburger and caret, and the dock's More slot
                      and puck — and the two bars sit in different subtrees. */}
                      <MobileChromeProvider>
                        <div className="flex min-h-screen">
                          <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-black/10 bg-(--nav) p-4 md:flex print:hidden dark:border-white/5">
                            <SidebarContent
                              active={session.profile}
                              username={login.username}
                              // The scope's DISAMBIGUATED set (#534) — two accessible
                              // profiles can share a name, and the bar/panel must name
                              // a specific one.
                              profiles={scope.profiles}
                              viewIds={scope.viewIds}
                              readOnlyIds={readOnlyIds}
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
                              substanceRelevant={substanceRelevant}
                              logHabitDays={logHabitDays}
                            />
                          </aside>
                          {/* clip (not hidden) so it doesn't force overflow-y to auto, which
            turns <main> into a scroll container and breaks position:sticky inside it.
            min-w-0 lets this flex item shrink below its content's intrinsic width —
            without it, wide tables/rows blow the whole page out horizontally. */}
                          {/* FIRST-PAINT CLEARANCE ONLY (#4102, #4282). Without this the first line
            of every page would print under the status bar, which is what
            `viewportFit: cover` means. It is PADDING, so it positions and paints
            nothing: content scrolls under the notch, and #4282 ruled that IS
            edge-to-edge. A sticky strip therefore cannot lean on it and carries
            `top-edge-safe` (app/globals.css) itself; the token rather than a
            second `env()` for the reason the page gutter is one.
            Below `md` only: the desktop shell never paid this. */}
                          <main className="min-w-0 flex-1 overflow-x-clip pt-(--top-edge-inset) md:pt-0">
                            {/* THE STICKY CHROME NOW HOLDS ONLY WHAT A PAGE PUT IN
                    IT (#4102). It was built for the phone top bar's hide-on-scroll
                    (issue #1416), and that bar has retired: the dock is the phone's
                    one chrome, so below `md` this element is EMPTY on every page
                    that registers no tab-first strip, which is what puts the first
                    page pixel at the viewport top. It still earns its place on the
                    pages that do register one — a page-owned strip that hides and
                    reveals as one unit, mounted standalone. */}
                            <ShellChrome />

                            {/* max(padding, safe-area inset) keeps content clear of the
              notch in landscape and the home indicator at the bottom now
              that the viewport paints edge-to-edge (viewportFit cover).
              Density (issue #1416, section A): pt-4 / 1rem gutters below `md`,
              the unchanged pt-8 / 1.25rem from `md` up. The conditional variant
              this used to carry went with the view banner (#1801): the chrome no
              longer grows a second row, so the padding is unconditional again.
              THE HORIZONTAL PAIR IS A TOKEN, not the expression spelled here
              (#3920): below `sm` a band CANCELS this gutter, and a cancel written
              from a COPY of the expression is one edit away from under-cancelling a
              notched side. `--page-gutter-left` / `--page-gutter-right` live in
              app/globals.css, with the `md` step to 1.25rem. */}
                            <div
                              data-testid="app-content-container"
                              className="mx-auto pt-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pl-(--page-gutter-left) pr-(--page-gutter-right) md:pt-8 md:pb-[max(2rem,env(safe-area-inset-bottom))] 3xl:max-w-[110rem]"
                            >
                              {/* This slot is OnboardingReturnBanner's alone again
                            (#1795). The deploy notice used to render here too, as a
                            second surface for the event the service worker's update
                            bar already owns — one deploy, two notices, two reload
                            buttons. There is one now, and it is the bar mounted by
                            ServiceWorkerRegister in the root layout. */}
                              <OnboardingReturnBanner
                                show={showOnboardingReturn}
                              />
                              <TravelTimezoneBanner
                                ownProfile={ownProfileActing}
                                profileZone={timezone}
                                homeZone={travelHomeZone}
                                dismissedZone={travelDismissedZone}
                              />
                              {children}
                            </div>
                          </main>
                        </div>
                        {/* The phone's nav drawer and quick-log sheet (#2746/#4102).
                      It renders NO chrome — both are overlays, opened from the
                      dock — so it sits here as a sibling of <main> rather than
                      inside <ShellChrome>, which exists to hide a sticky bar that
                      no longer exists. */}
                        <MobileNav
                          active={session.profile}
                          username={login.username}
                          profiles={scope.profiles}
                          viewIds={scope.viewIds}
                          readOnlyIds={readOnlyIds}
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
                          substanceRelevant={substanceRelevant}
                          logHabitDays={logHabitDays}
                        />
                        {/* The bottom dock (#2651) — mobile widths only, and a
                      SIBLING of <main> rather than a child of <ShellChrome>: that
                      wrapper transforms itself to hide on scroll, and a
                      transformed ancestor re-parents `position: fixed` to itself,
                      which would slide the dock off the bottom of the screen with
                      whatever the chrome is hiding. */}
                        <MobileDock trainingRelevant={trainingRelevant} />
                      </MobileChromeProvider>
                      <CommandPalette
                        profileName={session.profile.name}
                        weightUnit={units.weightUnit}
                      />
                      {/* PWA home-screen shortcuts land here (#1424): reads
                      `?quick=` and opens the SAME activity editor / quick-entry
                      overlay / palette the sheet does. Beside CommandPalette so
                      it sits inside both contexts it dispatches into, and
                      viewport-agnostic — the shortcut URL is an ordinary link. */}
                      <QuickShortcutHandler
                        cycleRelevant={relevance.cycle}
                        substanceRelevant={substanceRelevant}
                      />
                      <ExtractionToaster profileId={profile.id} />
                      <ImportJobsToaster profileId={profile.id} />
                      {/* Standalone-PWA pull-to-refresh (#1428). Renders nothing and
                      listens to nothing in a browser tab, where the browser's own
                      refresh already exists. */}
                      <PullToRefresh />
                    </ActivityEditorProvider>
                  </QuickEntryProvider>
                </OfflineQueueProvider>
              </DirtyFormProvider>
            </ActiveProfileProvider>
          </ConfirmProvider>
        </FormatPrefsProvider>
      </WeekStartProvider>
    </TimezoneProvider>
  );
}
