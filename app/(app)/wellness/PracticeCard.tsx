"use client";

import { useState } from "react";
import { IconPencil } from "@tabler/icons-react";
import LogPracticeButton from "@/app/(app)/protocols/LogPracticeButton";
import { practiceCadenceText, PRACTICE_PLENTY_TEXT } from "@/lib/practice";
import { formatUsageSummary } from "@/lib/usage-format";
import type { PracticeLog } from "@/lib/types";
import type { WellnessPractice } from "@/lib/practice-store";
import PracticeEditor from "./PracticeEditor";
import PracticeSessionHistory from "./PracticeSessionHistory";

export default function PracticeCard({
  practice,
  sessions,
  today,
}: {
  practice: WellnessPractice;
  sessions: PracticeLog[];
  today: string;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <article className="card space-y-4" data-testid="wellness-practice-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            {practice.name}
          </h2>
          {practice.perWeek != null ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                {practice.countThisWeek} /{" "}
                {practiceCadenceText(practice.perWeek, practice.perWeekMax)}
              </span>{" "}
              this week
              {practice.atCeiling ? ` · ${PRACTICE_PLENTY_TEXT}` : ""}
            </p>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Session history without a weekly target
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setEditing((value) => !value)}
          className="btn-ghost inline-flex items-center gap-1.5"
          data-testid="wellness-practice-edit"
        >
          <IconPencil className="h-4 w-4" stroke={1.75} />
          {practice.targetId == null ? "Set target" : "Edit"}
        </button>
      </div>

      {editing && (
        <PracticeEditor
          compact
          targetId={practice.targetId}
          name={practice.name}
          perWeek={practice.perWeek ?? 3}
          perWeekMax={practice.perWeekMax}
          onDone={() => setEditing(false)}
        />
      )}

      <LogPracticeButton
        practice={practice.name}
        todayCount={sessions.filter((session) => session.date === today).length}
        atCeiling={practice.atCeiling}
        today={today}
        defaultDurationMin={practice.previousDurationMin}
        showDetails
      />

      <div>
        <div className="section-label">All sessions</div>
        <p
          className="mt-0.5 text-sm text-slate-600 dark:text-slate-300"
          data-testid="wellness-practice-usage"
        >
          {formatUsageSummary(practice.sessionCount, practice.lastUsed, today)}
        </p>
        <PracticeSessionHistory
          sessions={sessions}
          emptyText="No sessions logged yet."
        />
      </div>
    </article>
  );
}
