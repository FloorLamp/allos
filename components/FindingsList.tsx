import Link from "next/link";
import { IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { Finding } from "@/lib/findings";

// Shared presentational list for the page-level, dismissible observational findings
// (issue #45, domains 4–6) — the training-balance, body-hygiene, and goal-pacing
// cards all render through this one component so their markup can't drift (the
// AGENTS.md "shared content component" rule). It generalizes the inline markup that
// TrajectoryFindings.tsx first established. Each card shows title/detail, an optional
// evidence line + action link, and a dismiss button posting to the surface's own
// namespace-guarded server action (passed in as `dismissAction`). Renders nothing
// when there are no findings.
export default function FindingsList({
  findings,
  dismissAction,
  heading,
  subtitle,
  icon,
  testid,
}: {
  findings: Finding[];
  // The surface's dismiss server action (guards its own dedupeKey namespace).
  dismissAction: (formData: FormData) => void | Promise<void>;
  heading: string;
  subtitle: string;
  icon: ReactNode;
  // data-testid for the container; each finding row is `${testid}-item`, each
  // dismiss button `${testid}-dismiss`.
  testid: string;
}) {
  if (findings.length === 0) return null;
  return (
    <div className="card" data-testid={testid}>
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
        {icon}
        {heading}
      </h2>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        {subtitle}
      </p>
      <ul className="space-y-3">
        {findings.map((f) => (
          <li
            key={f.dedupeKey}
            data-testid={`${testid}-item`}
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
                    {f.actionLabel ?? "View"} →
                  </Link>
                )}
              </div>
            </div>
            {/* Dismiss through the shared findings-bus suppression store (#39/#45). */}
            <form action={dismissAction}>
              <input type="hidden" name="dedupe_key" value={f.dedupeKey} />
              <button
                type="submit"
                data-testid={`${testid}-dismiss`}
                aria-label={`Dismiss ${f.title}`}
                title="Dismiss"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-ink-750 dark:hover:text-slate-300"
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
