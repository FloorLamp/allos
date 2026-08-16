"use client";

import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import PendingLink, { PendingIconSlot } from "@/components/PendingLink";
import { trainingActivityPageHref } from "@/lib/hrefs";

// The activity page's ledger bar: back to the log, and ‹ older / newer › walking
// the ledger in (date, id) order so a review session continues without bouncing
// back to a list (#2870).
//
// Extracted from the page (a Server Component) so these three can adopt the
// answered tap (#2983) with the ICON-SLOT treatment: each already carries a
// chevron, so the spinner takes the chevron's own box and nothing shifts. That
// is the same shape — and now the same treatment — as the timeline's day arrows,
// which is the surface these are functionally identical to: a stepper whose
// whole purpose is being tapped again, and again, and again. The repeat-tap
// absorption matters more here than the spinner does; walking five activities
// back used to dispatch five navigations and land on the first one that finished.
//
// The icon-slot treatment needs `PendingLink`'s render prop, which cannot cross
// the server/client boundary — hence a client component rather than three
// `PendingTextLink`s inlined on the page.
export default function ActivityLedgerNav({
  olderId,
  newerId,
}: {
  olderId: number | null;
  newerId: number | null;
}) {
  return (
    <div className="mb-4 flex items-center gap-3 text-sm">
      <PendingLink
        href="/training?tab=log"
        label="training log"
        className="inline-flex items-center gap-1 font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        {(pending) => (
          <>
            <PendingIconSlot
              pending={pending}
              size="h-4 w-4"
              icon={<IconChevronLeft className="h-4 w-4" aria-hidden />}
            />
            Training log
          </>
        )}
      </PendingLink>
      <span className="ml-auto flex items-center gap-3">
        {olderId != null && (
          <PendingLink
            href={trainingActivityPageHref(olderId)}
            label="older activity"
            testId="activity-older-link"
            className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400"
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
            href={trainingActivityPageHref(newerId)}
            label="newer activity"
            testId="activity-newer-link"
            className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400"
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
