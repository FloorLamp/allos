"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconScale } from "@tabler/icons-react";
import DateField from "@/components/DateField";
import { useToast } from "@/components/Toast";
import { addBodyMetric } from "@/app/(app)/trends/body-actions";
import { validateBodyMetricInput } from "@/lib/body-metric-input";
import { isRealIsoDate } from "@/lib/date";
import { toKg } from "@/lib/units";
import type { PediatricFormContext } from "@/lib/prn-dosing";

// A deliberately small body-weight entry embedded in the pediatric label lookup.
// It reuses the canonical Body write action rather than creating medication-owned
// weight data. This component sits inside medication forms, so it uses type="button"
// controls and invokes the action directly instead of nesting a second <form>.
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
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(initiallyOpen);
  const [weight, setWeight] = useState("");
  const [date, setDate] = useState(context.today);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const validationError = validateBodyMetricInput({
      weight,
      bodyFatPct: null,
      restingHr: null,
    });
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!isRealIsoDate(date) || date > context.today) {
      setError("Enter a valid date that is not in the future.");
      return;
    }

    const formData = new FormData();
    formData.set("date", date);
    formData.set("weight", weight);
    formData.set("weight_unit", context.weightUnit);
    setPending(true);
    try {
      await addBodyMetric(formData);
    } catch {
      setError("Couldn't update the weight. Try again.");
      return;
    } finally {
      setPending(false);
    }

    onSaved({
      ...context,
      weightKg: toKg(Number(weight), context.weightUnit),
      weightDate: date,
    });
    setWeight("");
    setOpen(false);
    toast("Weight updated");
    router.refresh();
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
        <input
          id={`${idPrefix}-weight`}
          data-testid="pediatric-weight-input"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.1"
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
          className="input"
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
