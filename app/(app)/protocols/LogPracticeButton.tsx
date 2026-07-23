"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconCheck } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import type { PracticeLogOutcome } from "@/lib/types";
import { logPractice } from "./actions";

// One-tap "Log session" button for a wellness practice (#1259). Logs a session for
// TODAY through the shared write core and answers from its typed outcome — NEVER an
// unconditional confirm (a session log is not idempotent; multi-session days are the
// point). Today's running count sits beside the button (the PRN widget shape) so a
// deliberate second tap is informed, not accidental. The button is a plain formatter
// over the one server action every practice surface shares.
export default function LogPracticeButton({
  practice,
  todayCount,
  atCeiling = false,
}: {
  practice: string;
  todayCount: number;
  atCeiling?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [count, setCount] = useState(todayCount);

  async function onClick() {
    setPending(true);
    let outcome: PracticeLogOutcome;
    try {
      const fd = new FormData();
      fd.set("practice", practice);
      outcome = await logPractice(fd);
    } catch {
      setPending(false);
      toast("Couldn't log that session. Try again.");
      return;
    }
    setPending(false);
    if (outcome.kind === "logged") {
      setCount(outcome.count);
      toast(
        outcome.count === 1
          ? "Logged today's session"
          : `Logged — ${outcome.count} sessions today`
      );
      router.refresh();
    } else {
      toast("Couldn't log that session.");
    }
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={onClick}
        data-testid="practice-log-button"
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        <IconCheck className="h-4 w-4" stroke={2} aria-hidden />
        Log session
      </button>
      <span
        className="text-xs text-slate-500 dark:text-slate-400"
        data-testid="practice-today-count"
      >
        {count === 0
          ? "None logged today"
          : count === 1
            ? "1 logged today"
            : `${count} logged today`}
        {atCeiling ? " · that's plenty this week" : ""}
      </span>
    </div>
  );
}
