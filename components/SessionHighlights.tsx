import type { SessionHighlight } from "@/lib/session-detail";
import Link from "next/link";

const TONE_CLASS: Record<SessionHighlight["tone"], string> = {
  neutral:
    "border-slate-300 bg-slate-50/60 dark:border-slate-600 dark:bg-ink-800",
  positive:
    "border-emerald-500 bg-emerald-50/60 dark:border-emerald-400 dark:bg-emerald-950/20",
  caution:
    "border-amber-500 bg-amber-50/60 dark:border-amber-400 dark:bg-amber-950/20",
};

export default function SessionHighlights({
  highlights,
  title = "Session highlights",
}: {
  highlights: SessionHighlight[];
  title?: string;
}) {
  if (highlights.length === 0) return null;
  return (
    <div className="mt-5" data-testid="session-highlights">
      <h3 className="section-label">{title}</h3>
      <ul className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-3">
        {highlights.map((highlight) => (
          <li
            key={highlight.key}
            className={`min-w-0 rounded-lg border-l-2 px-3 py-2.5 ${TONE_CLASS[highlight.tone]}`}
            data-testid={`session-highlight-${highlight.key.replaceAll("_", "-")}`}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
              {highlight.markerColor ? (
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: highlight.markerColor }}
                />
              ) : null}
              {highlight.label}
            </span>
            {highlight.href ? (
              <Link
                href={highlight.href}
                className="mt-0.5 block text-sm font-semibold text-slate-800 hover:text-brand-600 hover:underline dark:text-slate-100 dark:hover:text-brand-400"
              >
                {highlight.value}
              </Link>
            ) : (
              <span className="mt-0.5 block text-sm font-semibold text-slate-800 dark:text-slate-100">
                {highlight.value}
              </span>
            )}
            <span className="mt-0.5 block text-xs leading-4 text-slate-500 dark:text-slate-400">
              {highlight.detail}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
