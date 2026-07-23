"use client";

import { useState } from "react";
import { IconCopy, IconCheck, IconEye, IconEyeOff } from "@tabler/icons-react";

// The ONE token/URL display row (issue #1063). Health Connect, Strava, and the
// calendar feeds each hand-rolled a `<code>` + copy(/reveal) row whose
// `overflow-x-auto whitespace-nowrap` never engaged — grid/flex ancestors sized
// to the code's intrinsic (nowrap) width, and the app shell's `overflow-x-clip`
// silently swallowed the excess, pushing the copy/reveal buttons off-screen at
// phone width. Tokens and URLs are COPY targets, not read targets, so the row
// WRAPS (`break-all`) instead of scrolling: the value stays fully visible and
// the buttons stay reachable no matter how narrow the viewport or how long a
// production hostname gets.
export function CopyButton({ value }: { value: string }) {
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
          /* clipboard unavailable — the value is shown for manual copy */
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

// A read-only labeled token/URL field with copy, and (for secrets) a reveal
// toggle. `secret` starts masked; `testid` lands on the <code> so specs can
// read the displayed value.
export function TokenRow({
  label,
  value,
  secret = false,
  testid,
}: {
  label: string;
  value: string;
  secret?: boolean;
  testid?: string;
}) {
  const [shown, setShown] = useState(!secret);
  const display = shown ? value : "•".repeat(Math.min(value.length, 40));
  return (
    <div className="min-w-0">
      <label className="label">{label}</label>
      <div className="flex min-w-0 items-center gap-2">
        <code
          className="input min-w-0 flex-1 break-all font-mono text-xs"
          data-testid={testid}
        >
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
