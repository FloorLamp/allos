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
  const [failed, setFailed] = useState(false);
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
      setFailed(true);
      return;
    }
    onCleared?.();
    setConfirming(false);
  }

  if (!confirming) {
    return (
      <Button
        ref={clearRef}
        onClick={() => {
          setFailed(false);
          setConfirming(true);
        }}
        data-testid={testId}
      >
        Clear
      </Button>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="flex items-center gap-2">
        <span className="text-slate-500 dark:text-slate-400">Clear all?</span>
        <button
          ref={confirmRef}
          type="button"
          disabled={pending}
          aria-busy={pending}
          onClick={() => {
            setFailed(false);
            startTransition(runClear);
          }}
          className="btn-danger btn-sm"
          data-testid={`${testId}-confirm`}
        >
          {pending ? "Clearing…" : "Confirm"}
        </button>
        <Button
          disabled={pending}
          onClick={() => {
            setFailed(false);
            setConfirming(false);
          }}
        >
          Cancel
        </Button>
      </span>
      {failed && (
        <span role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          Couldn&apos;t clear the log. Try again.
        </span>
      )}
    </span>
  );
}
