import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getOptimalShareRows } from "@/lib/queries";
import { biomarkerViewHref } from "@/lib/hrefs";
import type { OptimalShareRow } from "@/lib/longevity-pillars";
import type { LongevitySection } from "@/lib/longevity";
import { MedicalValue } from "@/components/ui";
import PillarStat from "./PillarStat";

// Longevity §4 — Optimal-share biomarkers (#1042 phase 4): the expanded
// breakdown behind the "N of M optimal" pillar. The rows come from the SAME
// gather + rangeBadge judgment as the pillar count (getOptimalShareRows /
// optimalShareRows — reconciliation pinned by a pure test), non-optimal first.
// Links point at the biomarker surfaces that exist TODAY (/biomarkers +
// biomarkerViewHref); phase 5 (Results) repoints them later.
//
// A row shows the CANONICAL name and leads with the VALUE (#1501):
//   • `canonicalName?.trim() || name` — the vocabulary's canonical_name already IS clean,
//     deliberately-cased display text ("Uric Acid", "eGFR"); `name` is the raw
//     string the lab delivered, which may be shouting case. Rendering the raw one
//     while holding the canonical was this card's bug. (The provenance/edit
//     surfaces — import review, the editable record row, the detail page's "as
//     reported" column — deliberately keep showing the raw string.)
//   • the existing MedicalValue (value + unit + directional caret + sr-only
//     severity, #1220) instead of a direction chip: both directions used to
//     collapse into one amber "Above/Below optimal" badge that took the row's
//     width and never showed the number. The curated optimal band trails it,
//     muted, so a reading is legible against its target at a glance.

function BiomarkerRow({ row: r }: { row: OptimalShareRow }) {
  return (
    <li
      className="flex items-baseline justify-between gap-2 text-sm"
      data-testid="longevity-biomarker-row"
    >
      <Link
        href={biomarkerViewHref(r.canonicalName, r.name)}
        className={`truncate hover:underline ${
          r.badge === "optimal"
            ? "text-slate-700 dark:text-slate-200"
            : "text-brand-700 dark:text-brand-400"
        }`}
      >
        {r.canonicalName?.trim() || r.name}
      </Link>
      <span className="shrink-0 whitespace-nowrap tabular-nums">
        <MedicalValue value={r.value} unit={r.unit} flag={r.flag} />
        {r.optimalText && (
          <span
            data-testid="longevity-biomarker-optimal"
            className="ml-2 text-xs text-slate-500 dark:text-slate-400"
          >
            opt {r.optimalText}
          </span>
        )}
      </span>
    </li>
  );
}
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
      className="card scroll-mt-20"
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
              <BiomarkerRow key={`${r.name}-${i}`} row={r} />
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
              <BiomarkerRow key={`${r.name}-${i}`} row={r} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
