"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import Button from "@/components/Button";
import { Notice } from "@/components/Notice";

export default function CreatedShareLink({
  value,
  valueTestId,
}: {
  value: string;
  valueTestId?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const receiptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle"
  );

  function clearReceiptTimer() {
    clearTimeout(receiptTimer.current ?? undefined);
    receiptTimer.current = null;
  }

  useEffect(
    () => () => {
      mounted.current = false;
      clearTimeout(receiptTimer.current ?? undefined);
    },
    []
  );

  async function copy() {
    clearReceiptTimer();
    setCopyState("idle");
    try {
      await navigator.clipboard.writeText(value);
      if (!mounted.current) return;
      setCopyState("copied");
      receiptTimer.current = setTimeout(() => {
        receiptTimer.current = null;
        setCopyState("idle");
      }, 1_500);
    } catch {
      if (!mounted.current) return;
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopyState("manual");
    }
  }

  const status =
    copyState === "manual"
      ? "Copy unavailable. The link is selected for manual copying."
      : copyState === "copied"
        ? "Link copied."
        : "";

  return (
    <Notice tone="emerald" className="mt-4" testid="created-share-link">
      <p className="text-xs font-medium">
        Link created — copy it now (it won’t be shown again):
      </p>
      <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <input
          ref={inputRef}
          readOnly
          value={value}
          aria-label="Created share link"
          onFocus={(event) => event.currentTarget.select()}
          data-testid={valueTestId}
          className="input min-w-0 font-mono text-xs"
        />
        <Button onClick={copy} aria-label="Copy link" title="Copy link">
          {copyState === "copied" ? (
            <IconCheck className="h-4 w-4" stroke={1.75} />
          ) : (
            <IconCopy className="h-4 w-4" stroke={1.75} />
          )}
        </Button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={copyState === "manual" ? "mt-2 text-xs" : "sr-only"}
      >
        {status}
      </p>
    </Notice>
  );
}
