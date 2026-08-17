import Link from "next/link";
import { ActivityTypeIcon } from "@/components/ui";
import {
  recentSessionPartText,
  type RecentSessionsView,
} from "@/lib/training-recent-sessions";

// WHAT YOU DID — the sessions half of Training → Overview's "This week" card
// (#2566). Presentation only: every value is computed by the Training Log's own
// card derivation and folded by `recentSessionsView`, so this renders the Log's
// numbers rather than a second opinion of them.
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
          className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
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
                type={row.type}
                title={row.title}
                sportNames={row.sportNames}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-slate-800 group-hover:text-brand-600 dark:text-slate-100 dark:group-hover:text-brand-400">
                    {row.title}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {row.dayLabel}
                  </span>
                </span>
                {row.meta.length > 0 && (
                  <span
                    data-testid="recent-session-meta"
                    className="mt-0.5 block text-xs tabular-nums text-slate-600 dark:text-slate-300"
                  >
                    {row.meta.join(" · ")}
                  </span>
                )}
              </span>
            </Link>

            {row.parts.length > 0 && (
              <ul className="mt-1 ml-9 space-y-0.5">
                {row.parts.map((part, i) => (
                  <li
                    key={i}
                    data-testid="recent-session-part"
                    className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm"
                  >
                    <span className="text-slate-700 dark:text-slate-200">
                      {part.name}
                    </span>
                    {/* A single-effort cardio row can carry no detail at all
                        (the header already states its distance/duration) — an
                        empty span would leave a stray gap. */}
                    {recentSessionPartText(part) && (
                      <span className="tabular-nums text-slate-500 dark:text-slate-400">
                        {recentSessionPartText(part)}
                      </span>
                    )}
                  </li>
                ))}
                {row.moreParts > 0 && (
                  <li
                    data-testid="recent-session-more-parts"
                    className="text-xs text-slate-500 dark:text-slate-400"
                  >
                    +{row.moreParts} more
                  </li>
                )}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
