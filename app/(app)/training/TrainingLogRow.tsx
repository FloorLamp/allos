"use client";

import { memo } from "react";
import Link from "next/link";
import { ActivityTypeIcon } from "@/components/ui";
import Avatar from "@/components/Avatar";
import type { TrainingLogCardData } from "@/lib/training-log-card";
import {
  activityComponentSportNames,
  activityComponentsHaveCompositeIconIdentity,
} from "@/lib/activity-icon";
import { trainingActivityPageHref } from "@/lib/hrefs";
import ActivityPartRows from "@/components/activity/ActivityPartRows";
import ActivitySummaryLine from "@/components/activity/ActivitySummaryLine";

const LOG_ROW_PART_LIMIT = 3;

// The browse surface's compact index row (#2897): identity and primary summary
// on the left, then a capped rendering of the same activity parts and supporting
// facts the canonical record receives. It owns the #activity-N anchor (Telegram
// history is immutable; the deep-link vocabulary lives here now) and links to
// the activity's canonical read page at every viewport.
//
// Memoized because paging and filter changes can retain a large loaded window.
//
// The row's testids are -row suffixed to distinguish index summaries from the
// richer values on the destination page.
function TrainingLogRow({
  card,
  showSubjectChip,
  onFilterTag,
}: {
  card: TrainingLogCardData;
  // Multi-view (#1330): the host says whether this card is a non-acting
  // member's (single view and own cards render no chip).
  showSubjectChip: boolean;
  onFilterTag: (kind: "muscle" | "region", value: string) => void;
}) {
  const { activity, subject } = card;
  const parts = card.parts.slice(0, LOG_ROW_PART_LIMIT);
  const remainingParts = Math.max(0, card.parts.length - parts.length);
  const hasParts = parts.length > 0;
  const supportingDetails = [
    // Primary measurements already live in the shared summary above. Only
    // disclose facts that summary cannot carry; imported analysis belongs on
    // the activity page.
    card.gear ? `Gear: ${card.gear}` : null,
    card.routePolyline ? "Route recorded" : null,
  ].filter((detail): detail is string => detail != null);
  const hasDetails = parts.length > 0 || supportingDetails.length > 0;
  return (
    <div
      id={`activity-${activity.id}`}
      data-testid="training-log-row"
      className="group relative grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 border-b border-black/10 px-2 py-3 text-left transition scroll-mt-[calc(6rem+env(safe-area-inset-top))] hover:bg-brand-50/40 lg:px-3 dark:border-white/10 dark:hover:bg-brand-950/20"
    >
      <ActivityTypeIcon
        type={activity.type}
        title={activity.title}
        sportNames={activityComponentSportNames(activity.components)}
        composite={activityComponentsHaveCompositeIconIdentity(
          activity.components
        )}
      />
      <div className="min-w-0 max-w-5xl">
        <span className="flex items-center gap-2">
          <Link
            href={trainingActivityPageHref(
              activity.id,
              showSubjectChip ? activity.subjectProfileId : undefined
            )}
            className="truncate font-semibold text-slate-800 transition-colors before:absolute before:inset-0 group-hover:text-brand-600 dark:text-slate-100 dark:group-hover:text-brand-400"
          >
            {activity.title}
          </Link>
          {card.fault && (
            <span
              role="img"
              // Deliberately avoids the word "saved": Playwright's getByLabel
              // matches accessible names by case-insensitive SUBSTRING, and the
              // autosave indicator's spec asserts `getByLabel("Saved")` has no
              // matches after a failed save (#332). An accessible name is part
              // of the page's contract with every reader, tests included.
              aria-label={`Editor can’t re-save this as-is: ${card.fault}`}
              title={card.fault}
              data-testid="row-fault-dot"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
            />
          )}
        </span>
        <ActivitySummaryLine
          timeText={card.timeText}
          durationText={card.durationText}
          distanceText={card.distanceText}
          speedText={card.speedText}
          heartRateText={card.heartRateText}
          relativeEffort={activity.imported_metrics?.relative_effort}
          relativeEffortProvider={card.provenance.label}
          calorieText={card.calorieText}
          intensity={activity.intensity}
          heartRateZone={activity.heart_rate_zone}
          testId="activity-summary-row"
        />
        {hasDetails && (
          <div className="mt-1.5 min-w-0">
            {hasParts && (
              <ActivityPartRows
                parts={parts}
                remainingParts={remainingParts}
                density="compact"
                onFilterTag={onFilterTag}
              />
            )}
            {supportingDetails.length > 0 && (
              <ul
                data-testid="training-log-supporting-details"
                className={`${hasParts ? "mt-1" : ""} flex flex-wrap text-xs text-slate-500 dark:text-slate-400`}
              >
                {supportingDetails.map((detail, index) => (
                  <li key={`${detail}-${index}`} className="whitespace-nowrap">
                    {index > 0 && (
                      <span aria-hidden className="mx-1.5">
                        ·
                      </span>
                    )}
                    {detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {/* Subject chip on a non-acting member's row (issue #1330): on-element
          identity naming whose activity this is, with a read-only badge when
          the caller can't write to that member — same vocabulary as the card. */}
      {showSubjectChip && subject && (
        <span
          data-testid={`subject-chip-${subject.profileId}-row`}
          className="col-start-2 mt-2 flex min-w-0 shrink-0 items-center gap-1 justify-self-start rounded-full border border-black/10 bg-slate-50 py-0.5 pl-0.5 pr-2 text-xs font-medium text-slate-600 sm:col-start-3 sm:row-start-1 sm:mt-0 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300"
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
    </div>
  );
}

export default memo(TrainingLogRow);
