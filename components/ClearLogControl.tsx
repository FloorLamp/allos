"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Button from "@/components/Button";

type LogKind = "ai" | "error" | "notify";

export default function ClearLogControl({
  log,
  clear,
  onCleared,
}: {
  log: LogKind;
  clear: () => Promise<void>;
  onCleared?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const clearRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  const testId = log === "ai" ? "ai-log-clear" : `${log}-log-clear`;

  useEffect(() => {
    if (pending) return;
    if (opened.current || confirming)
      (confirming ? confirmRef : clearRef).current?.focus();
    opened.current ||= confirming;
  }, [confirming, pending]);

  async function runClear() {
    try {
      await clear();
    } catch {
      return;
    }
    onCleared?.();
    setConfirming(false);
  }

  if (!confirming) {
    return (
      <Button
        ref={clearRef}
        onClick={() => setConfirming(true)}
        data-testid={testId}
      >
        Clear
      </Button>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <span className="text-slate-500 dark:text-slate-400">Clear all?</span>
      <button
        ref={confirmRef}
        type="button"
        disabled={pending}
        aria-busy={pending}
        onClick={() => startTransition(runClear)}
        className="btn-danger btn-sm"
        data-testid={`${testId}-confirm`}
      >
        {pending ? "Clearing…" : "Confirm"}
      </button>
      <Button disabled={pending} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}
