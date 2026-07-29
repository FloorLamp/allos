import type { ReactNode } from "react";
import type { TrendsSection } from "@/lib/trends-sections";

// The section frame of the merged Trends page (#1644).
//
// One shell for all four censuses so a section's anchor, its heading level, its
// scroll offset under the sticky chip strip, and its testid are decided ONCE
// instead of per section. The `id` IS the section id — the same value the jump
// chips link to (`#body`) and every retired `?tab=` link was rewritten to through
// `trendsSectionHref`.
export default function TrendsSectionShell({
  id,
  heading,
  description,
  children,
}: {
  id: TrendsSection;
  heading: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      // Clear the sticky chip row (and, on a phone, the app chrome above it) so a
      // chip tap lands the heading in view rather than under the strip.
      className="scroll-mt-28 space-y-4"
      data-testid={`trends-section-${id}`}
      aria-labelledby={`trends-section-${id}-heading`}
    >
      <div className="space-y-1">
        <h2
          id={`trends-section-${id}-heading`}
          className="text-lg font-semibold text-slate-800 dark:text-slate-100"
        >
          {heading}
        </h2>
        {description && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

// The streamed placeholder a census shows until its own render arrives (#1644's
// streaming acceptance criterion). Deliberately quiet and fixed-height-ish: it
// holds the scroll position roughly where the section will land, so a chip tapped
// during the stream doesn't jump when the content replaces it.
export function TrendsSectionSkeleton({ label }: { label: string }) {
  return (
    <div
      className="card animate-pulse"
      data-testid="trends-section-loading"
      data-section={label}
    >
      <div className="h-4 w-40 rounded bg-slate-200 dark:bg-ink-800" />
      <div className="mt-4 h-32 rounded bg-slate-100 dark:bg-ink-850" />
      <span className="sr-only">Loading {label}…</span>
    </div>
  );
}
