import {
  type FrequencyPace,
  type PaceTone,
  PACE_BORDER_CLASS,
  PACE_FILL_CLASS,
} from "@/lib/goals";

// One weekly frequency target's progress, normalized for display.
export interface WeeklyTarget {
  id?: number;
  label: string;
  count: number;
  perWeek: number;
  met: boolean;
  // Paced status (#748 item 3 / #760). When supplied it drives the chip's tone so
  // every surface agrees (one computation: getFrequencyTargetProgress). Optional so
  // a caller with no pace data falls back to the legacy met/count colouring below.
  pace?: FrequencyPace;
}

// The chip's pace verdict as a shared PaceTone (#780). With a paced `pace` (every LIVE
// call site passes it — guarded by pace-chip-wiring.test.ts) the tone IS that
// FrequencyPace, so a chip is never "failed"/rose: a recurring week resets rather than
// fails. Only the LEGACY met/count fallback (a caller with no pace data — none of the
// live four) can reach the old not-started rose, kept solely for backward compat.
function chipTone(met: boolean, count: number, pace?: FrequencyPace): PaceTone {
  if (pace) return pace;
  return met ? "met" : count > 0 ? "behind" : "failed";
}

// The canonical weekly-target chip: a labelled row of squares (one per weekly rep,
// filled by sessions logged) inside a pace-coloured border. Border AND square-fill
// format over the ONE shared tone→class map (#780): emerald = met, brand = on pace,
// amber = behind (never rose for a paced week). Becomes a button when `onClick` is
// given (e.g. to select it for editing).
export function WeeklyTargetChip({
  target: { label, count, perWeek, met, pace },
  onClick,
  selected,
}: {
  target: WeeklyTarget;
  onClick?: () => void;
  selected?: boolean;
}) {
  const tone = chipTone(met, count, pace);
  const base = `flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${PACE_BORDER_CLASS[tone]}`;
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
              j < count ? PACE_FILL_CLASS[tone] : "bg-slate-300 dark:bg-ink-700"
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
        data-testid="weekly-target-chip"
        data-tone={tone}
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
    <div
      title={title}
      data-testid="weekly-target-chip"
      data-tone={tone}
      className={base}
    >
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
