"use client";

import FactChipRow, { FactChip } from "@/components/facts/FactChipRow";
import type { SleepFactKey, SleepFactSummary } from "@/lib/sleep-facts";

// The summary row of the manual sleep-and-mood entry (#3222), in the shared
// facts-with-editors grammar (#3218). Everything about how a chip looks, announces
// itself and discloses its editor lives in `components/facts/FactChipRow`; this file
// supplies only this dialog's own facts — which ones, in what order, and what each says.
//
// NO "MORE" AFFORDANCE HERE, and that is not an omission. The trailing chip exists to
// hold OPTIONAL facts with nothing to state; this dialog has three facts and the two it
// can write are the reason it opened, so an absent duration or mood is a missing
// essential — a dashed prompt — rather than something to tuck away.

export default function SleepFactRow({
  summary,
  openEditor,
  onOpen,
}: {
  summary: SleepFactSummary;
  openEditor: SleepFactKey | null;
  onOpen: (key: SleepFactKey) => void;
}) {
  return (
    <FactChipRow testId="sleep-fact-row">
      {summary.chips.map((chip) => (
        <FactChip
          key={chip.key}
          testId={`sleep-fact-${chip.key}`}
          label={chip.label}
          state={chip.state}
          expanded={openEditor === chip.key}
          onOpen={() => onOpen(chip.key)}
          // `data-suggested` is the primitive's, so this surface adds no marker of its
          // own — a per-consumer testid is the convention the third surface forgets.
          // Only the wording is ours.
          suggested={chip.suggested}
          badge={
            chip.suggested && (
              <span className="ml-1.5 text-xs font-medium text-brand-700 dark:text-brand-300">
                from your usual
              </span>
            )
          }
        />
      ))}
    </FactChipRow>
  );
}
