"use client";

import { useState, type ReactNode } from "react";
import { IconCalendarStats, IconSparkles } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import InsightLauncher from "@/components/InsightLauncher";

type OpenPanel = "patterns" | "suggestions" | null;

// Compact launchers for secondary supplement coaching. Like Food's lab suggestions,
// both open in a modal so inspecting them never shifts the schedule or its sidebar.
export default function SupplementInsightBadges({
  patternCount,
  suggestionCount,
  patterns,
  suggestions,
}: {
  patternCount: number;
  suggestionCount: number;
  patterns: ReactNode;
  suggestions: ReactNode;
}) {
  const [open, setOpen] = useState<OpenPanel>(null);

  return (
    <section data-testid="supplement-insights">
      <div className="space-y-3">
        {patternCount > 0 && (
          <InsightLauncher
            label="Patterns"
            count={patternCount}
            icon={<IconCalendarStats className="h-3.5 w-3.5" stroke={2} />}
            tone="violet"
            controls="supplement-patterns-panel"
            testId="supplement-patterns-badge"
            onClick={() => setOpen("patterns")}
          />
        )}
        <InsightLauncher
          label="Suggestions"
          count={suggestionCount}
          icon={<IconSparkles className="h-3.5 w-3.5" stroke={2} />}
          tone="emerald"
          controls="supplement-suggestions-panel"
          testId="supplement-suggestions-badge"
          onClick={() => setOpen("suggestions")}
        />
      </div>

      {open === "patterns" && (
        <ModalShell
          title="Patterns"
          onClose={() => setOpen(null)}
          className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col rounded-xl bg-white p-4 shadow-xl outline-hidden sm:p-5 dark:bg-ink-900"
        >
          <div
            id="supplement-patterns-panel"
            data-testid="supplement-patterns-panel"
            className="mt-4 min-h-0 overflow-y-auto pr-1"
          >
            {patterns}
          </div>
        </ModalShell>
      )}
      {open === "suggestions" && (
        <ModalShell
          title="Suggestions"
          onClose={() => setOpen(null)}
          className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col rounded-xl bg-white p-4 shadow-xl outline-hidden sm:p-5 dark:bg-ink-900"
        >
          <div
            id="supplement-suggestions-panel"
            data-testid="supplement-suggestions-panel"
            className="mt-4 min-h-0 overflow-y-auto pr-1"
          >
            {suggestions}
          </div>
        </ModalShell>
      )}
    </section>
  );
}
