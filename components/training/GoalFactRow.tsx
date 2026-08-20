"use client";

import FactChipRow, {
  FactAddChip,
  FactChip,
  FactMoreChip,
} from "@/components/facts/FactChipRow";
import {
  moreGoalFactsLabel,
  type GoalFactKey,
  type GoalFactSummary,
} from "@/lib/goal-facts";

// The summary row of the training-goal form (#3220), in the shared
// facts-with-editors grammar (#3218). Everything about how a chip looks, announces
// itself and discloses its editor lives in `components/facts/FactChipRow`; this file
// supplies only this form's own facts — which ones, in what order, and which
// affordance each becomes.
//
// WHICH PANELS EXIST is a superset of the fact keys: `more` is the trailing
// affordance's own panel, a MENU of the absent optionals rather than an editor, so
// that opening it still leaves exactly one editor on screen (the intake form's
// shape, #3216).
export type GoalOpenPanel = GoalFactKey | "more";

export default function GoalFactRow({
  summary,
  openEditor,
  onOpen,
}: {
  summary: GoalFactSummary;
  openEditor: GoalOpenPanel | null;
  onOpen: (key: GoalOpenPanel, focusKey: string) => void;
}) {
  return (
    <FactChipRow testId="goal-fact-row">
      {/* THE PROMPT AND THE SUBJECT CHIP SHARE ONE FOCUS KEY, on purpose. They are
          the same fact at two states, and the prompt does NOT persist once a subject
          is picked — so after picking, focus has to land on the chip that replaced
          it rather than on a control that is no longer there (#3311). */}
      {summary.subjectAbsent && (
        <FactAddChip
          testId="goal-fact-add-subject"
          focusKey="subject"
          label="what to track"
          expanded={openEditor === "subject"}
          onOpen={(focusKey) => onOpen("subject", focusKey)}
        />
      )}
      {summary.chips.map((chip) => (
        <FactChip
          key={chip.key}
          testId={`goal-fact-${chip.key}`}
          // One chip, one panel here, so this surface never has to tell the two keys
          // apart: the chip's focus identity is its fact key (#3311).
          focusKey={chip.key}
          label={chip.label}
          state={chip.state}
          suggested={chip.suggested}
          expanded={openEditor === chip.key}
          onOpen={(focusKey) => onOpen(chip.key, focusKey)}
        />
      ))}
      {summary.more.length > 0 && (
        <FactMoreChip
          testId="goal-fact-more"
          focusKey="more"
          label={moreGoalFactsLabel(summary.more)}
          expanded={openEditor === "more"}
          onOpen={(focusKey) => onOpen("more", focusKey)}
        />
      )}
    </FactChipRow>
  );
}
