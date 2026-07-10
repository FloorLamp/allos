import Link from "next/link";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { IconClipboardList } from "@tabler/icons-react";

// One open, dated care-plan item, flattened by the page.
export interface CarePlanDueRow {
  key: string;
  title: string;
  detail: string | null;
  dueText: string;
  overdue: boolean;
}

// Care plan widget (issue #171 — medical presence). Provider-ordered care items
// coming due, soonest first, overdue ones flagged — a differentiator the old fitness
// dashboard never surfaced. The full list (with mark-done) lives on /care-plan and
// /upcoming; this is the at-a-glance headline.
export default function CarePlanDueWidget({
  items,
}: {
  items: CarePlanDueRow[];
}) {
  return (
    <div className="card">
      <WidgetHeader title="Care plan" href="/care-plan" linkLabel="Care plan" />
      {items.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          No care-plan items due.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-3">
              <IconClipboardList
                className="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500"
                stroke={1.75}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <Link
                  href="/care-plan"
                  className="truncate font-medium text-slate-700 hover:text-brand-700 hover:underline dark:text-slate-200 dark:hover:text-brand-400"
                >
                  {item.title}
                </Link>
                {item.detail && (
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {item.detail}
                  </div>
                )}
              </div>
              <span
                className={`shrink-0 whitespace-nowrap text-xs font-medium ${
                  item.overdue
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-slate-500 dark:text-slate-400"
                }`}
              >
                {item.dueText}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
