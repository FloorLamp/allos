"use client";

import FactChipRow, {
  FactChip,
  FactMoreChip,
} from "@/components/facts/FactChipRow";
import {
  moreInjuryFactsLabel,
  type InjuryFactKey,
  type InjuryFactSummary,
} from "@/lib/injury-facts";

// The summary row of the injury bar's forms (#3221), in the shared facts-with-editors
// grammar (#3218). Everything about how a chip looks, announces itself and discloses its
// editor lives in `components/facts/FactChipRow`; this file supplies only these forms'
// own facts — which ones, in what order, and which affordance each becomes.
//
// ONE ROW SERVES BOTH WRITES, which is the shape the injury bar already had: the quick-log
// form and the per-chip scope correction render one `InjuryScopeFields` between them
// (#2297), so the chips are written once here and the two Server Actions behind them
// (`logInjury`, `updateInjury`) stay exactly as they were. The row is a renderer over
// `injuryFactSummary`; the only difference the two forms present to it is whether a
// STATUS chip is in the summary at all.
//
// WHICH PANELS EXIST is a superset of the fact keys: `more` is the trailing affordance's
// own panel, a MENU of the absent optionals rather than an editor, so that opening it
// still leaves exactly one editor on screen (the shape #3219 settled on, matched here
// rather than answered a second way).
//
// NO SUGGESTION MARKING ON THIS SURFACE, and that is tracked-as-absent rather than
// forgotten (`suggested` undefined, see FactChipRow's `suggestedAttrs`). Nothing in these
// two forms is supplied FOR the person: the log form opens blank but for the status
// default, and the edit form opens on what they themselves saved. The one place an injury
// fact would ever be proposed is the niggle promotion, which is #3358's, not this row's —
// and when it arrives it will mark its chips through the primitive's own `suggested`
// prop, with no change to this file's shape.
export type InjuryOpenPanel = InjuryFactKey | "more";

export default function InjuryFactRow({
  testId,
  summary,
  openEditor,
  onOpen,
}: {
  testId?: string;
  summary: InjuryFactSummary;
  openEditor: InjuryOpenPanel | null;
  onOpen: (key: InjuryOpenPanel, focusKey: string) => void;
}) {
  return (
    <FactChipRow testId={testId}>
      {summary.chips.map((chip) => (
        <FactChip
          key={chip.key}
          testId={`injury-fact-${chip.key}`}
          // One chip, one panel on this surface, so a chip's focus identity is its fact
          // key (#3311).
          focusKey={chip.key}
          label={chip.label}
          state={chip.state}
          expanded={openEditor === chip.key}
          onOpen={(focusKey) => onOpen(chip.key, focusKey)}
        />
      ))}
      {summary.more.length > 0 && (
        <FactMoreChip
          testId="injury-fact-more"
          // The affordance's OWN identity, not any of the facts it holds (#3311) — it is
          // one control over several, which is the chip-vs-panel split the primitive's
          // header describes.
          focusKey="more"
          label={moreInjuryFactsLabel(summary.more)}
          expanded={openEditor === "more"}
          onOpen={(focusKey) => onOpen("more", focusKey)}
        />
      )}
    </FactChipRow>
  );
}
