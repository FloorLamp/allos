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
  /**
   * The ONE rank a caller may state (#3982). Absence IS the secondary treatment,
   * so there is no third value to spell and no size axis to compose — the type is
   * the admission rule. Use it for the action a surface exists for, at most once
   * per surface.
   */
  variant?: "primary";
}

// The ordinary secondary action, plus the ONE primary variant the owner ruled for
// (#3982). Callers supply meaning, behavior and — only now — RANK; never geometry
// and never paint of their own. `variant="primary"` adds a paint-only utility on
// top of `button-control` rather than swapping the class, so both treatments carry
// the same box, the same focus ring and the same pending spinner by construction.
// The control is a full 44px effective target on a coarse pointer; navigational
// actions use DestinationActionLink instead.
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
    variant,
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
      className={
        variant === "primary"
          ? "button-control button-control-primary"
          : "button-control"
      }
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

// The link-shaped submit. `variant` is deliberately not forwardable: this wrapper
// already repaints its `> .button-control` child, and a primary inside it would be
// two paints arguing. Same reason `DestructiveSubmit` picks its props by name.
export const InlineSubmitAction = (
  props: Omit<SubmitActionProps, "variant">
) => (
  <span className="inline-submit-action">
    <SubmitActionChip {...props} />
  </span>
);
