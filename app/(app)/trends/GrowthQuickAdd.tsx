"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { validateGrowthInput } from "@/lib/growth-input";
import { addGrowth } from "./growth-actions";

// Manual height / head-circumference quick-add for the Trends → Body tab — a
// child-only sibling of BodyQuickAdd (rendered by the server section only for a
// minor profile). Height is the priority datapoint for a kid; head circumference
// appears only for the very young (server passes showHeadCirc). Both write to the
// SAME metric_samples keys ('height_cm' / 'head_circumference_cm') the growth
// charts read, so an entry immediately scores against the WHO/CDC percentile
// curves. Values carry a cm/in unit selector defaulting to cm (canonical); the
// pure validateGrowthInput mirrors the action's bounds so the form surfaces an
// inline error instead of a false "saved".
export default function GrowthQuickAdd({
  defaultDate,
  showHeadCirc,
}: {
  defaultDate: string;
  showHeadCirc: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    const validationError = validateGrowthInput({
      height: formData.get("height") as string | null,
      heightUnit: formData.get("height_unit") as string | null,
      headCirc: formData.get("head_circ") as string | null,
      headCircUnit: formData.get("head_circ_unit") as string | null,
    });
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      await addGrowth(formData);
    } catch {
      setError("Couldn't save this measurement. Try again.");
      return;
    }
    toast("Growth measurement saved");
    formRef.current?.reset();
    router.refresh();
  }

  return (
    <form
      ref={formRef}
      action={handle}
      className="card space-y-3"
      data-testid="growth-quick-add"
    >
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Log growth
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Height{showHeadCirc ? " and head circumference" : ""} — scored against
          the WHO/CDC growth percentiles below.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="label" htmlFor="g-date">
            Date
          </label>
          <DateField
            id="g-date"
            name="date"
            defaultValue={defaultDate}
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="g-height">
            Height
          </label>
          <div className="flex gap-2">
            <input
              id="g-height"
              type="number"
              step="0.1"
              min="0"
              name="height"
              className="input"
            />
            <select
              name="height_unit"
              aria-label="Height unit"
              defaultValue="cm"
              className="input w-auto"
            >
              <option value="cm">cm</option>
              <option value="in">in</option>
            </select>
          </div>
        </div>

        {showHeadCirc && (
          <div>
            <label className="label" htmlFor="g-head-circ">
              Head circumference
            </label>
            <div className="flex gap-2">
              <input
                id="g-head-circ"
                type="number"
                step="0.1"
                min="0"
                name="head_circ"
                className="input"
              />
              <select
                name="head_circ_unit"
                aria-label="Head circumference unit"
                defaultValue="cm"
                className="input w-auto"
              >
                <option value="cm">cm</option>
                <option value="in">in</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <SubmitButton pendingLabel="Saving…">Save growth</SubmitButton>
    </form>
  );
}
