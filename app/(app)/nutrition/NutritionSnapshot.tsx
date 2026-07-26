import type { FiberAdequacy } from "@/lib/fiber";
import type { ProteinAdequacy, ProteinToday } from "@/lib/protein";

const STATUS_LABEL: Record<string, string> = {
  below: "Below",
  within: "In range",
  above: "Above",
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
  proteinPeriod = "today",
  fiberPeriod = "today",
}: {
  proteinToday: ProteinToday | null;
  proteinAdequacy: ProteinAdequacy | null;
  fiberAdequacy: FiberAdequacy | null;
  proteinPeriod?: string;
  fiberPeriod?: string;
}) {
  if (!proteinToday && !proteinAdequacy && !fiberAdequacy) return null;

  const proteinStatus = proteinAdequacy?.status;
  const proteinGrams =
    proteinToday?.todayGrams ?? proteinAdequacy?.intake.grams ?? null;
  const proteinIsFloor =
    (proteinToday?.todayIntake?.basis ?? proteinAdequacy?.intake.basis) !==
    "tracked";
  const fiberStatus = fiberAdequacy?.status;
  const fiberIsFloor = fiberAdequacy?.intake.basis !== "tracked";
  const hasProtein = proteinGrams != null;
  const paired = hasProtein && !!fiberAdequacy;

  return (
    <section
      data-testid="nutrition-mobile-snapshot"
      className="border-y border-black/5 py-2 lg:hidden dark:border-white/5"
      aria-label="Nutrition at a glance"
    >
      <dl
        className={`grid text-sm ${
          paired
            ? "grid-cols-2 divide-x divide-black/5 dark:divide-white/5"
            : "grid-cols-1"
        }`}
      >
        {hasProtein && (
          <div className={`min-w-0 ${paired ? "pr-3" : ""}`}>
            <dt className="flex items-center justify-between gap-2 font-medium text-slate-700 dark:text-slate-200">
              <span>Protein</span>
              {proteinStatus && (
                <span
                  data-testid="nutrition-snapshot-protein-status"
                  className={`text-xs font-medium ${STATUS_CLASS[proteinStatus] ?? STATUS_CLASS.above}`}
                >
                  {STATUS_LABEL[proteinStatus] ?? proteinStatus}
                </span>
              )}
            </dt>
            <dd
              data-testid="nutrition-snapshot-protein-value"
              className="mt-0.5 text-xs tabular-nums text-slate-600 dark:text-slate-300"
            >
              {rounded(proteinGrams)}g{proteinIsFloor ? "+" : ""}{" "}
              {proteinPeriod}
            </dd>
          </div>
        )}
        {fiberAdequacy && (
          <div className={`min-w-0 ${paired ? "pl-3" : ""}`}>
            <dt className="flex items-center justify-between gap-2 font-medium text-slate-700 dark:text-slate-200">
              <span>Fiber</span>
              <span
                data-testid="nutrition-snapshot-fiber-status"
                className={`text-xs font-medium ${STATUS_CLASS[fiberStatus ?? ""] ?? STATUS_CLASS.above}`}
              >
                {STATUS_LABEL[fiberStatus ?? ""] ?? fiberStatus}
              </span>
            </dt>
            <dd
              data-testid="nutrition-snapshot-fiber-value"
              className="mt-0.5 text-xs tabular-nums text-slate-600 dark:text-slate-300"
            >
              {rounded(fiberAdequacy.intake.grams)}g{fiberIsFloor ? "+" : ""}{" "}
              {fiberPeriod}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
