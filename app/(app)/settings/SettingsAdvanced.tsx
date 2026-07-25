import type { ReactNode } from "react";

// The per-group "Advanced" fold (#1462 §3). Niche, one-time settings — a home
// location you set once, a Fitzpatrick skin type, a per-profile crisis-resources
// override — used to sit at equal rank with the settings people revisit, which is
// most of what made the old Profile page a scroll wall. They now live behind this
// collapsed-by-default disclosure at the END of their group page.
//
// Deliberately STATELESS: a native <details>, so it needs no client component, no
// stored open/closed preference, and it still opens with JS disabled. Browser
// in-page find also auto-expands it.
export default function SettingsAdvanced({
  children,
  testId = "settings-advanced",
  summary = "Advanced",
  hint,
}: {
  children: ReactNode;
  testId?: string;
  summary?: string;
  hint?: string;
}) {
  return (
    <details className="mt-6 group" data-testid={testId}>
      <summary className="cursor-pointer list-none rounded-lg px-1 py-2 text-sm font-medium text-slate-600 marker:content-none hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100">
        <span
          aria-hidden
          className="mr-1 inline-block transition-transform group-open:rotate-90"
        >
          ›
        </span>
        {summary}
        {hint && (
          <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
            {hint}
          </span>
        )}
      </summary>
      <div className="mt-2 space-y-6">{children}</div>
    </details>
  );
}
