"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import Button, { type ButtonProps } from "@/components/Button";

type SubmitButtonProps = Omit<
  ButtonProps,
  | "type"
  | "onClick"
  | "onKeyDown"
  | "aria-haspopup"
  | "aria-expanded"
  | "aria-controls"
> & {
  requireSelection?: string;
};

// Button owns submission state. This wrapper adds only the onboarding gate that
// waits for a named radio selection. `variant` is forwarded rather than
// destructured away: the type already admitted it (SubmitButtonProps omits only
// the props a submit may not state), so a caller asking for the one primary rank
// used to typecheck and then be silently dropped — the demotion #3982 was written
// against, arriving through the wrapper instead of the call site. `layout` is
// forwarded for the same reason: both of #4978's first two layout mounts are
// submits, so a wrapper that dropped it would put the escape straight back.
export default function SubmitButton({
  children,
  pendingLabel,
  disabled = false,
  requireSelection,
  "aria-label": ariaLabel,
  "data-testid": testId,
  name,
  value,
  variant,
  layout,
}: SubmitButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selectionSnapshot = useCallback(() => {
    if (!requireSelection) return false;
    const form = buttonRef.current?.form;
    if (!form) return true;
    const selected = Array.from(form.elements).some(
      (field) =>
        field instanceof HTMLInputElement &&
        field.name === requireSelection &&
        field.checked &&
        !field.disabled
    );
    return !selected;
  }, [requireSelection]);
  const subscribeToSelection = useCallback(
    (onChange: () => void) => {
      const form = buttonRef.current?.form;
      if (!form || !requireSelection) return () => {};
      form.addEventListener("change", onChange);
      return () => form.removeEventListener("change", onChange);
    },
    [requireSelection]
  );
  const selectionMissing = useSyncExternalStore(
    subscribeToSelection,
    selectionSnapshot,
    () => requireSelection != null
  );

  return (
    <Button
      ref={buttonRef}
      type="submit"
      disabled={disabled || selectionMissing}
      pendingLabel={pendingLabel}
      aria-label={ariaLabel}
      data-testid={testId}
      name={name}
      value={value}
      variant={variant}
      layout={layout}
    >
      {children}
    </Button>
  );
}

type DestructiveSubmitProps = Pick<
  ButtonProps,
  "children" | "pendingLabel" | "disabled" | "data-testid"
>;

export const DestructiveSubmit = (props: DestructiveSubmitProps) => (
  <span className="destructive-submit">
    <Button {...props} type="submit" />
  </span>
);
