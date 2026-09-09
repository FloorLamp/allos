import type { ReactNode } from "react";
import { goalBarClass } from "@/lib/outcome-goals";
import { PendingTextLink } from "@/components/PendingLink";
import type { AppRoute } from "@/lib/hrefs";

// A labelled reading with optional detail, link, badge, and progress.
// Cards use stat-tile's themed fill and surface radius. Both card and plain
// groups give values tabular figures so changing digits keep their width.
export function StatBox({
  label,
  value,
  sub,
  href,
  badge,
  progress,
  className,
  variant = "card",
  "data-testid": testId,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  // Optional app destination for the value.
  href?: AppRoute;
  // Optional chip shown next to the label (e.g. a "PR" marker).
  badge?: ReactNode;
  // When set (0–100), renders a goal-style progress bar under the value.
  progress?: number;
  // Extra classes on the box (e.g. "col-span-2" for a full-width goal).
  className?: string;
  // Dense detail groups already provide their own enclosing surface and rules.
  variant?: "card" | "plain";
  "data-testid"?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`${
        variant === "plain" ? "min-w-0" : "stat-tile"
      } ${className ?? ""}`}
    >
      <dt className="flex items-center gap-1.5 section-label">
        {label}
        {badge}
      </dt>
      <dd className="mt-0.5 flex items-center font-semibold tabular-nums text-slate-800 dark:text-slate-100">
        {href ? (
          // Announce the label while opening; a number alone has no context.
          <PendingTextLink
            href={href}
            label={label.toLowerCase()}
            className="hover:text-brand-600 hover:underline dark:hover:text-brand-400"
          >
            {value}
          </PendingTextLink>
        ) : (
          value
        )}
      </dd>
      {sub && (
        <dd className="text-xs text-slate-500 dark:text-slate-400">{sub}</dd>
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
