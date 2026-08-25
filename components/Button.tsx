"use client";

import { useFormStatus } from "react-dom";
import {
  forwardRef,
  type AriaAttributes,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
} from "react";

export interface ButtonProps {
  children: ReactNode;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  pendingLabel?: ReactNode;
  title?: string;
  "aria-label"?: string;
  "aria-haspopup"?: AriaAttributes["aria-haspopup"];
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  "data-testid"?: string;
}

// The ordinary secondary action. There is deliberately one treatment: callers
// supply meaning and behavior, never geometry or paint. The control is a full
// 44px rendered target on a phone and returns to its compact content height from
// sm upward; navigational actions use DestinationActionLink instead.
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    type = "button",
    disabled = false,
    onClick,
    onKeyDown,
    pendingLabel,
    title,
    "aria-label": ariaLabel,
    "aria-haspopup": ariaHasPopup,
    "aria-expanded": ariaExpanded,
    "aria-controls": ariaControls,
    "data-testid": testId,
  },
  ref
) {
  const { pending } = useFormStatus();
  const busy = pending && type === "submit";

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title={title}
      aria-label={ariaLabel}
      aria-haspopup={ariaHasPopup}
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
});

export default Button;
