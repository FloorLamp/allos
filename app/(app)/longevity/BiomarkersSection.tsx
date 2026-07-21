import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getOptimalShareRows } from "@/lib/queries";
import { RANGE_BADGE_META } from "@/lib/reference-range";
import { biomarkerViewHref } from "@/lib/hrefs";
import type { LongevitySection } from "@/lib/longevity";
import PillarStat from "./PillarStat";

// Longevity §4 — Optimal-share biomarkers (#1042 phase 4): the expanded
// breakdown behind the "N of M optimal" pillar. The rows come from the SAME
// gather + rangeBadge judgment as the pillar count (getOptimalShareRows /
// optimalShareRows — reconciliation pinned by a pure test), non-optimal first.
// Links point at the biomarker surfaces that exist TODAY (/biomarkers +
// biomarkerViewHref); phase 5 (Results) repoints them later.
export default async function BiomarkersSection({
  section,
}: {
  section: LongevitySection;
}) {
  const { profile } = await requireSession();
  const rows = getOptimalShareRows(profile.id);
  const nonOptimal = rows.filter((r) => r.badge !== "optimal");
  const optimal = rows.filter((r) => r.badge === "optimal");

  return (
    <section
      id="biomarkers"
      data-testid="longevity-biomarkers"
      className="card mb-6 scroll-mt-20"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {section.title}
        </h2>
        <Link
          href="/results/biomarkers"
          className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          All biomarkers
        </Link>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {section.pillars.map((p) => (
          <PillarStat key={p.key} pillar={p} />
        ))}
      </div>

      {nonOptimal.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 section-label">Outside their optimal band</h3>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {nonOptimal.map((r, i) => (
              <li
                key={`${r.name}-${i}`}
                className="flex items-center justify-between gap-2 text-sm"
                data-testid="longevity-biomarker-row"
              >
                <Link
                  href={biomarkerViewHref(r.canonicalName, r.name)}
                  className="truncate text-brand-700 hover:underline dark:text-brand-400"
                >
                  {r.name}
                </Link>
                <span
                  className={`badge shrink-0 ${RANGE_BADGE_META[r.badge].chip}`}
                >
                  {RANGE_BADGE_META[r.badge].label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {optimal.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-slate-600 dark:text-slate-300">
            {optimal.length} marker{optimal.length === 1 ? "" : "s"} in the
            optimal band
          </summary>
          <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {optimal.map((r, i) => (
              <li
                key={`${r.name}-${i}`}
                className="flex items-center justify-between gap-2 text-sm"
                data-testid="longevity-biomarker-row"
              >
                <Link
                  href={biomarkerViewHref(r.canonicalName, r.name)}
                  className="truncate text-slate-700 hover:underline dark:text-slate-200"
                >
                  {r.name}
                </Link>
                <span
                  className={`badge shrink-0 ${RANGE_BADGE_META[r.badge].chip}`}
                >
                  {RANGE_BADGE_META[r.badge].label}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
