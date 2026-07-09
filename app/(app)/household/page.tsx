import { requireAdmin, getAccessibleProfiles } from "@/lib/auth";
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
  getWeights,
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

export default function HouseholdPage() {
  // Cross-profile aggregation is admin-only — requireAdmin() bounces members, who
  // must not see other profiles' data through this page.
  const { login } = requireAdmin();
  const weightUnit = getUnitPrefs(login.id).weightUnit;

  // Reuse the existing per-profile query functions in a loop; no new cross-profile
  // SQL, so the profile-scoping test and the profileId-first convention hold.
  const cards: HouseholdCardData[] = getAccessibleProfiles().map((profile) => {
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

    // Two newest weigh-ins → latest value + trend arrow.
    const weights = getWeights(pid, 2);
    const latest = weights[0];
    const trend = weightTrend(latest?.weight_kg, weights[1]?.weight_kg);

    // Biomarkers whose current (latest) reading is out of the lab reference range.
    const oorBiomarkers = getMedicalRecords(pid, {
      current: true,
      range: "oor",
    }).length;

    const goals = getGoals(pid);
    const goalProgress = getGoalProgressMap(pid, goals);

    return {
      profile,
      adherence,
      lastActivity: recent
        ? { title: recent.title, when: formatRelativeDate(recent.date, day) }
        : null,
      activities7d: stats.last7,
      weightLabel: latest ? fmtWeight(latest.weight_kg, weightUnit) : null,
      weightWhen: latest ? formatRelativeDate(latest.date, day) : null,
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
        subtitle="Everyone at a glance — tap a card to open that profile."
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
