import DestinationLink from "@/components/DestinationLink";
import type { SportStat } from "@/lib/queries";
import { formatMinutes } from "@/lib/duration";
import SessionHighlights from "@/components/SessionHighlights";
import type { AppRoute } from "@/lib/hrefs";

export interface SportCadenceView {
  id: number;
  label: string;
  count: number;
  perWeek: number;
}

export default function SportDepthSuite({
  cadence,
  sports,
}: {
  cadence: SportCadenceView[];
  sports: SportStat[];
}) {
  const highlights = sports.slice(0, 3).map((sport) => ({
    key: `longest-${sport.sport}`,
    label: "Longest session",
    value: sport.sport,
    detail: formatMinutes(sport.longestDurationMin),
    tone: "neutral" as const,
    href: `/training?tab=analyze&kind=sport&item=${encodeURIComponent(sport.sport)}` as AppRoute,
  }));
  return (
    <div className="card" data-testid="sport-depth-suite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Sport
        </h3>
        <DestinationLink
          href="/training?tab=analyze&kind=sport"
          className="text-xs text-link"
        >
          Analyze
        </DestinationLink>
      </div>
      {sports.length === 0 && cadence.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          No recent sport sessions. Log a practice, match, or climb to build
          this view.
        </p>
      ) : (
        <>
          <div className="mt-4">
            <p className="section-label">Weekly cadence</p>
            {cadence.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                No sport target set.
              </p>
            ) : (
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {cadence.map((row) => (
                  <li
                    key={row.id}
                    className="flex justify-between gap-3 text-sm"
                  >
                    <span className="text-slate-600 dark:text-slate-300">
                      {row.label}
                    </span>
                    <span className="font-medium tabular-nums text-slate-800 dark:text-slate-100">
                      {row.count}/{row.perWeek}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <SessionHighlights highlights={highlights} title="Sport highlights" />
        </>
      )}
    </div>
  );
}
