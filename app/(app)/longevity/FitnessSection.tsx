import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { assembleFitnessCheckModel } from "@/lib/fitness-check-assemble";
import type { LongevitySection } from "@/lib/longevity";
import FitnessDomainBars from "@/components/FitnessDomainBars";
import PillarStat from "./PillarStat";

// Longevity §2 — Fitness-check percentiles (#1042 phase 4): a READ view over
// fitness_assessments. The numbers all come from the ONE existing pure model
// (buildFitnessCheckModel — the same computation /training?tab=fitness renders,
// percentiles from lib/fitness-norms), never a forked engine; recording a check
// stays on the Training tab, which "Run a fitness check" deep-links into. The
// section's headline stats are the fitness pillars (vo2max/strength) — the SAME
// Pillar objects the dashboard widget renders. The per-domain bars are the SHARED
// FitnessDomainBars component (the training grid renders the same one) so the color/label
// language can't drift between the two surfaces (#1132 / #221 formatter parity).
//
// The gather itself is `assembleFitnessCheckModel` (#2025) — the ONE DB-side assembler the
// Training section and the save action already used. This section hand-rolled the same six
// reads, which is exactly how a freshness policy ends up applied on one surface and not
// the other.
export default async function FitnessSection({
  section,
}: {
  section: LongevitySection;
}) {
  const { profile } = await requireSession();
  const { model } = assembleFitnessCheckModel(profile.id);

  return (
    <section
      id="fitness"
      data-testid="longevity-fitness"
      className="card scroll-mt-20"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {section.title}
        </h2>
        <Link
          href="/training?tab=fitness"
          className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
          data-testid="longevity-run-check"
        >
          Run a fitness check
        </Link>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {section.pillars.map((p) => (
          <PillarStat key={p.key} pillar={p} />
        ))}
      </div>

      {model.latestDate ? (
        <div className="mt-4">
          {/* #2025 — the same fresh/stale/unmeasured split the Training header states,
              off the same model: "measured" alone let a years-old value read as coverage. */}
          <p
            className="text-sm text-slate-600 dark:text-slate-300"
            data-testid="longevity-fitness-coverage"
          >
            Last guided check {model.latestDate} — {model.coverage.fresh} of{" "}
            {model.coverage.total} tests with a current value
            {model.coverage.stale > 0
              ? `, ${model.coverage.stale} past a re-check window`
              : ""}
            .
          </p>
          {model.domains.some((d) => d.bestPercentile != null) && (
            <div className="mt-3">
              <FitnessDomainBars
                domains={model.domains}
                testIdPrefix="longevity-fitness-domain"
              />
            </div>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          No guided fitness check recorded yet — run one to add per-domain
          percentiles here.
        </p>
      )}
    </section>
  );
}
