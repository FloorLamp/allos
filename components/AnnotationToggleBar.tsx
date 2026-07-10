"use client";

import {
  ANNOTATION_KIND_META,
  type AnnotationKind,
} from "@/lib/trend-annotations";

// The per-event-type toggle for the Trends event annotations.
// Presentational + controlled: the parent owns which kinds are enabled
// and re-renders the charts when a pill is clicked. Only the kinds actually present
// in the marker set are offered (a toggle for a kind with no markers is dead
// weight). Each pill doubles as the legend — its dot is the marker color used on
// the charts, so it reads in both light and dark.
export default function AnnotationToggleBar({
  kinds,
  enabled,
  onToggle,
}: {
  kinds: AnnotationKind[];
  enabled: Record<AnnotationKind, boolean>;
  onToggle: (kind: AnnotationKind) => void;
}) {
  if (kinds.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
        Events
      </span>
      {kinds.map((kind) => {
        const meta = ANNOTATION_KIND_META[kind];
        const on = enabled[kind];
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(kind)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
              on
                ? "border-slate-300 bg-white text-slate-700 dark:border-white/15 dark:bg-ink-800 dark:text-slate-200"
                : "border-slate-200 bg-transparent text-slate-400 dark:border-white/10 dark:text-slate-500"
            }`}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{
                background: on ? meta.color : "transparent",
                border: `1.5px solid ${meta.color}`,
              }}
            />
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
