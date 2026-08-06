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
  inlineDuration = false,
  usualSessionDay = false,
}: {
  practice: ProtocolPractice;
  ongoing: boolean;
  todayCount?: number;
  atCeiling?: boolean;
  // The acting profile's today (YYYY-MM-DD) — see LogPracticeButton.
  today: string;
  defaultDurationMin?: number | null;
  showDetails?: boolean;
  // Render the inline duration stepper on the practice scope (#2204, owner ruling).
  // This was the LAST one-tap practice log that silently discarded the duration: the
  // detail page had the expanded form beside it and the dashboard widget had nothing
  // at all, and in both cases the tap wrote a session with no duration for a domain
  // where "20 min sauna" vs "5 min" is most of the meaning. Passed straight through —
  // the shared button routes both the render and the write through one `stepperShown`
  // expression, so this surface cannot post a value that is not on screen either.
  //
  // Only meaningful for the "practice" scope; the activity/food actions below open
  // their own full forms, which have always asked for what they record.
  inlineDuration?: boolean;
  // Whether today is an inferred rhythm day for the wellness practice (#2188) —
  // see LogPracticeButton. Only meaningful for the "practice" scope.
  usualSessionDay?: boolean;
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
        inlineDuration={inlineDuration}
        usualSessionDay={usualSessionDay}
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
