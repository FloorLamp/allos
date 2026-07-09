"use client";

import { useState, useTransition } from "react";
import { useConfirm, type ConfirmOptions } from "@/components/ConfirmDialog";

// Confirm, then run an action inside a transition — the shared mechanics behind
// the reprocess buttons (single document and reprocess-all). Returns `pending`
// (true while the action is in flight, so the trigger can disable itself) and
// `result` (whatever the last run resolved to, cleared at the start of each run,
// so callers that produce a summary can surface it). `run` no-ops if the user
// cancels the confirmation.
export function useConfirmedAction<T>(
  confirmOptions: ConfirmOptions,
  action: () => Promise<T>
): { pending: boolean; result: T | null; run: () => Promise<void> } {
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<T | null>(null);

  async function run() {
    if (!(await confirm(confirmOptions))) return;
    setResult(null);
    startTransition(async () => {
      setResult(await action());
    });
  }

  return { pending, result, run };
}
