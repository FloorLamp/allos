import Link from "next/link";
import { ActivityTypeIcon } from "@/components/ui";
import { formatRelativeDate } from "@/lib/format-date";
import type { Activity } from "@/lib/types";
import WidgetHeader from "./WidgetHeader";

// Recent-activity list (extracted from page.tsx, behavior-preserving).
export default function RecentActivityWidget({
  recent,
  today,
}: {
  recent: Activity[];
  today: string;
}) {
  return (
    <div className="card">
      <WidgetHeader
        title="Recent activity"
        href="/training?tab=log"
        linkLabel="Log"
      />
      {recent.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          Nothing logged yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {recent.map((a) => (
            <li key={a.id}>
              <Link
                href={`/training?tab=log#activity-${a.id}`}
                className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2 transition hover:bg-slate-50 dark:hover:bg-ink-900"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ActivityTypeIcon type={a.type} title={a.title} />
                  <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                    {a.title}
                  </span>
                </div>
                <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                  {formatRelativeDate(a.date, today)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
