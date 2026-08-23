import Link from "next/link";
import { ActivityTypeIcon } from "@/components/ui";
import ActivityPartRows from "@/components/activity/ActivityPartRows";
import ActivitySummaryLine from "@/components/activity/ActivitySummaryLine";
import type { RecentSessionsView } from "@/lib/training-recent-sessions";
import {
  activityComponentSportNames,
  activityComponentsHaveCompositeIconIdentity,
} from "@/lib/activity-icon";

// WHAT YOU DID — the sessions half of Training → Overview's "This week" card
// (#2566). The fold chooses which sessions and parts fit; the activity summary
// and part rows are the same components used by the Log and canonical detail
// page, so compactness cannot turn into a second presentation vocabulary.
//
// It sits INSIDE the week card, under the spine, because it is the same week: the
// band is the shape, this is the content, and the routine chips below are what is
// still wanted. Three reads that used to need three surfaces, in one card.
export default function RecentSessions({ view }: { view: RecentSessionsView }) {
  if (view.rows.length === 0) return null;

  return (
    <div
      className="mt-5 border-t border-black/10 pt-4 dark:border-white/10"
      data-testid="recent-sessions"
      data-scope={view.scope}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="section-label">
          {view.scope === "week" ? "What you did" : "Last session"}
        </h4>
        <Link
          href="/training?tab=log"
          data-testid="recent-sessions-log-link"
          className="text-xs text-link"
        >
          {view.more > 0 ? `${view.more} more in Log →` : "Open log →"}
        </Link>
      </div>

      <ul className="mt-3 space-y-4">
        {view.rows.map((row) => (
          <li key={row.id} data-testid="recent-session" data-id={row.id}>
            {/* The header is the link; the exercise lines below stay plain text
                so a long session isn't one enormous tap target. */}
            <Link
              href={row.href}
              data-testid="recent-session-link"
              className="group flex items-start gap-3"
            >
              <ActivityTypeIcon
                type={row.card.activity.type}
                title={row.card.activity.title}
                sportNames={activityComponentSportNames(
                  row.card.activity.components
                )}
                composite={activityComponentsHaveCompositeIconIdentity(
                  row.card.activity.components
                )}
              />
              <div className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold text-slate-800 group-hover:text-brand-600 dark:text-slate-100 dark:group-hover:text-brand-400">
                    {row.card.activity.title}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {row.dayLabel}
                  </span>
                </span>
                <ActivitySummaryLine
                  timeText={row.card.timeText}
                  durationText={row.card.durationText}
                  distanceText={row.card.distanceText}
                  speedText={row.card.speedText}
                  heartRateText={row.card.heartRateText}
                  calorieText={row.card.calorieText}
                  intensity={row.card.activity.intensity}
                  heartRateZone={row.card.activity.heart_rate_zone}
                  testId="recent-session-meta"
                />
              </div>
            </Link>

            <ActivityPartRows
              parts={row.parts}
              remainingParts={row.moreParts}
              density="compact"
              className="mt-1 ml-9"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
