"use client";

import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import PendingLink, {
  PendingIconSlot,
  PendingOverlay,
} from "@/components/PendingLink";
import {
  cyclingRideHref,
  trainingActivityPageHref,
  type AppRoute,
  type CyclingLens,
} from "@/lib/hrefs";

const LEDGER_LINK_CLASS =
  "inline-flex items-center gap-1 font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white";

// The activity page's one navigation bar: return destinations on the left and
// ‹ older / newer › walking the ledger in (date, id) order on the right (#2870).
// Cycling contributes its overview destination here instead of mounting another
// back-link row inside its detail content.
//
// Extracted from the page (a Server Component) so every destination can adopt
// the answered tap (#2983). Chevron links use the icon-slot treatment; the text
// context link uses the overlay treatment so neither shape shifts while pending.
export default function ActivityLedgerNav({
  olderId,
  newerId,
  lens = null,
  subjectProfileId,
  trainingRelevant = true,
  contextLink,
}: {
  olderId: number | null;
  newerId: number | null;
  lens?: CyclingLens | null;
  subjectProfileId?: number;
  trainingRelevant?: boolean;
  contextLink?: { href: AppRoute; label: string } | null;
}) {
  const activityHref = (id: number) =>
    lens
      ? cyclingRideHref(id, lens, subjectProfileId)
      : trainingActivityPageHref(id, subjectProfileId);

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
      data-testid="activity-ledger-navigation"
    >
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <PendingLink
          href={trainingRelevant ? "/training?tab=log" : "/timeline"}
          label={trainingRelevant ? "training log" : "timeline"}
          className={LEDGER_LINK_CLASS}
        >
          {(pending) => (
            <>
              <PendingIconSlot
                pending={pending}
                size="h-4 w-4"
                icon={<IconChevronLeft className="h-4 w-4" aria-hidden />}
              />
              {trainingRelevant ? "Training log" : "Timeline"}
            </>
          )}
        </PendingLink>
        {contextLink ? (
          <>
            <span aria-hidden className="text-slate-300 dark:text-slate-600">
              /
            </span>
            <PendingLink
              href={contextLink.href}
              label={contextLink.label}
              testId="ride-cycling-overview-link"
              className={LEDGER_LINK_CLASS}
            >
              {(pending) => (
                <PendingOverlay pending={pending}>
                  {contextLink.label}
                </PendingOverlay>
              )}
            </PendingLink>
          </>
        ) : null}
      </span>
      <span className="ml-auto flex items-center gap-3">
        {olderId != null && (
          <PendingLink
            href={activityHref(olderId)}
            label="older activity"
            testId="activity-older-link"
            className={LEDGER_LINK_CLASS}
          >
            {(pending) => (
              <>
                <PendingIconSlot
                  pending={pending}
                  size="h-4 w-4"
                  icon={<IconChevronLeft className="h-4 w-4" aria-hidden />}
                />
                Older
              </>
            )}
          </PendingLink>
        )}
        {newerId != null && (
          <PendingLink
            href={activityHref(newerId)}
            label="newer activity"
            testId="activity-newer-link"
            className={LEDGER_LINK_CLASS}
          >
            {(pending) => (
              <>
                Newer
                <PendingIconSlot
                  pending={pending}
                  size="h-4 w-4"
                  icon={<IconChevronRight className="h-4 w-4" aria-hidden />}
                />
              </>
            )}
          </PendingLink>
        )}
      </span>
    </div>
  );
}
