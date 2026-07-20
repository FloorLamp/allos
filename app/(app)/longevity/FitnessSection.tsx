import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getUserSex, getUserAge } from "@/lib/settings";
import { getLatestBodyMetric } from "@/lib/queries";
import { batteryForAge } from "@/lib/fitness-battery";
import { getFitnessAssessments } from "@/lib/fitness-assessment";
import { buildFitnessCheckModel } from "@/lib/fitness-check-model";
import type { LongevitySection } from "@/lib/longevity";
import PillarStat from "./PillarStat";

// Longevity §2 — Fitness-check percentiles (#1042 phase 4): a READ view over
// fitness_assessments. The numbers all come from the ONE existing pure model
// (buildFitnessCheckModel — the same computation /training?tab=fitness renders,
// percentiles from lib/fitness-norms), never a forked engine; recording a check
// stays on the Training tab, which "Run a fitness check" deep-links into. The
// section's headline stats are the fitness pillars (vo2max/strength) — the SAME
// Pillar objects the dashboard widget renders.
const DOMAIN_LABEL: Record<string, string> = {
  endurance: "Endurance",
  strength: "Strength",
  balance: "Balance",
  flexibility: "Flexibility",
  mobility: "Mobility",
  body: "Body composition",
};

export default async function FitnessSection({
  section,
}: {
  section: LongevitySection;
}) {
  const { profile } = await requireSession();
  const sex = getUserSex(profile.id);
  const age = getUserAge(profile.id);
  const bodyweightKg = getLatestBodyMetric(profile.id, "weight");

  const sessions = getFitnessAssessments(profile.id, 2);
  const model = buildFitnessCheckModel(
    batteryForAge(age),
    sessions[0] ?? null,
    sessions[1] ?? null,
    sex,
    age,
    bodyweightKg
  );

  return (
    <section
      id="fitness"
      data-testid="longevity-fitness"
      className="card mb-6 scroll-mt-20"
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
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Last guided check {model.latestDate} — {model.measuredCount} of{" "}
            {model.totalCount} tests measured.
          </p>
          {model.domains.some((d) => d.percentile != null) && (
            <div className="mt-3 space-y-2">
              {model.domains.map((d) => (
                <div
                  key={d.domain}
                  data-testid={`longevity-fitness-domain-${d.domain}`}
                >
                  <div className="flex justify-between text-xs text-slate-600 dark:text-slate-300">
                    <span>{DOMAIN_LABEL[d.domain] ?? d.domain}</span>
                    <span>
                      {d.percentile != null
                        ? `${d.percentile}th pct`
                        : `${d.measuredCount}/${d.totalCount}`}
                    </span>
                  </div>
                  <div className="mt-0.5 h-2 rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className="h-2 rounded-full bg-brand-500"
                      style={{ width: `${d.percentile ?? 0}%` }}
                    />
                  </div>
                </div>
              ))}
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
