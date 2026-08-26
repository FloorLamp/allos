"use client";

import { useFormStatus } from "react-dom";
import { IconLoader2 } from "@tabler/icons-react";
import {
  forwardRef,
  type AriaAttributes,
  type ButtonHTMLAttributes,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
} from "react";

type NativeButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export interface ButtonProps {
  children: ReactNode;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  name?: NativeButtonProps["name"];
  value?: NativeButtonProps["value"];
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  pendingLabel?: ReactNode;
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
    name,
    value,
    onClick,
    onKeyDown,
    pendingLabel,
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
      name={name}
      value={value}
      onClick={onClick}
      onKeyDown={onKeyDown}
      aria-label={ariaLabel}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-busy={busy || undefined}
      data-testid={testId}
      data-button-control=""
      className="button-control"
    >
      {busy && (
        <IconLoader2 className="size-4 motion-safe:animate-spin" aria-hidden />
      )}
      {busy ? (pendingLabel ?? children) : children}
    </button>
  );
});

export default Button;

type SubmitActionProps = Omit<ButtonProps, "type">;

export const SubmitActionChip = (props: SubmitActionProps) => (
  <Button {...props} type="submit" />
);

export const InlineSubmitAction = (props: SubmitActionProps) => (
  <span className="inline-submit-action">
    <SubmitActionChip {...props} />
  </span>
);
