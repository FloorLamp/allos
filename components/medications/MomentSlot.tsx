import type { ReactNode } from "react";
import type { MomentSection } from "@/lib/moment-sections";

// One dose slot, rendered at the height this moment gives it (#2652 behavior 1). The
// DECISION is entirely `buildMomentSections` (pure, no DOM); this component only spends
// the height, in two shapes:
//
//   • EXPANDED — the slot this moment is about, or one that owes something now. A
//     heading and the full rows, controls and all.
//   • COMPRESSED — a native `<details>` whose `<summary>` IS the slot's one-line truth
//     ("✓ Morning · 3 of 3 taken · 08:12"). One tap opens the same rows, with the same
//     controls: compression changes HEIGHT, never reach (#1504).
//
// The line is a summary, not a truncation — see lib/moment-sections.ts for the rule that
// a slot which cannot state its whole truth in one line does not collapse at all. That
// is why the compressed shape here is safe to be a plain fold with no "…and 2 more"
// hedge: the sentence above the fold already accounts for every row below it.
//
// REDUCED MOTION (#2654) is the designed state. Both shapes carry a heading and a
// sentence, and neither depends on a transition to be understood: `<details>` toggles
// instantly, and nothing here animates height. A reader who never sees motion sees two
// complete, legible states.
//
// The slot heading stays an `<h3>` in BOTH shapes — inside the `<summary>` when
// compressed — so a reader navigating by heading still finds every slot of their day.
// A collapsed section is still a section; only its height changed. (Same principle as
// WidgetDormant's `<h2>`.)
//
// Deliberately STATELESS: this fold is derived from the clock, so it must not be
// remembered. Disclosure memory (behavior 3) is for ROUTINE folds a person chooses; a
// remembered moment fold would re-open yesterday's morning in tonight's evening and
// quietly undo the adaptation.
export default function MomentSlot({
  section,
  children,
}: {
  section: MomentSection<string>;
  children: ReactNode;
}) {
  const heading = (
    <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
      {section.label}
    </h3>
  );

  if (section.expanded) {
    return (
      <section
        data-testid="moment-slot"
        data-slot={section.bucket}
        data-slot-state={section.state}
        data-expanded="true"
      >
        <div className="flex flex-wrap items-baseline gap-x-2 px-1 pt-2 pb-1">
          {heading}
          <span
            data-testid="moment-slot-line"
            className="text-xs text-slate-500 dark:text-slate-400"
          >
            {section.lineDetail}
          </span>
        </div>
        <div className="divide-y divide-black/5 dark:divide-white/5">
          {children}
        </div>
      </section>
    );
  }

  return (
    <details
      data-testid="moment-slot"
      data-slot={section.bucket}
      data-slot-state={section.state}
      data-expanded="false"
      className="group"
    >
      <summary
        aria-label={section.line}
        className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 rounded-lg px-1 py-2 text-sm marker:content-none hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <span
          aria-hidden
          className="text-slate-500 group-open:rotate-90 dark:text-slate-400"
        >
          ›
        </span>
        {section.checked && (
          <span
            className="font-medium text-emerald-700 dark:text-emerald-400"
            aria-hidden
          >
            ✓
          </span>
        )}
        {heading}
        {/* The heading carries the slot name, so the visible detail drops it — but the
            `aria-label` on the summary carries the WHOLE sentence, so a screen reader
            following the disclosure hears the slot's complete truth in one utterance
            rather than two fragments. */}
        <span
          data-testid="moment-slot-line"
          className="text-slate-500 dark:text-slate-400"
        >
          {section.lineDetail}
        </span>
      </summary>
      <div className="divide-y divide-black/5 dark:divide-white/5">
        {children}
      </div>
    </details>
  );
}
