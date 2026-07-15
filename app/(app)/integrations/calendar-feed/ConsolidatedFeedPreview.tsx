import { IconBell, IconMapPin, IconUsersGroup } from "@tabler/icons-react";
import type { ConsolidatedDateGroup } from "@/lib/calendar-ics";

// Presentational preview of the CONSOLIDATED "family" feed: every accessible
// profile's upcoming appointments, grouped by date and labeled with the profile
// name. A faithful mirror of what leaves the app — rows come from the SAME pure
// selection + mapping the family feed route uses (see the page), so a profile set to
// minimal shows only "Medical appointment" here too. Read-only; no client interactivity.
const MAX_GROUPS = 12;

export default function ConsolidatedFeedPreview({
  groups,
  totalRows,
}: {
  groups: ConsolidatedDateGroup[];
  totalRows: number;
}) {
  const visible = groups.slice(0, MAX_GROUPS);
  const shownRows = visible.reduce((n, g) => n + g.rows.length, 0);
  const overflow = totalRows - shownRows;

  return (
    <div className="card space-y-4" data-testid="family-feed-preview">
      <div className="flex items-start gap-2">
        <IconUsersGroup
          className="mt-0.5 h-5 w-5 shrink-0 text-slate-500 dark:text-slate-400"
          aria-hidden
        />
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Combined upcoming appointments
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Every appointment across the profiles you can access, grouped by
            day. Each is labeled with the profile it belongs to — this is
            exactly what the family feed serves.
          </p>
        </div>
      </div>

      {shownRows === 0 ? (
        <p className="rounded-lg border border-dashed border-black/10 px-4 py-6 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
          No upcoming appointments across your profiles — add one under
          Appointments and it&apos;ll appear here.
        </p>
      ) : (
        <div className="space-y-4">
          {visible.map((g) => (
            <div key={g.dateKey}>
              <h3 className="mb-1.5 section-label">{g.dateLabel}</h3>
              <ul className="divide-y divide-black/5 dark:divide-white/5">
                {g.rows.map((r) => (
                  <li
                    key={r.uid}
                    className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <span
                      className="badge shrink-0 bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
                      data-testid="family-feed-profile-label"
                    >
                      {r.profileName}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span
                          className={`text-sm font-medium ${
                            r.cancelled
                              ? "text-slate-500 line-through dark:text-slate-400"
                              : "text-slate-800 dark:text-slate-100"
                          }`}
                        >
                          {r.summary}
                        </span>
                        {r.cancelled && (
                          <span className="badge bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                            Cancelled
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                        <span>{r.timeLabel ? r.timeLabel : "All day"}</span>
                        {r.location && (
                          <span className="inline-flex items-center gap-0.5">
                            <IconMapPin className="h-3 w-3" aria-hidden />
                            {r.location}
                          </span>
                        )}
                        {r.hasReminders && (
                          <span
                            className="inline-flex items-center gap-0.5"
                            title="This event carries a 1-day and 1-hour reminder"
                          >
                            <IconBell className="h-3 w-3" aria-hidden />
                            1-day + 1-hour reminders
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {overflow > 0 && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          + {overflow} more {overflow === 1 ? "appointment" : "appointments"} in
          the feed
        </p>
      )}
    </div>
  );
}
