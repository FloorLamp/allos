import { IconBell, IconMapPin, IconCalendarEvent } from "@tabler/icons-react";
import type { CalendarFeedPreviewRow } from "@/lib/calendar-ics";
import type { CalendarFeedDetail } from "@/lib/settings";

// Presentational preview of what a subscribed calendar client would show for this
// profile, rendered at the saved detail level. It's a faithful mirror: the rows
// come from the SAME selection + mapping the live feed route uses (see the page),
// so what's shown here is exactly what leaves the app — including, at "full", the
// provider/reason PHI. Read-only; no writes, no client interactivity.
const MAX_VISIBLE = 10;

export default function CalendarFeedPreview({
  rows,
  detail,
}: {
  rows: CalendarFeedPreviewRow[];
  detail: CalendarFeedDetail;
}) {
  const visible = rows.slice(0, MAX_VISIBLE);
  const overflow = rows.length - visible.length;

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Preview — what your calendar will show
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {detail === "full" ? (
            <>
              At <strong>full</strong> detail each event shows the provider and
              reason of the visit — this is the PHI that leaves the app.
            </>
          ) : (
            <>
              At <strong>minimal</strong> detail each event shows only
              &ldquo;Medical appointment&rdquo; (plus location) — no provider or
              reason leaves the app.
            </>
          )}
        </p>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-black/10 px-4 py-6 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
          No upcoming appointments — add one under Appointments and it&apos;ll
          appear here.
        </p>
      ) : (
        <ul className="divide-y divide-black/5 dark:divide-white/5">
          {visible.map((r) => (
            <li
              key={r.uid}
              className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0"
            >
              <IconCalendarEvent
                className="mt-0.5 h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={`text-sm font-medium ${
                      r.cancelled
                        ? "text-slate-400 line-through dark:text-slate-500"
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
                  <span>
                    {r.dateLabel}
                    {r.timeLabel ? ` · ${r.timeLabel}` : " · All day"}
                  </span>
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
      )}

      {overflow > 0 && (
        <p className="text-xs text-slate-400 dark:text-slate-500">
          + {overflow} more {overflow === 1 ? "appointment" : "appointments"} in
          the feed
        </p>
      )}
    </div>
  );
}
