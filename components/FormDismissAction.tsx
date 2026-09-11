"use client";

import Button from "@/components/Button";

/**
 * THE SUBORDINATE DISMISS UNDER THE FORM'S ONE COMMIT (owner rulings 2026-09-11
 * 11:15 and 15:15 UTC, #5617 step 4).
 *
 * The owner reported the defect on a screenshot of the record's inline dose edit
 * form: the Save CTA was THE SAME SIZE as the controls around it — a Cancel box
 * of identical geometry beside it and a "Not stated" chip above it — so nothing
 * in the form's geometry said which control committed it. The ruling makes Save
 * the form's one commit and keeps Cancel as "a quieter control that is not a
 * same-size box beside Save: a text-style dismiss".
 *
 * THE COMMIT IS PROMINENT, NOT WIDE, AND THAT SECOND RULING IS WHY THIS FILE
 * MATTERS MORE THAN IT DID (owner, 2026-09-11 15:15 UTC, amending the 11:15
 * ruling). The first ruling made Save full-width at the control box. Above
 * tablet width that ran the commit straight under the time wheel — `TimeField`
 * opens its popover on FOCUS, so anyone who types a time still has it open when
 * they reach for Save, and the wheel's own columns sat over the middle of the
 * button. Measured: on the measurements quick-add the commit went from 132px
 * clear of the wheel to 838px with its centre on the minute column, and a click
 * aimed at Save PICKED A TIME instead of saving. So width is out and the
 * anchored panel is untouched: "the owner's concern was prominence, not width."
 *
 * WHICH LEAVES THE RANK AND THIS DISMISS TO CARRY THE WHOLE DISTINCTION. Save is
 * filled (`variant="primary"`) and content-sized; the dismiss beneath it gives up
 * the fill, the border and the horizontal padding. That contrast — a painted
 * control against a text one — is what now says which of the two commits the
 * form, so do not quietly restore a bordered `Button` here.
 *
 * WHY A COMPONENT RATHER THAN A CLASS AT EIGHT CALL SITES. `Button`'s prop set
 * is closed (#3720/#3954): there is no `className`, and `variant`/`layout` are
 * both closed unions that spell rank and width, not paint. So the text treatment
 * can only arrive through a wrapper element, and eight hand-written wrappers
 * would be eight chances for one of them to drift — which is the shape #3982 and
 * #5696 were each written against.
 *
 * IT KEEPS THE BOX AND GIVES UP ONLY THE PAINT. `inline-submit-action` drops the
 * border, the fill and the horizontal padding and takes the link tone; it does
 * NOT touch `min-block-size`, so the dismiss still renders the 34px control box
 * and still earns the coarse-pointer reach every control in the family gets.
 * That is the whole point of the ruling's word "text-style": subordinate to the
 * eye, not smaller to the thumb.
 *
 * NOT WRITTEN DOWN IN docs/internals/design-system.md, AND THAT IS THE GATE'S
 * DOING RATHER THAN AN OVERSIGHT. A row was drafted for its control-grammar
 * section and `check-doc-brevity.mjs` refused it: that file is at its 1500-word
 * budget, and the rule is that new text DISPLACES old. Choosing which of that
 * doc's existing rules to delete is the doc owner's call, not this change's, so
 * the shape is recorded here and in the two tests that measure it —
 * `e2e/button-height-floor.mobile.spec.ts`'s "#5617 step 4" block and
 * `e2e/ordinary-submit-actions.ts`'s `expectProminentCommit` — and the doc row
 * is reported rather than bought with somebody else's words.
 *
 * THE UTILITY'S NAME IS NOW HALF WRONG, AND THAT IS DELIBERATE RATHER THAN
 * MISSED. `inline-submit-action` (app/globals.css) is the app's one text-style
 * control treatment and was named when its only consumers were submits; this is
 * the first non-submit to want it. Renaming it, or exporting this shape from
 * `components/Button.tsx` beside `InlineSubmitAction`, would be the clean home —
 * both of those files are fenced to another owner, so the treatment is reused
 * from here and the rename is reported rather than taken. Do not copy the class
 * string out of here into a call site: when the utility is renamed, this file is
 * the one place that has to change.
 */
export default function FormDismissAction({
  children,
  onClick,
  disabled,
  "data-testid": testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  "data-testid"?: string;
}) {
  return (
    <span className="inline-submit-action">
      <Button
        type="button"
        onClick={onClick}
        disabled={disabled}
        data-testid={testId}
      >
        {children}
      </Button>
    </span>
  );
}
