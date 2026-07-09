"use client";

import { useState } from "react";
import { IconCopy, IconCheck, IconEye, IconEyeOff } from "@tabler/icons-react";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800"
      aria-label="Copy"
    >
      {copied ? (
        <IconCheck className="h-3.5 w-3.5" />
      ) : (
        <IconCopy className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// A read-only field with copy, and (for secrets) a reveal toggle.
export function SecretField({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const [shown, setShown] = useState(!secret);
  const display = shown ? value : "•".repeat(Math.min(value.length, 40));
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-2">
        <code className="input min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
          {display}
        </code>
        {secret && (
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            className="inline-flex shrink-0 items-center rounded-md border border-black/10 p-1.5 text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800"
            aria-label={shown ? "Hide" : "Reveal"}
          >
            {shown ? (
              <IconEyeOff className="h-4 w-4" />
            ) : (
              <IconEye className="h-4 w-4" />
            )}
          </button>
        )}
        <CopyButton value={value} />
      </div>
    </div>
  );
}
