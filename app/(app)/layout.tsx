import MobileNav from "@/components/MobileNav";
import SidebarContent from "@/components/SidebarContent";
import CommandPalette from "@/components/CommandPalette";
import ActivityEditorProvider from "@/components/ActivityEditorProvider";
import ExtractionToaster from "@/components/ExtractionToaster";
import ImportJobsToaster from "@/components/ImportJobsToaster";
import VersionWatcher from "@/components/VersionWatcher";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { getAppVersion } from "@/lib/version";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { WeekStartProvider } from "@/components/WeekStartProvider";
import { getUnitPrefs, getTimezone, getWeekStart } from "@/lib/settings";
import { getEquipment } from "@/lib/equipment";
import { isTrainingRestricted } from "@/lib/age-gate";
import { requireSession, getAccessibleProfiles } from "@/lib/auth";
import {
  getActivitySuggestions,
  getRecentExerciseHistory,
  getLatestBodyMetric,
  getImportReviewCount,
} from "@/lib/queries";
import { getTimelineDates } from "@/lib/timeline";

// Authenticated app shell. requireSession() is the authoritative gate for the
// entire (app) route group — it redirects to /login when there's no live
// session. Every page under here is dynamic (it reads cookies() transitively),
// which is intended: it prevents the full-route cache from leaking one session's
// rendered data to another.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const session = requireSession();
  const { login, profile } = session;
  const profiles = getAccessibleProfiles();

  const units = getUnitPrefs(login.id);
  const timezone = getTimezone(profile.id);
  const weekStart = getWeekStart(profile.id);
  const restricted = isTrainingRestricted(profile.id);
  const suggestions = getActivitySuggestions(profile.id);
  const timelineDates = getTimelineDates(profile.id, {
    includeTrainingEvents: !restricted,
  });
  // One extra session per exercise: the editor filters out the activity being
  // logged (which auto-save inserts into its own history) and still shows 3.
  const exerciseHistory = getRecentExerciseHistory(profile.id, 4);
  const equipment = getEquipment(profile.id);
  const bodyweightKg = getLatestBodyMetric(profile.id, "weight");
  const version = getAppVersion();
  // Gates any admin-only nav entries in both surfaces.
  const isAdmin = login.role === "admin";
  // The Household overview is cross-profile; show it only when the caller can
  // reach 2+ profiles (issue #31) — an admin sees every profile, a caregiver
  // member sees their granted set, and a single-profile login never sees it.
  const multiProfile = profiles.length > 1;
  // Count of integrations currently in a failed state — drives the header
  // "import review" badge (Data → Review). Self-clearing on the next good sync.
  const reviewCount = getImportReviewCount(profile.id);
  // The caller holds only READ access on the active profile (issue #33) — a
  // member with a read-only grant. Drives the "read-only" hint in the profile
  // menu; every mutating action is independently gated server-side.
  const readOnly = session.access === "read";
  return (
    <TimezoneProvider tz={timezone}>
      <WeekStartProvider weekStart={weekStart}>
        <ConfirmProvider>
          <ActivityEditorProvider
            units={units}
            suggestions={suggestions}
            history={exerciseHistory}
            equipment={equipment}
            bodyweightKg={bodyweightKg}
          >
            <div className="flex min-h-screen">
              <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-black/10 bg-white/70 p-4 backdrop-blur-xl md:flex print:hidden dark:border-white/5 dark:bg-ink-950/70">
                <SidebarContent
                  activityDates={timelineDates}
                  version={version}
                  active={session.profile}
                  profiles={profiles}
                  restricted={restricted}
                  isAdmin={isAdmin}
                  multiProfile={multiProfile}
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
                  profiles={profiles}
                  restricted={restricted}
                  isAdmin={isAdmin}
                  multiProfile={multiProfile}
                  reviewCount={reviewCount}
                  readOnly={readOnly}
                />
                {/* max(padding, safe-area inset) keeps content clear of the
              notch in landscape and the home indicator at the bottom now
              that the viewport paints edge-to-edge (viewportFit cover). */}
                <div className="mx-auto max-w-6xl pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] 2xl:max-w-7xl 3xl:max-w-[110rem]">
                  {children}
                </div>
              </main>
            </div>
            <CommandPalette profileName={session.profile.name} />
            <ExtractionToaster />
            <ImportJobsToaster />
            <VersionWatcher current={version.sha} />
          </ActivityEditorProvider>
        </ConfirmProvider>
      </WeekStartProvider>
    </TimezoneProvider>
  );
}
