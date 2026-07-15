import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { IconCalendarEvent } from "@tabler/icons-react";

// The soonest scheduled visit, flattened by the page.
export interface NextAppointment {
  title: string;
  whenLabel: string;
  dueText: string;
  detail: string | null;
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
      <WidgetHeader
        title="Next appointment"
        href="/encounters"
        linkLabel="All"
      />
      {!appointment ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No upcoming appointments.
        </p>
      ) : (
        <div className="flex items-start gap-3">
          <IconCalendarEvent
            className="mt-0.5 h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400"
            stroke={1.75}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="truncate font-medium text-slate-800 dark:text-slate-100">
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
        </div>
      )}
    </div>
  );
}
