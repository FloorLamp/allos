import { redirect } from "next/navigation";
import Link from "next/link";
import {
  requireSession,
  getAccessibleProfiles,
  accessForProfile,
  ownProfileForLogin,
} from "@/lib/auth";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import { writeSubjectName } from "@/lib/own-profile";
import { EPISODES_HREF } from "@/lib/hrefs";
import { today } from "@/lib/db";
import {
  getActivities,
  getActivitiesByDate,
  getDashboardStats,
  getOutcomeGoals,
  getOutcomeGoalProgressMap,
  getMedicalRecords,
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getBodyMetricDailySeries,
  getWorkoutPresence,
  collectHouseholdRollup,
  getFindingSuppressions,
  countVisiblePools,
} from "@/lib/queries";
import { householdSetupForProfile } from "@/lib/queries/household-setup";
import { collectDataQualityGaps } from "@/lib/rule-findings";
import {
  householdDataQualityLine,
  dataQualityDedupeKey,
} from "@/lib/data-quality";
import { activeByKey } from "@/lib/findings";
import {
  getActiveSituations,
  getDisplayFormatPrefs,
  getUnitPrefs,
} from "@/lib/settings";
import { currentEpisodeForProfile } from "@/lib/illness-episode";
import { householdSickLine } from "@/lib/illness-episode-format";
import { schoolReturnStatusFor } from "@/lib/school-return-data";
import { schoolReturnCompactClause } from "@/lib/school-return";
import {
  goalHighlights,
  supplementAdherenceToday,
  weightTrend,
} from "@/lib/household";
import { fmtWeight } from "@/lib/units";
import { householdPresenceChip } from "@/lib/workout-presence";
import { formatRelativeDate } from "@/lib/format-date";
import { PageHeader, EmptyState } from "@/components/ui";
import SharedSuppliesLink from "@/components/intake/SharedSuppliesLink";
import { getIntakeDeltaLine } from "@/lib/intake-history";
import HouseholdCard, {
  type HouseholdCardData,
} from "@/components/HouseholdCard";

export const dynamic = "force-dynamic";

export default async function HouseholdPage() {
  // Household is a cross-profile overview. It's open to ANY login that can reach
  // 2+ profiles (issue #31) — an admin (sees every profile) or a caregiver member
  // (sees their granted set). A single-profile login has nothing to compare, so
  // it's bounced to the dashboard; this server gate is authoritative (the nav
  // link is hidden for the same case, but that's only cosmetic).
  const { login } = await requireSession();
  const profiles = await getAccessibleProfiles();
  if (profiles.length < 2) redirect("/");
  // Own-profile link (#1013): the login's self, so each card's dose-confirm names
  // the CARD's person unless it's the login's own card (or no own-profile is set).
  // Names are disambiguated (#534) so two same-named profiles stay distinguishable.
  const ownProfileId = ownProfileForLogin(login.id);
  // The already-authorized accessible ids — the only legitimate input to a
  // cross-profile reader (here, the medicine-cabinet door's count).
  const profileIds = profiles.map((p) => p.id);
  const cardNames = disambiguateProfileNames(profiles);
  const weightUnit = getUnitPrefs(login.id).weightUnit;
  const temperatureUnit = getUnitPrefs(login.id).temperatureUnit;
  const formatPrefs = getDisplayFormatPrefs(login.id);

  // One loop over the accessible profiles, each built from the EXISTING per-profile
  // query functions — no new cross-profile SQL, so the profile-scoping test and the
  // profileId-first convention hold. Bounded work: a household is a handful of
  // profiles, and each card is a small set of cheap, profile-scoped reads (the
  // glance stats below + collectHouseholdRollup's few reads — see its COST note).
  const cards: HouseholdCardData[] = profiles.map((profile) => {
    const pid = profile.id;
    const day = today(pid);

    // Today's supplement adherence (x/y): due doses honored via isDueOn.
    const activeSuppById = new Map(
      getSupplements(pid)
        .filter((s) => s.active)
        .map((s) => [s.id, s])
    );
    const adherence = supplementAdherenceToday(
      getSupplementDoses(pid),
      activeSuppById,
      {
        date: day,
        isWorkoutDay: getActivitiesByDate(pid, day).length > 0,
        activeSituations: new Set(getActiveSituations(pid)),
      },
      getTakenDoseIds(pid, day)
    );

    const recent = getActivities(pid, 1)[0];
    const stats = getDashboardStats(pid);

    // Current weight = the primary-source-aware value the dashboard QuickStats
    // shows (getLatestBodyMetricDated, #302/#396) — never a raw newest row, which
    // can disagree with every other "current weight" surface. The trend arrow
    // compares the two newest DAYS of the deduped one-source-per-day series
    // (getBodyMetricDailySeries, #14) so it measures change over time, not two
    // devices reporting the same day.
    const latestWeight = stats.latestWeight;
    const dailyWeights = getBodyMetricDailySeries(pid, "weight");
    const dwLen = dailyWeights.length;
    const trend = weightTrend(
      dailyWeights[dwLen - 1]?.value,
      dailyWeights[dwLen - 2]?.value
    );

    // Biomarkers whose current (latest) reading is out of the lab reference range.
    const oorBiomarkers = getMedicalRecords(pid, {
      current: true,
      range: "oor",
    }).length;

    const goals = getOutcomeGoals(pid);
    const goalProgress = getOutcomeGoalProgressMap(pid, goals);

    // The actionable rollup — today's attention items (due doses, low refills,
    // next visit) reusing the Upcoming aggregation's per-domain builders.
    const rollup = collectHouseholdRollup(pid, day);

    // Structural data-quality gaps (issue #1045), bus-filtered so a member's own
    // dismissal silences the line here too (dismiss once, silence everywhere). Kids'
    // profiles are where birthdate/sex gaps cluster and the caregiver is who can fix
    // them — the same ranked gap model the dashboard widget formats, condensed.
    const dataQuality = householdDataQualityLine(
      activeByKey(
        collectDataQualityGaps(pid),
        (g) => dataQualityDedupeKey(g.key),
        getFindingSuppressions(pid),
        day
      )
    );

    // Whether THIS login may WRITE this profile: admins always can, a member per
    // its grant level. Read-only cards show the attention items but no quick-action
    // buttons; the server action (confirmDoseAction) re-checks this per profile.
    const canWrite = accessForProfile(login.id, login.role, pid) === "write";

    return {
      profile,
      canWrite,
      subjectName: writeSubjectName(
        ownProfileId,
        pid,
        cardNames.get(pid) ?? profile.name
      ),
      rollup,
      today: day,
      adherence,
      // The pushed tier's state changes (#1505 part 3) — the SAME shared line the
      // morning digest and the weekly recap render, so a caregiver reading the
      // household card and the Telegram digest sees one story. Null on a quiet
      // window: the card then shows the x/y fraction alone, as before.
      intakeDeltaLine: getIntakeDeltaLine(pid, day),
      lastActivity: recent
        ? { title: recent.title, when: formatRelativeDate(recent.date, day) }
        : null,
      activities7d: stats.last7,
      weightLabel: latestWeight
        ? fmtWeight(latestWeight.value, weightUnit)
        : null,
      weightWhen: latestWeight
        ? formatRelativeDate(latestWeight.date, day)
        : null,
      trend,
      weightUnit,
      oorBiomarkers,
      goals: goalHighlights(goals, goalProgress, day, 2),
      // An open illness episode surfaces as a "sick day N" chip (issue #801) — the
      // same assembly the dashboard illness hero (#858) formats over.
      sick: (() => {
        const ep = currentEpisodeForProfile(pid);
        if (!ep) return null;
        const sr = schoolReturnStatusFor(pid, ep);
        return householdSickLine(
          profile.name,
          ep,
          temperatureUnit,
          sr ? schoolReturnCompactClause(sr) : null,
          formatPrefs.timeFormat
        );
      })(),
      // Derived workout presence (#921), grants-scoped like the sick chip: a compact
      // live-only "mid-workout · N min" glance. Unlinked (journalActivityHref anchors
      // the viewer's OWN log, so a cross-profile link would land on a dead anchor,
      // #879) — a plain chip, not a button.
      presence: householdPresenceChip(getWorkoutPresence(pid)),
      dataQuality,
      // Per-member SETUP HEALTH (#2173). Five checks derived at read time from facts
      // that already exist — the send-source scan × the notification edge set × per-login
      // channel presence, onboarding state, the dose roster, and the preventive planner's
      // own outstanding set. Composed HERE, inside the loop over the profiles the auth
      // boundary already resolved, so nothing evaluates a member this login cannot reach.
      // Bounded like the rest of the card: a handful of cheap, profile-scoped reads, all
      // of them ones some other surface already performs.
      setup: householdSetupForProfile(pid, day),
    };
  });

  return (
    <div>
      <PageHeader
        title="Household"
        subtitle="Everyone at a glance — confirm what's due, or tap a card to open that profile."
        action={
          // Cross-profile surfaces live here, and the medicine cabinet is one of them
          // (#1522) — a household-scoped registry that lost its nav row and is now
          // reached from the stable parents that consume it.
          // Wraps on a phone for the same reason the Medications header does: two
          // affordances plus the title do not fit 360px, and the shell clips rather
          // than scrolls, so an un-wrapping row would hide one of them outright.
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <SharedSuppliesLink count={countVisiblePools(profileIds)} />
            <Link
              href={EPISODES_HREF}
              className="text-sm font-medium text-sky-700 hover:underline dark:text-sky-300"
              data-testid="household-history-link"
            >
              History →
            </Link>
          </div>
        }
      />
      {cards.length === 0 ? (
        <EmptyState
          message={
            login.role === "admin"
              ? "No profiles to show. Create profiles in Family settings."
              : "No profiles to show. Ask an admin for access to the relevant profiles."
          }
          action={
            login.role === "admin"
              ? { href: "/settings/family", label: "Go to Family settings" }
              : undefined
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((data) => (
            <HouseholdCard key={data.profile.id} data={data} />
          ))}
        </div>
      )}
    </div>
  );
}
