import type { FrequencyPace } from "@/lib/goals";

// One weekly frequency target's progress, normalized for display.
export interface WeeklyTarget {
  id?: number;
  label: string;
  count: number;
  perWeek: number;
  met: boolean;
  // Paced status (#748 item 3). When supplied it drives the chip's colour so the
  // dashboard agrees with the /nutrition Weekly-habits badge (one computation:
  // getFrequencyTargetProgress). Optional so surfaces that predate pacing render
  // unchanged from the met/count fallback below.
  pace?: FrequencyPace;
}

// The canonical weekly-target chip: a labelled row of squares (one per weekly
// rep, filled by sessions logged) inside a status-coloured border. When `pace` is
// given: emerald = met, sky = on pace, amber = behind. Without it, the legacy
// met/count colouring (emerald = met, amber = in progress, rose = not started).
// Becomes a button when `onClick` is given (e.g. to select it for editing).
export function WeeklyTargetChip({
  target: { label, count, perWeek, met, pace },
  onClick,
  selected,
}: {
  target: WeeklyTarget;
  onClick?: () => void;
  selected?: boolean;
}) {
  const border = pace
    ? pace === "met"
      ? "border-emerald-400 dark:border-emerald-700"
      : pace === "on-pace"
        ? "border-sky-400 dark:border-sky-700"
        : "border-amber-400 dark:border-amber-600"
    : met
      ? "border-emerald-400 dark:border-emerald-700"
      : count > 0
        ? "border-amber-400 dark:border-amber-600"
        : "border-rose-400 dark:border-rose-800";
  const base = `flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${border}`;
  const inner = (
    <>
      <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
        {label}
      </span>
      <span className="flex gap-1">
        {Array.from({ length: Math.max(1, perWeek) }).map((_, j) => (
          <span
            key={j}
            className={`h-3 w-3 rounded-sm ${
              j < count
                ? pace
                  ? pace === "met"
                    ? "bg-emerald-500"
                    : pace === "on-pace"
                      ? "bg-sky-400"
                      : "bg-amber-400"
                  : met
                    ? "bg-emerald-500"
                    : "bg-amber-400"
                : "bg-slate-300 dark:bg-ink-700"
            }`}
          />
        ))}
      </span>
    </>
  );
  const title = `${label}: ${count}/${perWeek} this week`;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`${title} — click to edit`}
        className={`${base} cursor-pointer transition ${
          selected
            ? "ring-2 ring-brand-500 ring-offset-2 ring-offset-white dark:ring-offset-ink-950"
            : "hover:border-brand-400 dark:hover:border-brand-600"
        }`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div title={title} className={base}>
      {inner}
    </div>
  );
}

// A wrapping row of target chips, ordered least-completed first so the targets
// that still need attention lead. When `onSelect` is given each chip is
// clickable, and the chip whose id matches `selectedId` is highlighted.
export function WeeklyTargets({
  targets,
  onSelect,
  selectedId,
}: {
  targets: WeeklyTarget[];
  onSelect?: (t: WeeklyTarget) => void;
  selectedId?: number | null;
}) {
  const sorted = [...targets].sort(
    (a, b) =>
      a.count / Math.max(1, a.perWeek) - b.count / Math.max(1, b.perWeek)
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {sorted.map((t, i) => (
        <WeeklyTargetChip
          key={t.id ?? i}
          target={t}
          onClick={onSelect ? () => onSelect(t) : undefined}
          selected={t.id != null && t.id === selectedId}
        />
      ))}
    </div>
  );
}
