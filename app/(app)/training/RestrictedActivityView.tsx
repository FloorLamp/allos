import { PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { getUnitPrefs } from "@/lib/settings";
import { getActivities, getJournalWeekSummary } from "@/lib/queries";
import { isDurationActivityType } from "@/lib/age-gate";
import { today } from "@/lib/db";
import ActivityLogPanel from "./ActivityLogPanel";

// The Training surface for a training-restricted (minor) profile (issue #489).
// The full adult hub — strength e1RM/standards, fitness-age percentiles, coaching,
// workout recommendation, goals — stays gated, but duration-based sport/cardio
// tracking is age-neutral, so a restricted profile gets this lightweight activity
// log instead of a redirect: a simple sessions-this-week frequency line, a
// sport/cardio log form, and their recent sessions with delete. Reads are scoped
// to the session's active profile; the shared saveActivity/deleteActivity write
// path enforces the type-aware gate.
export default async function RestrictedActivityView() {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  // Duration-based sessions only — a restricted profile shouldn't have strength
  // rows, but filter defensively so a legacy one never leaks into this view.
  const activities = getActivities(profile.id, 60).filter((a) =>
    isDurationActivityType(a.type)
  );
  const week = getJournalWeekSummary(profile.id);

  return (
    <div>
      <PageHeader
        title="Activity"
        subtitle="Log and review sport, practice, and cardio sessions."
      />
      <p
        className="mb-4 text-sm text-slate-500 dark:text-slate-400"
        data-testid="activity-frequency"
      >
        {week.sessions === 0
          ? "No sessions yet this week."
          : `${week.sessions} session${week.sessions === 1 ? "" : "s"} this week`}
        {week.streak > 0 ? ` · ${week.streak}-day streak` : ""}
      </p>
      <ActivityLogPanel
        activities={activities.slice(0, 30)}
        distanceUnit={units.distanceUnit}
        defaultDate={today(profile.id)}
      />
    </div>
  );
}
