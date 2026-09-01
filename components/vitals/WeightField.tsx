"use client";

import type { Ref } from "react";

// ONE WEIGHT FIELD (#4424 ruling 5), named by `LOG_MANIFEST.body` beside
// `TemperatureField`, which the symptom leg extracted from the same form for the same
// reason. The measurements form and the pediatric label lookup were two implementations
// of one question — a number and the unit it is in — and the second one put the unit in
// its LABEL, so a weight typed in a medication form and the same weight typed on
// /trends did not look like the same field.
//
// IT IS UNCONTROLLED, ALWAYS. The measurements form posts it as part of a `<form>`; the
// pediatric lookup cannot use a form at all (it renders inside `IntakeItemForm`'s), so
// it reads the value off `inputRef` and builds the FormData itself. A `value`/`onChange`
// pair would make one field two fields selected by a prop, which is the shape this
// ruling exists to remove.
//
// THE UNIT RIDES INSIDE THE INPUT'S TRAILING EDGE, which is the measurements form's
// arrangement and now the only one: `pr-12` is what keeps a value from running under it.
export default function WeightField({
  id,
  unit,
  inputRef,
  autoFocus = false,
  testId,
}: {
  /**
   * The input's id — its label's `htmlFor`. THE LABEL IS THE HOST'S, in the host's own
   * words, and this carries no `aria-label` of its own for that reason: one here would
   * override the visible label and leave a screen reader hearing something the page
   * does not say.
   */
  id: string;
  /** The display unit this value is entered in; the write boundary converts to kg. */
  unit: string;
  /** For a host that has no `<form>` to read the value out of. */
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
  testId?: string;
}) {
  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        data-testid={testId}
        type="number"
        step="0.1"
        min="0"
        inputMode="decimal"
        autoFocus={autoFocus}
        name="weight"
        className="input pr-12"
      />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium text-slate-500 dark:text-slate-400">
        {unit}
      </span>
    </div>
  );
}
