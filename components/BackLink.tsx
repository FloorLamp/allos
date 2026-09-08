"use client";

import { IconArrowLeft } from "@tabler/icons-react";
import PendingLink, { PendingIconSlot } from "@/components/PendingLink";
import type { AppRoute } from "@/lib/hrefs";

// Navigation with the destination as its visible and accessible name.
export default function BackLink({
  href,
  destination,
  testId,
}: {
  href: AppRoute;
  destination: string;
  testId?: string;
}) {
  return (
    <PendingLink
      href={href}
      label={destination}
      testId={testId}
      className={`inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300`}
    >
      {(pending) => (
        <>
          <PendingIconSlot
            pending={pending}
            size="h-4 w-4"
            icon={
              <IconArrowLeft className="h-4 w-4" stroke={1.75} aria-hidden />
            }
          />
          {destination}
        </>
      )}
    </PendingLink>
  );
}
