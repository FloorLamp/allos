"use client";

import { useState, type FormEvent } from "react";
import { useToast } from "@/components/Toast";
import Combobox from "@/components/Combobox";
import { PRACTICE_STARTER_LIST } from "@/lib/practice";
import { savePractice } from "@/app/(app)/practice-actions";
import Button from "@/components/Button";
import SubmitButton from "@/components/SubmitButton";
import type { CatalogFormCallbacks } from "@/components/CatalogEditor";

// A practice's name and weekly goal — the form behind the quick-log sheet's Add
// practice and each row's Edit (#5668). It speaks the #5237 catalog form callbacks, so
// `CatalogFormDialog` hosts it the way it hosts every catalog form.
export default function PracticeEditor({
  targetId = null,
  name = "",
  perWeek = 3,
  perWeekMax = null,
  onSaved,
  onCancel,
  onPendingChange,
}: {
  targetId?: number | null;
  name?: string;
  perWeek?: number;
  perWeekMax?: number | null;
} & CatalogFormCallbacks<void>) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [practiceName, setPracticeName] = useState(name);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    onPendingChange?.(true);
    setError(null);
    const fd = new FormData(event.currentTarget);
    if (targetId != null) fd.set("target_id", String(targetId));
    try {
      const result = await savePractice(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast(targetId == null ? "Practice added" : "Practice updated");
      onSaved();
    } catch {
      setError("Couldn't save that practice. Try again.");
    } finally {
      setPending(false);
      onPendingChange?.(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 sm:grid-cols-3"
      data-testid={
        targetId == null ? "practice-create-form" : "practice-edit-form"
      }
    >
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200 sm:col-span-3">
        Practice
        <Combobox
          name="name"
          ariaLabel="Practice"
          value={practiceName}
          onChange={setPracticeName}
          options={[...PRACTICE_STARTER_LIST]}
          allowFreeText
          placeholder="Sauna, meditation, red light…"
          inputClassName="mt-1 w-full"
        />
      </label>
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
        Minimum days
        <input
          name="per_week"
          type="number"
          min="1"
          max="14"
          step="1"
          required
          defaultValue={perWeek}
          className="input mt-1 w-full"
        />
      </label>
      <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
        Maximum days (optional)
        <input
          name="per_week_max"
          type="number"
          min="1"
          max="14"
          step="1"
          defaultValue={perWeekMax ?? ""}
          className="input mt-1 w-full"
        />
      </label>
      <p className="text-xs leading-5 text-slate-500 sm:col-span-3 dark:text-slate-400">
        Multiple sessions on the same day count once toward the weekly goal.
      </p>
      <div className="flex items-end gap-2 sm:col-span-3">
        <SubmitButton variant="primary" disabled={pending}>
          {pending ? "Saving…" : targetId == null ? "Save" : "Save changes"}
        </SubmitButton>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
      {error && (
        <p
          className="text-sm text-rose-600 dark:text-rose-400 sm:col-span-3"
          data-testid="practice-save-error"
        >
          {error}
        </p>
      )}
    </form>
  );
}
