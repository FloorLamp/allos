"use client";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";

import { useRef, useState } from "react";
import { IconScale } from "@tabler/icons-react";
import DateField from "@/components/DateField";
import WeightField from "@/components/vitals/WeightField";
import { useToast } from "@/components/Toast";
import { addMeasurements } from "@/app/(app)/trends/measurement-actions";
import { validateBodyMetricInput } from "@/lib/body-metric-input";
import { toKg } from "@/lib/units";
import type { PediatricFormContext } from "@/lib/prn-dosing";

// The dosing-weight update embedded in the pediatric label lookup. Since #4424 it
// DEFINES NO FIELDS OF ITS OWN — the number is `WeightField`, the day is the shared
// `DateField` — and it posts `addMeasurements`, the one action every body sitting goes
// through. It used to draw its own weight input with the unit in its LABEL, its own
// never-the-future check, and `addBodyMetric`: a fourth body write action carrying a
// strict subset of the same submission, which ruling 7 deletes.
//
// IT CANNOT MOUNT THE FORM ITSELF, and that is ruling 2's "mounts the shared body-metric
// FIELD" rather than a shortcut. This renders inside `IntakeItemForm`'s `<form>` (its
// `renderPanel()` output is part of that element), so a component that draws its own
// `<form>` would be a nested one — the submit is then inert and the caregiver watches a
// Save do nothing. Measured: mounting `MeasurementsQuickAdd` here reddened
// e2e/medication-prefill.spec.ts three times out of three with the form still on screen
// and the value still in it. Hence `type="button"` controls, a ref instead of a
// `<form>`'s FormData, and the field composed rather than the whole form.
export default function PediatricWeightUpdate({
  idPrefix,
  context,
  initiallyOpen = false,
  onSaved,
}: {
  idPrefix: string;
  context: PediatricFormContext;
  initiallyOpen?: boolean;
  onSaved: (next: PediatricFormContext) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(initiallyOpen);
  const weightRef = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState(context.today);
  // The dosing-weight update, on whichever surface renders the item form (#3087).
  const stampLoggedVia = useLoggedViaStamp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const weight = weightRef.current?.value ?? "";
    // The same pure guard the shared form runs before it posts: the write cores skip an
    // out-of-range number in silence, which on its own reads as a save.
    const validationError = validateBodyMetricInput({
      weight,
      bodyFatPct: null,
      restingHr: null,
    });
    if (validationError) {
      setError(validationError);
      return;
    }

    const formData = stampLoggedVia(new FormData());
    formData.set("date", date);
    formData.set("weight", weight);
    formData.set("weight_unit", context.weightUnit);
    setPending(true);
    let saved;
    try {
      saved = await addMeasurements(formData);
    } catch {
      setError("Couldn't update the weight. Try again.");
      return;
    } finally {
      setPending(false);
    }
    // THE DAY BOUND IS THE ACTION'S NOW, not a second copy of it here (#4425): every
    // body core refuses a day that has not happened, and this is that refusal reaching
    // the caregiver instead of a Save that closes over nothing.
    if (saved.dateRefused) {
      setError("That date hasn't happened yet. Pick today or an earlier day.");
      return;
    }

    onSaved({
      ...context,
      weightKg: toKg(Number(weight), context.weightUnit),
      weightDate: date,
    });
    if (weightRef.current) weightRef.current.value = "";
    setOpen(false);
    toast("Weight updated");
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn-ghost btn-sm mt-2"
        data-testid="pediatric-weight-update-open"
        onClick={() => setOpen(true)}
      >
        <IconScale className="h-3.5 w-3.5" stroke={1.75} />
        Update weight
      </button>
    );
  }

  return (
    <div
      className="mt-2 grid gap-2 sm:grid-cols-2"
      data-testid="pediatric-weight-update"
    >
      <div>
        <label className="label" htmlFor={`${idPrefix}-weight`}>
          Weight ({context.weightUnit})
        </label>
        <WeightField
          id={`${idPrefix}-weight`}
          unit={context.weightUnit}
          inputRef={weightRef}
          testId="pediatric-weight-input"
          autoFocus
        />
      </div>
      <div>
        <label className="label" htmlFor={`${idPrefix}-weight-date`}>
          Measured on
        </label>
        <DateField
          id={`${idPrefix}-weight-date`}
          data-testid="pediatric-weight-date"
          value={date}
          onChange={setDate}
          max={context.today}
          required
        />
      </div>
      <div className="flex items-center gap-1.5 sm:col-span-2">
        <button
          type="button"
          className="btn btn-sm"
          disabled={pending}
          onClick={() => void save()}
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
      {error ? (
        <p
          role="alert"
          className="text-xs text-rose-600 sm:col-span-2 dark:text-rose-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
