"use client";

import { useState } from "react";
import FactChipRow, {
  FactChip,
  FactMoreChip,
} from "@/components/facts/FactChipRow";
import {
  moreFactsLabel,
  VISIT_FACT_NOUNS,
  type VisitFactKey,
  type VisitFactSummary,
} from "@/lib/visit-facts";

// The summary row of the visit pair (#3223), in the shared facts-with-editors grammar
// (#3218). Everything about how a chip looks, announces itself and discloses its editor
// lives in `components/facts/FactChipRow`; this file supplies only which facts a visit
// states, in what order, and what the trailing affordance holds.
//
// ONE ROW SERVES BOTH TENSES, which is the point of #3223: the appointment form and the
// encounter form mount THIS, so booking a visit and logging one that already happened
// are the same six questions in the same words. The two Server Actions and their two
// tables stay separate behind it.
//
// THE TRAILING AFFORDANCE OPENS A MENU, not the first fact it holds — the shape #3219
// settled on, and worth matching rather than answering a second way. A visit's optional
// facts really can all be empty (most logged visits carry no diagnoses and no notes), so
// the affordance routinely holds three or four; opening the first would make the other
// three unreachable in one gesture, and would make "add notes" mean "add reason". The
// menu names each one, so "more" never means "somewhere in here".
//
// AND IT MAKES THIS THE FIRST CONSUMER WHERE useFactEditor's SECOND FOCUS TIER ANSWERS.
// A fact edited back to empty has no chip to return to; focus lands on the affordance it
// has gone back inside, which is where the person would reach for it again.

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
  const [moreOpen, setMoreOpen] = useState(false);
  const moreLabel = moreFactsLabel(summary.absent);

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
      {moreLabel && (
        <>
          <FactMoreChip
            testId="visit-fact-more"
            // The affordance's OWN identity, not any of the facts it holds (#3311) —
            // it is one control over several, which is exactly the chip-vs-panel split
            // the primitive's header describes.
            focusKey="more"
            label={moreLabel}
            // `aria-expanded` states whether the MENU is open, which is what this
            // control actually discloses. The editor it eventually opens is the chip's
            // business, not this one's.
            expanded={moreOpen}
            onOpen={() => setMoreOpen((v) => !v)}
          />
          {moreOpen && (
            <span
              role="menu"
              aria-label="Add another detail"
              data-testid="visit-fact-more-menu"
              className="inline-flex flex-wrap items-center gap-1.5"
            >
              {summary.absent.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="menuitem"
                  data-testid={`visit-more-${key}`}
                  onClick={() => {
                    setMoreOpen(false);
                    onOpen(key);
                  }}
                  data-fact-chip="solo"
                  className="rounded-full border border-dashed border-(--border) px-3 text-sm text-slate-600 transition hover:bg-(--ghost-hover) dark:text-slate-300"
                >
                  {VISIT_FACT_NOUNS[key]}
                </button>
              ))}
            </span>
          )}
        </>
      )}
    </FactChipRow>
  );
}
