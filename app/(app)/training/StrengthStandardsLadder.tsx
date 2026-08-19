import Link from "next/link";
import { strengthLevelLabel } from "@/lib/strength-standards";
import type { StrengthLadderRow } from "@/lib/strength-ladder";
import { fmtWeight } from "@/lib/units";
import type { WeightUnit } from "@/lib/settings";

const BANDS = [
  "Untrained",
  "Beginner",
  "Novice",
  "Intermediate",
  "Advanced",
  "Elite",
];

export default function StrengthStandardsLadder({
  rows,
  weightUnit,
}: {
  rows: StrengthLadderRow[];
  weightUnit: WeightUnit;
}) {
  return (
    <div className="card" data-testid="strength-standards-ladder">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Strength standards
        </h3>
        <Link
          href="/training?tab=analyze&kind=strength"
          className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          Full standards →
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          Log a core lift and body weight to place it on the standards ladder.
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {rows.map(({ exercise, placement }) => (
            <div key={exercise} data-testid="strength-ladder-row">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <Link
                  href={`/training?tab=analyze&kind=strength&item=${encodeURIComponent(exercise)}`}
                  className="font-semibold text-slate-800 hover:text-brand-700 hover:underline dark:text-slate-100 dark:hover:text-brand-400"
                >
                  {exercise}
                </Link>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {fmtWeight(placement.current.e1rmKg, weightUnit)} e1RM ·{" "}
                  {strengthLevelLabel(placement.current.level)}
                  {placement.moved ? " · PR" : ""}
                </span>
              </div>
              <div
                className="relative mt-2 h-5"
                aria-label={`${exercise} at ${strengthLevelLabel(placement.current.level)}`}
              >
                <div className="absolute inset-x-0 top-1/2 flex h-2 -translate-y-1/2 overflow-hidden rounded-full">
                  {BANDS.map((band, index) => (
                    <span
                      key={band}
                      title={band}
                      className={
                        [
                          "bg-slate-300 dark:bg-slate-700",
                          "bg-slate-400 dark:bg-slate-600",
                          "bg-amber-400",
                          "bg-brand-500",
                          "bg-sky-500",
                          "bg-violet-500",
                        ][index]
                      }
                      style={{ width: `${100 / BANDS.length}%` }}
                    />
                  ))}
                </div>
                {placement.priorPercent != null && (
                  <span
                    className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-500 bg-white dark:bg-ink-900"
                    style={{ left: `${placement.priorPercent}%` }}
                    title={`About 90 days ago: ${fmtWeight(placement.prior!.e1rmKg, weightUnit)}`}
                    data-testid="strength-ladder-prior"
                  />
                )}
                <span
                  className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-slate-900 shadow-sm dark:border-ink-950 dark:bg-white"
                  style={{ left: `${placement.currentPercent}%` }}
                  data-testid="strength-ladder-current"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
