import { IconBarbell } from "@tabler/icons-react";
import Link from "next/link";
import type { Finding } from "@/lib/findings";
import FindingRow from "@/components/FindingRow";
import {
  rollupTrainingFindings,
  type TrainingFindingRow,
} from "@/lib/training-findings-rollup";

// The Training → Overview "Training watch" card (#1496) — ONE card, capped.
//
// Same findings, same dedupeKeys, same shared dismissal bus as before: the per-muscle
// volume-band shortfalls (#742) simply render as ONE expandable rollup row instead of
// up to ~17 sibling cards, and the row list is capped at three with the rest behind a
// "show all" disclosure. Expanding the rollup reveals the individual findings with
// their own dismiss buttons, so a dismiss inside it is still item-wise: it writes that
// muscle's own suppression key and the rollup comes back with N−1 items.
//
// The grouping/cap decision is the pure lib/training-findings-rollup; this component
// is the formatter over its result.
export default function TrainingWatchCard({
  findings,
  dismissAction,
}: {
  findings: Finding[];
  dismissAction: (formData: FormData) => void | Promise<void>;
}) {
  const rollup = rollupTrainingFindings(findings);
  if (rollup.rows.length === 0) return null;

  const renderRow = (row: TrainingFindingRow, overflow: boolean) => {
    if (row.kind === "finding") {
      return (
        <FindingRow
          key={row.key}
          finding={row.finding}
          dismissAction={dismissAction}
          itemTestid={
            overflow ? "training-findings-more-item" : "training-findings-item"
          }
          dismissTestid={
            overflow
              ? "training-findings-more-dismiss"
              : "training-findings-dismiss"
          }
        />
      );
    }
    const g = row.group;
    return (
      <li
        key={row.key}
        data-testid="training-findings-rollup"
        className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 dark:border-ink-750 dark:bg-ink-850/40"
      >
        <details className="group">
          <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
            <div className="min-w-0 flex-1">
              <p
                className="font-medium text-slate-800 dark:text-slate-100"
                data-testid="training-findings-rollup-title"
              >
                {g.title}
              </p>
              {g.detail && (
                <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                  {g.detail}
                </p>
              )}
            </div>
            <span className="shrink-0 text-xs font-medium text-brand-700 dark:text-brand-400">
              <span className="group-open:hidden">Show</span>
              <span className="hidden group-open:inline">Hide</span>
            </span>
          </summary>
          {/* The folded findings, unchanged — each keeps its own dedupeKey and its
              own dismiss form, so the bus behavior is identical to the flat cards. */}
          <ul className="mt-3 space-y-3">
            {g.items.map((f) => (
              <FindingRow
                key={f.dedupeKey}
                finding={f}
                dismissAction={dismissAction}
                itemTestid="training-findings-rollup-item"
                dismissTestid="training-findings-rollup-dismiss"
              />
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            <Link
              href="/training?tab=overview#muscle-coverage"
              className="font-medium text-brand-700 hover:underline dark:text-brand-400"
            >
              See muscle coverage →
            </Link>
          </p>
        </details>
      </li>
    );
  };

  const n = rollup.total;
  return (
    <div className="card" data-testid="training-findings">
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
        <IconBarbell className="h-4 w-4 shrink-0 text-amber-500" stroke={2} />
        Training watch
      </h2>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        {n} pattern{n === 1 ? "" : "s"} worth a look from your recent training.
      </p>
      <ul className="space-y-3">
        {rollup.shown.map((row) => renderRow(row, false))}
      </ul>
      {rollup.overflow.length > 0 && (
        <details className="group mt-3" data-testid="training-findings-more">
          <summary className="cursor-pointer list-none text-xs font-medium text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400 [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">
              Show all {rollup.rows.length} →
            </span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul className="mt-3 space-y-3">
            {rollup.overflow.map((row) => renderRow(row, true))}
          </ul>
        </details>
      )}
    </div>
  );
}
