import MobileNav from "@/components/MobileNav";
import SidebarContent from "@/components/SidebarContent";
import CommandPalette from "@/components/CommandPalette";
import ActivityEditorProvider from "@/components/ActivityEditorProvider";
import ExtractionToaster from "@/components/ExtractionToaster";
import ImportJobsToaster from "@/components/ImportJobsToaster";
import VersionWatcher from "@/components/VersionWatcher";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import OfflineQueueProvider from "@/components/OfflineQueueProvider";
import ProfileSwitchWatcher from "@/components/ProfileSwitchWatcher";
import ProfileViewStrip from "@/components/ProfileViewStrip";
import OnboardingReturnBanner from "@/components/OnboardingReturnBanner";
import { getAppVersion } from "@/lib/version";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { WeekStartProvider } from "@/components/WeekStartProvider";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";
import {
  getOnboardingState,
  getUnitPrefs,
  getDisplayFormatPrefs,
  getTimezone,
  getWeekStart,
} from "@/lib/settings";
import { getUserAge } from "@/lib/settings/profile-attrs";
import { getEquipment } from "@/lib/equipment";
import { isTrainingRestricted } from "@/lib/age-gate";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { requireSession, getAccessibleProfiles } from "@/lib/auth";
import { requireScope } from "@/lib/scope";
import { writeSubjectName } from "@/lib/own-profile";
import {
  getActivitySuggestions,
  getRecentExerciseHistory,
  getLatestBodyMetric,
  getImportReviewCount,
  getRecentActivityEquipmentIds,
  getMostRecentActivityEditData,
  getActivityEditData,
  getWorkoutPresence,
  profileHasIntakeItems,
  getNavRelevance,
} from "@/lib/queries";
import { getTimelineDates } from "@/lib/timeline";
import { getFormDeloadContext } from "@/lib/routines";
import { getFormRecoveringContext } from "@/lib/injuries";
import { buildActivePlateauHints } from "@/lib/rule-findings";
import { today } from "@/lib/db";

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
  const session = await requireSession();
  const { login, profile } = session;
  const profiles = await getAccessibleProfiles();
  // The cross-profile scope (issue #1096): the persisted view-set (∩ accessible),
  // resolved once at the shell so the profile menu's view toggles and the
  // persistent view strip both read the SAME validated viewIds. Its disambiguated
  // `profiles` (#534) name the in-view chips.
  const scope = await requireScope();
  const inViewProfiles = scope.viewIds
    .map((id) => scope.profiles.find((p) => p.id === id))
    .filter((p): p is (typeof scope.profiles)[number] => p != null);
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
  const restricted = isTrainingRestricted(profile.id);
  const suggestions = getActivitySuggestions(profile.id);
  const timelineDates = getTimelineDates(profile.id, {
    restricted,
  });
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
  // mobile quick action (issue #337); null hides both. A restricted profile has
  // no training surface, so it gets none.
  const lastActivity = restricted
    ? null
    : getMostRecentActivityEditData(profile.id);
  // The strength editor's two deload/plateau inputs (#923), skipped for a restricted
  // profile (no training surface). `deloadContext` shaves the next-set suggestion on a
  // routine deload week; `plateauHints` renders the calm inline plateau hint. Both read
  // the SAME gathers the Training-watch / session-card surfaces use, so nothing drifts.
  const now = today(profile.id);
  const deloadContext = restricted
    ? { isDeloadWeek: false, routineKeys: [] }
    : getFormDeloadContext(profile.id, now);
  // The recovering-injury context the form tempers by (#1144): the coarse regions
  // returning from a RECOVERING injury (#838), read from the SAME temperedRegions gather
  // the Analyze/detail panel uses so the live logger and its deep-link target agree on
  // the injury axis (#221/#1115). Skipped (empty) for a restricted profile.
  const recoveringContext = restricted
    ? { temperedRegions: [] }
    : getFormRecoveringContext(profile.id);
  const plateauHints = restricted
    ? []
    : buildActivePlateauHints(profile.id, now);
  // Derived workout presence (#921) for the app-wide minimized dock: on a fresh load
  // (or another device) the dock hydrates from this gather + the persisted #451 draft
  // instead of client memory. Acting-profile-scoped; skipped for a restricted profile
  // (no live workout mode). `liveStartEpochMs` places the elapsed clock off the real
  // session start.
  const presence = restricted ? undefined : getWorkoutPresence(profile.id);
  const liveEditData =
    presence?.state === "active" && presence.activityId != null
      ? getActivityEditData(profile.id, presence.activityId)
      : null;
  const liveStartEpochMs =
    presence?.state === "active"
      ? Date.now() - presence.sinceMin * 60_000
      : null;
  const version = getAppVersion();
  // Gates any admin-only nav entries in both surfaces.
  const isAdmin = login.role === "admin";
  // The Household overview is cross-profile; show it only when the caller can
  // reach 2+ profiles (issue #31) — an admin sees every profile, a caregiver
  // member sees their granted set, and a single-profile login never sees it.
  const multiProfile = profiles.length > 1;
  // Hides the Nutrition nav entry for an infant profile (< 1 y) — the adult
  // food-group serving catalog is meaningless there (issue #591). Cosmetic; the
  // /nutrition page independently gates on the same predicate. Eligible on
  // unknown age (hide only on a positive infant match).
  const foodLoggingRelevant = isFoodLoggingRelevant(getUserAge(profile.id));
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
  const onboarding = getOnboardingState(profile.id);
  const showOnboardingReturn =
    onboarding?.status === "in_progress" &&
    onboarding.basicsComplete &&
    !onboarding.layoutReviewed;
  return (
    <TimezoneProvider tz={timezone}>
      <WeekStartProvider weekStart={weekStart}>
        <FormatPrefsProvider prefs={formatPrefs}>
          <ConfirmProvider>
            <OfflineQueueProvider activeProfileId={profile.id}>
              <ProfileSwitchWatcher activeProfileId={profile.id} />
              <ActivityEditorProvider
                units={units}
                suggestions={suggestions}
                history={exerciseHistory}
                equipment={equipment}
                recentActivityEquipment={recentActivityEquipment}
                bodyweightKg={bodyweightKg}
                lastActivity={lastActivity}
                restricted={restricted}
                deloadContext={deloadContext}
                recoveringContext={recoveringContext}
                plateauHints={plateauHints}
                presence={presence}
                liveEditData={liveEditData}
                liveStartEpochMs={liveStartEpochMs}
                subjectName={actingSubjectName}
              >
                <div className="flex min-h-screen">
                  <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-black/10 bg-white/70 p-4 backdrop-blur-xl md:flex print:hidden dark:border-white/5 dark:bg-ink-950/70">
                    <SidebarContent
                      activityDates={timelineDates}
                      version={version}
                      active={session.profile}
                      username={login.username}
                      profiles={profiles}
                      viewIds={scope.viewIds}
                      restricted={restricted}
                      isAdmin={isAdmin}
                      multiProfile={multiProfile}
                      foodLoggingRelevant={foodLoggingRelevant}
                      hasIntakeItems={hasIntakeItems}
                      relevance={relevance}
                      reviewCount={reviewCount}
                      readOnly={readOnly}
                    />
                  </aside>
                  {/* clip (not hidden) so it doesn't force overflow-y to auto, which
            turns <main> into a scroll container and breaks position:sticky inside it.
            min-w-0 lets this flex item shrink below its content's intrinsic width —
            without it, wide tables/rows blow the whole page out horizontally. */}
                  <main className="min-w-0 flex-1 overflow-x-clip">
                    <MobileNav
                      activityDates={timelineDates}
                      version={version}
                      active={session.profile}
                      username={login.username}
                      profiles={profiles}
                      viewIds={scope.viewIds}
                      restricted={restricted}
                      isAdmin={isAdmin}
                      multiProfile={multiProfile}
                      foodLoggingRelevant={foodLoggingRelevant}
                      hasIntakeItems={hasIntakeItems}
                      relevance={relevance}
                      reviewCount={reviewCount}
                      readOnly={readOnly}
                    />
                    {/* max(padding, safe-area inset) keeps content clear of the
              notch in landscape and the home indicator at the bottom now
              that the viewport paints edge-to-edge (viewportFit cover). */}
                    <div
                      data-testid="app-content-container"
                      className="mx-auto pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] 3xl:max-w-[110rem]"
                    >
                      <OnboardingReturnBanner show={showOnboardingReturn} />
                      <ProfileViewStrip
                        profiles={inViewProfiles}
                        actingProfileId={scope.actingProfileId}
                      />
                      {children}
                    </div>
                  </main>
                </div>
                <CommandPalette
                  profileName={session.profile.name}
                  weightUnit={units.weightUnit}
                />
                <ExtractionToaster profileId={profile.id} />
                <ImportJobsToaster profileId={profile.id} />
                <VersionWatcher current={version.sha} />
              </ActivityEditorProvider>
            </OfflineQueueProvider>
          </ConfirmProvider>
        </FormatPrefsProvider>
      </WeekStartProvider>
    </TimezoneProvider>
  );
}
