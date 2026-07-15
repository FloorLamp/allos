import Link from "next/link";
import { IconTrendingUp, IconX } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getFindingSuppressions } from "@/lib/queries";
import { buildTrajectoryFindings } from "@/lib/trajectory-series";
import { activeFindings } from "@/lib/findings";
import { dismissTrajectory } from "./actions";

// Biomarker trajectory findings (issue #41) for the Trends → Biomarkers area. Runs
// the pure trajectory rules over the profile's per-analyte history and lists the
// active ones — an in-range value projected to cross a boundary, a persistent
// non-optimal pattern, or a concerning velocity — BEFORE a single-value flag would
// catch them. Each observation shows its numbers and a "worth discussing with your
// clinician" framing, links to the biomarker's detail (schedule a retest), and can
// be dismissed through the shared findings-bus suppression store. Nothing renders
// when no trajectory is firing.
export default async function TrajectoryFindings() {
  const { profile } = await requireSession();
  const now = today(profile.id);
  // activeFindings (not activeByKey) so a finding is suppressed by EITHER its own
  // `trajectory:<analyte>:<rule>` dedupeKey OR the shared `biomarker-flag:<family>`
  // acknowledgment it carries as `supersedes` (#564) — so dismissing the analyte's
  // flag on the dashboard silences its trajectory watch here too.
  const findings = activeFindings(
    buildTrajectoryFindings(profile.id, now),
    getFindingSuppressions(profile.id),
    now
  );
  if (findings.length === 0) return null;

  return (
    <div className="card" data-testid="trajectory-findings">
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
        <IconTrendingUp
          className="h-4 w-4 shrink-0 text-amber-500"
          stroke={2}
        />
        Trajectory watch
      </h2>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        Trends worth a closer look before a single reading crosses a line.
      </p>
      <ul className="space-y-3">
        {findings.map((f) => (
          <li
            key={f.dedupeKey}
            data-testid="trajectory-finding"
            className={`flex items-start gap-3 rounded-xl border p-3 ${
              f.tone === "info"
                ? "border-slate-200 bg-slate-50/60 dark:border-ink-750 dark:bg-ink-850/40"
                : "border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/30"
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-slate-800 dark:text-slate-100">
                {f.title}
              </p>
              {f.detail && (
                <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                  {f.detail}
                </p>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                {f.evidence && <span>{f.evidence}</span>}
                {f.actionHref && (
                  <Link
                    href={f.actionHref}
                    className="font-medium text-brand-700 hover:underline dark:text-brand-400"
                  >
                    {f.actionLabel ?? "View trend"} →
                  </Link>
                )}
              </div>
            </div>
            {/* Dismiss through the shared suppression store (#39/#41). The key is
                the analyte-level acknowledgment (`biomarker-flag:<family>`, #564),
                so dismissing here silences the analyte's dashboard flag too. */}
            <form
              action={async (fd) => {
                "use server";
                await dismissTrajectory(fd);
              }}
            >
              <input
                type="hidden"
                name="ack_key"
                value={f.supersedes ?? f.dedupeKey}
              />
              <button
                type="submit"
                data-testid="trajectory-dismiss"
                aria-label={`Dismiss ${f.title}`}
                title="Dismiss"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-ink-750 dark:hover:text-slate-300"
              >
                <IconX className="h-4 w-4" stroke={2} />
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
