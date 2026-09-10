"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import Button, { type ButtonProps } from "@/components/Button";
import { useConfirm, type ConfirmOptions } from "@/components/ConfirmDialog";

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

// The filled destructive submit. It states its rank through the primitive like
// any other filled control (#5696): the wrapper used to paint the fill onto a
// rank-LESS child, so a card could show two solid controls while every query for
// a rank class reported one. The wrapper survives for the GEOMETRY that rank
// cannot spell — the wider padding and larger type of the retiring `.btn-danger`
// shape — and paints nothing.
export const DestructiveSubmit = (props: DestructiveSubmitProps) => (
  <span className="destructive-submit">
    <Button {...props} type="submit" variant="danger" />
  </span>
);

// THE OTHER HALF OF A QUIET DESTRUCTIVE SUBMIT (#4978 ruling 10 as narrowed by
// ruling 12; owner-endorsed 2026-09-10). A destructive control that gives up the
// fill hands the red to its CONFIRM STEP — quieting one with nothing behind it
// deletes the destructive signal rather than relocating it, and every caller
// here revokes access with no undo. `danger` is stated HERE and nowhere else,
// so a caller cannot take the quiet paint and forget the red.
//
// It gates the ACTION rather than owning the <form>, because the forms it serves
// have nothing else in common: one is a card-level control carrying the DOM
// marker the integrations specs select on, the other is a per-row control
// carrying a layout class and its row's hidden id. A component owning the form
// would need a `className` escape, a children slot and a marker prop to serve
// both — three openings bought for one shared line.
//
// The confirm is awaited INSIDE the form action, the shape #5336 settled for
// this app (components/IntakeItemForm.tsx does the same): the dialog's store is
// external, so React commits the sheet even while the action is pending, and the
// caller stays a plain `<form action>` with the primitive owning its pending
// state.
type DestructiveAction = (formData: FormData) => void | Promise<void>;

export function useDestructiveSubmitGate(): (
  options: Omit<ConfirmOptions, "danger">,
  action: DestructiveAction
) => DestructiveAction {
  const confirm = useConfirm();
  return useCallback(
    (options, action) => async (formData) => {
      if (await confirm({ ...options, danger: true })) await action(formData);
    },
    [confirm]
  );
}
