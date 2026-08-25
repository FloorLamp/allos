"use client";

import { useFormStatus } from "react-dom";
import type { MouseEventHandler, ReactNode } from "react";

export interface ButtonProps {
  children: ReactNode;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  pendingLabel?: ReactNode;
  title?: string;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  "data-testid"?: string;
}

// The ordinary secondary action. There is deliberately one treatment: callers
// supply meaning and behavior, never geometry or paint. The control is a full
// 44px rendered target on a phone and returns to its compact content height from
// sm upward; navigational actions use DestinationActionLink instead.
export default function Button({
  children,
  type = "button",
  disabled = false,
  onClick,
  pendingLabel,
  title,
  "aria-label": ariaLabel,
  "aria-expanded": ariaExpanded,
  "aria-controls": ariaControls,
  "data-testid": testId,
}: ButtonProps) {
  const { pending } = useFormStatus();
  const busy = pending && type === "submit";

  return (
    <button
      type={type}
      disabled={disabled || busy}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-busy={busy || undefined}
      data-testid={testId}
      data-button-control=""
      className="button-control"
    >
      {busy ? (pendingLabel ?? children) : children}
    </button>
  );
}
