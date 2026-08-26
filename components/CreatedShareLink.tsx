"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import Button from "@/components/Button";
import { Notice } from "@/components/Notice";

type CreatedShareLinkProps = { value: string; valueTestId?: string };

export default function CreatedShareLink(props: CreatedShareLinkProps) {
  const { value, valueTestId } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const copyGeneration = useRef(0);
  const receiptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState("");
  const manualCopy = status.startsWith("Copy unavailable");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      copyGeneration.current += 1;
      clearTimeout(receiptTimer.current ?? undefined);
    };
  }, []);

  async function copy() {
    const generation = ++copyGeneration.current;
    clearTimeout(receiptTimer.current ?? undefined);
    receiptTimer.current = null;
    setStatus("");
    try {
      await navigator.clipboard.writeText(value);
      if (!mounted.current || generation !== copyGeneration.current) return;
      setStatus("Link copied.");
      receiptTimer.current = setTimeout(() => {
        receiptTimer.current = null;
        setStatus("");
      }, 1_500);
    } catch {
      if (!mounted.current || generation !== copyGeneration.current) return;
      inputRef.current?.focus();
      inputRef.current?.select();
      setStatus("Copy unavailable. The link is selected for manual copying.");
    }
  }

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
          {status === "Link copied." ? (
            <IconCheck className="h-4 w-4" stroke={1.75} />
          ) : (
            <IconCopy className="h-4 w-4" stroke={1.75} />
          )}
        </Button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={manualCopy ? "mt-2 text-xs" : "sr-only"}
      >
        {status}
      </p>
    </Notice>
  );
}
