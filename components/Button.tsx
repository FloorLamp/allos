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
  /**
   * The CLOSED set of layout needs a caller may state (owner ruling
   * 2026-09-04, #4978), in place of the `className` escape and the wrapper
   * element that the two shapes below had otherwise grown. `block` is full
   * width; `hidden-below-sm` is the responsive hide. Both are LAYOUT only —
   * they never touch paint, type size or the control box (#3938). There is no
   * third value on purpose: a mount that needs one is reported on #4978 and
   * waits, so the type is the admission rule here exactly as it is for
   * `variant`.
   */
  layout?: "block" | "hidden-below-sm";
}

/**
 * THE ONE SHAPE MODIFIER, AND IT IS GHOST-ONLY (owner ruling 4, 2026-09-09,
 * #4978). The fact row's "missing" placeholder shape — a dashed box saying the
 * app is waiting for this rather than offering it — is grammar the two rank
 * paints cannot spell, so `symptom-illness-bridge-activate` wore
 * `btn-ghost btn-sm border-dashed` and could not move onto the primitive at
 * all. The ruling admitted ONE BOOLEAN for it and stopped there: not a
 * `borderStyle` prop, not a third `variant` value, not a size axis, and NO
 * dashed primary or dashed danger — "ghost only. No third treatment beyond
 * that boolean."
 *
 * That limit is spelled as a union rather than trusted to a convention, so
 * `<Button dashed variant="primary">` is a COMPILE error and there is no
 * runtime guard to read: the type is the admission rule here exactly as it is
 * for `variant` and `layout` above. Widening this — a dashed rank, a second
 * shape, a `dashed` on `SubmitButton` (a form commit is filled, never a
 * placeholder) — is a new ruling, not a refactor.
 */
type ButtonShapeProps = { dashed?: false } | { dashed: true; variant?: never };

type ButtonMountProps = ButtonProps & ButtonShapeProps;

// `hidden sm:inline-flex` beats the `button-control` utility's own
// `inline-flex` because Tailwind emits custom `@utility` rules BEFORE the core
// ones (checked against the compiled sheet, not assumed), so the later `hidden`
// wins at equal specificity and `sm:inline-flex`, later still, restores it.
const LAYOUT_CLASS = {
  block: "w-full",
  "hidden-below-sm": "hidden sm:inline-flex",
} as const;

// The ordinary secondary action, the ONE primary variant the owner ruled for
// (#3982), and the ONE destructive paint (#4978). Callers supply meaning,
// behavior and — only now — RANK; never geometry and never paint of their own.
// `variant="primary"` / `variant="danger"` each add a paint-only utility on top
// of `button-control` rather than swapping the class, so every treatment carries
// the same box, the same focus ring and the same pending spinner by construction.
// The control is a full 44px effective target on a coarse pointer; navigational
// actions use DestinationActionLink instead.
const Button = forwardRef<HTMLButtonElement, ButtonMountProps>(function Button(
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
    layout,
    dashed = false,
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
      className={[
        "button-control",
        variant && `button-control-${variant}`,
        layout && LAYOUT_CLASS[layout],
        dashed && "border-dashed",
      ]
        .filter(Boolean)
        .join(" ")}
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
