"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import NotesText from "@/components/NotesText";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { FLOW_LABELS, periodLengthDays, type CyclePeriod } from "@/lib/cycle";
import CycleForm from "./CycleForm";
import { saveCycleAction, deleteCycleAction } from "./actions";

// One recorded period in the history list (issue #714): dates, period length, flow, note,
// with inline edit (reusing CycleForm) and delete. Length between this period's start and
// the NEXT one (the cycle length) is shown by the parent list; here we show the period's
// own bleeding length.
export default function CycleHistoryRow({ period }: { period: CyclePeriod }) {
  const formatPrefs = useFormatPrefs();
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const days = periodLengthDays(period);

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", String(period.id));
      let result: { ok: boolean; error?: string };
      try {
        result = await deleteCycleAction(fd);
      } catch {
        setError("Couldn't delete this period. Try again.");
        return;
      }
      if (!result.ok) {
        setError(result.error ?? "Couldn't delete this period.");
        return;
      }
      toast("Period deleted");
      router.refresh();
    });
  }

  if (editing) {
    return (
      <li className="list-none">
        <CycleForm
          action={saveCycleAction}
          period={period}
          onDone={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li
      className="card flex flex-wrap items-start justify-between gap-2"
      data-testid="cycle-history-row"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
          {formatLongDate(period.period_start, formatPrefs)}
          {" – "}
          {period.period_end
            ? formatLongDate(period.period_end, formatPrefs)
            : "ongoing"}
        </div>
        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {days != null ? `${days} day${days === 1 ? "" : "s"}` : "in progress"}
          {period.flow ? ` · ${FLOW_LABELS[period.flow]} flow` : ""}
        </div>
        <NotesText
          notes={period.note}
          className="mt-1 block text-sm text-slate-600 dark:text-slate-300"
        />
        {error && (
          <p
            role="alert"
            className="mt-1 text-xs text-rose-600 dark:text-rose-400"
          >
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          className="btn-ghost px-2 py-1 text-xs"
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn-ghost px-2 py-1 text-xs text-rose-600 dark:text-rose-400"
          disabled={pending}
          data-testid="cycle-delete-button"
          onClick={handleDelete}
        >
          {pending ? "…" : "Delete"}
        </button>
      </div>
    </li>
  );
}
