"use client";

import type { Ref } from "react";

// ONE WEIGHT FIELD (#4424 ruling 5), named by `LOG_MANIFEST.body` beside
// `TemperatureField` — the same extraction the symptom leg made from the same form.
// The measurements form and the pediatric label lookup drew one question two ways, and
// the second put the unit in its LABEL, so the same weight did not look like the same
// field. The unit rides inside the input's trailing edge here (`pr-12` keeps a value
// from running under it), which is the measurements form's arrangement and now the only one.
//
// UNCONTROLLED, ALWAYS. The measurements form posts it inside a `<form>`; the pediatric
// lookup cannot use a form at all (it renders inside `IntakeItemForm`'s) and reads the
// value off `inputRef`. A `value`/`onChange` pair would make one field two, selected by
// a prop, which is the shape this ruling exists to remove.

export default function WeightField({
  id,
  unit,
  inputRef,
  autoFocus = false,
  testId,
}: {
  /**
   * The input's id — its label's `htmlFor`. THE LABEL IS THE HOST'S: no `aria-label`
   * here, because one would override the visible label and leave a screen reader
   * hearing something the page does not say.
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
