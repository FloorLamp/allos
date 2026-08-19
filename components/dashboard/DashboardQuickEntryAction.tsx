"use client";

import { useQuickEntry } from "@/components/QuickEntryProvider";
import type { QuickEntryForm } from "@/lib/quick-log";

export default function DashboardQuickEntryAction({
  title,
  detail,
  form,
  actionLabel = "Log",
}: {
  title: string;
  detail?: string;
  form: QuickEntryForm;
  actionLabel?: string;
}) {
  const { open } = useQuickEntry();
  return (
    <article className="card" data-testid="dashboard-quick-entry-action">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {title}
          </h3>
          {detail && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {detail}
            </p>
          )}
        </div>
        <button type="button" className="btn-ghost" onClick={() => open(form)}>
          {actionLabel}
        </button>
      </div>
    </article>
  );
}
