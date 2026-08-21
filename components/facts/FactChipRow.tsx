"use client";

import { IconPlus } from "@tabler/icons-react";
import type { ReactNode } from "react";

// FACTS WITH EDITORS, the shared entry-form primitive (#3218), extracted from the one
// intake form that proved it (#3216).
//
// THE CONTRACT, restated here because this file is where it is enforced. A form whose
// fields are discrete facts renders, after its seeding pick, a row of tappable sentence
// chips stating exactly what Save will write — plus the submit button. Tapping a chip
// opens that fact's editor ALONE (see FactEditorHost), Done returns to the chips, and at
// most one editor is on screen. The form posts whole regardless of which editors were
// opened: closing an editor hides it, it does not unmount the value (#2014).
//
// EVERY CHIP IS A BUTTON WITH `aria-expanded`, which is the whole accessibility contract
// of a summary-first form: a chip is a disclosure, so what a screen reader announces has
// to be "this states a fact AND opens an editor", not a decorative span beside an
// invisible control. Keyboard reaches every chip in reading order for the same reason.
//
// A MISSING ESSENTIAL renders dashed and says what to add (`state: "missing"`); an ABSENT
// OPTIONAL renders nothing at all and is reached through one trailing affordance, which
// NAMES the facts it holds so "more" never means "somewhere in here".
//
// THIS PRIMITIVE OWNS NO DOMAIN LOGIC AND NO STORE. Each consumer supplies its facts, its
// editors, and its existing action; the chips are presentation over the same write.
//
// EVERY DISCLOSURE NAMES ITSELF, as `data-focus-key`, and that is what lets focus come
// back (#3311). Opening an editor unmounts this whole row, so when it returns EVERY chip
// is a new DOM node — the element the person activated is gone, not merely moved. A key
// survives that; an element reference cannot. See useFactEditor in FactEditorHost.
//
// AND IT IS THE CHIP'S OWN IDENTITY, NOT ITS PANEL'S. "Which editor does this open" and
// "where was I" are two questions, and a chip is not always the only answer to the first:
// the intake form draws one chip per rule SENTENCE and all of them open the one rules
// builder. Keyed on the panel, clicking the third rule returns focus to the first, and
// tapping "+ rule" returns focus to a rule the person did not touch — right answers to
// the wrong question. So the panel key is an argument to `open()`, and `focusKey` is
// per-chip. The chip hands its own key to `onOpen`, so a consumer relays it rather than
// spelling it twice and letting the two drift.
//
// WHAT IS DELIBERATELY *NOT* A CONSUMER: a surface whose fields are free numeric entry
// rather than discrete facts — the measurements form is the recorded counter-case. The
// pattern is a tool, not a mandate.

export type FactChipState = "stated" | "missing";

// THE SUGGESTION MARKING, and it belongs to the primitive rather than to each consumer
// (#3222). A chip whose value was supplied FOR the person — a label default, a borrowed
// typical duration — is an editable suggestion, not something they stated, and that
// difference is the whole distinction between prefilling and asserting (#846).
//
// It shipped on the removable chip only, which made it a per-consumer convention the
// third surface could simply forget: intake marked its fact chips with a badge testid,
// and the second consumer reached for another one. Both shapes now emit the SAME
// attribute from this one helper, so the marking is a structural property of a chip.
//
// The WORDING stays with the consumer — `badge` is a ReactNode, and "from label
// defaults" is not "from your usual". Only the machine-readable fact is shared.
//
// Absent when the consumer does not track suggestion for that fact at all, which is
// different from tracking it and finding it false.
//
// A MISSING CHIP CARRIES NO MARKING, and that is the rule rather than an oversight: a
// chip with no value cannot have borrowed one, so "not tracked" is the honest answer and
// `data-suggested="0"` would be a claim about a value that does not exist. A STATED fact
// the consumer never suggests is the other case — that one is tracked-and-false, and says
// so. Written down here because four more consumers are queued behind the first two and
// this is a reading they would otherwise each have to guess at.
function suggestedAttrs(
  suggested: boolean | undefined
): Record<string, string> {
  return suggested === undefined
    ? {}
    : { "data-suggested": suggested ? "1" : "0" };
}

const STATED_CHIP =
  "tap-target rounded-full border border-(--border) bg-surface px-3 py-1.5 text-sm text-slate-700 transition hover:bg-(--ghost-hover) dark:text-slate-200";

const MISSING_CHIP =
  "tap-target rounded-full border border-dashed border-brand-400 px-3 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50 dark:border-brand-500 dark:text-brand-300 dark:hover:bg-brand-950";

// The row itself: the facts in reading order, wrapping on narrow viewports. Consumers
// pass their chips as children so a surface can order its own facts and append its own
// trailing affordances without this component knowing any of their names.
//
// THE ROW IS THE FALLBACK FOCUS TARGET (#3311), which is why it is focusable at all. When
// an editor closes and the fact it edited has no chip — an optional fact left empty goes
// back behind the trailing affordance — there is nothing to return to, and leaving focus
// on <body> drops a keyboard user at the top of the document. `tabIndex={-1}` makes the
// row focusable WITHOUT adding a tab stop, and because the row CONTAINS the chips, Tab
// from it continues into the row in document order rather than skipping past it.
//
// AND IT SHOWS A RING WHEN IT HAS FOCUS. A focusable element that gives no sign it is
// focused is its own defect, and shipping one inside a fix for a keyboard defect would
// be a poor trade. `focus:` rather than `focus-visible:` on purpose: this element is
// never tabbed to and never clicked, so the only way it takes focus is the one
// programmatic call below — and programmatic focus does not reliably match
// :focus-visible after a pointer interaction, which is exactly when the indicator would
// go missing. A ring around a waypoint you are meant to leave immediately is correct.
export default function FactChipRow({
  testId,
  className,
  children,
}: {
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      data-fact-row="true"
      tabIndex={-1}
      className={`flex flex-wrap items-center gap-1.5 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-hidden ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

// One fact. `expanded` is true when this fact's editor is the one open — the aria wiring
// that makes the chip a disclosure rather than a label.
//
// `remove` turns the chip into a stated fact WITH a dismissal (a rule the person can
// delete before saving). The chip stays the disclosure; the × is a second button beside
// it, never a click-target overlapping the first.
export function FactChip({
  label,
  focusKey,
  state = "stated",
  expanded,
  onOpen,
  testId,
  badge,
  suggested,
  remove,
}: {
  label: ReactNode;
  // THIS CHIP's own identity, unique within the row — not its panel's (see the header).
  // Emitted as `data-focus-key` so the editor can hand focus back to exactly this chip
  // (#3311). Required, because a consumer that forgets loses the return path with
  // nothing on screen to show for it.
  focusKey: string;
  state?: FactChipState;
  expanded: boolean;
  // Handed this chip's `focusKey`, so a consumer whose chips and panels do not
  // correspond one-to-one relays it to `open(panel, focusKey)` instead of writing the
  // same key in two places.
  onOpen: (focusKey: string) => void;
  testId?: string;
  // An annotation the consumer renders inside the chip — the datasets supplied this and
  // the person has not touched it (#846), and so on. The primitive does not name it.
  badge?: ReactNode;
  // Emitted as `data-suggested` on EITHER chip shape when the consumer tracks it; see
  // suggestedAttrs. The consumer supplies the wording through `badge`.
  suggested?: boolean;
  remove?: { label: string; testId?: string; onClick: () => void };
}) {
  if (!remove)
    return (
      <button
        type="button"
        data-testid={testId}
        data-fact-state={state}
        data-focus-key={focusKey}
        {...suggestedAttrs(suggested)}
        aria-expanded={expanded}
        onClick={() => onOpen(focusKey)}
        className={state === "missing" ? MISSING_CHIP : STATED_CHIP}
      >
        {label}
        {badge}
      </button>
    );

  return (
    <span
      data-testid={testId}
      data-fact-state={state}
      {...suggestedAttrs(suggested)}
      className="inline-flex items-center gap-1 rounded-full border border-(--border) bg-surface py-1.5 pr-1.5 pl-3 text-sm text-slate-700 dark:text-slate-200"
    >
      <button
        type="button"
        data-focus-key={focusKey}
        aria-expanded={expanded}
        onClick={() => onOpen(focusKey)}
        className="text-left"
      >
        {label}
        {badge}
      </button>
      <button
        type="button"
        data-testid={remove.testId}
        aria-label={remove.label}
        onClick={remove.onClick}
        className="tap-target flex h-6 w-6 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950 dark:hover:text-rose-400"
      >
        ×
      </button>
    </span>
  );
}

// The prompt variant: a dashed "+ thing" that adds a fact the row cannot state yet
// because there is not one of it. Distinct from a MISSING essential, which is a fact the
// form already knows it wants.
export function FactAddChip({
  label,
  focusKey,
  expanded,
  onOpen,
  testId,
}: {
  label: string;
  // This prompt's own identity — see FactChip's `focusKey` (#3311). It PERSISTS after
  // the fact is added (the intake form keeps "+ rule" beside the rules it states), so
  // focus returns here rather than to whichever chip the addition produced.
  focusKey: string;
  expanded: boolean;
  onOpen: (focusKey: string) => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-focus-key={focusKey}
      aria-expanded={expanded}
      onClick={() => onOpen(focusKey)}
      className="tap-target inline-flex items-center gap-1 rounded-full border border-dashed border-(--border) px-3 py-1.5 text-sm text-slate-600 transition hover:bg-(--ghost-hover) dark:text-slate-300"
    >
      <IconPlus className="h-3.5 w-3.5" stroke={2} aria-hidden="true" />
      {label}
    </button>
  );
}

// The mini variant: the ONE trailing affordance holding the optional facts with nothing
// to state. Quiet, because it is not a fact — it is where the absent ones live. Its label
// names them (see `moreFactsLabel` in each consumer's fact module).
export function FactMoreChip({
  label,
  focusKey,
  expanded,
  onOpen,
  testId,
}: {
  label: string;
  // This affordance's own identity — see FactChip's `focusKey` (#3311).
  focusKey: string;
  expanded: boolean;
  onOpen: (focusKey: string) => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-focus-key={focusKey}
      // WHERE AN ABSENT OPTIONAL FACT GOES, and so where focus goes when the fact that
      // was just edited has no chip of its own: it is in here (#3311). Marked for the
      // primitive rather than found by a consumer testid, because this is the one
      // trailing affordance by contract — see FactEditorHost's restore.
      data-fact-more="true"
      aria-expanded={expanded}
      onClick={() => onOpen(focusKey)}
      className="tap-target rounded-full px-3 py-1.5 text-sm text-slate-500 underline-offset-2 transition hover:underline dark:text-slate-400"
    >
      {label}
    </button>
  );
}
