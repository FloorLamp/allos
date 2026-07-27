"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import Combobox from "@/components/Combobox";
import { PRACTICE_STARTER_LIST } from "@/lib/practice";
import { savePractice } from "./actions";

export default function PracticeEditor({
  targetId = null,
  name = "",
  perWeek = 3,
  perWeekMax = null,
  compact = false,
  onDone,
}: {
  targetId?: number | null;
  name?: string;
  perWeek?: number;
  perWeekMax?: number | null;
  compact?: boolean;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [practiceName, setPracticeName] = useState(name);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError(null);
    const fd = new FormData(form);
    if (targetId != null) fd.set("target_id", String(targetId));
    try {
      const result = await savePractice(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast(targetId == null ? "Practice added" : "Practice updated");
      onDone?.();
      router.refresh();
      if (targetId == null) {
        form.reset();
        setPracticeName("");
      }
    } catch {
      setError("Couldn't save that practice. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className={
        compact ? "grid gap-3 sm:grid-cols-3" : "card grid gap-3 sm:grid-cols-3"
      }
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
        Weekly minimum
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
        Optional maximum
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
      <div className="flex items-end gap-2">
        <button type="submit" className="btn" disabled={pending}>
          {pending
            ? "Saving…"
            : targetId == null
              ? "Add practice"
              : "Save changes"}
        </button>
        {onDone && (
          <button type="button" className="btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <p className="text-sm text-rose-600 dark:text-rose-400 sm:col-span-3">
          {error}
        </p>
      )}
    </form>
  );
}
