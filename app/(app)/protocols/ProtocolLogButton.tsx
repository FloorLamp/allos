"use client";

import { IconCheck } from "@tabler/icons-react";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { useQuickEntry } from "@/components/QuickEntryProvider";
import LogPracticeButton from "@/components/practices/LogPracticeButton";
import type { ProtocolPractice } from "@/lib/queries/protocols";
import { protocolLogAction } from "@/lib/protocol-log-action";

// One shared scope-aware protocol action (#1584), used on both the detail page
// and dashboard. It reaches the existing activity editor, food logger, or
// wellness-practice action and disappears for ended protocols (#1592).
export default function ProtocolLogButton({
  practice,
  ongoing,
  todayCount = 0,
  atCeiling = false,
  today,
  defaultDurationMin = null,
  showDetails = false,
}: {
  practice: ProtocolPractice;
  ongoing: boolean;
  todayCount?: number;
  atCeiling?: boolean;
  // The acting profile's today (YYYY-MM-DD) — see LogPracticeButton.
  today: string;
  defaultDurationMin?: number | null;
  showDetails?: boolean;
}) {
  const activityEditor = useActivityEditor();
  const quickEntry = useQuickEntry();
  if (!ongoing) return null;

  const action = protocolLogAction(practice.scopeKind, practice.value);
  if (!action) return null;

  if (action.kind === "practice") {
    return (
      <LogPracticeButton
        practice={action.practice}
        todayCount={todayCount}
        atCeiling={atCeiling}
        today={today}
        defaultDurationMin={defaultDurationMin}
        showDetails={showDetails}
      />
    );
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        data-testid="protocol-log-button"
        onClick={() => {
          if (action.kind === "activity") {
            activityEditor.openCreate({ type: action.type });
          } else {
            quickEntry.open("food", { foodGroup: action.foodGroup });
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white"
      >
        <IconCheck className="h-4 w-4" stroke={2} aria-hidden />
        {action.label}
      </button>
    </div>
  );
}
