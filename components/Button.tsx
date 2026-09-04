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
   * The ONE rank plus the one destructive paint a caller may state (#3982,
   * `danger` added #4978). Absence IS the secondary treatment, so there is no
   * third value to spell and no size axis to compose — the type is the
   * admission rule. `primary` marks the action a surface exists for, at most
   * once per surface. `danger` tells a destructive action apart from its
   * neighbour before the tap, since undo happens after.
   */
  variant?: "primary" | "danger";
}

// The ordinary secondary action, the ONE primary variant the owner ruled for
// (#3982), and the ONE destructive paint (#4978). Callers supply meaning,
// behavior and — only now — RANK; never geometry and never paint of their own.
// `variant="primary"` / `variant="danger"` each add a paint-only utility on top
// of `button-control` rather than swapping the class, so every treatment carries
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
          : variant === "danger"
            ? "button-control button-control-danger"
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
