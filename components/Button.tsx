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

type ForwardedDataAttributes = Readonly<
  Record<`data-${string}`, string | number | undefined>
> & {
  readonly "data-testid"?: never;
  readonly "data-button-control"?: never;
};

export interface ButtonProps {
  children: ReactNode;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  name?: NativeButtonProps["name"];
  value?: NativeButtonProps["value"];
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  pendingLabel?: ReactNode;
  /**
   * THE SAME IN-FLIGHT TREATMENT, REACHED FROM OUTSIDE A FORM (#5900). The
   * primitive already owned one — `aria-busy`, the spinner, and a control that
   * refuses a second tap — but derived it solely from `useFormStatus`, which
   * reports pending only INSIDE a form. So the eleven quick-log tap bodies,
   * which post through `useWritePipeline` rather than a form action, could not
   * reach it and grew five spellings of their own instead. A tap body hands its
   * `pipeline.pending(key)` (or `ledger.pending()`) here.
   *
   * It ORs into the form derivation and defaults to `false`; it never replaces
   * it, because every current form submit gets its spinner from `useFormStatus`
   * and nothing else (orchestrator A's clearance, constraint 1, #5903).
   *
   * DO NOT PASS `pendingLabel` WITH THIS. The busy path below renders
   * `pendingLabel ?? children`, so a tap body that states both would swap its
   * label mid-write and change width under the finger — the defect #5900 exists
   * to remove. `pendingLabel` remains the form callers' own spelling; this is a
   * caller rule rather than a runtime guard, because the two props are
   * independently legitimate and only their combination is wrong.
   */
  busy?: boolean;
  "aria-label"?: string;
  "aria-haspopup"?: AriaAttributes["aria-haspopup"];
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  "data-testid"?: string;
  /**
   * THE ONE OPENING IN THE CLOSED PROP SET, AND IT CAN CARRY NOTHING BUT STATE
   * (PM ruling 8, 2026-09-09, #4978). Converting a raw element onto this
   * primitive used to DROP its hyphenated attributes in silence: the prop set is
   * closed and the render below is an explicit list, and TypeScript exempts a
   * name like `data-workout-offer` from excess-property checking because it is
   * not an identifier. So `typecheck`, `lint` and a class-asserting component
   * test all stayed green while the attribute vanished from the page, and only
   * a browser-tier assertion could see it.
   *
   * This closes that by admitting the state markers alone, and it cannot widen
   * into the escape hatch #3720 and #3954 refuse: the KEY type is
   * `data-${string}`, so no `className`, `style`, `role`, `aria-*` or handler
   * can be spelled through it, and the VALUE type is a scalar, so nothing here
   * renders. It is one named prop rather than an index signature on this
   * interface or a rest spread on the component, so every prop that is not a
   * `data-*` attribute is still refused exactly as it was.
   *
   * The two attributes the primitive OWNS are typed `never`, because the record
   * is spread LAST and would otherwise let a mount shadow them — the type is
   * the admission rule here exactly as it is for `variant`, `layout` and
   * `dashed`.
   */
  data?: ForwardedDataAttributes;
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

/**
 * THE ONE IN-FLIGHT MARK (#5900), exported because three of the quick-log tap
 * controls cannot be this primitive and must still show the SAME thing. The
 * dose circles, the bristol tiles and the protein pair carry bespoke geometry
 * that `button-control` does not spell, so they render their own element — and
 * copying `IconLoader2`'s class string into each of them is how a surface grows
 * a sixth spelling of "in flight". A control with a label PRECEDES the label
 * with this, exactly as the render below does; an icon-only control SWAPS its
 * glyph for it, so its box does not move under the finger.
 *
 * `aria-hidden`, always: `aria-busy` on the control is what a reader is told,
 * and the spinner is the same fact drawn.
 */
export const BusyMark = () => (
  <IconLoader2 className="size-4 motion-safe:animate-spin" aria-hidden />
);

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
    busy: busyProp = false,
    "aria-label": ariaLabel,
    "aria-haspopup": ariaHasPopup,
    "aria-expanded": ariaExpanded,
    "aria-controls": ariaControls,
    "data-testid": testId,
    data,
    variant,
    layout,
    dashed = false,
  },
  ref
) {
  const { pending } = useFormStatus();
  const busy = busyProp || (pending && type === "submit");

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
      {...data}
    >
      {busy && <BusyMark />}
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
// two paints arguing. `DestructiveSubmit` picks its props by name for a DIFFERENT
// reason since #5757 — it repaints nothing now, and hard-codes `variant="danger"`
// on the child, so a caller-supplied rank would fight the one it states.
export const InlineSubmitAction = (
  props: Omit<SubmitActionProps, "variant">
) => (
  <span className="inline-submit-action">
    <SubmitActionChip {...props} />
  </span>
);
