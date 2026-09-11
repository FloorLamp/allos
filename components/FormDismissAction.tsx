"use client";

import Button from "@/components/Button";

/**
 * THE SUBORDINATE DISMISS BESIDE A FULL-WIDTH COMMIT (owner ruling 2026-09-11
 * 11:15 UTC, #5617 step 4).
 *
 * The owner reported the defect on a screenshot of the record's inline dose edit
 * form: the Save CTA was THE SAME SIZE as the controls around it — a Cancel box
 * of identical geometry beside it and a "Not stated" chip above it — so nothing
 * in the form's geometry said which control committed it. The ruling makes Save
 * the form's one prominent commit, `layout="block"` at the control box, and
 * keeps Cancel as "a quieter control that is not a same-size box beside Save: a
 * text-style dismiss under or beside the full-width Save".
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
