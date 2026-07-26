import Link from "next/link";
import { IconX } from "@tabler/icons-react";
import type { Finding } from "@/lib/findings";

// ONE finding row — title/detail, the optional evidence + action line, and the
// dismiss button posting to the surface's own namespace-guarded server action.
//
// Extracted out of FindingsList (issue #1496) so a surface that needs a DIFFERENT
// list SHAPE still renders the same ROW: the Training → Overview rollup folds the
// per-muscle volume findings into one expandable group row, and the findings inside
// it must stay byte-identical to the flat cards elsewhere — same markup, same
// dismiss affordance, same `dedupeKey` posted to the same bus (the AGENTS.md
// "shared content component" rule; hand-mirrored row markup is exactly what drifts).
export default function FindingRow({
  finding: f,
  dismissAction,
  itemTestid,
  dismissTestid,
}: {
  finding: Finding;
  // The surface's dismiss server action (guards its own dedupeKey namespace).
  dismissAction: (formData: FormData) => void | Promise<void>;
  itemTestid: string;
  dismissTestid: string;
}) {
  return (
    <li
      data-testid={itemTestid}
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
          data-testid={dismissTestid}
          aria-label={`Dismiss ${f.title}`}
          title="Dismiss"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-ink-750 dark:hover:text-slate-300"
        >
          <IconX className="h-4 w-4" stroke={2} />
        </button>
      </form>
    </li>
  );
}
