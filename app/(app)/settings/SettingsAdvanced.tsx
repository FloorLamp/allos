import type { ReactNode } from "react";
import RememberedDetails from "@/components/RememberedDetails";

// The per-group "Advanced" fold (#1462 §3). Niche, one-time settings — a home
// location you set once, a Fitzpatrick skin type, a per-profile crisis-resources
// override — used to sit at equal rank with the settings people revisit, which is
// most of what made the old Profile page a scroll wall. They now live behind this
// collapsed-by-default disclosure at the END of their group page.
//
// Still a native <details> (it opens with JS disabled, and browser in-page find still
// auto-expands it), but no longer stateless: since #2652 behavior 3 it REMEMBERS its
// open state PER DEVICE, and per group. Somebody who is working in one group's Advanced
// settings is working in it across several visits; re-opening the same fold each time is
// friction with no information in it. The state is localStorage, never a settings row —
// lib/disclosure-memory.ts carries the full reasoning for that tier choice.
//
// Instanced by `testId`, so the Notifications group's Advanced fold and the Units
// group's are remembered apart.
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
    <RememberedDetails
      id="settings-group"
      instance={testId}
      className="mt-6 group"
      testId={testId}
      summary={
        <summary className="fold-control list-none rounded-lg px-1 text-sm font-medium text-slate-600 marker:content-none hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100">
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
      }
    >
      <div className="mt-2 space-y-6">{children}</div>
    </RememberedDetails>
  );
}
