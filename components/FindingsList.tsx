import type { ReactNode } from "react";
import type { Finding } from "@/lib/findings";
import FindingRow from "@/components/FindingRow";

// Shared presentational list for the page-level, dismissible observational findings
// (issue #45, domains 4–6) — the training-balance, body-hygiene, and goal-pacing
// cards all render through this one component so their markup can't drift (the
// AGENTS.md "shared content component" rule). It generalizes the inline markup that
// TrajectoryFindings.tsx first established. Each card shows title/detail, an optional
// evidence line + action link, and a dismiss button posting to the surface's own
// namespace-guarded server action (passed in as `dismissAction`). Renders nothing
// when there are no findings.
//
// Capped surfaces (the dashboard rollup widgets, #1219) pass their overflow as
// `moreFindings`: the rows beyond the cap render inside a native <details>
// disclosure ("Show N more"), so a "N of M" subtitle always comes with a path to
// the hidden M−N — same rows, same links, same dismiss affordance. Overflow rows
// carry their own `${testid}-more-item` testid so cap assertions on the visible
// slice stay exact.
export default function FindingsList({
  findings,
  moreFindings = [],
  dismissAction,
  heading,
  subtitle,
  icon,
  testid,
  collapsible = false,
}: {
  findings: Finding[];
  // Overflow beyond the surface's cap, revealed by a "Show N more" disclosure.
  moreFindings?: Finding[];
  // The surface's dismiss server action (guards its own dedupeKey namespace).
  dismissAction: (formData: FormData) => void | Promise<void>;
  heading: string;
  subtitle: string;
  icon: ReactNode;
  // data-testid for the container; each finding row is `${testid}-item`, each
  // dismiss button `${testid}-dismiss` (overflow rows: `${testid}-more-item` /
  // `${testid}-more-dismiss`).
  testid: string;
  // Dense supporting findings can start as a one-row disclosure so they remain
  // visible without pushing the page's primary content below the fold.
  collapsible?: boolean;
}) {
  if (findings.length === 0) return null;

  // The row itself is the shared FindingRow (#1496) — the Training → Overview
  // rollup renders the SAME row inside its group disclosure.
  const row = (f: Finding, itemTestid: string, dismissTestid: string) => (
    <FindingRow
      key={f.dedupeKey}
      finding={f}
      dismissAction={dismissAction}
      itemTestid={itemTestid}
      dismissTestid={dismissTestid}
    />
  );

  const rows = (
    <>
      <ul className="space-y-3">
        {findings.map((f) => row(f, `${testid}-item`, `${testid}-dismiss`))}
      </ul>
      {moreFindings.length > 0 && (
        <details className="group mt-3" data-testid={`${testid}-more`}>
          <summary className="cursor-pointer list-none text-xs font-medium text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400 [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">
              Show {moreFindings.length} more →
            </span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul className="mt-3 space-y-3">
            {moreFindings.map((f) =>
              row(f, `${testid}-more-item`, `${testid}-more-dismiss`)
            )}
          </ul>
        </details>
      )}
    </>
  );

  if (collapsible) {
    return (
      <details className="card group" data-testid={testid}>
        <summary
          className="flex cursor-pointer list-none items-center justify-between gap-4 [&::-webkit-details-marker]:hidden"
          data-testid={`${testid}-toggle`}
        >
          <span className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5">{icon}</span>
            <span className="min-w-0">
              <span className="block font-semibold text-slate-800 dark:text-slate-100">
                {heading}
              </span>
              <span className="mt-0.5 block text-sm text-slate-500 dark:text-slate-400">
                {subtitle}
              </span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
              {findings.length + moreFindings.length}
            </span>
            <span
              className="text-sm text-slate-500 transition-transform group-open:rotate-180 dark:text-slate-400"
              aria-hidden
            >
              ▾
            </span>
          </span>
        </summary>
        <div className="mt-4 border-t border-black/10 pt-4 dark:border-white/10">
          {rows}
        </div>
      </details>
    );
  }

  return (
    <div className="card" data-testid={testid}>
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
        {icon}
        {heading}
      </h2>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        {subtitle}
      </p>
      {rows}
    </div>
  );
}
