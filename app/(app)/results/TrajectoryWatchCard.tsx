import { IconTrendingUp, IconX } from "@tabler/icons-react";
import type { Finding } from "@/lib/findings";
import FindingRow from "@/components/FindingRow";
import PhoneFold from "@/components/PhoneFold";
import {
  rollupTrajectoryFindings,
  type TrajectoryAnalyteGroup,
} from "@/lib/trajectory-rollup";

// The Results › Biomarkers "Trajectory watch" card (#1499 section B) — ONE card,
// capped, the #1496 Training-watch pattern applied to the hub that shipped the same
// disease.
//
// Same findings, same dedupeKeys, same shared dismissal bus as before: an analyte's
// approaching / persistent / velocity observations render as ONE expandable row
// instead of up to three sibling blocks, and the row list is capped at three with
// the rest behind a "show all" disclosure. Expanding a row reveals the individual
// findings with their own dismiss buttons, so a dismiss inside it is still
// item-wise.
//
// The row's OWN dismiss is not a new bulk action: since #564 every trajectory
// finding's dismiss writes the analyte-level acknowledgment key
// ("biomarker-flag:<family>") it carries as `supersedes`, which is exactly the key
// this rollup groups on — so the group button and any item inside it post the same
// string to the same bus, and the dashboard flag goes quiet with them.
//
// The grouping/cap decision is the pure lib/trajectory-rollup; this component is
// the formatter over its result.
//
// #1647: below `sm` the row list folds behind a toggle and the card's headline
// sentence stays. That is the price of keeping this card ABOVE the panel index on a
// phone while the two glance cards move below it — see lib/phone-fold's PHONE_STACK.
export default function TrajectoryWatchCard({
  findings,
  dismissAction,
}: {
  findings: Finding[];
  dismissAction: (formData: FormData) => void | Promise<void>;
}) {
  const rollup = rollupTrajectoryFindings(findings);
  if (rollup.groups.length === 0) return null;

  const renderGroup = (g: TrajectoryAnalyteGroup, overflow: boolean) => {
    const n = g.items.length;
    return (
      <li
        key={g.key}
        data-testid="trajectory-rollup"
        data-analyte={g.label}
        className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/60 dark:bg-amber-950/30"
      >
        <div className="flex items-start gap-3">
          <details className="group min-w-0 flex-1">
            <summary
              data-testid={
                overflow
                  ? "trajectory-rollup-more-toggle"
                  : "trajectory-rollup-toggle"
              }
              className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-800 dark:text-slate-100">
                  {g.label}
                </p>
                <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                  {n} trend{n === 1 ? "" : "s"} worth a look
                </p>
              </div>
              <span className="shrink-0 text-xs font-medium text-brand-700 dark:text-brand-400">
                <span className="group-open:hidden">Show</span>
                <span className="hidden group-open:inline">Hide</span>
              </span>
            </summary>
            {/* The folded findings, unchanged — each keeps its own dedupeKey and its
                own dismiss form, so the bus behavior is identical to the flat cards.
                The POSTED key is the analyte acknowledgment (#564), as it was
                before this rollup existed. */}
            <ul className="mt-3 space-y-3">
              {g.items.map((f) => (
                <FindingRow
                  key={f.dedupeKey}
                  finding={f}
                  dismissAction={dismissAction}
                  dismissKey={f.supersedes ?? f.dedupeKey}
                  itemTestid="trajectory-finding"
                  dismissTestid="trajectory-dismiss"
                />
              ))}
            </ul>
          </details>
          {/* Dismiss the analyte without expanding — the SAME acknowledgment key
              every item inside posts, so this is a shortcut, not a bulk action. */}
          <form action={dismissAction}>
            <input type="hidden" name="dedupe_key" value={g.key} />
            <button
              type="submit"
              data-testid="trajectory-rollup-dismiss"
              aria-label={`Dismiss ${g.label} trajectory watch`}
              title="Dismiss"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-ink-750 dark:hover:text-slate-300"
            >
              <IconX className="h-4 w-4" stroke={2} />
            </button>
          </form>
        </div>
      </li>
    );
  };

  const n = rollup.analyteCount;
  return (
    <div className="card mb-6" data-testid="trajectory-findings">
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
        <IconTrendingUp
          className="h-4 w-4 shrink-0 text-amber-500"
          stroke={2}
        />
        Trajectory watch
      </h2>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        {n} analyte{n === 1 ? "" : "s"} trending before a single reading crosses
        a line{rollup.names ? ` — ${rollup.names}` : ""}.
      </p>
      {/* PHONE FOLD (#1647). This card keeps its place ABOVE the panel index at every
          width — it is the one surface here that has to find the reader rather than be
          looked up — so on a phone it pays for that place by folding its ROWS. What
          stays is the whole signal: that something is trending, how many analytes, and
          which ones (the sentence above names them). What folds is the per-analyte
          detail, one tap away. From `sm` up the folded slot is `display: contents`, so
          the list and the overflow disclosure are laid out by this card exactly as
          before — no desktop change, and no second row tree. */}
      <PhoneFold
        testId="trajectory-rows-fold"
        showLabel={`Show ${n} trending analyte${n === 1 ? "" : "s"}`}
        hideLabel="Hide trending analytes"
        folded={
          <>
            <ul className="space-y-3">
              {rollup.shown.map((g) => renderGroup(g, false))}
            </ul>
            {rollup.overflow.length > 0 && (
              <details
                className="group mt-3"
                data-testid="trajectory-findings-more"
              >
                <summary className="cursor-pointer list-none text-xs font-medium text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400 [&::-webkit-details-marker]:hidden">
                  <span className="group-open:hidden">
                    Show all {rollup.groups.length} →
                  </span>
                  <span className="hidden group-open:inline">Show fewer</span>
                </summary>
                <ul className="mt-3 space-y-3">
                  {rollup.overflow.map((g) => renderGroup(g, true))}
                </ul>
              </details>
            )}
          </>
        }
      />
    </div>
  );
}
