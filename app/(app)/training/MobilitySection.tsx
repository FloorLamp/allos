import { getMobilitySession, getMobilityCoverage } from "@/lib/queries";
import { MOBILITY_MOVES } from "@/lib/mobility-moves";
import { formatRelativeDate } from "@/lib/format-date";
import MobilityLogBar from "./MobilityLogBar";

// The mobility surface on the Training overview (issue #840) — SELF-CONTAINED so it can be
// spliced next to (never merged into) the #736 muscle-coverage card. It renders:
//   • the tap-the-moves log bar (one recovery activity row per day, its components the
//     tapped moves — no per-move sets/weights, the habit-tier model);
//   • the mobility region-coverage strip — a SEPARATE view from strength trained-coverage
//     (#482: trained ≠ mobilized), computed only from recovery sessions.
// Kept a plain component import so any future OverviewSection restructure is a one-line
// splice.
const COVERAGE_DAYS = 7;

export default async function MobilitySection({
  profileId,
  today,
}: {
  profileId: number;
  today: string;
}) {
  const session = getMobilitySession(profileId, today);
  const coverage = getMobilityCoverage(profileId, today, COVERAGE_DAYS);
  const coverageMax = coverage.reduce((m, r) => Math.max(m, r.days), 0);

  return (
    <div className="card" data-testid="mobility-section">
      <h3 className="font-semibold text-slate-800 dark:text-slate-100">
        Mobility
      </h3>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        Tap the moves you did today — a mobility session is one tap per move, no
        sets or weights. Regularity is the signal.
      </p>
      <div className="mt-4">
        <MobilityLogBar
          today={today}
          initialMoves={session.moves}
          initialDurationMin={session.durationMin}
          moves={MOBILITY_MOVES}
        />
      </div>

      {/* Region coverage — its OWN computation, never merged with strength coverage
          (#482). Shows every region so a 0-mobilized region ("Shoulders 0 this week")
          is visible, the whole point of a coverage view. */}
      <div className="mt-6 border-t border-black/5 pt-4 dark:border-white/5">
        <h4 className="font-medium text-slate-700 dark:text-slate-200">
          Region coverage
        </h4>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Days each region was mobilized over the last {COVERAGE_DAYS} days —
          separate from strength coverage (mobilized ≠ trained).
        </p>
        <ul className="mt-3 space-y-2" data-testid="mobility-coverage">
          {coverage.map((row) => (
            <li
              key={row.region}
              data-testid="mobility-coverage-row"
              data-region={row.region}
              className="flex items-center gap-3 text-sm"
            >
              <span className="w-24 shrink-0 text-slate-600 dark:text-slate-300">
                {row.label}
              </span>
              <span
                className="h-2.5 min-w-[0.375rem] rounded-full bg-sky-500/80"
                style={{
                  width: `${coverageMax > 0 ? (row.days / coverageMax) * 100 : 0}%`,
                }}
                aria-hidden="true"
              />
              <span className="ml-auto shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                {row.days === 0
                  ? "—"
                  : `${row.days} ${row.days === 1 ? "day" : "days"}`}
              </span>
              <span className="w-24 shrink-0 text-right text-xs text-slate-400 dark:text-slate-500">
                {row.lastMobilized
                  ? formatRelativeDate(row.lastMobilized, today)
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
