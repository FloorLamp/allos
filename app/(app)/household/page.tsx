import { redirect } from "next/navigation";
import {
  requireSession,
  getAccessibleProfiles,
  accessForProfile,
} from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getActivities,
  getActivitiesByDate,
  getDashboardStats,
  getGoals,
  getGoalProgressMap,
  getMedicalRecords,
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getBodyMetricDailySeries,
  collectHouseholdRollup,
} from "@/lib/queries";
import { getActiveSituations, getUnitPrefs } from "@/lib/settings";
import {
  goalHighlights,
  supplementAdherenceToday,
  weightTrend,
} from "@/lib/household";
import { fmtWeight } from "@/lib/units";
import { formatRelativeDate } from "@/lib/format-date";
import { PageHeader, EmptyState } from "@/components/ui";
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
  const weightUnit = getUnitPrefs(login.id).weightUnit;

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

    const goals = getGoals(pid);
    const goalProgress = getGoalProgressMap(pid, goals);

    // The actionable rollup — today's attention items (due doses, low refills,
    // next visit) reusing the Upcoming aggregation's per-domain builders.
    const rollup = collectHouseholdRollup(pid, day);

    // Whether THIS login may WRITE this profile: admins always can, a member per
    // its grant level. Read-only cards show the attention items but no quick-action
    // buttons; the server action (confirmDoseAction) re-checks this per profile.
    const canWrite = accessForProfile(login.id, login.role, pid) === "write";

    return {
      profile,
      canWrite,
      rollup,
      today: day,
      adherence,
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
      goals: goalHighlights(goals, goalProgress, 2),
    };
  });

  return (
    <div>
      <PageHeader
        title="Household"
        subtitle="Everyone at a glance — confirm what's due, or tap a card to open that profile."
      />
      {cards.length === 0 ? (
        <EmptyState message="No profiles to show." />
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
