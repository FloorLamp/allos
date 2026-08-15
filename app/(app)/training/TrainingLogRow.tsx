"use client";

import { ActivityTypeIcon } from "@/components/ui";
import Avatar from "@/components/Avatar";
import type { TrainingLogCardData } from "@/lib/training-log-card";
import { activityComponentSportNames } from "@/lib/activity-icon";

// The browse surface's slim row (#2897): type glyph, title, the summary line,
// and the multi-view subject chip — everything already computed for the card,
// one row tall. The row OWNS the #activity-N anchor (Telegram history is
// immutable; the deep-link vocabulary lives here now), and its one gesture is
// "open": the reading pane on desktop, expand-in-place on phones — the host
// decides, the row just reports the tap.
export default function TrainingLogRow({
  card,
  selected,
  expanded,
  showSubjectChip,
  onOpen,
}: {
  card: TrainingLogCardData;
  // Highlighted as the reading pane's current record (desktop).
  selected: boolean;
  // Expanded in place below this row (mobile) — the row is also the collapse tap.
  expanded: boolean;
  // Multi-view (#1330): the host says whether this card is a non-acting
  // member's (single view and own cards render no chip).
  showSubjectChip: boolean;
  onOpen: () => void;
}) {
  const { activity, subject } = card;
  const summary = [
    card.timeText,
    card.durationText,
    card.distanceText,
    card.heartRateText,
    card.calorieText,
  ].filter((t): t is string => t != null && t !== "");
  return (
    <button
      type="button"
      id={`activity-${activity.id}`}
      data-testid="training-log-row"
      aria-expanded={expanded}
      onClick={onOpen}
      className={`flex w-full items-center gap-3 rounded-lg border bg-white px-3 py-2 text-left transition scroll-mt-[calc(6rem+env(safe-area-inset-top))] dark:bg-ink-900 ${
        selected || expanded
          ? "border-brand-500 ring-1 ring-brand-500 dark:border-brand-400 dark:ring-brand-400"
          : "border-black/10 hover:border-black/20 dark:border-white/10 dark:hover:border-white/20"
      }`}
    >
      <ActivityTypeIcon
        type={activity.type}
        title={activity.title}
        sportNames={activityComponentSportNames(activity.components)}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-semibold text-slate-800 dark:text-slate-100">
            {activity.title}
          </span>
          {card.fault && (
            <span
              aria-hidden
              title={card.fault}
              data-testid="row-fault-dot"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
            />
          )}
        </span>
        {summary.length > 0 && (
          <span
            data-testid="activity-summary"
            className="mt-0.5 block truncate text-xs text-slate-600 dark:text-slate-300"
          >
            {summary.join(" · ")}
          </span>
        )}
      </span>
      {/* Subject chip on a non-acting member's row (issue #1330): on-element
          identity naming whose activity this is, with a read-only badge when
          the caller can't write to that member — same vocabulary as the card. */}
      {showSubjectChip && subject && (
        <span
          data-testid={`subject-chip-${subject.profileId}`}
          className="flex min-w-0 shrink-0 items-center gap-1 rounded-full border border-black/10 bg-slate-50 py-0.5 pl-0.5 pr-2 text-xs font-medium text-slate-600 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300"
        >
          <Avatar
            profile={{
              id: subject.profileId,
              name: subject.name,
              photo_path: subject.photoPath,
              photo_version: subject.photoVersion,
            }}
            size="sm"
          />
          <span className="max-w-24 truncate">{subject.name}</span>
          {!subject.canWrite && (
            <span className="shrink-0 rounded-full bg-amber-100 px-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              RO
            </span>
          )}
        </span>
      )}
    </button>
  );
}
