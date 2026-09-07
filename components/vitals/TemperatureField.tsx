"use client";

import type { useTemperatureUnitDetection } from "@/components/useTemperatureUnitDetection";

// ONE TEMPERATURE FIELD (#4424 ruling 5), named by `LOG_MANIFEST.body` as the field
// the symptom domain's form composes rather than re-draws. The measurements form and
// the symptom bar's illness mounts were two implementations of one question — a
// number, the unit it is in, and the detection that follows the reading — and the
// second one arranged them differently, so a °C reading typed on the bar and the same
// reading typed on /trends did not look like the same field.
//
// THE UNIT RIDES INSIDE THE INPUT'S TRAILING EDGE, which is the measurements form's
// arrangement and now the only one: the value can never run under it (`pr-16`), and
// `select-bare` is the primitive that pins the OPEN option list's colors in dark mode.
//
// AND IT DECLARES ITS OWN MEASURE (#5490 site 2, #3938's ruling): a temperature is a
// short number, so the field is a short field — at every host, once, rather than
// whatever a call site's flex row has left over. The illness fold gave it `flex-1`,
// which made a five-character reading ~530px inside the cockpit's 880px measure and
// let every sibling's content move it: flipping the card's day toggle resized a text
// input that might be focused and being typed into. Below `sm` it is still the line's
// width, which is what a phone wants and what the fold already rendered.
//
// DETECTION IS THE HOST'S, passed in rather than owned here, because a host resets it
// on its own schedule (the measurements form clears the whole sitting; the bar clears
// after one reading) and two `useTemperatureUnitDetection` instances over one field
// would disagree about whether the user had chosen a unit.

export type TemperatureUnitDetection = ReturnType<
  typeof useTemperatureUnitDetection
>;

export default function TemperatureField({
  id,
  testIdPrefix,
  detection,
  unitLabel,
  required = false,
  autoFocus = false,
}: {
  /** The input's id — its label's `htmlFor`. */
  id: string;
  /** `{prefix}-input`, `{prefix}-unit`, `{prefix}-detected`. */
  testIdPrefix: string;
  detection: TemperatureUnitDetection;
  /** The unit select's accessible name, in the host's own words for this reading. */
  unitLabel: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="w-full min-w-0 sm:w-40">
      <div className="relative">
        <input
          id={id}
          data-testid={`${testIdPrefix}-input`}
          type="number"
          step="0.1"
          inputMode="decimal"
          name="temperature"
          required={required}
          autoFocus={autoFocus}
          onChange={(event) => detection.readValue(event.target.value)}
          className="input w-full pr-16"
        />
        <select
          name="temp_unit"
          data-testid={`${testIdPrefix}-unit`}
          aria-label={unitLabel}
          value={detection.unit}
          onChange={(event) =>
            detection.chooseUnit(event.target.value === "C" ? "C" : "F")
          }
          className="select-bare absolute inset-y-1 right-1 py-0 pl-1.5 text-xs"
        >
          <option value="F">°F</option>
          <option value="C">°C</option>
        </select>
      </div>
      {detection.detectedUnit && (
        <p
          data-testid={`${testIdPrefix}-detected`}
          className="mt-1 text-xs text-slate-500 dark:text-slate-400"
        >
          Detected °{detection.detectedUnit} from the reading.
        </p>
      )}
    </div>
  );
}
