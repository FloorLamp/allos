"use client";

import type { PracticeLog } from "@/lib/types";
import { formatUsageSummary } from "@/lib/usage-format";
import PracticeSessionHistory from "./PracticeSessionHistory";

export default function PracticeHistorySection({
  title,
  sessions,
  sessionCount,
  lastUsed,
  today,
  emptyText,
  usageTestId,
}: {
  title: string;
  sessions: PracticeLog[];
  sessionCount: number;
  lastUsed: string | null;
  today: string;
  emptyText: string;
  usageTestId: string;
}) {
  return (
    <div>
      <div className="section-label">{title}</div>
      {sessionCount > 0 && (
        <p
          className="mt-0.5 text-sm text-slate-600 dark:text-slate-300"
          data-testid={usageTestId}
        >
          {formatUsageSummary(sessionCount, lastUsed, today)}
        </p>
      )}
      <PracticeSessionHistory
        sessions={sessions}
        totalCount={sessionCount}
        emptyText={emptyText}
      />
    </div>
  );
}
