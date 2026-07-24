import type { FiberAdequacy } from "@/lib/fiber";
import type { ProteinAdequacy, ProteinToday } from "@/lib/protein";

const STATUS_LABEL: Record<string, string> = {
  below: "Below range",
  within: "In range",
  above: "Above range",
};

const STATUS_CLASS: Record<string, string> = {
  below: "text-amber-700 dark:text-amber-300",
  within: "text-emerald-700 dark:text-emerald-300",
  above: "text-slate-600 dark:text-slate-300",
};

function rounded(value: number): string {
  return String(Math.round(value));
}

// A compact mobile checkpoint between the personalized quick-log rows and the
// collapsed remainder of the catalog. The full gauges and write controls still live
// in Today's nutrients below; this copy only keeps feedback from being buried after
// the complete food vocabulary on a phone.
export default function NutritionSnapshot({
  proteinToday,
  proteinAdequacy,
  fiberAdequacy,
}: {
  proteinToday: ProteinToday | null;
  proteinAdequacy: ProteinAdequacy | null;
  fiberAdequacy: FiberAdequacy | null;
}) {
  if (!proteinToday && !proteinAdequacy && !fiberAdequacy) return null;

  const proteinStatus = proteinAdequacy?.status;
  const proteinGrams =
    proteinToday?.todayGrams ?? proteinAdequacy?.intake.grams ?? null;
  const proteinIsFloor =
    (proteinToday?.todayIntake?.basis ?? proteinAdequacy?.intake.basis) !==
    "tracked";
  const fiberStatus = fiberAdequacy?.status;

  return (
    <section
      data-testid="nutrition-mobile-snapshot"
      className="rounded-lg border border-black/5 bg-brand-50/60 p-3 lg:hidden dark:border-white/5 dark:bg-brand-950/30"
      aria-label="Nutrition at a glance"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          At a glance
        </h3>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Details below
        </span>
      </div>
      <dl className="space-y-2 text-sm">
        {proteinGrams != null && (
          <div className="flex items-center justify-between gap-3">
            <dt className="font-medium text-slate-700 dark:text-slate-200">
              Protein
            </dt>
            <dd className="flex items-center gap-2 text-right">
              <span className="tabular-nums text-slate-600 dark:text-slate-300">
                {proteinIsFloor ? "at least " : ""}
                {rounded(proteinGrams)} g today
              </span>
              {proteinStatus && (
                <span
                  className={`font-medium ${STATUS_CLASS[proteinStatus] ?? STATUS_CLASS.above}`}
                >
                  {STATUS_LABEL[proteinStatus] ?? proteinStatus}
                </span>
              )}
            </dd>
          </div>
        )}
        {fiberAdequacy && (
          <div className="flex items-center justify-between gap-3">
            <dt className="font-medium text-slate-700 dark:text-slate-200">
              Fiber
            </dt>
            <dd className="flex items-center gap-2 text-right">
              <span className="tabular-nums text-slate-600 dark:text-slate-300">
                ~{rounded(fiberAdequacy.intake.grams)} g/day this week
              </span>
              <span
                className={`font-medium ${STATUS_CLASS[fiberStatus ?? ""] ?? STATUS_CLASS.above}`}
              >
                {STATUS_LABEL[fiberStatus ?? ""] ?? fiberStatus}
              </span>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
