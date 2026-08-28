import type { ReactNode } from "react";
import { goalBarClass } from "@/lib/outcome-goals";
import { PendingTextLink } from "@/components/PendingLink";
import type { AppRoute } from "@/lib/hrefs";

// A labelled stat box: an uppercase label over a bold value, with optional
// sub-text, link, label badge, and a goal-style progress bar.
//
// THE BLESSED STAT TILE (#3475). "Uppercase label over a bold value" had grown
// three treatments — this box's borderless literal tint, a page-local BORDERED
// `rounded-lg border bg-surface` tile on /medical/cycles, and the longevity
// pillar boxes. This component is the tier the others fold into, and the box it
// draws is the `stat-tile` utility in app/globals.css: tokened fill (`--ghost`,
// so dark mode comes for free instead of being maintained by hand as
// `bg-slate-50 dark:bg-ink-900`) and the SURFACE radius, because a tile holds
// content and is not a control. A new stat grid renders this rather than
// re-deciding either.
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
  // When set, the value links to it (e.g. the training log entry of the last session).
  // An INTERNAL app route, so it is `AppRoute` (issue #285): a consolidated-away
  // training log route becomes a build error here rather than a shipped dead link.
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
      <dd className="mt-0.5 flex items-center font-semibold text-slate-800 dark:text-slate-100">
        {href ? (
          // A raw <a> to an INTERNAL route was a full document load out of the
          // app shell (#2983) — the same defect as the training overview's
          // "next workout" CTA, and this tile is a door into a session's
          // canonical activity page. The
          // value is the tile's only text, so it is also the pending slot. The
          // announcement names the TILE, lower-cased to match the shipped
          // convention ("Opening 5s best"): the box cannot name what is at the
          // other end, and the number alone would announce nothing.
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
