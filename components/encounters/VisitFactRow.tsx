"use client";

import FactChipRow, {
  FactChip,
  FactMoreChip,
} from "@/components/facts/FactChipRow";
import {
  moreFactsLabel,
  type VisitFactKey,
  type VisitFactSummary,
} from "@/lib/visit-facts";

// The summary row of the visit pair (#3223), in the shared facts-with-editors grammar
// (#3218). Everything about how a chip looks, announces itself and discloses its editor
// lives in `components/facts/FactChipRow`; this file supplies only which facts a visit
// states, in what order, and which trailing affordance holds the absent ones.
//
// ONE ROW SERVES BOTH TENSES, which is the point of #3223: the appointment form and the
// encounter form mount THIS, so a person who books a visit and a person who logs one
// that already happened are answering the same six questions in the same words. The two
// Server Actions and their two tables stay separate behind it.
//
// IT HAS A TRAILING AFFORDANCE, unlike the sleep dialog's row and the activity editor's.
// A visit's optional facts really can all be empty — most logged visits carry no
// diagnoses and no notes — and five dashed prompts for things nobody is going to fill in
// is the "wall of fields" the pattern exists to replace. So an absent optional renders
// NO chip and lives behind one control that names what it holds. That also makes this
// the first consumer where useFactEditor's SECOND focus tier is the one that answers: a
// fact edited back to empty has no chip to return to, and focus lands on the affordance
// it just went back inside.

export default function VisitFactRow({
  testId,
  summary,
  openEditor,
  onOpen,
}: {
  testId?: string;
  summary: VisitFactSummary;
  openEditor: VisitFactKey | null;
  onOpen: (key: VisitFactKey) => void;
}) {
  const moreLabel = moreFactsLabel(summary.absent);
  // The affordance opens the FIRST fact it holds. It is one control over several facts,
  // so its own identity is not any of their keys — hence the explicit focus key relayed
  // through `onOpen`, exactly the chip-vs-panel split the primitive's header describes.
  const firstAbsent = summary.absent[0];

  return (
    <FactChipRow testId={testId}>
      {summary.chips.map((chip) => (
        <FactChip
          key={chip.key}
          testId={`visit-fact-${chip.key}`}
          // One chip, one panel on this surface, so a chip's focus identity is its fact
          // key (#3311).
          focusKey={chip.key}
          label={chip.label}
          state={chip.state}
          expanded={openEditor === chip.key}
          onOpen={() => onOpen(chip.key)}
          // `data-suggested` is the primitive's; this surface adds no marker of its own.
          // Only the wording is ours, and "from this provider" is not "from your usual".
          suggested={chip.suggested}
          badge={
            chip.suggested && (
              <span className="ml-1.5 text-xs font-medium text-brand-700 dark:text-brand-300">
                from this provider
              </span>
            )
          }
        />
      ))}
      {moreLabel && firstAbsent && (
        <FactMoreChip
          testId="visit-fact-more"
          focusKey="more"
          label={moreLabel}
          expanded={summary.absent.includes(openEditor as VisitFactKey)}
          onOpen={() => onOpen(firstAbsent)}
        />
      )}
    </FactChipRow>
  );
}
