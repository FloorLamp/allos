"use client";

import FactChipRow, {
  FactChip,
  FactMoreChip,
} from "@/components/facts/FactChipRow";
import {
  moreRecordFactsLabel,
  type RecordFactSummary,
} from "@/lib/record-facts";

// The chip row and the more-menu every clinical record form draws (#5302), written
// once for the thirteen.
//
// The eight consumers before this family each wrote their own row file, and that was
// right for them: the intake form draws one chip per rule sentence, the activity
// editor repeats a row per exercise, the protocol form has a "+ practice" prompt no
// other surface has. The record forms have none of that. Every one of the thirteen
// draws the same thing — the stated facts in reading order, then one trailing
// affordance naming what is absent — so this is a renderer over
// `RecordFactSummary`, and a form supplies only its testid prefix, its nouns, and
// which panel each chip opens.
//
// WHICH PANEL A CHIP OPENS IS THE CONSUMER'S QUESTION, not this component's. Usually it
// is the chip's own fact key; the allergy form's reaction and severity are two chips
// over one editor (#1405), which is the primitive's many-chips-one-panel case. So the
// caller passes `panelOf` and this file never learns a fact name.
//
// THE TESTIDS ARE PART OF THE CONTRACT, because e2e/record-facts-helpers.ts routes by
// them for every form in the family: `<prefix>-fact-row`, `<prefix>-fact-<key>`,
// `<prefix>-fact-more`, `<prefix>-more-<key>`.
export default function RecordFactRow<K extends string>({
  prefix,
  summary,
  nouns,
  openEditor,
  panelOf,
  onOpen,
}: {
  /** The form's testid prefix — "condition", "allergy", … */
  prefix: string;
  summary: RecordFactSummary<K>;
  nouns: Record<K, string>;
  /** The panel currently open, or null. The row renders only when it is null. */
  openEditor: string | null;
  panelOf?: (key: K) => string;
  onOpen: (panel: string, focusKey: string) => void;
}) {
  const panel = panelOf ?? ((key: K) => key as string);
  return (
    <FactChipRow testId={`${prefix}-fact-row`}>
      {summary.chips.map((chip) => (
        <FactChip
          key={chip.key}
          testId={`${prefix}-fact-${chip.key}`}
          // THIS CHIP's own identity, which is not always its panel's: focus has to
          // come back to the chip that was tapped (#3311).
          focusKey={chip.key}
          label={chip.label}
          state={chip.state}
          suggested={chip.suggested}
          expanded={openEditor === panel(chip.key)}
          onOpen={(focusKey) => onOpen(panel(chip.key), focusKey)}
        />
      ))}
      {summary.more.length > 0 && (
        <FactMoreChip
          testId={`${prefix}-fact-more`}
          focusKey="more"
          label={moreRecordFactsLabel(summary.more, nouns)}
          expanded={openEditor === "more"}
          onOpen={(focusKey) => onOpen("more", focusKey)}
        />
      )}
    </FactChipRow>
  );
}

// The trailing affordance's panel is a MENU, not an editor: it names the optional facts
// with nothing to state and hands off to one of them, so opening it still leaves
// exactly one editor on screen (the intake form's shape, #3216).
export function RecordFactMoreMenu<K extends string>({
  prefix,
  more,
  nouns,
  panelOf,
  onOpen,
}: {
  prefix: string;
  more: readonly K[];
  nouns: Record<K, string>;
  panelOf?: (key: K) => string;
  onOpen: (panel: string) => void;
}) {
  const panel = panelOf ?? ((key: K) => key as string);
  return (
    <div className="flex flex-wrap gap-1.5 pointer-coarse:gap-3.5">
      {more.map((key) => (
        <button
          key={key}
          type="button"
          data-testid={`${prefix}-more-${key}`}
          onClick={() => onOpen(panel(key))}
          data-fact-chip="solo"
          className="rounded-full border border-(--border) px-3 text-sm transition hover:bg-(--ghost-hover)"
        >
          {nouns[key]}
        </button>
      ))}
    </div>
  );
}
