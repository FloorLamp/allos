"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { startPeriodAction, endPeriodAction } from "./actions";

// One-tap "period started" / "period ended" (issue #714 item 4), acting on today for the
// active profile. The button shown depends on whether a period is currently open. Answers
// from the action's typed result — never an unconditional confirm.
export default function PeriodQuickActions({
  hasOpenPeriod,
}: {
  hasOpenPeriod: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(
    action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>,
    okMsg: string
  ) {
    setError(null);
    startTransition(async () => {
      let result: { ok: boolean; error?: string };
      try {
        result = await action(new FormData());
      } catch {
        setError("Couldn't update the period. Try again.");
        return;
      }
      if (!result.ok) {
        setError(result.error ?? "Couldn't update the period.");
        return;
      }
      toast(okMsg);
      router.refresh();
    });
  }

  return (
    <div className="space-y-2" data-testid="period-quick-actions">
      {hasOpenPeriod ? (
        <button
          type="button"
          className="btn w-full"
          disabled={pending}
          data-testid="period-ended-button"
          onClick={() => run(endPeriodAction, "Period ended")}
        >
          {pending ? "Saving…" : "Period ended today"}
        </button>
      ) : (
        <button
          type="button"
          className="btn w-full"
          disabled={pending}
          data-testid="period-started-button"
          onClick={() => run(startPeriodAction, "Period started")}
        >
          {pending ? "Saving…" : "Period started today"}
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}
