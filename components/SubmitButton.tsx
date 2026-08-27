"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import Button, { type ButtonProps } from "@/components/Button";

type SubmitButtonProps = Pick<
  ButtonProps,
  | "children"
  | "pendingLabel"
  | "disabled"
  | "aria-label"
  | "data-testid"
  | "name"
  | "value"
> & {
  requireSelection?: string;
};

// Button owns submission state. This wrapper adds only the onboarding gate that
// waits for a named radio selection.
export default function SubmitButton({
  children,
  pendingLabel,
  disabled = false,
  requireSelection,
  "aria-label": ariaLabel,
  "data-testid": testId,
  name,
  value,
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
