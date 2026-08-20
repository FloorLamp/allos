"use client";

import FactChipRow, {
  FactAddChip,
  FactChip,
  FactMoreChip,
} from "@/components/facts/FactChipRow";
import {
  moreProtocolFactsLabel,
  type ProtocolFactKey,
  type ProtocolFactSummary,
} from "@/lib/protocol-facts";

// The summary row of the protocol form (#3219), in the shared facts-with-editors
// grammar (#3218). Everything about how a chip looks, announces itself and discloses
// its editor lives in `components/facts/FactChipRow`; this file supplies only this
// form's own facts — which ones, in what order, and which affordance each becomes.
//
// WHICH PANELS EXIST is a superset of the fact keys: `more` is the trailing affordance's
// own panel, a MENU of the absent optionals rather than an editor, so that opening it
// still leaves exactly one editor on screen (the intake form's shape, #3216).
export type ProtocolOpenPanel = ProtocolFactKey | "more";

export default function ProtocolFactRow({
  summary,
  openEditor,
  onOpen,
}: {
  summary: ProtocolFactSummary;
  openEditor: ProtocolOpenPanel | null;
  onOpen: (key: ProtocolOpenPanel, focusKey: string) => void;
}) {
  return (
    <FactChipRow testId="protocol-fact-row" className="sm:col-span-2">
      {/* THE PROMPT AND THE PRACTICE CHIP SHARE ONE FOCUS KEY, on purpose. They are the
          same fact at two states, and the prompt does NOT persist once a practice is
          picked — so after picking, focus has to land on the chip that replaced it
          rather than on a control that is no longer there (#3311). */}
      {summary.practiceAbsent && (
        <FactAddChip
          testId="protocol-fact-add-practice"
          focusKey="practice"
          label="practice"
          expanded={openEditor === "practice"}
          onOpen={(focusKey) => onOpen("practice", focusKey)}
        />
      )}
      {summary.chips.map((chip) => (
        <FactChip
          key={chip.key}
          testId={`protocol-fact-${chip.key}`}
          // One chip, one panel here, so this surface never has to tell the two keys
          // apart: the chip's focus identity is its fact key (#3311).
          focusKey={chip.key}
          label={chip.label}
          state={chip.state}
          expanded={openEditor === chip.key}
          onOpen={(focusKey) => onOpen(chip.key, focusKey)}
        />
      ))}
      {summary.more.length > 0 && (
        <FactMoreChip
          testId="protocol-fact-more"
          focusKey="more"
          label={moreProtocolFactsLabel(summary.more)}
          expanded={openEditor === "more"}
          onOpen={(focusKey) => onOpen("more", focusKey)}
        />
      )}
    </FactChipRow>
  );
}
