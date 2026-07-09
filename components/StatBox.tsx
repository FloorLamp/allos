import type { ReactNode } from "react";
import { goalBarClass } from "@/lib/goals";

// A labelled stat box used in the Cardio/Sport/Exercise detail panels: an
// uppercase label over a bold value, with optional sub-text, link, label badge,
// and a goal-style progress bar.
export function StatBox({
  label,
  value,
  sub,
  subClass,
  href,
  badge,
  progress,
  className,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  subClass?: string;
  // When set, the value links to it (e.g. the journal entry of the last session).
  href?: string;
  // Optional chip shown next to the label (e.g. a "PR" marker).
  badge?: ReactNode;
  // When set (0–100), renders a goal-style progress bar under the value.
  progress?: number;
  // Extra classes on the box (e.g. "col-span-2" for a full-width goal).
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg bg-slate-50 px-3 py-2 dark:bg-ink-900 ${className ?? ""}`}
    >
      <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
        {label}
        {badge}
      </dt>
      <dd className="mt-0.5 font-semibold text-slate-800 dark:text-slate-100">
        {href ? (
          <a
            href={href}
            className="hover:text-brand-600 hover:underline dark:hover:text-brand-400"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
      {sub && (
        <dd
          className={`text-xs ${subClass ?? "text-slate-400 dark:text-slate-500"}`}
        >
          {sub}
        </dd>
      )}
      {typeof progress === "number" && (
        <div className="mt-1.5 h-1.5 w-full rounded-full bg-slate-200 dark:bg-ink-800">
          <div
            className={`h-1.5 rounded-full transition-colors ${goalBarClass(progress)}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
