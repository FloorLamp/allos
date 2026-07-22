import Link from "next/link";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { IconCalendarEvent } from "@tabler/icons-react";
import type { AppRoute } from "@/lib/hrefs";

// The soonest scheduled visit, flattened by the page.
export interface NextAppointment {
  title: string;
  // Date AND clock time, formatted through the login's display prefs (#1215) — a
  // 9am and a 4pm visit must be distinguishable, so the time is half the answer.
  whenLabel: string;
  dueText: string;
  detail: string | null;
  // Where the card content links (#1215): the resulting encounter once one exists,
  // else the visits list — matching the every-row-links convention of the sibling
  // widgets (RecentLabs). Typed AppRoute so a dead route fails the build (#285).
  href: AppRoute;
}

// Next appointment widget (issue #171 — medical presence). Surfaces the single
// soonest scheduled visit so it isn't buried in the Upcoming list. Read-only.
export default function NextAppointmentWidget({
  appointment,
}: {
  appointment: NextAppointment | null;
}) {
  return (
    <div className="card">
      <WidgetHeader title="Next appointment" href="/records/history/visits" />
      {!appointment ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No upcoming appointments.
        </p>
      ) : (
        <Link
          href={appointment.href}
          data-testid="next-appointment-link"
          className="group flex items-start gap-3 rounded-md -m-1 p-1 hover:bg-slate-50 dark:hover:bg-ink-800"
        >
          <IconCalendarEvent
            className="mt-0.5 h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400"
            stroke={1.75}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="truncate font-medium text-slate-800 group-hover:text-brand-700 dark:text-slate-100 dark:group-hover:text-brand-400">
              {appointment.title}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-300">
              {appointment.whenLabel}
              <span className="text-slate-500 dark:text-slate-400">
                {" "}
                · {appointment.dueText}
              </span>
            </div>
            {appointment.detail && (
              <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                {appointment.detail}
              </div>
            )}
          </div>
        </Link>
      )}
    </div>
  );
}
