"use client";

import FactChipRow, {
  FactAddChip,
  FactChip,
} from "@/components/facts/FactChipRow";
import type {
  ActivitySessionFactKey,
  ActivitySessionFactSummary,
} from "@/lib/activity-session-facts";

// The session-level summary row of the activity editor (#3334), in the shared
// facts-with-editors grammar (#3218). Everything about how a chip looks, announces
// itself and discloses its editor lives in `components/facts/FactChipRow`; this file
// supplies only which facts this section states, in what order.
//
// NO "MORE" AFFORDANCE HERE. The trailing chip holds optional facts with nothing to
// state, and this row's one optional fact keeps its own standing "+ equipment" prompt
// instead — a prompt is the right shape while there is exactly one of them. The day a
// second and third session fact land behind it (#3228), that prompt becomes the
// trailing affordance's contents and this row grows one.
//
// THE ROW IS STILL THE FOCUS FLOOR EITHER WAY: with no `[data-fact-more]` here,
// useFactEditor's third tier is the tier that answers when a fact leaves the row, which
// is exactly the combination the primitive's source-scan calls the queued adopters'
// floor. Today no fact can leave — "+ equipment" persists after equipment is cleared —
// so tier one always answers; the floor is there for when that stops being true.

export default function ActivitySessionFactRow({
  summary,
  openEditor,
  onOpen,
}: {
  summary: ActivitySessionFactSummary;
  openEditor: ActivitySessionFactKey | null;
  onOpen: (key: ActivitySessionFactKey) => void;
}) {
  return (
    <FactChipRow testId="activity-session-fact-row">
      {summary.chips.map((chip) =>
        chip.state === "add" ? (
          <FactAddChip
            key={chip.key}
            testId={`activity-fact-${chip.key}`}
            // One chip, one panel on this surface, so the chip's focus identity is
            // its fact key (#3311).
            focusKey={chip.key}
            label={chip.label}
            expanded={openEditor === chip.key}
            onOpen={() => onOpen(chip.key)}
          />
        ) : (
          <FactChip
            key={chip.key}
            testId={`activity-fact-${chip.key}`}
            focusKey={chip.key}
            label={chip.label}
            state="stated"
            expanded={openEditor === chip.key}
            onOpen={() => onOpen(chip.key)}
            // `data-suggested` is the primitive's; this surface adds no marker of its
            // own. Only the wording is ours, and "last used" is not "from your usual".
            suggested={chip.suggested}
            badge={
              chip.suggested && (
                <span className="ml-1.5 text-xs font-medium text-brand-700 dark:text-brand-300">
                  last used
                </span>
              )
            }
          />
        )
      )}
    </FactChipRow>
  );
}
