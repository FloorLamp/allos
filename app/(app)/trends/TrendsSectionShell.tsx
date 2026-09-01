import type { ReactNode } from "react";
import type { TrendsLandingSection } from "@/lib/trends-sections";

// The section frame of the merged Trends landing surface (#1644).
//
// The streamed Body census shell. Its canonical id and retired Starred alias share
// one scroll position, so old deep links survive without reviving a second section.
export default function TrendsSectionShell({
  id,
  legacyId,
  heading,
  description,
  quietHeading = false,
  children,
}: {
  id: TrendsLandingSection;
  legacyId?: "starred";
  heading: string;
  description?: string;
  // The page head carries no heading band (#1485 F reclaimed it, and the tab
  // strip already names the surface), so the census heading stays in the
  // accessibility tree without spending a second visible row.
  quietHeading?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      // Clear the sticky tab strip (and, on a phone, the app chrome above it) so a
      // `#body` deep link lands the heading in view rather than under the strip.
      className={quietHeading ? "scroll-mt-28" : "scroll-mt-28 space-y-4"}
      data-testid={`trends-section-${id}`}
      aria-labelledby={`trends-section-${id}-heading`}
    >
      {legacyId ? (
        <span id={legacyId} className="scroll-mt-28" aria-hidden />
      ) : null}
      <div className={quietHeading ? undefined : "space-y-1"}>
        <h2
          id={`trends-section-${id}-heading`}
          className={
            quietHeading
              ? "sr-only"
              : "text-lg font-semibold text-slate-800 dark:text-slate-100"
          }
        >
          {heading}
        </h2>
        {description && !quietHeading && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}
