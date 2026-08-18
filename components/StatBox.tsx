import type { CSSProperties, ReactNode } from "react";
import { goalBarClass } from "@/lib/outcome-goals";
import { PendingTextLink } from "@/components/PendingLink";
import type { AppRoute } from "@/lib/hrefs";

// A labelled stat box used in the Cardio/Sport/Exercise detail panels: an
// uppercase label over a bold value, with optional sub-text, link, label badge,
// and a goal-style progress bar.
export function StatBox({
  label,
  value,
  valueStyle,
  valueTitle,
  sub,
  subClass,
  href,
  badge,
  progress,
  className,
  variant = "card",
  "data-testid": testId,
}: {
  label: string;
  value: string;
  valueStyle?: CSSProperties;
  valueTitle?: string;
  sub?: ReactNode;
  subClass?: string;
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
        variant === "plain"
          ? "min-w-0"
          : "rounded-lg bg-slate-50 px-3 py-2 dark:bg-ink-900"
      } ${className ?? ""}`}
    >
      <dt className="flex items-center gap-1.5 section-label">
        {label}
        {badge}
      </dt>
      <dd
        className="mt-0.5 font-semibold text-slate-800 dark:text-slate-100"
        style={valueStyle}
        title={valueTitle}
      >
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
        <dd
          className={`text-xs ${subClass ?? "text-slate-500 dark:text-slate-400"}`}
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
